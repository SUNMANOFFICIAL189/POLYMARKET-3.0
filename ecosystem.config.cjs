module.exports = {
  apps: [
    {
      name: "polymarket-bot",
      script: "npx",
      args: "tsx src/index.ts",
      cwd: "/opt/polymarket-bot",
      env: {
        NODE_ENV: "production"
      },
      max_memory_restart: "500M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/opt/polymarket-bot/logs/bot-error.log",
      out_file: "/opt/polymarket-bot/logs/bot-out.log",
      merge_logs: true,
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: "10s"
    },
    {
      name: "polymarket-dashboard",
      script: "npm",
      args: "start",
      cwd: "/opt/polymarket-bot/dashboard",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      },
      max_memory_restart: "300M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "/opt/polymarket-bot/logs/dashboard-error.log",
      out_file: "/opt/polymarket-bot/logs/dashboard-out.log",
      merge_logs: true
    }
  ]
};
