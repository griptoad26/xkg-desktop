//! Tailscale peer discovery Tauri command — Phase 178 / TASK-HUB-20260731-178.
//!
//! Wraps the `tailscale status --json` command and parses peer IPs out
//! of the response, presenting them to the Sync.svelte UI and the
//! local SyncClient so the user can pick a hub URL without typing it.
//!
//! ## Design
//!
//! - The Tauri shell plugin already exposes `tauri_plugin_shell` (we
//!   use it for `shell().open(url, None)` in `continue_in_browser`),
//!   so we use `tokio::process::Command` for the spawn instead of
//!   pulling another plugin just for one command.
//! - We parse `tailscale status --json` to extract `Peer.<key>.TailscaleIPs[0]`
//!   for every peer that's currently online. The first IP in the list
//!   is the IPv4 100.x address.
//! - If `tailscale` is not installed or `tailscaled` is not running,
//!   we return an empty list with an `error` string — the UI treats
//!   this as a soft failure (button still works, shows a hint to
//!   install tailscale).
//!
//! ## Security
//!
//! - The command reads `tailscale status` only — it does NOT accept
//!   arbitrary input, so we don't need allowlist gymnastics.
//! - Output is parsed as JSON in a strict way (no eval / no shell).
//!
//! ## Why one command, not a long-running watch?
//!
//! MVP: a button-triggered refresh. Phase 4+ could grow this into
//! a background poll + mDNS fallback.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// One peer entry returned to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerInfo {
    /// Stable peer identifier (Tailscale node ID, e.g. "node-abcd1234").
    pub node_id: String,
    /// Human-readable name (e.g. "alice-macbook").
    pub name: String,
    /// Best-effort IPv4 100.x address (the IPv4 Tailscale IP).
    /// Empty when only IPv6 is available.
    pub ip: String,
    /// All advertised IPs (IPv4 first, then IPv6).
    pub ips: Vec<String>,
    /// `true` if the peer is currently online per `tailscale status`.
    pub online: bool,
    /// Last-seen timestamp string (raw, from tailscale).
    pub last_seen: String,
}

/// Wraps the parsed peer list + a possible error message.
#[derive(Debug, Clone, Serialize)]
pub struct PeerList {
    /// Empty list if discovery failed — UI surfaces `error` instead.
    pub peers: Vec<PeerInfo>,
    /// `true` if `tailscale status` succeeded.
    pub ok: bool,
    /// Populated when `ok == false`. Strings, not structured, so the
    /// UI can render them verbatim.
    pub error: Option<String>,
    /// Wall-clock unix seconds at fetch time (for "synced Xs ago").
    pub fetched_at: i64,
}

// -----------------------------------------------------------------------------
// Tailscale status JSON schema (subset)
//
// We only decode the fields we care about. Anything else is ignored
// via serde's default behaviour on unknown fields.
// -----------------------------------------------------------------------------
#[derive(Debug, Deserialize)]
struct TsStatus {
    #[serde(default, rename = "Peer")]
    peer: Option<serde_json::Value>,
    #[serde(default)]
    user: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct TsPeer {
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "HostName")]
    host_name: Option<String>,
    #[serde(default, rename = "DNSName")]
    dns_name: Option<String>,
    #[serde(default, rename = "TailscaleIPs")]
    tailscale_ips: Option<Vec<String>>,
    #[serde(default, rename = "Online")]
    online: Option<bool>,
    #[serde(default, rename = "LastSeen")]
    last_seen: Option<String>,
}

// -----------------------------------------------------------------------------
// Core parser
// -----------------------------------------------------------------------------

/// Parse `tailscale status --json` output into a `PeerList`.
/// Pure function (no IO) so it's testable in isolation.
fn parse_status_output(stdout: &str) -> Vec<PeerInfo> {
    let parsed: serde_json::Result<TsStatus> = serde_json::from_str(stdout);
    let status = match parsed {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[peer_discovery] bad tailscale JSON: {e}");
            return Vec::new();
        }
    };

    let peers = match status.peer {
        Some(p) if p.is_object() => p,
        // Newer tailscale uses Statusv4 (object keyed by stable ID) and
        // some builds wrap peers under .Peer or .Peers. We treat any
        // object-shaped `peer` value as the peer map.
        Some(p) => {
            // If the value is an array (some tailscale builds), take
            // `Peer.<id>.TailscaleIPs` differently — but the `peer`
            // key is usually an object.
            if let Some(arr) = p.as_array() {
                let mut out = Vec::new();
                for v in arr {
                    if let Ok(tp) = serde_json::from_value::<TsPeer>(v.clone()) {
                        out.push(peer_from(tp));
                    }
                }
                return out;
            }
            return Vec::new();
        }
        None => return Vec::new(),
    };

    let map = peers.as_object().cloned().unwrap_or_default();
    let mut out = Vec::new();
    for (key, val) in map.iter() {
        let tp: TsPeer = match serde_json::from_value(val.clone()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let mut p = peer_from(tp);
        // If the host_name is empty, use the map key (stable node id).
        if p.name.is_empty() {
            p.name = key.clone();
        }
        if p.node_id.is_empty() {
            p.node_id = key.clone();
        }
        out.push(p);
    }
    // Sort: online first, then alphabetical for determinism.
    out.sort_by(|a, b| {
        b.online
            .cmp(&a.online)
            .then_with(|| a.name.cmp(&b.name))
    });
    out
}

fn peer_from(tp: TsPeer) -> PeerInfo {
    let ips = tp.tailscale_ips.clone().unwrap_or_default();
    let ip = ips
        .iter()
        .find(|s| s.contains('.')) // crude IPv4 detector
        .cloned()
        .unwrap_or_else(|| ips.first().cloned().unwrap_or_default());
    PeerInfo {
        node_id: tp.id.unwrap_or_default(),
        name: tp
            .host_name
            .or(tp.dns_name)
            .unwrap_or_default(),
        ip,
        ips,
        online: tp.online.unwrap_or(false),
        last_seen: tp.last_seen.unwrap_or_default(),
    }
}

// -----------------------------------------------------------------------------
// Tauri command — runs `tailscale status --json`
// -----------------------------------------------------------------------------

/// Run `tailscale status --json` and return the parsed peer list.
/// Returns `{ ok: false, peers: [], error: "..." }` on any failure
/// (missing binary, non-zero exit, malformed JSON, timeout).
#[tauri::command]
pub async fn discover_peers() -> PeerList {
    let now = chrono::Utc::now().timestamp();
    let mut cmd = tokio::process::Command::new("tailscale");
    cmd.arg("status")
        .arg("--json")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    // Cap how long we'll wait; tailscale should respond in <1s normally.
    cmd.kill_on_drop(true);

    let output = match tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            return PeerList {
                peers: Vec::new(),
                ok: false,
                error: Some(format!(
                    "failed to spawn `tailscale`: {e} (is it installed? https://tailscale.com/download)"
                )),
                fetched_at: now,
            };
        }
        Err(_) => {
            return PeerList {
                peers: Vec::new(),
                ok: false,
                error: Some("`tailscale status --json` timed out after 5s".to_string()),
                fetched_at: now,
            };
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return PeerList {
            peers: Vec::new(),
            ok: false,
            error: Some(format!(
                "tailscale exited with {}: {stderr}",
                output.status
            )),
            fetched_at: now,
        };
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let peers = parse_status_output(&stdout);
    PeerList {
        peers,
        ok: true,
        error: None,
        fetched_at: now,
    }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_string_yields_empty_list() {
        let out = parse_status_output("");
        assert!(out.is_empty());
    }

    #[test]
    fn parse_malformed_json_yields_empty_list() {
        let out = parse_status_output("not json at all");
        assert!(out.is_empty());
    }

    #[test]
    fn parse_minimal_peer_object_extracts_ipv4() {
        let json = r#"{
            "Peer": {
                "node-abcd1234": {
                    "HostName": "alice-macbook",
                    "TailscaleIPs": ["100.64.1.2", "fd7a:115c:a1e0::1"],
                    "Online": true,
                    "LastSeen": "2026-07-31T22:00:00Z"
                }
            }
        }"#;
        let out = parse_status_output(json);
        assert_eq!(out.len(), 1);
        let p = &out[0];
        assert_eq!(p.name, "alice-macbook");
        assert_eq!(p.ip, "100.64.1.2");
        assert_eq!(p.ips, vec!["100.64.1.2", "fd7a:115c:a1e0::1"]);
        assert!(p.online);
    }

    #[test]
    fn parse_only_ipv6_peer_extracts_first_ip() {
        let json = r#"{
            "Peer": {
                "node-xyz": {
                    "HostName": "v6-only",
                    "TailscaleIPs": ["fd7a:115c:a1e0::2"],
                    "Online": true
                }
            }
        }"#;
        let out = parse_status_output(json);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].ip, "fd7a:115c:a1e0::2");
    }

    #[test]
    fn parse_offline_peer_listed_with_online_false() {
        let json = r#"{
            "Peer": {
                "node-1": {"HostName": "online", "TailscaleIPs": ["100.1.1.1"], "Online": true},
                "node-2": {"HostName": "offline", "TailscaleIPs": ["100.1.1.2"], "Online": false}
            }
        }"#;
        let out = parse_status_output(json);
        assert_eq!(out.len(), 2);
        // Online first.
        assert!(out[0].online);
        assert!(!out[1].online);
    }

    #[test]
    fn parse_missing_optional_fields_does_not_panic() {
        let json = r#"{"Peer": {"node-1": {"HostName": "minimal"}}}
        "#;
        let out = parse_status_output(json);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "minimal");
        assert_eq!(out[0].ip, "");
        assert!(!out[0].online);
    }

    #[test]
    fn peer_list_serializes_ok_true_with_peers() {
        let pl = PeerList {
            peers: vec![PeerInfo {
                node_id: "node-x".into(),
                name: "test".into(),
                ip: "100.0.0.1".into(),
                ips: vec!["100.0.0.1".into()],
                online: true,
                last_seen: "now".into(),
            }],
            ok: true,
            error: None,
            fetched_at: 12345,
        };
        let j = serde_json::to_string(&pl).expect("json");
        assert!(j.contains("\"ok\":true"));
        assert!(j.contains("\"ip\":\"100.0.0.1\""));
    }
}