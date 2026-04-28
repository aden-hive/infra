#!/bin/bash
set -eu

for i in $(seq 1 50); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

exec google-chrome-stable \
  --no-sandbox \
  --test-type \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=TranslateUI,AutomationControlled \
  --disable-popup-blocking \
  --disable-dev-shm-usage \
  --password-store=basic \
  --user-data-dir=/data/chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --window-size=1100,720 \
  --window-position=80,40 \
  https://www.google.com
