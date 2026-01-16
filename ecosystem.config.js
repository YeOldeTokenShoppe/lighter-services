// PM2 configuration for production deployment
module.exports = {
  apps: [{
    name: 'lighter-service',
    script: './lighter-background-service.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    env_development: {
      NODE_ENV: 'development',
      LOG_LEVEL: 'debug'
    },
    log_file: './logs/lighter-service.log',
    error_file: './logs/lighter-error.log',
    out_file: './logs/lighter-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm Z',
    merge_logs: true,
    // Restart policy
    restart_delay: 5000,
    max_restarts: 10,
    min_uptime: '10s'
  }]
};