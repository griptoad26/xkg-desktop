//! Integration smoke test for the xkg-core → Tauri-command surface.
//!
//! Exercises the same code paths the Tauri commands use (Store wrapper,
//! CaptureStore) end-to-end against a real ChatGPT DOM fixture on disk.

use std::sync::Mutex;
use xkg_core::capture::CaptureStore;
use xkg_core::extractors::chatgpt::{extract_title, ChatGPTExtractor};
use xkg_core::extractor::Extractor;
use xkg_core::{Conversation, LLMKind, Message};

const DOM: &str = include_str!("fixtures/chatgpt_sample.html");

#[test]
fn end_to_end_capture_then_search_then_list() {
    let tmp = tempfile::tempdir().expect("tmpdir");
    let db = tmp.path().join("captures.db");

    let store = Mutex::new(CaptureStore::open(&db).expect("open"));

    // 1. Extract
    let ext = ChatGPTExtractor;
    let extracted = ext.extract(DOM).expect("extract ok");
    assert!(extracted.len() >= 4, "expected at least 4 msgs, got {}", extracted.len());

    // 2. Capture (write conv + msgs through the Store wrapper)
    let title = extract_title(DOM);
    let now = chrono::Utc::now();
    let mut conv = Conversation::new(LLMKind::Chatgpt, title.clone());
    conv.id = Some(extracted[0].client_msg_id.clone());
    conv.created_at = now;
    conv.updated_at = now;

    let conv_id = {
        let g = store.lock().expect("lock");
        g.insert_conversation(&conv).expect("insert conv")
    };
    assert!(!conv_id.is_empty());

    {
        let g = store.lock().expect("lock");
        for m in &extracted {
            let mut msg = Message::new(m.role.clone(), m.body.clone());
            msg.conversation_id = Some(conv_id.clone());
            msg.client_msg_id = Some(m.client_msg_id.clone());
            msg.created_at = now;
            g.insert_message(&msg).expect("insert msg");
        }
    }

    // 3. List conversations
    let convs = {
        let g = store.lock().expect("lock");
        g.list_conversations().expect("list")
    };
    assert_eq!(convs.len(), 1);
    assert_eq!(convs[0].id.as_deref(), Some(conv_id.as_str()));
    assert_eq!(convs[0].llm, LLMKind::Chatgpt);

    // 4. Get messages for that conversation
    let msgs = {
        let g = store.lock().expect("lock");
        g.messages_for_conversation(&conv_id).expect("msgs")
    };
    assert_eq!(msgs.len(), extracted.len());
    for m in &msgs {
        assert_eq!(m.conversation_id.as_deref(), Some(conv_id.as_str()));
    }

    // 5. Search — pick a term that's in one of the bodies.
    let hits = {
        let g = store.lock().expect("lock");
        g.search("rusqlite", 10).expect("search")
    };
    assert!(!hits.is_empty(), "expected at least one search hit");
    for h in &hits {
        assert!(h.body.to_lowercase().contains("rusqlite"));
    }

    // 6. Re-capture is idempotent — re-extracts dedupe on (conv_id, client_msg_id)
    {
        let g = store.lock().expect("lock");
        for m in &extracted {
            let mut msg = Message::new(m.role.clone(), m.body.clone());
            msg.conversation_id = Some(conv_id.clone());
            msg.client_msg_id = Some(m.client_msg_id.clone());
            g.insert_message(&msg).expect("idempotent insert");
        }
        assert_eq!(g.message_count().expect("count"), extracted.len() as i64);
    }

    // 7. Empty search returns empty
    let empty = {
        let g = store.lock().expect("lock");
        g.search("", 10).expect("empty search ok")
    };
    assert!(empty.is_empty());
}
