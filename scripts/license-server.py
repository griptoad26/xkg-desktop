#!/usr/bin/env python3
"""
license-server.py — Stub license-check endpoint that mirrors the contract
the TabMind desktop client uses for Pro-feature gating.

This file is a STUB. It returns a deterministic canned response so the
desktop client can be developed and tested against a stable shape. It is
NOT the production license server.

Contract (matches draft /api/license/check):
  POST /api/license/check
    Request:  {"license_key": "<uuid>", "device_id": "<uuid>", "app_version": "0.1.0"}
    Response 200:
      {
        "valid": true,
        "tier":  "pro",
        "issued_at": "2026-07-01T00:00:00Z",
        "expires_at": "2027-07-01T00:00:00Z",
        "features": ["cloud_sync", "unlimited_workspaces", "export_pdf"],
        "grace_window_days": 30,
        "server_time": "2026-07-31T20:00:00Z"
      }
    Response 4xx: {"valid": false, "reason": "invalid_key|expired|revoked"}

Grace-window rules (client-side, not enforced here):
  - On successful 200, the client persists (license_key, response) into
    local storage and starts a 30-day grace timer.
  - On startup, the client calls /api/license/check.
    * 200 -> refresh grace window.
    * 5xx or network error -> serve cached license until grace window expires.
    * 4xx with reason "expired" or "revoked" -> do NOT serve cached; show
      a paywall immediately.

Run locally:
  python3 license-server.py --port 8765
  curl -s -X POST http://localhost:8765/api/license/check \
    -H 'Content-Type: application/json' \
    -d '{"license_key":"dev-key","device_id":"dev-device","app_version":"0.1.0"}'
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict

LOG = logging.getLogger("license-server")

# ---- Canned responses ------------------------------------------------------

CANON_VALID: Dict[str, Any] = {
    "valid": True,
    "tier": "pro",
    "issued_at": "2026-07-01T00:00:00Z",
    "expires_at": "2027-07-01T00:00:00Z",
    "features": ["cloud_sync", "unlimited_workspaces", "export_pdf"],
    "grace_window_days": 30,
}

# License keys that simulate failure modes for client integration tests.
# Anything else returns CANON_VALID.
RESPONSES_BY_KEY: Dict[str, Dict[str, Any]] = {
    "expired-key": {
        "status": 200,
        "body": {
            "valid": False,
            "reason": "expired",
            "expires_at": "2026-01-01T00:00:00Z",
        },
    },
    "revoked-key": {
        "status": 200,
        "body": {
            "valid": False,
            "reason": "revoked",
            "revoked_at": "2026-07-15T00:00:00Z",
        },
    },
    "invalid-key": {
        "status": 400,
        "body": {"valid": False, "reason": "invalid_key"},
    },
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_response(license_key: str) -> tuple[int, Dict[str, Any]]:
    canned = RESPONSES_BY_KEY.get(license_key)
    if canned:
        body = dict(canned["body"])
        body.setdefault("server_time", now_iso())
        return canned["status"], body

    body = dict(CANON_VALID)
    body["server_time"] = now_iso()
    return 200, body


# ---- HTTP handler ----------------------------------------------------------

class LicenseHandler(BaseHTTPRequestHandler):
    server_version = "TabMindLicenseStub/0.1"

    # Quiet the default per-request stderr logging; keep it on --verbose.
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401
        if LOG.isEnabledFor(logging.DEBUG):
            LOG.debug("%s - %s", self.address_string(), fmt % args)

    def _json(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._json(200, {"ok": True, "stub": True, "time": now_iso()})
            return
        self._json(404, {"error": "not_found", "path": self.path})

    def do_POST(self) -> None:
        if self.path != "/api/license/check":
            self._json(404, {"error": "not_found", "path": self.path})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > 4096:
            self._json(400, {"error": "bad_request", "reason": "invalid_body"})
            return

        try:
            raw = self.rfile.read(length).decode("utf-8")
            req = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "bad_request", "reason": "invalid_json"})
            return

        license_key = req.get("license_key")
        if not isinstance(license_key, str) or not license_key:
            self._json(400, {"error": "bad_request", "reason": "missing_license_key"})
            return

        LOG.info("license_check key=%s device=%s version=%s",
                 license_key, req.get("device_id"), req.get("app_version"))

        status, body = build_response(license_key)
        self._json(status, body)


# ---- Entrypoint ------------------------------------------------------------

def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="TabMind license-check stub server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    server = ThreadingHTTPServer((args.bind, args.port), LicenseHandler)
    LOG.info("serving on http://%s:%d", args.bind, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOG.info("shutting down")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))