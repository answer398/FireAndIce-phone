import 'dotenv/config';
import os from 'node:os';
import { LIMITS } from '../../common/protocol/events.mjs';

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function listEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV ?? 'production',
  host: process.env.HOST ?? '0.0.0.0',
  port: intEnv('PORT', 8080),
  /** Origins allowed to open the socket. Empty array = same-origin only. */
  allowedOrigins: listEnv('ALLOWED_ORIGINS', []),
  /** How long a disconnected SEAT is held before the slot is truly released. */
  seatGraceMs: intEnv('SEAT_GRACE_MS', LIMITS.SEAT_GRACE_MS),
  /** Ready→start countdown length. */
  countdownMs: intEnv('COUNTDOWN_MS', LIMITS.COUNTDOWN_MS),
  /** Unaccepted swap-offer lifetime. */
  swapOfferTtlMs: intEnv('SWAP_OFFER_TTL_MS', LIMITS.SWAP_OFFER_TTL_MS),
  /** Length of the join code (see LIMITS in the shared protocol). */
  roomCodeLength: intEnv('ROOM_CODE_LENGTH', LIMITS.ROOM_CODE_LENGTH),
  /** How long a room nobody joins (or refills) lives, in ms. */
  emptyRoomTtlMs: intEnv('EMPTY_ROOM_TTL_MS', LIMITS.EMPTY_ROOM_TTL_MS),
  /** Interval for the expired-seat / dead-room safety sweep. */
  sweepIntervalMs: intEnv('SWEEP_INTERVAL_MS', LIMITS.SWEEP_INTERVAL_MS),
  /** Maximum simultaneously existing rooms (abuse guard). */
  maxRooms: intEnv('MAX_ROOMS', LIMITS.MAX_ROOMS),
  /** Rate limits, per client IP: room creations and join/rejoin per minute. */
  rateCreatePerMin: intEnv('RATE_CREATE_PER_MIN', 6),
  rateJoinPerMin: intEnv('RATE_JOIN_PER_MIN', 20),
  /** Behind a reverse proxy (nginx/Caddy) that sets X-Forwarded-*. */
  trustProxy: process.env.TRUST_PROXY === '1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

export const isDev = config.env === 'development';

export function localAddresses() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) result.push(iface.address);
    }
  }
  return result;
}
