FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Per-user LLM auth: no provider key baked in. The desktop pushes a
# per-user JWT (the "stream token") into the VM via PUT /api/config/llm
# right after spawn — see configureRemoteLlm in hive-desktop's
# remote-runtime.ts. Hive serve in the VM stores it in its credential
# store and authenticates outbound calls to the hive-llm proxy as the
# signed-in user. No shared baked-in KIMI_API_KEY anymore.

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg \
      xvfb x11-utils \
      x11vnc novnc websockify \
      supervisor \
      fonts-liberation fonts-noto-color-emoji fonts-dejavu \
      dbus-x11 procps openssl \
      python3.11 python3.11-venv python3-pip \
      build-essential libpq-dev \
      systemd systemd-sysv openssh-server sudo chrony socat \
      fuse3 iptables git nfs-common \
      xfwm4 xfce4-panel xfce4-terminal xfdesktop4 thunar xfce4-settings \
      tango-icon-theme adwaita-icon-theme \
      mousepad nano vim-tiny xdg-utils \
      zstd \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/apt/keyrings \
    && wget -q -O /etc/apt/keyrings/google-chrome.asc https://dl.google.com/linux/linux_signing_key.pub \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.asc] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && /usr/local/bin/uv --version

RUN useradd -m -u 1001 -s /bin/bash hive \
    && mkdir -p /data/chrome /var/log/supervisor \
    && chown -R hive:hive /home/hive /data

# Source the Chrome extension from the auto-synced runtime tree
# (sync-hive-src.sh mirrors hive-desktop-runtime/tools/browser-extension/
# into hive-src/tools/browser-extension/ on every roll). The previous
# standalone hive-extension/ dir was hand-maintained and drifted two
# versions behind the runtime — the bundled VM kept shipping v1.0.0
# while the runtime had moved to v1.2.3 (sidepanel-based UI, icons).
COPY hive-src/tools/browser-extension /opt/hive-extension
COPY pack-and-policy.sh /usr/local/bin/pack-and-policy.sh
RUN chmod +x /usr/local/bin/pack-and-policy.sh && /usr/local/bin/pack-and-policy.sh

COPY supervisord.conf /etc/supervisor/conf.d/sandbox.conf

# Make the base supervisor install E2B-template-builder friendly.
# envd runs the sandbox start-cmd as a constrained user that can't write to
# /var/log, /var/run, or even /dev/stdout; moving everything into /tmp and
# dropping user= directives lets supervisord start as whoever envd invokes it as.
RUN sed -i \
      -e 's|/var/run/supervisor.sock|/tmp/supervisor.sock|g' \
      -e 's|/var/run/supervisord.pid|/tmp/supervisord.pid|' \
      -e 's|logfile=/var/log/supervisor/supervisord.log.*|logfile=NONE|' \
      -e 's|childlogdir=/var/log/supervisor.*|childlogdir=/tmp|' \
      /etc/supervisor/supervisord.conf
COPY start-chrome.sh /usr/local/bin/start-chrome.sh
RUN chmod +x /usr/local/bin/start-chrome.sh

COPY hive-src /opt/hive
WORKDIR /opt/hive

# Per-user persistent-volume data plane. Two scripts that marshal
# /root/.hive (= HIVE_HOME) to/from a signed S3 URL. The orchestrator
# (or, for this RC, a manual envd Process.Start) invokes these on
# Start/Stop so user state survives template upgrades.
#
# RC scope: just the in-VM data plane — no orchestrator/api/hive-backend
# integration yet. Test by signing a URL with `mc share` on MinIO and
# calling the script directly via envd.
COPY hive-userdata-snapshot.sh /usr/local/bin/hive-userdata-snapshot.sh
COPY hive-userdata-restore.sh  /usr/local/bin/hive-userdata-restore.sh
RUN chmod +x /usr/local/bin/hive-userdata-snapshot.sh \
             /usr/local/bin/hive-userdata-restore.sh

# `--frozen` uses the exact lockfile resolution, so the build-time venv
# matches what runtime would otherwise resolve. Without this, `uv run`
# re-syncs at first call (Uninstalled X / Installed Y) and delays hive
# serve startup past the orchestrator's 20s snapshot deadline.
RUN /usr/local/bin/uv sync --frozen 2>&1 | tail -10
# Smoke-test the venv's hive script imports cleanly so failures surface
# at build time, not at first VM boot.
RUN /opt/hive/.venv/bin/hive --help >/dev/null

# Pre-seed /root/.hive/configuration.json so `hive serve` doesn't demand
# quickstart, and surface HIVE_HOME on the noVNC desktop as `Hive` so
# users can browse queens/colonies/memories/sessions/secrets without
# digging through a terminal. xfdesktop runs with HOME=/root (see
# supervisord.conf), so the shortcut lives under /root/Desktop.
# Earlier versions pointed this at /opt/hive (source code) — not useful.
# The API key (KIMI_API_KEY) is NOT baked here; pass via docker run -e.
RUN mkdir -p /root/.hive /root/Desktop \
    && ln -sfn /root/.hive /root/Desktop/Hive
COPY hive-configuration.json /root/.hive/configuration.json

EXPOSE 4001 6080 8787 9229 9230

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
