#!/usr/bin/env node

const http = require('node:http');

const port = Number(process.argv[2] ?? '');
const timeoutMs = Number(process.argv[3] ?? '1500');

if (!Number.isInteger(port) || port <= 0) {
  console.error('Usage: node scripts/check-health.cjs <port> [timeoutMs]');
  process.exit(2);
}

const request = http.get(
  {
    host: '127.0.0.1',
    port,
    path: '/health',
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500,
  },
  (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
    });
    response.on('end', () => {
      if (response.statusCode !== 200) {
        process.exit(1);
      }

      try {
        const payload = JSON.parse(body);
        process.exit(payload?.status === 'ok' ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  },
);

request.on('error', () => {
  process.exit(1);
});

request.on('timeout', () => {
  request.destroy();
  process.exit(1);
});