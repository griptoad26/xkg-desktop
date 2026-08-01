//! Integration tests for the `continue_in_browser` URL builder.
//!
//! The Tauri command itself (`continue_in_browser`) needs a live
//! `tauri::AppHandle` to drive `tauri_plugin_shell::ShellExt`, which is
//! awkward to construct in a plain integration test. The URL-building
//! logic, however, is the only thing that can break silently — a
//! wrong host or an un-encoded query would still "work" from a Rust
//! perspective but land the user on a broken page in the browser.
//!
//! So we test the pure helper `xkg::build_continue_url` against the
//! URL templates specified in Phase 5a:
//!
//! - chatgpt → `https://chatgpt.com/?q=<title>`
//! - claude  → `https://claude.ai/new?q=<title>`
//! - grok    → `https://grok.com/?q=<title>`
//!
//! Every call uses `urlencoding::encode` so spaces, `&`, `?`, etc.
//! get percent-encoded before being interpolated into the URL.

use xkg_desktop::build_continue_url;

#[test]
fn chatgpt_url_template() {
    let u = build_continue_url("chatgpt", "How do I learn Rust?").expect("ok");
    assert_eq!(u, "https://chatgpt.com/?q=How%20do%20I%20learn%20Rust%3F");
}

#[test]
fn claude_url_template() {
    let u = build_continue_url("claude", "Explain monads").expect("ok");
    assert_eq!(u, "https://claude.ai/new?q=Explain%20monads");
}

#[test]
fn grok_url_template() {
    let u = build_continue_url("grok", "real-time data").expect("ok");
    assert_eq!(u, "https://grok.com/?q=real-time%20data");
}

#[test]
fn query_with_ampersand_is_url_encoded() {
    // The `&` in a raw query string would otherwise introduce a
    // second query parameter (`q=rust & sqlite` -> `q=rust&sqlite`),
    // silently changing the meaning of the URL.
    let u = build_continue_url("chatgpt", "rust & sqlite").expect("ok");
    assert_eq!(u, "https://chatgpt.com/?q=rust%20%26%20sqlite");
    // The encoded URL must still parse as a single `?q=` query, not
    // split on the `&`.
    let parsed = url::Url::parse(&u).expect("valid url");
    assert_eq!(parsed.host_str(), Some("chatgpt.com"));
    assert_eq!(parsed.path(), "/");
    let q = parsed
        .query_pairs()
        .find(|(k, _)| k == "q")
        .map(|(_, v)| v.into_owned())
        .expect("?q= present");
    assert_eq!(q, "rust & sqlite");
}

#[test]
fn query_with_unicode_is_url_encoded() {
    // Non-ASCII characters (e.g. a Chinese prompt) must be percent-
    // encoded so the URL stays ASCII-clean. We don't pin the exact
    // encoding (could be UTF-8 bytes or percent-encoded UTF-8) —
    // only that it round-trips back to the original text.
    let u = build_continue_url("claude", "你好世界").expect("ok");
    assert!(u.starts_with("https://claude.ai/new?q="));
    let parsed = url::Url::parse(&u).expect("valid url");
    let q = parsed
        .query_pairs()
        .find(|(k, _)| k == "q")
        .map(|(_, v)| v.into_owned())
        .expect("?q= present");
    assert_eq!(q, "你好世界");
}

#[test]
fn unsupported_llm_returns_error() {
    let err = build_continue_url("gemini", "test").unwrap_err();
    assert!(err.contains("unsupported LLM"));
    assert!(err.contains("gemini"));
}

#[test]
fn empty_title_produces_valid_url() {
    // The Svelte UI can invoke this command before the user has
    // typed a title (e.g. from a quick-action button on a selected
    // conversation). The browser should still land on a valid new-
    // chat page, just with an empty prompt box.
    for llm in ["chatgpt", "claude", "grok"] {
        let u = build_continue_url(llm, "").expect("ok");
        assert!(u.starts_with("https://"));
        assert!(u.ends_with("?q="), "empty q param for {llm}: {u}");
    }
}

#[test]
fn each_llm_uses_correct_host() {
    // Pin the host portion of every template so a typo in a future
    // refactor (e.g. `https://chat.openai.com/` vs `chatgpt.com/`)
    // trips the test immediately.
    assert!(build_continue_url("chatgpt", "x")
        .unwrap()
        .starts_with("https://chatgpt.com/?q="));
    assert!(build_continue_url("claude", "x")
        .unwrap()
        .starts_with("https://claude.ai/new?q="));
    assert!(build_continue_url("grok", "x")
        .unwrap()
        .starts_with("https://grok.com/?q="));
}
