#!/usr/bin/env bash
# /usr/local/bin/le-cleanup.sh — certbot DNS-01 cleanup hook for GoDaddy.
#
# Companion to le-auth.sh. Called after LE has validated (or timed out) to
# remove the _acme-challenge TXT record. Same env vars from certbot:
#   CERTBOT_DOMAIN, CERTBOT_VALIDATION
#
# Removes only OUR entry — if another value was published to the same
# name (multi-SAN, concurrent renewal), those are preserved.

set -euo pipefail

CREDS=/etc/letsencrypt/godaddy.env
[ -r "$CREDS" ] || { echo "le-cleanup: missing $CREDS" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CREDS"
[ -n "${GODADDY_TOKEN:-}" ] || { echo "le-cleanup: GODADDY_TOKEN not set" >&2; exit 1; }
[ -n "${CERTBOT_DOMAIN:-}" ] || exit 0
[ -n "${CERTBOT_VALIDATION:-}" ] || exit 0

DOMAIN="${CERTBOT_DOMAIN#\*.}"
ZONE=open-hive.com
case "$DOMAIN" in
  *.$ZONE|"$ZONE") ;;
  *) echo "le-cleanup: not touching DNS for $DOMAIN (parent must be $ZONE)" >&2; exit 0 ;;
esac
REL="${DOMAIN%.$ZONE}"
if [ "$DOMAIN" = "$ZONE" ]; then
  REC_NAME="_acme-challenge"
else
  REC_NAME="_acme-challenge.${REL}"
fi

echo "le-cleanup: remove TXT ${REC_NAME}.${ZONE} = \"${CERTBOT_VALIDATION}\""

url="https://api.godaddy.com/v1/domains/${ZONE}/records/TXT/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "${REC_NAME}")"

remaining="$(curl -sS -m 15 -H "Authorization: Bearer ${GODADDY_TOKEN}" "${url}" | python3 -c '
import json, sys, os
target = os.environ["CERTBOT_VALIDATION"]
try:
    rows = json.load(sys.stdin) or []
except Exception:
    rows = []
# Same GoDaddy quirk as le-auth: PUT payload must be minimal {data,ttl}.
# See le-auth.sh comment for the diagnostic that pinned this.
kept = [{"data": r["data"], "ttl": 600} for r in rows if r.get("data") and r.get("data") != target]
print(json.dumps(kept))
')"

# GoDaddy has no "DELETE all records at this name" REST verb; PUT with empty
# array 400s. When there's nothing left, we PUT a single throwaway record
# and DELETE it — but the simpler robust behavior is to leave a stale
# _acme-challenge with no data (harmless; LE just ignores it). If there
# ARE remaining values, PUT them.
if [ "$(echo "$remaining" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')" = "0" ]; then
  # PUT an empty-content-effectively record via DELETE endpoint (GoDaddy
  # supports DELETE /records/{type}/{name} in recent API versions).
  curl -sS -m 15 -X DELETE \
    -H "Authorization: Bearer ${GODADDY_TOKEN}" \
    "${url}" >/dev/null || echo "le-cleanup: DELETE returned non-2xx (harmless; stale TXT persists)" >&2
else
  curl -sS -m 15 -X PUT \
    -H "Authorization: Bearer ${GODADDY_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${remaining}" \
    "${url}" >/dev/null
fi
