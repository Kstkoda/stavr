/**
 * Cowire audit dashboard — single-file vanilla HTML/CSS/JS.
 *
 * Served at `GET /dashboard`. Lives as a TS string so the `tsc` build doesn't
 * need an asset-copy step. No build step on the browser side either; Tailwind
 * is pulled from the CDN.
 *
 * The dashboard talks to these endpoints, all under /dashboard:
 *   GET  /dashboard/status        — uptime, connected clients, active scopes
 *   GET  /dashboard/workers       — list of workers
 *   GET  /dashboard/workers/:id   — one worker with last 50 events
 *   GET  /dashboard/events        — history with filters
 *   GET  /dashboard/decisions     — pending decisions
 *   POST /dashboard/decisions/:correlationId/respond
 *   GET  /dashboard/stream        — live SSE event tap
 *   GET  /dashboard/export        — JSON/CSV audit log dump
 */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <title>Cowire — Audit Dashboard</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root {
      color-scheme: dark;
      --bg-0: #0a0d12;
      --bg-1: #11151c;
      --bg-2: #161b25;
      --bg-3: #1d2330;
      --border: #232a39;
      --fg-0: #e5e9f0;
      --fg-1: #aab1c0;
      --fg-2: #6b7280;
      --accent: #7c9eff;
      --accent-dim: #4e6acb;
      --green: #4ade80;
      --amber: #fbbf24;
      --red: #f87171;
      --pink: #f472b6;
      --cyan: #67e8f9;
      --violet: #a78bfa;
    }
    html, body {
      background: var(--bg-0);
      color: var(--fg-0);
      font-family: ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
      font-size: 12.5px;
      line-height: 1.45;
      margin: 0;
      height: 100%;
    }
    body { overflow: hidden; }
    *:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
      border-radius: 2px;
    }
    button, [role="button"] { cursor: pointer; }
    .panel { background: var(--bg-1); border: 1px solid var(--border); }
    .panel-h { background: var(--bg-2); border-bottom: 1px solid var(--border); padding: 6px 10px;
               text-transform: uppercase; letter-spacing: 0.07em; font-size: 10.5px; color: var(--fg-1); }
    .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px;
            border: 1px solid var(--border); border-radius: 3px; font-size: 10.5px;
            color: var(--fg-1); background: var(--bg-2); user-select: none; }
    .chip.active { color: var(--fg-0); border-color: var(--accent-dim); background: rgba(124,158,255,0.08); }
    .pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px;
            font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
    .status-running { color: var(--green); }
    .status-starting { color: var(--amber); }
    .status-idle { color: var(--cyan); }
    .status-terminated { color: var(--fg-2); }
    .status-crashed { color: var(--red); }
    .row-hover:hover { background: var(--bg-2); }
    .row-active { background: rgba(124,158,255,0.10); border-left: 2px solid var(--accent); }
    .ev-row { padding: 4px 10px; border-bottom: 1px solid rgba(35,42,57,0.4); }
    .ev-row:hover { background: var(--bg-2); }
    .ev-kind { color: var(--accent); font-weight: 600; }
    .ev-time { color: var(--fg-2); }
    .ev-agent { color: var(--cyan); }
    .ev-corr { color: var(--violet); }
    pre.payload { white-space: pre-wrap; word-break: break-word; color: var(--fg-1);
                  background: var(--bg-2); border: 1px solid var(--border); padding: 6px 8px;
                  margin-top: 4px; border-radius: 3px; font-size: 11.5px; max-height: 320px; overflow: auto; }
    .scroll-y { overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--bg-3) transparent; }
    .scroll-y::-webkit-scrollbar { width: 8px; }
    .scroll-y::-webkit-scrollbar-thumb { background: var(--bg-3); border-radius: 4px; }
    .btn { padding: 4px 10px; border-radius: 3px; font-size: 11.5px; border: 1px solid var(--border);
           background: var(--bg-2); color: var(--fg-0); }
    .btn:hover { background: var(--bg-3); border-color: var(--accent-dim); }
    .btn-approve { color: #0a0d12; background: var(--green); border-color: var(--green); font-weight: 600; }
    .btn-approve:hover { background: #6df09f; }
    .btn-reject { color: #0a0d12; background: var(--red); border-color: var(--red); font-weight: 600; }
    .btn-reject:hover { background: #ff9b9b; }
    input[type="text"], input[type="search"], select {
      background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border);
      padding: 3px 8px; border-radius: 3px; font-family: inherit; font-size: 11.5px;
    }
    .modal-bg { background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); }
    .grid-shell {
      display: grid;
      grid-template-rows: 38px 1fr;
      grid-template-columns: 280px 1fr 360px;
      grid-template-areas:
        "top top top"
        "left center right";
      height: 100vh;
      gap: 1px;
      background: var(--border);
    }
    .grid-shell > * { background: var(--bg-1); }
    .area-top { grid-area: top; }
    .area-left { grid-area: left; }
    .area-center { grid-area: center; }
    .area-right { grid-area: right; }
    @media (max-width: 1100px) {
      .grid-shell { grid-template-columns: 220px 1fr 280px; }
    }
    .live-dot { width: 7px; height: 7px; background: var(--green); border-radius: 50%;
                display: inline-block; box-shadow: 0 0 0 0 rgba(74,222,128,0.7); }
    .live-dot.paused { background: var(--amber); }
    .live-dot.live { animation: pulse 2s infinite; }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(74,222,128,0.55); }
      70% { box-shadow: 0 0 0 6px rgba(74,222,128,0); }
      100% { box-shadow: 0 0 0 0 rgba(74,222,128,0); }
    }

    /* ----- Workers panel (NOW-first redesign) ----- */
    .w-filter {
      position: sticky; top: 0; z-index: 2;
      background: var(--bg-1); border-bottom: 1px solid var(--border);
      padding: 6px 8px; display: flex; flex-wrap: wrap; gap: 4px;
    }
    .w-filter input[type="search"] { width: 100%; }
    .w-filter .row { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; width: 100%; }
    .w-section { border-bottom: 1px solid var(--border); }
    .w-section-h {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 10px; background: var(--bg-2);
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--fg-1); user-select: none;
    }
    .w-section-h .count { color: var(--fg-2); font-weight: 400; }
    .w-section-h .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }
    .w-dot-active { background: var(--green); box-shadow: 0 0 4px rgba(74,222,128,0.5); }
    .w-dot-idle { background: var(--amber); }
    .w-dot-recent { background: var(--fg-2); }
    .w-empty { padding: 6px 12px; font-size: 10.5px; color: var(--fg-2); font-style: italic; }
    details.worker-row {
      border-bottom: 1px solid rgba(35,42,57,0.4);
      background: transparent;
    }
    details.worker-row > summary {
      list-style: none; cursor: pointer; padding: 5px 10px;
      outline: none;
    }
    details.worker-row > summary::-webkit-details-marker { display: none; }
    details.worker-row > summary:hover { background: var(--bg-2); }
    details.worker-row[open] > summary { background: var(--bg-2); }
    .wr-line1 { display: flex; align-items: center; gap: 6px; }
    .wr-name { font-weight: 600; color: var(--fg-0); flex: 1; min-width: 0;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wr-age { color: var(--fg-2); font-size: 10.5px; flex-shrink: 0; }
    .wr-line2 { display: flex; gap: 8px; font-size: 10.5px; margin-top: 1px; color: var(--fg-2); }
    .wr-type { color: var(--cyan); }
    .wr-cwd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .wr-preview { font-size: 10.5px; color: var(--fg-1); margin-top: 2px;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wr-branch { font-size: 10.5px; color: var(--violet); overflow: hidden;
                 text-overflow: ellipsis; white-space: nowrap; }
    .wr-detail { padding: 6px 10px 8px 10px; background: var(--bg-2);
                 border-top: 1px solid var(--border); }
    .wr-detail .ev-mini { font-size: 10.5px; color: var(--fg-1); padding: 2px 0;
                          border-bottom: 1px solid rgba(35,42,57,0.4); }
    .wr-detail .ev-mini:last-child { border-bottom: none; }
    .wr-detail .ev-mini code { color: var(--fg-0); }
    .wr-detail .ev-mini .ts { color: var(--fg-2); margin-right: 4px; }
    .wr-detail .ev-mini .k { color: var(--accent); margin-right: 4px; }
    .reason-completed { background: rgba(74,222,128,0.15); color: var(--green);
                        border: 1px solid rgba(74,222,128,0.35); }
    .reason-crashed { background: rgba(248,113,113,0.15); color: var(--red);
                      border: 1px solid rgba(248,113,113,0.35); }
    .reason-terminated_by_user { background: rgba(167,139,250,0.15); color: var(--violet);
                                  border: 1px solid rgba(167,139,250,0.35); }
    .reason-badge { padding: 0 5px; border-radius: 3px; font-size: 9.5px;
                    font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
    details.w-history { border-bottom: 1px solid var(--border); }
    details.w-history > summary {
      cursor: pointer; padding: 6px 10px; background: var(--bg-2);
      color: var(--fg-1); font-size: 10.5px;
      display: flex; align-items: center; gap: 6px; list-style: none;
    }
    details.w-history > summary::-webkit-details-marker { display: none; }
    details.w-history > summary:hover { background: var(--bg-3); }
    details.w-history > summary::before { content: '▸'; color: var(--fg-2); }
    details.w-history[open] > summary::before { content: '▾'; }
    .chip-pill {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 1px 6px; border-radius: 10px; font-size: 10px;
      border: 1px solid var(--border); background: var(--bg-2);
      color: var(--fg-1); cursor: pointer; user-select: none;
    }
    .chip-pill:hover { border-color: var(--accent-dim); }
    .chip-pill.on { background: rgba(124,158,255,0.15); border-color: var(--accent-dim); color: var(--fg-0); }
    .chip-pill .pdot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
    select.w-type { font-size: 11px; padding: 2px 4px; }
  </style>
</head>
<body>
  <div class="grid-shell">

    <!-- Top status bar -->
    <header class="area-top flex items-center px-3" role="banner" aria-label="Daemon status">
      <div class="flex items-center gap-2 mr-4">
        <span class="live-dot live" id="live-dot" aria-hidden="true"></span>
        <span class="font-bold tracking-wide" style="color:var(--accent)">cowire</span>
        <span style="color:var(--fg-2)">·</span>
        <span style="color:var(--fg-1)">audit dashboard</span>
      </div>
      <div class="flex items-center gap-4 text-xs flex-1" id="status-bar" style="color:var(--fg-1)">
        <span>connecting…</span>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn" id="btn-pause" aria-pressed="false" title="Pause live tail (space)">Pause</button>
        <button class="btn" id="btn-clear" title="Clear tail (c)">Clear</button>
        <button class="btn" id="btn-export-json" title="Export JSON">Export JSON</button>
        <button class="btn" id="btn-export-csv" title="Export CSV">Export CSV</button>
      </div>
    </header>

    <!-- Left: workers (NOW-first redesign) -->
    <aside class="area-left flex flex-col" aria-label="Workers">
      <div class="panel-h flex items-center justify-between">
        <span>Workers</span>
        <span style="color:var(--fg-2)" id="workers-count">0</span>
      </div>
      <div class="scroll-y flex-1" id="workers-scroll">
        <div class="w-filter" id="w-filter">
          <div class="row" id="w-status-pills" aria-label="Status filter">
            <button type="button" class="chip-pill" data-w-status="active"><span class="pdot w-dot-active"></span>active</button>
            <button type="button" class="chip-pill" data-w-status="idle"><span class="pdot w-dot-idle"></span>idle</button>
            <button type="button" class="chip-pill" data-w-status="completed"><span class="pdot" style="background:var(--green)"></span>completed</button>
            <button type="button" class="chip-pill" data-w-status="crashed"><span class="pdot" style="background:var(--red)"></span>crashed</button>
          </div>
          <div class="row">
            <select id="w-filter-type" class="w-type" aria-label="Worker type filter">
              <option value="">all types</option>
            </select>
          </div>
          <div class="row">
            <input id="w-filter-text" type="search" placeholder="search name / cwd / branch" aria-label="Search workers" />
          </div>
        </div>

        <section class="w-section" data-bucket="active">
          <div class="w-section-h"><span class="dot w-dot-active"></span><span>Active</span><span style="color:var(--fg-2);font-weight:400">· last 60s</span><span class="flex-1" style="flex:1"></span><span class="count" id="w-count-active">0</span></div>
          <div id="w-list-active"></div>
        </section>

        <section class="w-section" data-bucket="idle">
          <div class="w-section-h"><span class="dot w-dot-idle"></span><span>Idle</span><span style="color:var(--fg-2);font-weight:400">· 1–5m</span><span class="flex-1" style="flex:1"></span><span class="count" id="w-count-idle">0</span></div>
          <div id="w-list-idle"></div>
        </section>

        <section class="w-section" data-bucket="recent">
          <div class="w-section-h"><span class="dot w-dot-recent"></span><span>Recently ended</span><span style="color:var(--fg-2);font-weight:400">· last 30m</span><span class="flex-1" style="flex:1"></span><span class="count" id="w-count-recent">0</span></div>
          <div id="w-list-recent"></div>
        </section>

        <details class="w-history" id="w-history">
          <summary><span>Show older history</span><span class="flex-1" style="flex:1"></span><span class="count" id="w-count-older" style="color:var(--fg-2)">0</span></summary>
          <div id="w-list-older"></div>
        </details>
      </div>
    </aside>

    <!-- Center: live event tail -->
    <main class="area-center flex flex-col" aria-label="Event stream">
      <div class="panel-h flex items-center gap-2 flex-wrap">
        <span>Live event tail</span>
        <span style="color:var(--fg-2)" id="tail-count">0 events</span>
        <div class="flex-1"></div>
        <input id="filter-text" type="search" placeholder="filter (text, corr_id, agent)" style="width:240px" aria-label="Filter events" />
        <select id="filter-kind" aria-label="Kind filter">
          <option value="">all kinds</option>
        </select>
        <select id="filter-time" aria-label="Time window">
          <option value="0">all time</option>
          <option value="60">last 1m</option>
          <option value="300">last 5m</option>
          <option value="3600">last 1h</option>
          <option value="86400">last 24h</option>
        </select>
      </div>
      <div id="kind-chips" class="px-3 py-2 flex gap-1 flex-wrap" aria-label="Kind quick filters" style="border-bottom:1px solid var(--border)"></div>
      <div class="scroll-y flex-1" id="event-stream" role="log" aria-live="polite" aria-relevant="additions"></div>
    </main>

    <!-- Right: pending decisions -->
    <aside class="area-right flex flex-col" aria-label="Pending decisions">
      <div class="panel-h flex items-center justify-between">
        <span>Pending decisions</span>
        <span style="color:var(--fg-2)" id="decisions-count">0</span>
      </div>
      <div class="scroll-y flex-1" id="decisions-list" role="list"></div>
    </aside>
  </div>

  <!-- Worker drill-in modal -->
  <div id="modal" class="fixed inset-0 hidden items-center justify-center modal-bg z-50" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="panel w-[860px] max-w-[95vw] max-h-[88vh] flex flex-col">
      <div class="panel-h flex items-center justify-between">
        <span id="modal-title">Worker</span>
        <button class="btn" id="modal-close" aria-label="Close (Esc)">Close</button>
      </div>
      <div class="p-3 scroll-y" id="modal-body" style="min-height:120px"></div>
    </div>
  </div>

<script>
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const fmtTime = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleTimeString("en-GB", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
  };
  const fmtAge = (sec) => {
    if (sec == null) return "—";
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h";
    return Math.floor(sec / 86400) + "d";
  };
  const ageAgo = (iso) => {
    if (!iso) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  };
  const fmtAgo = (iso) => {
    const s = ageAgo(iso);
    return s == null ? "—" : fmtAge(s) + " ago";
  };
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // ----- State -----
  const state = {
    events: [],            // live + history merged, capped
    maxTail: 1000,
    paused: false,
    workers: [],
    decisions: [],
    activeWorkerId: null,
    filterText: "",
    filterKind: "",
    filterTimeSec: 0,
    knownKinds: new Set(),
    seenIds: new Set(),
    // Workers panel
    workerFilterStatus: new Set(),   // 'active' | 'idle' | 'completed' | 'crashed' — empty = all
    workerFilterType: "",
    workerFilterText: "",
    workerTypes: new Set(),          // observed type strings
    workerEventCache: new Map(),     // worker.id -> { events: [], fetched_at: number, inflight: bool }
    // Track latest worker_progress / worker_activity per worker for "last event preview"
    workerLastPreview: new Map(),    // worker.id -> { kind, text, at }
  };

  // Categorize kinds into rendering "families" for richer chrome.
  const KIND_FAMILY = (kind) => {
    if (kind.startsWith("worker_")) return "worker";
    if (kind.startsWith("decision_")) return "decision";
    if (kind.startsWith("trust_scope_")) return "scope";
    if (kind === "tool_use" || kind === "command_run") return "tool";
    if (kind === "file_written") return "file";
    if (kind === "verification") return "verify";
    if (kind === "commit_pushed") return "git";
    if (kind === "pr_opened") return "git";
    if (kind === "error" || kind === "worker_error") return "error";
    if (kind === "session_started" || kind === "session_ended") return "session";
    return "default";
  };
  const FAMILY_COLOR = {
    worker: "var(--cyan)",
    decision: "var(--amber)",
    scope: "var(--violet)",
    tool: "var(--accent)",
    file: "var(--fg-0)",
    verify: "var(--green)",
    git: "var(--pink)",
    error: "var(--red)",
    session: "var(--fg-1)",
    default: "var(--accent)",
  };
  const FAMILY_GLYPH = {
    worker: "▣", decision: "?", scope: "§", tool: "›_", file: "✎",
    verify: "✓", git: "⤴", error: "⚠", session: "◐", default: "•",
  };

  // ----- Status bar -----
  async function refreshStatus() {
    try {
      const r = await fetch("/dashboard/status", { cache: "no-store" });
      if (!r.ok) throw new Error("status " + r.status);
      const s = await r.json();
      const bits = [
        '<span>uptime <b style="color:var(--fg-0)">' + esc(fmtAge(s.uptime_sec)) + '</b></span>',
        '<span>clients <b style="color:var(--fg-0)">' + s.connected_clients + '</b></span>',
        '<span>events <b style="color:var(--fg-0)">' + s.event_count + '</b></span>',
        '<span>open decisions <b style="color:var(--fg-0)">' + s.pending_decisions + '</b></span>',
        '<span>active scopes <b style="color:var(--fg-0)">' + s.active_scopes + '</b></span>',
        '<span style="color:var(--fg-2)">v' + esc(s.version) + ' · port ' + s.port + '</span>',
      ];
      $("status-bar").innerHTML = bits.join('<span style="color:var(--bg-3)">|</span>');
    } catch (err) {
      $("status-bar").innerHTML = '<span style="color:var(--red)">daemon unreachable</span>';
    }
  }

  // ----- Workers (NOW-first redesign) -----
  async function refreshWorkers() {
    try {
      const r = await fetch("/dashboard/workers", { cache: "no-store" });
      const j = await r.json();
      state.workers = j.workers || [];
      for (const w of state.workers) {
        if (w && w.type) state.workerTypes.add(w.type);
      }
      renderWorkerTypeOptions();
      renderWorkers();
    } catch {}
  }

  function renderWorkerTypeOptions() {
    const sel = $("w-filter-type");
    if (!sel) return;
    const current = sel.value;
    const types = Array.from(state.workerTypes).sort();
    sel.innerHTML = '<option value="">all types</option>' +
      types.map((t) => '<option value="' + esc(t) + '"' + (t === current ? " selected" : "") + '>' + esc(t) + '</option>').join("");
  }

  function workerMatchesFilters(w, bucket) {
    if (state.workerFilterStatus.size) {
      // Pills map 'active'/'idle' to bucket, 'completed'/'crashed' to termination reason
      const tr = w.termination_reason;
      const matched =
        (state.workerFilterStatus.has("active") && bucket === "active") ||
        (state.workerFilterStatus.has("idle") && bucket === "idle") ||
        (state.workerFilterStatus.has("completed") && tr === "completed") ||
        (state.workerFilterStatus.has("crashed") && (tr === "crashed" || w.status === "crashed"));
      if (!matched) return false;
    }
    if (state.workerFilterType && w.type !== state.workerFilterType) return false;
    if (state.workerFilterText) {
      const t = state.workerFilterText.toLowerCase();
      const branch = (w.metadata && typeof w.metadata.branch === "string") ? w.metadata.branch : "";
      const hay = (String(w.name || "") + " " + String(w.id || "") + " " + String(w.cwd || "") + " " + branch).toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  }

  function bucketOf(w, now) {
    const ended = w.status === "terminated" || w.status === "crashed";
    if (ended) {
      const ts = w.ended_at || w.last_activity_at || w.started_at;
      const ageSec = ts ? (now - new Date(ts).getTime()) / 1000 : Infinity;
      return ageSec < 30 * 60 ? "recent" : "older";
    }
    const ts = w.last_activity_at || w.started_at;
    const ageSec = ts ? (now - new Date(ts).getTime()) / 1000 : Infinity;
    return ageSec < 60 ? "active" : "idle";
  }

  function renderWorkers() {
    const now = Date.now();
    const buckets = { active: [], idle: [], recent: [], older: [] };
    for (const w of state.workers) {
      const b = bucketOf(w, now);
      if (!workerMatchesFilters(w, b)) continue;
      buckets[b].push(w);
    }
    // Sort by recency: active/idle by last_activity desc, recent/older by ended_at desc.
    const tActivity = (w) => new Date(w.last_activity_at || w.started_at || 0).getTime();
    const tEnded = (w) => new Date(w.ended_at || w.last_activity_at || w.started_at || 0).getTime();
    buckets.active.sort((a, b) => tActivity(b) - tActivity(a));
    buckets.idle.sort((a, b) => tActivity(b) - tActivity(a));
    buckets.recent.sort((a, b) => tEnded(b) - tEnded(a));
    buckets.older.sort((a, b) => tEnded(b) - tEnded(a));

    $("workers-count").textContent = state.workers.length;
    $("w-count-active").textContent = buckets.active.length;
    $("w-count-idle").textContent = buckets.idle.length;
    $("w-count-recent").textContent = buckets.recent.length;
    $("w-count-older").textContent = buckets.older.length;

    diffRenderBucket("w-list-active", buckets.active, "active");
    diffRenderBucket("w-list-idle", buckets.idle, "idle");
    diffRenderBucket("w-list-recent", buckets.recent, "recent");
    // Cap older bucket at 100 to avoid runaway DOM.
    diffRenderBucket("w-list-older", buckets.older.slice(0, 100), "older");
  }

  function diffRenderBucket(containerId, workers, mode) {
    const container = $(containerId);
    if (!container) return;
    const existing = new Map();
    for (const el of Array.from(container.children)) {
      const wid = el.dataset && el.dataset.workerId;
      if (wid) existing.set(wid, el);
    }
    const seen = new Set();
    let prev = null;
    for (const w of workers) {
      seen.add(w.id);
      let el = existing.get(w.id);
      if (!el) {
        el = buildWorkerRow(w, mode);
      } else {
        updateWorkerRow(el, w, mode);
      }
      // Place el after prev (or at start)
      const target = prev ? prev.nextSibling : container.firstChild;
      if (el !== target) {
        if (prev) prev.after(el);
        else container.prepend(el);
      }
      prev = el;
    }
    // Remove rows no longer in this bucket
    for (const [id, el] of existing) {
      if (!seen.has(id)) el.remove();
    }
    // Empty placeholder
    let empty = container.querySelector(".w-empty");
    if (workers.length === 0) {
      if (!empty) {
        empty = document.createElement("div");
        empty.className = "w-empty";
        empty.textContent = mode === "active" ? "none active" :
                            mode === "idle" ? "none idle" :
                            mode === "recent" ? "no recent terminations" :
                            "no older workers";
        container.appendChild(empty);
      }
    } else if (empty) {
      empty.remove();
    }
  }

  function buildWorkerRow(w, mode) {
    const el = document.createElement("details");
    el.className = "worker-row";
    el.dataset.workerId = w.id;
    el.addEventListener("toggle", () => {
      if (el.open) loadWorkerDetail(w.id, el);
    });
    updateWorkerRow(el, w, mode);
    return el;
  }

  function reasonBadge(w) {
    const tr = w.termination_reason;
    if (!tr) return "";
    const cls = "reason-" + esc(tr);
    return '<span class="reason-badge ' + cls + '">' + esc(tr.replace(/_/g, " ")) + '</span>';
  }

  function workerLastPreviewText(w) {
    const p = state.workerLastPreview.get(w.id);
    if (!p) return "";
    const k = p.kind === "worker_progress" ? "▸" : p.kind === "worker_activity" ? "·" : "•";
    return k + " " + p.text;
  }

  function updateWorkerRow(el, w, mode) {
    const lastAct = w.last_activity_at || w.started_at;
    const endedAt = w.ended_at;
    const ageIso = mode === "recent" || mode === "older" ? endedAt : lastAct;
    const ageTitle = esc(ageIso || "");
    const ageHtml = '<span class="wr-age" title="' + ageTitle + '">' + esc(fmtAgo(ageIso)) + '</span>';
    const branch = (w.metadata && typeof w.metadata.branch === "string") ? w.metadata.branch : "";

    let summaryHtml = "";
    if (mode === "active") {
      const preview = workerLastPreviewText(w);
      summaryHtml =
        '<div class="wr-line1">' +
          '<span class="dot w-dot-active" style="width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0"></span>' +
          '<span class="wr-name" title="' + esc(w.name) + '">' + esc(w.name) + '</span>' +
          ageHtml +
        '</div>' +
        '<div class="wr-line2">' +
          '<span class="wr-type">' + esc(w.type) + '</span>' +
          (w.pid ? '<span>pid ' + w.pid + '</span>' : '') +
          '<span class="wr-cwd" title="' + esc(w.cwd || "") + '">' + esc(w.cwd || "") + '</span>' +
        '</div>' +
        (branch ? '<div class="wr-branch" title="' + esc(branch) + '">' + esc(branch) + '</div>' : '') +
        (preview ? '<div class="wr-preview" title="' + esc(preview) + '">' + esc(preview) + '</div>' : '');
    } else if (mode === "idle") {
      summaryHtml =
        '<div class="wr-line1">' +
          '<span class="dot w-dot-idle" style="width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0"></span>' +
          '<span class="wr-name" title="' + esc(w.name) + '">' + esc(w.name) + '</span>' +
          ageHtml +
        '</div>' +
        '<div class="wr-line2">' +
          '<span class="wr-type">' + esc(w.type) + '</span>' +
          (branch ? '<span class="wr-cwd" style="color:var(--violet)" title="' + esc(branch) + '">' + esc(branch) + '</span>' : '') +
        '</div>';
    } else { // recent / older
      summaryHtml =
        '<div class="wr-line1">' +
          '<span class="dot w-dot-recent" style="width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0"></span>' +
          '<span class="wr-name" title="' + esc(w.name) + '">' + esc(w.name) + '</span>' +
          reasonBadge(w) +
          ageHtml +
        '</div>' +
        '<div class="wr-line2">' +
          '<span class="wr-type">' + esc(w.type) + '</span>' +
          (w.exit_code != null ? '<span>exit ' + w.exit_code + '</span>' : '') +
        '</div>';
    }

    // Set/replace <summary> content (preserves <details>.open and any existing detail body).
    let summary = el.querySelector(":scope > summary");
    if (!summary) {
      summary = document.createElement("summary");
      el.appendChild(summary);
    }
    if (summary.dataset.html !== summaryHtml) {
      summary.innerHTML = summaryHtml;
      summary.dataset.html = summaryHtml;
    }
    el.dataset.mode = mode;

    // Refresh detail panel if already open (re-render cached events).
    if (el.open) {
      renderWorkerDetailBody(w.id, el);
    }
  }

  async function loadWorkerDetail(workerId, rowEl) {
    let cache = state.workerEventCache.get(workerId);
    if (!cache) {
      cache = { events: [], fetched_at: 0, inflight: false };
      state.workerEventCache.set(workerId, cache);
    }
    // Always show what we have immediately; refetch if stale (>3s) or never fetched.
    renderWorkerDetailBody(workerId, rowEl);
    if (cache.inflight) return;
    const stale = Date.now() - cache.fetched_at > 3000;
    if (!stale && cache.events.length) return;
    cache.inflight = true;
    try {
      const r = await fetch("/dashboard/workers/" + encodeURIComponent(workerId), { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        cache.events = (j.events || []);
        cache.fetched_at = Date.now();
      }
    } catch {}
    cache.inflight = false;
    renderWorkerDetailBody(workerId, rowEl);
  }

  function renderWorkerDetailBody(workerId, rowEl) {
    const cache = state.workerEventCache.get(workerId);
    let body = rowEl.querySelector(":scope > .wr-detail");
    if (!body) {
      body = document.createElement("div");
      body.className = "wr-detail";
      rowEl.appendChild(body);
    }
    if (!cache || cache.events.length === 0) {
      body.innerHTML = cache && cache.inflight ? '<div style="color:var(--fg-2)">loading…</div>' : '<div style="color:var(--fg-2)">no events recorded</div>';
      return;
    }
    // Show last 10 worker_log / worker_progress / worker_activity events (or fall back to any).
    const isWorkerKind = (k) => k === "worker_progress" || k === "worker_activity" || k === "worker_spawned" || k === "worker_terminated" || k === "worker_error" || k === "worker_metadata_changed";
    let evs = cache.events.filter((e) => isWorkerKind(e.kind));
    if (evs.length === 0) evs = cache.events;
    evs = evs.slice(0, 10);
    body.innerHTML = evs.map((ev) => {
      const p = ev.payload || {};
      let payload = "";
      if (ev.kind === "worker_progress") {
        payload = (p.message || "") + (p.detail ? " — " + p.detail : "");
      } else if (ev.kind === "worker_activity") {
        payload = p.status || p.message || "";
      } else if (ev.kind === "worker_terminated") {
        payload = (p.reason || "") + (p.exit_code != null ? " (exit " + p.exit_code + ")" : "");
      } else if (ev.kind === "worker_error") {
        payload = p.message || "";
      } else {
        try { payload = JSON.stringify(p).slice(0, 140); } catch { payload = String(p); }
      }
      return '<div class="ev-mini">' +
        '<span class="ts" title="' + esc(ev.at) + '">' + esc(fmtAgo(ev.at)) + '</span>' +
        '<span class="k">' + esc(ev.kind) + '</span>' +
        '<code>' + esc(payload) + '</code>' +
      '</div>';
    }).join("");
  }

  // ----- Decisions -----
  async function refreshDecisions() {
    try {
      const r = await fetch("/dashboard/decisions?status=open", { cache: "no-store" });
      const j = await r.json();
      state.decisions = j.decisions || [];
      renderDecisions();
    } catch {}
  }
  function renderDecisions() {
    const root = $("decisions-list");
    $("decisions-count").textContent = state.decisions.length;
    if (!state.decisions.length) {
      root.innerHTML = '<div class="px-3 py-4 text-xs" style="color:var(--fg-2)">no pending decisions</div>';
      return;
    }
    root.innerHTML = state.decisions.map((d) => {
      const ttl = Math.max(0, Math.floor((new Date(d.expires_at).getTime() - Date.now()) / 1000));
      const opts = (d.options || []).map((o) => (
        '<button class="btn btn-approve" data-corr="' + esc(d.correlation_id) + '" data-opt="' + esc(o.id) + '">' + esc(o.label) + '</button>'
      )).join(" ");
      return (
        '<article class="px-3 py-3" role="listitem" style="border-bottom:1px solid var(--border)">' +
          '<header class="flex items-center gap-2 mb-1">' +
            '<span class="pill" style="background:var(--amber);color:#111">DECISION</span>' +
            '<span class="ev-corr text-xs truncate">' + esc(d.correlation_id) + '</span>' +
            '<span class="flex-1"></span>' +
            '<span class="text-xs" style="color:var(--fg-2)">ttl ' + ttl + 's</span>' +
          '</header>' +
          '<div class="mb-2" style="color:var(--fg-0)">' + esc(d.question) + '</div>' +
          '<div class="flex flex-wrap gap-2">' + opts + '</div>' +
          (d.default_option_id ? '<div class="text-xs mt-2" style="color:var(--fg-2)">default: ' + esc(d.default_option_id) + '</div>' : "") +
        '</article>'
      );
    }).join("");
    root.querySelectorAll("button[data-corr]").forEach((b) => {
      b.addEventListener("click", () => respondDecision(b.getAttribute("data-corr"), b.getAttribute("data-opt"), b));
    });
  }
  async function respondDecision(corr, optionId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      const r = await fetch("/dashboard/decisions/" + encodeURIComponent(corr) + "/respond", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chosen_option_id: optionId, responder: "dashboard-user", reason: "approved via dashboard" }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert("rejected: " + (j.error || r.status));
      }
    } catch (e) {
      alert("error: " + e.message);
    } finally {
      refreshDecisions();
    }
  }

  // ----- Event stream -----
  function pushEvent(ev) {
    if (state.seenIds.has(ev.id)) return;
    state.seenIds.add(ev.id);
    state.events.unshift(ev);
    if (state.events.length > state.maxTail) {
      const dropped = state.events.splice(state.maxTail);
      for (const d of dropped) state.seenIds.delete(d.id);
    }
    if (!state.knownKinds.has(ev.kind)) {
      state.knownKinds.add(ev.kind);
      renderKindOptions();
    }
    // Surface worker-scoped events into the workers panel without waiting for the next poll.
    handleWorkerEvent(ev);
    if (!state.paused) renderStream();
  }

  function handleWorkerEvent(ev) {
    if (!ev || typeof ev.kind !== "string" || !ev.kind.startsWith("worker_")) return;
    const p = (ev.payload && typeof ev.payload === "object") ? ev.payload : {};
    const wid = (typeof p.id === "string" && p.id) || (typeof ev.correlation_id === "string" ? ev.correlation_id : "");
    if (!wid) return;
    // Update "last event preview" used by Active rows.
    if (ev.kind === "worker_progress") {
      const text = (p.message || "") + (p.detail ? " — " + p.detail : "");
      if (text) state.workerLastPreview.set(wid, { kind: ev.kind, text, at: ev.at });
    } else if (ev.kind === "worker_activity") {
      const text = p.status || p.message || "";
      if (text) state.workerLastPreview.set(wid, { kind: ev.kind, text, at: ev.at });
    } else if (ev.kind === "worker_error") {
      const text = p.message || "error";
      state.workerLastPreview.set(wid, { kind: ev.kind, text, at: ev.at });
    }
    // Invalidate detail cache so an open <details> reloads on next render tick.
    const cache = state.workerEventCache.get(wid);
    if (cache) cache.fetched_at = 0;
    // Spawns / terminations / metadata changes need a server refetch
    // (the workers list status fields aren't in the event payload).
    // Progress / activity / error just update local preview state.
    if (
      ev.kind === "worker_spawned" ||
      ev.kind === "worker_terminated" ||
      ev.kind === "worker_metadata_changed"
    ) {
      scheduleWorkerRefetch();
    } else {
      scheduleWorkerRerender();
    }
  }

  let workerRefetchTimer = null;
  function scheduleWorkerRefetch() {
    if (workerRefetchTimer) return;
    workerRefetchTimer = setTimeout(() => {
      workerRefetchTimer = null;
      refreshWorkers();
    }, 250);
  }
  let workerRerenderTimer = null;
  function scheduleWorkerRerender() {
    if (workerRerenderTimer) return;
    workerRerenderTimer = setTimeout(() => {
      workerRerenderTimer = null;
      renderWorkers();
    }, 250);
  }

  function matchesFilters(ev) {
    if (state.filterKind && ev.kind !== state.filterKind) return false;
    if (state.filterTimeSec > 0) {
      const t = new Date(ev.at).getTime();
      if (Date.now() - t > state.filterTimeSec * 1000) return false;
    }
    if (state.filterText) {
      const t = state.filterText.toLowerCase();
      const hay = (ev.kind + " " + (ev.correlation_id || "") + " " + (ev.source_agent || "") + " " + JSON.stringify(ev.payload || {})).toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  }

  function renderKindOptions() {
    const sel = $("filter-kind");
    const current = sel.value;
    const kinds = Array.from(state.knownKinds).sort();
    sel.innerHTML = '<option value="">all kinds</option>' + kinds.map((k) => '<option value="' + esc(k) + '"' + (k === current ? " selected" : "") + '>' + esc(k) + '</option>').join("");

    // Top frequent chips
    const chips = $("kind-chips");
    const families = ["worker", "decision", "tool", "verify", "git", "scope", "error"];
    chips.innerHTML = '<button class="chip' + (state.filterKind === "" ? " active" : "") + '" data-chip-kind="">all</button>' +
      kinds.slice(0, 14).map((k) => '<button class="chip' + (state.filterKind === k ? " active" : "") + '" data-chip-kind="' + esc(k) + '">' + esc(k) + '</button>').join("");
    chips.querySelectorAll("button[data-chip-kind]").forEach((b) => {
      b.addEventListener("click", () => {
        state.filterKind = b.getAttribute("data-chip-kind");
        sel.value = state.filterKind;
        renderKindOptions();
        renderStream();
      });
    });
  }

  function renderEventRow(ev) {
    const fam = KIND_FAMILY(ev.kind);
    const color = FAMILY_COLOR[fam];
    const glyph = FAMILY_GLYPH[fam];
    const p = ev.payload || {};
    let body = "";
    if (ev.kind === "command_run" || ev.kind === "tool_use") {
      const cmd = p.command || (p.name ? p.name + "(" + (p.args ? JSON.stringify(p.args) : "") + ")" : JSON.stringify(p));
      const ec = ("exit_code" in p) ? ' <span style="color:' + (p.exit_code === 0 ? "var(--green)" : "var(--red)") + '">exit ' + p.exit_code + '</span>' : "";
      const dur = p.duration_ms != null ? ' <span style="color:var(--fg-2)">' + p.duration_ms + 'ms</span>' : "";
      body = '<code style="color:var(--fg-0)">' + esc(cmd) + '</code>' + ec + dur;
    } else if (ev.kind === "file_written") {
      body = '<code>' + esc(p.path || "") + '</code> <span style="color:var(--green)">+' + (p.lines_added || 0) + '</span> <span style="color:var(--red)">-' + (p.lines_removed || 0) + '</span>';
    } else if (ev.kind === "verification") {
      body = '<b>' + esc(p.check || "") + '</b> <span style="color:' + (p.status === "pass" ? "var(--green)" : "var(--red)") + '">' + esc(p.status || "") + '</span> ' + esc(p.detail || "");
    } else if (ev.kind === "commit_pushed") {
      body = '<span style="color:var(--pink)">' + esc((p.sha || "").slice(0, 8)) + '</span> ' + esc(p.message || "") + ' <span style="color:var(--fg-2)">→ ' + esc(p.branch || "") + '</span>';
    } else if (ev.kind === "pr_opened") {
      body = '<a href="' + esc(p.url || "#") + '" target="_blank" rel="noopener" style="color:var(--accent)">' + esc(p.title || p.url) + '</a>';
    } else if (ev.kind === "progress" || ev.kind === "worker_progress") {
      body = esc(p.message || p.detail || "") + (p.detail && p.message ? ' <span style="color:var(--fg-2)">— ' + esc(p.detail) + '</span>' : "");
    } else if (ev.kind === "decision_request") {
      body = '<b>' + esc(p.question || "") + '</b> <span style="color:var(--fg-2)">[' + (p.options || []).map((o) => esc(o.id)).join("|") + "]</span>";
    } else if (ev.kind === "decision_response") {
      body = '<b>chose</b> ' + esc(p.chosen_option_id || "") + ' <span style="color:var(--fg-2)">by ' + esc(p.responder || "") + '</span>';
    } else if (ev.kind === "worker_spawned") {
      body = '<b>' + esc(p.name || p.id) + '</b> <span style="color:var(--cyan)">' + esc(p.type || "") + '</span> ' + (p.pid ? 'pid ' + p.pid : "") + ' <span style="color:var(--fg-2)">' + esc(p.cwd || "") + '</span>';
    } else if (ev.kind === "worker_terminated") {
      body = '<b>' + esc(p.id) + '</b> ' + esc(p.reason || "") + (p.exit_code != null ? ' <span style="color:var(--fg-2)">exit ' + p.exit_code + '</span>' : "");
    } else if (ev.kind === "trust_scope_action_authorized") {
      body = '<span style="color:var(--violet)">' + esc(p.scope_id || "") + '</span> → <code>' + esc(p.tool || "") + '</code>';
    } else if (ev.kind === "error" || ev.kind === "worker_error") {
      body = '<span style="color:var(--red)">' + esc(p.message || "") + '</span>';
    } else if (typeof p === "object") {
      const keys = Object.keys(p).slice(0, 4);
      body = keys.map((k) => '<span style="color:var(--fg-2)">' + esc(k) + ':</span> ' + esc(typeof p[k] === "object" ? JSON.stringify(p[k]) : String(p[k]))).join(" ");
    } else {
      body = esc(String(p));
    }
    const corr = ev.correlation_id ? ' <span class="ev-corr">⤳' + esc(ev.correlation_id.slice(0, 8)) + '</span>' : "";
    return (
      '<div class="ev-row" data-event-id="' + esc(ev.id) + '" tabindex="0">' +
        '<div class="flex items-baseline gap-2">' +
          '<span class="ev-time">' + fmtTime(ev.at) + '</span>' +
          '<span style="color:' + color + ';width:18px;text-align:center">' + glyph + '</span>' +
          '<span class="ev-kind" style="color:' + color + '">' + esc(ev.kind) + '</span>' +
          '<span class="ev-agent">' + esc(ev.source_agent || "") + '</span>' +
          corr +
          '<span class="flex-1"></span>' +
        '</div>' +
        '<div class="pl-7">' + body + '</div>' +
      '</div>'
    );
  }

  function renderStream() {
    const root = $("event-stream");
    const visible = state.events.filter(matchesFilters);
    $("tail-count").textContent = visible.length + " / " + state.events.length + " events";
    if (!visible.length) {
      root.innerHTML = '<div class="px-3 py-4 text-xs" style="color:var(--fg-2)">no events yet (or filtered out)</div>';
      return;
    }
    root.innerHTML = visible.slice(0, 500).map(renderEventRow).join("");
    root.querySelectorAll(".ev-row").forEach((el) => {
      el.addEventListener("click", () => {
        const open = el.querySelector("pre.payload");
        if (open) { open.remove(); return; }
        const ev = state.events.find((e) => e.id === el.getAttribute("data-event-id"));
        if (!ev) return;
        const pre = document.createElement("pre");
        pre.className = "payload";
        pre.textContent = JSON.stringify(ev, null, 2);
        el.appendChild(pre);
      });
    });
  }

  // ----- Worker drill-in -----
  async function openWorker(id) {
    state.activeWorkerId = id;
    renderWorkers();
    const modal = $("modal");
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    $("modal-title").textContent = "Worker " + id;
    $("modal-body").innerHTML = '<div style="color:var(--fg-2)">loading…</div>';
    try {
      const r = await fetch("/dashboard/workers/" + encodeURIComponent(id));
      if (!r.ok) throw new Error("status " + r.status);
      const j = await r.json();
      renderWorkerDetail(j);
    } catch (err) {
      $("modal-body").innerHTML = '<div style="color:var(--red)">failed: ' + esc(err.message) + '</div>';
    }
  }
  function renderWorkerDetail(j) {
    const w = j.worker;
    $("modal-title").textContent = w.name + " — " + w.type;
    const meta = w.metadata || {};
    const metaRows = Object.keys(meta).map((k) => (
      '<tr><td style="color:var(--fg-2);padding-right:10px;vertical-align:top">' + esc(k) + '</td><td><code>' + esc(typeof meta[k] === "object" ? JSON.stringify(meta[k]) : String(meta[k])) + '</code></td></tr>'
    )).join("");
    const eventsHtml = (j.events || []).map(renderEventRow).join("");
    const toolCallsHtml = (j.tool_calls || []).length
      ? (j.tool_calls || []).map(renderEventRow).join("")
      : '<div class="px-3 py-2 text-xs" style="color:var(--fg-2)">no tool calls recorded</div>';
    $("modal-body").innerHTML = (
      '<div class="grid grid-cols-2 gap-4 mb-3 text-xs">' +
        '<div><span style="color:var(--fg-2)">id</span> <code>' + esc(w.id) + '</code></div>' +
        '<div><span style="color:var(--fg-2)">status</span> <span class="pill status-' + esc(w.status) + '">' + esc(w.status) + '</span></div>' +
        '<div><span style="color:var(--fg-2)">cwd</span> <code>' + esc(w.cwd) + '</code></div>' +
        '<div><span style="color:var(--fg-2)">started</span> ' + esc(w.started_at) + '</div>' +
        (w.pid ? '<div><span style="color:var(--fg-2)">pid</span> ' + w.pid + '</div>' : "") +
        (w.ended_at ? '<div><span style="color:var(--fg-2)">ended</span> ' + esc(w.ended_at) + ' (' + esc(w.termination_reason || "") + ')</div>' : "") +
      '</div>' +
      (metaRows ? '<div class="panel-h">metadata</div><table class="text-xs mb-3" style="width:100%">' + metaRows + '</table>' : "") +
      '<div class="panel-h">last 50 events</div>' +
      '<div class="scroll-y" style="max-height:240px;border:1px solid var(--border)">' + (eventsHtml || '<div class="px-3 py-2 text-xs" style="color:var(--fg-2)">no events</div>') + '</div>' +
      '<div class="panel-h mt-3">last 50 tool calls (command_run)</div>' +
      '<div class="scroll-y" style="max-height:240px;border:1px solid var(--border)">' + toolCallsHtml + '</div>'
    );
  }
  function closeModal() {
    $("modal").classList.add("hidden");
    $("modal").classList.remove("flex");
    state.activeWorkerId = null;
    renderWorkers();
  }

  // ----- Filters -----
  $("filter-text").addEventListener("input", (e) => { state.filterText = e.target.value; renderStream(); });
  $("filter-kind").addEventListener("change", (e) => { state.filterKind = e.target.value; renderKindOptions(); renderStream(); });
  $("filter-time").addEventListener("change", (e) => { state.filterTimeSec = Number(e.target.value); renderStream(); });

  // Workers panel filters
  document.querySelectorAll("#w-status-pills [data-w-status]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.getAttribute("data-w-status");
      if (state.workerFilterStatus.has(k)) state.workerFilterStatus.delete(k);
      else state.workerFilterStatus.add(k);
      btn.classList.toggle("on", state.workerFilterStatus.has(k));
      renderWorkers();
    });
  });
  $("w-filter-type").addEventListener("change", (e) => { state.workerFilterType = e.target.value; renderWorkers(); });
  $("w-filter-text").addEventListener("input", (e) => { state.workerFilterText = e.target.value; renderWorkers(); });

  // ----- Top bar buttons -----
  $("btn-pause").addEventListener("click", togglePause);
  $("btn-clear").addEventListener("click", () => { state.events = []; state.seenIds.clear(); renderStream(); });
  $("btn-export-json").addEventListener("click", () => { window.location.href = "/dashboard/export?format=json"; });
  $("btn-export-csv").addEventListener("click", () => { window.location.href = "/dashboard/export?format=csv"; });
  $("modal-close").addEventListener("click", closeModal);
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === "Escape") { closeModal(); }
    else if (e.key === " ") { e.preventDefault(); togglePause(); }
    else if (e.key === "c" || e.key === "C") { state.events = []; state.seenIds.clear(); renderStream(); }
    else if (e.key === "/") { e.preventDefault(); $("filter-text").focus(); }
  });
  function togglePause() {
    state.paused = !state.paused;
    $("btn-pause").textContent = state.paused ? "Resume" : "Pause";
    $("btn-pause").setAttribute("aria-pressed", String(state.paused));
    $("live-dot").classList.toggle("paused", state.paused);
    $("live-dot").classList.toggle("live", !state.paused);
    if (!state.paused) renderStream();
  }

  // ----- Live SSE tail -----
  let es = null;
  function connectStream() {
    if (es) try { es.close(); } catch {}
    es = new EventSource("/dashboard/stream");
    es.addEventListener("event", (m) => {
      try { pushEvent(JSON.parse(m.data)); } catch {}
    });
    es.addEventListener("ping", () => {});
    es.onerror = () => {
      $("live-dot").classList.remove("live");
      // EventSource reconnects on its own; we just nudge the status.
      refreshStatus();
    };
    es.onopen = () => { if (!state.paused) $("live-dot").classList.add("live"); };
  }

  // ----- Initial load + polling -----
  async function bootstrap() {
    await Promise.all([refreshStatus(), refreshWorkers(), refreshDecisions()]);
    // Pull a recent history so the tail isn't empty on first load.
    try {
      const r = await fetch("/dashboard/events?limit=200", { cache: "no-store" });
      const j = await r.json();
      for (const ev of (j.events || [])) pushEvent(ev);
    } catch {}
    connectStream();
  }
  bootstrap();
  setInterval(refreshStatus, 5000);
  setInterval(refreshWorkers, 5000);
  setInterval(refreshDecisions, 2000);
  // Cheap re-render every 5s so relative ages tick forward without re-fetching workers.
  setInterval(() => { if (state.workers.length) renderWorkers(); }, 5000);
})();
</script>

<!-- Spec 49 Layer 2 — Steward chat panel (right rail).
     Posts steward_prompt events; subscribes to per-correlation_id SSE for
     thinking/tool_call/response/usage events. Renders distinct styling per
     event kind so the User can follow the Steward's run live. -->
<style>
  .steward-panel {
    position: fixed;
    right: 12px;
    bottom: 12px;
    width: 360px;
    max-height: 70vh;
    background: var(--bg-2, #1a1d24);
    border: 1px solid var(--accent, #4ade80);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 6px 24px rgba(0,0,0,0.3);
    font: 12px/1.5 -apple-system, system-ui, sans-serif;
    color: var(--fg, #e5e7eb);
    z-index: 50;
  }
  .steward-panel header { padding: 6px 10px; border-bottom: 1px solid #3a3f4a; display: flex; justify-content: space-between; align-items: center; }
  .steward-panel header strong { color: var(--accent, #4ade80); }
  .steward-panel header button { background: transparent; border: 0; color: var(--fg-2, #9ca3af); cursor: pointer; }
  .steward-log { flex: 1; overflow-y: auto; padding: 8px 10px; min-height: 200px; }
  .steward-log .msg { margin-bottom: 8px; }
  .steward-log .msg .label { display: inline-block; min-width: 64px; color: var(--fg-2, #9ca3af); }
  .steward-log .msg.user .label { color: #60a5fa; }
  .steward-log .msg.thinking .label { color: #fbbf24; }
  .steward-log .msg.tool .label { color: #f472b6; }
  .steward-log .msg.response .label { color: #4ade80; }
  .steward-log .msg.usage .label { color: #9ca3af; }
  .steward-input { display: flex; gap: 6px; padding: 6px; border-top: 1px solid #3a3f4a; }
  .steward-input input { flex: 1; background: #0f1115; color: var(--fg, #e5e7eb); border: 1px solid #3a3f4a; border-radius: 4px; padding: 5px 8px; font: inherit; }
  .steward-input button { background: var(--accent, #4ade80); border: 0; color: #0f1115; font-weight: bold; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
  .steward-collapsed .steward-log, .steward-collapsed .steward-input { display: none; }
</style>

<aside class="steward-panel" id="steward-panel" aria-label="Steward chat">
  <header>
    <strong>Steward</strong>
    <button id="steward-toggle" aria-label="Toggle">_</button>
  </header>
  <div class="steward-log" id="steward-log"></div>
  <form class="steward-input" id="steward-form">
    <input type="text" id="steward-input" placeholder="Ask the Steward…" autocomplete="off">
    <button type="submit">Send</button>
  </form>
</aside>

<script>
(function() {
  const log = document.getElementById('steward-log');
  const form = document.getElementById('steward-form');
  const input = document.getElementById('steward-input');
  const panel = document.getElementById('steward-panel');
  const toggle = document.getElementById('steward-toggle');
  let activeEs = null;

  function appendMsg(kind, label, body) {
    const row = document.createElement('div');
    row.className = 'msg ' + kind;
    const lbl = document.createElement('span');
    lbl.className = 'label';
    lbl.textContent = label;
    const txt = document.createElement('span');
    txt.textContent = ' ' + body;
    row.appendChild(lbl);
    row.appendChild(txt);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  toggle?.addEventListener('click', () => {
    panel.classList.toggle('steward-collapsed');
  });

  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = (input.value || '').trim();
    if (!text) return;
    input.value = '';
    appendMsg('user', 'you', text);
    let body;
    try {
      const res = await fetch('/dashboard/steward/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      body = await res.json();
    } catch (err) {
      appendMsg('thinking', 'error', String(err));
      return;
    }
    if (!body.ok) {
      appendMsg('thinking', 'error', body.error || 'unknown error');
      return;
    }
    const cid = body.correlation_id;
    if (activeEs) { try { activeEs.close(); } catch (e) {} }
    activeEs = new EventSource('/dashboard/steward/responses?correlation_id=' + encodeURIComponent(cid));
    activeEs.addEventListener('steward_thinking', (e) => {
      try { const ev = JSON.parse(e.data); appendMsg('thinking', 'thinking', (ev.payload && ev.payload.text) || '…'); } catch (err) {}
    });
    activeEs.addEventListener('steward_tool_call', (e) => {
      try { const ev = JSON.parse(e.data); appendMsg('tool', 'tool', (ev.payload && ev.payload.tool) || '?'); } catch (err) {}
    });
    activeEs.addEventListener('steward_response', (e) => {
      try { const ev = JSON.parse(e.data); appendMsg('response', 'steward', (ev.payload && ev.payload.text) || ''); } catch (err) {}
    });
    activeEs.addEventListener('steward_usage', (e) => {
      try {
        const ev = JSON.parse(e.data);
        const p = ev.payload || {};
        appendMsg('usage', 'usage', '$' + ((p.cost_usd || 0).toFixed(4)) + ' (in=' + (p.input_tokens||0) + ', out=' + (p.output_tokens||0) + ')');
      } catch (err) {}
    });
  });
})();
</script>
</body>
</html>
`;
