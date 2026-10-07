/**
 * Socket.IO connection wrapper.
 *
 * Responsibilities:
 *  - load the Socket.IO client (served by the Node server at /socket.io)
 *  - reconnect with backoff, exposing state transitions on the bus
 *  - latency probe (protocol NET_PING round trip)
 *
 * Deliberately knows nothing about rooms or the game; consumers speak in
 * protocol events only. The shared protocol namespace `P` is injected by
 * main.js (boot.js loads it dynamically so the layer can degrade gracefully
 * when hosted without the Node server).
 */
import { config, urlFlags } from '../config.js';
import { logger } from '../core/logger.js';

export const ConnectionState = {
  LOADING_SDK: 'loading-sdk',
  SDK_UNAVAILABLE: 'sdk-unavailable',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
};

/** Load the socket.io client once. Resolves null when unavailable
 * (e.g. static-only hosting without the Node server) so the caller can
 * degrade gracefully instead of crashing the game page.
 *
 * The official bundle is UMD: executed as a plain <script> on these game
 * pages it would detect RequireJS's global `define.amd` and register
 * itself as an anonymous AMD module instead of setting `window.io`.
 * We therefore fetch the source and evaluate it with a capturing `define`
 * in a function scope — the page's global AMD loader is never touched. */
export async function loadSocketIoSdk() {
  if (window.io) return window.io;
  const previousDefine = window.define;
  try {
    // RequireJS is present in the game runtime. Socket.IO's UMD bundle would
    // otherwise register an anonymous AMD module instead of exposing window.io.
    window.define = undefined;
    const script = document.createElement('script');
    script.src = config.socketPath + '/socket.io.min.js';
    script.async = false;
    const loaded = new Promise((resolve) => {
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
    });
    document.head.appendChild(script);
    const ok = await loaded;
    window.define = previousDefine;
    script.remove();
    return ok ? window.io ?? null : null;
  } catch {
    window.define = previousDefine;
    return null;
  }
}

export class SocketClient {
  /**
   * @param {import('../core/bus.js').Bus} bus
   * @param {object} P shared protocol namespace (EVENTS, …)
   */
  constructor(bus, P) {
    this.bus = bus;
    this.P = P;
    this.io = null;
    this.socket = null;
    this.state = ConnectionState.LOADING_SDK;
    this.pingTimer = null;
    this.lastLatencyMs = null;
    this.onLatency = null;
    /** Listeners registered before the socket exists; replayed in #open(). */
    this.#pendingListeners = [];
  }

  async connect() {
    const io = await loadSocketIoSdk();
    if (!io) {
      this.#setState(ConnectionState.SDK_UNAVAILABLE);
      logger.warn('socket.io client unavailable — multiplayer disabled');
      return false;
    }
    this.io = io;
    this.#open();
    return true;
  }

  #pendingListeners;

  #open() {
    this.#setState(ConnectionState.CONNECTING);
    const socket = this.io({
      path: config.socketPath,
      // iOS Safari and some carrier/proxy paths reject the initial WebSocket
      // handshake while ordinary HTTPS polling still works. Establish the
      // session over polling first, then let Socket.IO upgrade to WebSocket;
      // tryAllTransports also keeps a failed upgrade from leaving the lobby
      // stuck in CONNECTING.
      transports: ['polling', 'websocket'],
      tryAllTransports: true,
      rememberUpgrade: false,
      upgrade: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      reconnectionAttempts: Infinity,
      timeout: 8000,
    });
    this.socket = socket;
    if (urlFlags.debug) window.__mpSocket = socket;

    // Modules wire protocol listeners while the SDK is still loading;
    // replay everything they registered in the meantime.
    for (const { event, handler } of this.#pendingListeners) {
      socket.on(event, handler);
    }
    this.#pendingListeners = [];

    socket.on('connect', () => {
      this.#setState(ConnectionState.CONNECTED);
      this.#startPings();
      // The network came back — whoever holds a session must rejoin now.
      this.bus.emit('net:reconnected');
    });

    socket.on('disconnect', (reason) => {
      this.#setState(ConnectionState.DISCONNECTED);
      this.#stopPings();
      logger.warn('socket disconnected:', reason);
    });

    socket.on('connect_error', (err) => {
      logger.debug('connect error:', err?.message ?? err);
    });
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.bus.emit('net:state', state);
  }

  #startPings() {
    this.#stopPings();
    this.pingTimer = setInterval(() => {
      const sentAt = performance.now();
      this.socket.timeout(3000).emit(this.P.EVENTS.NET_PING, sentAt, (err, sentBack) => {
        if (err || typeof sentBack !== 'number') return;
        this.lastLatencyMs = Math.round(performance.now() - sentBack);
        this.onLatency?.(this.lastLatencyMs);
        logger.debug('latency', this.lastLatencyMs, 'ms');
      });
    }, config.pingIntervalMs);
  }

  #stopPings() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Attach a protocol listener; safe to call before the socket exists. */
  on(event, handler) {
    if (this.socket) {
      this.socket.on(event, handler);
    } else {
      this.#pendingListeners.push({ event, handler });
    }
    return () => {
      this.socket?.off(event, handler);
      const index = this.#pendingListeners.findIndex((entry) => entry.event === event && entry.handler === handler);
      if (index >= 0) this.#pendingListeners.splice(index, 1);
    };
  }

  emit(event, payload, ack) {
    if (!this.socket || !this.socket.connected) {
      logger.debug('drop emit (offline):', event);
      return false;
    }
    if (typeof ack === 'function') {
      this.socket.timeout(5000).emit(event, payload, (err, response) => {
        if (err) {
          logger.debug('ack timeout for', event);
          ack({ ok: false, timeout: true });
        } else {
          ack(response);
        }
      });
    } else {
      this.socket.emit(event, payload);
    }
    return true;
  }

  get connected() {
    return Boolean(this.socket?.connected);
  }

  /**
   * Poke the connection after a page-lifecycle event (tab visible again,
   * `online` fired, bfcache restore). No-op while connected or connecting;
   * otherwise starts connecting immediately instead of waiting out the
   * backoff timer — mobile OSes silently kill sockets in the background.
   */
  poke() {
    if (!this.socket) return;
    if (this.socket.connected) return;
    try {
      this.socket.connect();
    } catch { /* socket in a state that rejects connect() */ }
  }
}
