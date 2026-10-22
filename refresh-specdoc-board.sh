#!/usr/bin/env bash
set -euo pipefail

ROOT="/data/projects/specdoc"
LOGDIR="$ROOT/logs"
STATE="$LOGDIR/specdoc-refresh.state"
HISTORY="$LOGDIR/specdoc-refresh-history.log"
CORE="$ROOT/refresh-specdoc.sh"

SOURCE="${1:-$ROOT}"
SOURCE="$(realpath "$SOURCE")"

case "$SOURCE" in
  /data/projects|/data/projects/*) ;;
  *)
    echo "ERROR: source path must be under /data/projects" >&2
    exit 2
    ;;
esac

[ -d "$SOURCE" ] || {
  echo "ERROR: directory not found: $SOURCE" >&2
  exit 2
}

[ -x "$CORE" ] || {
  echo "ERROR: refresh-specdoc.sh not found or not executable" >&2
  exit 2
}

mkdir -p "$LOGDIR"

START="$(date +%s)"
PHASE="Starting"
PROGRESS=2

write_state() {
  local status="$1"
  local ended="${2:-0}"
  local rc="${3:-0}"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$status" "$$" "$START" "$PHASE" "$PROGRESS" "$SOURCE" "$ended" "$rc" \
    > "$STATE"
}

finish() {
  local rc=$?
  local end duration
  end="$(date +%s)"
  duration=$((end - START))

  if [ "$rc" -eq 0 ]; then
    PHASE="Complete"
    PROGRESS=100
    write_state complete "$end" 0
    printf '%s\t%s\n' "$duration" "$SOURCE" >> "$HISTORY"
    echo "Refresh complete: $SOURCE"
  else
    PHASE="Failed"
    write_state failed "$end" "$rc"
    echo "Refresh failed: $SOURCE (exit $rc)" >&2
  fi
}

trap finish EXIT

PHASE="Project refresh"
PROGRESS=10
write_state running

echo "Board refresh source: $SOURCE"
echo "Delegating to multi-project refresh: $CORE"

# Critical: do not duplicate PocketFlow generation here.
# The core refresh owns project identity, isolated output, publication and registry.
SPECDOC_NO_RESTART=1 "$CORE" "$SOURCE"

PHASE="Refreshing board data"
PROGRESS=97
write_state running
