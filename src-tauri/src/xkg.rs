//! xkg-core integration for xkg-desktop.
//!
//! Phase 2 deliverable: embed the [`xkg_core::CaptureStore`] behind a
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
//! * [`capture_html`] — given a DOM HTML dump + LLM kind, run the matching
//!   extractor from the [`xkg_core::extractor`] registry, persist a new
//!   conversation, and return a summary. Phase 2: polymorphic across
//!   ChatGPT / Claude / Grok (Phase 1 was ChatGPT-only).
//! * [`list_conversations`] — every conversation in the local store,
//!   most recently updated first.
//! * [`search_messages`] — full-text search via xkg-core's FTS5 index.
//! * [`get_conversation_messages`] — every message in a given conversation.
//! * [`xkg_stats`] — quick counters for the UI (total conversations /
//!   messages + database path).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use xkg_core::capture::{CaptureStore, SearchFilters, SearchHit};
use xkg_core::extractor::get_extractor;
use xkg_core::extractors::chatgpt::extract_title;
use xkg_core::graph::{GraphQueryResult, GraphResult};
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

/// Capture a DOM HTML dump from one of the supported LLMs.
///
/// Phase 2 replaces the Phase 1 [`capture_chatgpt_html`] (which hardcoded
/// the ChatGPT extractor) with a polymorphic command that looks the right
/// extractor up via [`xkg_core::extractor::get_extractor`]. The `llm`
/// argument selects which extractor to run — `"chatgpt"`, `"claude"`, or
/// `"grok"` for now; the registry returns `None` for not-yet-implemented
/// LLMs (Gemini, Perplexity) and we surface that as an error.
///
/// What it does, top to bottom:
/// 1. Parses `llm` into an [`LLMKind`] and resolves the extractor via the
///    registry. Errors out for unknown LLMs or unimplemented extractors.
/// 2. Runs the resolved extractor over `html`.
/// 3. Pulls the conversation title out of `<title>` (ChatGPT-flavored
///    for now — Phase 3+ will let each extractor supply its own title).
/// 4. Opens a new (or upserted) [`Conversation`] in the local store, with
///    `conv.llm` set from the resolved kind.
/// 5. For each extracted message, writes a [`Message`] with the
///    `(conversation_id, client_msg_id)` dedupe key.
/// 6. Returns a [`CaptureResult`] so the UI can show "captured N messages".
#[tauri::command]
pub fn capture_html(
    html: String,
    llm: String, // "chatgpt" | "claude" | "grok"
    store: tauri::State<'_, Store>,
) -> Result<CaptureResult, String> {
    // 1. Resolve LLM kind.
    let kind = match llm.as_str() {
        "chatgpt" => LLMKind::Chatgpt,
        "claude" => LLMKind::Claude,
        "grok" => LLMKind::Grok,
        other => return Err(format!("unsupported LLM: {}", other)),
    };

    // 2. Look up the extractor via the registry.
    let extractor =
        get_extractor(kind).ok_or_else(|| format!("no extractor registered for {:?}", kind))?;

    // 3. Run it.
    let extracted = extractor
        .extract(&html)
        .map_err(|e| format!("extractor failed: {e}"))?;

    // 4. Title (ChatGPT-flavored for now; per-extractor titles land later).
    let title = extract_title(&html);
    let now = chrono::Utc::now();

    // 5. Upsert the conversation.
    let mut conv = Conversation::new(kind, title.clone());
    if let Some(first) = extracted.first() {
        conv.id = Some(first.client_msg_id.clone());
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

/// Phase 5a: full-text search with LLM / date-range / has-code /
/// has-citations filters. Returns [`SearchHit`] rows in bm25 rank order.
///
/// `filters` carries optional filter dimensions; missing fields mean
/// "no restriction on this dimension". An empty / blank `query` returns
/// an empty vector (same contract as [`search_messages`]).
#[tauri::command]
pub fn search_advanced(
    query: String,
    filters: SearchFilters,
    limit: usize,
    store: tauri::State<'_, Store>,
) -> Result<Vec<SearchHit>, String> {
    let guard = store.0.lock().map_err(|e| format!("store lock poisoned: {e}"))?;
    guard
        .search_advanced(&query, &filters, limit)
        .map_err(|e| format!("search_advanced: {e}"))
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

/// Build a topic graph for `query`. Returns nodes (topics + their
/// message ids) and edges (pairs of topics co-mentioned by the same
/// message, weighted by the number of shared messages).
///
/// Phase 3 deliverable: backs the Graph.svelte tab. Defaults to a
/// 20-node / 40-edge graph which is plenty for the "circle of dots +
/// lines" SVG visualization.
#[tauri::command]
pub fn graph_query(
    query: String,
    store: tauri::State<'_, Store>,
) -> Result<GraphQueryResult, String> {
    let guard = store.0.lock().map_err(|e| format!("store lock poisoned: {e}"))?;
    let res: GraphResult<GraphQueryResult> = guard.graph_query(&query, 20, 40);
    res.map_err(|e| format!("graph_query: {e}"))
}

/// Build the deep-link URL for the "Continue in browser" action.
///
/// `llm` is one of `"chatgpt"`, `"claude"`, or `"grok"`. `title` is the
/// conversation's first user prompt, percent-encoded into the `?q=`
/// query param so the LLM web UI pre-fills the prompt box.
///
/// Extracted as a free function so the unit tests in
/// `tests/continue_in_browser.rs` can verify the URL templates without
/// spinning up a full Tauri runtime.
pub fn build_continue_url(llm: &str, title: &str) -> Result<String, String> {
    let encoded = urlencoding::encode(title).into_owned();
    let url = match llm {
        "chatgpt" => format!("https://chatgpt.com/?q={}", encoded),
        "claude" => format!("https://claude.ai/new?q={}", encoded),
        "grok" => format!("https://grok.com/?q={}", encoded),
        other => return Err(format!("unsupported LLM: {}", other)),
    };
    Ok(url)
}

/// Phase 5a: open the system browser on the matching LLM's new-chat
/// page, with the conversation title pre-filled as the prompt.
///
/// `tauri_plugin_shell::ShellExt::shell(&app).open(url, None)` works
/// on all three desktop targets (macOS, Linux, Windows) because it
/// defers to the platform's "open" / "xdg-open" / "start" helper.
#[tauri::command]
pub async fn continue_in_browser(
    llm: String,
    title: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // `tauri_plugin_shell::ShellExt::shell(&app).open(url, None)` is
    // the recommended pattern from the Phase 5a spec, even though the
    // method is now marked deprecated in favor of `tauri-plugin-opener`
    // (which is a 2.x-only split-out crate). The allow is scoped to
    // the single call so the rest of the file stays warning-clean.
    let url = build_continue_url(&llm, &title)?;
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(url, None)
        .map_err(|e| format!("failed to open browser: {e}"))?;
    Ok(())
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

    #[test]
    fn build_continue_url_chatgpt() {
        let u = build_continue_url("chatgpt", "hello world").expect("url");
        assert_eq!(u, "https://chatgpt.com/?q=hello%20world");
    }

    #[test]
    fn build_continue_url_claude() {
        let u = build_continue_url("claude", "what is rust?").expect("url");
        assert_eq!(u, "https://claude.ai/new?q=what%20is%20rust%3F");
    }

    #[test]
    fn build_continue_url_grok() {
        let u = build_continue_url("grok", "rust & sqlite").expect("url");
        assert_eq!(u, "https://grok.com/?q=rust%20%26%20sqlite");
    }

    #[test]
    fn build_continue_url_unsupported_llm_errors() {
        let err = build_continue_url("gemini", "hi").unwrap_err();
        assert!(err.contains("unsupported LLM"));
        assert!(err.contains("gemini"));
    }

    #[test]
    fn build_continue_url_empty_title_is_ok() {
        // An empty title should produce a valid URL with a bare `?q=`,
        // not panic or 500. The browser will land on the LLM's new-chat
        // page with an empty prompt box.
        let u = build_continue_url("chatgpt", "").expect("url");
        assert_eq!(u, "https://chatgpt.com/?q=");
    }
}