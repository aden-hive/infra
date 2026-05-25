// Hive VM dashboard. Vanilla JS, no build step. Talks to hive-backend
// /v1/workspace/* with a user JWT supplied by the operator. Token + base
// URL persist in localStorage so reloads keep the session.
//
// Threading model: single inflight request at a time per action button.
// The "log" panel captures the entire request/response pair so the
// operator can paste it into a bug report or convert to curl.
//
// No frameworks. Updates DOM directly. Polling = manual click of Refresh
// (workspace endpoints aren't free — they re-validate the row lock).

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "hive-portal-config";

  // ── persisted config ────────────────────────────────────────────────
  function loadConfig() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveConfig(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  }
  const cfg = loadConfig();
  if (cfg.base) $("base").value = cfg.base;
  if (cfg.jwt) $("jwt").value = cfg.jwt;

  // ── request log ──────────────────────────────────────────────────────
  function logLine(html) {
    const el = $("log");
    const ts = new Date().toISOString().slice(11, 19);
    el.innerHTML += `<span class="dim">${ts}</span> ${html}\n`;
    el.scrollTop = el.scrollHeight;
  }
  function escape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ── auth + transport ────────────────────────────────────────────────
  function getAuth() {
    const base = $("base").value.replace(/\/$/, "");
    const jwt = $("jwt").value.trim();
    if (!jwt) throw new Error("missing JWT");
    return { base, jwt };
  }

  async function api(method, path, body) {
    const { base, jwt } = getAuth();
    const url = `${base}${path}`;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/json",
      },
    };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    logLine(`<span class="ok">${escape(method)}</span> ${escape(path)} <span class="dim">→ ${escape(base)}</span>`);
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      logLine(`  <span class="err">network: ${escape(err.message)}</span>`);
      throw err;
    }
    const text = await res.text();
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    const tag = res.ok ? `<span class="ok">${res.status}</span>` : `<span class="err">${res.status}</span>`;
    if (parsed && typeof parsed === "object") {
      const oneLine = JSON.stringify(parsed).slice(0, 240);
      logLine(`  ${tag} <span class="dim">${escape(oneLine)}</span>`);
    } else {
      logLine(`  ${tag} <span class="dim">${escape(String(text).slice(0, 240))}</span>`);
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  // ── status rendering ────────────────────────────────────────────────
  function fmtDate(s) {
    if (!s) return "—";
    try {
      const d = new Date(s);
      const sec = Math.floor((Date.now() - d.getTime()) / 1000);
      const ago = sec < 60 ? `${sec}s ago`
        : sec < 3600 ? `${Math.floor(sec / 60)}m ago`
        : sec < 86400 ? `${Math.floor(sec / 3600)}h ago`
        : `${Math.floor(sec / 86400)}d ago`;
      return `${d.toLocaleString()} <span class="dim">(${ago})</span>`;
    } catch { return s; }
  }

  function renderStatus(s) {
    $("workspace-card").style.display = "block";
    $("colonies-card").style.display = "block";
    $("events-card").style.display = "block";
    const state = s.state || "unknown";
    const badge = $("state-badge");
    badge.className = `badge ${state}`;
    badge.textContent = state;
    $("sandbox-id").textContent = s.sandboxId ?? "—";
    $("vcpu").textContent = s.vcpu ?? "—";
    $("ram").textContent = s.ramMb ?? "—";
    $("last-hb").innerHTML = fmtDate(s.lastHeartbeatAt);
    $("last-paused").innerHTML = fmtDate(s.lastPausedAt);
    $("last-resumed").innerHTML = fmtDate(s.lastResumedAt);
    $("expires").innerHTML = fmtDate(s.expiresAt);
    renderColonies(s.pushedColonies || []);
    renderVmDisplay(s);
  }

  // Latest embed payload — kept so "Open in new tab" can reach the same
  // URL the iframe is showing, and so a manual hide/show cycle restores
  // the existing session without re-fetching status.
  let lastEmbed = null;
  let displayHidden = false;

  function renderVmDisplay(s) {
    const card = $("vm-display-card");
    const iframe = $("vm-display-iframe");
    const expiresEl = $("vm-display-expires");
    const toggle = $("vm-display-toggle");

    // Only show the iframe when the VM is reachable. /status returns
    // embed only for state='running'; paused/terminated rows must hide
    // the embed (stale tokens would 404 from client-proxy anyway).
    const url = s && s.state === "running" && s.embed && s.embed.novnc
      ? s.embed.novnc.loadUrl
      : null;

    if (!url) {
      card.style.display = "none";
      iframe.src = "about:blank";
      lastEmbed = null;
      return;
    }

    lastEmbed = s.embed.novnc;
    card.style.display = displayHidden ? "none" : "block";
    toggle.textContent = displayHidden ? "Show" : "Hide";

    // Only swap src when the URL actually changed — otherwise every
    // /status refresh would reload the whole VNC client, losing focus
    // and connection state.
    if (iframe.src !== url) {
      iframe.src = url;
    }
    if (lastEmbed.expiresAt) {
      const d = new Date(lastEmbed.expiresAt);
      const ms = d.getTime() - Date.now();
      if (ms > 0) {
        const mins = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        expiresEl.textContent = `embed expires in ${mins}m${secs.toString().padStart(2, "0")}s`;
        expiresEl.className = "dim";
      } else {
        expiresEl.textContent = `embed expired — refresh`;
        expiresEl.className = "dim error";
      }
    } else {
      expiresEl.textContent = "";
    }
  }

  function renderColonies(list) {
    const ul = $("colonies-list");
    $("colonies-count").textContent = `${list.length} pinned`;
    if (list.length === 0) {
      ul.innerHTML = `<div class="dim" style="padding:8px 0;">No colonies pinned.</div>`;
      return;
    }
    ul.innerHTML = list.map((name) => `
      <div class="row-between" style="padding:6px 0; border-bottom: 1px solid var(--border);">
        <code style="background:none; border:0; padding:0;">${escape(name)}</code>
        <button class="button danger" data-unpin="${escape(name)}">Unpin</button>
      </div>
    `).join("");
    ul.querySelectorAll("[data-unpin]").forEach((btn) => {
      btn.addEventListener("click", () => unpinColony(btn.dataset.unpin));
    });
  }

  function fmtRelative(s) {
    if (!s) return "—";
    try {
      const d = new Date(s);
      const sec = Math.floor((Date.now() - d.getTime()) / 1000);
      if (sec < 60) return `${sec}s ago`;
      if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
      if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
      return `${Math.floor(sec / 86400)}d ago`;
    } catch { return s; }
  }
  function fmtAbsolute(s) {
    if (!s) return "—";
    try {
      const d = new Date(s);
      return d.toLocaleString();
    } catch { return s; }
  }

  function eventCategoryClass(eventType) {
    if (eventType.startsWith("terminate_")) return "error";
    if (eventType.startsWith("pause_")) return "muted";
    if (eventType === "spawn" || eventType === "resume") return "ok";
    return "";
  }

  function renderEvents(events) {
    const ul = $("events-list");
    if (!events || events.length === 0) {
      ul.innerHTML = `<div class="dim" style="padding:8px 0;">No events yet.</div>`;
      return;
    }
    // Card-per-event layout. Avoids the table-column-width problem with
    // long detail JSON: the JSON block wraps freely under the metadata
    // row, doesn't fight the card width.
    ul.innerHTML = events.map((e) => {
      const cls = eventCategoryClass(e.eventType);
      const hasDetail = e.detail && Object.keys(e.detail).length > 0;
      const detailHtml = hasDetail
        ? `<pre class="event-detail">${escape(JSON.stringify(e.detail, null, 2))}</pre>`
        : "";
      const userBadge = e.userId != null
        ? `<span class="dim">· user ${escape(String(e.userId))}</span>`
        : `<span class="dim">· system</span>`;
      return `
        <div class="event-row">
          <div class="event-row-head">
            <span class="event-type ${cls}">${escape(e.eventType)}</span>
            ${userBadge}
            <span class="event-time" title="${escape(fmtAbsolute(e.occurredAt))}">${escape(fmtRelative(e.occurredAt))}</span>
          </div>
          ${detailHtml}
        </div>
      `;
    }).join("");
  }

  // ── handlers ────────────────────────────────────────────────────────
  async function loadStatus() {
    try {
      const s = await api("GET", "/v1/workspace");
      renderStatus(s);
    } catch (err) {
      if (err.status === 404 && err.body?.error === "workspace_not_initialized") {
        $("workspace-card").style.display = "block";
        $("state-badge").className = "badge unknown";
        $("state-badge").textContent = "not started";
        $("sandbox-id").textContent = "—";
        ["vcpu","ram","last-hb","last-paused","last-resumed","expires"].forEach(id => $(id).textContent = "—");
        renderColonies([]);
        $("colonies-card").style.display = "block";
      }
    }
  }

  async function loadEvents() {
    try {
      const events = await api("GET", "/v1/workspace/events?limit=20");
      renderEvents(events);
    } catch (err) {
      // event log is best-effort
    }
  }

  async function actionStart() {
    try {
      const r = await api("POST", "/v1/workspace/start", {});
      renderStatus(r);
      // status doesn't include heartbeat/paused timestamps from /start, refresh
      void loadStatus();
      void loadEvents();
    } catch (e) { /* logged */ }
  }
  async function actionHeartbeat() {
    try { await api("POST", "/v1/workspace/heartbeat", {}); void loadStatus(); }
    catch (e) { /* logged */ }
  }
  async function actionPause() {
    try { await api("POST", "/v1/workspace/pause", {}); void loadStatus(); void loadEvents(); }
    catch (e) { /* logged */ }
  }
  async function actionDestroy() {
    const ok = window.confirm("Destroy the workspace VM?\n\nThis kills the sandbox, wipes all files, and clears every colony pin. Use Pause for the lossless equivalent.");
    if (!ok) return;
    try { await api("DELETE", "/v1/workspace"); void loadStatus(); void loadEvents(); }
    catch (e) { /* logged */ }
  }
  async function actionPin() {
    const name = $("pin-name").value.trim();
    if (!name) return;
    try {
      await api("POST", "/v1/workspace/colonies", { colony_name: name });
      $("pin-name").value = "";
      void loadStatus();
      void loadEvents();
    } catch (e) { /* logged */ }
  }
  async function unpinColony(name) {
    const ok = window.confirm(`Unpin "${name}" from the workspace VM?\n\nFuture chats route to local. VM files stay in place; re-pinning is lossless.`);
    if (!ok) return;
    try {
      await api("DELETE", `/v1/workspace/colonies/${encodeURIComponent(name)}`);
      void loadStatus();
      void loadEvents();
    } catch (e) { /* logged */ }
  }

  // ── wiring ──────────────────────────────────────────────────────────
  $("connect").addEventListener("click", () => {
    const base = $("base").value;
    const jwt = $("jwt").value.trim();
    if (!jwt) {
      $("conn-status").textContent = "JWT required";
      $("conn-status").className = "dim error";
      return;
    }
    saveConfig({ base, jwt });
    $("conn-status").textContent = "Connecting…";
    $("conn-status").className = "dim";
    void loadStatus().then(loadEvents).then(() => {
      $("conn-status").textContent = "Connected";
      $("conn-status").className = "dim ok";
    });
  });
  $("forget").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    $("jwt").value = "";
    $("conn-status").textContent = "Token wiped";
    $("conn-status").className = "dim";
    ["workspace-card","colonies-card","events-card"].forEach(id => $(id).style.display = "none");
  });
  $("refresh").addEventListener("click", () => { void loadStatus(); });
  $("events-refresh").addEventListener("click", () => { void loadEvents(); });

  // VM display controls. Hide just removes the iframe from view (keeps
  // the URL cached in lastEmbed so re-showing doesn't need a /status).
  // Open-in-new-tab is the fallback for browsers that block third-party
  // iframe embedding from the client-proxy host.
  $("vm-display-toggle").addEventListener("click", () => {
    displayHidden = !displayHidden;
    $("vm-display-card").style.display = displayHidden ? "none" : "block";
    $("vm-display-toggle").textContent = displayHidden ? "Show" : "Hide";
    if (displayHidden) {
      // Don't keep the noVNC websocket open while hidden.
      $("vm-display-iframe").src = "about:blank";
    } else if (lastEmbed?.loadUrl) {
      $("vm-display-iframe").src = lastEmbed.loadUrl;
    }
  });
  $("vm-display-open").addEventListener("click", () => {
    if (lastEmbed?.loadUrl) {
      window.open(lastEmbed.loadUrl, "_blank", "noopener,noreferrer");
    }
  });
  $("act-start").addEventListener("click", actionStart);
  $("act-heartbeat").addEventListener("click", actionHeartbeat);
  $("act-pause").addEventListener("click", actionPause);
  $("act-destroy").addEventListener("click", actionDestroy);
  $("act-pin").addEventListener("click", actionPin);

  // Auto-connect on page load if we already have a token.
  if (cfg.jwt) {
    void loadStatus().then(loadEvents).then(() => {
      $("conn-status").textContent = "Connected (auto)";
      $("conn-status").className = "dim ok";
    });
  }
})();
