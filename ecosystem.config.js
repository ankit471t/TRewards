// ═══════════════════════════════════════════════════════════
// TRewards PM2 Ecosystem Config - ecosystem.config.js
// 
// Usage:
//   pm2 start ecosystem.config.js
//   pm2 stop all
//   pm2 restart trewards-backend
//   pm2 logs trewards-backend
//   pm2 monit
// ═══════════════════════════════════════════════════════════

module.exports = {
  apps: [
    {
      name: 'trewards-backend',
      script: 'server.js',
      instances: 1,           // SQLite requires single instance
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '256M',
      restart_delay: 5000,
      max_restarts: 10,
      
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      
      // Graceful shutdown
      kill_timeout: 5000,
      listen_timeout: 3000,
    },
    {
      name: 'trewards-bot',
      script: 'bot.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '128M',
      restart_delay: 5000,
      
      env_production: {
        NODE_ENV: 'production',
        BOT_PORT: 3001,
      },
      
      out_file: './logs/bot-out.log',
      error_file: './logs/bot-error.log',
    }
  ]
};