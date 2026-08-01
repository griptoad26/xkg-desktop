#!/usr/bin/env bash
#
# gen-upgradecode.sh — emit a stable MSI UpgradeCode (GUID) for a given product line.
#
# Usage:
#   ./gen-upgradecode.sh                       # one-shot, prints a new GUID
#   ./gen-upgradecode.sh --write PATH/JSON     # write/refresh upgradeCode in a Tauri wix config
#   PRODUCT_NAME=tabmind ./gen-upgradecode.sh --print-existing PATH/JSON
#
# Rules:
#   - A product line = one product identifier (com.seele.tabmind). One upgradeCode per line.
#   - Persisted under /var/lib/xkg-release/<id>.upgradecode so subsequent runs are deterministic.
#   - Never overwrite an existing upgradeCode unless --rotate is passed (which requires --reason).
#
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  gen-upgradecode.sh [--print]
  gen-upgradecode.sh --write <path-to-tauri-config.json>
  gen-upgradecode.sh --print-existing <path-to-tauri-config.json>
  gen-upgradecode.sh --rotate --reason "<reason>" --write <path-to-tauri-config.json>

Notes:
  upgradeCode is a stable MSI GUID. Changing it between releases is a SUPPORT-BREAKING
  change: existing installs will NOT be upgraded in place; they will install side-by-side.
  Do not rotate unless you are intentionally forking a new product line.
USAGE
}

STATE_DIR="${XKG_STATE_DIR:-/var/lib/xkg-release}"
PRODUCT_NAME="${PRODUCT_NAME:-tabmind}"
STATE_FILE="$STATE_DIR/${PRODUCT_NAME}.upgradecode"

# Crude portable GUID generator: prefer uuidgen, fall back to /proc/sys/kernel/random/uuid.
new_guid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  else
    cat /proc/sys/kernel/random/uuid
  fi
}

read_existing_upgrade_code() {
  python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
    print(cfg.get("bundle", {}).get("windows", {}).get("wix", {}).get("upgradeCode", ""))
except Exception as exc:
    sys.exit(f"failed to parse {sys.argv[1]}: {exc}")
PY
}

write_upgrade_code() {
  python3 - "$1" "$2" <<'PY'
import json, os, sys
path, code = sys.argv[1], sys.argv[2]
with open(path) as f:
    cfg = json.load(f)
cfg.setdefault("bundle", {}).setdefault("windows", {}).setdefault("wix", {})["upgradeCode"] = code
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
}

case "${1:-}" in
  --print|"")
    mkdir -p "$STATE_DIR"
    if [[ -f "$STATE_FILE" ]]; then
      cat "$STATE_FILE"
    else
      GUID=$(new_guid)
      echo "$GUID" > "$STATE_FILE"
      echo "$GUID"
      echo "(persisted to $STATE_FILE)" >&2
    fi
    ;;
  --write)
    [[ -n "${2:-}" ]] || { echo "missing path" >&2; usage; exit 2; }
    mkdir -p "$STATE_DIR"
    if [[ -f "$STATE_FILE" ]]; then
      GUID=$(cat "$STATE_FILE")
      echo "reusing persisted upgradeCode: $GUID"
    else
      GUID=$(new_guid)
      echo "$GUID" > "$STATE_FILE"
      echo "generated new upgradeCode: $GUID (persisted to $STATE_FILE)"
    fi
    write_upgrade_code "$2" "$GUID"
    ;;
  --print-existing)
    [[ -n "${2:-}" ]] || { echo "missing path" >&2; usage; exit 2; }
    read_existing_upgrade_code "$2"
    ;;
  --rotate)
    REASON=""
    WRITE=""
    shift
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --reason) REASON="$2"; shift 2 ;;
        --write) WRITE="$2"; shift 2 ;;
        *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
      esac
    done
    [[ -n "$REASON" ]] || { echo "--rotate requires --reason" >&2; usage; exit 2; }
    [[ -n "$WRITE" ]]  || { echo "--rotate requires --write" >&2; usage; exit 2; }
    mkdir -p "$STATE_DIR"
    OLD=$(cat "$STATE_FILE" 2>/dev/null || echo "<none>")
    GUID=$(new_guid)
    echo "$GUID" > "$STATE_FILE"
    write_upgrade_code "$WRITE" "$GUID"
    echo "ROTATED upgradeCode"
    echo "  old: $OLD"
    echo "  new: $GUID"
    echo "  reason: $REASON"
    echo "  WARNING: existing installs will not upgrade in place; this is a SUPPORT-BREAKING change."
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac