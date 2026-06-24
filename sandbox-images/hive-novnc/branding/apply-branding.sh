#!/bin/sh
# Apply OpenHive branding to the live XFCE session.
#
# Runs as a one-shot supervisord program after xfdesktop / xfce4-panel /
# xfwm4 come up. xfconf-query needs a live DBus session + X display, so
# none of this can run at image-build time — it has to fire at boot.
#
# Five surfaces are owned by this script:
#
#   1. Desktop wallpaper          xfconf -c xfce4-desktop
#   2. xfwm4 window decorations   xfconf -c xfwm4         (theme=Greybird-dark)
#   3. xfce4-panel chrome         xfconf -c xfce4-panel   (charcoal bg)
#   4. xsettings GTK theme        xfconf -c xsettings     (Greybird-dark)
#   5. Clock + users plugin       xfconf -c xfce4-panel   (single-line clock,
#                                                          hide users)
#
# Every block is idempotent (xfconf --create updates in place) and wrapped
# in `|| true` so one failure can't strand subsequent fixes — partial
# branding beats zero branding.

set -u

export DISPLAY="${DISPLAY:-:1}"

log() { printf '[hive-branding] %s\n' "$*"; }

for i in 1 2 3 4 5 6 7 8 9 10; do
  if xset q >/dev/null 2>&1; then break; fi
  sleep 1
done

# ── 1. Wallpaper ───────────────────────────────────────────────────────
WALLPAPER="/opt/hive-branding/wallpaper.png"
if [ -f "$WALLPAPER" ]; then
  for MONITOR in screen monitorscreen VGA1 VGA-1 monitor0 default; do
    for WS in 0 1 2 3; do
      xfconf-query -c xfce4-desktop \
        -p "/backdrop/screen0/monitor${MONITOR}/workspace${WS}/last-image" \
        --create --type string --set "$WALLPAPER" 2>/dev/null || true
      # image-style 5 = "Zoomed" — fill the screen, preserve aspect.
      # The wallpaper is generated at 1280x800 to match the Xvfb default,
      # so on the typical case Zoomed is a no-op (1:1 render). 0 means
      # "no image at all" — accidentally setting that here gave us
      # xfdesktop's default dark-teal backdrop, which is what the user
      # reported as "dark blue wallpaper" before this fix.
      xfconf-query -c xfce4-desktop \
        -p "/backdrop/screen0/monitor${MONITOR}/workspace${WS}/image-style" \
        --create --type int --set 5 2>/dev/null || true
    done
  done
  log "wallpaper set: $WALLPAPER"
fi

# ── 2. xfwm4 window decorations ────────────────────────────────────────
# Greybird-dark ships with the greybird-gtk-theme package; provides
# matching gtk-2, gtk-3, gtk-4, AND xfwm4 theme variants. Setting it for
# xfwm4 specifically retitles every dialog (the "Failed to execute
# default Web Browser" popup that was light grey on screenshot v1
# becomes charcoal with white close/min/max glyphs).
xfconf-query -c xfwm4 -p /general/theme --create --type string \
  --set "Greybird-dark" 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/title_font --create --type string \
  --set "Inter Tight Bold 9" 2>/dev/null || true
xfconf-query -c xfwm4 -p /general/button_layout --create --type string \
  --set "O|HMC" 2>/dev/null || true
log "xfwm4 theme: Greybird-dark"

# ── 3. xfce4-panel chrome ──────────────────────────────────────────────
# By default xfce4-panel uses the GTK theme's bg color (a light grey
# under stock GTK). Force an explicit solid-color background so both
# panels match the wallpaper's #0B0B0B / #111111 family, not whatever
# the GTK theme ends up resolving to.
#
# background-style 1 = solid color
# background-rgba is a 4-element double array {r, g, b, a}, 0..1 each.
# 0.067 ≈ #111111 (the brand --surface token).
for PANEL in panel-0 panel-1 panel-2 panel-3; do
  xfconf-query -c xfce4-panel -p "/panels/$PANEL/background-style" \
    --create --type int --set 1 2>/dev/null || true
  xfconf-query -c xfce4-panel -p "/panels/$PANEL/background-rgba" \
    --create --type double --set 0.067 \
    --type double --set 0.067 \
    --type double --set 0.067 \
    --type double --set 0.94 2>/dev/null || true
done
log "xfce4-panel background: #111111 @ 94% opacity"

# ── 3a. Panel launcher icon names ──────────────────────────────────────
# XFCE 4.18 ships stock dock launchers (Terminal, FileManager, WebBrowser)
# with these stand-in icon names baked into their .desktop files:
#
#   Icon=org.xfce.terminalemulator     (Terminal)
#   Icon=org.xfce.filemanager          (FileManager)
#   Icon=org.xfce.webbrowser           (WebBrowser)
#
# These are meant to be themed by each icon theme to whatever app the
# user picked as their preferred default for that category. The catch:
# Papirus / Papirus-Dark DOES NOT SHIP these names yet — they're new in
# 4.18 and Papirus's coverage hasn't caught up. xfce4-panel's
# gtk_image_set_from_icon_name() falls through inheritance:
#   Papirus-Dark → Papirus → Adwaita → hicolor
# and lands on Adwaita's bright-blue versions, which is what the user
# kept seeing on the dock (Chrome blue, Adwaita-blue file cabinet,
# Adwaita-blue globe) regardless of how many times we set xsettings to
# Papirus-Dark.
#
# Rewrite each launcher .desktop's Icon= to a name Papirus DOES ship.
# Launcher copies live under /root/.config/xfce4/panel/launcher-<N>/.
# Belt + braces: also patch /etc/xdg/xfce4/panel/launcher-*/ in case a
# fresh profile gets seeded on next boot from the system template.
# Sources for the bug + fix: gitlab.xfce.org/xfce/xfce4-panel/-/blob/
# master/plugins/launcher/launcher.c, gitlab.xfce.org papirus-icon-theme
# issues #1189 #3156.
for DIR in /root/.config/xfce4/panel /etc/xdg/xfce4/panel; do
  [ -d "$DIR" ] || continue
  for D in "$DIR"/launcher-*/*.desktop; do
    [ -f "$D" ] || continue
    # Use the -symbolic variants because Papirus-Dark only ships flat
    # dark glyphs in /symbolic/, NOT in /apps/. The non-symbolic
    # `web-browser` etc. fall through to Papirus's colorful /apps/
    # versions (because Papirus-Dark inherits from Papirus). Symbolic
    # icons auto-tint to the panel's FG color (light glyph on charcoal
    # panel) which is the actual flat-dark look the user is after.
    sed -i -e 's|^Icon=org\.xfce\.terminalemulator$|Icon=utilities-terminal-symbolic|' \
           -e 's|^Icon=org\.xfce\.filemanager$|Icon=system-file-manager-symbolic|' \
           -e 's|^Icon=org\.xfce\.webbrowser$|Icon=web-browser-symbolic|' "$D" || true
    # Also catch the case where a previous boot already converted to
    # the non-symbolic Papirus name — promote to symbolic.
    sed -i -e 's|^Icon=utilities-terminal$|Icon=utilities-terminal-symbolic|' \
           -e 's|^Icon=system-file-manager$|Icon=system-file-manager-symbolic|' \
           -e 's|^Icon=web-browser$|Icon=web-browser-symbolic|' "$D" || true
  done
done
log "panel launcher Icon= names rewritten to Papirus-shipped equivalents"

# Rewrite the WebBrowser launcher's Exec line to call google-chrome
# DIRECTLY with the same flags supervisord uses to start the persistent
# Chrome window. --user-data-dir=/data/chrome is the critical bit: when
# the user clicks the dock browser, Chrome's singleton-lock detects an
# existing process holding the same profile and routes the URL there
# (opens in the existing window/tab strip) instead of spawning a second
# isolated profile. Without this, the dock launches a SEPARATE Chrome
# instance with a fresh /root/.config/google-chrome/ profile — which is
# what the user reported as "not opening the same browser as the hive
# bootstrapped profile". --no-sandbox is required because the session
# runs as root and Chrome would otherwise exit 1 (the EIO dialog).
# Exec sed only fires when the line matches the stock exo-open pattern;
# safe to re-run.
for DIR in /root/.config/xfce4/panel /etc/xdg/xfce4/panel; do
  for D in "$DIR"/launcher-*/*.desktop; do
    [ -f "$D" ] || continue
    sed -i 's|^Exec=exo-open --launch WebBrowser.*$|Exec=google-chrome-stable --no-sandbox --test-type --user-data-dir=/data/chrome %U|' "$D" || true
  done
done
log "WebBrowser launcher Exec rewritten to chrome --no-sandbox --user-data-dir=/data/chrome"

# Assert helpers.rc — xfce4-mime-helper auto-populates it on first run
# with WebBrowser=google-chrome (the stock helper that doesn't pass
# --no-sandbox and hence makes Chrome exit 1 under root). Force-overwrite
# every boot so our /usr/share/xfce4/helpers/hive-chrome.desktop helper
# is the WebBrowser for any other tool that calls exo-open --launch
# WebBrowser (xdg-open routes, the Settings → Default Applications
# "Test" buttons, third-party tools that use libexo, etc.).
mkdir -p /root/.config/xfce4
printf 'WebBrowser=hive-chrome\nTerminalEmulator=xfce4-terminal\nFileManager=Thunar\n' \
  > /root/.config/xfce4/helpers.rc
log "/root/.config/xfce4/helpers.rc asserted: WebBrowser=hive-chrome"

# NB: tried pruning plugin-15 (showdesktop) and plugin-20 (empty
# launcher) from panel-1's plugin-ids to clean up the off-brand blue
# squares — that broke the dock entirely (all four launchers re-rendered
# as default empty-launcher gears). Leaving the original 8-item layout
# in place. To revisit cleanly: would need to delete the per-launcher
# .desktop dirs AND the /plugins/plugin-N xfconf nodes in a coordinated
# way, not just edit the panel-1 plugin-ids array.

# Force xsettings re-broadcast so xfce4-panel's gtk_icon_theme "changed"
# signal fires and the launchers re-resolve their icons against
# Papirus-Dark. set-to-other-then-back guarantees the broadcast even if
# the value matches. xfsettingsd watches the channel and re-emits.
xfconf-query -c xsettings -p /Net/IconThemeName --create --type string \
  --set "Adwaita" 2>/dev/null || true
sleep 1
xfconf-query -c xsettings -p /Net/IconThemeName --create --type string \
  --set "Hive-Overrides" 2>/dev/null || true

# ── 3b. xfce4-mime-helper preferred-applications ───────────────────────
# Modern XFCE (>=4.16) stores helper preferences in xfconf, not just in
# ~/.config/xfce4/helpers.rc. exo-open's lookup checks xfconf FIRST,
# then falls back to helpers.rc. Without this xfconf write, exo-open
# --launch WebBrowser would still find no helper and error with
# "Failed to execute default Web Browser. Input/output error." even
# though helpers.rc was set at image-build time. Setting it here closes
# that path.
# NB: per agent research, the xfconf channels xfce4-session and
# xfce-mime-helper are largely no-ops in XFCE 4.18; helpers.rc + the
# helper .desktop file are what xfce4-mime-helper actually reads. We
# still write these defensively (harmless) but the real path is the
# /usr/share/xfce4/helpers/hive-chrome.desktop + helpers.rc baked at
# image-build time.
xfconf-query -c xfce4-session -p /general/PreferredApplications/WebBrowser \
  --create --type string --set "hive-chrome" 2>/dev/null || true
xfconf-query -c xfce-mime-helper -p /preferred-applications/WebBrowser \
  --create --type string --set "hive-chrome" 2>/dev/null || true
log "xfce4 PreferredApplications/WebBrowser → hive-chrome (Chrome --no-sandbox)"

# ── 4. xsettings (GTK theme for apps) ──────────────────────────────────
# Already set via /root/.config/gtk-3.0/settings.ini at image-build time
# but xsettings is what xfsettingsd actually reads at runtime — duplicate
# here so the live session matches the on-disk file from minute one.
xfconf-query -c xsettings -p /Net/ThemeName --create --type string \
  --set "Greybird-dark" 2>/dev/null || true
xfconf-query -c xsettings -p /Net/IconThemeName --create --type string \
  --set "Hive-Overrides" 2>/dev/null || true
xfconf-query -c xsettings -p /Gtk/FontName --create --type string \
  --set "Inter 10" 2>/dev/null || true
xfconf-query -c xsettings -p /Gtk/MonospaceFontName --create --type string \
  --set "JetBrains Mono 10" 2>/dev/null || true
xfconf-query -c xsettings -p /Gtk/ApplicationPreferDarkTheme \
  --create --type bool --set true 2>/dev/null || true
log "xsettings GTK theme: Greybird-dark / Adwaita icons"

# ── 5. Clock format + hide users-plugin ────────────────────────────────
# xfce4-panel stores plugin instances as numbered children of /plugins/.
# Walk them to find clock + users (their type names are stable across
# panel versions), then mutate the clock's format and remove the users
# plugin from its panel's plugin-ids list.
clock_format_fixed=0
users_hidden=0
plugins_root="/plugins"
for n in $(seq 1 30); do
  pid="plugin-$n"
  ptype=$(xfconf-query -c xfce4-panel -p "$plugins_root/$pid" 2>/dev/null || true)
  case "$ptype" in
    clock)
      # Mode 2 = "Custom format". Format string: tight, single line,
      # day-of-week + date + time. Mirrors the JetBrains-Mono tone of
      # the wallpaper's section markers.
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/mode" \
        --create --type int --set 2 2>/dev/null || true
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/digital-format" \
        --create --type string --set " %a  %b %-d   %H:%M " 2>/dev/null || true
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/digital-time-format" \
        --create --type string --set " %a  %b %-d   %H:%M " 2>/dev/null || true
      clock_format_fixed=1
      ;;
    actions)
      # The "root" badge in the top-right is the actions plugin (NOT
      # users — that name doesn't exist on Debian XFCE). Its UI shows
      # the username + a power dropdown. Neither is useful in a cloud
      # sandbox: the username is always "root" and the user can't
      # actually power-cycle the VM from inside. Hide both:
      #
      #   appearance 0 = "Action buttons" (icons only, no username)
      #     but we also want to remove the icons — easier path:
      #   visible-buttons 0 = no items shown at all
      #
      # The plugin frame remains in the layout (removing it from the
      # plugin-ids array is fragile across versions) but renders empty.
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/appearance" \
        --create --type int --set 0 2>/dev/null || true
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/items" \
        --create --type string --set "+separator" 2>/dev/null || true
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/show-username" \
        --create --type bool --set false 2>/dev/null || true
      users_hidden=1
      ;;
  esac
done
log "clock-format-fixed=$clock_format_fixed actions-hidden=$users_hidden"

# ── 6. Restart xfdesktop + xfce4-panel hard ────────────────────────────
# `xfdesktop --reload` re-reads xfconf and redraws the backdrop, but it
# does NOT re-poll the active GTK icon theme — once xfdesktop has booted
# with theme X, switching xsettings to theme Y is invisible to the
# already-decided icon cache. The user reported "home icon unchanged"
# after we set xsettings to Papirus-Dark; this was the cause.
#
# Killing xfdesktop forces supervisord to respawn it (autorestart=true),
# at which point it re-reads xsettings and picks up Papirus-Dark
# everywhere. Same dance for xfce4-panel because plugin appearance
# changes (actions/users layout, clock format) don't always live-update.
log "restarting xfdesktop + xfce4-panel to pick up theme + plugin changes"
pkill -TERM xfdesktop >/dev/null 2>&1 || true
pkill -TERM xfce4-panel >/dev/null 2>&1 || true
# supervisord respawn lag is sub-second; the user sees a 1-frame flicker.

log "branding applied"
