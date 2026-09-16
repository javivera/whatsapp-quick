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

struct AppState {
    bridge_process: Mutex<Option<Child>>,
    pending_deep_link: Mutex<Option<String>>,
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
            let _ = child.wait();
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

/// Reachability probe that succeeds on ANY HTTP response, including the 503 a
/// bridge returns while WhatsApp Web is still booting. Used to decide whether a
/// bridge already exists before spawning a competitor on the same port.
fn bridge_reachable() -> Option<Value> {
    let client = health_http_client().ok()?;
    let response = client
        .get(format!("{}/health", bridge_base_url()))
        .send()
        .ok()?;
    response.json::<Value>().ok()
}

#[tauri::command]
fn ensure_bridge(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<Value, String> {
    if let Some(payload) = bridge_reachable() {
        let unhealthy = should_restart_bridge(&payload);
        eprintln!(
            "quick: attached to existing bridge (status={}, owner={})",
            payload.get("status").and_then(Value::as_str).unwrap_or("-"),
            if owns_bridge(&state) { "self" } else { "other-app" }
        );
        // Attach to an existing bridge, ready or not. Only a bridge this
        // process owns may be torn down and replaced.
        if !unhealthy || !owns_bridge(&state) {
            return Ok(payload);
        }
        stop_bridge_process(&state);
    } else {
        eprintln!("quick: no bridge listening; starting one on the shared session");
    }

    spawn_bridge_if_needed(&state, &app)?;
    std::thread::sleep(Duration::from_millis(900));

    if let Ok(payload) = bridge_get_health_check("/health") {
        return Ok(payload);
    }

    if let Some(payload) = bridge_reachable() {
        return Ok(payload);
    }

    Ok(json!({
        "success": true,
        "ready": false,
        "status": "starting_bridge"
    }))
}

#[tauri::command]
fn restart_bridge(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<Value, String> {
    stop_bridge_process(&state);
    spawn_bridge_if_needed(&state, &app)?;
    std::thread::sleep(Duration::from_millis(900));

    if let Ok(payload) = bridge_get_health_check("/health") {
        return Ok(payload);
    }

    Ok(json!({
        "success": true,
        "ready": false,
        "status": "starting_bridge"
    }))
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

            // The page is served from Tauri's own asset protocol (frontendDist)
            // rather than a localhost HTTP server. A remote origin
            // (http://localhost:<port>) is gated by Tauri's ACL, which rejects
            // the app's own commands with "not allowed by ACL". The asset
            // protocol origin is local, so the bridge commands work without a
            // `remote.urls` declaration. Consequence: no microphone access yet,
            // which is fine while this palette is text-only.

            // Palette chrome: no native shadow, transparent backing, parked
            // off-screen until the global shortcut asks for it.
            if let Some(window) = app.get_webview_window("main") {
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
                println!("[quick] build 2026-09-16-v0.1.20");
            }

            register_toggle(app.handle());

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
                }
                tauri::RunEvent::Resumed => {
                    println!("[sleep-wake] Received Resumed event from system - ensuring bridge is healthy");
                    let state = app_handle.state::<AppState>();
                    // Check if bridge needs restart due to stale connection
                    if let Ok(payload) = bridge_get_health_check("/health") {
                        if should_restart_bridge(&payload) || 
                           !payload.get("ready").and_then(Value::as_bool).unwrap_or(false) {
                            println!("[sleep-wake] Bridge health check failed - restarting...");
                            stop_bridge_process(&state);
                            std::thread::sleep(Duration::from_millis(500));
                            let _ = spawn_bridge_if_needed(&state, &app_handle);
                        }
                    } else {
                        println!("[sleep-wake] Could not reach bridge - restarting...");
                        stop_bridge_process(&state);
                        std::thread::sleep(Duration::from_millis(500));
                        let _ = spawn_bridge_if_needed(&state, &app_handle);
                    }
                }
                _ => {}
            }
        });
}
