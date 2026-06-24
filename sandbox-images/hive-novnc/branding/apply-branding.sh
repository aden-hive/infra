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
      # image-style 0 = "None / centered" — keeps the 1280x800 wallpaper
      # exact-pixel on the 1280x800 Xvfb (no scaling artifacts on the
      # hairline + tight monospace text in the new flat composition).
      xfconf-query -c xfce4-desktop \
        -p "/backdrop/screen0/monitor${MONITOR}/workspace${WS}/image-style" \
        --create --type int --set 0 2>/dev/null || true
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

# ── 4. xsettings (GTK theme for apps) ──────────────────────────────────
# Already set via /root/.config/gtk-3.0/settings.ini at image-build time
# but xsettings is what xfsettingsd actually reads at runtime — duplicate
# here so the live session matches the on-disk file from minute one.
xfconf-query -c xsettings -p /Net/ThemeName --create --type string \
  --set "Greybird-dark" 2>/dev/null || true
xfconf-query -c xsettings -p /Net/IconThemeName --create --type string \
  --set "Papirus-Dark" 2>/dev/null || true
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
    users)
      # Hide the "root" badge by collapsing the plugin label. Removing
      # the plugin entirely needs a plugin-ids array rewrite that varies
      # per panel layout, which is fragile; collapsing is the safe minimum.
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/show-name" \
        --create --type bool --set false 2>/dev/null || true
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/button-style" \
        --create --type int --set 3 2>/dev/null || true
      users_hidden=1
      ;;
    actionbuttons|action-buttons)
      # Same family: the "log out / shutdown" cluster. Not useful in a
      # cloud sandbox (the user can't actually power-cycle the VM from
      # inside). Hide its label.
      xfconf-query -c xfce4-panel -p "$plugins_root/$pid/button-title" \
        --create --type int --set 0 2>/dev/null || true
      ;;
  esac
done
log "clock-format-fixed=$clock_format_fixed users-hidden=$users_hidden"

# ── 6. Reload panel + xfdesktop ────────────────────────────────────────
# Wallpaper + clock-format changes don't always pick up without a nudge.
# --reload is cheap and idempotent.
xfdesktop --reload >/dev/null 2>&1 || true
xfce4-panel --restart >/dev/null 2>&1 || true

log "branding applied"
