import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { RoomManager } from './rooms/roomManager.js';
import { createSocketServer } from './realtime/socketServer.js';

const log = (...args) => {
  if (config.logLevel !== 'silent') console.log('[server]', ...args);
};

const app = createApp();
const httpServer = http.createServer(app);

const roomManager = new RoomManager({
  seatGraceMs: config.seatGraceMs,
  countdownMs: config.countdownMs,
  swapOfferTtlMs: config.swapOfferTtlMs,
  emptyTtlMs: config.emptyRoomTtlMs,
  codeLength: config.roomCodeLength,
  maxRooms: config.maxRooms,
  sweepIntervalMs: config.sweepIntervalMs,
  log,
});

const realtime = createSocketServer(httpServer, {
  roomManager,
  allowedOrigins: config.allowedOrigins,
  log,
  trustProxy: config.trustProxy,
  rateLimits: {
    createMax: config.rateCreatePerMin,
    joinMax: config.rateJoinPerMin,
    messageMax: config.rateMessagePerMin,
  },
});

if (config.trustProxy) {
  app.set('trust proxy', 1);
}

httpServer.listen(config.port, config.host, () => {
  console.log(`[server] ${config.env} mode, listening on ${config.host}:${config.port}`);
  if (config.publicUrl) console.log(`[server] public URL: ${config.publicUrl}`);
  console.log('[server] games:', roomManager.gameIds.join(', ') || '(none found)');
  console.log('[server] rooms:', roomManager.stats().rooms);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[server] ${signal} received, shutting down`);
    realtime.stop();
    roomManager.stop();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
