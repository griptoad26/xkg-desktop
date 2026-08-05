//! Integration tests for the OS-keyring backed device key storage
//! added in TASK-203 (audit finding CS-X3).
//!
//! These tests never touch the host keyring (libsecret / Keychain /
//! Credential Manager). They build `keyring::Entry` instances
//! directly via `Entry::new_with_credential` wrapping a
//! `MockCredential` so the production code under test sees an
//! in-memory credential backend.
//!
//! ## Why the entry-injection seam exists
//!
//! The mock backend's `MockCredentialBuilder` creates a fresh
//! `MockCredential` per `Entry::new(...)` call, and each
//! credential owns its own password slot — so two `Entry::new`
//! calls with the same `(service, user)` *do not* see each
//! other's writes. That breaks the obvious test (seed then read)
//! for any code that opens its own entry internally.
//!
//! To work around that, the production code accepts an optional
//! `&keyring::Entry` so tests can hand it an entry built via
//! `Entry::new_with_credential(...)` wrapping a `MockCredential`.
//! The production code reuses the same `Entry` across calls and
//! reads/writes its `MockCredential`'s `MockData` directly, so
//! the seeded value is visible across "production" calls.
//!
//! Tests covered:
//!   1. First call mints a fresh 32-byte key and stores it.
//!   2. Subsequent calls return the same key (no churn).
//!   3. A corrupted entry (wrong length / non-hex) returns an error
//!      rather than silently producing bad crypto.

use keyring::credential::CredentialApi;
use keyring::mock::MockCredential;
use xkg_desktop::sync_command::device_key_from_keyring;

/// Build a `keyring::Entry` backed by a default `MockCredential`.
/// Tests can manipulate the credential's password slot directly via
/// `entry.get_credential().downcast_ref::<MockCredential>()`.
fn build_mock_entry() -> keyring::Entry {
    let credential = MockCredential::default();
    keyring::Entry::new_with_credential(Box::new(credential))
}

/// Set the password on a mock-backed entry, by going through the
/// `MockCredential` API directly. (Calling `entry.set_password`
/// would also work, but going through the downcast keeps the
/// test self-documenting about what's happening.)
fn set_mock_password(entry: &keyring::Entry, password: &str) {
    let mock_ref: &MockCredential = entry
        .get_credential()
        .downcast_ref()
        .expect("MockCredential downcast");
    mock_ref
        .set_password(password)
        .expect("set mock password");
}

#[test]
fn device_key_from_keyring_mints_and_persists_a_32_byte_key() {
    let entry = build_mock_entry();

    // First call: nothing in the keyring yet, so a fresh key is
    // minted and stored.
    let key = device_key_from_keyring(Some(&entry))
        .expect("first call mints a key");
    assert_eq!(key.len(), 32);
    // Sanity check: not all zero (extremely unlikely but let's be
    // paranoid about a bug that would zero-init the buffer).
    assert!(key.iter().any(|b| *b != 0));

    // Second call: same key is returned, no new random bytes.
    let key2 = device_key_from_keyring(Some(&entry))
        .expect("second call returns key");
    assert_eq!(key, key2, "key must be stable across calls");

    // Independent read via the mock's stored password returns the
    // same hex-encoded value.
    let mock_ref: &MockCredential = entry
        .get_credential()
        .downcast_ref()
        .expect("MockCredential downcast");
    let stored = mock_ref
        .get_password()
        .expect("read back stored password");
    let bytes = hex::decode(stored.trim()).expect("hex decode");
    assert_eq!(bytes.len(), 32);
    assert_eq!(&bytes[..], &key[..]);
}

#[test]
fn corrupted_keyring_value_returns_an_error() {
    let entry = build_mock_entry();

    // Pre-seed a deliberately bad value (non-hex). The production
    // code must surface this rather than producing bad crypto.
    set_mock_password(&entry, "not-valid-hex-zzzz");

    let result = device_key_from_keyring(Some(&entry));
    assert!(
        result.is_err(),
        "non-hex keyring value must surface as an error, got {:?}",
        result
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("hex") || msg.contains("keyring"),
        "error should explain the failure mode, got: {msg}"
    );
}

#[test]
fn wrong_length_keyring_value_returns_an_error() {
    let entry = build_mock_entry();

    // 16 bytes (128 bits) instead of 32 — a valid hex, but the
    // wrong length. The production code must reject this rather
    // than truncating or padding.
    set_mock_password(&entry, &hex::encode([0u8; 16]));

    let result = device_key_from_keyring(Some(&entry));
    assert!(
        result.is_err(),
        "short key must be rejected, got {:?}",
        result
    );
    let msg = result.unwrap_err();
    assert!(
        msg.contains("length") || msg.contains("keyring"),
        "error should explain the failure mode, got: {msg}"
    );
}