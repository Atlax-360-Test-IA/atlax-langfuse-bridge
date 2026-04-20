#!/usr/bin/env bash
# statusline.sh — Claude Code statusline hook. Prints the current billing
# tier (seat/vertex/api/?) plus the account if detectable. Side effect:
# updates ~/.atlax-ai/tier.json so the langfuse-sync hook can read it.
#
# Install in ~/.claude/settings.json:
#   {
#     "statusLine": {
#       "type": "command",
#       "command": "/absolute/path/to/atlax-langfuse-bridge/scripts/statusline.sh"
#     }
#   }
#
# This script prints a single line of text to stdout. Keep it <5ms — it runs
# on every prompt tick.
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun run "${SCRIPT_DIR}/detect-tier.ts" --label 2>/dev/null || printf '? tier'
