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
      tango-icon-theme adwaita-icon-theme papirus-icon-theme \
      gnome-themes-extra greybird-gtk-theme \
      fonts-inter fonts-jetbrains-mono fonts-firacode \
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

# ───────────────────────────── OpenHive branding ─────────────────────────────
#
# Drop the brand kit under /opt/hive-branding so every consumer (Chrome
# new-tab, noVNC overlay CSS, xfdesktop wallpaper, the apply-wallpaper.sh
# autostart script) reads from one canonical location. Keeping assets in a
# /opt subdir rather than scattered across /usr/share means a future
# rebrand or theme variant lives in a single rsync away.
#
# Three surfaces get themed at build time:
#
#   1. xfdesktop wallpaper. The actual xfconf write happens at boot (see
#      supervisord.conf [program:hive-branding]) because xfconf-query needs
#      a live DBus session — can't be set in the image.
#
#   2. noVNC chrome. Stock /usr/share/novnc/vnc.html gets a <link> tag
#      injected via sed so our hive-branding/novnc-overlay.css loads AFTER
#      base.css, winning on equal specificity. The overlay only sets CSS
#      custom-properties + recolors known noVNC class names — we never
#      edit base.css in place (it'd get clobbered on novnc package upgrade).
#
#   3. Chrome new-tab. /etc/opt/chrome/policies/managed/ is read by Chrome
#      at startup; the hive-newtab.json policy file there pins
#      HomepageLocation + NewTabPageLocation at our local landing page.
#      No extension, no Chrome-Web-Store dependency.
COPY branding /opt/hive-branding
RUN chmod +x /opt/hive-branding/apply-branding.sh \
    && mkdir -p /usr/share/novnc/hive-branding \
    # Serve the noVNC overlay CSS and the hive-mark SVG over websockify
    # (port 6080) at the same origin as vnc.html. The CSS references
    # hive-mark.svg via a relative URL, so both must be in the same dir.
    && cp /opt/hive-branding/novnc-overlay.css /opt/hive-branding/hive-mark.svg \
          /usr/share/novnc/hive-branding/ \
    # Inject the overlay <link> tag right before </head> in vnc.html so
    # it loads after base.css and wins on equal specificity. We never
    # edit base.css in place because it's apt-managed. The sed is gated
    # on the marker being absent so a rebuild doesn't double-inject.
    && if ! grep -q "hive-branding/novnc-overlay.css" /usr/share/novnc/vnc.html; then \
         sed -i 's|</head>|<link rel="stylesheet" href="hive-branding/novnc-overlay.css" />\n</head>|' /usr/share/novnc/vnc.html; \
       fi \
    # Chrome enterprise policy. NewTabPageLocation overrides Ctrl+T.
    # Served over http://127.0.0.1:9998/ (see [program:branding-http]
    # in supervisord.conf) rather than file:///opt/... because the
    # hive-browser-bridge extension's <all_urls> permission covers
    # http://localhost natively, while file:// would force Chrome to
    # prompt the user for "Allow access to file URLs" on every install
    # — a permission the bridge extension can't request itself.
    && mkdir -p /etc/opt/chrome/policies/managed \
    && cp /opt/hive-branding/hive-newtab.json /etc/opt/chrome/policies/managed/ \
    # Master preferences file for Chrome — picked up on first profile
    # creation and seeds the homepage + new-tab. Belt + braces with the
    # policy file above. Same http://127.0.0.1:9998/ URL for the same
    # extension-permission reason.
    && mkdir -p /etc/opt/chrome \
    && printf '%s\n' \
         '{"homepage": "http://127.0.0.1:9998/newtab.html",' \
         ' "homepage_is_newtabpage": false,' \
         ' "browser": {"show_home_button": true, "check_default_browser": false},' \
         ' "session": {"restore_on_startup": 4,' \
         '             "startup_urls": ["http://127.0.0.1:9998/newtab.html"]}}' \
         > /etc/opt/chrome/master_preferences \
    # Default browser chain: three layers so every "open in browser"
    # path resolves to google-chrome regardless of which mechanism the
    # caller uses.
    #   1. update-alternatives → x-www-browser / gnome-www-browser
    #      (called by xdg-open's legacy fallback and by xterm's
    #      built-in URL handler)
    #   2. xfce4 helpers.rc → WebBrowser=google-chrome
    #      (called by exo-open --launch WebBrowser, which is what the
    #      XFCE panel's "Web Browser" launcher uses — that's the dock
    #      globe icon the user clicked that errored)
    #   3. xdg-mime defaults → text/html + x-scheme-handler/http +
    #      x-scheme-handler/https → google-chrome.desktop
    #      (called by xdg-open, which is what most non-XFCE apps use)
    && update-alternatives --install /usr/bin/x-www-browser x-www-browser \
         /usr/bin/google-chrome-stable 200 \
    && update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser \
         /usr/bin/google-chrome-stable 200 \
    && mkdir -p /root/.config/xfce4 \
    && printf '%s\n' \
         'WebBrowser=google-chrome' \
         'TerminalEmulator=xfce4-terminal' \
         'FileManager=Thunar' \
         > /root/.config/xfce4/helpers.rc \
    && mkdir -p /root/.config \
    && printf '%s\n' \
         '[Default Applications]' \
         'text/html=google-chrome.desktop' \
         'x-scheme-handler/http=google-chrome.desktop' \
         'x-scheme-handler/https=google-chrome.desktop' \
         'x-scheme-handler/about=google-chrome.desktop' \
         'x-scheme-handler/unknown=google-chrome.desktop' \
         > /root/.config/mimeapps.list \
    && cp /root/.config/mimeapps.list /etc/xdg/mimeapps.list 2>/dev/null || true \
    # GTK + xfwm + icon defaults for the root user (HOME=/root inside
    # the VM per supervisord.conf). Greybird is the canonical dark XFCE
    # theme that ships with the greybird-gtk-theme package; pair with
    # Adwaita icons for clean monochrome glyphs (the stock Tango set was
    # the source of the bright-blue "Home" / "Hive" folder icons the
    # user flagged as off-brand).
    && mkdir -p /root/.config/gtk-3.0 /root/.config/xfce4/xfconf/xfce-perchannel-xml \
    && printf '[Settings]\ngtk-theme-name=Greybird-dark\ngtk-icon-theme-name=Papirus-Dark\ngtk-font-name=Inter 10\ngtk-application-prefer-dark-theme=1\n' \
         > /root/.config/gtk-3.0/settings.ini \
    && printf '[Net]\nThemeName=Greybird-dark\nIconThemeName=Papirus-Dark\n' \
         > /root/.gtkrc-2.0

EXPOSE 4001 6080 8787 9229 9230

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
