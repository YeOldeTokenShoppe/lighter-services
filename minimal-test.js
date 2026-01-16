const https = require('https');

console.log('🚀 Minimal service starting...');

// Simple health check endpoint
const server = require('http').createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Service is running!\n');
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`✅ Server running on port ${port}`);
});

// Keep alive
setInterval(() => {
  console.log('❤️ Service alive:', new Date().toISOString());
}, 30000);