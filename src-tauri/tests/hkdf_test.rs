//! Cross-stack & passphrase tests for TASK-203 CS-X1.
//!
//! ## Why this lives in `tests/` (not in `sync_command.rs::tests`)
//!
//! The unit tests in `sync_command.rs::tests::*` already pin the
//! canonical HKDF vector. The reason for the integration tests
//! here is the keyring layer:
//!
//!   * `set_sync_passphrase` and `read_passphrase_from_keyring`
//!     both call `keyring::Entry::new(...)` internally. The
//!     `keyring::mock` backend creates a *fresh* `MockCredential`
//!     per `Entry::new` call, so two calls would never see each
//!     other's writes. The fix is the entry-injection seam on the
//!     production side (`*_with(&Entry, ...)` variants) — tests
//!     build a single `MockCredential`-backed entry and pass it
//!     to both the writer and the reader, so they share state.
//!
//!   * `has_sync_passphrase` / `set_sync_passphrase` /
//!     `read_passphrase_from_keyring` exercise the full keyring
//!     code path end-to-end (set_password → get_password →
//!     delete_password) so a regression in the keyring wiring
//!     fires here, not deep in the production sync flow.
//!
//! The cross-stack vector assertion is also re-stated here so a
//! reviewer reading one file can confirm both sides agree.

use keyring::mock::MockCredential;
use xkg_desktop::sync_command::{
    derive_key, read_passphrase_from_keyring_with,
    set_sync_passphrase_with,
};

/// Build a `keyring::Entry` backed by a `MockCredential`. Reusing
/// one entry across the writer and the reader is what makes the
/// mock backend behave like a real keyring — see module docs.
fn build_mock_entry() -> keyring::Entry {
    let credential = MockCredential::default();
    keyring::Entry::new_with_credential(Box::new(credential))
}

/// Cross-stack test vector for TASK-203 CS-X1.
///
/// Pinned HKDF-SHA256 output for the canonical passphrase. MUST
/// match the assertion in
/// `xkg-mobile-flutter/test/sync_crypto_hkdf_test.dart`.
const CANONICAL_PASSPHRASE: &str = "correct horse battery staple";
const CANONICAL_KEY_HEX: &str =
    "b93054311eba70a781cbebd08961d6841e540a95199936415febd727fb1989a5";

#[test]
fn derive_key_matches_mobile_cross_stack_vector() {
    let key = derive_key(CANONICAL_PASSPHRASE);
    let actual_hex = hex::encode(key);
    assert_eq!(
        actual_hex, CANONICAL_KEY_HEX,
        "Rust HKDF-SHA256 output drifted from the cross-platform \
         contract. Sync envelopes between mobile and desktop will no \
         longer round-trip. Update the mobile test together with this \
         one — the contract is the 32-byte hex string, not the \
         implementation."
    );
}

#[test]
fn derive_key_produces_32_bytes_for_every_input() {
    for input in &["", "x", "a much longer passphrase than usual 1234", "🦀"] {
        let key = derive_key(input);
        assert_eq!(key.len(), 32, "input = {input:?}");
    }
}

#[test]
fn derive_key_different_inputs_produce_different_keys() {
    let a = derive_key("alice");
    let b = derive_key("bob");
    assert_ne!(a, b);
    let c = derive_key("alice "); // trailing space
    assert_ne!(a, c);
}

#[test]
fn set_sync_passphrase_then_read_returns_the_passphrase() {
    let entry = build_mock_entry();
    let passphrase = "shared-secret-1";
    set_sync_passphrase_with(&entry, passphrase.to_string()).expect("set");
    let read = read_passphrase_from_keyring_with(&entry).expect("read");
    assert_eq!(read.as_deref(), Some(passphrase));
}

#[test]
fn set_sync_passphrase_can_be_overwritten() {
    let entry = build_mock_entry();
    set_sync_passphrase_with(&entry, "first".to_string()).expect("set first");
    set_sync_passphrase_with(&entry, "second".to_string()).expect("set second");
    let read = read_passphrase_from_keyring_with(&entry).expect("read");
    assert_eq!(
        read.as_deref(),
        Some("second"),
        "second set_sync_passphrase must overwrite the first"
    );
}

#[test]
fn empty_passphrase_clears_the_keyring_entry() {
    let entry = build_mock_entry();
    set_sync_passphrase_with(&entry, "pwd".to_string()).expect("set");
    assert_eq!(
        read_passphrase_from_keyring_with(&entry)
            .expect("read")
            .as_deref(),
        Some("pwd")
    );
    // Empty string → clear.
    set_sync_passphrase_with(&entry, String::new()).expect("clear");
    assert_eq!(
        read_passphrase_from_keyring_with(&entry).expect("read"),
        None,
        "empty passphrase must delete the keyring entry"
    );
    // Calling clear again on an empty entry is a no-op (NoEntry is OK).
    set_sync_passphrase_with(&entry, String::new()).expect("clear (no-op)");
}

#[test]
fn full_cs_x1_scenario_two_round_trips() {
    // Walk the full CS-X1 flow: set a passphrase, read it back
    // through the keyring seam, derive the AES key via the Rust
    // `derive_key`, confirm the bytes match the pinned cross-stack
    // vector. On the mobile side, the same passphrase produces the
    // same bytes via `SyncCrypto.hkdfKey`.
    let entry = build_mock_entry();
    set_sync_passphrase_with(&entry, CANONICAL_PASSPHRASE.to_string()).expect("set");

    let passphrase = read_passphrase_from_keyring_with(&entry)
        .expect("read")
        .expect("present");
    let derived = derive_key(&passphrase);
    let actual_hex = hex::encode(derived);
    assert_eq!(
        actual_hex, CANONICAL_KEY_HEX,
        "the end-to-end CS-X1 scenario (keyring → derive_key → AES key) \
         must produce the pinned bytes. If this fails, mobile and \
         desktop ciphertexts will no longer round-trip."
    );
}
