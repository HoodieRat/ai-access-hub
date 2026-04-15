#!/usr/bin/env bash
set -euo pipefail

PROMPT_FILE="${1:-rpg-master-prompt.txt}"
CONTINUE_COUNT="${2:-20}"
LOG_FILE="${3:-hermes-rpg-afk.log}"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/scripts/hermes-afk-runner.cjs"

if [[ ! -f "$RUNNER" ]]; then
  echo "Runner not found: $RUNNER" >&2
  exit 1
fi

node "$RUNNER" --preset rpg --prompt-file "$PROMPT_FILE" --max-continues "$CONTINUE_COUNT" --log-file "$LOG_FILE"

echo "Done. Output saved to $LOG_FILE"
