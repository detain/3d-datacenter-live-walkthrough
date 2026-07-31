/**
 * tests/js/helpers/dc-stack.js — shared harness that boots the REAL dc-ws.js and
 * dc-presence.js together in one `node:vm` sandbox, with real DOM event plumbing
 * between them.
 *
 * Why a joint harness: the three behaviours the owner cares about are all
 * cross-module. "The local user appears in the presence count" is dc-ws's auth
 * reply travelling through a `dc:auth-success` CustomEvent into dc-presence's
 * badge writer. A harness that hand-fires `dc:auth-success` proves nothing about
 * the wire; this one drives a socket frame and reads the DOM at the other end.
 *
 * NOT collected by vitest: vitest.config.ts includes only `tests/js/dc-*.test.js`,
 * and this file lives a directory down, so it is a helper and never a spec.
 *
 * ---------------------------------------------------------------------------
 * Protocol shapes this harness emits (get these wrong and the tests are fiction)
 * ---------------------------------------------------------------------------
 *   request/event  {v:1, id:"<uuid>", op:"<ns.verb>", ts:<unix>, data:{}}
 *   reply          {v:1, re:"<request id>", ok:true|false, ...}   ← NO `op`
 *
 *   auth.hello reply : {v:1, re:<the auth.hello id>, ok:true,
 *                       data:{session, uid, clientId, name, hub_time}}
 *   client_id        : a 20-char hex STRING (PHP bin2hex(pack('NnN',…))), never
 *                      an int — every fixture id below is 20 hex chars.
 *   batch_updated    : data is a MAP KEYED BY CLIENT ID,
 *                      {"<hexid>": {uid,name,x,z,yaw,ts}, …}
 *
 * ---------------------------------------------------------------------------
 * Anti-vacuity
 * ---------------------------------------------------------------------------
 * Eight tests in this suite have already shipped asserting fictions (a missing
 * `WebSocket` sandbox global made every connected-socket assertion pass without
 * a socket; an op-shaped `auth.welcome` that the hub never sends). So:
 *   - `WebSocket` is installed as a BARE sandbox global, because dc-ws.js writes
 *     `new WebSocket(url, 'v1')` / `WebSocket.OPEN` as bare identifiers.
 *   - the mock socket THROWS on send() while not OPEN, so a harness that forgets
 *     to move readyState is loud instead of silently swallowing frames.
 *   - open() asserts a socket exists and that auth.hello actually reached it.
 *   - authOk() asserts a hello id was in flight and that auth really landed.
 *   - listener exceptions are recorded on `h.errors` (dc-ws's _setStatus swallows
 *     them in a try/catch, so `expect(...).not.toThrow()` alone is not enough).
 * Tests should call `h.expectClean()` rather than trusting a bare not.toThrow().
 */

import * as THREE_STUB from '../__mocks__/three.js';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// MUTATION TESTING HOOK. Tests always run against public_html/js by default.
// scripts-free mutation runs (tests/js/helpers/mutate.mjs) point these env vars at
// deliberately-broken COPIES in a scratch dir, so a test can be proven to fail
// without ever editing the real sources — public_html/ belongs to another agent.
const WS_SRC = process.env.DC_MUTATE_WS
  || path.resolve(__dirname, '../../../public_html/js/dc-ws.js');
const PRESENCE_SRC = process.env.DC_MUTATE_PRESENCE
  || path.resolve(__dirname, '../../../public_html/js/dc-presence.js');

export const WS_SOURCE = fs.readFileSync(WS_SRC, 'utf8');
export const PRESENCE_SOURCE = fs.readFileSync(PRESENCE_SRC, 'utf8');

/** Realistic hub client ids: 20 hex chars = bin2hex(pack('NnN', …)). */
export const IDS = {
  self: '6a1f2c3d4e5f00a1b2c3',
  selfTab2: '6a1f2c3d4e5f77d4e5f6',
  remote: '0a1b2c3d0f1e9988aabb',
  remote2: 'ffee0011223344556677',
  /** Server-driven bot: `bot_<location>` — deliberately NOT hex, NOT 20 chars. */
  bot: 'bot_secaucus',
  bot2: 'bot_nyc',
};

/* ------------------------------------------------------------------ */
/* DOM fakes                                                           */
/* ------------------------------------------------------------------ */

function makeCtx2d() {
  const noop = () => {};
  return {
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
    clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, arcTo: noop,
    arc: noop, closePath: noop, fill: noop, fillText: noop, stroke: noop,
    fillRect: noop, bezierCurveTo: noop,
  };
}

function makeEl(id, tagName = 'SPAN') {
  const el = {
    id,
    tagName,
    childNodes: [],
    firstChild: null,
    textContent: '',
    style: {},
    attrs: {},
    classes: new Set(),
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    insertBefore(node, ref) {
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i >= 0) this.childNodes.splice(i, 0, node);
      else this.childNodes.push(node);
      this.firstChild = this.childNodes[0] || null;
      return node;
    },
    appendChild(node) {
      this.childNodes.push(node);
      this.firstChild = this.childNodes[0] || null;
      return node;
    },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
  };
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    contains: (c) => el.classes.has(c),
  };
  return el;
}

/* ------------------------------------------------------------------ */
/* WebSocket mock                                                      */
/* ------------------------------------------------------------------ */

function makeWebSocketClass(ctl) {
  function MockWebSocket(url, protocol) {
    ctl.constructed++;
    if (ctl.throwOnConstruct) {
      // Mirrors a browser refusing the handshake synchronously (bad URL / CSP /
      // mixed content) — dc-ws.js catches this and disables multiplayer.
      throw new Error('SecurityError: the operation is insecure');
    }
    this.url = url;
    this.protocol = protocol;
    this.readyState = MockWebSocket.CONNECTING;
    this._sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    ctl.sockets.push(this);
  }
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  MockWebSocket.prototype.send = function (data) {
    // Loud on purpose: a harness that forgets to move readyState would otherwise
    // make every "the client sent X" assertion pass with an empty _sent array.
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('InvalidStateError: send() on a socket in readyState ' + this.readyState);
    }
    this._sent.push(data);
  };
  MockWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' });
  };
  return MockWebSocket;
}

/* ------------------------------------------------------------------ */
/* the stack                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {Object} [opts]
 * @param {string|undefined} [opts.sessionId]  window.DC_SESSION_ID; pass '' or
 *        undefined to model a page with no PHP session (auth must be rejected).
 * @param {boolean} [opts.throwOnConstruct] make `new WebSocket()` throw.
 * @param {boolean} [opts.debug] set window.DC_DEBUG.
 * @param {boolean} [opts.noBadge] render a page with no #dcPresence markup.
 * @param {boolean} [opts.scene] install a DC scene before the modules load.
 * @param {boolean} [opts.presenceOnly] load only dc-presence.js (no dc-ws.js).
 */
export function loadStack(opts = {}) {
  const listeners = {};
  const events = [];
  /** Exceptions thrown by DOM listeners — dc-ws's _setStatus swallows these. */
  const errors = [];
  const timers = [];
  const rafQueue = [];
  const intervals = [];
  let rafSeq = 0;
  let timerSeq = 0;
  let intervalSeq = 0;
  const clock = { t: 1000 };
  const logs = { log: [], warn: [], info: [], error: [] };

  const ctl = { sockets: [], constructed: 0, throwOnConstruct: !!opts.throwOnConstruct };
  const MockWebSocket = makeWebSocketClass(ctl);

  class CustomEventShim {
    constructor(type, init) {
      this.type = type;
      this.detail = init ? init.detail : undefined;
      this.bubbles = !!(init && init.bubbles);
    }
  }

  /* --- #dcPresence markup, mirroring public_html/admin/dc.html --- */
  const els = {};
  if (!opts.noBadge) {
    els.dcPresence = makeEl('dcPresence', 'DIV');
    els.dcPresenceDot = makeEl('dcPresenceDot');
    els.dcPresenceLabel = makeEl('dcPresenceLabel');
    els.dcPresenceCount = makeEl('dcPresenceCount');
    els.dcPresenceCount.textContent = '0';
    // <span id=dcPresenceLabel>Users: <span id=dcPresenceCount>0</span></span>
    const labelText = { nodeType: 3, nodeValue: 'Users: ' };
    els.dcPresenceLabel.childNodes = [labelText, els.dcPresenceCount];
    els.dcPresenceLabel.firstChild = labelText;
    els.dcPresence.childNodes = [els.dcPresenceDot, els.dcPresenceLabel];
  }

  const doc = {
    readyState: 'complete',
    hidden: false,
    addEventListener(type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
    removeEventListener(type, cb) {
      const l = listeners[type];
      if (!l) return;
      const i = l.indexOf(cb);
      if (i >= 0) l.splice(i, 1);
    },
    // Faithful to the DOM: a throwing listener does NOT stop the others, and the
    // exception does not escape dispatchEvent. Recorded so tests can assert on it.
    dispatchEvent(ev) {
      events.push(ev);
      const l = (listeners[ev.type] || []).slice();
      for (const cb of l) {
        try { cb(ev); } catch (err) { errors.push({ type: ev.type, err }); }
      }
      return true;
    },
    getElementById(id) { return els[id] || null; },
    createElement(tag) {
      const el = makeEl(null, String(tag).toUpperCase());
      el.width = 0;
      el.height = 0;
      el.getContext = () => makeCtx2d();
      return el;
    },
    createTextNode(text) { return { nodeType: 3, nodeValue: text }; },
    createEvent() { return { initCustomEvent() {} }; },
    body: { appendChild() {}, removeChild() {} },
  };

  const consoleShim = {
    log: (...a) => logs.log.push(a),
    warn: (...a) => logs.warn.push(a),
    info: (...a) => logs.info.push(a),
    error: (...a) => logs.error.push(a),
  };

  // Timers and intervals carry real ids and clearX() really removes them, so
  // "no leaked keepalive across reconnects" measures the module, not the harness.
  const setTimeoutShim = (fn, ms) => { timerSeq++; timers.push({ id: timerSeq, fn, ms }); return timerSeq; };
  const clearTimeoutShim = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const setIntervalShim = (fn, ms) => { intervalSeq++; intervals.push({ id: intervalSeq, fn, ms }); return intervalSeq; };
  const clearIntervalShim = (id) => {
    const i = intervals.findIndex((t) => t.id === id);
    if (i >= 0) intervals.splice(i, 1);
  };

  const win = {
    document: doc,
    WebSocket: MockWebSocket,
    DC: null,
    DCM: null,
    DC_DEBUG: opts.debug || false,
    DC_AUTHED: false,
    DC_UID: null,
    DC_PRESENCE: null,
    DC_LATENCY: null,
    location: { search: opts.search || '' },
    performance: { now: () => clock.t },
    setTimeout: setTimeoutShim,
    clearTimeout: clearTimeoutShim,
    setInterval: setIntervalShim,
    clearInterval: clearIntervalShim,
    addEventListener() {},
    removeEventListener() {},
    console: consoleShim,
    URLSearchParams,
  };
  if (opts.sessionId !== undefined) win.DC_SESSION_ID = opts.sessionId;
  win.window = win;
  win.self = win;

  const sandbox = {
    window: win,
    document: doc,
    console: consoleShim,
    performance: win.performance,
    // dc-ws.js and dc-presence.js reference all of these as BARE identifiers.
    // A bare V8 context has none of them; omitting `WebSocket` here is exactly
    // how a whole class of connected-socket assertions became vacuous before.
    WebSocket: MockWebSocket,
    URLSearchParams,
    setTimeout: setTimeoutShim,
    clearTimeout: clearTimeoutShim,
    setInterval: setIntervalShim,
    clearInterval: clearIntervalShim,
    requestAnimationFrame(cb) { rafSeq++; rafQueue.push({ id: rafSeq, cb }); return rafSeq; },
    cancelAnimationFrame(id) {
      const i = rafQueue.findIndex((e) => e.id === id);
      if (i >= 0) rafQueue.splice(i, 1);
    },
    crypto: {
      randomUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      },
    },
    CustomEvent: CustomEventShim,
    THREE: THREE_STUB,
  };
  // Deterministic backoff jitter. dc-ws multiplies its delay by
  // (0.5 + Math.random() * 0.5), so with real randomness the multiplier can be
  // exactly 1.0 and a "the delay grows" assertion is flaky. Shadowing Math lets
  // the backoff be asserted exactly. Math's methods ignore `this`, so a prototype
  // chain onto the real Math is safe.
  if (opts.random !== undefined) {
    sandbox.Math = Object.assign(Object.create(Math), { random: () => opts.random });
  }
  vm.createContext(sandbox);

  /** Install a DC scene (+ optional roomSpawn / roomBounds / extras). */
  function installScene(extra = {}) {
    const scene = new THREE_STUB.Group();
    win.DC = Object.assign({
      scene,
      _sceneTicks: 0,
      tick(dt) { win.DC._sceneTicks++; win.DC._lastDt = dt; },
      roomSpawn: { x: 100, y: 0, z: 200, lookX: 100, lookZ: 210 },
      roomBounds: { minX: -50, maxX: 250, minZ: 100, maxZ: 300 },
    }, extra);
    return win.DC;
  }

  if (opts.scene) installScene(opts.sceneExtra);

  /* --- load order mirrors public_html/admin/dc.php: ws, then presence --- */
  if (!opts.presenceOnly) {
    vm.runInContext(WS_SOURCE, sandbox, { filename: WS_SRC });
  }
  // dc-presence.js is an ES module (`import * as THREE from "three"`). Per
  // .claude/rules/js-tests.md the real three package is never imported in a unit
  // test — strip the import and hand it the shared stub via the sandbox global.
  const presenceCode = PRESENCE_SOURCE.replace(
    /^\s*import\s+\*\s+as\s+THREE\s+from\s+["'][^"']+["'];?\s*$/m, ''
  );
  if (/import\s+\*\s+as\s+THREE/.test(presenceCode)) {
    throw new Error('dc-stack: failed to strip the THREE import from dc-presence.js');
  }
  vm.runInContext(presenceCode, sandbox, { filename: PRESENCE_SRC });

  const h = {
    win, doc, els, events, errors, timers, intervals, rafQueue, clock, logs, ctl,
    sockets: ctl.sockets,
    THREE: THREE_STUB,
    installScene,

    /** The dc-ws client instance (null only if dc-ws was not loaded). */
    get client() { return win.DC_WS; },
    /** Newest socket the client constructed, or null when construction threw. */
    socket(i) {
      if (!ctl.sockets.length) return null;
      return i === undefined ? ctl.sockets[ctl.sockets.length - 1] : ctl.sockets[i];
    },

    /* ---------------- transport driving ---------------- */

    /**
     * Bring the newest socket up: readyState = OPEN, then fire onopen. dc-ws
     * sends auth.hello from onopen, so this asserts the frame really landed —
     * otherwise every downstream auth assertion would be vacuous.
     */
    open() {
      const ws = h.socket();
      if (!ws) throw new Error('dc-stack.open(): no socket was constructed');
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen({});
      const hello = h.frames().filter((f) => f.op === 'auth.hello');
      if (hello.length !== 1) {
        throw new Error('dc-stack.open(): expected exactly 1 auth.hello frame, got ' + hello.length);
      }
      if (!win.DC_WS._helloId) {
        throw new Error('dc-stack.open(): dc-ws did not record a _helloId');
      }
      return ws;
    },

    /** Deliver a raw frame (object or string) through onmessage. */
    deliver(frame) {
      const ws = h.socket();
      if (!ws || !ws.onmessage) throw new Error('dc-stack.deliver(): socket is not receiving');
      ws.onmessage({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
    },

    /**
     * The real auth answer: a CORRELATED REPLY carrying `re` + `ok` and NO `op`.
     * @param {Object} [data] overrides for {session, uid, clientId, name, hub_time}
     */
    authOk(data) {
      const re = win.DC_WS._helloId;
      if (!re) throw new Error('dc-stack.authOk(): no auth.hello is in flight');
      h.deliver({
        v: 1,
        re,
        ok: true,
        data: Object.assign({
          session: win.DC_SESSION_ID || 'sess',
          uid: 42,
          clientId: IDS.self,
          name: 'Tester',
          hub_time: 1700000000,
        }, data || {}),
      });
      if (win.DC_AUTHED !== true) {
        throw new Error('dc-stack.authOk(): the reply did not authenticate the client');
      }
    },

    /** A failure reply correlated to the in-flight auth.hello. */
    authFail(error) {
      const re = win.DC_WS._helloId;
      if (!re) throw new Error('dc-stack.authFail(): no auth.hello is in flight');
      h.deliver({
        v: 1,
        re,
        ok: false,
        error: Object.assign({ code: 'AUTH_FAILED', message: 'invalid session' }, error || {}),
      });
    },

    /** Server→client EVENT: carries v/id/op/ts/data and no `ok`. */
    event(op, data) {
      h.deliver({ v: 1, id: 'evt-' + Math.random().toString(16).slice(2), op, ts: 1700000000, data: data || {} });
    },

    presenceJoined(data) {
      h.event('dc.presence.joined', Object.assign({
        uid: 7, clientId: IDS.remote, name: 'Remote', x: 1, z: 2, yaw: 0,
      }, data || {}));
    },
    presenceLeft(data) {
      h.event('dc.presence.left', Object.assign({ uid: 7, clientId: IDS.remote }, data || {}));
    },
    /** batch_updated data is a MAP KEYED BY CLIENT ID — never an array. */
    presenceBatch(map) { h.event('dc.presence.batch_updated', map); },

    close(code, reason) {
      const ws = h.socket();
      if (!ws) throw new Error('dc-stack.close(): no socket');
      ws.close(code, reason);
      return ws;
    },

    /**
     * Dispatch a document event the way dc.js does (it uses `new CustomEvent(...)`
     * + document.dispatchEvent). Used for dc:respawn, which dc.js fires from
     * spawnInside() at dc.js:2621.
     */
    fire(type, detail) {
      doc.dispatchEvent(new CustomEventShim(type, { detail, bubbles: true }));
    },

    /**
     * Replay dc.js's real location-switch sequence, in order:
     *   displayDatacenter() -> clearScene()  : DC_PRESENCE_LEAVE(), roomBounds = null
     *                       -> buildRoom()   : roomBounds = <new extents>
     *                       -> spawnInside() : dispatch dc:respawn
     * and then dc-multi's dc:respawn handler, which calls announcePresence() ->
     * DC_PRESENCE_JOIN(). All of clearScene/buildRoom/spawnInside run synchronously
     * inside displayDatacenter(), so nothing can observe the null gap in between.
     * @param {Object|null} newBounds
     * @param {{x:number, z:number, yaw:number}} [pose] where dc-multi re-announces
     */
    switchLocation(newBounds, pose = { x: 140, z: 260, yaw: 0.25 }) {
      if (typeof win.DC_PRESENCE_LEAVE === 'function') win.DC_PRESENCE_LEAVE();
      if (win.DC) win.DC.roomBounds = null;
      if (win.DC) win.DC.roomBounds = newBounds ? Object.assign({}, newBounds) : null;
      h.fire('dc:respawn', { x: pose.x, z: pose.z });
      if (typeof win.DC_PRESENCE_JOIN === 'function') win.DC_PRESENCE_JOIN(pose.x, pose.z, pose.yaw);
      h.flushRaf();
    },

    /* ---------------- inspection ---------------- */

    /** Parsed frames written to socket `i` (newest socket by default). */
    frames(i) {
      const ws = h.socket(i);
      if (!ws) return [];
      return ws._sent.map((s) => JSON.parse(s));
    },
    allFrames() {
      return ctl.sockets.flatMap((ws) => ws._sent.map((s) => JSON.parse(s)));
    },
    opsSent(op, i) { return h.frames(i).filter((f) => f.op === op); },
    eventsOf(type) { return events.filter((e) => e.type === type); },
    statuses() { return h.eventsOf('dc:ws-status').map((e) => e.detail.status); },
    /** How many document listeners are registered for `type` (leak detection). */
    listenerCount(type) { return (listeners[type] || []).length; },

    /* ---------------- badge readers (#dcPresence) ---------------- */

    /** The number rendered in #dcPresenceCount. */
    count() {
      if (!els.dcPresenceCount) return null;
      return Number(els.dcPresenceCount.textContent);
    },
    labelPrefix() {
      const first = els.dcPresenceLabel && els.dcPresenceLabel.firstChild;
      return first && first.nodeType === 3 ? first.nodeValue : null;
    },
    dotActive() { return !!(els.dcPresenceDot && els.dcPresenceDot.classes.has('active')); },
    dotColor() { return els.dcPresenceDot ? els.dcPresenceDot.style.background : null; },
    badgeTitle() { return els.dcPresence ? els.dcPresence.attrs.title : null; },

    /* ---------------- clocks ---------------- */

    flushRaf() {
      const pending = rafQueue.splice(0, rafQueue.length);
      pending.forEach((e) => e.cb());
      return pending.length;
    },
    /** Drain queued setTimeout callbacks (watchScene poll, reconnect, +200ms badge). */
    runTimers(rounds = 6) {
      let ran = 0;
      for (let i = 0; i < rounds && timers.length; i++) {
        const batch = timers.splice(0, timers.length);
        batch.forEach((t) => { ran++; t.fn(); });
      }
      return ran;
    },
    /** Fire every registered keepalive interval once. */
    tickKeepalive() { intervals.forEach((iv) => iv.fn()); },
    /** Advance the performance clock and run one scene frame. */
    frame(dt = 1 / 60, advanceMs) {
      if (advanceMs !== undefined) clock.t += advanceMs;
      if (!win.DC || typeof win.DC.tick !== 'function') {
        throw new Error('dc-stack.frame(): no scene installed');
      }
      win.DC.tick(dt);
    },

    /* ---------------- scene / avatars ---------------- */

    avatarGroups() {
      if (!win.DC || !win.DC.scene) return [];
      return win.DC.scene.children.filter((c) => c instanceof THREE_STUB.Group);
    },
    /** Nameplate sprites hanging off remote avatar groups. */
    nameplates() {
      return h.avatarGroups().map((g) => g.children.find((c) => c.isSprite) || null);
    },
    sceneTicks() { return (win.DC && win.DC._sceneTicks) || 0; },

    /* ---------------- assertions ---------------- */

    /** No DOM listener blew up. dc-ws swallows these, so check it explicitly. */
    expectClean() {
      if (errors.length) {
        const e = errors[0];
        throw new Error('listener for ' + e.type + ' threw: ' + (e.err && e.err.stack || e.err));
      }
    },
  };

  return h;
}
