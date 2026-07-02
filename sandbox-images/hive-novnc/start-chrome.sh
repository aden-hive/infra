#!/bin/bash
# Chrome launcher.
#
# Two responsibilities on top of exec'ing the browser:
#
#   1. Put Chrome (and every child it fork/execs after this point) into a
#      dedicated cgroup v2 slice with a hard memory ceiling. When Chrome
#      exceeds the ceiling, the kernel kills a process WITHIN the slice
#      (a renderer, GPU proc, utility proc — never hive serve or Xvfb,
#      because they're outside the slice). Chrome's browser process detects
#      the SIGKILL and marks the tab "Aw, Snap!" → auto-reload. This is the
#      graceful degradation path we want.
#
#   2. Pass memory-bounding flags so Chrome cooperates with the ceiling
#      instead of just hitting the wall (--js-flags caps V8 old-gen per
#      renderer; --disk-cache-size + --media-cache-size cap on-disk state).
#
# History: the previous approach was `oom_score_adj=+700` on the whole
# Chrome tree via supervisord's exec wrapper. That inherited to the browser
# process too, so under memory pressure the still-launching renderer of a
# freshly-created tab was the highest-scored victim — tab died mid-spawn,
# the browser-bridge extension retried, cycle repeated. Verified on
# 2026-07-01 with team 14863's session (extension logs: "tab creates but
# immediately dies, group IDs keep cycling"). Restarting the desktop app
# did NOT fix it because the failure is entirely VM-side kernel behavior.
#
# The cgroup approach replaces that with an in-cgroup OOM path: the kernel
# still picks the highest-rss member of the slice (typically a renderer),
# but the browser process — being smaller RSS — is naturally last, so tab
# creation succeeds and the leaky renderers get reaped as needed. hive
# serve's oom_score_adj=-800 (set in supervisord.conf) still protects it
# in the rare case of a true VM-wide OOM.

set -eu

# ---------- cgroup v2 setup (best-effort; skip if kernel/mount can't) ----------
CGROUP_ROOT=/sys/fs/cgroup
CHROME_SLICE=${CGROUP_ROOT}/chrome.slice
# 2 GiB hard ceiling. The VM currently runs with 4 GiB total; hive serve +
# Xvfb + supervisord + xfce components idle around 500-700 MiB, so Chrome
# gets ~half the RAM. If we bump VM RAM the ceiling should scale with it.
CHROME_MEMORY_MAX=2147483648        # 2 GiB
# memory.high is a "soft" limit — kernel throttles the cgroup's allocations
# when crossed, giving Chrome's own memory-pressure signals a chance to run
# (which the extension's tab discard should hook into, see follow-up). Set
# to ~75% of hard cap.
CHROME_MEMORY_HIGH=1610612736       # 1.5 GiB

setup_cgroup() {
  # cgroup v2 unified hierarchy check: a v2 root has cgroup.controllers.
  if [ ! -e "${CGROUP_ROOT}/cgroup.controllers" ]; then
    return 1
  fi
  # Enable the memory controller for children of root. This can only be
  # done once and is idempotent (echo'ing an already-enabled controller
  # is a no-op, not an error). If it fails (e.g. controller already
  # enabled with active procs in root), we still try mkdir — a slice
  # without memory controller will be created but memory.max writes will
  # fail, and we degrade to "no cgroup limits, just Chrome flags".
  echo "+memory" > "${CGROUP_ROOT}/cgroup.subtree_control" 2>/dev/null || true

  mkdir -p "${CHROME_SLICE}" 2>/dev/null || return 1
  # Set the limits. If either write fails, unwind — a partially-configured
  # slice would enforce whichever limit landed, and the mixed state is
  # confusing to debug. Failing all-or-nothing means the fallback path
  # (no cgroup) is at least deterministic.
  if ! echo "${CHROME_MEMORY_MAX}" > "${CHROME_SLICE}/memory.max" 2>/dev/null; then
    return 1
  fi
  # memory.high is optional — kernels before 4.20 don't support it. Best
  # effort; don't fail the setup if it doesn't land.
  echo "${CHROME_MEMORY_HIGH}" > "${CHROME_SLICE}/memory.high" 2>/dev/null || true

  # Move ourselves into the slice. Every subsequent exec inherits the
  # cgroup membership by default (fork/exec never leaves the cgroup unless
  # explicitly moved), so all of Chrome's children — browser proc,
  # renderers, GPU, utility, zygote, sandbox helpers — end up here too.
  if ! echo $$ > "${CHROME_SLICE}/cgroup.procs" 2>/dev/null; then
    return 1
  fi
  return 0
}

if setup_cgroup; then
  echo "[start-chrome] cgroup ${CHROME_SLICE} active (memory.max=${CHROME_MEMORY_MAX})"
else
  echo "[start-chrome] cgroup setup skipped/failed; falling back to Chrome flags only"
fi

# ---------- wait for Xvfb ----------
for i in $(seq 1 50); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

# ---------- exec Chrome with memory-bounding flags ----------
#
# --js-flags "--max-old-space-size=384"
#   Caps V8's old-generation heap PER RENDERER at 384 MiB. Default is ~1.4
#   GiB per renderer on 64-bit, which multiplies by every leaky tab. 384
#   forces V8 to run more-frequent full GCs under sustained memory use;
#   renderers that genuinely need more will hit the cap and OOM within
#   the cgroup (Chrome then respawns the affected tab), rather than
#   racing every other renderer to the shared cgroup ceiling.
#
# --disk-cache-size=52428800  → 50 MiB HTTP disk cache (down from default ~320 MiB)
# --media-cache-size=52428800 → 50 MiB media cache
#   Cache lives on the persistent volume at /data/chrome; a fat cache
#   compounds VM disk pressure on top of memory pressure. 50 MiB is
#   enough for typical page-load reuse without hoarding.
#
# --renderer-process-limit=8
#   Cap on total renderer procs. Chrome's default is dynamic (up to ~20
#   depending on RAM detection). With --js-flags cap, 8 * 384MiB = 3 GiB
#   worst-case V8; combined with browser + GPU procs that fits under the
#   2 GiB cgroup with slack for headers/graphics buffers. When the cap is
#   hit, Chrome reuses existing renderer processes for new tabs (site-
#   isolation degrades gracefully).
#
# NOTE: --disable-dev-shm-usage stays — /dev/shm inside firecracker is
# tiny and Chrome uses it aggressively for GPU/renderer IPC. Disabling
# forces /tmp instead. Keep this even with cgroup limits.
exec google-chrome-stable \
  --no-sandbox \
  --test-type \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=TranslateUI,AutomationControlled \
  --enable-features=WebUIDarkMode \
  --disable-popup-blocking \
  --disable-dev-shm-usage \
  --password-store=basic \
  --user-data-dir=/data/chrome \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --window-size=1100,720 \
  --window-position=80,40 \
  --js-flags="--max-old-space-size=384" \
  --disk-cache-size=52428800 \
  --media-cache-size=52428800 \
  --renderer-process-limit=8 \
  --homepage=http://127.0.0.1:9998/newtab.html \
  http://127.0.0.1:9998/newtab.html
