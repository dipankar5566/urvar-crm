module.exports = {
  apps: [
    {
      name: "urvar-crm",
      cwd: "D:/urvar-crm",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3002",
      exec_mode: "fork",
      instances: 1,
      watch: false,
      max_memory_restart: "2G",
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 4000,
      env: {
        NODE_ENV: "production",
      },
      out_file: "D:/urvar-crm/logs/crm-out.log",
      error_file: "D:/urvar-crm/logs/crm-error.log",
    },
    {
      // AI Voice Agent media server (Phase 0+) — standalone WS process, not
      // part of the Next.js app. Holds the wss:// endpoints Plivo's <Stream>
      // and the browser's live-assist panel connect to. See voice-agent/server.ts.
      name: "urvar-voice-agent",
      cwd: "D:/urvar-crm",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "voice-agent/server.ts",
      exec_mode: "fork",
      instances: 1,
      watch: false,
      max_memory_restart: "1G",
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 4000,
      env: {
        NODE_ENV: "production",
        // The PM2 Windows service runs this under a different account than
        // the interactive ADMIN user (confirmed via a startup crash: tsx's
        // IPC-server bootstrap tried to mkdir under ADMIN's AppData\Local\Temp
        // and got EPERM, path showed "...Temp\tsx-LOCAL SERVICE"). Point
        // tsx's scratch dir at a location every Windows service account can
        // write to instead.
        TEMP: "C:\\Windows\\Temp",
        TMP: "C:\\Windows\\Temp",
      },
      out_file: "D:/urvar-crm/logs/voice-agent-out.log",
      error_file: "D:/urvar-crm/logs/voice-agent-error.log",
    },
  ],
};
