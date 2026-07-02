// XKG Desktop — Tauri 2.x main entry point.
//
// Wires up the global-shortcut plugin (handled in shortcuts.rs),
// the autostart plugin (login items), and the supporting Tauri
// commands consumed by the Settings.svelte panel.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod shortcuts;
mod xkg;

use serde::Serialize;
use shortcuts::{import_text, register_shortcut, ShortcutState2};
use tauri::Manager;
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_autostart::ManagerExt;

use xkg::{
    capture_html, default_db_path, get_conversation_messages, list_conversations,
    open_store, search_messages, xkg_stats, Store, StorePath,
};

// AppState removed — we use shortcuts::ShortcutState2 for the
// last-import cache (set by import_text).

#[derive(Serialize)]
struct PlatformInfo {
    platform: String,
    os_version: String,
}

#[tauri::command]
fn get_platform_info() -> PlatformInfo {
    PlatformInfo {
        platform: std::env::consts::OS.to_string(),
        os_version: sysinfo_os_version().unwrap_or_default(),
    }
}

#[tauri::command]
fn get_last_import_info(state: tauri::State<'_, ShortcutState2>) -> Option<serde_json::Value> {
    state.last_import.lock().ok().and_then(|g| {
        g.as_ref().map(|r| serde_json::to_value(r).unwrap_or(serde_json::Value::Null))
    })
}

#[tauri::command]
async fn test_hub_connection(url: String) -> Result<serde_json::Value, String> {
    // Quick GET /api/health check.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("client build failed: {}", e))?;
    let health_url = format!("{}/api/health", url.trim_end_matches('/'));
    let resp = client.get(&health_url).send().await
        .map_err(|e| format!("request failed: {}", e))?;
    let status = resp.status();
    if status.is_success() {
        Ok(serde_json::json!({ "ok": true, "status": status.as_u16() }))
    } else {
        Ok(serde_json::json!({ "ok": false, "error": format!("HTTP {}", status.as_u16()) }))
    }
}

/// Best-effort OS version string (used only for the settings footer).
fn sysinfo_os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/os-release").ok().and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("PRETTY_NAME="))
                .map(|l| l.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_string())
        })
    }
    #[cfg(target_os = "windows")]
    {
        // Best we can do without pulling in a heavy dep
        std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            // CLI args passed to the app on auto-launch. We don't need any.
            Some(vec![]),
        ))
        .manage(ShortcutState2::default())
        .invoke_handler(tauri::generate_handler![
            import_text,
            get_platform_info,
            get_last_import_info,
            test_hub_connection,
            capture_html,
            list_conversations,
            search_messages,
            get_conversation_messages,
            xkg_stats,
        ])
        .setup(|app| {
            // Register the system-wide shortcut (Ctrl+Shift+X by default).
            if let Err(e) = register_shortcut(&app.handle()) {
                eprintln!("[xkg-desktop] failed to register shortcut: {}", e);
            }
            // For testing convenience: log the autostart status on startup.
            // The settings UI will read this via plugin:autostart|is_enabled.
            let autostart = app.autolaunch();
            match autostart.is_enabled() {
                Ok(true) => eprintln!("[xkg-desktop] autostart: ENABLED"),
                Ok(false) => eprintln!("[xkg-desktop] autostart: disabled"),
                Err(e) => eprintln!("[xkg-desktop] autostart check failed: {}", e),
            }
            // Ensure app data dir exists for future persistence use
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
            }

            // Open the xkg-core CaptureStore at ~/.config/xkg-desktop/captures.db
            // and hand it to every Tauri command via managed state. This is
            // the local-first SQLite (FTS5) store the capture/search UI reads.
            match default_db_path() {
                Ok(path) => {
                    match open_store(&path) {
                        Ok(store) => {
                            eprintln!(
                                "[xkg-desktop] capture store opened at {}",
                                path.display()
                            );
                            app.manage(Store(std::sync::Mutex::new(store)));
                            app.manage(StorePath(path));
                        }
                        Err(e) => {
                            eprintln!("[xkg-desktop] failed to open capture store: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[xkg-desktop] could not resolve db path: {}", e);
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running XKG desktop app");
}


