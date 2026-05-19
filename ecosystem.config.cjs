// PM2 ecosystem config for stavr.
//
// Runs the FULL daemon (`stavr daemon start`) — this is the only entry point
// that calls startDaemonForeground, which wires the memory poller, retention
// scheduler, steward loop, and worker watchdog. The lighter `stavr start`
// command skips all of that and would leave the OOM leak unfixed at runtime
// (this bit us on 2026-05-16 — events table grew unbounded even though the
// retention code was compiled into dist).
//
// Usage:
//   pm2 delete stavr 2>$null    # clean any prior entry
//   pm2 start ecosystem.config.cjs
//   pm2 logs stavr -f           # live tail
//   pm2 save                    # persist across reboot (after `pm2 startup`)
//
// Node flags raise the heap ceiling + capture diagnostics on fatal error:
//   --max-old-space-size=8192      raise heap ceiling (defense; retention is the real fix)
//   --heapsnapshot-near-heap-limit=2  auto-dump up to 2 heap snapshots before next OOM
//   --report-on-fatalerror         Diagnostic Report on fatal errors (cross-platform)
//   --report-directory=...         where reports land

module.exports = {
  apps: [
    {
      name: 'stavr',
      script: 'dist/cli.js',
      // Full daemon mode — NOT bare `start`. The lighter `stavr start` only
      // mounts transports + broker, skipping memory poller + retention.
      args: ['daemon', 'start'],
      node_args: [
        '--max-old-space-size=8192',
        '--heapsnapshot-near-heap-limit=2',
        '--report-on-fatalerror',
        '--report-directory=./tmp/diag-reports',
      ],
      cwd: __dirname,
      // Diagnostic endpoints (POST /debug/heap-snapshot, /debug/cpu-profile,
      // /debug/diagnostic-report). Locked behind this flag � daemon returns
      // 404 (not 403) when unset to avoid leaking endpoint existence.
      // Personal-machine + loopback-only (ADR-006) makes always-on safe.
      env: {
        STAVR_DEBUG_ENABLED: "1",
      },
      // Auto-restart with bounds: 5 restarts max, 30s gap, exponential
      // backoff past that. Past that, PM2 stops respawning — gives a
      // clear signal something's actually broken rather than masking it
      // with infinite respawn loops.
      //
      // v0.6.x fix — operator observed `tmp/pm2-stavr.err.log` filling
      // with "daemon already running" / EADDRINUSE entries every ~30s
      // even after the daemon had crashed dozens of times. Cause: PM2's
      // default `min_uptime` is 1000ms, which a fast EADDRINUSE-exit
      // satisfies, so the max_restarts counter never tripped. Raising
      // min_uptime to 30000 means the process has to actually stay alive
      // 30s before PM2 considers the restart "successful" and resets the
      // counter — fast crashes accumulate properly. Add
      // exp_backoff_restart_delay so consecutive fast failures back off
      // instead of slamming the port.
      max_restarts: 5,
      min_uptime: 30000,
      restart_delay: 30000,
      exp_backoff_restart_delay: 5000,
      // Don't auto-restart on clean exit (graceful shutdown is intentional).
      autorestart: true,
      // Send SIGTERM and wait this long for graceful shutdown before SIGKILL.
      kill_timeout: 10000,
      // Log files. PM2 rotates these via `pm2 install pm2-logrotate` if you want.
      out_file: './tmp/pm2-stavr.out.log',
      error_file: './tmp/pm2-stavr.err.log',
      merge_logs: true,
      time: true, // prepend ISO timestamp to each log line
      // Memory ceiling — restart if heap goes wild (defense in depth alongside
      // --max-old-space-size). 7000MB is safely below the 8192 heap cap.
      max_memory_restart: '7000M',
    },
    // v0.5 P3 — Steward agent subprocess (ADR-032 §Decision 1).
    // Lives ALONGSIDE the in-process Steward during the P5 shadow window. The
    // daemon continues to do real planning via wireV02Subsystem; this entry
    // runs the new ModelRuntime-backed planner in parallel, writing planned
    // BOMs to the parity log (P5) but NOT dispatching. Cutover (delete
    // in-process planner, swap the daemon call site) is a separate, manually
    // gated commit.
    {
      name: 'stavr-steward-agent',
      script: 'dist/steward-agent/main.js',
      args: ['--daemon-url', 'http://127.0.0.1:7777'],
      cwd: __dirname,
      // Lower heap ceiling than the daemon — Steward shouldn't accumulate
      // events; if it climbs near the cap that's a planner-context retention
      // bug worth paging on rather than masking.
      node_args: ['--max-old-space-size=2048'],
      max_restarts: 5,
      min_uptime: 30000,
      restart_delay: 30000,
      exp_backoff_restart_delay: 5000,
      autorestart: true,
      kill_timeout: 10000,
      max_memory_restart: '2000M',
      out_file: './tmp/pm2-steward.out.log',
      error_file: './tmp/pm2-steward.err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
