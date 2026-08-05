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
use hkdf::Hkdf;
use sha2::Sha256;
use xkg_core::capture::CaptureStore;
use xkg_core::sync::{Device, SyncClient, SyncError};
use xkg_core::sync_http::{SyncHttpClient, UploadResult};

use crate::xkg::StorePath;

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

// HKDF parameters shared with the mobile side (TASK-203 CS-X1).
// Both clients MUST use exactly these constants or envelopes produced
// on one platform won't decrypt on the other.
const HKDF_SALT: &[u8] = b"xkg-v1";
const HKDF_INFO: &[u8] = b"sync-encryption-v1";

/// Derive a deterministic 32-byte AES-256 key from `token` using HKDF-SHA256.
///
/// MUST stay byte-for-byte compatible with the mobile side's
/// `SyncCrypto.hkdfKey()` so a passphrase entered on one platform
/// produces the same 32-byte key on the other.
///
///   - salt:    "xkg-v1"
///   - info:    "sync-encryption-v1"
///   - output:  32 bytes
pub fn derive_key(token: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), token.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

/// Service name used when storing the device key in the OS keyring.
/// Picked once and never changed — changing it would orphan the
/// keyring entry on every user's machine.
pub const KEYRING_SERVICE: &str = "xkg-desktop";
/// User/account name within the keyring. Distinct from any OS
/// account name; this is just the keychain account slot.
pub const KEYRING_USER: &str = "device_key";
/// Distinct keyring slot for the user-entered sync passphrase
/// (TASK-203 / CS-X1). When this slot is populated, the on-the-wire
/// AES key is derived from the passphrase via HKDF-SHA256 instead
/// of from the random per-install key — so two devices typing the
/// same passphrase produce the same 32-byte AES key.
pub const KEYRING_USER_PASSPHRASE: &str = "sync_passphrase";

/// Look up (or mint) the 32-byte device encryption key in the OS
/// keyring.
///
///   * If a key already exists under
///     `(KEYRING_SERVICE, KEYRING_USER)`, it's read out and returned
///     as hex.
///   * Otherwise, 32 fresh bytes from `getrandom` are stored and
///     returned.
///
/// This is the storage layer for the key that `local_encryption_key`
/// hands back to the UI. The actual AES key derivation still goes
/// through [`derive_key`] — i.e. when the user clicks "Sync now" with
/// this token, the on-the-wire key is
/// `SHA256("xkg-desktop/v0.2.0/sync-key/" || token)`. The keyring
/// just removes the previous "hash the DB path" fallback that
/// CS-X3 flagged: the per-install entropy now lives in the OS
/// secure store instead of in a directory path.
///
/// `entry` lets tests inject a custom keyring entry (e.g. one
/// built via `Entry::new_with_credential` so the mock backend
/// shares state across `set_password` / `get_password` calls).
/// Production code passes `None` and we fall back to the default
/// `Entry::new(KEYRING_SERVICE, KEYRING_USER)` constructor.
///
/// When a caller-supplied entry is used, the same `Entry` is
/// reused across calls (we don't clone it). That matters for the
/// `keyring::mock` test backend, which stores the password on the
/// `MockCredential` instance — cloning via `Entry::new` would
/// allocate a fresh credential with no password. The real OS
/// keyring is unaffected because the OS resolves
/// `(KEYRING_SERVICE, KEYRING_USER)` to the same stored entry
/// regardless of how many `Entry` handles exist.
pub fn device_key_from_keyring(
    entry: Option<&keyring::Entry>,
) -> Result<[u8; 32], String> {
    // We need an owned `Entry` for the `set_password` fallback
    // path, but we never clone the supplied entry — we use the
    // reference's underlying handle via `as_any` round-tripping
    // through the `Entry` itself. Concretely: the caller-supplied
    // entry is held by reference for the lifetime of this call,
    // and we use that same entry for both `get_password` and
    // `set_password`.
    match entry {
        Some(e) => read_or_mint_key(e),
        None => {
            let default_entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
                .map_err(|e| format!("keyring entry: {e}"))?;
            read_or_mint_key(&default_entry)
        }
    }
}

fn read_or_mint_key(entry: &keyring::Entry) -> Result<[u8; 32], String> {
    match entry.get_password() {
        Ok(hex_str) => {
            let bytes = hex::decode(hex_str.trim())
                .map_err(|e| format!("keyring value not hex: {e}"))?;
            if bytes.len() != 32 {
                return Err(format!(
                    "keyring value wrong length ({} bytes, expected 32)",
                    bytes.len()
                ));
            }
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            Ok(out)
        }
        Err(keyring::Error::NoEntry) => {
            // First run on this machine: mint a random 32-byte key
            // and persist it.
            let mut key = [0u8; 32];
            getrandom_bytes(&mut key)
                .map_err(|e| format!("mint device key: {e}"))?;
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| format!("store device key: {e}"))?;
            Ok(key)
        }
        Err(e) => Err(format!("read keyring: {e}")),
    }
}

/// Fill `buf` with `buf.len()` cryptographically random bytes via
/// the `getrandom` crate. Cross-platform: uses BCryptGenRandom on
/// Windows, getrandom(2) on Linux, SecRandomCopyBytes on macOS.
fn getrandom_bytes(buf: &mut [u8]) -> Result<(), String> {
    getrandom::getrandom(buf).map_err(|e| format!("getrandom: {e}"))
}

/// Compute a placeholder local "auth token" backed by the OS keyring.
/// Used when the user hasn't entered an explicit token.
///
/// **TASK-203 / CS-X1**: when the user has set a sync passphrase
/// via [`set_sync_passphrase`], the passphrase is returned as the
/// token. When two devices share the same passphrase they then
/// derive the same 32-byte AES key via HKDF-SHA256 (see
/// [`derive_key`]) and their ciphertexts round-trip. Without a
/// passphrase we fall back to the per-install random key (CS-X3).
///
/// The returned token is opaque from the UI's perspective — it's
/// only fed back into [`sync_now`] where [`derive_key`] turns it
/// into the actual AES key. Storing entropy in the OS keyring
/// (instead of deriving it from the DB path) is what CS-X3 asked
/// for: the on-disk DB path is no longer part of the encryption
/// key material.
#[tauri::command]
pub fn local_encryption_key(
    _store_path: tauri::State<'_, StorePath>,
) -> Result<String, String> {
    // Passphrase takes precedence — that's what enables cross-device
    // sync. The keyring entry is created by set_sync_passphrase and
    // has lifetime == user's intent to keep syncing.
    if let Some(passphrase) = read_passphrase_from_keyring()? {
        return Ok(passphrase);
    }
    // Fall back to the per-install random key. The UI cannot tell
    // these apart (both are opaque hex-looking strings), which is
    // intentional — callers always feed the token back into
    // derive_key, which is the single source of truth for the
    // AES key derivation.
    let key = device_key_from_keyring(None)?;
    Ok(format!("keyring-{}", hex::encode(key)))
}

/// Read the user-set sync passphrase from the keyring, if present.
///
/// Returns `Ok(None)` when no passphrase has been configured yet —
/// treat that as "fall back to the random per-install key" rather
/// than as an error.
///
/// Accepts an optional pre-built [`keyring::Entry`]. When `None`,
/// a fresh entry is constructed via [`keyring::Entry::new`] (the
/// production path). Tests pass an entry built via
/// [`keyring::Entry::new_with_credential`] wrapping a
/// [`keyring::mock::MockCredential`] so they share state across
/// reads and writes — see `tests/hkdf_test.rs` for the rationale.
pub fn read_passphrase_from_keyring_with(
    entry: &keyring::Entry,
) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(passphrase) => Ok(Some(passphrase)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("read passphrase: {e}")),
    }
}

pub fn read_passphrase_from_keyring() -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_PASSPHRASE)
        .map_err(|e| format!("keyring entry (passphrase): {e}"))?;
    read_passphrase_from_keyring_with(&entry)
}

/// Store (or overwrite) the user-set sync passphrase in the
/// keyring. From this point on, [`local_encryption_key`] will
/// return the passphrase as the token, and a subsequent
/// [`derive_key`] call will produce the same 32-byte AES key on
/// every device that has the same passphrase configured.
///
/// Pass the empty string to clear the passphrase (the keyring
/// entry is deleted and `local_encryption_key` falls back to the
/// per-install random key).
///
/// Splits into a helper that takes a `&keyring::Entry` so tests
/// can inject a `MockCredential` (see
/// [`read_passphrase_from_keyring_with`] for the same pattern).
pub fn set_sync_passphrase_with(
    entry: &keyring::Entry,
    passphrase: String,
) -> Result<(), String> {
    if passphrase.is_empty() {
        match entry.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("clear passphrase: {e}")),
        }
    } else {
        entry
            .set_password(&passphrase)
            .map_err(|e| format!("store passphrase: {e}"))
    }
}

#[tauri::command]
pub fn set_sync_passphrase(passphrase: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER_PASSPHRASE)
        .map_err(|e| format!("keyring entry (passphrase): {e}"))?;
    set_sync_passphrase_with(&entry, passphrase)
}

/// Tauri command: returns whether a sync passphrase is currently
/// configured. Used by the Sync tab to decide whether to show
/// "Set passphrase" or "Change passphrase" in the UI.
#[tauri::command]
pub fn has_sync_passphrase() -> Result<bool, String> {
    Ok(read_passphrase_from_keyring()?.is_some())
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

    /// Cross-stack test vector for TASK-203 CS-X1.
    ///
    /// Pin the canonical HKDF-SHA256 output for a known passphrase
    /// so the desktop (Rust) and mobile (Dart) sides produce the
    /// exact same 32-byte AES key. The expected bytes here MUST
    /// match the assertion in:
    ///
    ///   * `xkg-mobile-flutter/test/sync_crypto_hkdf_test.dart`
    ///     (the canonical-vector test, asserting the same 32 bytes
    ///     for the same passphrase)
    ///   * `xkg-mobile-flutter/test/sync_service_passphrase_test.dart`
    ///     (the SyncService-level test that asserts the same hex
    ///     string after `setPassphrase`)
    ///
    /// If this test fails after a refactor, the mobile tests will
    /// fail too — and vice versa. The contract is the 32-byte hex
    /// string, not the implementation.
    ///
    /// Reference: HKDF-SHA256(
    ///     salt = "xkg-v1",
    ///     info = "sync-encryption-v1",
    ///     IKM  = "correct horse battery staple",
    ///     L    = 32
    /// )
    ///   = b93054311eba70a781cbebd08961d6841e540a95199936415febd727fb1989a5
    ///
    /// Verified independently with the `cryptography` Python library
    /// (PyCA) which uses the same RFC 5869 reference implementation
    /// as the Dart `cryptography` package and the Rust `hkdf` crate.
    #[test]
    fn derive_key_matches_mobile_cross_stack_vector() {
        const PASSPHRASE: &str = "correct horse battery staple";
        const EXPECTED_HEX: &str =
            "b93054311eba70a781cbebd08961d6841e540a95199936415febd727fb1989a5";

        let key = derive_key(PASSPHRASE);
        let actual_hex = hex::encode(key);
        assert_eq!(
            actual_hex, EXPECTED_HEX,
            "Rust HKDF-SHA256 output drifted from the cross-platform \
             contract. The mobile side's SyncCrypto.hkdfKey() still \
             produces {EXPECTED_HEX:?} for this passphrase — if this \
             test fails, sync envelopes between mobile and desktop \
             will no longer round-trip. DO NOT change the EXPECTED_HEX \
             constant here without coordinating the same change in \
             xkg-mobile-flutter/test/sync_crypto_hkdf_test.dart."
        );
    }

    /// Edge case: empty passphrase is gated by `set_sync_passphrase`
    /// (which clears the keyring entry), but `derive_key("")` itself
    /// must still produce a deterministic 32-byte output. Locking
    /// this in keeps the KDF behaviour stable across releases.
    #[test]
    fn derive_key_empty_passphrase_is_stable_32_bytes() {
        let a = derive_key("");
        let b = derive_key("");
        assert_eq!(a, b);
        assert_eq!(a.len(), 32);
        // And it must differ from any non-empty passphrase.
        assert_ne!(a, derive_key("x"));
    }

    /// Defence-in-depth: `derive_key` must always produce exactly
    /// 32 bytes (AES-256 key length). The `expand` call would never
    /// accept a different length, but a future refactor that does
    /// (e.g. shifting to a different output length) would silently
    /// break every envelope — this test catches that.
    #[test]
    fn derive_key_output_length_is_32_bytes() {
        assert_eq!(derive_key("anything").len(), 32);
    }

    #[test]
    fn sync_result_serializes_expected_fields() {
        let upload = UploadResult {
            device_id: "dev-1".into(),
            conv_cursor: 10,
            msg_cursor: 20,
            accepted_at: 12345,
            bytes: 256,
            accepted: 0,
            messages_uploaded: 0,
            cursor: 0,
        };
        let env = SyncEnvelope {
            device_id: "dev-1".into(),
            encrypted_payload: "AAAA".into(),
            nonce: "AAAAAAAAAAAAAAAA".into(),
            cursor: 0,
            message_cursor: 0,
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
        assert_eq!(env.encrypted_payload.len(), 4);
    }

    #[test]
    fn hostname_fallback_returns_nonempty_string() {
        let h = hostname_fallback();
        assert!(!h.is_empty());
    }
}