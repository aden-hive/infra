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
      gnome-themes-extra greybird-gtk-theme librsvg2-bin \
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

# Prune the stock /etc/xdg/xfce4/panel/default.xml panel layout BEFORE
# any session boots. The default ships:
#   panel-1 (top bar):  plugin-ids = 1..14
#     plugin-14 = actions  ← renders a "root" username + power dropdown
#                            badge in the top-right. Useless in a cloud
#                            sandbox (can't power-cycle the VM from
#                            inside, and the username is always "root").
#   panel-2 (bottom dock): plugin-ids = 15..22
#     plugin-15 = showdesktop  ← blue filled rectangle, no useful
#                                action in a cloud workstation.
#     plugin-20 = launcher with items[] = empty array ← shows as a
#                                blue gear placeholder, clicking does
#                                nothing.
#
# Deleting the value lines from the plugin-ids arrays leaves the
# remaining plugins in place. Each numeric value appears in exactly one
# plugin-ids context (1-14 only in panel-1's, 15-22 only in panel-2's),
# so the sed delete-by-exact-value-text is safe scoping. The per-plugin
# definitions under <property name="plugins"> stay in the xml as dead
# config; xfce4-panel just doesn't render them because they're not in
# any panel's plugin-ids array.
#
# Previous attempt: edit the runtime xfconf channel via xfconf-query at
# session-time. That scrambled the panel state catastrophically when
# panel restart raced the xfconfd persistence layer. Editing the xdg
# template at build time avoids the race entirely.
RUN sed -i '\|<value type="int" value="14"/>|d; \
            \|<value type="int" value="15"/>|d; \
            \|<value type="int" value="20"/>|d' \
        /etc/xdg/xfce4/panel/default.xml

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
    # Old approach: ln -sfn /root/.hive /root/Desktop/Hive — that gave
    # a generic blue Adwaita folder-link icon on the desktop. Even with
    # Papirus-Dark as the active xsettings IconThemeName, xfdesktop's
    # symlink rendering fell through to a stock blue tinted glyph that
    # competed with the brand. Replacing the symlink with a proper
    # .desktop entry lets us pin the icon to our own hex-cluster SVG
    # (Icon=/opt/hive-branding/hive-mark.svg), so the desktop's single
    # remaining icon IS the OpenHive brand mark — clean, on-brand,
    # no theme-fallback risk.
    && printf '%s\n' \
         '[Desktop Entry]' \
         'Version=1.0' \
         'Type=Application' \
         'Name=Hive' \
         'GenericName=OpenHive workspace' \
         'Comment=Open the OpenHive workspace folder (queens, colonies, sessions, secrets)' \
         'Exec=xdg-open /root/.hive' \
         # Use named icon (looked up in the icon-theme), not an absolute
         # path. xfdesktop's pixbuf loader had trouble with the absolute
         # path version (showed a generic document fallback). The
         # openhive-mark.svg gets installed under
         # /usr/share/icons/hicolor/scalable/apps/ below — hicolor is
         # inherited by every theme so the lookup always resolves.
         'Icon=openhive-mark' \
         'Terminal=false' \
         'Categories=Utility;' \
         > /root/Desktop/Hive.desktop \
    && chmod +x /root/Desktop/Hive.desktop
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
    # Install the OpenHive hex-cluster mark into hicolor as
    # `openhive-mark` so anywhere an Icon= references it (the desktop
    # Hive.desktop, future panel launchers, etc) can resolve via the
    # standard icon-theme lookup chain. hicolor is the universal base
    # theme inherited by Papirus, Adwaita, and all the others, so the
    # icon shows up regardless of the active theme.
    # Install our own icon theme `Hive-Overrides` that inherits
    # Papirus-Dark. The previous approach (writing overrides into
    # Papirus-Dark's own size dirs) failed because Papirus-Dark's
    # 48x48/64x64/128x128 directories are SYMLINKS into Papirus, AND
    # the leaf files (user-home.svg) within Papirus are themselves
    # symlinks to user-blue-home.svg. Every `cp` we tried — even with
    # `rm -f` first — was touching the wrong indirection level, so
    # xfdesktop kept rendering Papirus's blue folder.
    #
    # By creating a sibling theme that inherits Papirus-Dark, we own
    # the directory hierarchy completely (no symlinks), and GTK's
    # icon-theme lookup chain becomes:
    #   Hive-Overrides → Papirus-Dark → (breeze-dark missing) →
    #   Adwaita → gnome → hicolor
    # so anything NOT in Hive-Overrides cascades through Papirus-Dark
    # unchanged, but the three icons we override (user-home for Home,
    # drive-harddisk for File System, openhive-mark for the Hive
    # desktop entry) get our brand glyphs.
    #
    # Sources: xfdesktop's special-file-icon.c hardcodes "drive-harddisk"
    # for filesystem and falls through to g_file_info_get_icon for home
    # (which returns "user-home"). GTK3 always appends Adwaita/gnome/
    # hicolor to every Inherits chain (gtkicontheme.c:load_themes), so
    # missing Inherits targets (breeze-dark) skip silently — confirmed
    # via xfce4-icon-theme audit by general-purpose agent.
    && cp -r /opt/hive-branding/hive-icons-theme /usr/share/icons/Hive-Overrides \
    # Rasterize the SVGs to fixed-size PNGs at every directory size the
    # index.theme declares (16/22/24/32/48/64/128/256). xfdesktop's
    # desktop-icon lookup REJECTS Type=Scalable entries and only matches
    # Type=Fixed PNG rasters — this was definitively proven via strace
    # of the live xfdesktop process: the lookup walked past
    # Hive-Overrides (despite the theme being discovered and the cache
    # containing user-home) and fell through to Adwaita's
    # /usr/share/icons/Adwaita/48x48/places/user-home.png as the final
    # hit. The previous Hive-Overrides-with-scalable-only attempt
    # failed for exactly this reason. Keeping the SVGs around in
    # scalable/ for apps (e.g. Thunar's file list) that DO accept them.
    && for entry in places/user-home devices/drive-harddisk apps/openhive-mark ; do \
         ctx="${entry%/*}" ; name="${entry##*/}" ; \
         src="/usr/share/icons/Hive-Overrides/scalable/${ctx}/${name}.svg" ; \
         for sz in 16 22 24 32 48 64 128 256 ; do \
           dst_dir="/usr/share/icons/Hive-Overrides/${sz}x${sz}/${ctx}" ; \
           mkdir -p "$dst_dir" ; \
           rsvg-convert -w "$sz" -h "$sz" -o "$dst_dir/${name}.png" "$src" ; \
         done ; \
       done \
    && gtk-update-icon-cache -f /usr/share/icons/Hive-Overrides 2>/dev/null || true \
    && gtk-update-icon-cache -f /usr/share/icons/hicolor 2>/dev/null || true \
    # Seed system-wide xsettings xfconf channel — xfconfd reads this on
    # first session and copies into ~/.config/xfce4/xfconf/... so even
    # if apply-branding.sh hasn't fired yet, the icon theme is correct
    # from xfdesktop's first paint. Belt + braces with the script-time
    # xfconf-query in apply-branding.sh.
    && mkdir -p /etc/xdg/xfce4/xfconf/xfce-perchannel-xml \
    && printf '%s\n' \
         '<?xml version="1.0" encoding="UTF-8"?>' \
         '<channel name="xsettings" version="1.0">' \
         '  <property name="Net" type="empty">' \
         '    <property name="IconThemeName" type="string" value="Hive-Overrides"/>' \
         '    <property name="ThemeName" type="string" value="Greybird-dark"/>' \
         '  </property>' \
         '</channel>' \
         > /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml \
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
    # Theme keys: use_system_theme=true makes Chrome inherit GTK
    # Greybird-dark for the tab bar / address bar / browser frame
    # (without this Chrome ships with its own light theme regardless of
    # the system GTK setting). browser.theme.system_theme=1 is the
    # equivalent profile-level setting Chrome stores once a user picks
    # "Use System Theme" in chrome://settings/appearance — pre-seeding
    # it via master_preferences saves the user from having to set it
    # manually on every fresh profile.
    && printf '%s\n' \
         '{"homepage": "http://127.0.0.1:9998/newtab.html",' \
         ' "homepage_is_newtabpage": false,' \
         ' "browser": {"show_home_button": true, "check_default_browser": false,' \
         '             "theme": {"system_theme": 1}},' \
         ' "extensions": {"theme": {"use_system_theme": true}},' \
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
    # Custom WebBrowser helper. We can't use the stock google-chrome
    # helper because xfce4-mime-helper runs the binary without
    # --no-sandbox, which makes Chrome refuse to start under root and
    # exit 1. The "Failed to execute default Web Browser. Input/output
    # error." dialog the user kept seeing is glib's g_strerror(EIO)
    # for that non-zero child exit — NOT a missing helper. Wrap chrome
    # with the flag baked into X-XFCE-Commands so every consumer of
    # exo-open --launch WebBrowser hits the working path.
    && mkdir -p /usr/share/xfce4/helpers \
    && printf '%s\n' \
         '[Desktop Entry]' \
         'Version=1.0' \
         'Encoding=UTF-8' \
         'Type=X-XFCE-Helper' \
         'NoDisplay=true' \
         'Name=Hive Chrome' \
         'Icon=google-chrome' \
         'X-XFCE-Category=WebBrowser' \
         'X-XFCE-Binaries=google-chrome-stable;google-chrome;' \
         'X-XFCE-Commands=%B --no-sandbox --test-type --user-data-dir=/data/chrome;' \
         'X-XFCE-CommandsWithParameter=%B --no-sandbox --test-type --user-data-dir=/data/chrome "%s";' \
         'StartupNotify=true' \
         > /usr/share/xfce4/helpers/hive-chrome.desktop \
    && mkdir -p /root/.config/xfce4 \
    && printf '%s\n' \
         'WebBrowser=hive-chrome' \
         'TerminalEmulator=xfce4-terminal' \
         'FileManager=Thunar' \
         > /root/.config/xfce4/helpers.rc \
    && mkdir -p /etc/xdg/xfce4 \
    && cp /root/.config/xfce4/helpers.rc /etc/xdg/xfce4/helpers.rc \
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
    && printf '[Settings]\ngtk-theme-name=Greybird-dark\ngtk-icon-theme-name=Hive-Overrides\ngtk-font-name=Inter 10\ngtk-application-prefer-dark-theme=1\n' \
         > /root/.config/gtk-3.0/settings.ini \
    && printf '[Net]\nThemeName=Greybird-dark\nIconThemeName=Hive-Overrides\n' \
         > /root/.gtkrc-2.0

EXPOSE 4001 6080 8787 9229 9230

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
