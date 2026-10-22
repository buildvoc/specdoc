#!/usr/bin/env bash
set -euo pipefail
ROOT="${SPECDOC_ROOT:-/data/projects/specdoc}"
SOURCE="${SPECDOC_SOURCE:-$ROOT}"
eval "$(python3 "$ROOT/specdoc-project.py" --source "$SOURCE" --format shell)"
exec python3 "$ROOT/multi_project/publish_specs.py"
