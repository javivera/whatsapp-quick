// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // ytm sets Accessory in setup, which is AFTER Tauri has already created
    // the window. AeroSpace then sees a regular app window, assigns it to
    // whatever workspace you were on at launch (P), and later ⌘⇧M jumps there.
    // Set the policy before Tauri starts so the window is never a tiled client.
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
        if let Some(mtm) = MainThreadMarker::new() {
            NSApplication::sharedApplication(mtm)
                .setActivationPolicy(NSApplicationActivationPolicy::Accessory);
        }
    }
    whatsapp_quick_lib::run();
}
