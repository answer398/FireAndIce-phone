import http from 'node:http';
import { createApp } from './app.js';
import { config, isDev, localAddresses } from './config.js';
import { RoomManager } from './rooms/roomManager.js';
import { createSocketServer } from './realtime/socketServer.js';

const log = (...args) => {
  if (isDev || config.logLevel !== 'debug') console.log('[server]', ...args);
};

const app = createApp();
const httpServer = http.createServer(app);

const roomManager = new RoomManager({
  graceMs: config.roomGraceMs,
  emptyTtlMs: config.emptyRoomTtlMs,
  codeLength: config.roomCodeLength,
  sweepIntervalMs: config.sweepIntervalMs,
  log,
});

createSocketServer(httpServer, {
  roomManager,
  allowedOrigins: config.allowedOrigins,
  log,
});

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

httpServer.listen(config.port, config.host, () => {
  const base = (host) => `http://${host}:${config.port}`;
  console.log(`[server] ${config.env} mode, listening on ${config.host}:${config.port}`);
  console.log(`[server]   local:    ${base('127.0.0.1')}`);
  for (const addr of localAddresses()) {
    console.log(`[server]   network:  ${base(addr)}`);
  }
  console.log('[server] rooms:', roomManager.stats().rooms);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal} received, shutting down`);
    roomManager.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
