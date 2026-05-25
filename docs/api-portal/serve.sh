#!/usr/bin/env bash
# Hive VM control portal — local dev server.
#
# Plain static-file server on a port of your choice (default 8765).
# Auto-opens index.html in your default browser. Ctrl-C to stop.
#
#   ./serve.sh                # default port 8765
#   PORT=9000 ./serve.sh      # custom port
#   ./serve.sh 9000           # custom port (positional)
#   ./serve.sh --no-open      # skip auto-open
set -euo pipefail

PORT="${PORT:-${1:-8765}}"
[[ "$PORT" == "--no-open" ]] && PORT=8765 && OPEN=0
OPEN="${OPEN:-1}"
[[ "${2:-}" == "--no-open" ]] && OPEN=0

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}/"

# Pick the launch helper available on this machine; fall back to a
# printed URL if none.
open_browser() {
  if [[ "$OPEN" != "1" ]]; then return; fi
  (sleep 0.4
   if command -v xdg-open >/dev/null 2>&1;  then xdg-open  "$URL" >/dev/null 2>&1 || true
   elif command -v open >/dev/null 2>&1;    then open       "$URL" >/dev/null 2>&1 || true
   elif command -v wslview >/dev/null 2>&1; then wslview    "$URL" >/dev/null 2>&1 || true
   fi) &
}

# Pick a server: python3 is in stock Ubuntu; npx serve is the npm fallback.
if command -v python3 >/dev/null 2>&1; then
  CMD=(python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$ROOT")
elif command -v npx >/dev/null 2>&1; then
  CMD=(npx --yes serve -l "$PORT" "$ROOT")
else
  echo "error: need python3 or npx to serve files" >&2
  exit 1
fi

echo "Hive VM control portal"
echo "  serving:  $ROOT"
echo "  URL:      $URL"
echo "  Ctrl-C to stop"
echo

open_browser
exec "${CMD[@]}"
