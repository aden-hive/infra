#!/usr/bin/env bash
# Refresh `hive-src/` from a working checkout of the closed-source desktop
# runtime fork (defaults to $HOME/aden/hive-desktop-runtime) — the same
# source the AppImage's `hive-desktop/vendor/sync-hive.sh` pulls from.
#
# Why this exists: the desktop AppImage and the VM template MUST run the
# same hive-runtime code. Before this script, the AppImage was synced from
# `~/aden/hive-desktop-runtime` automatically at packaging time, but the
# VM template's `hive-src/` was an arbitrary local checkout the developer
# happened to have lying around — they drifted by ~100 commits in the wild.
# Now both call rsync with the same exclusion list and the same source.
#
#   bash sync-hive-src.sh                            # use $HOME/aden/hive-desktop-runtime
#   HIVE_SRC=/path/to/hive-runtime bash sync-hive-src.sh
#
# Idempotent. Stamps `.hive-source-rev` + `.hive-source-branch` so a later
# diff against the AppImage's matching files surfaces drift instantly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${HIVE_SRC:-$HOME/aden/hive-desktop-runtime}"
DST="$ROOT/hive-src"

if [[ ! -d "$SRC" || ! -f "$SRC/core/pyproject.toml" ]]; then
  echo "error: HIVE_SRC=$SRC isn't a hive checkout (no core/pyproject.toml)" >&2
  exit 1
fi

mkdir -p "$DST"
# Same exclusion set as hive-desktop/vendor/sync-hive.sh — keep them in
# lockstep so the AppImage and the VM template see identical source trees.
rsync -a --delete \
  --exclude='.git' \
  --exclude='.venv' \
  --exclude='node_modules' \
  --exclude='__pycache__' \
  --exclude='.pytest_cache' \
  --exclude='.ruff_cache' \
  --exclude='.mypy_cache' \
  --exclude='*.pyc' \
  --exclude='build/' \
  --exclude='dist/' \
  --exclude='core/frontend/' \
  --exclude='exports/' \
  "$SRC/" "$DST/"

# Stamp the source revision so a later diff against the AppImage's
# `release/OpenHive-*-linux-x64/resources/hive/.hive-source-rev` makes
# drift between the desktop and the VM trivially diagnosable.
if git -C "$SRC" rev-parse HEAD >/dev/null 2>&1; then
  git -C "$SRC" rev-parse HEAD > "$DST/.hive-source-rev"
  git -C "$SRC" rev-parse --abbrev-ref HEAD > "$DST/.hive-source-branch"
fi

du -sh "$DST"
echo "synced: $SRC -> $DST"
