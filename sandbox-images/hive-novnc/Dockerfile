FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg \
      xvfb x11-utils \
      x11vnc novnc websockify \
      supervisor \
      fonts-liberation fonts-noto-color-emoji \
      dbus-x11 procps openssl \
      python3.11 python3.11-venv python3-pip \
      build-essential libpq-dev \
      systemd systemd-sysv openssh-server sudo chrony socat \
      fuse3 iptables git nfs-common \
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

COPY hive-extension /opt/hive-extension
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
# `--frozen` uses the exact lockfile resolution, so the build-time venv
# matches what runtime would otherwise resolve. Without this, `uv run`
# re-syncs at first call (Uninstalled X / Installed Y) and delays hive
# serve startup past the orchestrator's 20s snapshot deadline.
RUN /usr/local/bin/uv sync --frozen 2>&1 | tail -10
# Smoke-test the venv's hive script imports cleanly so failures surface
# at build time, not at first VM boot.
RUN /opt/hive/.venv/bin/hive --help >/dev/null

# Pre-seed /root/.hive/configuration.json so `hive serve` doesn't demand quickstart.
# The API key (KIMI_API_KEY) is NOT baked here; pass via docker run -e.
RUN mkdir -p /root/.hive
COPY hive-configuration.json /root/.hive/configuration.json

EXPOSE 4001 6080 8787 9229 9230

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
