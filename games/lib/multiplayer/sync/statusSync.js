/**
 * Status synchronization.
 *
 * Host: republishes adapter phase changes to the guest (throttled), plus
 * pause requests from the guest translate into the same P-key tap the host
 * player would press.
 *
 * Guest: exposes the latest known host phase so the UI can enable the pads
 * exactly when a level is running.
 */
import { logger } from '../core/logger.js';

export class StatusSync {
  constructor({ bus, net, session, adapter, P }) {
    this.bus = bus;
    this.net = net;
    this.session = session;
    this.adapter = adapter;
    this.P = P;

    this.latest = { phase: P.GAME_PHASES.BOOTING, paused: false, ts: 0 };
    this.lastSentAt = 0;
    this.pendingSend = null;

    // Always subscribe: the seat (and therefore the host role) only exists
    // AFTER a room is created/joined, never at bootstrap time. The role is
    // re-checked at publish time.
    bus.on('adapter:phase', ({ phase, paused }) => {
      if (session.isHost) this.#publish({ phase, paused });
    });
    bus.on('session:joined', ({ role }) => {
      if (role === P.ROLES.HOST && session.peer.connected) {
        // Reload-while-seated: the guest is already there and needs the
        // current phase immediately.
        this.#publish(this.latest, true);
      }
    });
    bus.on('session:peer', ({ connected }) => {
      // A (re)joining guest must learn the current phase immediately.
      if (connected && session.isHost) this.#publish(this.latest, true);
    });
  }

  #publish({ phase, paused }, immediate = false) {
    this.latest = { phase, paused, ts: Date.now() };
    const now = Date.now();
    if (!immediate && now - this.lastSentAt < 250) {
      if (!this.pendingSend) {
        this.pendingSend = setTimeout(() => {
          this.pendingSend = null;
          this.#publish(this.latest, true);
        }, 250);
      }
      return;
    }
    this.lastSentAt = now;
    this.sentCount = (this.sentCount ?? 0) + 1;
    this.net.emit(this.P.EVENTS.GAME_STATUS, this.latest);
    logger.debug('status published', this.latest);
  }
}

/** Guest-side consumer: track the host's status and drive pad availability. */
export class GuestStatusTracker {
  constructor({ bus, net, P }) {
    this.bus = bus;
    this.P = P;
    net.on(P.EVENTS.GAME_STATUS, (status) => {
      if (status && typeof status === 'object') {
        this.bus.emit('host:status', status);
      }
    });
    net.on(P.EVENTS.GAME_COMMAND, () => {}); // commands never flow guest-ward
  }

  /** Whether the guest's pads should currently accept input. */
  static padsActiveFor(status) {
    return Boolean(status && status.phase === 'level');
  }
}
