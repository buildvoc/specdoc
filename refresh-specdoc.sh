#!/usr/bin/env bash
set -euo pipefail
ROOT="${SPECDOC_ROOT:-/data/projects/specdoc}"
ENGINE="$ROOT/pocketflow"
SOURCE="${1:-$ROOT}"
eval "$(python3 "$ROOT/specdoc-project.py" --source "$SOURCE" --format shell)"
PY="$ENGINE/.venv/bin/python"; [ -x "$PY" ] || PY=python3
mkdir -p "$ROOT/specifications/.staging" "$(dirname "$SPECDOC_SPEC_DIR")" "$ROOT/projects"
STAGE_BASE="$ROOT/specifications/.staging/${SPECDOC_PROJECT_KEY}.$$"
OLD_DIR="${SPECDOC_SPEC_DIR}.previous.$$"
mkdir -p "$STAGE_BASE"
cleanup(){ rm -rf "$STAGE_BASE"; }
trap cleanup EXIT
printf 'project:   %s\nsource:    %s\noutput:    %s\naliases:   %s-*\n' "$SPECDOC_NAMESPACE" "$SPECDOC_SOURCE" "$SPECDOC_SPEC_DIR" "$SPECDOC_ALIAS_PREFIX"
if [ -f "$ENGINE/.env" ]; then set -a; . "$ENGINE/.env"; set +a; fi
(
  cd "$ENGINE"
  "$PY" -u main.py --dir "$SPECDOC_SOURCE" --name "$SPECDOC_PROJECT_NAME" --output "$STAGE_BASE" --no-cache
)
GENERATED="$STAGE_BASE/$SPECDOC_PROJECT_NAME"
if [ ! -f "$GENERATED/index.md" ] && [ -f "$STAGE_BASE/index.md" ]; then GENERATED="$STAGE_BASE"; fi
[ -f "$GENERATED/index.md" ] || { echo "PocketFlow did not produce index.md for $SPECDOC_NAMESPACE" >&2; exit 1; }
[ ! -f "$ENGINE/project_changelog.py" ] || "$PY" -u "$ENGINE/project_changelog.py" "$SPECDOC_SOURCE" "$GENERATED/CHANGELOG.md"
if [ -e "$SPECDOC_SPEC_DIR" ]; then rm -rf "$OLD_DIR"; mv "$SPECDOC_SPEC_DIR" "$OLD_DIR"; fi
mkdir -p "$(dirname "$SPECDOC_SPEC_DIR")"; mv "$GENERATED" "$SPECDOC_SPEC_DIR"
rollback(){ if [ -e "$OLD_DIR" ]; then rm -rf "$SPECDOC_SPEC_DIR"; mv "$OLD_DIR" "$SPECDOC_SPEC_DIR"; fi; }
trap 'rollback; cleanup' ERR
SPECDOC_SOURCE="$SPECDOC_SOURCE" SPECDOC_NAMESPACE="$SPECDOC_NAMESPACE" SPECDOC_SPEC_DIR="$SPECDOC_SPEC_DIR" SPECDOC_ALIAS_PREFIX="$SPECDOC_ALIAS_PREFIX" SPECDOC_PROJECT_GITHUB="$SPECDOC_PROJECT_GITHUB" SPECDOC_NO_RESTART=1 "$ROOT/publish-specs.sh"
python3 "$ROOT/specdoc-project.py" --source "$SPECDOC_SOURCE" --write-registry --format json >/dev/null
rm -rf "$OLD_DIR"; trap cleanup EXIT
if [ "${SPECDOC_NO_RESTART:-0}" != "1" ]; then sudo systemctl restart specdoc-hd2-adapter.service specdoc-hd2-board.service; fi
printf '\nrefresh complete: %s\nspecifications:   %s\nmanifest:         %s/manifest.json\n' "$SPECDOC_NAMESPACE" "$SPECDOC_SPEC_DIR" "$SPECDOC_SPEC_DIR"
