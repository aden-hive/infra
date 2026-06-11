#!/bin/bash
# Stage HIVE_HOME (=/root/.hive) into a single zstd-compressed tarball and
# PUT it to the signed S3 URL passed as $1. Exits non-zero on any failure
# so the caller (orchestrator) treats sync failure as a hard error rather
# than silently destroying the sandbox with the user's data still on disk.
#
#   /usr/local/bin/hive-userdata-snapshot.sh \
#     "https://minio.../hive-userdata/<userId>/v1/userdata.tar.zst?<sig>"
#
# Exclusion set:
#   .venv               — runtime ships its own per-template venv, never user state
#   caches              — re-derive cheaply on next boot, just inflate the blob
#   failed_requests/    — local debug telemetry, no value across upgrades
#
# `/data/chrome` is NOT included in this RC — chrome profiles can be
# hundreds of MB and need selective extraction (cookies yes, cache no).
# A later RC will add a second tarball for chrome state.
set -euo pipefail

PUT_URL="${1:?usage: $0 <signed-PUT-url>}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TAR="$WORK/userdata.tar.zst"

# We tar from / with relative paths so extraction lands at the same path
# on restore. zstd level 3 (default) is the right tradeoff — level 19
# saves another 15% at 10× the wall-clock, which we pay every Stop.
tar --create --zstd \
    --exclude='.venv' \
    --exclude='__pycache__' \
    --exclude='.ruff_cache' \
    --exclude='.mypy_cache' \
    --exclude='*.pyc' \
    --exclude='failed_requests' \
    -f "$TAR" \
    -C / root/.hive

SIZE=$(stat -c %s "$TAR")
echo "hive-userdata-snapshot: tar size=${SIZE} bytes" >&2

# PUT to signed URL. --fail makes any 4xx/5xx an explicit error. Don't
# log the URL itself — the signature is the auth token.
curl --fail --show-error --silent \
     --upload-file "$TAR" \
     "$PUT_URL"

echo "hive-userdata-snapshot: uploaded ${SIZE} bytes" >&2
