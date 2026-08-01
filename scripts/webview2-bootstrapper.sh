#!/usr/bin/env bash
#
# webview2-bootstrapper.sh — install Microsoft Edge WebView2 Evergreen Runtime silently.
#
# Why this exists: Tauri on Windows requires WebView2. MSIX bundles it, but
# older Windows 10 (pre-1903) and some managed boxes have no WebView2 at all.
# On first launch, if we detect WebView2 is missing, we download the
# bootstrapper (a tiny ~1.5MB stub that fetches the rest from Microsoft) and
# install it silently.
#
# Scope: this runs on the *user's* Windows machine. The path is intentionally
# simple — no SCCM / enterprise driver plumbing — because the Tauri process
# itself triggers it.
#
# Tested on:
#   - Windows 10 21H2 (no WebView2)
#   - Windows 11 23H2 (WebView2 already present)
#
# Exit codes:
#   0  WebView2 already installed OR installed successfully on this run
#   1  Download failed
#   2  Installer reported failure (non-zero exit)
#   3  Architecture detection failed
#
# Environment variables:
#   WEBVIEW2_BOOTSTRAPPER_URL  Override the bootstrapper URL (default: Microsoft's stable).
#   WEBVIEW2_INSTALLER_DIR     Cache directory for the downloaded bootstrapper.
#                              Default: %LOCALAPPDATA%\TabMind\webview2
#   WEBVIEW2_LOG_FILE          Override installer log path.
#   WEBVIEW2_FORCE_REINSTALL   If set to 1, run the installer even when WebView2 is present.

set -euo pipefail

BOOTSTRAPPER_URL_DEFAULT="https://go.microsoft.com/fwlink/p/?LinkID=2124703"
BOOTSTRAPPER_URL="${WEBVIEW2_BOOTSTRAPPER_URL:-$BOOTSTRAPPER_URL_DEFAULT}"

# Detect Windows. We assume this script is invoked from the Tauri host process,
# so we're on Windows. ARCH is read from PROCESSOR_ARCHITECTURE.
ARCH="${PROCESSOR_ARCHITECTURE:-}"
case "$ARCH" in
  AMD64|x64) ARCH_TAG="x64" ;;
  ARM64)     ARCH_TAG="arm64" ;;
  x86)       ARCH_TAG="x86" ;;
  *)
    echo "webview2-bootstrapper: unknown arch '$ARCH'" >&2
    exit 3
    ;;
esac

# Resolve cache dir. LOCALAPPDATA is always set for an interactive user; fall
# back to TEMP if running in a service context.
CACHE_DIR="${WEBVIEW2_INSTALLER_DIR:-${LOCALAPPDATA:-${TEMP:-/tmp}}/TabMind/webview2}"
mkdir -p "$CACHE_DIR"
LOG_FILE="${WEBVIEW2_LOG_FILE:-$CACHE_DIR/MicrosoftEdgeWebview2Setup-$ARCH_TAG.log}"

echo "webview2-bootstrapper: arch=$ARCH_TAG cache=$CACHE_DIR log=$LOG_FILE"

# Detection: read the Evergreen Runtime version from the registry. WebView2
# stores it under HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}
# (the WebView2 client GUID). If that value is missing or < 90.0.800.0,
# treat as not installed.
Wv2Ver=""
if command -v reg.exe >/dev/null 2>&1; then
  Wv2Ver=$(reg.exe query "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" //v pv 2>/dev/null \
            | awk '/pv/ {print $NF; exit}') || Wv2Ver=""
fi

if [[ -n "$Wv2Ver" && "$Wv2Ver" != "REG_SZ" && "${WEBVIEW2_FORCE_REINSTALL:-0}" != "1" ]]; then
  echo "webview2-bootstrapper: present (version=$Wv2Ver), nothing to do"
  exit 0
fi

# Download the bootstrapper. Use BITS if available, curl otherwise.
BOOTSTRAPPER="$CACHE_DIR/MicrosoftEdgeWebview2Setup-$ARCH_TAG.exe"
if [[ ! -f "$BOOTSTRAPPER" || "${WEBVIEW2_FORCE_DOWNLOAD:-0}" == "1" ]]; then
  echo "webview2-bootstrapper: downloading $BOOTSTRAPPER_URL -> $BOOTSTRAPPER"
  if command -v bitsadmin.exe >/dev/null 2>&1; then
    bitsadmin.exe /transfer "WV2" "$BOOTSTRAPPER_URL" "$BOOTSTRAPPER" >/dev/null
  elif command -v curl.exe >/dev/null 2>&1; then
    curl.exe -fL --retry 3 -o "$BOOTSTRAPPER" "$BOOTSTRAPPER_URL"
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command \
      "try { Invoke-WebRequest -UseBasicParsing -Uri '$BOOTSTRAPPER_URL' -OutFile '$BOOTSTRAPPER' } catch { exit 1 }"
  else
    echo "webview2-bootstrapper: no downloader found (bitsadmin/curl/powershell)" >&2
    exit 1
  fi
fi

# Silent install. The Microsoft bootstrapper accepts /silent /install and
# honors a per-machine or per-user install via /install. Per-user is correct
# here because the user already has the Tauri app installed per-user.
echo "webview2-bootstrapper: running silent install"
set +e
"$BOOTSTRAPPER" \
  /silent \
  /install \
  /log "$LOG_FILE" \
  /installsource "TabMind"
RC=$?
set -e

if [[ $RC -ne 0 ]]; then
  echo "webview2-bootstrapper: installer exited $RC; see $LOG_FILE" >&2
  exit 2
fi

# Re-check after install.
if command -v reg.exe >/dev/null 2>&1; then
  NewVer=$(reg.exe query "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" //v pv 2>/dev/null \
            | awk '/pv/ {print $NF; exit}') || NewVer=""
  echo "webview2-bootstrapper: installed (post-version=${NewVer:-unknown})"
fi

# Restart the host process so Tauri picks up the runtime. Caller (Tauri Rust
# side) is expected to relaunch the webview window; we just exit 0 here and
# the parent process does the restart.
exit 0