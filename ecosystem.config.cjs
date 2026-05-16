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
      // Auto-restart with bounds: 3 restarts max, 30s gap. Past that, PM2
      // stops respawning — gives a clear signal something's actually broken
      // rather than masking it with infinite respawn loops.
      max_restarts: 3,
      restart_delay: 30000,
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
  ],
};
