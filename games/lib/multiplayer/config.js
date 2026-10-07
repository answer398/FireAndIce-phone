/**
 * Client-side configuration for the multiplayer extension layer.
 *
 * The layer lives next to the games (no build step), so configuration is a
 * plain module. Diagnostics are enabled only in non-production builds.
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
  /**
   * Legacy WebRTC video relay (host picture → guest). The guest now
   * simulates locally and follows host snapshots, so the relay is OFF by
   * default; enable only for debugging or as a degraded-mode fallback.
   */
  videoRelay: false,
  /** Video capture frame rate for the host -> guest stream. */
  videoFps: 30,
  /**
   * Host -> guest world snapshot rate (Hz). The guest simulates locally, so
   * this only bounds correction latency: 10–20Hz is the useful band — below
   * 10 the guest drifts visibly between corrections, above 20 the JSON costs
   * more than the corrections buy.
   */
  snapshotHz: 15,
  /** Heartbeat for guest input frames even when nothing changed (ms). */
  inputHeartbeatMs: 250,
  /** Status broadcast throttle while values keep changing (ms). */
  statusThrottleMs: 250,
  /** Latency probe interval (ms). */
  pingIntervalMs: 5000,
};

export const urlFlags = (() => {
  const params = new URLSearchParams(location.search);
  const gameMatch = location.pathname.match(/^\/?games\/(\d-[a-z0-9-]+)\/?/);
  // Diagnostics stay local-only, but the test harness uses the loopback IP
  // rather than the localhost hostname. Keep all loopback spellings scoped
  // to development so a public deployment can never expose the debug handle.
  const localDebugHost = location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]' ||
    location.hostname === '::1';
  return {
    room: params.get('room'),
    debug: params.get('mpDebug') === '1' && localDebugHost,
    /** Game directory id when this page IS a game page (null in the lobby). */
    game: gameMatch ? gameMatch[1] : null,
    /** `?mp=off` hard-disables the layer (troubleshooting escape hatch). */
    off: params.get('mp') === 'off',
  };
})();
