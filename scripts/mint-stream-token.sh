#!/usr/bin/env bash
# Mint a per-user hive stream JWT for ad-hoc testing.
#
# The streamToken is the JWT hive-backend signs with config.jwt.secret
# (same shape as ``signStreamToken`` in
# hive-backend/src/services/sandbox/account-vm.service.ts). The hive
# runtime + hive-llm proxy validate it via HS256.
#
# Used by:
#   - parity-test.sh (HIVE_STREAM_TOKEN env)
#   - manual debugging when the desktop isn't running locally
#
#   ./mint-stream-token.sh                          # 24h TTL, default user
#   ./mint-stream-token.sh --sub user@example.com --team 14034
#   ./mint-stream-token.sh --ttl-hours 1            # short-lived
#
# Requires kubectl access to the staging namespace to read the
# JWT_SECRET from k8s `hive-secrets` (same secret hive-backend signs
# with). Falls back to $HIVE_JWT_SECRET env override.
set -euo pipefail

NAMESPACE="${HIVE_K8S_NAMESPACE:-staging}"
SECRET_NAME="${HIVE_K8S_SECRET:-hive-secrets}"
SUB="${HIVE_TOKEN_SUB:-timothy@adenhq.com}"
TEAM_ID="${HIVE_TOKEN_TEAM:-14034}"
TTL_HOURS="${HIVE_TOKEN_TTL_HOURS:-24}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sub) SUB="$2"; shift 2 ;;
    --team) TEAM_ID="$2"; shift 2 ;;
    --ttl-hours) TTL_HOURS="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    -h|--help) sed -n '1,/^$/p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve JWT_SECRET.
if [[ -n "${HIVE_JWT_SECRET:-}" ]]; then
  JWT_SECRET="$HIVE_JWT_SECRET"
elif command -v kubectl >/dev/null 2>&1; then
  JWT_SECRET=$(kubectl -n "$NAMESPACE" get secret "$SECRET_NAME" \
    -o jsonpath='{.data.JWT_SECRET}' 2>/dev/null | base64 -d) || true
  if [[ -z "$JWT_SECRET" ]]; then
    echo "error: kubectl couldn't read JWT_SECRET from $NAMESPACE/$SECRET_NAME" >&2
    echo "       set \$HIVE_JWT_SECRET directly or fix cluster access" >&2
    exit 1
  fi
else
  echo "error: neither \$HIVE_JWT_SECRET nor kubectl available" >&2
  exit 1
fi

# Sign with HS256. Inline Python so the script has zero external deps
# beyond the standard library — runs identically on the dev laptop and
# in CI.
JWT_SECRET="$JWT_SECRET" SUB="$SUB" TEAM_ID="$TEAM_ID" TTL_HOURS="$TTL_HOURS" \
python3 - <<'PYEOF'
import base64, hashlib, hmac, json, os, secrets, time, sys
secret = os.environ["JWT_SECRET"].encode()
payload = {
    "sub": os.environ["SUB"],
    "team_id": os.environ["TEAM_ID"],
    "sid": secrets.token_hex(8),
    "iat": int(time.time()),
    "exp": int(time.time()) + int(os.environ["TTL_HOURS"]) * 3600,
}
header = {"alg": "HS256", "typ": "JWT"}
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
h = b64(json.dumps(header, separators=(',', ':')).encode())
p = b64(json.dumps(payload, separators=(',', ':')).encode())
sig = b64(hmac.new(secret, f"{h}.{p}".encode(), hashlib.sha256).digest())
sys.stdout.write(f"{h}.{p}.{sig}\n")
PYEOF
