import 'dotenv/config';
import os from 'node:os';

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
  /** Room lifetime after the host disconnects, before the room is destroyed. */
  roomGraceMs: intEnv('ROOM_GRACE_MS', 60_000),
  /** Length of the 4-character join code (see LIMITS in the shared protocol). */
  roomCodeLength: intEnv('ROOM_CODE_LENGTH', 4),
  /** How long a created-but-never-joined room lives, in ms. */
  emptyRoomTtlMs: intEnv('EMPTY_ROOM_TTL_MS', 10 * 60_000),
  /** Interval for destroying expired rooms. */
  sweepIntervalMs: intEnv('SWEEP_INTERVAL_MS', 30_000),
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
