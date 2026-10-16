#!/bin/sh
# Two Claude Code agents, same repo, overlapping tasks: Engram's claim blocks the second editor.
# usage: scripts/demo-coordination.sh /path/to/click-checkout
set -e
REPO="$1"; PLUGIN="$(cd "$(dirname "$0")/../plugin" && pwd)"
export FALKORDB_URL="${FALKORDB_URL:-falkor://localhost:6390}" ENGRAM_REPO="${ENGRAM_REPO:-demo-coordination}"
run() { # $1 = agent name, $2 = task
  ENGRAM_AGENT="$1" claude -p "$2" --model haiku --permission-mode bypassPermissions --plugin-dir "$PLUGIN" \
    --no-session-persistence --output-format text 2>&1 | sed "s/^/[$1] /"
}
cd "$REPO"
run agent-A "In src/click/types.py, add a short comment above BoolParamType.bool_states explaining which strings map to True. Then wait by running: sleep 25" &
sleep 8
run agent-B "In src/click/types.py, add a docstring to BoolParamType.str_to_bool." &
wait
echo "--- claims and sessions in the graph:"
cd "$(dirname "$0")/.." 2>/dev/null || true
