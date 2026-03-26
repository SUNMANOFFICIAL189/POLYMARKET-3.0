/**
 * PM2 Ecosystem config for MiroFish services.
 * Run with: pm2 start mirofish/ecosystem.config.cjs
 *
 * Two services:
 *   1. mirofish-scanner: Runs swarm simulations every 90 minutes
 *   2. mirofish-bridge: HTTP API bridge for the bot to query results
 */
module.exports = {
  apps: [
    {
      name: 'mirofish-scanner',
      script: 'scanner.py',
      cwd: './mirofish',
      interpreter: 'python3',
      args: '--daemon',
      env: {
        PYTHONUNBUFFERED: '1',
      },
      log_file: './mirofish/logs/scanner.log',
      error_file: './mirofish/logs/scanner-error.log',
      out_file: './mirofish/logs/scanner-out.log',
      max_restarts: 10,
      restart_delay: 30000,  // 30s between restarts
      autorestart: true,
    },
    {
      name: 'mirofish-bridge',
      script: 'bridge.py',
      cwd: './mirofish',
      interpreter: 'python3',
      env: {
        PYTHONUNBUFFERED: '1',
      },
      log_file: './mirofish/logs/bridge.log',
      error_file: './mirofish/logs/bridge-error.log',
      out_file: './mirofish/logs/bridge-out.log',
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    },
  ],
};
