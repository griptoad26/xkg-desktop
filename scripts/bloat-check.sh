#!/usr/bin/env bash
#
# bloat-check.sh — analyze a Tauri AppImage for size bloat.
#
# Why: Tauri Desktop 0.1.0 ships a 77MB AppImage. Target is <25MB. This script
# surfaces the biggest contributors inside the squashfs payload and prints a
# sorted report. It does NOT modify the AppImage; you act on the report.
#
# Usage:
#   ./bloat-check.sh PATH/TO/TabMind.AppImage
#   ./bloat-check.sh --extract-dir PATH/TO/TabMind.AppImage  # keep extraction on disk
#   ./bloat-check.sh --target-mb 25 PATH/TO/TabMind.AppImage
#
# Requirements:
#   - unsquashfs (squashfs-tools)
#   - awk, sort, du, find
#
# Output: a sorted top-N table of largest files plus a "suspect patterns" block
# flagging webview2 fallback bundles, debug symbols, and Chrome DevTools assets.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: bloat-check.sh [--target-mb N] [--extract-dir DIR] PATH/TO/AppImage

  --target-mb N    Hard cap. Exits non-zero if extracted size > N MB (default: 25).
  --extract-dir D  Keep extraction under D instead of an ephemeral mktemp dir.
  --top N          Number of rows in the report (default: 40).

Exit codes:
  0  Size OK.
  1  Size over target.
  2  Usage / argument error.
  3  Required tool missing.
USAGE
}

TARGET_MB=25
TOP=40
EXTRACT_DIR=""
APPIMAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-mb) TARGET_MB="$2"; shift 2 ;;
    --extract-dir) EXTRACT_DIR="$2"; shift 2 ;;
    --top) TOP="$2"; shift 2 ;;
    -h|--help|help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; usage; exit 2 ;;
    *) APPIMAGE="$1"; shift ;;
  esac
done

if [[ -z "$APPIMAGE" ]]; then
  usage >&2; exit 2
fi
if [[ ! -f "$APPIMAGE" ]]; then
  echo "AppImage not found: $APPIMAGE" >&2; exit 2
fi

for tool in unsquashfs awk sort du find; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 3; }
done

if [[ -z "$EXTRACT_DIR" ]]; then
  EXTRACT_DIR="$(mktemp -d -t tabmind-bloat-XXXXXX)"
  CLEANUP=1
else
  mkdir -p "$EXTRACT_DIR"
  CLEANUP=0
fi
trap '[[ "${CLEANUP:-0}" == 1 ]] && rm -rf "$EXTRACT_DIR"' EXIT

echo "==> Extracting $(basename "$APPIMAGE") into $EXTRACT_DIR"
chmod +x "$APPIMAGE" || true
# AppImages are gzipped squashfs. -f is "files-from-stdin"; we just point at the file.
unsquashfs -d "$EXTRACT_DIR/squashfs-root" -no-progress "$APPIMAGE" >/dev/null

ROOT="$EXTRACT_DIR/squashfs-root"

if [[ ! -d "$ROOT" ]]; then
  echo "extraction failed: $ROOT missing" >&2; exit 3
fi

# Total payload size on disk.
TOTAL_BYTES=$(du -sb "$ROOT" | awk '{print $1}')
TOTAL_MB=$(awk -v b="$TOTAL_BYTES" 'BEGIN { printf "%.1f", b/1024/1024 }')
echo "==> Extracted payload size: ${TOTAL_MB} MB ($TOTAL_BYTES bytes)"

if awk -v got="$TOTAL_MB" -v cap="$TARGET_MB" 'BEGIN { exit (got > cap ? 0 : 1) }'; then
  STATUS=OK
else
  STATUS=OVER
fi
echo "==> Target: ${TARGET_MB} MB  ->  $STATUS"

echo
echo "==> Top ${TOP} files by size:"
( cd "$ROOT" && find . -type f -printf '%s\t%p\n' ) \
  | sort -nr \
  | head -n "$TOP" \
  | awk -F'\t' '{
      size = $1; path = $2;
      if (size >= 1048576)      printf "%8.1f MB  %s\n", size/1048576, path;
      else if (size >= 1024)    printf "%8.1f KB  %s\n", size/1024,   path;
      else                       printf "%8d B    %s\n", size,        path;
    }'

echo
echo "==> Largest directories (top 20):"
( cd "$ROOT" && du -ab --max-depth=3 . 2>/dev/null | sort -nr | head -n 20 \
  | awk '{
      size = $1; path = $2;
      if (size >= 1048576)      printf "%8.1f MB  %s\n", size/1048576, path;
      else if (size >= 1024)    printf "%8.1f KB  %s\n", size/1024,   path;
      else                       printf "%8d B    %s\n", size,        path;
    }')

echo
echo "==> Suspect patterns:"
# Bundled webview2 fallback (typically a MicrosoftWebView2Setup*.exe inside the bundle).
( cd "$ROOT" && find . -type f \( \
    -iname 'MicrosoftEdgeWebView2RuntimeInstaller*' -o \
    -iname 'MicrosoftEdgeWebview2Setup*' -o \
    -iname 'WebView2Loader.dll' \) -printf '%s\t%p\n' ) \
  | sort -nr | head -n 20 | awk -F'\t' '{
      size=$1; path=$2;
      if (size >= 1048576) printf "  %8.1f MB  %s\n", size/1048576, path;
      else if (size >= 1024) printf "  %8.1f KB  %s\n", size/1024, path;
      else printf "  %8d B    %s\n", size, path;
    }' \
  | sed 's/^/  /'

# Debug symbols and unwinding tables (large, usually safe to strip from release).
echo "  -- debug symbols / DWARF (.debug, .dwp, .sym, DWARF strings):"
( cd "$ROOT" && find . -type f \( -name '*.debug' -o -name '*.dwp' -o -name '*.sym' \) -printf '%s\t%p\n' \
  | sort -nr | head -n 10 | awk -F'\t' '{
      size=$1; path=$2;
      if (size >= 1048576) printf "    %8.1f MB  %s\n", size/1048576, path;
      else if (size >= 1024) printf "    %8.1f KB  %s\n", size/1024, path;
      else printf "    %8d B    %s\n", size, path;
    }' )

# Chrome DevTools frontend files (DevTools frontend ships ~30MB on its own).
echo "  -- DevTools frontend (devtools_app, devtools_resources.pak):"
( cd "$ROOT" && find . -type f \( \
    -path '*devtools*' -o \
    -iname 'devtools_app*.pak' -o \
    -iname 'devtools_resources.pak' -o \
    -iname 'Inspector*.js' \) -printf '%s\t%p\n' ) \
  | sort -nr | head -n 10 | awk -F'\t' '{
      size=$1; path=$2;
      if (size >= 1048576) printf "    %8.1f MB  %s\n", size/1048576, path;
      else if (size >= 1024) printf "    %8.1f KB  %s\n", size/1024, path;
      else printf "    %8d B    %s\n", size, path;
    }'

# Pak files (typically locale + resources).
echo "  -- Pak files (resources/locale):"
( cd "$ROOT" && find . -type f -name '*.pak' -printf '%s\t%p\n' ) \
  | sort -nr | head -n 10 | awk -F'\t' '{
      size=$1; path=$2;
      if (size >= 1048576) printf "    %8.1f MB  %s\n", size/1048576, path;
      else if (size >= 1024) printf "    %8.1f KB  %s\n", size/1024, path;
      else printf "    %8d B    %s\n", size, path;
    }'

echo
echo "==> Recommendations (heuristic):"
if ( cd "$ROOT" && find . -iname 'MicrosoftEdgeWebview2Setup*' -size +1M -print -quit | grep -q . ); then
  echo "  - Drop the bundled WebView2 bootstrapper. Let the user's system WebView2 load at runtime."
fi
if ( cd "$ROOT" && find . -name '*.debug' -size +1M -print -quit | grep -q . ); then
  echo "  - Strip debug symbols from the release build. Set RUSTFLAGS='-C strip=symbols' or use Tauri's strip=true."
fi
if ( cd "$ROOT" && find . -path '*devtools*' -size +1M -print -quit | grep -q . ); then
  echo "  - Disable bundled DevTools for release builds (Tauri devtools toggle)."
fi
echo "  - Build with --release and LTO. In tauri.conf.json set bundle.linux.appimage.bundleMediaFramework=false."
echo "  - Exclude debug=webview-devtools from the bundle (tauri.conf.json -> build.beforeDevCommand/beforeBuildCommand should not inject DevTools)."

if [[ "$STATUS" == "OVER" ]]; then
  exit 1
fi
exit 0