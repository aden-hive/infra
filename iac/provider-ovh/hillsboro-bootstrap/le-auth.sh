#!/usr/bin/env bash
# /usr/local/bin/le-auth.sh — certbot DNS-01 manual-auth hook for GoDaddy.
#
# Persistent location (never /tmp — tmpfs on Ubuntu wipes on reboot, which
# is exactly the bug that broke VA's cert renewal in July 2026: the prior
# operator wrote the hook to /tmp/le-auth.sh, the server rebooted, and
# every scheduled renewal since then failed with "Unable to find
# manual-auth-hook command /tmp/le-auth.sh in the PATH".
#
# Called by certbot with two env vars:
#   CERTBOT_DOMAIN     — e.g. "vm-west.open-hive.com" or "*.vm-west.open-hive.com"
#   CERTBOT_VALIDATION — the TXT-record value to publish
#
# Writes a TXT record at _acme-challenge.<zone-suffix> via GoDaddy's API,
# then waits for public DNS to reflect it (belt-and-braces — certbot has
# its own recursor check but a hook that returns before propagation
# occasionally trips LE's validator).
#
# Bearer PAT in /etc/letsencrypt/godaddy.env as GODADDY_TOKEN=gd_pat_…
# Same env file the plan calls "already on VA" and which we now install
# fresh on Hillsboro.

set -euo pipefail

CREDS=/etc/letsencrypt/godaddy.env
[ -r "$CREDS" ] || { echo "le-auth: missing $CREDS" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CREDS"
[ -n "${GODADDY_TOKEN:-}" ] || { echo "le-auth: GODADDY_TOKEN not set in $CREDS" >&2; exit 1; }
[ -n "${CERTBOT_DOMAIN:-}" ] || { echo "le-auth: CERTBOT_DOMAIN unset (are you running me by hand?)" >&2; exit 1; }
[ -n "${CERTBOT_VALIDATION:-}" ] || { echo "le-auth: CERTBOT_VALIDATION unset" >&2; exit 1; }

# Strip any wildcard prefix — the challenge sits at _acme-challenge.<name>
# regardless of whether the cert is for foo.example.com or *.foo.example.com.
DOMAIN="${CERTBOT_DOMAIN#\*.}"

# We only manage records inside open-hive.com — hardcode the parent zone to
# avoid a wrong-zone typo silently succeeding against the wrong domain.
ZONE=open-hive.com
case "$DOMAIN" in
  *.$ZONE|"$ZONE") ;;
  *) echo "le-auth: refusing to touch DNS for $DOMAIN (parent zone must be $ZONE)" >&2; exit 1 ;;
esac

# GoDaddy's record NAME is relative to the zone (no trailing dot, no zone
# suffix). e.g. for DOMAIN=vm-west.open-hive.com and ZONE=open-hive.com,
# the record name is "_acme-challenge.vm-west".
REL="${DOMAIN%.$ZONE}"
if [ "$DOMAIN" = "$ZONE" ]; then
  REC_NAME="_acme-challenge"
else
  REC_NAME="_acme-challenge.${REL}"
fi

echo "le-auth: publish TXT ${REC_NAME}.${ZONE} = \"${CERTBOT_VALIDATION}\""

# PUT replaces all records at this name. To support multi-SAN certs where
# LE may issue back-to-back challenges for the same name (e.g. cert covers
# both foo.example.com and *.foo.example.com — same _acme-challenge.foo
# name), we GET the existing records first and merge our value onto them
# rather than clobbering. Idempotent: if our value already exists, no-op.
url_get="https://api.godaddy.com/v1/domains/${ZONE}/records/TXT/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "${REC_NAME}")"
existing="$(curl -sS -m 15 -H "Authorization: Bearer ${GODADDY_TOKEN}" "${url_get}" | python3 -c '
import json, sys, os
target = os.environ["CERTBOT_VALIDATION"]
try:
    rows = json.load(sys.stdin) or []
except Exception:
    rows = []
# CRITICAL: GoDaddy accepts a PUT payload with extra "name"/"type" fields
# (HTTP 200) but SILENTLY DROPS the records (dig returns empty). Strip the
# GET response to just {data,ttl} before rebuilding the array. Verified
# 2026-08-25: a PUT of [{"data":"X","name":"...","ttl":600,"type":"TXT"}]
# leaves no records; a PUT of [{"data":"X","ttl":600}] works.
kept = [{"data": r["data"], "ttl": 600} for r in rows if r.get("data") and r.get("data") != target]
kept.append({"data": target, "ttl": 600})
print(json.dumps(kept))
')"

curl -sS -m 15 -X PUT \
  -H "Authorization: Bearer ${GODADDY_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${existing}" \
  "${url_get}" >/dev/null

# Wait for propagation. Query authoritative NS directly (not a caching
# resolver) so we're not fooled by CDN stickiness. GoDaddy's NS answers
# nearly instantly in practice; we still cap at 120 s.
NS=ns71.domaincontrol.com
echo "le-auth: waiting for ${REC_NAME}.${ZONE} TXT to include ${CERTBOT_VALIDATION} (authoritative check via ${NS})"
for i in $(seq 1 60); do
  if dig +short TXT "${REC_NAME}.${ZONE}" "@${NS}" | grep -qF "${CERTBOT_VALIDATION}"; then
    echo "le-auth: propagated in ${i}s (via ${NS})"
    # Extra small pause — Let's Encrypt's validator polls a random
    # recursor, not the authoritative NS. 10 s of extra slack.
    sleep 10
    exit 0
  fi
  sleep 2
done
echo "le-auth: propagation timeout waiting for ${REC_NAME}.${ZONE} — LE validation may still succeed but is at risk" >&2
exit 0  # don't fail the hook — let certbot try and surface the real error
