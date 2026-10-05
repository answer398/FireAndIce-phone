/**
 * Guest-side input bridge.
 *
 * Since the unified InputManager (games/lib/input/) exists, this module no
 * longer captures any input itself. It does three things:
 *
 *  1. Hands the guest's room-assigned character to the manager via
 *     FBInput.setLocalRoles([char]) — from then on the manager's physical
 *     keyboard and touch-pad sources only ever produce events for THAT
 *     character, never for the host's (role assignment is enforced in one
 *     place; a guest cannot operate the other character).
 *
 *  2. Translates the manager's local pressed/released events into protocol
 *     state frames { up, left, right, seq } on the bus ('pads:frame').
 *     Frames are change-driven plus a 1s heartbeat, so a reconnecting host
 *     re-syncs from the very next frame.
 *
 *  3. Gates pads/frames on the host being inside a level (setEnabled), and
 *     releases everything the moment it turns off, so the host never keeps
 *     a stuck key.
 *
 * Loop safety: remote input is applied host-side by remoteApplier through
 * FBInput.applyRemote, which is source-tagged 'remote' and never re-emitted
 * as a local event — frames can therefore never echo back onto the network.
 */
import { logger } from '../core/logger.js';

const FBInput = window.FBInput;
const FBInputPads = window.FBInputPads;

export class LocalPads {
  constructor({ bus, char }) {
    if (!FBInput) {
      throw new Error('games/lib/input/input-manager.js must load before the multiplayer layer');
    }
    this.bus = bus;
    this.char = char;
    // The manager is the single input funnel; FBInput only exposes tables.
    this.manager = FBInput.manager();

    this.state = { up: false, left: false, right: false };
    this.seq = 0;
    this.heartbeat = null;
    this.enabled = false;

    this.manager.setLocalRoles([char]);
    this.unsubEvents = this.manager.onLocalEvent((ev) => {
      if (ev.role !== this.char || !this.enabled) return;
      this.state[ev.action] = ev.type === 'pressed';
      this.#sendFrame();
    });
    logger.debug('local input bound to char', char);
  }

  /** Pads respond (and frames flow) only while the host is in a level. */
  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      // Release everything (pads, keyboard) for our character so the host
      // does not keep a stuck key, then push one final all-released frame.
      this.manager.releaseAll({ source: 'local', role: this.char });
      this.state = { up: false, left: false, right: false };
      this.#sendFrame(true);
      this.#stopHeartbeat();
    } else {
      this.state = { up: false, left: false, right: false };
      this.#startHeartbeat();
    }
    // Pads: on touch devices they exist already; on desktop guests they are
    // rendered on demand (mouse-operable), exactly like the old buildPad().
    if (FBInputPads) {
      FBInputPads.forceVisible(enabled);
      FBInputPads.setVisible(enabled);
    }
    this.bus.emit('pads:enabled', enabled);
  }

  destroy() {
    this.setEnabled(false);
    if (this.unsubEvents) this.unsubEvents();
    this.unsubEvents = null;
  }

  // ---- frame production ---------------------------------------------------

  #sendFrame(force = false) {
    if (!this.enabled && !force) return;
    this.seq += 1;
    this.bus.emit('pads:frame', { ...this.state, seq: this.seq });
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeat = setInterval(() => this.#sendFrame(true), 1000);
  }

  #stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
