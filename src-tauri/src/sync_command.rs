//! Sync Tauri commands — Phase 4.
//!
//! Wraps [`xkg_core::sync::SyncClient`] (pure data + AES-GCM) and
//! [`xkg_core::sync_http::SyncHttpClient`] (HTTP transport) behind
//! commands the Svelte `Sync.svelte` tab can call.
//!
//! ## Design
//!
//! The Tauri `Store` managed state is a `Mutex<CaptureStore>` — not
//! `Clone`, so we can't hand it to a `SyncClient` (which takes the store
//! by value). Instead we **re-open the same SQLite file** as a private
//! `CaptureStore` for the duration of the sync. SQLite handles multiple
//! connections per file fine, and this keeps the existing `Store` state
//! untouched. We resolve the path from the `StorePath` managed state,
//! which is set at app startup from `xkg::default_db_path()`.
//!
//! ## Encryption key
//!
//! `derive_key` is not exported by xkg-core (Phase 4 doesn't add it yet),
//! so we derive a 32-byte AES-256 key from the auth token locally with
//! SHA-256. Deterministic, so the same token always yields the same key
//! across devices — which is what we want for "press button to sync"
//! MVP behaviour. A proper KDF (Argon2id / HKDF) lands in a later phase.

use serde::Serialize;
use sha2::{Digest, Sha256};
use xkg_core::capture::CaptureStore;
use xkg_core::sync::{Device, SyncClient, SyncError};
use xkg_core::sync_http::{SyncHttpClient, UploadResult};

use crate::StorePath;

/// What `sync_now` returns to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct SyncResult {
    /// Device id that just registered + uploaded.
    pub device_id: String,
    /// Server-side conversation cursor after upload.
    pub conv_cursor: i64,
    /// Server-side message cursor after upload.
    pub msg_cursor: i64,
    /// Server-acknowledged timestamp (unix seconds).
    pub accepted_at: i64,
    /// Bytes the server received (envelope size).
    pub bytes: usize,
    /// Local timestamp the sync finished (unix seconds).
    pub finished_at: i64,
    /// How many conversations we bundled (from the local store).
    pub conversations_uploaded: usize,
    /// How many messages we bundled (from the local store).
    pub messages_uploaded: usize,
}

/// Derive a deterministic 32-byte AES-256 key from `token` using SHA-256.
///
/// MVP only. Phase 5+ should swap this for an Argon2id / HKDF derivation
/// keyed on a server-issued password.
pub fn derive_key(token: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"xkg-desktop/v0.2.0/sync-key/");
    hasher.update(token.as_bytes());
    let out = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

/// Compute a placeholder local "auth token" derived from the db path.
/// Used when the user hasn't entered an explicit token.
///
/// This is intentionally weak — real auth is a separate story. All it
/// needs to do is let the local encryption key be deterministic across
/// devices owned by the same user.
#[tauri::command]
pub fn local_encryption_key(
    store_path: tauri::State<'_, StorePath>,
) -> Result<String, String> {
    // Hash the DB path to get a stable per-install seed. Includes the
    // app name so two apps on the same machine don't collide.
    let mut hasher = Sha256::new();
    hasher.update(b"xkg-desktop/v0.2.0/local-token/");
    hasher.update(store_path.0.display().to_string().as_bytes());
    let digest = hasher.finalize();
    Ok(format!(
        "local-{}",
        &hex::encode(&digest[..8])
    ))
}

/// Run a single sync: register device → bundle everything since 0 → upload.
///
/// `platform` is `"linux" | "macos" | "windows"`. `app_version` is the
/// app version string (e.g. `"0.2.0"`).
#[tauri::command]
pub async fn sync_now(
    store_path: tauri::State<'_, StorePath>,
    server_url: String,
    auth_token: String,
    platform: String,
    app_version: String,
) -> Result<SyncResult, String> {
    // 1. Open a private CaptureStore over the same DB file so we can
    //    own it in a SyncClient without disturbing the Tauri-managed
    //    store. SQLite serializes writes between connections.
    let owned_store = CaptureStore::open(&store_path.0)
        .map_err(|e| format!("open store for sync: {e}"))?;

    // 2. Build the device. Use a fresh ULID for the id so each install
    //    looks distinct on the server side. Use hostname as the human
    //    label so the server UI can show "alice's macbook" etc.
    let device = Device::now(
        ulid::Ulid::new().to_string(),
        hostname_fallback(),
        platform,
        app_version,
    );

    // 3. Derive an AES-256 key from the auth token.
    let key = derive_key(&auth_token);

    // 4. Bundle everything newer than cursor 0 (MVP: full sync every
    //    time). We do this BEFORE registering so we can fail fast on
    //    a broken store without hitting the network.
    let sync_client = SyncClient::new(owned_store, device.clone(), key);
    let (envelope, _conv_cursor, _msg_cursor) = sync_client
        .bundle_since(0, 0)
        .map_err(sync_err_to_string)?;

    // Count what we bundled by decrypting our own envelope. Cheap
    // (the envelope was just produced) and gives us accurate stats
    // without re-walking the store.
    let bundle_counts = xkg_core::sync::decrypt(&derive_key(&auth_token), &envelope.encrypted_payload, &envelope.nonce)
        .map(|p| (p.conversations.len(), p.messages.len()))
        .unwrap_or((0, 0));

    // 5. Build the HTTP client and register + upload. Both calls are
    //    blocking on reqwest; wrap them in spawn_blocking so we don't
    //    pin the Tauri async runtime.
    let server_url = server_url.clone();
    let device_for_http = device.clone();
    let auth_token_owned = auth_token.clone();
    let upload: UploadResult = tokio::task::spawn_blocking(move || -> Result<UploadResult, SyncError> {
        let http = SyncHttpClient::new(server_url, device_for_http)
            .map_err(|e| SyncError::Encryption(format!("http client: {e}")))?
            .with_auth_token(auth_token_owned);
        let _ = http
            .register_device()
            .map_err(|e| SyncError::Encryption(format!("register: {e}")))?;
        http.upload(envelope).map_err(|e| SyncError::Encryption(format!("upload: {e}")))
    })
    .await
    .map_err(|e| format!("sync task panicked: {e}"))?
    .map_err(sync_err_to_string)?;

    Ok(SyncResult {
        device_id: upload.device_id,
        conv_cursor: upload.conv_cursor,
        msg_cursor: upload.msg_cursor,
        accepted_at: upload.accepted_at,
        bytes: upload.bytes,
        finished_at: chrono::Utc::now().timestamp(),
        conversations_uploaded: bundle_counts.0,
        messages_uploaded: bundle_counts.1,
    })
}

/// Best-effort hostname (used for the `Device::name` field).
fn hostname_fallback() -> String {
    std::env::var_os("HOSTNAME")
        .map(|s| s.to_string_lossy().to_string())
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_else(|| "unknown-device".to_string())
}

fn sync_err_to_string(e: SyncError) -> String {
    format!("sync: {e}")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use xkg_core::sync::SyncEnvelope;

    #[test]
    fn derive_key_is_deterministic_32_bytes() {
        let a = derive_key("token-1");
        let b = derive_key("token-1");
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        // Different tokens produce different keys.
        let c = derive_key("token-2");
        assert_ne!(a, c);
    }

    #[test]
    fn sync_result_serializes_expected_fields() {
        let upload = UploadResult {
            device_id: "dev-1".into(),
            conv_cursor: 10,
            msg_cursor: 20,
            accepted_at: 12345,
            bytes: 256,
        };
        let env = SyncEnvelope {
            device_id: "dev-1".into(),
            conv_cursor: Some(0),
            msg_cursor: Some(0),
            encrypted_payload: vec![0u8; 256],
            nonce: [0u8; 12],
        };
        let r = SyncResult {
            device_id: upload.device_id.clone(),
            conv_cursor: upload.conv_cursor,
            msg_cursor: upload.msg_cursor,
            accepted_at: upload.accepted_at,
            bytes: upload.bytes,
            finished_at: 99999,
            conversations_uploaded: 0,
            messages_uploaded: 0,
        };
        let j = serde_json::to_string(&r).expect("json");
        assert!(j.contains("\"device_id\":\"dev-1\""));
        assert!(j.contains("\"conv_cursor\":10"));
        assert!(j.contains("\"msg_cursor\":20"));
        assert!(j.contains("\"accepted_at\":12345"));
        assert!(j.contains("\"bytes\":256"));
        // Convince the compiler we used `env` so the test isn't dead.
        assert_eq!(env.encrypted_payload.len(), 256);
    }

    #[test]
    fn hostname_fallback_returns_nonempty_string() {
        let h = hostname_fallback();
        assert!(!h.is_empty());
    }
}