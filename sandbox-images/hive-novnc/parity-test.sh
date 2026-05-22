#!/usr/bin/env bash
# Local↔remote colony parity check.
#
#   ./parity-test.sh                              # uses test-fixtures/parity_smoke
#   ./parity-test.sh --colony x_reply             # any colony from ~/.hive/colonies/
#   ./parity-test.sh --colony /path/to/fixture    # any explicit fixture root
#   ./parity-test.sh --keep                       # don't tear down sandbox/tunnel/runtime on exit
#
# What this script does, in order:
#   1. Stages the colony into a tarball matching pushColonyToWorkspace's
#      multi-root layout (colonies/<name>/ + agents/<name>/worker/ +
#      agents/queens/<q>/sessions/<sid>/).
#   2. Spawns a fresh local `hive serve` against an isolated $HIVE_HOME.
#   3. Spawns a fresh remote e2b sandbox via the e2b API.
#   4. Opens an SSH tunnel to the orchestrator's :5007 so we can hit the
#      sandbox via Host-header routing without minting an embed token.
#   5. Pushes the same tarball to both via POST /api/colonies/import.
#   6. Creates a session against the colony on both sides, sends a prompt,
#      polls for either set_output / max_iterations / 60s timeout.
#   7. Invokes parity-test.py to GET each side's session/events/skills/
#      workers/config_llm/credentials and compare along PARITY_DIMENSIONS.
#   8. Tears down: kills local hive serve, deletes the remote sandbox,
#      closes the SSH tunnel.
#
# Why a separate Python helper: the JSON diffing in parity-test.py is
# easier to read and maintain than the bash equivalent. This shell script
# handles process orchestration and filesystem; Python handles the test
# matrix and report.
#
# Requires:
#   - SSH access to $ORCH_HOST as $ORCH_USER (default: ubuntu@135.148.52.236)
#   - Python 3.11+ for parity-test.py
#   - $E2B_API_KEY set (or kubectl access to staging-hive-app pod env)
#   - A working `~/aden/hive-desktop-runtime/.venv` (or HIVE_RUNTIME_DIR set)

set -euo pipefail
# pipefail: critical so the final `python3 parity-test.py … | tee /tmp/…`
# pipeline propagates parity-test.py's exit code instead of `tee`'s 0.
# Prior version reported "EXIT=0" even when parity-test FAIL'd.
set -o pipefail

ORCH_USER="${ORCH_USER:-ubuntu}"
ORCH_HOST="${ORCH_HOST:-135.148.52.236}"
ORCH="${ORCH_USER}@${ORCH_HOST}"
TUNNEL_PORT="${TUNNEL_PORT:-15007}"  # local side of the SSH tunnel
HIVE_E2B_TEMPLATE="${HIVE_E2B_TEMPLATE:-hivev3}"
RUN_ID="$(date +%s)-$$"
RUN_DIR="/tmp/parity-${RUN_ID}"
COLONY_ARG=""
KEEP=0
PROMPT="${PROMPT:-Reply with the word 'pong' and call set_output to finish.}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --colony) COLONY_ARG="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '1,/^$/p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$RUN_DIR"

# Resolve the colony source dir.
if [[ -z "$COLONY_ARG" ]]; then
  COLONY_SRC="$ROOT/test-fixtures/parity_smoke"
  COLONY_NAME="parity_smoke"
elif [[ -d "$COLONY_ARG" ]]; then
  COLONY_SRC="$COLONY_ARG"
  COLONY_NAME="$(basename "$COLONY_ARG")"
else
  COLONY_NAME="$COLONY_ARG"
  COLONY_SRC="$HOME/.hive/colonies/$COLONY_NAME"
  if [[ ! -d "$COLONY_SRC" ]]; then
    echo "error: colony '$COLONY_NAME' not found at $COLONY_SRC" >&2
    exit 1
  fi
fi
echo "→ colony: $COLONY_NAME ($COLONY_SRC)"

# ── 1. Stage the multi-root tar ───────────────────────────────────────
STAGE="$RUN_DIR/stage"
mkdir -p "$STAGE/colonies" "$STAGE/agents"

if [[ -d "$COLONY_SRC/colonies" && -d "$COLONY_SRC/agents" ]]; then
  # Already in multi-root layout (parity_smoke fixture).
  cp -r "$COLONY_SRC/colonies/." "$STAGE/colonies/"
  cp -r "$COLONY_SRC/agents/." "$STAGE/agents/"
else
  # Layout is `<colony>/...` — wrap into multi-root the same way the
  # desktop's pushColonyToWorkspace does. metadata.json points at a
  # queen session under ~/.hive/agents/queens/<q>/sessions/<sid>/; if
  # it exists, ship it.
  cp -r "$COLONY_SRC" "$STAGE/colonies/$COLONY_NAME"
  if [[ -f "$STAGE/colonies/$COLONY_NAME/metadata.json" ]]; then
    QSESSION=$(python3 -c "import json,sys;
m=json.load(open('$STAGE/colonies/$COLONY_NAME/metadata.json'));
print(m.get('queen_session_id') or '')")
    QNAME=$(python3 -c "import json,sys;
m=json.load(open('$STAGE/colonies/$COLONY_NAME/metadata.json'));
print(m.get('queen_name') or m.get('queen_id') or '')")
    if [[ -n "$QSESSION" && -n "$QNAME" ]]; then
      QSRC="$HOME/.hive/agents/queens/$QNAME/sessions/$QSESSION"
      if [[ -d "$QSRC" ]]; then
        mkdir -p "$STAGE/agents/queens/$QNAME/sessions"
        cp -r "$QSRC" "$STAGE/agents/queens/$QNAME/sessions/$QSESSION"
        echo "  + included queen session $QNAME/$QSESSION"
      fi
    fi
  fi
  if [[ -d "$HOME/.hive/agents/$COLONY_NAME/worker" ]]; then
    mkdir -p "$STAGE/agents/$COLONY_NAME"
    cp -r "$HOME/.hive/agents/$COLONY_NAME/worker" "$STAGE/agents/$COLONY_NAME/worker"
    echo "  + included worker tree"
  fi
fi

PUSH_TAR="$RUN_DIR/push.tar.gz"
tar -C "$STAGE" -czf "$PUSH_TAR" colonies agents
echo "  staged tar: $PUSH_TAR ($(stat -c%s "$PUSH_TAR") bytes)"

# ── 2. Spawn local hive serve ─────────────────────────────────────────
LOCAL_HIVE_HOME="$RUN_DIR/local"
mkdir -p "$LOCAL_HIVE_HOME"

# Preseed configuration.json so local hive serve has the same provider
# config the VM bakes in via Dockerfile. Without this, the local side
# has provider="" / model="" / has_api_key=false and parity comparison
# is meaningless (last live run showed exactly this divergence).
cat > "$LOCAL_HIVE_HOME/configuration.json" <<'EOF'
{
  "llm": {
    "provider": "hive",
    "model": "glm-5.1",
    "max_tokens": 32768,
    "max_context_tokens": 240000,
    "api_key_env_var": "HIVE_API_KEY",
    "api_base": "https://llm.open-hive.com"
  },
  "gcu_enabled": true
}
EOF

# Find a hive-runtime checkout to spawn from. Default to the same source
# the AppImage / VM template both pull from.
RUNTIME_DIR="${HIVE_RUNTIME_DIR:-$HOME/aden/hive-desktop-runtime}"
if [[ ! -f "$RUNTIME_DIR/core/pyproject.toml" ]]; then
  echo "error: HIVE_RUNTIME_DIR=$RUNTIME_DIR is not a hive checkout" >&2
  exit 1
fi

# Discover a streamToken so we can authenticate the LLM path on both
# sides. This is the JWT hive-backend mints per-user; the desktop POSTs
# it to /api/credentials with credential_id=hive. Without it,
# llm_has_api_key=false on both sides and the queen errors with
# "Missing Anthropic API Key" on the first turn — which is exactly the
# bug we shipped four fixes for in the past 8 days. Discovery order:
#   1. $HIVE_STREAM_TOKEN env var (explicit override)
#   2. /proc/<pid>/environ of a running desktop hive serve
#   3. fail loudly with a clear hint
STREAM_TOKEN="${HIVE_STREAM_TOKEN:-}"
if [[ -z "$STREAM_TOKEN" ]]; then
  DESKTOP_HIVE_PID=$(pgrep -f "runtime-venv/bin/.*hive serve" | head -1 || true)
  if [[ -n "$DESKTOP_HIVE_PID" ]]; then
    STREAM_TOKEN=$(sudo cat "/proc/$DESKTOP_HIVE_PID/environ" 2>/dev/null \
      | tr '\0' '\n' | grep '^HIVE_API_KEY=' | cut -d= -f2- || true)
    [[ -n "$STREAM_TOKEN" ]] && echo "  streamToken: discovered from desktop pid $DESKTOP_HIVE_PID"
  fi
fi
if [[ -z "$STREAM_TOKEN" ]]; then
  echo "error: no HIVE_STREAM_TOKEN found." >&2
  echo "  set \$HIVE_STREAM_TOKEN, or run the desktop app so its hive serve" >&2
  echo "  has a fresh JWT we can read from its env." >&2
  exit 1
fi

LOCAL_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
LOCAL_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
LOCAL_LOG="$RUN_DIR/local.log"

echo "→ spawning local hive serve on :$LOCAL_PORT (HIVE_HOME=$LOCAL_HIVE_HOME)"
(
  cd "$RUNTIME_DIR/core" && \
  HIVE_HOME="$LOCAL_HIVE_HOME" \
  HIVE_DESKTOP_TOKEN="$LOCAL_TOKEN" \
  HIVE_DESKTOP_MODE=1 \
  HIVE_API_KEY="$STREAM_TOKEN" \
  uv run hive serve --host 127.0.0.1 --port "$LOCAL_PORT" \
    > "$LOCAL_LOG" 2>&1 &
  echo $! > "$RUN_DIR/local.pid"
) &
sleep 1

LOCAL_PID=$(cat "$RUN_DIR/local.pid")
LOCAL_URL="http://127.0.0.1:$LOCAL_PORT"

# wait for /api/sessions to respond
for i in $(seq 1 30); do
  sleep 1
  if curl -sS -m 2 -H "X-Hive-Token: $LOCAL_TOKEN" "$LOCAL_URL/api/sessions" >/dev/null 2>&1; then
    echo "  local hive serve ready"
    break
  fi
done

# ── 3 + 4. Spawn remote sandbox + SSH tunnel ──────────────────────────
if [[ -z "${E2B_API_KEY:-}" ]]; then
  if command -v kubectl >/dev/null 2>&1; then
    POD=$(kubectl -n staging get pods -o name 2>/dev/null | grep 'staging-hive-app' | head -1 | sed 's|pod/||')
    [[ -n "$POD" ]] && E2B_API_KEY=$(kubectl -n staging exec "$POD" -- env 2>/dev/null \
      | grep '^E2B_API_KEY=' | cut -d= -f2- || true)
  fi
fi
if [[ -z "${E2B_API_KEY:-}" ]]; then
  echo "error: E2B_API_KEY not set and kubectl couldn't find one" >&2
  exit 1
fi

echo "→ spawning remote sandbox (template=$HIVE_E2B_TEMPLATE)"
SPAWN_RESP=$(curl -sS -m 30 -X POST https://api.vm.open-hive.com/sandboxes \
  -H "X-API-Key: $E2B_API_KEY" -H "Content-Type: application/json" \
  -d "{\"templateID\":\"$HIVE_E2B_TEMPLATE\",\"timeout\":300,\"metadata\":{\"diag\":\"parity-test-$RUN_ID\"}}")
REMOTE_SANDBOX=$(echo "$SPAWN_RESP" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('sandboxID',''))" 2>/dev/null)
if [[ -z "$REMOTE_SANDBOX" ]]; then
  echo "error: failed to spawn remote sandbox: $SPAWN_RESP" >&2
  exit 1
fi
echo "  remote sandboxID: $REMOTE_SANDBOX"
REMOTE_HOST_HEADER="8787-${REMOTE_SANDBOX}.vm.open-hive.com"

echo "→ opening SSH tunnel ${TUNNEL_PORT} → ${ORCH}:5007"
ssh -fN -L "${TUNNEL_PORT}:127.0.0.1:5007" "$ORCH"
TUNNEL_PID=$(pgrep -f "ssh -fN -L ${TUNNEL_PORT}:127.0.0.1:5007" | head -1)
echo "  tunnel pid: $TUNNEL_PID"
REMOTE_URL="http://127.0.0.1:${TUNNEL_PORT}"

# wait for remote hive serve to come up (firecracker boot + supervisord)
for i in $(seq 1 30); do
  sleep 2
  if curl -sS -m 3 -H "Host: $REMOTE_HOST_HEADER" "$REMOTE_URL/api/sessions" >/dev/null 2>&1; then
    echo "  remote hive serve ready ($i polls)"
    break
  fi
done

# ── 5a. Push the same tar to both ─────────────────────────────────────
echo "→ pushing colony to local"
curl -sS -m 30 -X POST "$LOCAL_URL/api/colonies/import" \
  -H "X-Hive-Token: $LOCAL_TOKEN" \
  -F "file=@$PUSH_TAR" -F "replace_existing=true" \
  | python3 -m json.tool 2>/dev/null | head -10 || true

echo "→ pushing colony to remote"
curl -sS -m 60 -X POST "$REMOTE_URL/api/colonies/import" \
  -H "Host: $REMOTE_HOST_HEADER" \
  -F "file=@$PUSH_TAR" -F "replace_existing=true" \
  | python3 -m json.tool 2>/dev/null | head -10 || true

# ── 5b. POST the streamToken as the `hive` credential to both ─────────
# Mirrors what the desktop's configureRemoteLlm + configureLocalLlm do
# after auth so the queen's LLM provider has an api_key on first turn.
# Without this, both sides resolve has_api_key=false and the queen
# errors immediately with "Missing Anthropic API Key" — exactly the
# regression class our parity test must catch.
CRED_BODY=$(python3 -c "import json; print(json.dumps({'credential_id':'hive','keys':{'api_key':'$STREAM_TOKEN'}}))")
echo "→ POST hive credential to local"
curl -sS -m 10 -X POST "$LOCAL_URL/api/credentials" \
  -H "X-Hive-Token: $LOCAL_TOKEN" -H "Content-Type: application/json" \
  -d "$CRED_BODY" | head -c 200
echo
echo "→ POST hive credential to remote"
curl -sS -m 10 -X POST "$REMOTE_URL/api/credentials" \
  -H "Host: $REMOTE_HOST_HEADER" -H "Content-Type: application/json" \
  -d "$CRED_BODY" | head -c 200
echo

# ── 6. Create sessions on both — bind to the colony with agent_path ───
# `agent_path` makes the runtime call create_session_with_worker_colony,
# which loads the colony's worker.json. Without it (prior version of
# this script), both sides got queen-only sessions with has_worker=false
# and colony_name=null.
# Don't add `--` here: python3 -c parses argv as ['-c', ...rest], so the
# `--` itself becomes argv[1] and the real prompt becomes argv[2]. Without
# the separator, argv[1] is the prompt as intended. Caught when local
# queen kept replying "looks like a blank message" because it received
# `--` as the user input.
PROMPT_JSON=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$PROMPT")

# Read the colony's queen_name out of metadata.json so we can pin both
# sides to the same queen profile (both runtimes default-pick differently
# when queen_name is unset, surfacing as a queen_id divergence).
QUEEN_NAME=$(python3 -c "import json; print(json.load(open('$STAGE/colonies/$COLONY_NAME/metadata.json')).get('queen_name') or '')" 2>/dev/null)

echo "→ create local session (agent_path=$LOCAL_HIVE_HOME/colonies/$COLONY_NAME, queen=$QUEEN_NAME)"
LOCAL_SESSION_RESP=$(curl -sS -m 30 -X POST "$LOCAL_URL/api/sessions" \
  -H "X-Hive-Token: $LOCAL_TOKEN" -H "Content-Type: application/json" \
  -d "{\"agent_path\":\"$LOCAL_HIVE_HOME/colonies/$COLONY_NAME\",
       \"queen_name\":\"$QUEEN_NAME\",
       \"initial_prompt\":$PROMPT_JSON,
       \"initial_phase\":\"independent\"}" || echo '{}')
LOCAL_SID=$(echo "$LOCAL_SESSION_RESP" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id') or d.get('id') or '')" 2>/dev/null)
echo "  local sid: $LOCAL_SID"

echo "→ create remote session (agent_path=/root/.hive/colonies/$COLONY_NAME, queen=$QUEEN_NAME)"
REMOTE_SESSION_RESP=$(curl -sS -m 30 -X POST "$REMOTE_URL/api/sessions" \
  -H "Host: $REMOTE_HOST_HEADER" -H "Content-Type: application/json" \
  -d "{\"agent_path\":\"/root/.hive/colonies/$COLONY_NAME\",
       \"queen_name\":\"$QUEEN_NAME\",
       \"initial_prompt\":$PROMPT_JSON,
       \"initial_phase\":\"independent\"}" || echo '{}')
REMOTE_SID=$(echo "$REMOTE_SESSION_RESP" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id') or d.get('id') or '')" 2>/dev/null)
echo "  remote sid: $REMOTE_SID"

if [[ -z "$LOCAL_SID" || -z "$REMOTE_SID" ]]; then
  echo "warning: one or both session creates failed; comparing what we got anyway"
  echo "  local resp: $LOCAL_SESSION_RESP" | head -c 300
  echo "  remote resp: $REMOTE_SESSION_RESP" | head -c 300
fi

# ── Poll queen activity instead of sleeping ──────────────────────────
# The queen processes initial_prompt asynchronously. Wait for either a
# tool_call_started event, an error event, or 60s elapsed. Polls each
# side independently — the first to settle stops the wait.
echo "→ polling for queen activity (up to 60s)"
poll_side() {
  local label="$1" url="$2" sid="$3" hdr_name="$4" hdr_val="$5"
  [[ -z "$sid" ]] && return 0
  for i in $(seq 1 30); do
    local body
    body=$(curl -sS -m 3 -H "$hdr_name: $hdr_val" \
      "$url/api/sessions/$sid/events/history?limit=20" 2>/dev/null || echo '{}')
    if echo "$body" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: sys.exit(1)
evs=d.get('events',[])
for e in evs:
    if e.get('type') in ('tool_call_started','error','stream_error','exception','queen_loop_iteration'):
        sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
      echo "  $label settled after ${i} polls"
      return 0
    fi
    sleep 2
  done
  echo "  $label still polling at 60s — proceeding to compare anyway"
}
poll_side "local" "$LOCAL_URL" "$LOCAL_SID" "X-Hive-Token" "$LOCAL_TOKEN"
poll_side "remote" "$REMOTE_URL" "$REMOTE_SID" "Host" "$REMOTE_HOST_HEADER"

# ── 7. Run the parity comparison ──────────────────────────────────────
echo "→ comparing"
python3 "$ROOT/parity-test.py" \
  --local-url "$LOCAL_URL" \
  --local-token "$LOCAL_TOKEN" \
  --remote-url "$REMOTE_URL" \
  --remote-host-header "$REMOTE_HOST_HEADER" \
  --local-session-id "$LOCAL_SID" \
  --remote-session-id "$REMOTE_SID" \
  --report "$RUN_DIR/report.json" \
  && PARITY_RESULT=0 || PARITY_RESULT=$?

# ── 8. Cleanup ────────────────────────────────────────────────────────
cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    echo "→ --keep set; leaving local pid=$LOCAL_PID, remote sandbox=$REMOTE_SANDBOX, tunnel pid=$TUNNEL_PID, run dir=$RUN_DIR"
    return
  fi
  echo "→ teardown"
  # Kill the local hive serve subtree, not just the bash wrapper. The
  # original `kill $LOCAL_PID` signaled the cd-subshell but `uv → python
  # → hive serve` (plus 5 MCP-server children) survived as orphans. Use
  # pkill -P recursively from the wrapper pid; pkill returns 1 if no
  # processes match (which is fine if a prior signal already killed
  # them) so swallow with `|| true`.
  if [[ -n "${LOCAL_PID:-}" ]]; then
    # Recursively walk the process tree and kill descendants.
    descendants() { local p=$1; for c in $(pgrep -P "$p" 2>/dev/null); do echo "$c"; descendants "$c"; done; }
    for d in $(descendants "$LOCAL_PID") "$LOCAL_PID"; do
      kill -KILL "$d" 2>/dev/null || true
    done
  fi
  [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
  if [[ -n "${REMOTE_SANDBOX:-}" ]]; then
    curl -sS -m 10 -X DELETE "https://api.vm.open-hive.com/sandboxes/$REMOTE_SANDBOX" \
      -H "X-API-Key: $E2B_API_KEY" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
cleanup

echo
echo "report: $RUN_DIR/report.json"
exit "$PARITY_RESULT"
