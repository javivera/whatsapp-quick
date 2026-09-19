use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{blocking::Client as BlockingClient, Client as AsyncClient};
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use sysinfo::{Pid, Signal, System};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// System-wide toggle for the palette.
const DEFAULT_SHORTCUT: &str = "Command+Shift+M";

/// A blur this soon after showing is key-status churn from being ordered front
/// without activating the app, not the user clicking away.
const BLUR_GRACE_MS: u64 = 700;

/// Markers identifying the full WhatsApp Keyboard Desktop app. It shares
/// bridge port 8787: while it is running, its bridge is left strictly alone.
/// Anything else holding our port with no live owner is an orphan this app
/// may reclaim automatically.
const FULL_APP_CMD_MARKERS: [&str; 2] =
    ["WhatsApp Keyboard Desktop.app", "whatsapp_keyboard_desktop"];

/// Latency-bounded probe client. The watchdog and heal paths must never block
/// longer than this on a wedged bridge.
const PROBE_TIMEOUT_SECS: u64 = 4;
/// How often the background watchdog checks the bridge behind our back.
const WATCHDOG_INTERVAL_SECS: u64 = 30;
/// A bridge spawned less than this long ago is still booting (503s, refused
/// connections) and must not be mistaken for wedged.
const SPAWN_GRACE_SECS: u64 = 60;

struct AppState {
    bridge_process: Mutex<Option<Child>>,
    pending_deep_link: Mutex<Option<String>>,
    /// When this process last spawned a bridge. Reclaim logic leaves a
    /// fresh spawn alone while WhatsApp Web boots.
    bridge_spawned_at: Mutex<Option<Instant>>,
    /// Serialises heal/reclaim runs (ensure_bridge, watchdog, sleep-wake)
    /// so two triggers can't stack competing kill+spawn cycles.
    heal_lock: Mutex<()>,
}

struct OverlayState {
    shown: Mutex<bool>,
    /// Set once a real Focused(true) arrives, mirrored from the ytm overlay:
    /// without it, a Focused(false) delivered while the panel was never key
    /// would dismiss it immediately.
    was_focused: Mutex<bool>,
    /// When the palette was last ordered front. A brief loss of key status can
    /// still follow a show on some Space transitions, so a blur within
    /// BLUR_GRACE_MS of showing is ignored.
    shown_at: Mutex<Option<Instant>>,
}

/// The full "WhatsApp Keyboard Desktop" app keeps its LocalAuth session under
/// its own bundle's Application Support folder. Point this app at that same
/// folder so the already-linked WhatsApp session (clientId "gui") is reused and
/// no QR scan is needed. Only one bridge can hold that Chrome profile at a
/// time, but `ensure_bridge` attaches to a healthy bridge before spawning, so
/// in practice only one bridge ever runs.
fn shared_auth_data_dir(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(value) = std::env::var("WEBJS_AUTH_DATA_DIR") {
        if !value.trim().is_empty() {
            return PathBuf::from(value);
        }
    }

    let home = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("/tmp"));
    let shared = home
        .join("Library/Application Support")
        .join("com.opencode.whatsappkeyboarddesktop")
        .join("bridge")
        .join("auth");
    if shared.join("session-gui").is_dir() {
        return shared;
    }

    // Nothing to share yet: fall back to this bundle's own data dir so linking
    // a fresh device still works.
    app.path()
        .app_local_data_dir()
        .map(|dir| dir.join("bridge").join("auth"))
        .unwrap_or(shared)
}

fn bridge_base_url() -> String {
    std::env::var("WEBJS_BRIDGE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8787".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn should_restart_bridge(payload: &Value) -> bool {
    let status = payload.get("status").and_then(Value::as_str).unwrap_or_default();
    matches!(status, "init_failed" | "connection_stale") || status.starts_with("disconnected:")
}

static HEALTH_HTTP_CLIENT: OnceLock<BlockingClient> = OnceLock::new();
static PROBE_HTTP_CLIENT: OnceLock<BlockingClient> = OnceLock::new();
static ASYNC_HTTP_CLIENT: OnceLock<AsyncClient> = OnceLock::new();
static ASYNC_HEALTH_HTTP_CLIENT: OnceLock<AsyncClient> = OnceLock::new();

fn get_or_build_blocking_client(lock: &OnceLock<BlockingClient>, timeout: Duration) -> Result<BlockingClient, String> {
    if let Some(client) = lock.get() {
        return Ok(client.clone());
    }
    let built = BlockingClient::builder()
        .timeout(timeout)
        .build()
        .map_err(|err| err.to_string())?;
    let _ = lock.set(built.clone());
    Ok(lock.get().cloned().unwrap_or(built))
}

fn get_or_build_async_client(lock: &OnceLock<AsyncClient>, timeout: Duration) -> Result<AsyncClient, String> {
    if let Some(client) = lock.get() {
        return Ok(client.clone());
    }
    let built = AsyncClient::builder()
        .timeout(timeout)
        .build()
        .map_err(|err| err.to_string())?;
    let _ = lock.set(built.clone());
    Ok(lock.get().cloned().unwrap_or(built))
}

fn health_http_client() -> Result<BlockingClient, String> {
    get_or_build_blocking_client(&HEALTH_HTTP_CLIENT, Duration::from_secs(5))
}

fn async_health_http_client() -> Result<AsyncClient, String> {
    get_or_build_async_client(&ASYNC_HEALTH_HTTP_CLIENT, Duration::from_secs(5))
}

fn async_http_client() -> Result<AsyncClient, String> {
    get_or_build_async_client(&ASYNC_HTTP_CLIENT, Duration::from_secs(90))
}

fn parse_json_response(response: reqwest::blocking::Response) -> Result<Value, String> {
    let status = response.status();
    let payload: Value = response.json().map_err(|err| err.to_string())?;

    if !status.is_success() || !payload.get("success").and_then(Value::as_bool).unwrap_or(false) {
        let detail = payload
            .get("error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Bridge request failed with status {status}"));
        return Err(detail);
    }

    Ok(payload)
}

async fn parse_json_response_async(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let payload: Value = response.json().await.map_err(|err| err.to_string())?;

    if !status.is_success() || !payload.get("success").and_then(Value::as_bool).unwrap_or(false) {
        let detail = payload
            .get("error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Bridge request failed with status {status}"));
        return Err(detail);
    }

    Ok(payload)
}

#[allow(dead_code)]
fn bridge_get_health_check(path: &str) -> Result<Value, String> {
    let request_path = if path == "/health" {
        format!("{path}?strict=true")
    } else {
        path.to_string()
    };
    let client = health_http_client()?;
    let response = client
        .get(format!("{}{}", bridge_base_url(), request_path))
        .send()
        .map_err(|err| err.to_string())?;

    parse_json_response(response)
}

async fn bridge_get_async_health_check(path: &str) -> Result<Value, String> {
    let request_path = if path == "/health" {
        format!("{path}?strict=true")
    } else {
        path.to_string()
    };
    let client = async_health_http_client()?;
    let response = client
        .get(format!("{}{}", bridge_base_url(), request_path))
        .send()
        .await
        .map_err(|err| err.to_string())?;

    parse_json_response_async(response).await
}

async fn bridge_get_async(path: &str, query: &[(&str, String)]) -> Result<Value, String> {
    let client = async_http_client()?;
    let response = client
        .get(format!("{}{}", bridge_base_url(), path))
        .query(query)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    parse_json_response_async(response).await
}

async fn bridge_post_async(path: &str, payload: Value) -> Result<Value, String> {
    let client = async_http_client()?;
    let response = client
        .post(format!("{}{}", bridge_base_url(), path))
        .json(&payload)
        .send()
        .await
        .map_err(|err| err.to_string())?;

    parse_json_response_async(response).await
}

fn request_bridge_shutdown() {
    let Ok(client) = health_http_client() else {
        return;
    };
    let _ = client
        .post(format!("{}{}", bridge_base_url(), "/shutdown"))
        .json(&json!({}))
        .send();
}

fn project_root() -> Result<PathBuf, String> {
    // src-tauri -> whatsapp-quick (where bridge_server.js lives).
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Could not resolve project root".to_string())
}

fn resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn resolve_bridge_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if let Some(resource_root) = resource_dir(app) {
        let bridge_dir = resource_root.join("bridge");
        let bridge_script = bridge_dir.join("bridge_server.js");
        if bridge_script.is_file() {
            return Ok((bridge_dir, bridge_script));
        }
    }

    let root = project_root()?;
    let bridge_script = root.join("bridge_server.js");
    if bridge_script.is_file() {
        return Ok((root, bridge_script));
    }

    Err("Could not locate bridge_server.js".to_string())
}

/// Resolve the directory holding the frontend assets (index.html, quick.js,
/// quick.css). In a release bundle the files are copied under `Resources/ui`;
/// during development they sit at `<project_root>/ui`.
fn resolve_ui_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(resource_root) = resource_dir(app) {
        let bundled_ui = resource_root.join("ui");
        if bundled_ui.join("index.html").is_file() {
            return Ok(bundled_ui);
        }
    }

    let compile_time = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("ui"))
        .unwrap_or_default();
    if compile_time.join("index.html").is_file() {
        return Ok(compile_time);
    }

    Err("Could not locate the ui/ directory with index.html".to_string())
}

fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("webm") => "audio/webm",
        _ => "application/octet-stream",
    }
}

/// Spawn a tiny_http server on an OS-assigned port serving the UI directory.
///
/// The page MUST load from `http://localhost:<port>` (not Tauri's
/// `tauri://localhost` asset protocol) because that asset protocol is not a
/// secure context on macOS WKWebView, and `navigator.mediaDevices.getUserMedia`
/// (microphone, for voice notes) only exists in a secure context.
fn spawn_asset_server(ui_dir: PathBuf) -> Result<u16, String> {
    // Binding port 0 lets the OS pick and reserve the port atomically.
    let addr = "127.0.0.1:0";
    let server = tiny_http::Server::http(addr)
        .map_err(|e| format!("Failed to start asset server on {addr}: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .ok_or("Asset server did not bind an IP socket")?
        .port();

    println!("[asset-server] Serving {ui_dir:?} on http://localhost:{port}");

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let url_path = request.url().to_string();
            let clean = url_path.split('?').next().unwrap_or("/");
            let relative = if clean == "/" { "/index.html" } else { clean };
            let relative = relative.trim_start_matches('/');
            let file_path = ui_dir.join(relative);

            if file_path.is_file() {
                match std::fs::File::open(&file_path) {
                    Ok(mut file) => {
                        let mut buf = Vec::new();
                        if std::io::Read::read_to_end(&mut file, &mut buf).is_ok() {
                            let content_type = mime_for_path(&file_path);
                            let header = tiny_http::Header::from_bytes(
                                b"Content-Type",
                                content_type.as_bytes(),
                            )
                            .unwrap();
                            let response =
                                tiny_http::Response::from_data(buf).with_header(header);
                            let _ = request.respond(response);
                        } else {
                            let _ = request.respond(
                                tiny_http::Response::from_string("Read error")
                                    .with_status_code(500),
                            );
                        }
                    }
                    Err(_) => {
                        let _ = request.respond(
                            tiny_http::Response::from_string("Not found").with_status_code(404),
                        );
                    }
                }
            } else {
                let _ = request.respond(
                    tiny_http::Response::from_string("Not found").with_status_code(404),
                );
            }
        }
    });

    Ok(port)
}

fn command_exists_in_path(command: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                let candidate = dir.join(command);
                if candidate.is_file() {
                    return true;
                }
                #[cfg(windows)]
                {
                    let exe_candidate = dir.join(format!("{command}.exe"));
                    return exe_candidate.is_file();
                }
                #[cfg(not(windows))]
                {
                    false
                }
            })
        })
        .unwrap_or(false)
}

fn bundled_binary_candidates(app: &tauri::AppHandle, name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(resource_root) = resource_dir(app) {
        let exe_suffix = std::env::consts::EXE_SUFFIX;
        let bin_dir = resource_root.join("bin");
        candidates.push(bin_dir.join(name));
        candidates.push(bin_dir.join(format!("{name}{exe_suffix}")));
        candidates.push(resource_root.join(name));
        candidates.push(resource_root.join(format!("{name}{exe_suffix}")));

        if let Ok(entries) = fs::read_dir(&bin_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if file_name == name
                    || file_name == format!("{name}{exe_suffix}")
                    || file_name.starts_with(&format!("{name}-"))
                {
                    candidates.push(path);
                }
            }
        }
    }
    candidates
}

fn resolve_node_command(app: &tauri::AppHandle) -> String {
    if let Ok(value) = std::env::var("WEBJS_NODE_PATH") {
        if !value.trim().is_empty() {
            return value;
        }
    }

    if let Some(path) = bundled_binary_candidates(app, "node")
        .into_iter()
        .find(|candidate| candidate.is_file())
    {
        return path.to_string_lossy().to_string();
    }

    if command_exists_in_path("node") {
        return "node".to_string();
    }

    let homebrew = "/opt/homebrew/bin/node";
    if PathBuf::from(homebrew).is_file() {
        return homebrew.to_string();
    }

    "node".to_string()
}

fn resolve_ffmpeg_command(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(value) = std::env::var("FFMPEG_PATH") {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }

    bundled_binary_candidates(app, "ffmpeg")
        .into_iter()
        .find(|candidate| candidate.is_file())
        .map(|path| path.to_string_lossy().to_string())
}

fn spawn_bridge_if_needed(state: &AppState, app: &tauri::AppHandle) -> Result<(), String> {
    let mut guard = state
        .bridge_process
        .lock()
        .map_err(|_| "Bridge state lock poisoned".to_string())?;

    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            Ok(Some(_)) | Err(_) => {
                *guard = None;
            }
        }
    }

    let (bridge_work_dir, bridge_script) = resolve_bridge_paths(app)?;
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Could not resolve app local data directory".to_string())?
        .join("bridge");
    let auth_data_dir = shared_auth_data_dir(app);
    fs::create_dir_all(&auth_data_dir)
        .map_err(|err| format!("Failed to create bridge auth directory: {err}"))?;

    let mut command = Command::new(resolve_node_command(app));
    command
        .arg(&bridge_script)
        .current_dir(&bridge_work_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env("WEBJS_AUTH_DATA_DIR", &auth_data_dir)
        .env("WEBJS_APP_DATA_DIR", &app_data_dir);

    if let Some(ffmpeg_path) = resolve_ffmpeg_command(app) {
        command.env("FFMPEG_PATH", ffmpeg_path);
    }

    let child = command
        .spawn()
        .map_err(|err| format!("Failed to start bridge process: {err}"))?;

    *guard = Some(child);
    drop(guard);
    if let Ok(mut at) = state.bridge_spawned_at.lock() {
        *at = Some(Instant::now());
    }
    Ok(())
}

fn collect_descendant_pids(root_pid: u32) -> Vec<Pid> {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);

    let root = Pid::from_u32(root_pid);
    let mut queue = vec![root];
    let mut descendants = Vec::new();

    while let Some(parent_pid) = queue.pop() {
        for (pid, process) in sys.processes() {
            if process.parent() == Some(parent_pid) && !descendants.contains(pid) {
                descendants.push(*pid);
                queue.push(*pid);
            }
        }
    }

    descendants
}

fn terminate_pid(sys: &System, pid: Pid) {
    if let Some(process) = sys.process(pid) {
        let _ = process.kill_with(Signal::Term);
        std::thread::sleep(Duration::from_millis(150));
        if sys.process(pid).is_some() {
            let _ = process.kill();
        }
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return true,
        }
    }
}

fn stop_bridge_process(state: &AppState) {
    if let Ok(mut guard) = state.bridge_process.lock() {
        if let Some(child) = guard.as_mut() {
            let root_pid = child.id();
            let descendant_pids = collect_descendant_pids(root_pid);

            // Only ask for a graceful shutdown when our own child is still
            // alive. POSTing /shutdown blindly would kill a bridge owned by
            // the full app, which shares this port.
            if matches!(child.try_wait(), Ok(None)) {
                request_bridge_shutdown();
            }

            if !wait_for_child_exit(child, Duration::from_secs(5)) {
                let _ = child.kill();
                let _ = wait_for_child_exit(child, Duration::from_secs(2));
            }

            let mut sys = System::new_all();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
            for pid in descendant_pids.iter().rev() {
                terminate_pid(&sys, *pid);
            }
            // Never block here: a starved bridge ignores SIGTERM, so wait()
            // would stall the caller (notably reclaim) forever. Survivors
            // are SIGKILLed by the caller's terminate_pids/sweep.
            let _ = child.try_wait();
        }
        *guard = None;
    }
}

/// True when THIS process started the bridge it is talking to.
/// A bridge on the shared port may belong to the full WhatsApp Keyboard
/// Desktop app; we must never shut down a bridge we did not start.
fn owns_bridge(state: &AppState) -> bool {
    state
        .bridge_process
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

/// True while the full WhatsApp app is alive. Its bridge is never touched.
fn full_app_running() -> bool {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    sys.processes().values().any(|process| {
        let name = process.name().to_string_lossy().to_lowercase();
        if name.contains("whatsapp_keyboard_desktop") {
            return true;
        }
        process.cmd().iter().any(|arg| {
            let arg = arg.to_string_lossy();
            FULL_APP_CMD_MARKERS.iter().any(|marker| arg.contains(marker))
        })
    })
}

/// Pids of node processes running a bridge_server.js copy: the processes that
/// can hold our shared port. Includes orphans from previously crashed owners.
fn bridge_holder_pids() -> Vec<u32> {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    sys.processes()
        .values()
        .filter(|process| {
            process.name().to_string_lossy() == "node"
                && process
                    .cmd()
                    .iter()
                    .any(|arg| arg.to_string_lossy().contains("bridge_server.js"))
        })
        .map(|process| process.pid().as_u32())
        .collect()
}

/// Pids of headless Chrome helpers bound to the shared session-gui profile.
/// A stale set holds the profile lock and blocks a fresh bridge's browser.
fn session_chrome_pids() -> Vec<u32> {
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    sys.processes()
        .values()
        .filter(|process| {
            let name = process.name().to_string_lossy().to_lowercase();
            name.contains("chrome")
                && process
                    .cmd()
                    .iter()
                    .any(|arg| arg.to_string_lossy().contains("session-gui"))
        })
        .map(|process| process.pid().as_u32())
        .collect()
}

/// TERM, wait briefly, then KILL whatever remains. Works on stopped (SIGSTOP)
/// and event-loop-starved processes that ignore graceful shutdown.
fn terminate_pids(pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    let mut sys = System::new_all();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
    let targets: Vec<Pid> = pids.iter().map(|id| Pid::from_u32(*id)).collect();
    for pid in &targets {
        if let Some(process) = sys.process(*pid) {
            let _ = process.kill_with(Signal::Term);
        }
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        std::thread::sleep(Duration::from_millis(150));
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All);
        let alive: Vec<Pid> = targets
            .iter()
            .copied()
            .filter(|pid| sys.process(*pid).is_some())
            .collect();
        if alive.is_empty() || Instant::now() >= deadline {
            for pid in alive {
                if let Some(process) = sys.process(pid) {
                    let _ = process.kill();
                }
            }
            break;
        }
    }
}

/// Kill bridge/Chrome strays from dead owners so the next spawn owns a clean
/// slate. No-op while the full app runs: its processes are never candidates.
fn sweep_orphaned_bridge() {
    if full_app_running() {
        return;
    }
    let holders = bridge_holder_pids();
    let chromes = session_chrome_pids();
    if holders.is_empty() && chromes.is_empty() {
        return;
    }
    eprintln!(
        "quick: sweeping orphaned bridge processes (bridge={holders:?}, session_chrome={})",
        chromes.len()
    );
    terminate_pids(&holders);
    terminate_pids(&chromes);
}

fn probe_http_client() -> Result<BlockingClient, String> {
    get_or_build_blocking_client(
        &PROBE_HTTP_CLIENT,
        Duration::from_secs(PROBE_TIMEOUT_SECS),
    )
}

enum BridgeProbe {
    Healthy(Value),
    /// The port accepted our connection but no usable answer came back in
    /// time: the holder's event loop is starved (the 100%-CPU wedge).
    Wedged,
    /// Nothing listening at all.
    Absent,
}

/// Bounded-latency liveness probe. Any parseable JSON counts as alive, even a
/// booting 503: this measures the event loop, not WhatsApp readiness.
/// Deliberately strict=false so the watchdog never triggers bridge-side
/// reconnect storms.
fn probe_bridge() -> BridgeProbe {
    let Ok(client) = probe_http_client() else {
        return BridgeProbe::Absent;
    };
    match client
        .get(format!("{}/health?strict=false", bridge_base_url()))
        .send()
    {
        Ok(response) => match response.json::<Value>() {
            Ok(payload) => BridgeProbe::Healthy(payload),
            Err(_) => BridgeProbe::Wedged,
        },
        Err(err) if err.is_connect() => BridgeProbe::Absent,
        Err(_) => BridgeProbe::Wedged,
    }
}

fn wait_for_bridge_healthy(timeout: Duration) -> Option<Value> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let BridgeProbe::Healthy(payload) = probe_bridge() {
            return Some(payload);
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    None
}

fn bridge_spawned_recently(state: &AppState) -> bool {
    state
        .bridge_spawned_at
        .lock()
        .map(|at| {
            at.map(|t| t.elapsed() < Duration::from_secs(SPAWN_GRACE_SECS))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn starting_bridge_payload() -> Value {
    json!({
        "success": true,
        "ready": false,
        "status": "starting_bridge"
    })
}

/// Replace an unresponsive bridge nobody owns. Only ever runs while the full
/// app is down, so the holder can only be an orphan; a live full app's
/// bridge is never a candidate.
fn reclaim_stale_bridge(state: &AppState, app: &AppHandle) -> Result<Value, String> {
    if full_app_running() {
        eprintln!("quick: bridge unresponsive but the full app is running; leaving its bridge alone");
        return Ok(json!({
            "success": true,
            "ready": false,
            "status": "bridge_unresponsive_owner_active"
        }));
    }
    if bridge_spawned_recently(state) {
        return Ok(starting_bridge_payload());
    }
    let holders = bridge_holder_pids();
    let chromes = session_chrome_pids();
    eprintln!(
        "quick: reclaiming unresponsive bridge (bridge_pids={holders:?}, session_chrome={})",
        chromes.len()
    );
    // KILL first: a starved event loop can't run its graceful-shutdown
    // handler, so anything graceful (POST /shutdown, wait()) would stall.
    // stop_bridge_process afterwards just reaps our Child handle.
    terminate_pids(&holders);
    stop_bridge_process(state);
    terminate_pids(&chromes);
    spawn_bridge_if_needed(state, app)?;
    if let Some(payload) = wait_for_bridge_healthy(Duration::from_secs(20)) {
        return Ok(payload);
    }
    Ok(starting_bridge_payload())
}

/// Single entry point for every "make sure there is a usable bridge" path
/// (frontend boot, background watchdog, sleep-wake). Responding bridges are
/// attached to and never disturbed; only a bridge this process owns may be
/// restarted on a bad status; an unresponsive bridge with no live owner is
/// reclaimed automatically — no user action needed.
fn heal_bridge(state: &AppState, app: &AppHandle) -> Result<Value, String> {
    let _heal = match state.heal_lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(starting_bridge_payload()),
    };
    match probe_bridge() {
        BridgeProbe::Healthy(payload) => {
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("-");
            eprintln!(
                "quick: attached to existing bridge (status={status}, owner={})",
                if owns_bridge(state) { "self" } else { "other-app" }
            );
            // Only a bridge this process owns may be torn down and replaced.
            if !should_restart_bridge(&payload) || !owns_bridge(state) {
                return Ok(payload);
            }
            eprintln!("quick: owned bridge reports unhealthy status; restarting it");
            stop_bridge_process(state);
            spawn_bridge_if_needed(state, app)?;
            if let Some(fresh) = wait_for_bridge_healthy(Duration::from_secs(20)) {
                return Ok(fresh);
            }
            Ok(starting_bridge_payload())
        }
        BridgeProbe::Wedged => reclaim_stale_bridge(state, app),
        BridgeProbe::Absent => {
            eprintln!("quick: no bridge listening; starting one on the shared session");
            spawn_bridge_if_needed(state, app)?;
            if let Some(payload) = wait_for_bridge_healthy(Duration::from_secs(20)) {
                return Ok(payload);
            }
            Ok(starting_bridge_payload())
        }
    }
}

#[tauri::command]
fn ensure_bridge(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<Value, String> {
    heal_bridge(&state, &app)
}

#[tauri::command]
fn restart_bridge(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<Value, String> {
    if owns_bridge(&state) || !full_app_running() {
        stop_bridge_process(&state);
        sweep_orphaned_bridge();
    }
    heal_bridge(&state, &app)
}

#[tauri::command]
async fn bridge_health() -> Result<Value, String> {
    bridge_get_async_health_check("/health").await
}

#[tauri::command]
async fn bridge_get_chats(
    limit: i64,
    include_groups: bool,
    query: Option<String>,
) -> Result<Value, String> {
    let mut params = vec![
        ("limit", limit.clamp(1, 1000).to_string()),
        ("include_groups", include_groups.to_string()),
    ];
    if let Some(query) = query {
        if !query.trim().is_empty() {
            params.push(("q", query.trim().to_string()));
        }
    }
    bridge_get_async("/chats", &params).await
}

#[tauri::command]
async fn bridge_get_messages(chat_id: String, limit: i64) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    bridge_get_async(
        "/messages",
        &[
            ("chat_id", chat_id.trim().to_string()),
            ("limit", limit.clamp(1, 500).to_string()),
        ],
    )
    .await
}

#[tauri::command]
async fn bridge_send_message(chat_id: String, text: String, quoted_message_id: Option<String>) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    if text.trim().is_empty() {
        return Err("text is required".to_string());
    }

    bridge_post_async(
        "/send",
        json!({
            "chat_id": chat_id.trim(),
            "text": text.trim(),
            "quoted_message_id": quoted_message_id.as_deref().map(str::trim).filter(|value| !value.is_empty())
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_refresh() -> Result<Value, String> {
    bridge_post_async("/refresh", json!({})).await
}

#[tauri::command]
async fn bridge_mark_seen(chat_id: String) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    bridge_post_async("/seen", json!({ "chat_id": chat_id.trim() })).await
}

#[tauri::command]
async fn bridge_delete_chat(chat_id: String) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    bridge_post_async("/delete", json!({ "chat_id": chat_id.trim() })).await
}

#[tauri::command]
async fn bridge_archive_chat(chat_id: String) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    bridge_post_async("/archive", json!({ "chat_id": chat_id.trim() })).await
}

#[tauri::command]
async fn bridge_unarchive_chat(chat_id: String) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    bridge_post_async("/unarchive", json!({ "chat_id": chat_id.trim() })).await
}

#[tauri::command]
async fn bridge_send_audio(chat_id: String, audio_data: String, mimetype: Option<String>) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    if audio_data.trim().is_empty() {
        return Err("audio_data is required".to_string());
    }
    let mime = mimetype.unwrap_or_else(|| "audio/ogg; codecs=opus".to_string());
    bridge_post_async(
        "/send-audio",
        json!({
            "chat_id": chat_id.trim(),
            "audio_data": audio_data.trim(),
            "mimetype": mime.trim()
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_send_image(
    chat_id: String,
    image_data: String,
    mimetype: String,
    filename: Option<String>,
    caption: Option<String>,
) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    if image_data.trim().is_empty() {
        return Err("image_data is required".to_string());
    }
    if mimetype.trim().is_empty() {
        return Err("mimetype is required".to_string());
    }

    bridge_post_async(
        "/send-image",
        json!({
            "chat_id": chat_id.trim(),
            "image_data": image_data.trim(),
            "mimetype": mimetype.trim(),
            "filename": filename.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            "caption": caption.as_deref().map(str::trim).filter(|value| !value.is_empty())
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_send_media(
    chat_id: String,
    media_data: String,
    mimetype: String,
    filename: Option<String>,
    caption: Option<String>,
    quoted_message_id: Option<String>,
) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    if media_data.trim().is_empty() {
        return Err("media_data is required".to_string());
    }
    if mimetype.trim().is_empty() {
        return Err("mimetype is required".to_string());
    }

    bridge_post_async(
        "/send-media",
        json!({
            "chat_id": chat_id.trim(),
            "media_data": media_data.trim(),
            "mimetype": mimetype.trim(),
            "filename": filename.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            "caption": caption.as_deref().map(str::trim).filter(|value| !value.is_empty()),
            "quoted_message_id": quoted_message_id.as_deref().map(str::trim).filter(|value| !value.is_empty())
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_edit_message(chat_id: String, message_id: String, text: String) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    if message_id.trim().is_empty() {
        return Err("messageId is required".to_string());
    }
    if text.trim().is_empty() {
        return Err("text is required".to_string());
    }

    bridge_post_async(
        "/edit-message",
        json!({
            "chat_id": chat_id.trim(),
            "message_id": message_id.trim(),
            "text": text.trim()
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_delete_message(chat_id: String, message_id: String, everyone: Option<bool>) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    if message_id.trim().is_empty() {
        return Err("messageId is required".to_string());
    }

    bridge_post_async(
        "/delete-message",
        json!({
            "chat_id": chat_id.trim(),
            "message_id": message_id.trim(),
            "everyone": everyone.unwrap_or(false)
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_react_message(message_id: String, emoji: String) -> Result<Value, String> {
    if message_id.trim().is_empty() {
        return Err("messageId is required".to_string());
    }
    bridge_post_async(
        "/react",
        json!({
            "message_id": message_id.trim(),
            "emoji": emoji
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_get_link_preview(url: String) -> Result<Value, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("url is required".to_string());
    }
    bridge_get_async("/link-preview", &[("url", trimmed.to_string())]).await
}

#[tauri::command]
fn get_pending_deep_link(state: State<AppState>) -> Option<String> {
    state.pending_deep_link.lock().unwrap().take()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("url is required".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("Only http(s) URLs are supported".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(trimmed);
        cmd
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(trimmed);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", trimmed]);
        cmd
    };

    command
        .spawn()
        .map_err(|err| format!("Could not open URL: {err}"))?;

    Ok(())
}

fn extension_for_mimetype(mimetype: &str, filename: Option<&str>) -> String {
    if let Some(name) = filename {
        if let Some(ext) = std::path::Path::new(name).extension().and_then(|e| e.to_str()) {
            let ext = ext.to_lowercase();
            if !ext.is_empty()
                && ext.len() <= 8
                && ext.chars().all(|c| c.is_ascii_alphanumeric())
            {
                return ext;
            }
        }
    }
    let mime = mimetype.split(';').next().unwrap_or("").trim().to_lowercase();
    match mime.as_str() {
        "application/pdf" => "pdf",
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        "audio/aac" => "aac",
        "audio/wav" => "wav",
        "text/plain" => "txt",
        "application/zip" => "zip",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        _ => "bin",
    }
    .to_string()
}

fn sanitize_filename(filename: Option<&str>, ext: &str) -> String {
    let base = filename
        .map(|f| {
            let stem = std::path::Path::new(f)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("media");
            let cleaned: String = stem
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            if cleaned.trim_matches('_').is_empty() {
                "media".to_string()
            } else {
                cleaned
            }
        })
        .unwrap_or_else(|| "media".to_string());
    format!("{base}.{ext}")
}

/// Save base64 media bytes to a temp file and open it with the OS default app
/// (Preview for images/PDFs, QuickTime for videos, etc). Returns the path that
/// was opened so the frontend can show it.
#[tauri::command]
fn open_media_external(
    data: String,
    mimetype: String,
    filename: Option<String>,
) -> Result<String, String> {
    let trimmed = data.trim();
    if trimmed.is_empty() {
        return Err("data is required".to_string());
    }
    let bytes = BASE64
        .decode(trimmed)
        .map_err(|err| format!("Invalid base64 data: {err}"))?;
    if bytes.is_empty() {
        return Err("data decoded to empty".to_string());
    }

    let ext = extension_for_mimetype(&mimetype, filename.as_deref());
    let safe_name = sanitize_filename(filename.as_deref(), &ext);
    // Unique prefix so two opens of the same-named document never collide
    // (the OS may keep the previous viewer open and re-read the file).
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join("whatsapp-quick");
    fs::create_dir_all(&dir).map_err(|err| format!("Could not create temp dir: {err}"))?;
    let path = dir.join(format!("{unique}-{safe_name}"));
    fs::write(&path, &bytes).map_err(|err| format!("Could not write temp file: {err}"))?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = Command::new("open");
        cmd.arg(&path);
        cmd
    };

    #[cfg(target_os = "linux")]
    let mut command = {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(&path);
        cmd
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", path.to_string_lossy().as_ref()]);
        cmd
    };

    command
        .spawn()
        .map_err(|err| format!("Could not open media: {err}"))?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn bridge_forward_message(
    source_chat_id: String,
    message_id: String,
    target_chat_id: String,
) -> Result<Value, String> {
    if source_chat_id.trim().is_empty() {
        return Err("sourceChatId is required".to_string());
    }
    if message_id.trim().is_empty() {
        return Err("messageId is required".to_string());
    }
    if target_chat_id.trim().is_empty() {
        return Err("targetChatId is required".to_string());
    }

    bridge_post_async(
        "/forward",
        json!({
            "source_chat_id": source_chat_id.trim(),
            "message_id": message_id.trim(),
            "target_chat_id": target_chat_id.trim()
        }),
    )
    .await
}

#[tauri::command]
async fn bridge_get_media(chat_id: String, message_id: String) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    if message_id.trim().is_empty() {
        return Err("messageId is required".to_string());
    }
    bridge_get_async(
        "/media",
        &[
            ("chat_id", chat_id.trim().to_string()),
            ("message_id", message_id.trim().to_string()),
        ],
    )
    .await
}

#[tauri::command]
async fn bridge_get_profile_pic(chat_id: String) -> Result<Value, String> {
    if chat_id.trim().is_empty() {
        return Err("chatId is required".to_string());
    }
    bridge_get_async(
        "/profile-pic",
        &[("chat_id", chat_id.trim().to_string())],
    )
    .await
}

#[tauri::command]
fn log_debug(message: String) {
    let _ = writeln!(io::stdout(), "{message}");
}

#[tauri::command]
fn get_process_stats(state: State<'_, AppState>) -> Result<Value, String> {
    let mut sys = System::new();
    let own_pid = Pid::from_u32(std::process::id());

    // Refresh only the processes we care about
    sys.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[own_pid]),
    );

    let mut result = json!({
        "tauri_pid": std::process::id(),
        "tauri_memory_bytes": 0,
        "tauri_cpu_percent": 0.0,
        "bridge_pid": null,
        "bridge_memory_bytes": null,
        "bridge_cpu_percent": null,
        "total_memory_bytes": 0,
        "total_cpu_percent": 0.0,
    });

    if let Some(proc) = sys.process(own_pid) {
        let mem = proc.memory();
        let cpu = proc.cpu_usage();
        result["tauri_memory_bytes"] = json!(mem);
        result["tauri_cpu_percent"] = json!(cpu);
        result["total_memory_bytes"] = json!(mem);
        result["total_cpu_percent"] = json!(cpu);
    }

    // Check bridge process
    if let Ok(guard) = state.bridge_process.lock() {
        if let Some(child) = guard.as_ref() {
            let bridge_pid = Pid::from_u32(child.id());
            let mut sys2 = System::new();
            sys2.refresh_processes(
                sysinfo::ProcessesToUpdate::Some(&[bridge_pid]),
            );
            if let Some(proc) = sys2.process(bridge_pid) {
                let mem = proc.memory();
                let cpu = proc.cpu_usage();
                result["bridge_pid"] = json!(child.id());
                result["bridge_memory_bytes"] = json!(mem);
                result["bridge_cpu_percent"] = json!(cpu);
                let total_mem = result["total_memory_bytes"].as_u64().unwrap_or(0) + mem;
                let total_cpu = result["total_cpu_percent"].as_f64().unwrap_or(0.0) + cpu as f64;
                result["total_memory_bytes"] = json!(total_mem);
                result["total_cpu_percent"] = json!(total_cpu);
            }
        }
    }

    // System-wide memory info
    let mut sys_full = System::new();
    sys_full.refresh_memory();
    result["system_total_memory"] = json!(sys_full.total_memory());
    result["system_used_memory"] = json!(sys_full.used_memory());

    Ok(result)
}

/// How long the palette has been on screen, or None if it is hidden.
fn shown_for<R: Runtime>(app: &AppHandle<R>) -> Option<Duration> {
    app.state::<OverlayState>()
        .shown_at
        .lock()
        .ok()
        .and_then(|at| *at)
        .map(|at| at.elapsed())
}

/// Guard for dismiss-on-focus-loss signals.
///
/// Ordering the panel front (without activating the app) churns focus state for
/// a moment: a blur AND an app-activation notification both arrive within tens
/// of milliseconds of showing. Neither is the user leaving, so anything inside
/// the grace window is ignored.
fn focus_left_after_grace<R: Runtime>(app: &AppHandle<R>) -> bool {
    shown_for(app)
        .map(|elapsed| elapsed >= Duration::from_millis(BLUR_GRACE_MS))
        .unwrap_or(false)
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window("main")
}

fn set_shown<R: Runtime>(app: &AppHandle<R>, shown: bool) {
    if let Ok(mut flag) = app.state::<OverlayState>().shown.lock() {
        *flag = shown;
    }
}

fn is_shown<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<OverlayState>()
        .shown
        .lock()
        .map(|flag| *flag)
        .unwrap_or(false)
}

fn hide_quick_because<R: Runtime>(app: &AppHandle<R>, reason: &str) {
    // Already hidden (e.g. the blur echo after releasing key below): never
    // re-hide, or rapid toggles would stack redundant slide cycles.
    if !is_shown(app) {
        return;
    }
    eprintln!("quick: hide reason={reason} shown_for={:?}", shown_for(app));
    set_shown(app, false);
    if let Ok(mut at) = app.state::<OverlayState>().shown_at.lock() {
        *at = None;
    }
    // ytm rule: the NSWindow is deliberately NOT ordered out. Ordering it
    // out made WebKit drop the webview's layer, so the next show repainted
    // in strips (partial content, then a pop) and the suspended renderer
    // swallowed the slide transition. Staying on stage keeps it painted, so
    // the CSS slide is a pure compositor transform in both directions.
    // The invisible-but-present window must not eat clicks or keys.
    let _ = app.emit("quick-hiding", ());
    if let Some(window) = main_window(app) {
        #[cfg(target_os = "macos")]
        {
            scratchpad::set_click_through(&window, true);
            scratchpad::release_key(&window);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window.hide();
        }
    }
}

fn show_quick<R: Runtime>(app: &AppHandle<R>) {
    set_shown(app, true);
    if let Ok(mut flag) = app.state::<OverlayState>().was_focused.lock() {
        *flag = false;
    }
    if let Ok(mut at) = app.state::<OverlayState>().shown_at.lock() {
        *at = Some(Instant::now());
    }

    let Some(window) = main_window(app) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.set_always_on_top(true);
    #[cfg(target_os = "macos")]
    {
        let _ = window.set_visible_on_all_workspaces(true);
        // Order front instantly — the window itself is transparent, the
        // slide-up is the page's CSS transition (triggered by quick-shown).
        // The window is never ordered out (see hide), so the frame persists;
        // re-pinning a visible docked window is a no-op.
        let w = window.clone();
        scratchpad::set_click_through(&window, false);
        let _ = app.run_on_main_thread(move || {
            scratchpad::order_front_docked(&w);
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("quick-shown", ());
}

fn toggle_quick<R: Runtime>(app: &AppHandle<R>) {
    if is_shown(app) {
        hide_quick_because(app, "toggle");
    } else {
        show_quick(app);
    }
}

/// Called from the page (Esc) to dismiss the palette.
#[tauri::command]
fn hide_quick_cmd(app: AppHandle) {
    hide_quick_because(&app, "esc-from-page");
}

fn register_toggle<R: Runtime>(app: &AppHandle<R>) {
    let Ok(shortcut) = DEFAULT_SHORTCUT.parse::<Shortcut>() else {
        eprintln!("quick: invalid shortcut {DEFAULT_SHORTCUT}");
        return;
    };
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if let Err(err) = gs.on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_quick(app);
        }
    }) {
        eprintln!("quick: failed to register {DEFAULT_SHORTCUT}: {err}");
    }
}

/// coolCalc's trick: NSPanel + nonactivatingPanel + canBecomeKey. The panel can
/// take keystrokes (so the search field and composer work) without activating
/// the app, which is what keeps the previously focused app's Space and menu bar
/// untouched.
#[cfg(target_os = "macos")]
mod scratchpad {
    use objc2::runtime::AnyObject;
    use objc2::{define_class, ClassType, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSFloatingWindowLevel, NSPanel, NSScreen, NSWindowCollectionBehavior,
        NSWindowStyleMask, NSWindowTitleVisibility,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tauri::{Runtime, WebviewWindow};

    /// Click-through switch for the parked panel (ytm's trick): while the
    /// card is slid away, the invisible-but-present window must not eat
    /// clicks aimed at whatever is underneath it.
    pub fn set_click_through<R: Runtime>(window: &WebviewWindow<R>, through: bool) {
        let Ok(ptr) = window.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        unsafe {
            let panel = &*(ptr as *const NSPanel);
            panel.setIgnoresMouseEvents(through);
        }
    }

    /// Give up key focus without ordering the window out. The panel stays on
    /// stage (so WebKit keeps it painted) but parked off-window; typing
    /// keeps reaching the app the user is actually using.
    pub fn release_key<R: Runtime>(window: &WebviewWindow<R>) {
        let Ok(ptr) = window.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        unsafe {
            let panel = &*(ptr as *const NSPanel);
            if panel.isKeyWindow() {
                panel.resignKeyWindow();
            }
        }
    }

    define_class!(
        #[unsafe(super(NSPanel))]
        #[name = "WhatsAppQuickPanel"]
        #[thread_kind = MainThreadOnly]
        struct WhatsAppQuickPanel;

        impl WhatsAppQuickPanel {
            #[unsafe(method(canBecomeKeyWindow))]
            fn can_become_key_window(&self) -> bool {
                true
            }

            #[unsafe(method(canBecomeMainWindow))]
            fn can_become_main_window(&self) -> bool {
                true
            }
        }
    );

    /// Bottom centre of the PRIMARY display only — same rule as ytm. Never
    /// follow the mouse or the focused window onto a secondary display.
    /// Returns the frame; the caller decides whether to jump or animate to it.
    /// Falls back to the current frame when off the main thread (no screen
    /// query possible) — callers run on the main thread, so this is just a
    /// safety net.
    fn bottom_frame(panel: &NSPanel) -> NSRect {
        let current = panel.frame();
        let Some(mtm) = MainThreadMarker::new() else {
            return current;
        };
        let screens = NSScreen::screens(mtm);
        if screens.count() == 0 {
            return current;
        }
        let screen = screens.objectAtIndex(0);
        let vis = screen.visibleFrame();
        NSRect {
            origin: NSPoint {
                x: vis.origin.x + ((vis.size.width - current.size.width) * 0.5).round(),
                y: vis.origin.y,
            },
            size: NSSize {
                width: current.size.width,
                height: current.size.height,
            },
        }
    }

    /// Activate the app so the panel is a genuinely key window.
    ///
    /// Without this, ordering the nonactivating panel front makes it *look* key
    /// (it repaints, and it even reports Focused(true)) but the WKWebView never
    /// becomes first responder, so NOTHING typed reaches the palette until the
    /// user clicks inside it. Activation also makes blur trustworthy, which is
    /// what dismiss-on-click-away needs.
    /// Not used any more: activation was added to chase a keyboard problem that
    /// turned out not to exist. Kept out of the way to avoid changing behaviour
    /// the user has already confirmed works.
    #[allow(dead_code)]
    pub fn activate() {
        use objc2_app_kit::NSApplication;
        if let Some(mtm) = MainThreadMarker::new() {
            let app = NSApplication::sharedApplication(mtm);
            // NSApp.activate() is an "intentional activation" request on macOS
            // 14+ and is simply ignored for a background app, so this palette
            // (accessory, never frontmost) needs the forceful form.
            #[allow(deprecated)]
            app.activateIgnoringOtherApps(true);
        }
    }

    /// Hide the palette when the panel stops being the key window.
    ///
    /// Observed directly on the NSPanel rather than through Tauri's
    /// `WindowEvent::Focused`, which is unreliable for a nonactivating panel
    /// (our app is never the active app, so no deactivation is delivered and
    /// the event can be missed entirely). No extra permission is needed.
    pub fn on_resign_key<R, F>(window: &WebviewWindow<R>, handler: F)
    where
        R: Runtime,
        F: Fn() + 'static,
    {
        use block2::RcBlock;
        use objc2_app_kit::{NSWindow, NSWindowDidResignKeyNotification};
        use objc2_foundation::{NSNotificationCenter, NSNotification};
        use std::ptr::NonNull;

        let Ok(ptr) = window.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        let block = RcBlock::new(move |_note: NonNull<NSNotification>| handler());
        unsafe {
            let window_ref = &*(ptr as *const NSWindow);
            let center = NSNotificationCenter::defaultCenter();
            let token = center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidResignKeyNotification),
                Some(window_ref),
                None,
                &block,
            );
            // The registration lives only as long as the returned token, so leak
            // it for the lifetime of the process.
            Box::leak(Box::new(token));
        }
    }

    pub fn configure_panel<R: Runtime>(window: &WebviewWindow<R>) {
        let Ok(ptr) = window.ns_window() else {
            return;
        };
        if ptr.is_null() {
            return;
        }
        unsafe {
            let cls = WhatsAppQuickPanel::class();
            let obj = ptr as *mut AnyObject;
            if objc2::ffi::object_getClass(obj) != cls {
                objc2::ffi::object_setClass(obj, cls);
            }
            let panel = &*(ptr as *const NSPanel);
            panel.setStyleMask(
                NSWindowStyleMask::NonactivatingPanel | NSWindowStyleMask::FullSizeContentView,
            );
            panel.setTitleVisibility(NSWindowTitleVisibility::Hidden);
            panel.setTitlebarAppearsTransparent(true);
            panel.setFloatingPanel(true);
            panel.setBecomesKeyOnlyIfNeeded(false);
            panel.setHidesOnDeactivate(false);
            let join_all = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle
                | NSWindowCollectionBehavior::FullScreenDisallowsTiling;
            panel.setCollectionBehavior(join_all);
            panel.setLevel(NSFloatingWindowLevel);
            panel.setHasShadow(false);
            panel.setOpaque(false);
            let _ = window.set_background_color(None);
        }
    }

    /// Order front at the docked bottom-centre position, instantly. MUST run
    /// on the main thread. No frame animation here: the window is fully
    /// transparent and the slide is the page's CSS transition on .shell,
    /// which reverses smoothly from any mid-hide position.
    ///
    /// The panel class/styleMask is configured ONCE (at setup, while hidden):
    /// re-applying setStyleMask on a visible window repaints it, which is a
    /// needless flicker source now that the window is never ordered out.
    pub fn order_front_docked<R: Runtime>(window: &WebviewWindow<R>) {
        let Ok(ptr) = window.ns_window() else {
            let _ = window.show();
            return;
        };
        if ptr.is_null() {
            let _ = window.show();
            return;
        }
        unsafe {
            let panel = &*(ptr as *const NSPanel);
            let before = panel.frame();
            let target = bottom_frame(panel);
            eprintln!(
                "[quick] pin x={} y={} w={} h={} (was x={} y={} w={} h={})",
                target.origin.x,
                target.origin.y,
                target.size.width,
                target.size.height,
                before.origin.x,
                before.origin.y,
                before.size.width,
                before.size.height
            );
            panel.setFrame_display(target, false);
            panel.makeKeyAndOrderFront(None);
            eprintln!(
                "[quick] after orderFront visible={} key={} alpha={} level={} frame={{x:{},y:{},w:{},h:{}}}",
                panel.isVisible(),
                panel.isKeyWindow(),
                panel.alphaValue(),
                panel.level(),
                panel.frame().origin.x,
                panel.frame().origin.y,
                panel.frame().size.width,
                panel.frame().size.height
            );
            let join_all = NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::FullScreenAuxiliary
                | NSWindowCollectionBehavior::Transient
                | NSWindowCollectionBehavior::IgnoresCycle
                | NSWindowCollectionBehavior::FullScreenDisallowsTiling;
            panel.setCollectionBehavior(join_all);
            panel.setLevel(NSFloatingWindowLevel);
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            bridge_process: Mutex::new(None),
            pending_deep_link: Mutex::new(None),
            bridge_spawned_at: Mutex::new(None),
            heal_lock: Mutex::new(()),
        })
        .manage(OverlayState {
            shown: Mutex::new(false),
            was_focused: Mutex::new(false),
            shown_at: Mutex::new(None),
        })
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            ensure_bridge,
            restart_bridge,
            bridge_health,
            bridge_get_chats,
            bridge_get_messages,
            bridge_send_message,
            bridge_refresh,
            bridge_mark_seen,
            bridge_delete_chat,
            bridge_archive_chat,
            bridge_unarchive_chat,
            bridge_send_audio,
            bridge_send_image,
            bridge_send_media,
            bridge_edit_message,
            bridge_delete_message,
            bridge_react_message,
            bridge_get_link_preview,
            bridge_forward_message,
            bridge_get_media,
            bridge_get_profile_pic,
            open_url,
            open_media_external,
            get_pending_deep_link,
            log_debug,
            get_process_stats,
            hide_quick_cmd
        ])
        .setup(|app| {
            // THIS is the ytm line we were missing. Without it Tauri keeps a
            // regular activation policy, AeroSpace treats the app as a normal
            // tiled client, and focusing the palette jumps to the workspace
            // where the window was born (P).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // The page is served from a localhost HTTP server (spawned below),
            // NOT Tauri's `tauri://localhost` asset protocol. The asset protocol
            // is not a secure context on macOS WKWebView, so microphone access
            // (`navigator.mediaDevices.getUserMedia`, needed for voice notes) is
            // unavailable there. The capability declares `remote.urls` for
            // `http://localhost:*` so this trusted localhost page can still call
            // the app's own commands.
            let ui_dir = resolve_ui_dir(&app.handle()).expect("Cannot locate ui/ directory");
            let port = spawn_asset_server(ui_dir).expect("Cannot start asset server");
            let local_url = format!("http://localhost:{port}/index.html");
            println!("[quick] navigating webview to {local_url}");

            // Palette chrome: no native shadow, transparent backing, parked
            // off-screen until the global shortcut asks for it.
            if let Some(window) = app.get_webview_window("main") {
                let url = tauri::Url::parse(&local_url)
                    .expect("Failed to parse asset server URL");
                window
                    .navigate(url)
                    .expect("Failed to navigate webview to asset server");

                let _ = window.set_always_on_top(true);
                let _ = window.set_shadow(false);
                let _ = window.set_background_color(None);
                // Do NOT order front at launch. TinyCast opens this app on
                // workspace P; showing here is what pins the window to P so
                // later ⌘⇧M jumps there. ytm never gets launched from a
                // workspace-bound launcher — it just lives in the background.
                #[cfg(target_os = "macos")]
                {
                    let _ = window.set_visible_on_all_workspaces(true);
                    scratchpad::configure_panel(&window);
                }
                let _ = window.hide();
                println!("[quick] build 2026-09-17-v0.1.22");
            }

            register_toggle(app.handle());

            // Background watchdog: if the bridge's event loop starves (the
            // wedge that froze the UI), reclaim it automatically. Cheap: one
            // local HTTP hit every 30s, and strictly hands-off while the
            // full app is running.
            let watch = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(WATCHDOG_INTERVAL_SECS));
                if matches!(probe_bridge(), BridgeProbe::Wedged) && !full_app_running() {
                    let state = watch.state::<AppState>();
                    if let Err(err) = reclaim_stale_bridge(&state, &watch) {
                        eprintln!("quick: watchdog reclaim failed: {err}");
                    }
                }
            });

            // The app is an accessory (no Dock icon), so the menu-bar item is
            // the reliable way to show, hide, or quit it without a keyboard.
            let show_item =
                MenuItem::with_id(app, "show", "Show / Hide  (Cmd+Shift+M)", true, None::<&str>)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit WhatsApp Quick", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let mut tray = TrayIconBuilder::with_id("quick")
                .menu(&menu)
                .tooltip("WhatsApp Quick")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => toggle_quick(app),
                    "quit" => {
                        let state = app.state::<AppState>();
                        stop_bridge_process(&state);
                        // Fate-sharing: leave no orphaned bridge (or profile-
                        // locked Chrome) behind. Sweep is a no-op while the
                        // full app runs.
                        sweep_orphaned_bridge();
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Handle deep links (wkd:// scheme)
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    println!("[deep-link] Received URL: {url}");
                    let url_str = url.to_string();
                    // Store it so the frontend can fetch it on boot
                    let state = handle.state::<AppState>();
                    *state.pending_deep_link.lock().unwrap() = Some(url_str.clone());
                    // Also emit in case the frontend is already loaded
                    let _ = handle.emit("wkd-open-url", url_str);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::WindowEvent { event, .. } => match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        hide_quick_because(app_handle, "close-requested");
                    }
                    tauri::WindowEvent::Focused(true) => {
                        if let Ok(mut flag) = app_handle.state::<OverlayState>().was_focused.lock() {
                            *flag = true;
                        }
                    }
                    tauri::WindowEvent::Focused(false) => {
                        // Copied from ytm. No grace period: ytm has none.
                        let should_hide = app_handle
                            .state::<OverlayState>()
                            .was_focused
                            .lock()
                            .map(|mut flag| {
                                let hide = *flag;
                                *flag = false;
                                hide
                            })
                            .unwrap_or(false);
                        if should_hide {
                            hide_quick_because(app_handle, "blur");
                        }
                    }
                    _ => {}
                },
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    let state = app_handle.state::<AppState>();
                    stop_bridge_process(&state);
                    sweep_orphaned_bridge();
                }
                tauri::RunEvent::Resumed => {
                    println!("[sleep-wake] Received Resumed event from system - ensuring bridge is healthy");
                    let state = app_handle.state::<AppState>();
                    if let Err(err) = heal_bridge(&state, app_handle) {
                        eprintln!("[sleep-wake] bridge heal failed: {err}");
                    }
                }
                _ => {}
            }
        });
}
