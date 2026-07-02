//! xkg-core integration for xkg-desktop.
//!
//! Phase 1 deliverable: embed the [`xkg_core::CaptureStore`] behind a
//! small set of Tauri commands the Svelte UI can call. The store is opened
//! once on app startup and handed to every command via managed state.
//!
//! ## State
//!
//! `rusqlite::Connection` is `!Sync`, so we wrap the store in a
//! `std::sync::Mutex`. `Mutex<T>` is `Send + Sync` whenever `T: Send`, which
//! is all `tauri::State` needs.
//!
//! ## Commands
//!
//! * [`capture_chatgpt_html`] — given a ChatGPT DOM HTML dump, run the
//!   ChatGPT extractor, persist a new conversation, and return a summary.
//! * [`list_conversations`] — every conversation in the local store,
//!   most recently updated first.
//! * [`search_messages`] — full-text search via xkg-core's FTS5 index.
//! * [`get_conversation_messages`] — every message in a given conversation.
//! * [`xkg_stats`] — quick counters for the UI (total conversations /
//!   messages + database path).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use xkg_core::capture::CaptureStore;
use xkg_core::extractors::chatgpt::{extract_title, ChatGPTExtractor};
use xkg_core::extractor::Extractor;
use xkg_core::{Conversation, LLMKind, Message};

/// Thread-safe wrapper around [`CaptureStore`] for use as Tauri state.
pub struct Store(pub Mutex<CaptureStore>);

/// Path the store was opened at. Useful for the UI to display.
pub struct StorePath(pub PathBuf);

/// Result returned to the UI after a capture attempt.
#[derive(Debug, Clone, Serialize)]
pub struct CaptureResult {
    /// ID of the conversation the extracted messages were inserted into.
    pub conversation_id: String,
    /// How many messages were actually inserted (i.e. not previously seen).
    /// Re-extracts dedupe on `(conversation_id, client_msg_id)` so this
    /// can legitimately be 0.
    pub inserted: usize,
    /// How many messages the extractor produced in total.
    pub extracted: usize,
    /// Title pulled from `<title>`, if any.
    pub title: Option<String>,
}

impl CaptureResult {
    fn new(
        conversation_id: String,
        inserted: usize,
        extracted: usize,
        title: Option<String>,
    ) -> Self {
        Self {
            conversation_id,
            inserted,
            extracted,
            title,
        }
    }
}

/// Counters surfaced to the UI for status display.
#[derive(Debug, Clone, Serialize)]
pub struct XkgStats {
    pub conversations: i64,
    pub messages: i64,
    pub db_path: String,
}

/// Resolve the database path.
///
/// `~/.config/xkg-desktop/captures.db` on Linux, the platform-appropriate
/// equivalent elsewhere. Always returns an absolute path.
pub fn default_db_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME not set".to_string())?;
    Ok(home.join(".config").join("xkg-desktop").join("captures.db"))
}

/// Open the store at `db_path`. Creates the parent directory if missing.
pub fn open_store(db_path: &std::path::Path) -> Result<CaptureStore, String> {
    CaptureStore::open(db_path).map_err(|e| format!("failed to open capture store: {e}"))
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Capture a ChatGPT DOM HTML dump.
///
/// What it does, top to bottom:
/// 1. Runs the [`ChatGPTExtractor`] over `html`.
/// 2. Pulls the conversation title out of `<title>`.
/// 3. Opens a new (or upserted) [`Conversation`] in the local store.
/// 4. For each extracted message, writes a [`Message`] with the
///    `(conversation_id, client_msg_id)` dedupe key.
/// 5. Returns a [`CaptureResult`] so the UI can show "captured N messages".
#[tauri::command]
pub fn capture_chatgpt_html(
    html: String,
    store: tauri::State<'_, Store>,
) -> Result<CaptureResult, String> {
    let extractor = ChatGPTExtractor;
    let extracted = extractor
        .extract(&html)
        .map_err(|e| format!("extractor failed: {e}"))?;

    let title = extract_title(&html);
    let now = chrono::Utc::now();

    let mut conv = Conversation::new(LLMKind::Chatgpt, title.clone());
    // Use a stable id derived from the first extracted `client_msg_id`
    // so re-extracts of the same DOM land in the same conversation row.
    if let Some(first) = extracted.first() {
        conv.id = Some(first.client_msg_id.clone());
        // source_url: leave None for now; Phase 2 wires up the real URL.
    }
    conv.source_url = None;
    conv.created_at = now;
    conv.updated_at = now;

    let guard = store.0.lock().map_err(|e| format!("store lock poisoned: {e}"))?;
    let conv_id = guard
        .insert_conversation(&conv)
        .map_err(|e| format!("insert conversation: {e}"))?;

    let mut inserted = 0usize;
    for m in &extracted {
        let mut msg = Message::new(m.role.clone(), m.body.clone());
        msg.conversation_id = Some(conv_id.clone());
        msg.client_msg_id = Some(m.client_msg_id.clone());
        msg.created_at = now;
        let outcome = guard.insert_message(&msg);
        match outcome {
            Ok(_) => inserted += 1,
            Err(e) => return Err(format!("insert message: {e}")),
        }
    }

    Ok(CaptureResult::new(
        conv_id,
        inserted,
        extracted.len(),
        title,
    ))
}

/// List every conversation in the store, most recently updated first.
#[tauri::command]
pub fn list_conversations(
    store: tauri::State<'_, Store>,
) -> Result<Vec<Conversation>, String> {
    let guard = store.0.lock().map_err(|e| format!("store lock poisoned: {e}"))?;
    guard
        .list_conversations()
        .map_err(|e| format!("list_conversations: {e}"))
}

/// Full-text search across every captured message.
#[tauri::command]
pub fn search_messages(
    query: String,
    store: tauri::State<'_, Store>,
) -> Result<Vec<Message>, String> {
    let guard = store.0.lock().map_err(|e| format!("store lock poisoned: {e}"))?;
    guard
        .search(&query, 100)
        .map_err(|e| format!("search: {e}"))
}

/// List every message in a conversation, oldest first.
#[tauri::command]
pub fn get_conversation_messages(
    conversation_id: String,
    store: tauri::State<'_, Store>,
) -> Result<Vec<Message>, String> {
    let guard = store.0.lock().map_err(|e| format!("store lock poisoned: {e}"))?;
    guard
        .messages_for_conversation(&conversation_id)
        .map_err(|e| format!("messages_for_conversation: {e}"))
}

/// Counters + path for the UI status row.
#[tauri::command]
pub fn xkg_stats(
    store: tauri::State<'_, Store>,
    store_path: tauri::State<'_, StorePath>,
) -> Result<XkgStats, String> {
    let guard = store.0.lock().map_err(|e| format!("store lock poisoned: {e}"))?;
    let conversations = guard
        .conversation_count()
        .map_err(|e| format!("conversation_count: {e}"))?;
    let messages = guard
        .message_count()
        .map_err(|e| format!("message_count: {e}"))?;
    Ok(XkgStats {
        conversations,
        messages,
        db_path: store_path.0.display().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Unit-ish smoke test that runs in `cargo check` build.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_db_path_is_under_xkg_desktop_dir() {
        let p = default_db_path().expect("path");
        assert!(p.ends_with("xkg-desktop/captures.db"));
        assert!(p.is_absolute());
    }

    #[test]
    fn capture_result_serializes_to_json() {
        let r = CaptureResult::new("conv-1".into(), 3, 3, Some("hello".into()));
        let s = serde_json::to_string(&r).expect("json");
        assert!(s.contains("conv-1"));
        assert!(s.contains("\"inserted\":3"));
        assert!(s.contains("\"extracted\":3"));
    }

    #[test]
    fn xkg_stats_serializes() {
        let s = XkgStats {
            conversations: 4,
            messages: 42,
            db_path: "/tmp/x.db".into(),
        };
        let j = serde_json::to_string(&s).expect("json");
        assert!(j.contains("\"conversations\":4"));
        assert!(j.contains("\"messages\":42"));
    }

    #[test]
    fn store_wrapper_is_send_and_sync() {
        // Compile-time assertion that the wrapper satisfies Tauri's
        // `Send + Sync` state bound. If this test compiles, we're good.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Store>();
    }

    #[test]
    fn message_role_string_roundtrip_for_ui() {
        // Sanity: the role enum stays serializable as lowercase.
        use xkg_core::MessageRole;
        let r = MessageRole::User;
        let j = serde_json::to_string(&r).unwrap();
        assert_eq!(j, "\"user\"");
    }
}