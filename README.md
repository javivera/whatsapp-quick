# WhatsApp Quick

A standalone macOS palette: press **⌘⇧M** anywhere and a compact WhatsApp panel
slides up from the bottom of the screen. Read and answer messages with the
keyboard, then dismiss it.

It is a **separate app** from "WhatsApp Keyboard Desktop" — you can run it with
the full app closed, or with it open. It does not need a second QR scan.

```bash
cd ../whatsapp-quick        # or wherever this self-contained folder lives
npm run install            # builds, signs locally, installs to /Applications
open "/Applications/WhatsApp Quick.app"
```

## Sharing the bridge (the important part)

The bridge is `bridge_server.js` in this folder, bundled into this app
unchanged. Both apps run the *same* bridge code, so there is only one bridge
to maintain (the source of truth lives in `whatsapp_web_listener/bridge_server.js`;
copy it here if it changes).

Two mechanisms make the two apps cooperate:

1. **Attach first.** `ensure_bridge` probes `http://127.0.0.1:8787/health`
   before doing anything. The probe succeeds on *any* HTTP response, including
   the `503` a bridge returns while WhatsApp Web is still booting. If anything
   answers, this app attaches to it and never spawns a competitor.
2. **Shared session.** When nothing is listening, the app spawns its own bridge
   with `WEBJS_AUTH_DATA_DIR` pointed at the full app's session folder:

   ```
   ~/Library/Application Support/com.opencode.whatsappkeyboarddesktop/bridge/auth
   ```

   The `LocalAuth` client id is `gui` for both apps, so the existing
   `session-gui` is reused and **no QR scan is needed**. Only one bridge can
   hold that Chrome profile at a time — the attach-first probe guarantees that.

`WEBJS_AUTH_DATA_DIR` overrides the path if you ever need to point it elsewhere.
If no shared session exists yet, it falls back to this bundle's own data dir so
a fresh QR link still works.

### Ownership rule (do not break this)

This app must only ever tear down a bridge **it started itself**:

- `owns_bridge()` gates every restart decision.
- `stop_bridge_process` only sends `POST /shutdown` when its own child process
  is still alive.

The naive version posted `/shutdown` to the shared port whenever it had *any*
child handle, which killed the full app's bridge. Keep the ownership gate.

## Keyboard

| Key | Action |
| --- | --- |
| `⌘⇧M` | show / hide the palette (global, works from any app) |
| any letter, or `/` | jump to search and start filtering |
| `↑` `↓` / `k` `j` | move through chats |
| `↵` | open the selected chat |
| `⇥` | from the chat list, jump to the composer |
| `↑` `↓` in an empty composer | jump back to the chat list |
| `↵` in the composer | send (`⇧↵` for a newline) |
| `esc` | clear search → leave the composer → hide the palette |
| `⌘⇧M` again / tray item | dismiss |
| click another app, `⌘⇥` | dismiss (loses focus) |

There is also a menu-bar item (Show / Hide, Quit) because the app is an
accessory (`LSUIElement`), so it has no Dock icon.

## Architecture notes

- **UI origin.** The page is served from Tauri's own asset protocol, *not* from
  a localhost HTTP server. A remote origin (`http://localhost:<port>`) is gated
  by Tauri's ACL, which rejects the app's own commands with
  `Command … not allowed by ACL`. Consequence: no microphone access, so **voice
  notes are not sendable from this palette yet**. Adding them means either
  declaring `remote.urls` for a *fixed* asset-server port, or another secure
  context.
- **Window.** A nonactivating `NSPanel` (`canBecomeKeyWindow → true`) ordered
  front without activating the app, so the palette takes keystrokes without
  stealing the focused app's Space or menu bar. Bottom-anchored inside
  `NSScreen.visibleFrame`, so a Dock never covers it.
- **Never use `CanJoinAllSpaces` / `visibleOnAllWorkspaces`.** It makes
  space-managing window managers (AeroSpace) switch Spaces when the palette
  opens — the palette must "pop up where I am". It *also* made AppKit churn the
  panel's key status immediately after showing, which is what made
  hide-on-blur look broken and unfixable. Use
  `NSWindowCollectionBehavior::MoveToActiveSpace | FullScreenAuxiliary`
  instead: the panel moves to the user's Space and keeps key status.
- **Dismissal.** `Esc`, the global shortcut, the tray item, or the window close
  button. Plus "lose focus": a blur hides the panel, and an
  `NSWorkspaceDidActivateApplicationNotification` observer hides it when another
  app becomes active (clicking another app's window, `⌘⇥`).
  - The blur path ignores any blur within `BLUR_GRACE_MS` (700 ms) of showing,
    because the panel is ordered front without activating the app and AppKit can
    churn key status right after a show.
  - App-activation is used for "clicked away" rather than a **global mouse
    monitor**: `addGlobalMonitorForEventsMatchingMask` silently delivers nothing
    unless the app holds Accessibility permission, which this app does not
    request. Activation notifications need no permission.
  - Don't try to detect focus with Tauri's `WebviewWindow::is_focused()`: a
    nonactivating panel that is genuinely key reports `false` (observed
    `focused=false, visible=true` while keystrokes were landing), so a poll built
    on it hides the palette the instant it opens.
- **Chat column width is hard-pinned** (`width`/`min-width`/`max-width: 300px`).
  A flex item's `min-width: auto` resolves to its min-content size, so one
  unbreakable string — a base64 blob in a chat preview — would otherwise blow
  the column out to thousands of pixels and squeeze the thread to ~28px.
  Previews and bodies are also clamped in JS.

## Layout

```
whatsapp-quick/
  bridge_server.js          shared bridge (copied from whatsapp_web_listener)
  package.json              bridge deps + tauri CLI
  node_modules/             bridge + tauri dependencies
  scripts/install-macos.sh   build + sign + install to /Applications
  ui/                        index.html, quick.css, quick.js  (the palette)
  src-tauri/
    tauri.conf.json          window, bundle, bridge resources
    capabilities/default.json
    Info.plist               LSUIElement (accessory app)
    src/lib.rs               bridge commands + shortcut + NSPanel
```

`src/lib.rs` started as a copy of the full app's `lib.rs` (same 28 bridge
commands), with the asset server removed and the overlay layer added.

## Verifying a change

Any change is **not done** until the installed bundle is rebuilt and checked:

```bash
cd ../whatsapp-quick
npm run install
pkill -f "WhatsApp Quick.app/Contents/MacOS/whatsapp_quick"
"/Applications/WhatsApp Quick.app/Contents/MacOS/whatsapp_quick"   # keep stdout visible
```

Then press ⌘⇧M and look at it. The bridge's own logs are inherited by this
process, so a broken spawn is visible immediately. To inspect the live window
without the compositor in the way:

```bash
screencapture -x -o -l "$(python3 -c '
import Quartz
for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionAll, Quartz.kCGNullWindowID):
    if (w.get("kCGWindowOwnerName") or "")=="WhatsApp Quick":
        b=dict(w.get("kCGWindowBounds") or {})
        if b.get("Width")==820: print(w.get("kCGWindowNumber")); break')" /tmp/palette.png
```
