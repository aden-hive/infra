#!/bin/bash
# Pull a userdata tarball from the signed S3 URL passed as $1 and extract
# it over /. Designed to run on sandbox boot BEFORE `hive serve` starts,
# so the runtime sees the restored queens/colonies/memories from the
# first moment it inits.
#
#   /usr/local/bin/hive-userdata-restore.sh \
#     "https://minio.../hive-userdata/<userId>/v1/userdata.tar.zst?<sig>"
#
# A 404 on HEAD is treated as "first boot for this user, nothing to
# restore" and exits 0 — restore must be idempotent across new users.
# Any other non-200 is a hard failure (don't let hive serve start on top
# of a half-restored state).
set -euo pipefail

GET_URL="${1:?usage: $0 <signed-GET-url>}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# Probe with HEAD first so 404 (new user) is non-fatal. curl -I follows
# the same auth as the GET, and the response is just headers.
STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
              --head "$GET_URL")
case "$STATUS" in
  200) ;;
  404)
    echo "hive-userdata-restore: no existing blob (HTTP 404) — first boot, skipping" >&2
    exit 0
    ;;
  *)
    echo "hive-userdata-restore: HEAD returned $STATUS — refusing to start hive on undefined state" >&2
    exit 1
    ;;
esac

TAR="$WORK/userdata.tar.zst"
curl --fail --show-error --silent \
     --output "$TAR" \
     "$GET_URL"

SIZE=$(stat -c %s "$TAR")
echo "hive-userdata-restore: downloaded ${SIZE} bytes" >&2

# Extract at /. The snapshot tar was built with `-C / root/.hive` so the
# paths inside are relative to /. We rely on tar's default behavior of
# overwriting existing files — anything baked into the template at
# /root/.hive (e.g. configuration.json) is replaced by the user's copy
# if present. That's intentional: the user's configuration wins.
tar --extract --zstd -f "$TAR" -C /

echo "hive-userdata-restore: extracted into /root/.hive" >&2
