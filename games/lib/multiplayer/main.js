/**
 * Orchestration entry for the multiplayer extension layer.
 *
 * Mode selection:
 *  - `?room=CODE` in the URL  -> guest: join that room immediately
 *  - otherwise                -> host-capable: chip + panel; host on demand
 *
 * All cross-module facts flow through one Bus. Protocol constants (P) are
 * injected by boot.js (dynamic import, so static-only hosting degrades to
 * a disabled overlay instead of breaking the game page).
 */
import { config, urlFlags } from './config.js';
import { Bus } from './core/bus.js';
import { logger } from './core/logger.js';
import { SocketClient, ConnectionState } from './net/socketClient.js';
import { RoomSession } from './room/roomSession.js';
import { GameAdapter } from './adapter/gameAdapter.js';
import { RemoteApplier } from './input/remoteApplier.js';
import { LocalPads } from './input/localPads.js';
import { VideoChannel, hookGameAudioOnce } from './net/videoChannel.js';
import { StatusSync, GuestStatusTracker } from './sync/statusSync.js';
import { Overlay } from './ui/overlay.js';

export function bootstrap(P) {
  if (urlFlags.off) {
    logger.info('disabled via ?mp=off');
    return;
  }
  if (!window.FBInput) {
    // The unified input layer (games/lib/input/) is a hard dependency:
    // without it, seats/roles/loop-prevention cannot be enforced.
    logger.warn('multiplayer layer unavailable: FBInput missing');
    return;
  }

  const input = window.FBInput.manager();

  const bus = new Bus();
  let statusSync = null;

  // 1. Network + session
  const net = new SocketClient(bus, P);
  const session = new RoomSession({ bus, net, P });
  void net.connect();

  // 2. Game observation (host + guest both run the page; only the host's
  //    instance drives the actual game).
  const adapter = new GameAdapter({ bus, P });

  // 3. Host-side pieces: remote input application, video capture, status.
  const remoteApplier = new RemoteApplier({ P });
  hookGameAudioOnce();
  const video = new VideoChannel({
    bus,
    net,
    P,
    iceServers: config.iceServers,
    videoFps: config.videoFps,
  });

  // 4. UI
  const overlay = new Overlay({ bus, mount: document.body });
  overlay.handlers = {
    onCreate: (char) => session.create({ char }),
    onJoin: (code) => session.join(code),
    onLeave: () => session.leave('user-leave'),
    onClosePanel: () => overlay.togglePanel(false),
  };

  // ---- host wiring ----------------------------------------------------------

  let hostStreamStarted = false;

  /** Host-side session start: runs on create AND on reload-while-seated. */
  const startHostSession = (peerAlreadyConnected) => {
    hostStreamStarted = false;
    remoteApplier.releaseAll();
    if (!peerAlreadyConnected) return;
    // Bind this device to the host's own character: keyboard and touch pads
    // may only drive it from now on; the peer's character is fed
    // exclusively by the network (see remoteApplier / FBInput.applyRemote).
    bindLocalSeat();
    // Keep simulating while the host window is unfocused — otherwise the
    // engine's blur auto-pause freezes the game for the remote player.
    adapter.setHostMode(true);
    const canvas = adapter.getCanvas();
    if (canvas) {
      video.hostStart(canvas).then((ok) => {
        hostStreamStarted = ok;
      });
    }
    bus.emit('adapter:phase', { phase: adapter.getPhase(), paused: adapter.isPaused() });
  };

  bus.on('session:joined', ({ role, peerConnected }) => {
    overlay.setSessionInfo(currentSessionInfo());
    if (role === P.ROLES.HOST) {
      overlay.banner(peerConnected ? '房间已恢复，队友在线' : '房间已创建，等待队友加入…', 3000);
      startHostSession(peerConnected);
    }
  });

  bus.on('session:peer', ({ connected }) => {
    overlay.setSessionInfo(currentSessionInfo());
    if (session.isHost && connected) {
      overlay.banner('队友已加入', 2500);
      // Bind seats: this device drives only the host's own character; the
      // peer's character is fed exclusively by network frames (the two
      // players can never fight over the same character).
      bindLocalSeat();
      // Keep simulating while the host window is unfocused.
      adapter.setHostMode(true);
      remoteApplier.releaseAll();
      remoteApplier.lastSeq = -1;
      // (Re)start the video push for this guest.
      const canvas = adapter.getCanvas();
      if (canvas) {
        video.hostStart(canvas).then((ok) => {
          hostStreamStarted = ok;
        });
      }
      // Tell the guest what phase we are in right now.
      bus.emit('adapter:phase', { phase: adapter.getPhase(), paused: adapter.isPaused() });
    }
    if (!connected) {
      adapter.setHostMode(false);
      remoteApplier.releaseAll();
      // Seat binding intentionally KEPT while the peer is away: the seat is
      // still theirs during the reconnect grace window — if this device's
      // keyboard drove their character, their held keys would fight ours on
      // rejoin.
      if (session.isHost) overlay.banner('队友已断开，等待重连…');
    }
  });

  bus.on('session:left', () => {
    overlay.setSessionInfo(null);
    overlay.setHostStatus(null);
    adapter.setHostMode(false);
    remoteApplier.releaseAll();
    video.stop();
    document.body.classList.remove('mp-guest-active');
    // Back to single-player local: both characters controlled here again.
    unbindLocalSeat();
  });

  // Remote input arriving on the host. The manager tags it 'remote' and
  // never re-emits it, so frames can never loop back onto the network.
  net.on(P.EVENTS.INPUT_FRAME, (frame) => {
    remoteApplier.applyFrame(frame, remoteChar());
  });
  net.on(P.EVENTS.INPUT_POINTER, (ev) => remoteApplier.applyPointer(ev));
  net.on(P.EVENTS.GAME_COMMAND, (cmd) => {
    if (cmd?.type === P.GAME_COMMANDS.PAUSE_TOGGLE) adapter.togglePause();
  });

  // Canvas becomes available: attach pointer target; (re)start stream if a
  // guest is already seated (covers reload while seated).
  bus.on('adapter:canvas', (canvas) => {
    remoteApplier.attachCanvas(canvas);
    if (session.isHost && session.peer.connected && !hostStreamStarted) {
      void video.hostStart(canvas);
    }
  });

  // Host phase changes flow to the guest.
  statusSync = new StatusSync({ bus, net, session, adapter, P });

  // ---- guest wiring -----------------------------------------------------------

  let guestPads = null;
  let lastHostStatus = null;

  // Consumes the host's status broadcasts (drives pad availability + UI).
  new GuestStatusTracker({ bus, net, P });

  bus.on('session:joined', ({ role, char }) => {
    if (role !== P.ROLES.GUEST) return;
    // Bind the incoming WebRTC stream to the overlay video element.
    video.guestAttach(overlay.video);
    overlay.showGuestVideo();
    if (!guestPads) {
      // LocalPads binds this device to `char` (the seat the room assigned)
      // and bridges FBInput local events -> protocol frames. Pads are built
      // by the shared touch-pads module, not here.
      guestPads = new LocalPads({ bus, char });
      bus.on('pads:frame', (frame) => net.emit(P.EVENTS.INPUT_FRAME, frame));
    }
    guestPads.setEnabled(false);
  });

  net.on(P.EVENTS.RTC_SIGNAL, () => {}); // handled inside VideoChannel

  bus.on('host:status', (status) => {
    lastHostStatus = { ...status, receivedAt: Date.now() };
    overlay.setHostStatus(status);
    if (guestPads) guestPads.setEnabled(GuestStatusTracker.padsActiveFor(status));
  });

  bus.on('session:peer', ({ connected }) => {
    if (!session.isHost && guestPads) {
      if (!connected) guestPads.setEnabled(false);
    }
  });

  // Pause chip for the guest (request the host to toggle pause).
  overlay.chip.addEventListener('dblclick', () => {
    if (session.role === P.ROLES.GUEST) {
      net.emit(P.EVENTS.GAME_COMMAND, { type: P.GAME_COMMANDS.PAUSE_TOGGLE });
    }
  });

  // ---- latency -> UI ---------------------------------------------------------

  net.onLatency = (ms) => overlay.setNetState(net.state, ms);
  bus.on('net:state', (state) => {
    overlay.setNetState(state);
    // Rejoin after any reconnect (session listens too; the overlay only
    // re-renders here).
    if (state === ConnectionState.CONNECTED && session.token) {
      session.rejoin(session.token);
    }
  });

  // ---- auto-join / restore ------------------------------------------------------

  function currentSessionInfo() {
    if (!session.code) return null;
    return {
      code: session.code,
      role: session.role,
      char: session.char,
      peerConnected: session.peer.connected,
    };
  }

  function remoteChar() {
    // The remote player controls the character opposite to ours.
    return session.char === 'fb' ? 'wg' : 'fb';
  }

  /**
   * Bind this device to one seat (multiplayer): the unified InputManager
   * restricts keyboard + touch pads to the assigned character, and the
   * shared touch-pads module re-renders to show only that seat's pad.
   */
  function bindLocalSeat() {
    if (session.char) input.setLocalRoles([session.char]);
  }

  /** Back to single-player local: both characters are ours to drive again. */
  function unbindLocalSeat() {
    input.setLocalRoles(null);
    if (window.FBInputPads) {
      window.FBInputPads.forceVisible(false);
      window.FBInputPads.setVisible(true);
    }
  }

  // Initial join flow: prefer resuming a stored seat (token), falling back
  // to the ?room= share code when the seat is gone. (Not bus.once: the
  // first net:state emission is CONNECTING, and a once listener would
  // consume it before CONNECTED ever arrives.)
  let initialJoinDone = false;
  bus.on('net:state', (state) => {
    if (initialJoinDone || state !== ConnectionState.CONNECTED) return;
    initialJoinDone = true;
    if (urlFlags.room) {
      logger.info('resume-or-join from URL:', urlFlags.room);
      overlay.togglePanel(true);
      session.resumeOrJoin(urlFlags.room);
    } else {
      session.resumeOrJoin(null);
    }
  });

  logger.info('bootstrapped');

  // Lightweight introspection for support/diagnostics (`?mpDebug=1`).
  window.__mpState = () => ({
    net: net.state,
    latency: net.lastLatencyMs,
    role: session.role,
    code: session.code,
    peer: session.peer,
    phase: adapter.getPhase(),
    paused: adapter.isPaused(),
    hasGame: Boolean(adapter.game),
    hasLevel: Boolean(adapter.level),
    lastHostStatus,
    statusSyncSent: statusSync?.sentCount ?? null,
    videoState: {
      srcAttached: Boolean(overlay.video?.srcObject),
      width: overlay.video?.videoWidth ?? 0,
    },
  });
}
