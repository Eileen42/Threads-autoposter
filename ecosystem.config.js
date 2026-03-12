const path = require('path');

module.exports = {
  apps: [
    {
      name: 'threads-autoposter',
      script: path.join(__dirname, 'dist', 'index.js'),
      interpreter: 'node',
      interpreter_args: '--no-warnings=ExperimentalWarning',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
      out_file: path.join(__dirname, 'logs', 'out.log'),
      error_file: path.join(__dirname, 'logs', 'error.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
