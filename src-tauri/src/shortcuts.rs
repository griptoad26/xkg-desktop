//! XKG Desktop — Global keyboard shortcut handler.
//!
//! This is the main deliverable for TASK-XKG-20260612-180.
//!
//! Registers a system-wide shortcut (default Ctrl+Shift+X, configurable
//! via the `XKG_GLOBAL_SHORTCUT` env var) that, when pressed, opens a
//! small floating capture dialog. The user types into a textarea, hits
//! Save (or Cmd/Ctrl+Enter), and the text is POSTed to the cluster
//! hub at `/api/import` (default `http://127.0.0.1:8090`, configurable
//! via `XKG_HUB_URL`).
//!
//! Architecture
//! ============
//! - `register_shortcut` is called from `main.rs` after the Tauri
//!   app is built but before `.run()`.
//! - We use `tauri-plugin-global-shortcut` (the official Tauri 2.x
//!   plugin) which wraps the OS-level shortcut APIs (CGEventTap on
//!   macOS, RegisterHotKey on Windows, GRAB_KEYBOARD on Linux).
//! - On shortcut press, we toggle a small always-on-top window
//!   (`capture-window`) that contains the dialog.
//! - The dialog itself is plain HTML in `src/capture.html` and
//!   talks to Rust via the Tauri command `import_text`.
//! - `import_text` does the POST to the hub using `reqwest`.
//!
//! Why not just a CLI or browser bookmarklet?
//! ----------------------------------------
//! A global shortcut has to be registered with the OS to work
//! system-wide. Tauri's global-shortcut plugin is the most
//! batteries-included way to do this in Rust without writing
//! platform-specific bindings yourself.
//!
//! References
//! ----------
//! - https://v2.tauri.app/plugin/global-shortcut/
//! - https://docs.rs/tauri-plugin-global-shortcut/latest/

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// State held by the app: the last known visibility of the capture window
/// (so we can toggle correctly when the shortcut is pressed).
#[derive(Default)]
pub struct ShortcutState2 {
    pub last_import: Mutex<Option<ImportResult>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportRequest {
    pub text: String,
    pub title: Option<String>,
    pub topic: Option<String>,
    pub tags: Option<Vec<String>>,
    pub author_id: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub ok: bool,
    pub id: Option<String>,
    pub duplicate: bool,
    pub error: Option<String>,
    pub total_imports: Option<u64>,
}

/// Default shortcut: Ctrl+Shift+X. Override via env var
/// `XKG_GLOBAL_SHORTCUT` (e.g. "CmdOrCtrl+Shift+Y").
pub fn default_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyX)
}

/// Parse a shortcut string like "CmdOrCtrl+Shift+X" or "Alt+Space".
/// Returns None if the string can't be parsed.
pub fn parse_shortcut(s: &str) -> Option<Shortcut> {
    // We accept the same syntax Tauri uses in tauri.conf.json:
    //   modifiers joined by '+', separated from the key by '+'
    // Examples:
    //   "CmdOrCtrl+Shift+X"
    //   "Alt+KeyQ"
    //   "Shift+Space"
    let parts: Vec<&str> = s.split('+').map(str::trim).collect();
    if parts.is_empty() { return None; }
    let (modifiers, key) = parts.split_at(parts.len() - 1);
    let key_str = key[0];
    let mut mods = Modifiers::empty();
    for m in modifiers {
        let m_low = m.to_lowercase();
        match m_low.as_str() {
            "cmdorctrl" | "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" => mods |= Modifiers::ALT,
            "super" | "meta" | "cmd" | "command" | "win" | "windows" => mods |= Modifiers::META,
            _ => return None,
        }
    }
    // Strip the "Key" prefix if present ("KeyX" -> "X")
    let key_clean = key_str
        .strip_prefix("Key")
        .or_else(|| key_str.strip_prefix("Digit"))
        .unwrap_or(key_str);
    // Try to map the key to a Code enum variant
    let code = match_code(key_clean)?;
    Some(Shortcut::new(Some(mods), code))
}

fn match_code(key: &str) -> Option<Code> {
    use Code::*;
    let single_char = |c: char| -> Option<Code> {
        match c {
            'A' => Some(KeyA), 'B' => Some(KeyB), 'C' => Some(KeyC), 'D' => Some(KeyD),
            'E' => Some(KeyE), 'F' => Some(KeyF), 'G' => Some(KeyG), 'H' => Some(KeyH),
            'I' => Some(KeyI), 'J' => Some(KeyJ), 'K' => Some(KeyK), 'L' => Some(KeyL),
            'M' => Some(KeyM), 'N' => Some(KeyN), 'O' => Some(KeyO), 'P' => Some(KeyP),
            'Q' => Some(KeyQ), 'R' => Some(KeyR), 'S' => Some(KeyS), 'T' => Some(KeyT),
            'U' => Some(KeyU), 'V' => Some(KeyV), 'W' => Some(KeyW), 'X' => Some(KeyX),
            'Y' => Some(KeyY), 'Z' => Some(KeyZ),
            '0' => Some(Digit0), '1' => Some(Digit1), '2' => Some(Digit2), '3' => Some(Digit3),
            '4' => Some(Digit4), '5' => Some(Digit5), '6' => Some(Digit6), '7' => Some(Digit7),
            '8' => Some(Digit8), '9' => Some(Digit9),
            _ => None,
        }
    };
    // Single character
    if key.len() == 1 {
        if let Some(c) = key.chars().next() {
            if let Some(code) = single_char(c.to_ascii_uppercase()) {
                return Some(code);
            }
        }
    }
    // Named keys
    match key.to_lowercase().as_str() {
        "space" => Some(Space),
        "enter" | "return" => Some(Enter),
        "tab" => Some(Tab),
        "escape" | "esc" => Some(Escape),
        "backspace" => Some(Backspace),
        "delete" | "del" => Some(Delete),
        "home" => Some(Home),
        "end" => Some(End),
        "pageup" => Some(PageUp),
        "pagedown" => Some(PageDown),
        "arrowup" | "up" => Some(ArrowUp),
        "arrowdown" | "down" => Some(ArrowDown),
        "arrowleft" | "left" => Some(ArrowLeft),
        "arrowright" | "right" => Some(ArrowRight),
        "f1" => Some(F1), "f2" => Some(F2), "f3" => Some(F3), "f4" => Some(F4),
        "f5" => Some(F5), "f6" => Some(F6), "f7" => Some(F7), "f8" => Some(F8),
        "f9" => Some(F9), "f10" => Some(F10), "f11" => Some(F11), "f12" => Some(F12),
        _ => None,
    }
}

/// Build the Tauri command name we'll register the import endpoint under.
/// (Kept as a named constant for any future frontend references; the
/// command is registered in main.rs via `tauri::generate_handler!`.)
#[allow(dead_code)]
pub const IMPORT_COMMAND: &str = "import_text";

/// Register the global shortcut and the import command. Call this
/// from `.setup()` of the Tauri app builder.
pub fn register_shortcut(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Resolve which shortcut to use: env var, then default.
    let shortcut = match std::env::var("XKG_GLOBAL_SHORTCUT") {
        Ok(s) if !s.is_empty() => match parse_shortcut(&s) {
            Some(sc) => sc,
            None => {
                eprintln!(
                    "[xkg-desktop] could not parse XKG_GLOBAL_SHORTCUT={:?}; using default Ctrl+Shift+X",
                    s
                );
                default_shortcut()
            }
        },
        _ => default_shortcut(),
    };
    eprintln!("[xkg-desktop] registering global shortcut: {:?}", shortcut);

    let app_handle = app.clone();
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |_app, sc, event| {
                if sc == &shortcut && event.state == ShortcutState::Pressed {
                    if let Err(e) = toggle_capture_window(&app_handle) {
                        eprintln!("[xkg-desktop] failed to toggle capture window: {}", e);
                    }
                }
            })
            .build(),
    )?;

    // Register the shortcut with the OS.
    app.global_shortcut().register(shortcut)?;

    // Build the capture window up-front, but keep it hidden. Showing
    // it is cheap; building on first press feels laggy.
    let _ = build_capture_window(app);

    Ok(())
}

/// Open or focus the capture window. If already open, focus it.
/// If closed/hidden, build + show it.
pub fn toggle_capture_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(win) = app.get_webview_window("capture") {
        // Window exists — toggle visibility
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    } else {
        // Build it fresh
        build_capture_window(app)?;
    }
    Ok(())
}

fn build_capture_window(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let win = WebviewWindowBuilder::new(
        app,
        "capture",
        WebviewUrl::App("capture.html".into()),
    )
    .title("XKG Capture")
    .inner_size(480.0, 280.0)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .always_on_top(true)
    .decorations(true)
    .skip_taskbar(true)
    .visible(false)
    .build()?;
    // Center on screen
    if let Some(monitor) = win.current_monitor()? {
        let mon_size = monitor.size();
        let win_size = win.outer_size()?;
        let x = (mon_size.width as i32 - win_size.width as i32) / 2;
        let y = (mon_size.height as i32 - win_size.height as i32) / 3;
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    Ok(())
}

/// Tauri command: import a piece of text. Called from the capture
/// dialog's "Save" button. This is a synchronous command (Tauri
/// runs it in a separate thread, so the UI doesn't block).
#[tauri::command]
pub async fn import_text(
    request: ImportRequest,
    state: State<'_, ShortcutState2>,
) -> Result<ImportResult, String> {
    let result = post_to_hub(&request).await.map_err(|e| e.to_string())?;
    // Cache the last result so the UI can show "last captured" status
    if let Ok(mut last) = state.last_import.lock() {
        *last = Some(result.clone());
    }
    Ok(result)
}

async fn post_to_hub(req: &ImportRequest) -> Result<ImportResult, Box<dyn std::error::Error>> {
    let hub_url = std::env::var("XKG_HUB_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8090".to_string());
    let url = format!("{}/api/import", hub_url.trim_end_matches('/'));

    // We use reqwest for the HTTP client. Add to Cargo.toml:
    //   reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
    // If you don't want the TLS dep, swap to ureq or a manual
    // implementation over TcpStream.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let body = serde_json::json!({
        "text": req.text,
        "title": req.title,
        "topic": req.topic,
        "tags": req.tags,
        "author_id": req.author_id,
        "source": req.source.as_deref().unwrap_or("xkg-desktop"),
    });
    let resp = client.post(&url).json(&body).send().await?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await?;
    if !status.is_success() {
        return Ok(ImportResult {
            ok: false,
            id: None,
            duplicate: false,
            error: Some(format!("hub returned {}: {}", status, body)),
            total_imports: None,
        });
    }
    Ok(ImportResult {
        ok: body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        id: body.get("id").and_then(|v| v.as_str()).map(String::from),
        duplicate: body.get("duplicate").and_then(|v| v.as_bool()).unwrap_or(false),
        error: body.get("error").and_then(|v| v.as_str()).map(String::from),
        total_imports: body.get("total_imports").and_then(|v| v.as_u64()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_shortcut() {
        // Just make sure it doesn't panic
        let _ = default_shortcut();
    }

    #[test]
    fn test_parse_shortcut() {
        let sc = parse_shortcut("CmdOrCtrl+Shift+X").expect("should parse");
        let _ = sc; // we can't easily introspect, but no panic is enough

        // Wrong modifier should fail
        assert!(parse_shortcut("Bogus+Shift+X").is_none());

        // Just a key, no modifier, should still parse
        let _ = parse_shortcut("Space");
    }

    #[test]
    fn test_match_code() {
        use Code::*;
        assert_eq!(match_code("X"), Some(KeyX));
        assert_eq!(match_code("x"), Some(KeyX));
        assert_eq!(match_code("Space"), Some(Space));
        assert_eq!(match_code("Enter"), Some(Enter));
        assert_eq!(match_code("F5"), Some(F5));
        assert_eq!(match_code("BogusKey"), None);
    }
}
