#!/bin/bash
# Onboarding console — a browser the operator drives over VNC, running on the
# host and egress IP the profile actually lives at.
#
# Driven by `npm run onboard start <accountId>`, which resolves the account's
# egress and passes it in. Do not launch it by hand for an existing account:
# the proxy must be the one that account already logs in from.
#
# This is the §10 `onboard` lease in its simplest possible form. The point is
# the sequencing rule: the account logs in FROM the address it will later run
# from, so LinkedIn never sees the session move at the moment it scrutinises
# hardest.
#
# Nothing binds to a public interface. Reach it with an SSH tunnel:
#   gcloud compute ssh browser-farm-spike --project=aden-487803 \
#     --zone=us-west2-a -- -L 6080:localhost:6080
# then open http://localhost:6080/vnc.html
set -euo pipefail

# Display :2 and the 92xx/59xx/60xx+1 ports are a SECOND browser, distinct from
# the fleet Chrome on :99 / 9222. They must never collide: starting a console
# runs stop() first, and a shared CDP port makes that stop kill the fleet
# browser every sweep and action depend on — measured live, it left the API
# answering "Connection closed." until hive-chrome was restarted.
DISPLAY_NUM="${DISPLAY_NUM:-2}"
SCREEN="${SCREEN:-1280x800x24}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/onboard-chrome-profile}"
CDP_PORT="${CDP_PORT:-9223}"
# Egress for this session. Empty means the machine's default route, which is
# only correct for a brand-new account being assigned to this host's own IP.
PROXY="${PROXY:-}"
VNC_PORT="${VNC_PORT:-5901}"
WEB_PORT="${WEB_PORT:-6081}"

export DISPLAY=":${DISPLAY_NUM}"
mkdir -p "$PROFILE_DIR" /tmp/spike-console

stop() {
  pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
  pkill -f "x11vnc.*-rfbport ${VNC_PORT}" 2>/dev/null || true
  pkill -f "websockify.*${WEB_PORT}" 2>/dev/null || true
  pkill -f "openbox" 2>/dev/null || true
  pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true
}

case "${1:-start}" in
  stop) stop; echo "console stopped"; exit 0 ;;
  status)
    ss -tlnp 2>/dev/null | grep -E ":(${CDP_PORT}|${VNC_PORT}|${WEB_PORT})\b" || echo "nothing listening"
    exit 0 ;;
esac

stop; sleep 1

Xvfb ":${DISPLAY_NUM}" -screen 0 "$SCREEN" -nolisten tcp >/tmp/spike-console/xvfb.log 2>&1 &
for _ in $(seq 1 40); do xdpyinfo -display ":${DISPLAY_NUM}" >/dev/null 2>&1 && break; sleep 0.25; done

# A window manager is not optional: without one Chrome's top-level window never
# gets mapped properly and the VNC view shows a blank root.
openbox >/tmp/spike-console/openbox.log 2>&1 &
sleep 1

# Headful, not --headless. Headless leaves traces that are detectable exactly
# where it matters most — the login and challenge flow.
#
# --password-store=basic mirrors the production template. It makes Chrome
# encrypt the cookie jar with its built-in key rather than a machine keyring,
# which is the single reason profiles are portable between hosts at all.
${CHROME_BIN:-google-chrome} \
  --no-sandbox \
  --test-type \
  --user-data-dir="$PROFILE_DIR" \
  --password-store=basic \
  ${PROXY:+--proxy-server="$PROXY"} \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run --no-default-browser-check \
  --window-position=0,0 --window-size=1280,800 \
  --disable-dev-shm-usage \
  "https://www.linkedin.com/login" \
  >/tmp/spike-console/chrome.log 2>&1 &

# NOT a CDP wait: headful Chrome 151 never binds a debug port, so this browser
# has no CDP endpoint by design. The operator reaches it through VNC; give
# Chrome a moment to paint its first window instead.
sleep 3

x11vnc -display ":${DISPLAY_NUM}" -rfbport "${VNC_PORT}" -localhost \
  -forever -shared -nopw -noxdamage -quiet >/tmp/spike-console/x11vnc.log 2>&1 &
sleep 1

websockify --web /usr/share/novnc "127.0.0.1:${WEB_PORT}" "localhost:${VNC_PORT}" \
  >/tmp/spike-console/websockify.log 2>&1 &
sleep 1

echo "console up${PROXY:+ (egress via $PROXY)}"
true
ss -tln 2>/dev/null | grep -E ":(${CDP_PORT}|${VNC_PORT}|${WEB_PORT})\b" || true
