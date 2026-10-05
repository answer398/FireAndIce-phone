/**
 * Client-side configuration for the multiplayer extension layer.
 *
 * The layer lives next to the games (no build step), so configuration is a
 * plain module. Override via URL query (`?mpDebug=1`) for diagnostics.
 */

export const config = {
  /** Socket.IO namespace path served by the Node server. */
  socketPath: '/socket.io',
  /** Where the shared protocol constants live (same app serves them). */
  protocolUrl: '/common/protocol/events.mjs',
  /** WebRTC ICE servers. Add a TURN server for strict-NAT deployments. */
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
  /** Video capture frame rate for the host -> guest stream. */
  videoFps: 30,
  /** Heartbeat for guest input frames even when nothing changed (ms). */
  inputHeartbeatMs: 1000,
  /** Status broadcast throttle while values keep changing (ms). */
  statusThrottleMs: 250,
  /** Latency probe interval (ms). */
  pingIntervalMs: 5000,
};

export const urlFlags = (() => {
  const params = new URLSearchParams(location.search);
  return {
    room: params.get('room'),
    debug: params.get('mpDebug') === '1',
    /** `?mp=off` hard-disables the layer (troubleshooting escape hatch). */
    off: params.get('mp') === 'off',
  };
})();
