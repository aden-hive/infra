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
COPY start-chrome.sh /usr/local/bin/start-chrome.sh
RUN chmod +x /usr/local/bin/start-chrome.sh

COPY hive-src /opt/hive
WORKDIR /opt/hive
RUN /usr/local/bin/uv sync --no-dev 2>&1 | tail -10

# Pre-seed /root/.hive/configuration.json so `hive serve` doesn't demand quickstart.
# The API key (KIMI_API_KEY) is NOT baked here; pass via docker run -e.
RUN mkdir -p /root/.hive
COPY hive-configuration.json /root/.hive/configuration.json

EXPOSE 4001 6080 8787 9229 9230

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
