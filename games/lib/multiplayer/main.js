/**
 * Orchestration entry for the multiplayer extension layer (game pages).
 *
 * Flow: the LOBBY (index.html) is where rooms are created, shared and
 * readied up. A game page resumes the seat via the sessionStorage token
 * (keyed by room code, so the lobby→game navigation carries it), reports
 * `room:load` once the game resources are in, and both players drive the
 * server-side countdown → start gate from here.
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

  const PLAY_STATES = new Set([P.ROOM_STATES.PLAYING, P.ROOM_STATES.PAUSED, P.ROOM_STATES.RECONNECTING, P.ROOM_STATES.FINISHED]);

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
  overlay.setInviteUrl(() => (session.code ? `${location.origin}/?room=${session.code}` : null));
  overlay.handlers = {
    onCreate: (char) => {
      if (!urlFlags.game) {
        overlay.banner('请在游戏页内创建房间', 3000);
        return;
      }
      session.create({ game: urlFlags.game, char });
    },
    onJoin: (code) => session.join(code),
    onLeave: () => session.leave('user-leave'),
    onClosePanel: () => {},
    onReadyToggle: () => {
      const mine = session.state?.players?.[session.role];
      session.setReady(!(mine?.ready ?? false));
    },
    onSwapTap: () => {
      const swap = session.state?.swap;
      if (!swap) return session.swap(P.SWAP_ACTIONS.REQUEST);
      if (swap.from === session.role) return session.swap(P.SWAP_ACTIONS.CANCEL);
      return session.swap(P.SWAP_ACTIONS.ACCEPT);
    },
    onSwapReject: () => session.swap(P.SWAP_ACTIONS.DECLINE),
    onCopyLink: () => copyInvite(),
    onShare: () => shareInvite(),
  };

  const inviteUrl = () => (session.code ? `${location.origin}/?room=${session.code}` : null);

  async function copyInvite() {
    const url = inviteUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      overlay.banner('邀请链接已复制，快发给队友吧', 2500);
    } catch {
      overlay.banner(url, 6000);
    }
  }

  async function shareInvite() {
    const url = inviteUrl();
    if (!url) return;
    const shareData = { title: '森林冰火人 · 双人联机', text: `房间码 ${session.code}，点链接直接加入：`, url };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return; // user closed the share sheet
      }
    }
    await copyInvite();
  }

  // ---- loaded gate -----------------------------------------------------------
  //
  // `room:load` tells the server this page finished loading the game
  // resources (adapter reached any phase past booting). A failsafe timer
  // covers degraded pages whose Phaser hooks never attach.

  let loadedReported = false;
  const reportLoaded = () => {
    if (loadedReported || !session.code) return;
    loadedReported = true;
    session.setLoaded(true);
  };
  bus.on('adapter:phase', ({ phase }) => {
    if (phase !== P.GAME_PHASES.BOOTING) reportLoaded();
  });
  setTimeout(reportLoaded, 20_000);
  bus.on('session:joined', () => {
    if (loadedReported) session.setLoaded(true);
  });

  // ---- room state → UI + gating ------------------------------------------------

  let boundChar = null;

  const roomState = () => session.state;
  const roomStateIs = (...states) => Boolean(session.state && states.includes(session.state.state));

  let prevRoomState = null;

  bus.on('room:state', (state) => {
    overlay.setRoomState(state);
    // Role swaps reassign characters: rebind this device's seat (keyboard
    // restriction) and, for guests, the input bridge built around the char.
    if (session.char && session.char !== boundChar) bindLocalSeat();
    if (guestPads && session.char && guestPads.char !== session.char) {
      guestPads.destroy();
      guestPads = new LocalPads({ bus, char: session.char });
      guestPads.setEnabled(false);
    }
    // Ready/countdown phase drives the panel; playing collapses it.
    if (state.state === P.ROOM_STATES.COUNTDOWN) {
      overlay.togglePanel(false);
      overlay.startCountdownClock(() => {
        if (!session.state || session.state.state !== P.ROOM_STATES.COUNTDOWN) return null;
        const remaining = session.state.countdown.startAt - session.serverNow();
        return remaining > -600 ? remaining : null;
      });
    } else {
      overlay.hideCountdown();
    }
    if (state.state === P.ROOM_STATES.RECONNECTING) {
      const peerRole = session.role === P.ROLES.HOST ? P.ROLES.GUEST : P.ROLES.HOST;
      if (state.players?.[peerRole] && !state.players[peerRole].connected) {
        overlay.banner('对方正在重连…（席位将保留一段时间）');
      }
    } else if (state.state === P.ROOM_STATES.PLAYING && prevRoomState === P.ROOM_STATES.RECONNECTING) {
      overlay.banner('对方已重连，继续游戏', 2500);
    }
    if (state.state === P.ROOM_STATES.FINISHED) {
      overlay.banner('本关结束！双方准备后自动开始下一局', 4000);
      if (!document.hidden) overlay.togglePanel(true);
    }
    prevRoomState = state.state;
    updateGuestPads();
  });

  bus.on('room:start', () => {
    overlay.hideCountdown();
    if (session.isHost) {
      overlay.banner('开始！请进入关卡（双方已同步）', 3500);
    } else {
      overlay.banner('已同步开始，等待房主进入关卡…', 3500);
    }
  });

  bus.on('session:joined', ({ role, char, game, peerConnected }) => {
    overlay.setSessionInfo({ code: session.code, role, char, game, peerConnected });
    overlay.chip.setAttribute('data-role', role);
    if (role === P.ROLES.HOST) {
      overlay.banner(peerConnected ? '房间已恢复，队友在线' : '房间已创建，等待队友加入…', 3000);
      startHostSession(peerConnected);
    } else {
      bindLocalSeat();
    }
    // Seated players see the room panel while the room is not live yet.
    if (roomStateIs(P.ROOM_STATES.PLAYING, P.ROOM_STATES.PAUSED, P.ROOM_STATES.RECONNECTING)) {
      overlay.togglePanel(false); // mid-game reload: stay out of the way
    } else {
      overlay.togglePanel(true);
    }
    updateGuestPads();
  });

  bus.on('session:peer', ({ connected }) => {
    overlay.setSessionInfo(currentSessionInfo());
    if (session.isHost && connected) {
      overlay.banner('队友已加入', 2500);
      bindLocalSeat();
      // Keep simulating while the host window is unfocused.
      adapter.setHostMode(true);
      remoteApplier.releaseAll();
      remoteApplier.lastSeq = -1;
      // (Re)start the video push for this guest.
      const canvas = adapter.getCanvas();
      if (canvas) void video.hostStart(canvas);
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
      if (session.isHost) overlay.banner('队友已断开，席位保留，等待重连…');
    }
    updateGuestPads();
  });

  bus.on('session:left', () => {
    overlay.setSessionInfo(null);
    overlay.chip.removeAttribute('data-role');
    adapter.setHostMode(false);
    remoteApplier.releaseAll();
    video.stop();
    document.body.classList.remove('mp-guest-active');
    boundChar = null;
    // Back to single-player local: both characters controlled here again.
    unbindLocalSeat();
  });

  bus.on('session:error', () => updateGuestPads());

  // ---- host wiring ----------------------------------------------------------

  let hostStreamStarted = false;

  /** Host-side session start: runs on create AND on reload-while-seated. */
  const startHostSession = (peerAlreadyConnected) => {
    hostStreamStarted = false;
    remoteApplier.releaseAll();
    if (!peerAlreadyConnected) return;
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
      // and bridges FBInput local events -> protocol frames.
      guestPads = new LocalPads({ bus, char });
      bus.on('pads:frame', (frame) => net.emit(P.EVENTS.INPUT_FRAME, frame));
    } else {
      guestPads.destroy();
      guestPads = new LocalPads({ bus, char });
    }
    guestPads.setEnabled(false);
    updateGuestPads();
  });

  net.on(P.EVENTS.RTC_SIGNAL, () => {}); // handled inside VideoChannel

  bus.on('host:status', (status) => {
    lastHostStatus = { ...status, receivedAt: Date.now() };
    overlay.setHostStatus(status);
    updateGuestPads();
  });

  // Pause chip for the guest (request the host to toggle pause).
  overlay.chip.addEventListener('dblclick', () => {
    if (session.role === P.ROLES.GUEST && roomStateIs(...PLAY_STATES)) {
      net.emit(P.EVENTS.GAME_COMMAND, { type: P.GAME_COMMANDS.PAUSE_TOGGLE });
    }
  });

  /** Guest pads accept input only when the SERVER says the game is live
   * (playing/paused/reconnecting) AND the host is inside a level. */
  function updateGuestPads() {
    if (!guestPads) return;
    const live = roomStateIs(...PLAY_STATES);
    const inLevel = Boolean(lastHostStatus && lastHostStatus.phase === 'level');
    guestPads.setEnabled(live && inLevel);
  }

  // ---- latency -> UI ---------------------------------------------------------

  net.onLatency = (ms) => {
    overlay.setNetState(net.state, ms);
    // Self-reported latency for the room panel (cosmetic, rate-limited server-side).
    if (session.code) net.emit(P.EVENTS.NET_LATENCY, { ms });
  };
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
      game: session.game,
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
    if (!session.char || session.char === boundChar) return;
    boundChar = session.char;
    input.setLocalRoles([session.char]);
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
    game: session.game,
    char: session.char,
    roomState: session.state,
    peer: session.peer,
    phase: adapter.getPhase(),
    paused: adapter.isPaused(),
    loadedReported,
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
