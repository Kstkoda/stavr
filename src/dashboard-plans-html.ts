// src/dashboard-plans-html.ts
//
// `/dashboard/plans` page — food-label approval card for BOMs. Same vanilla
// HTML + Tailwind CDN pattern as the main dashboard. No build step.
//
// Backend endpoints this page calls:
//   GET  /dashboard/plans/list
//   GET  /dashboard/plans/:bomId
//   POST /dashboard/plans/:bomId/respond
//   GET  /dashboard/stream  (filtered for bom_* events)

export const DASHBOARD_PLANS_HTML = String.raw`<!doctype html>
<html lang="en" class="dark">
<head>
  <meta charset="utf-8" />
  <title>Stavr — Plans</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    :root { color-scheme: dark; --bg-0:#0a0d12; --bg-1:#11151c; --bg-2:#161b25; --line:#1f2937; --text:#e5e7eb; --muted:#94a3b8; }
    body { background: var(--bg-0); color: var(--text); font-family: ui-sans-serif, system-ui, sans-serif; }
    .card { background: var(--bg-1); border:1px solid var(--line); border-radius: 12px; }
    .chip { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:11px; line-height:18px; background: var(--bg-2); border:1px solid var(--line); color: var(--muted); }
    .chip.proposed { color:#fbbf24; border-color:#7c5e0a; }
    .chip.running  { color:#60a5fa; border-color:#1e3a8a; }
    .chip.done     { color:#34d399; border-color:#065f46; }
    .chip.failed   { color:#f87171; border-color:#7f1d1d; }
    .chip.cancelled, .chip.rejected { color:#a3a3a3; border-color:#374151; }
    .chip.risk { color:#c4b5fd; border-color:#4c1d95; }
    .btn { padding:6px 12px; border-radius:8px; font-size:13px; font-weight:500; border:1px solid var(--line); background:var(--bg-2); color:var(--text); cursor:pointer; }
    .btn.primary { background:#1e40af; border-color:#1e3a8a; color:#dbeafe; }
    .btn.danger  { background:#7f1d1d; border-color:#7f1d1d; color:#fee2e2; }
    .btn:hover { filter: brightness(1.1); }
    .step-row { padding:8px 12px; border-bottom:1px solid var(--line); display:grid; grid-template-columns: 40px 1fr 140px 100px; gap:8px; align-items:center; font-size:13px; }
    .step-row:last-child { border-bottom: none; }
    .muted { color: var(--muted); }
    a { color: #60a5fa; }
  </style>
</head>
<body class="min-h-screen">
  <header class="border-b border-[color:var(--line)] px-6 py-3 flex items-center gap-4">
    <h1 class="text-base font-semibold">Stavr — Plans</h1>
    <nav class="flex gap-3 text-sm">
      <a href="/dashboard">Dashboard</a>
      <a href="/dashboard/plans" class="font-semibold">Plans</a>
    </nav>
    <span class="muted text-xs ml-auto" id="liveStatus">connecting…</span>
  </header>

  <main class="px-6 py-4 grid grid-cols-1 md:grid-cols-[360px_1fr] gap-4">
    <section>
      <h2 class="text-xs uppercase tracking-wide text-[color:var(--muted)] mb-2">Counters</h2>
      <div class="card p-3 grid grid-cols-2 gap-2 mb-4 text-sm">
        <div><span class="muted">Proposed</span> <span id="cntProposed" class="float-right font-semibold">0</span></div>
        <div><span class="muted">Running</span> <span id="cntRunning" class="float-right font-semibold">0</span></div>
        <div><span class="muted">Done</span> <span id="cntDone" class="float-right font-semibold">0</span></div>
        <div><span class="muted">Failed</span> <span id="cntFailed" class="float-right font-semibold">0</span></div>
      </div>
      <h2 class="text-xs uppercase tracking-wide text-[color:var(--muted)] mb-2">BOMs</h2>
      <div id="bomList" class="space-y-2 text-sm">
        <div class="muted">Loading…</div>
      </div>
    </section>

    <section>
      <h2 class="text-xs uppercase tracking-wide text-[color:var(--muted)] mb-2">Details</h2>
      <div id="bomDetail" class="card p-4 text-sm">
        <div class="muted">Select a BOM on the left to see its food-label approval card.</div>
      </div>
    </section>
  </main>

<script>
'use strict';
const state = { focus: null, boms: new Map() };

function statusChip(s) {
  return '<span class="chip ' + s + '">' + s + '</span>';
}

function fmtUsd(n) { return '$' + (Number(n)||0).toFixed(4); }

async function loadBoms() {
  const res = await fetch('/dashboard/plans/list');
  if (!res.ok) return;
  const body = await res.json();
  state.boms = new Map((body.boms || []).map(b => [b.id, b]));
  renderList();
  refreshCounters();
  if (state.focus && state.boms.has(state.focus)) loadDetail(state.focus);
}

function refreshCounters() {
  const counts = { proposed:0, running:0, done:0, failed:0 };
  for (const b of state.boms.values()) {
    const today = new Date().toISOString().slice(0,10);
    if (b.status === 'proposed') counts.proposed++;
    else if (b.status === 'running') counts.running++;
    else if (b.status === 'done' && (b.ended_at||'').startsWith(today)) counts.done++;
    else if (b.status === 'failed' && (b.ended_at||'').startsWith(today)) counts.failed++;
  }
  document.getElementById('cntProposed').textContent = counts.proposed;
  document.getElementById('cntRunning').textContent = counts.running;
  document.getElementById('cntDone').textContent = counts.done;
  document.getElementById('cntFailed').textContent = counts.failed;
}

function renderList() {
  const root = document.getElementById('bomList');
  if (state.boms.size === 0) {
    root.innerHTML = '<div class="muted">No BOMs yet.</div>';
    return;
  }
  const items = [...state.boms.values()].sort((a,b) => (b.proposed_at||'').localeCompare(a.proposed_at||''));
  root.innerHTML = items.map(b => {
    const goal = (b.goal || '').slice(0, 80);
    return [
      '<div class="card p-3 cursor-pointer" data-bom="' + b.id + '">',
      '  <div class="flex items-center justify-between gap-2 mb-1">',
      '    ' + statusChip(b.status),
      '    <span class="muted text-[11px]">' + (b.steps_done||0) + '/' + (b.steps_total||0) + ' steps</span>',
      '  </div>',
      '  <div class="truncate">' + escapeHtml(goal) + '</div>',
      '  <div class="muted text-[11px] mt-1">' + fmtUsd(b.cost_estimate) + ' est · ~' + (b.duration_sec||0) + 's</div>',
      '</div>',
    ].join('');
  }).join('');
  root.querySelectorAll('[data-bom]').forEach(el => {
    el.addEventListener('click', () => loadDetail(el.getAttribute('data-bom')));
  });
}

async function loadDetail(bomId) {
  state.focus = bomId;
  const res = await fetch('/dashboard/plans/' + encodeURIComponent(bomId));
  if (!res.ok) {
    document.getElementById('bomDetail').innerHTML = '<div class="muted">Not found.</div>';
    return;
  }
  const body = await res.json();
  renderDetail(body.bom, body.steps);
}

function renderDetail(bom, steps) {
  const root = document.getElementById('bomDetail');
  if (!bom) { root.innerHTML = '<div class="muted">Not found.</div>'; return; }
  const envelope = (bom.risk_envelope || []).map(r => '<span class="chip risk">' + r + '</span>').join(' ');
  const stepRows = (steps || []).map(s => [
    '<div class="step-row">',
    '  <div class="muted">#' + s.step_no + '</div>',
    '  <div>',
    '    <div>' + escapeHtml(s.title) + '</div>',
    '    <div class="muted text-[11px]">' + escapeHtml(s.capability) + ' · ' + escapeHtml(s.risk_class) + ' · ' + escapeHtml(s.model) + ' · brick=' + escapeHtml(s.brick_id||'-') + '</div>',
    '  </div>',
    '  <div>' + statusChip(s.status) + '</div>',
    '  <div class="muted text-right">' + fmtUsd(s.cost_estimate) + '</div>',
    '</div>',
  ].join('')).join('');

  const approvalBox = bom.status === 'proposed' ? [
    '<div class="mt-4 flex gap-2">',
    '  <button class="btn primary" id="approveBtn">Approve plan</button>',
    '  <button class="btn danger" id="rejectBtn">Reject</button>',
    '</div>',
  ].join('') : '';

  root.innerHTML = [
    '<div class="flex items-start gap-3 mb-3">',
    '  <h3 class="font-semibold text-base flex-1">' + escapeHtml(bom.goal) + '</h3>',
    '  ' + statusChip(bom.status),
    '</div>',
    '<div class="flex flex-wrap gap-2 text-xs muted mb-3">',
    '  <span>profile: ' + escapeHtml(bom.profile_mode) + '</span>',
    '  <span>· ' + (bom.steps_done||0) + '/' + (bom.steps_total||0) + ' done</span>',
    '  <span>· estimated ' + fmtUsd(bom.cost_estimate) + ' (max ' + fmtUsd(bom.cost_max) + ')</span>',
    '  <span>· ETA ~' + (bom.duration_sec||0) + 's</span>',
    '</div>',
    '<div class="mb-3"><span class="text-xs muted mr-2">Risk envelope:</span>' + envelope + '</div>',
    '<div class="card p-0 overflow-hidden">' + stepRows + '</div>',
    approvalBox,
  ].join('');

  const approve = document.getElementById('approveBtn');
  if (approve) approve.addEventListener('click', () => respond(bom.id, 'approve'));
  const reject = document.getElementById('rejectBtn');
  if (reject) reject.addEventListener('click', () => respond(bom.id, 'reject'));
}

async function respond(bomId, verdict) {
  const res = await fetch('/dashboard/plans/' + encodeURIComponent(bomId) + '/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verdict }),
  });
  if (!res.ok) {
    alert('failed: ' + res.status);
    return;
  }
  await loadBoms();
}

function escapeHtml(s) {
  return String(s||'').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function openStream() {
  const es = new EventSource('/dashboard/stream');
  es.addEventListener('event', (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      if (typeof ev.kind === 'string' && ev.kind.startsWith('bom_')) {
        document.getElementById('liveStatus').textContent = 'live · last: ' + ev.kind;
        void loadBoms();
      }
    } catch { /* drop */ }
  });
  es.addEventListener('ping', () => {
    document.getElementById('liveStatus').textContent = 'live';
  });
  es.onerror = () => { document.getElementById('liveStatus').textContent = 'reconnecting…'; };
}

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  state.focus = params.get('focus');
  void loadBoms();
  openStream();
});
</script>
</body>
</html>`;
