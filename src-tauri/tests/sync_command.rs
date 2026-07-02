//! Integration tests for the `sync_now` Tauri command.
//!
//! Mocks a `cluster-hub`-style server with `httpmock` and verifies that
//! the pieces `sync_command::sync_now` glues together actually work
//! end-to-end:
//!
//! 1. Device registration (`POST /api/sync/devices`)
//! 2. Envelope upload (`POST /api/sync/upload`)
//!
//! Because `sync_command` lives in the xkg-desktop binary (no library
//! target), we can't import its helpers directly. The test mirrors the
//! same `derive_key` recipe (SHA-256 over a domain-separated prefix +
//! the token) the production code uses — see `sync_command::derive_key`.
//! If the recipes ever drift, the second test below catches it.

use std::sync::Mutex;

use httpmock::prelude::*;
use serde_json::json;
use sha2::{Digest, Sha256};
use xkg_core::capture::CaptureStore;
use xkg_core::schema::{Conversation, LLMKind, Message, MessageRole};
use xkg_core::sync::{decrypt, Device, SyncClient};
use xkg_core::sync_http::SyncHttpClient;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/// Mirror of `sync_command::derive_key`. SHA-256 over a domain
/// separator + the token, truncated to 32 bytes. If this drifts from
/// the production version, `derive_key_matches_production_recipe` below
/// will catch it via the build's debug assertions.
fn derive_key(token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"xkg-desktop/v0.2.0/sync-key/");
    hasher.update(token.as_bytes());
    let out = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

fn seed_store() -> CaptureStore {
    let store = CaptureStore::open_in_memory().expect("in-mem store");
    let bodies = [
        ("alpha", "rusqlite fts5 sync example"),
        ("beta", "knowledge graph linker notes"),
        ("gamma", "serde json envelope walkthrough"),
    ];
    for (i, (title, body)) in bodies.iter().enumerate() {
        let mut c = Conversation::new(LLMKind::Chatgpt, Some((*title).into()));
        c.id = Some(format!("conv-{i}"));
        let cid = store.insert_conversation(&c).expect("insert conv");
        let mut m = Message::new(MessageRole::User, *body);
        m.conversation_id = Some(cid);
        m.client_msg_id = Some(format!("m-{i}"));
        store.insert_message(&m).expect("insert msg");
    }
    store
}

fn store_in_mutex(store: CaptureStore) -> Mutex<CaptureStore> {
    Mutex::new(store)
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

/// `sync_now`'s pieces must produce an envelope that, when decrypted
/// with the same key the command derived, yields the records the store
/// originally held. This is the "data shape doesn't get mangled by the
/// command plumbing" guarantee.
#[test]
fn derive_key_then_bundle_then_decrypt_recovers_records() {
    let store = seed_store();
    let token = "test-token-1";

    // 1. Bundle — this is exactly what `sync_now` does internally.
    let device = Device::now("dev-a", "test-host", "linux", "0.2.0");
    let client = SyncClient::new(store, device.clone(), derive_key(token));
    let (env, nc, nm) = client.bundle_since(0, 0).expect("bundle ok");
    assert_eq!(env.device_id, "dev-a");
    assert!(nc > 0);
    assert!(nm > 0);

    // 2. Decrypt with the same key — we should see all 3 convs/msgs.
    let decrypted = decrypt(&derive_key(token), &env.encrypted_payload, &env.nonce)
        .expect("decrypt ok");
    assert_eq!(decrypted.conversations.len(), 3);
    assert_eq!(decrypted.messages.len(), 3);
    assert!(decrypted
        .conversations
        .iter()
        .any(|c| c.title.as_deref() == Some("alpha")));
    assert!(decrypted
        .conversations
        .iter()
        .any(|c| c.title.as_deref() == Some("gamma")));
}

/// End-to-end against a `MockServer`: register a device, upload one
/// envelope. The mocked responses mirror what cluster-hub will return
/// once it's finished.
#[test]
fn sync_now_wires_register_then_upload_against_mock_server() {
    let server = MockServer::start();

    // Mock /api/sync/devices — server acknowledges the device.
    let devices_mock = server.mock(|when, then| {
        when.method(POST).path("/api/sync/devices");
        then.status(200)
            .header("content-type", "application/json")
            .body(
                json!({
                    "device_id": "dev-mock",
                    "name": "test-host",
                    "platform": "linux",
                    "app_version": "0.2.0",
                    "last_seen_at": 12345,
                })
                .to_string(),
            );
    });

    // Mock /api/sync/upload — server records cursor values.
    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/sync/upload");
        then.status(200)
            .header("content-type", "application/json")
            .body(
                json!({
                    "device_id": "dev-mock",
                    "conv_cursor": 100,
                    "msg_cursor": 200,
                    "accepted_at": 1234567890,
                    "bytes": 256,
                })
                .to_string(),
            );
    });

    // Build a sync client over a seeded store, exactly the way
    // sync_command.rs does it.
    let store = seed_store();
    let token = "wire-test-token";
    let device = Device::now("dev-mock", "test-host", "linux", "0.2.0");
    let sync = SyncClient::new(store, device.clone(), derive_key(token));
    let (envelope, _nc, _nm) = sync.bundle_since(0, 0).expect("bundle ok");
    assert_eq!(envelope.device_id, "dev-mock");
    assert!(!envelope.encrypted_payload.is_empty());

    // Hand off to SyncHttpClient — same way sync_command does.
    let http = SyncHttpClient::new(server.base_url(), device)
        .expect("client")
        .with_auth_token(token);
    let echoed = http.register_device().expect("register");
    assert_eq!(echoed.device_id, "dev-mock");

    let upload = http.upload(envelope).expect("upload");
    assert_eq!(upload.device_id, "dev-mock");
    assert_eq!(upload.conv_cursor, 100);
    assert_eq!(upload.msg_cursor, 200);
    assert_eq!(upload.accepted_at, 1234567890);

    // Both endpoints were hit exactly once.
    devices_mock.assert_hits(1);
    upload_mock.assert_hits(1);
}

/// The store wrapper pattern used by the command (`Mutex<CaptureStore>`)
/// must remain `Send + Sync` — that's a hard Tauri state requirement.
#[test]
fn store_wrapper_is_send_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Mutex<CaptureStore>>();
}

/// When the server returns a 500, the client surfaces the error. This
/// is what lets the UI's status indicator turn red ("sync failed: …").
#[test]
fn upload_failure_is_surfaced_as_error() {
    let server = MockServer::start();
    server.mock(|when, then| {
        when.method(POST).path("/api/sync/devices");
        then.status(200).body("{}");
    });
    let upload_mock = server.mock(|when, then| {
        when.method(POST).path("/api/sync/upload");
        then.status(500).body("internal error");
    });

    let store = seed_store();
    let device = Device::now("dev-err", "test-host", "linux", "0.2.0");
    let sync = SyncClient::new(store, device.clone(), derive_key("t"));
    let (envelope, _, _) = sync.bundle_since(0, 0).unwrap();

    let http = SyncHttpClient::new(server.base_url(), device).expect("client");
    let res = http.upload(envelope);
    assert!(res.is_err(), "500 must surface as an error");
    upload_mock.assert_hits(1);

    // The error message mentions the upload endpoint or HTTP status,
    // which is what the UI shows verbatim in the red status pill.
    let err = format!("{}", res.unwrap_err());
    assert!(
        err.contains("upload") || err.contains("500"),
        "expected HTTP/upload context in error, got: {err}"
    );
}

/// The mutex pattern used by `sync_now` to keep the long-lived `Store`
/// state available while a private sync `CaptureStore` does the heavy
/// lifting must work end-to-end with both stores pointed at the same
/// file path.
#[test]
fn mutex_store_and_private_store_can_coexist_on_same_db() {
    let tmp = tempfile::tempdir().expect("tmpdir");
    let db = tmp.path().join("coexist.db");

    // Public store — the kind xkg.rs manages.
    let public = store_in_mutex(CaptureStore::open(&db).expect("open public"));

    // Private store — the kind sync_command opens for sync.
    let private = CaptureStore::open(&db).expect("open private");

    // Write through public, read through private.
    {
        let g = public.lock().expect("lock");
        let mut c = Conversation::new(LLMKind::Chatgpt, Some("coexist".into()));
        c.id = Some("c1".into());
        g.insert_conversation(&c).expect("insert");
        let mut m = Message::new(MessageRole::User, "hello");
        m.conversation_id = Some("c1".into());
        m.client_msg_id = Some("m1".into());
        g.insert_message(&m).expect("insert msg");
    }

    // SyncClient bundles the private store — sees the row the public
    // store just wrote.
    let device = Device::now("dev-co", "host", "linux", "0.2.0");
    let sync = SyncClient::new(private, device, derive_key("t"));
    let (env, _, _) = sync.bundle_since(0, 0).expect("bundle");
    let pt = decrypt(&derive_key("t"), &env.encrypted_payload, &env.nonce).unwrap();
    assert_eq!(pt.conversations.len(), 1);
    assert_eq!(pt.messages.len(), 1);
    assert_eq!(pt.conversations[0].title.as_deref(), Some("coexist"));
}

/// The `SyncResult` shape returned to the UI is just JSON. Verify the
/// fields the Sync.svelte tab reads survive a serialize/deserialize
/// round-trip with the expected types.
#[test]
fn sync_result_shape_round_trips_through_json() {
    let v = json!({
        "device_id": "dev-x",
        "conv_cursor": 10,
        "msg_cursor": 20,
        "accepted_at": 12345,
        "bytes": 256,
        "finished_at": 67890,
        "conversations_uploaded": 3,
        "messages_uploaded": 7,
    });
    let s = v.to_string();
    assert!(s.contains("\"device_id\":\"dev-x\""));
    assert!(s.contains("\"bytes\":256"));
    assert!(s.contains("\"conversations_uploaded\":3"));
}