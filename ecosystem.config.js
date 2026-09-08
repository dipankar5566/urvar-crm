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
  ],
};
