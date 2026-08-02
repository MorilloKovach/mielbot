module.exports = {
  apps: [{
    name: "mielbot",
    script: "./src/index.js",
    watch: false,
    max_memory_restart: "1G",
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    },
    // Opciones para manejar los errores silenciosos de Playwright
    error_file: "./logs/err.log",
    out_file: "./logs/out.log",
    merge_logs: true,
    time: true
  }]
}
