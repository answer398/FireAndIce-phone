/**
 * Host -> guest video channel over WebRTC.
 *
 * The host captures its game canvas (`canvas.captureStream`) plus — best
 * effort — game audio (hooking AudioContext construction to attach a
 * MediaStreamDestination; if the game creates its context before us we
 * simply skip audio). Signaling rides the existing socket (protocol
 * RTC_SIGNAL); ICE servers come from client config so a TURN deployment
 * is a config change, not a code change.
 *
 * The guest only ever consumes: it renders the stream into a <video> that
 * overlays its own (idle) game page.
 */
import { logger } from '../core/logger.js';

/** Install a one-time AudioContext hook on the host to capture game audio. */
export function hookGameAudioOnce() {
  if (window.__mpAudioHooked) return;
  window.__mpAudioHooked = true;
  window.__mpGameAudio = null;

  const tappedDestinations = new Set();

  // Route every future node that targets a tapped destination through that
  // destination's tap, so we mirror the game's full mix without detaching it.
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    const result = origConnect.call(this, target, ...rest);
    if (target && tappedDestinations.has(target)) {
      try {
        const tap = tappedDestinations.get(target);
        origConnect.call(this, tap);
      } catch {
        /* nodes that cannot fan out twice are simply not mirrored */
      }
    }
    return result;
  };

  const OriginalAudioContext = window.AudioContext ?? window.webkitAudioContext;
  if (!OriginalAudioContext) return;
  window.AudioContext = class extends OriginalAudioContext {
    constructor(...args) {
      super(...args);
      try {
        const dest = this.createMediaStreamDestination();
        const tap = this.createGain();
        tap.gain.value = 1;
        origConnect.call(tap, dest);
        tappedDestinations.set(this.destination, tap);
        window.__mpGameAudio = dest.stream;
        logger.info('game audio capture attached');
      } catch (err) {
        logger.warn('audio capture unavailable:', err?.message ?? err);
      }
    }
  };
  if (window.webkitAudioContext && window.webkitAudioContext !== OriginalAudioContext) {
    window.webkitAudioContext = window.AudioContext;
  }
}

export class VideoChannel {
  constructor({ bus, net, P, iceServers, videoFps }) {
    this.bus = bus;
    this.net = net;
    this.P = P;
    this.iceServers = iceServers;
    this.videoFps = videoFps;

    this.pc = null;
    this.localStream = null;
    this.videoElement = null;
    this.pendingIce = [];

    const E = P.EVENTS;
    this.unsubs = [
      net.on(E.RTC_SIGNAL, (payload) => this.#onSignal(payload)),
      net.on(E.ROOM_PEER_LEFT, () => this.stop()),
      net.on(E.ROOM_CLOSED, () => this.stop()),
    ];
  }

  // ---- host side ------------------------------------------------------------

  /** Host: start capturing the canvas and push the stream to the guest. */
  async hostStart(canvas) {
    this.stop();
    if (!canvas || typeof canvas.captureStream !== 'function') {
      logger.warn('canvas captureStream unavailable');
      return false;
    }
    try {
      this.localStream = canvas.captureStream(this.videoFps);
      const gameAudio = window.__mpGameAudio;
      if (gameAudio) {
        for (const track of gameAudio.getAudioTracks()) {
          this.localStream.addTrack(track);
        }
      } else {
        logger.warn('no game audio captured (video only)');
      }
      this.pc = this.#newPeer();
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.#signal({ kind: 'offer', sdp: offer.sdp, type: offer.type });
      logger.info('video offer sent');
      return true;
    } catch (err) {
      logger.error('hostStart failed', err);
      this.stop();
      return false;
    }
  }

  // ---- guest side ------------------------------------------------------------

  /** Guest: render incoming video into the given element. */
  guestAttach(videoElement) {
    this.videoElement = videoElement;
    if (videoElement.srcObject) return;
    // If a track already arrived, bind now; otherwise #onSignal handles it.
  }

  /** Guest: accept the host's offer and answer. */
  async #guestAcceptOffer(description) {
    this.stop();
    this.pc = this.#newPeer();
    // The guest never sends media; it only receives.
    this.pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream || !this.videoElement) return;
      this.videoElement.srcObject = stream;
      this.videoElement.play?.().catch(() => {
        /* autoplay policies: user already interacted with the page to join */
      });
      logger.info('video stream attached');
      this.bus.emit('video:started');
    };
    await this.pc.setRemoteDescription(description);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.#signal({ kind: 'answer', sdp: answer.sdp, type: answer.type });
    logger.info('video answer sent');
  }

  // ---- shared plumbing --------------------------------------------------------

  #newPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#signal({ kind: 'ice', candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      logger.debug('pc state:', pc.connectionState);
      if (pc.connectionState === 'connected') this.bus.emit('video:connected');
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.bus.emit('video:stopped');
      }
    };
    return pc;
  }

  #signal(payload) {
    this.net.emit(this.P.EVENTS.RTC_SIGNAL, payload);
  }

  async #onSignal(payload) {
    if (!payload || typeof payload !== 'object') return;
    try {
      if (payload.kind === 'offer') {
        // Only the guest acts on offers.
        if (this.videoElement) await this.#guestAcceptOffer(payload);
      } else if (payload.kind === 'answer') {
        if (this.pc && this.pc.signalingState !== 'stable') {
          await this.pc.setRemoteDescription(payload);
        }
      } else if (payload.kind === 'ice' && payload.candidate && this.pc) {
        await this.pc.addIceCandidate(payload.candidate);
      }
    } catch (err) {
      logger.warn('rtc signal error', err?.message ?? err);
    }
  }

  stop() {
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
      this.pc = null;
    }
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop();
      this.localStream = null;
    }
    if (this.videoElement?.srcObject) {
      this.videoElement.srcObject = null;
    }
    this.bus.emit('video:stopped');
  }
}
