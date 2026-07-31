/**
 * Unit tests for public_html/js/dc-presence.js
 *
 * dc-presence.js is an ES-module IIFE that imports Three.js via the bare "three"
 * specifier (resolved by the importmap in public_html/admin/dc.php). Per
 * .claude/rules/js-tests.md a unit test must NEVER pull in the real three package,
 * so the module is loaded into a `node:vm` sandbox with the import statement
 * stripped and the shared stub (tests/js/__mocks__/three.js) injected as the THREE
 * global. Everything the module touches (window / document / performance /
 * setTimeout) is a controllable fake, so the tests below drive real code paths:
 *   - dt-based avatar smoothing (C5)
 *   - join at the player's real position, exactly once (C3)
 *   - the optional `bounds` field on dc.presence.join (CONTRACT BOT-BOUNDS)
 *   - the dc:ws-status badge reflection (CONTRACT STATUS-EVENT)
 *   - the DC_PRESENCE_ENABLED kill switch absorbed from dc-ws.js (C2)
 *   - silence in the hot loop unless window.DC_DEBUG (C4)
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE_STUB from './__mocks__/three.js';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '../../public_html/js/dc-presence.js');
const SOURCE = fs.readFileSync(SRC, 'utf8');

// ----------------------------------------------------------------
// Constants mirrored from dc-presence.js (verified by reading the source)
// ----------------------------------------------------------------
const THROTTLE_MS = 150;
const LERP_SPEED = 12;
const YAW_LERP_SPEED = 8;
const MAX_NAME_SPRITE_CACHE = 64;

/** The frame-rate-independent blend the module must use. */
const blendFor = (dt, k = LERP_SPEED) => 1 - Math.exp(-k * dt);

// ----------------------------------------------------------------
// DOM / window fakes
// ----------------------------------------------------------------
function makeCtx2d() {
  const noop = () => {};
  return {
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
    clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, arcTo: noop,
    arc: noop, closePath: noop, fill: noop, fillText: noop, stroke: noop,
    fillRect: noop, bezierCurveTo: noop,
  };
}

function makeEl(id) {
  return {
    id,
    tagName: 'SPAN',
    childNodes: [],
    firstChild: null,
    textContent: '',
    style: {},
    attrs: {},
    classes: new Set(),
    classList: {
      add(c) { this._o.classes.add(c); },
      remove(c) { this._o.classes.delete(c); },
      contains(c) { return this._o.classes.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    insertBefore(node) { this.childNodes.unshift(node); this.firstChild = node; return node; },
    appendChild(node) { this.childNodes.push(node); if (!this.firstChild) this.firstChild = node; return node; },
    removeChild() {},
  };
}

function makeHarness(opts = {}) {
  const listeners = {};
  const timers = [];
  const sent = [];
  const clock = { t: 1000 };

  const els = {};
  ['dcPresence', 'dcPresenceDot', 'dcPresenceLabel', 'dcPresenceCount'].forEach((id) => {
    const el = makeEl(id);
    el.classList._o = el;
    els[id] = el;
  });
  // Mirror the real markup: <span id=Label>Users: <span id=Count>0</span></span>
  const labelText = { nodeType: 3, nodeValue: 'Users: ' };
  els.dcPresenceLabel.firstChild = labelText;
  els.dcPresenceLabel.childNodes = [labelText, els.dcPresenceCount];

  const doc = {
    readyState: 'complete',
    hidden: false,
    addEventListener(evt, cb) { (listeners[evt] = listeners[evt] || []).push(cb); },
    removeEventListener() {},
    getElementById(id) { return els[id] || null; },
    createElement(tag) {
      const el = makeEl(tag);
      el.classList._o = el;
      el.width = 0; el.height = 0;
      el.getContext = () => makeCtx2d();
      return el;
    },
    createTextNode(text) { return { nodeType: 3, nodeValue: text }; },
    body: { appendChild() {} },
  };

  const win = {
    document: doc,
    DC: null,
    DCM: null,
    DC_DEBUG: opts.debug || false,
    DC_PRESENCE_SEND(op, data) { sent.push({ op, data }); },
    performance: { now: () => clock.t },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
  };
  if (opts.enabled !== undefined) win.DC_PRESENCE_ENABLED = opts.enabled;
  // Stand-in for the dc-ws.js client, which is loaded (and has already reported its
  // first status) before this module evaluates.
  if (opts.dcWs) win.DC_WS = opts.dcWs;

  const sandbox = {
    window: win,
    document: doc,
    console,
    performance: win.performance,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    THREE: THREE_STUB,
  };
  vm.createContext(sandbox);

  // Strip the ES import so the source can run as a classic script; THREE comes from
  // the sandbox global instead (same object as the shared stub).
  const code = SOURCE.replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["'][^"']+["'];?\s*$/m, '');
  expect(code).not.toContain('import * as THREE');
  vm.runInContext(code, sandbox, { filename: SRC });

  const fire = (evt, detail) => {
    (listeners[evt] || []).forEach((cb) => cb({ detail, type: evt }));
  };

  return {
    win, doc, els, sent, clock, timers, listeners, fire,
    /** Drain queued setTimeout callbacks (watchScene polling, deferred indicator). */
    runTimers(rounds = 5) {
      for (let i = 0; i < rounds && timers.length; i++) {
        const batch = timers.splice(0, timers.length);
        batch.forEach((fn) => fn());
      }
    },
    /** Install a mock DC scene/tick (and optional bounds/spawn). */
    installScene(extra = {}) {
      win.DC = Object.assign({
        scene: new THREE_STUB.Group(),
        tick() { win.DC._ticked = (win.DC._ticked || 0) + 1; },
      }, extra);
      return win.DC;
    },
    /** Install the dc-multi facade dc-presence reads its own pose back from. */
    installDcm(x, z, facing) {
      win.DCM = { getPosition: () => ({ x, z }), getFacing: () => facing };
      return win.DCM;
    },
    auth(detail) {
      fire('dc:auth-success', Object.assign({
        uid: 42, clientId: 'a1b2c3d4e5f6a7b8c9d0', name: 'Tester', session: 'sess', hub_time: 1,
      }, detail || {}));
    },
    joined(detail) {
      fire('dc:v1-event', { op: 'dc.presence.joined', data: Object.assign({
        uid: 7, clientId: 'ffffffffffffffffffff', name: 'Remote', x: 0, z: 0, yaw: 0,
      }, detail || {}) });
    },
    v1(op, data) { fire('dc:v1-event', { op, data }); },
    status(s) { fire('dc:ws-status', { status: s }); },
    /** Advance the fake clock and run one frame through DC.tick. */
    frame(dt, advanceMs) {
      if (advanceMs !== undefined) clock.t += advanceMs;
      win.DC.tick(dt);
    },
    ops(op) { return sent.filter((s) => s.op === op); },
    /** The single remote avatar's group (created by dc.presence.joined). */
    avatarGroups() { return win.DC.scene.children.filter((c) => c instanceof THREE_STUB.Group); },
  };
}

/** Authenticated + scene ready + one remote avatar at (0,0). */
function withRemoteAvatar(opts = {}) {
  const h = makeHarness(opts);
  h.installScene(opts.dcExtra);
  h.installDcm(0, 0, 0);
  h.auth();
  h.joined({ x: 0, z: 0, yaw: 0 });
  const group = h.avatarGroups()[0];
  expect(group).toBeTruthy();
  return { h, group };
}

// ================================================================
// C11 — Three.js import specifier
// ================================================================
describe('dc-presence.js — C11 Three.js import', () => {
  it('imports THREE via the bare "three" specifier resolved by the importmap', () => {
    expect(SOURCE).toMatch(/^import \* as THREE from "three";$/m);
  });

  it('no longer uses the relative ../../../../../lib/three path', () => {
    expect(SOURCE).not.toContain('lib/three/build/three.module.js');
    expect(SOURCE).not.toContain('../../../../..');
  });

  it('matches the specifier dc-multi.js uses', () => {
    const multi = fs.readFileSync(path.resolve(__dirname, '../../public_html/js/dc-multi.js'), 'utf8');
    expect(multi).toMatch(/import \* as THREE from "three";/);
  });
});

// ================================================================
// Public API surface
// ================================================================
describe('dc-presence.js — presence API surface', () => {
  it('DC_PRESENCE_JOIN, DC_PRESENCE_MOVE, DC_PRESENCE_LEAVE are functions on window after load', () => {
    const h = makeHarness();
    expect(typeof h.win.DC_PRESENCE_JOIN).toBe('function');
    expect(typeof h.win.DC_PRESENCE_MOVE).toBe('function');
    expect(typeof h.win.DC_PRESENCE_LEAVE).toBe('function');
  });

  it('the module wins the DC_PRESENCE_* exports (defined last, after dc-ws.js)', () => {
    // Simulates dc-ws.js having defined its own copies first; ours must replace them.
    const h = makeHarness();
    expect(h.win.DC_PRESENCE_JOIN.name).toBe('joinScene');
    expect(h.win.DC_PRESENCE_MOVE.name).toBe('moveScene');
    expect(h.win.DC_PRESENCE_LEAVE.name).toBe('leaveScene');
  });
});

// ================================================================
// C5 — dt-based, frame-rate-independent avatar smoothing
// ================================================================
describe('dc-presence.js — C5 avatar smoothing is driven by frame dt', () => {
  it('one frame closes exactly 1 - exp(-LERP_SPEED*dt) of the gap', () => {
    const { h, group } = withRemoteAvatar();
    // Move the remote to x=10 with the clock frozen so its velocity stays 0.
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10, z: 0, yaw: 0 });

    const dt = 1 / 60;
    h.frame(dt);
    expect(group.position.x).toBeCloseTo(10 * blendFor(dt), 10);
    // Emphatically NOT a snap to the target.
    expect(group.position.x).toBeLessThan(2);
  });

  it('does NOT snap when 150ms (the send rate) has elapsed since the last update', () => {
    const { h, group } = withRemoteAvatar();
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10, z: 0, yaw: 0 });

    // The old code derived the factor from timeSinceUpdate: 0.15 * 12 * 2 = 3.6 -> 1.0 -> teleport.
    const dt = 1 / 60;
    h.frame(dt, 150);
    expect(group.position.x).toBeCloseTo(10 * blendFor(dt), 6);
    expect(group.position.x).toBeLessThan(10);
  });

  it('is frame-rate independent: two half-steps land where one full step does', () => {
    const a = withRemoteAvatar();
    a.h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10, z: 4, yaw: 0 });
    a.h.frame(1 / 30);

    const b = withRemoteAvatar();
    b.h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10, z: 4, yaw: 0 });
    b.h.frame(1 / 60);
    b.h.frame(1 / 60);

    expect(b.group.position.x).toBeCloseTo(a.group.position.x, 12);
    expect(b.group.position.z).toBeCloseTo(a.group.position.z, 12);
  });

  it('a bigger dt closes more of the gap than a smaller dt', () => {
    const slow = withRemoteAvatar();
    slow.h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10 });
    slow.h.frame(1 / 120);

    const fast = withRemoteAvatar();
    fast.h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10 });
    fast.h.frame(1 / 30);

    expect(fast.group.position.x).toBeGreaterThan(slow.group.position.x);
  });

  it('converges on the target over ~1s of 60fps frames without overshooting', () => {
    const { h, group } = withRemoteAvatar();
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10, z: 0 });
    for (let i = 0; i < 90; i++) {
      h.frame(1 / 60);
      expect(group.position.x).toBeLessThanOrEqual(10);
    }
    expect(group.position.x).toBeCloseTo(10, 2);
  });

  it('a missing / zero / non-finite dt falls back to 1/60 instead of snapping or NaN', () => {
    for (const dt of [undefined, 0, -1, NaN, Infinity, 'nope']) {
      const { h, group } = withRemoteAvatar();
      h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10 });
      h.frame(dt);
      expect(Number.isFinite(group.position.x)).toBe(true);
      expect(group.position.x).toBeCloseTo(10 * blendFor(1 / 60), 10);
    }
  });

  it('yaw uses the same dt-based blend and turns the short way round the wrap', () => {
    const { h, group } = withRemoteAvatar();
    group.rotation.y = -Math.PI + 0.1;
    // Target just the other side of the +/-PI wrap: the short way is +0.2 rad, not -6.08.
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', yaw: Math.PI - 0.1 });

    const dt = 1 / 60;
    h.frame(dt);
    const expected = (-Math.PI + 0.1) + (-0.2) * blendFor(dt, YAW_LERP_SPEED);
    expect(group.rotation.y).toBeCloseTo(expected, 10);
  });

  it('extrapolates the TARGET from velocity but still blends by dt', () => {
    const { h, group } = withRemoteAvatar();
    // First update 100ms after the join -> vx = 5 / 0.1 = 50 u/s (clamped ceiling).
    h.clock.t += 100;
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 5, z: 0 });

    const dt = 1 / 60;
    h.frame(dt, 100); // 100ms stale -> extrapolate 0.1s ahead: 5 + 50*0.1 = 10
    expect(group.position.x).toBeCloseTo(10 * blendFor(dt), 6);
  });

  it('stops extrapolating once an update is older than 500ms', () => {
    const { h, group } = withRemoteAvatar();
    h.clock.t += 100;
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 5, z: 0 });

    const dt = 1 / 60;
    h.frame(dt, 600); // stale -> aim at the last KNOWN position (5), not a prediction
    expect(group.position.x).toBeCloseTo(5 * blendFor(dt), 6);
  });

  it('does nothing while the tab is hidden', () => {
    const { h, group } = withRemoteAvatar();
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10 });
    h.doc.hidden = true;
    h.frame(1 / 60);
    expect(group.position.x).toBe(0);
  });
});

// ================================================================
// C4 — no per-avatar, per-frame logging
// ================================================================
describe('dc-presence.js — C4 logging is gated behind window.DC_DEBUG', () => {
  let spies;
  beforeEach(() => {
    spies = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
    };
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('the tick loop logs nothing, ever (60Hz x N users)', () => {
    const { h } = withRemoteAvatar();
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10 });
    spies.log.mockClear(); spies.info.mockClear();
    for (let i = 0; i < 120; i++) h.frame(1 / 60);
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
  });

  it('the tick loop stays silent even with DC_DEBUG on (hot path must not allocate/log)', () => {
    const { h } = withRemoteAvatar({ debug: true });
    h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 10 });
    spies.log.mockClear(); spies.info.mockClear();
    for (let i = 0; i < 60; i++) h.frame(1 / 60);
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
  });

  it('joined / batch_updated are silent without DC_DEBUG', () => {
    const h = makeHarness();
    h.installScene();
    h.auth();
    spies.log.mockClear(); spies.info.mockClear();
    h.joined({ x: 1, z: 2 });
    h.v1('dc.presence.batch_updated', { ffffffffffffffffffff: { x: 3, z: 4 } });
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
  });

  it('joined / batch_updated do log when DC_DEBUG is on', () => {
    const h = makeHarness({ debug: true });
    h.installScene();
    h.auth();
    spies.log.mockClear();
    h.joined({ x: 1, z: 2 });
    h.v1('dc.presence.batch_updated', { ffffffffffffffffffff: { x: 3, z: 4 } });
    expect(spies.log).toHaveBeenCalled();
    expect(spies.log.mock.calls.some((c) => String(c[0]).includes('[dc-presence]'))).toBe(true);
  });

  it('console.info is not used anywhere in the source', () => {
    expect(SOURCE).not.toContain('console.info');
  });
});

// ================================================================
// C3 — join at the player's REAL position, exactly once
// ================================================================
describe('dc-presence.js — C3 join uses the real player position', () => {
  it('auth success joins at dc-multi\'s live pose, not (0,0,0)', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(123.5, -67.25, 1.75);
    h.auth();

    const joins = h.ops('dc.presence.join');
    expect(joins.length).toBe(1);
    expect(joins[0].data.x).toBeCloseTo(123.5, 6);
    expect(joins[0].data.z).toBeCloseTo(-67.25, 6);
    expect(joins[0].data.yaw).toBeCloseTo(1.75, 6);
  });

  it('falls back to DC.roomSpawn when dc-multi has not booted yet', () => {
    const h = makeHarness();
    h.installScene({ roomSpawn: { x: 40, z: 90, lookX: 40, lookZ: 100 } });
    h.auth();

    const joins = h.ops('dc.presence.join');
    expect(joins.length).toBe(1);
    expect(joins[0].data.x).toBe(40);
    expect(joins[0].data.z).toBe(90);
    // facing derived from the spawn look target: atan2(0, 10) === 0
    expect(joins[0].data.yaw).toBeCloseTo(0, 6);
  });

  it('falls back to (0,0,0) only when neither dc-multi nor roomSpawn is available', () => {
    const h = makeHarness();
    h.installScene();
    h.auth();
    expect(h.ops('dc.presence.join')[0].data).toMatchObject({ x: 0, z: 0, yaw: 0 });
  });

  it('explicit coordinates win over the DCM read-back', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(1, 2, 0.1);
    h.auth();                                // joined from the live DCM pose
    h.win.DC_PRESENCE_LEAVE();               // pointer unlock -> latch cleared
    h.win.DC_PRESENCE_JOIN(55, 66, 0.5);     // re-lock: dc-multi supplies its own pose

    const joins = h.ops('dc.presence.join');
    expect(joins.length).toBe(2);
    expect(joins[0].data).toMatchObject({ x: 1, z: 2, yaw: 0.1 });
    expect(joins[1].data).toMatchObject({ x: 55, z: 66, yaw: 0.5 });
  });

  it('a parked join is re-resolved at replay time, not frozen at a stale fallback', () => {
    const h = makeHarness();
    h.auth();                                // no scene, no dc-multi -> parks
    h.installScene({ roomSpawn: { x: 70, z: 80, lookX: 70, lookZ: 81 } });
    h.installDcm(71, 81, 0.3);               // dc-multi booted in the meantime
    h.runTimers();
    expect(h.ops('dc.presence.join')[0].data).toMatchObject({ x: 71, z: 81, yaw: 0.3 });
  });

  it('a join before auth is parked and replayed once auth lands (never dropped)', () => {
    const h = makeHarness();
    h.installScene();
    h.win.DC_PRESENCE_JOIN(10, 20, 0.25); // dc-multi spawned first
    expect(h.sent.length).toBe(0);        // silently dropped in the old code, forever

    h.installDcm(10, 20, 0.25);
    h.auth();
    const joins = h.ops('dc.presence.join');
    expect(joins.length).toBe(1);
    expect(joins[0].data).toMatchObject({ x: 10, z: 20, yaw: 0.25 });
  });

  it('a join before the scene exists is parked and replayed by the scene watcher', () => {
    const h = makeHarness();
    h.auth();                    // no window.DC yet
    expect(h.ops('dc.presence.join').length).toBe(0);

    h.installScene({ roomSpawn: { x: 5, z: 6, lookX: 5, lookZ: 7 } });
    h.runTimers();               // watchScene poll notices the scene
    const joins = h.ops('dc.presence.join');
    expect(joins.length).toBe(1);
    expect(joins[0].data).toMatchObject({ x: 5, z: 6 });
  });

  it('is idempotent: repeat joins at the same pose send exactly ONE dc.presence.join', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(30, 40, 0.5);
    h.auth();
    h.win.DC_PRESENCE_JOIN(30, 40, 0.5);   // dc-multi's _onAuthSuccess re-announce
    h.win.DC_PRESENCE_JOIN();              // and again on pointer re-lock
    expect(h.ops('dc.presence.join').length).toBe(1);
    expect(h.ops('dc.presence.move').length).toBe(0);
  });

  it('a later join with BETTER coordinates becomes a move correction, not a second join', () => {
    const h = makeHarness();
    h.installScene({ roomSpawn: { x: 0, z: 0, lookX: 0, lookZ: 1 } });
    h.auth();                              // joins at the spawn
    h.win.DC_PRESENCE_JOIN(80, 90, 1.5);   // dc-multi now knows the real pose

    expect(h.ops('dc.presence.join').length).toBe(1);
    const moves = h.ops('dc.presence.move');
    expect(moves.length).toBe(1);
    expect(moves[0].data).toMatchObject({ x: 80, z: 90, yaw: 1.5 });
  });

  it('re-authentication after a disconnect sends exactly one fresh join', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(11, 22, 0);
    h.auth();
    expect(h.ops('dc.presence.join').length).toBe(1);

    h.fire('dc:disconnected');
    h.auth();                              // reconnected + re-authed
    expect(h.ops('dc.presence.join').length).toBe(2);
  });

  it('leave clears the latch so a re-entry can announce itself again', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(1, 2, 0);
    h.auth();
    h.win.DC_PRESENCE_LEAVE();
    expect(h.ops('dc.presence.leave').length).toBe(1);
    h.win.DC_PRESENCE_JOIN(1, 2, 0);
    expect(h.ops('dc.presence.join').length).toBe(2);
  });
});

// ================================================================
// C2 — the guard absorbed from the deleted dc-ws.js duplicates
// ================================================================
describe('dc-presence.js — C2 DC_PRESENCE_ENABLED kill switch', () => {
  it('suppresses join, move and leave when presence is disabled', () => {
    const h = makeHarness({ enabled: false });
    h.installScene();
    h.installDcm(5, 5, 0);
    h.win.DC_PRESENCE_JOIN(5, 5, 0);
    h.win.DC_PRESENCE_MOVE(6, 6, 0);
    h.win.DC_PRESENCE_LEAVE();
    expect(h.sent).toEqual([]);
  });

  it('a disconnect disables presence; sends stay suppressed until the next auth', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(5, 5, 0);
    h.auth();
    h.sent.length = 0;

    h.fire('dc:disconnected');
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    h.clock.t += THROTTLE_MS + 1;
    h.win.DC_PRESENCE_MOVE(7, 7, 0);
    expect(h.sent).toEqual([]);

    h.auth();
    expect(h.win.DC_PRESENCE_ENABLED).toBe(true);
    expect(h.ops('dc.presence.join').length).toBe(1);
  });

  it('auth failure disables presence too', () => {
    const h = makeHarness();
    h.installScene();
    h.auth();
    h.fire('dc:auth-failure');
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
  });

  it('sends yaw (never facing) and never a client-supplied clientId', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(3, 4, 0.9);
    h.auth();
    h.clock.t += THROTTLE_MS + 1;
    h.win.DC_PRESENCE_MOVE(4, 5, 1.1);

    expect(h.sent.length).toBeGreaterThanOrEqual(2);
    for (const frame of h.sent) {
      expect(frame.data).not.toHaveProperty('facing');
      expect(frame.data).not.toHaveProperty('clientId');
    }
    expect(Object.keys(h.ops('dc.presence.move')[0].data).sort()).toEqual(['x', 'yaw', 'z']);
    expect(SOURCE).not.toMatch(/facing:/);
  });

  it('moveScene honours the 150ms throttle', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(0, 0, 0);
    h.auth();
    h.sent.length = 0;

    h.clock.t += THROTTLE_MS + 1;
    h.win.DC_PRESENCE_MOVE(1, 1, 0);
    h.win.DC_PRESENCE_MOVE(2, 2, 0);   // same instant -> throttled
    expect(h.ops('dc.presence.move').length).toBe(1);

    h.clock.t += THROTTLE_MS + 1;
    h.win.DC_PRESENCE_MOVE(3, 3, 0);
    expect(h.ops('dc.presence.move').length).toBe(2);
  });

  it('degrades gracefully when DC_PRESENCE_SEND does not exist (no hub at all)', () => {
    const h = makeHarness();
    h.win.DC_PRESENCE_SEND = undefined;
    h.installScene();
    expect(() => {
      h.auth();
      h.win.DC_PRESENCE_JOIN(1, 2, 3);
      h.win.DC_PRESENCE_MOVE(1, 2, 3);
      h.win.DC_PRESENCE_LEAVE();
    }).not.toThrow();
  });
});

// ================================================================
// CONTRACT BOT-BOUNDS — optional bounds on dc.presence.join
// ================================================================
describe('dc-presence.js — CONTRACT BOT-BOUNDS', () => {
  it('join carries bounds sourced from DC.roomBounds', () => {
    const h = makeHarness();
    h.installScene({ roomBounds: { minX: -120, maxX: 130, minZ: 400, maxZ: 640 } });
    h.installDcm(0, 500, 0);
    h.auth();

    const join = h.ops('dc.presence.join')[0];
    expect(join.data.bounds).toEqual({ minX: -120, maxX: 130, minZ: 400, maxZ: 640 });
  });

  it('bounds is OMITTED entirely when roomBounds is null (scene not built yet)', () => {
    const h = makeHarness();
    h.installScene({ roomBounds: null });
    h.auth();
    expect(h.ops('dc.presence.join')[0].data).not.toHaveProperty('bounds');
  });

  it('bounds is omitted when DC.roomBounds is malformed or degenerate', () => {
    const bad = [
      { minX: 0, maxX: 10, minZ: 0 },                       // missing maxZ
      { minX: 'a', maxX: 10, minZ: 0, maxZ: 10 },           // non-numeric
      { minX: NaN, maxX: 10, minZ: 0, maxZ: 10 },           // NaN
      { minX: 10, maxX: 10, minZ: 0, maxZ: 10 },            // zero width
      { minX: 0, maxX: 10, minZ: 10, maxZ: 0 },             // inverted
    ];
    for (const roomBounds of bad) {
      const h = makeHarness();
      h.installScene({ roomBounds });
      h.auth();
      expect(h.ops('dc.presence.join')[0].data).not.toHaveProperty('bounds');
    }
  });

  it('bounds rides on join only — never on move', () => {
    const h = makeHarness();
    h.installScene({ roomBounds: { minX: -1, maxX: 1, minZ: -1, maxZ: 1 } });
    h.auth();
    h.clock.t += THROTTLE_MS + 1;
    h.win.DC_PRESENCE_MOVE(1, 1, 0);
    expect(h.ops('dc.presence.move')[0].data).not.toHaveProperty('bounds');
  });

  it('bounds is a plain copy, not a live reference to DC.roomBounds', () => {
    const h = makeHarness();
    const roomBounds = { minX: -1, maxX: 1, minZ: -2, maxZ: 2 };
    h.installScene({ roomBounds });
    h.auth();
    roomBounds.maxX = 9999;
    expect(h.ops('dc.presence.join')[0].data.bounds.maxX).toBe(1);
  });
});

// ================================================================
// CONTRACT STATUS-EVENT — dc:ws-status reflected on the badge
// ================================================================
describe('dc-presence.js — CONTRACT STATUS-EVENT badge reflection', () => {
  it('before any status event the badge keeps its legacy behaviour', () => {
    const h = makeHarness();
    expect(h.els.dcPresenceCount.textContent).toBe('0');
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(false);
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toBe('Users: ');
  });

  it('connecting shows an amber dot and a Connecting label', () => {
    const h = makeHarness();
    h.status('connecting');
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(false);
    expect(h.els.dcPresenceDot.style.background).toBe('#e8b23a');
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toMatch(/Connecting/);
  });

  it('connected + authed goes green via the existing .active class (no inline colour)', () => {
    const h = makeHarness();
    h.installScene();
    h.status('connected');
    h.auth();
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(true);
    expect(h.els.dcPresenceDot.style.background).toBe('');
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toBe('Users: ');
  });

  it('connected but not yet authed is not shown as live', () => {
    const h = makeHarness();
    h.status('connected');
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(false);
    expect(h.els.dcPresenceCount.textContent).toBe('0');
  });

  it('connected-but-alone reads as 1 user and live', () => {
    const h = makeHarness();
    h.installScene();
    h.status('connected');
    h.auth();
    expect(h.els.dcPresenceCount.textContent).toBe('1');
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(true);
  });

  it.each(['disconnected', 'error', 'exhausted'])('%s reads as offline, not as "alone"', (status) => {
    const h = makeHarness();
    h.installScene();
    h.status('connected');
    h.auth();
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(true);

    h.status(status);
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(false);
    expect(h.els.dcPresenceDot.style.background).not.toBe('');
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toMatch(/Offline/);
    expect(String(h.els.dcPresence.getAttribute('title'))).toMatch(/unavailable/i);
  });

  it('does not break the existing count logic', () => {
    const h = makeHarness();
    h.installScene();
    h.status('connected');
    h.auth();
    h.joined({ clientId: 'aaaaaaaaaaaaaaaaaaaa' });
    expect(h.els.dcPresenceCount.textContent).toBe('2');
    h.joined({ clientId: 'bbbbbbbbbbbbbbbbbbbb', uid: 8, name: 'Other' });
    expect(h.els.dcPresenceCount.textContent).toBe('3');
    h.v1('dc.presence.left', { clientId: 'aaaaaaaaaaaaaaaaaaaa' });
    expect(h.els.dcPresenceCount.textContent).toBe('2');
  });

  it('never replaces the label element wholesale (the count span lives inside it)', () => {
    const h = makeHarness();
    h.status('disconnected');
    h.status('connecting');
    expect(h.els.dcPresenceLabel.childNodes).toContain(h.els.dcPresenceCount);
  });

  it('ignores unknown / malformed status payloads', () => {
    const h = makeHarness();
    h.status('connecting');
    const amber = h.els.dcPresenceDot.style.background;
    h.status('bogus');
    h.fire('dc:ws-status', null);
    h.fire('dc:ws-status', {});
    expect(h.els.dcPresenceDot.style.background).toBe(amber);
  });

  it('survives a page with no #dcPresence markup at all', () => {
    const h = makeHarness();
    h.doc.getElementById = () => null;
    expect(() => { h.status('disconnected'); h.status('connected'); }).not.toThrow();
  });

  // dc-ws.js loads BEFORE dc-presence.js, so its init-time _setStatus('connecting')
  // is dispatched before our listener exists. We seed from DC_WS.status instead.
  it('seeds the badge from window.DC_WS.status at startup (missed first event)', () => {
    const h = makeHarness({ dcWs: { status: 'connecting' } });
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toMatch(/Connecting/);
    expect(h.els.dcPresenceDot.style.background).toBe('#e8b23a');
  });

  it('seeds an already-dead hub as offline without waiting for an event', () => {
    const h = makeHarness({ dcWs: { status: 'exhausted' } });
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toMatch(/Offline/);
  });

  it('falls back to DC_WS.getState().status when the field is absent', () => {
    const h = makeHarness({ dcWs: { getState: () => ({ status: 'disconnected' }) } });
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toMatch(/Offline/);
  });

  it('seeding is null-safe when DC_WS does not exist (standalone dc.html)', () => {
    const h = makeHarness();
    expect(h.win.DC_WS).toBeUndefined();
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toBe('Users: ');
  });

  it('seeding survives a DC_WS whose getState throws', () => {
    const h = makeHarness({ dcWs: { getState: () => { throw new Error('boom'); } } });
    expect(h.els.dcPresenceLabel.firstChild.nodeValue).toBe('Users: ');
  });

  it('a later dc:ws-status event overrides the seeded value', () => {
    const h = makeHarness({ dcWs: { status: 'connecting' } });
    h.installScene();
    h.status('connected');
    h.auth();
    expect(h.els.dcPresenceDot.classList.contains('active')).toBe(true);
  });
});

// ================================================================
// Graceful degradation — the page must work with the hub unreachable
// ================================================================
describe('dc-presence.js — graceful degradation', () => {
  it('every presence entry point is safe with no window.DC at all', () => {
    const h = makeHarness();
    expect(h.win.DC).toBeNull();
    expect(() => {
      h.auth();
      h.joined({});
      h.v1('dc.presence.updated', { clientId: 'ffffffffffffffffffff', x: 1 });
      h.v1('dc.presence.left', { clientId: 'ffffffffffffffffffff' });
      h.v1('dc.presence.batch_updated', { ffffffffffffffffffff: { x: 1 } });
      h.fire('dc:disconnected');
      h.fire('dc:auth-failure');
      h.win.DC_PRESENCE_JOIN();
      h.win.DC_PRESENCE_MOVE(1, 2, 3);
      h.win.DC_PRESENCE_LEAVE();
    }).not.toThrow();
  });

  it('teardown after the scene disappears does not throw (onLeft / disconnect)', () => {
    const { h } = withRemoteAvatar();
    h.win.DC = undefined;  // dc.js torn down / never finished booting
    expect(() => {
      h.v1('dc.presence.left', { clientId: 'ffffffffffffffffffff' });
      h.fire('dc:disconnected');
    }).not.toThrow();
    expect(h.els.dcPresenceCount.textContent).toBe('0');
  });

  it('a disconnect removes every remote avatar from the scene', () => {
    const { h, group } = withRemoteAvatar();
    expect(h.win.DC.scene.children).toContain(group);
    h.fire('dc:disconnected');
    expect(h.win.DC.scene.children).not.toContain(group);
    expect(h.els.dcPresenceCount.textContent).toBe('0');
  });

  it('malformed auth / event payloads do not throw', () => {
    const h = makeHarness();
    h.installScene();
    expect(() => {
      h.fire('dc:auth-success', undefined);
      h.fire('dc:v1-event', undefined);
      h.fire('dc:v1-event', { op: 'dc.presence.joined' });
      h.fire('dc:v1-event', { op: 'dc.presence.batch_updated', data: null });
      h.fire('dc:v1-event', { op: 'dc.presence.batch_updated', data: { x: null } });
    }).not.toThrow();
  });

  it('remote events for unknown clientIds are ignored', () => {
    const { h, group } = withRemoteAvatar();
    h.v1('dc.presence.updated', { clientId: 'nope', x: 999 });
    h.v1('dc.presence.left', { clientId: 'nope' });
    h.frame(1 / 60);
    expect(group.position.x).toBe(0);
    expect(h.els.dcPresenceCount.textContent).toBe('2');
  });
});

// ================================================================
// clientId key handling — explicit String() consistency
// ================================================================
describe('dc-presence.js — clientId key handling', () => {
  it('a numeric clientId from batch_updated still matches a string-keyed entry', () => {
    const h = makeHarness();
    h.installScene();
    h.installDcm(0, 0, 0);
    h.auth();
    h.joined({ clientId: 7, uid: 7, name: 'Legacy', x: 0, z: 0 });
    const group = h.avatarGroups()[0];
    expect(group).toBeTruthy();

    // for...in hands us the STRING "7" even though the join carried the NUMBER 7.
    h.v1('dc.presence.batch_updated', { 7: { x: 10, z: 0, yaw: 0 } });
    h.frame(1 / 60);
    expect(group.position.x).toBeGreaterThan(0);
  });

  it('batch_updated skips self whatever the clientId type', () => {
    const h = makeHarness();
    h.installScene();
    h.auth({ uid: 42, clientId: 99 });          // hub handed back a number
    h.joined({ clientId: 'other', uid: 8, name: 'Other', x: 0, z: 0 });
    const other = h.avatarGroups()[0];

    h.v1('dc.presence.batch_updated', { 99: { x: 500, z: 500 }, other: { x: 3, z: 0 } });
    h.frame(1 / 60);
    expect(other.position.x).toBeGreaterThan(0);
    expect(other.position.x).toBeLessThan(3);   // moved toward 3, not 500
    expect(h.els.dcPresenceCount.textContent).toBe('2');
  });

  it('our own joined echo never becomes a remote avatar', () => {
    const h = makeHarness();
    h.installScene();
    h.auth({ clientId: 'selfselfselfselfself' });
    h.joined({ clientId: 'selfselfselfselfself', uid: 42, name: 'Tester' });
    expect(h.avatarGroups().length).toBe(0);
    expect(h.els.dcPresenceCount.textContent).toBe('1');
  });

  it('a duplicate joined for the same clientId does not create a second avatar', () => {
    const { h } = withRemoteAvatar();
    h.joined({ clientId: 'ffffffffffffffffffff' });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.els.dcPresenceCount.textContent).toBe('2');
  });

  it('presence broadcasts arriving before auth are ignored (no avatar at a peer pose)', () => {
    const h = makeHarness();
    h.installScene();
    h.joined({ x: 77, z: 88 });
    expect(h.avatarGroups().length).toBe(0);
    // ...and that peer's coordinates must NOT become our own pending join.
    h.installDcm(1, 2, 0);
    h.auth();
    expect(h.ops('dc.presence.join')[0].data).toMatchObject({ x: 1, z: 2 });
  });
});

// ================================================================
// Constants / geometry (pure, mirrored from the source)
// ================================================================
describe('dc-presence.js — constants', () => {
  it('THROTTLE_MS = 150ms minimum interval between move sends', () => {
    expect(SOURCE).toMatch(/const THROTTLE_MS = 150\b/);
    expect(THROTTLE_MS).toBe(150);
  });

  it('LERP_SPEED = 12 and YAW_LERP_SPEED = 8 are smoothing RATES (1/seconds)', () => {
    expect(SOURCE).toMatch(/const LERP_SPEED = 12\b/);
    expect(SOURCE).toMatch(/const YAW_LERP_SPEED = 8\b/);
  });

  it('the smoothing formula is the frame-rate-independent exponential form', () => {
    expect(SOURCE).toContain('1 - Math.exp(-LERP_SPEED * step)');
    expect(SOURCE).toContain('1 - Math.exp(-YAW_LERP_SPEED * step)');
    // The old network-time-derived factor is gone.
    expect(SOURCE).not.toContain('timeSinceUpdate * LERP_SPEED');
  });

  it('AVATAR_BODY_GEO and AVATAR_HEAD_GEO geometries are created with correct params', () => {
    const bodyGeo = new THREE_STUB.CylinderGeometry(0.12, 0.12, 0.28, 8);
    expect(bodyGeo.radiusTop).toBeCloseTo(0.12, 2);
    expect(bodyGeo.radiusBottom).toBeCloseTo(0.12, 2);
    expect(bodyGeo.height).toBeCloseTo(0.28, 2);
    expect(bodyGeo.radialSegments).toBe(8);

    const headGeo = new THREE_STUB.SphereGeometry(0.10, 12, 8);
    expect(headGeo.radius).toBeCloseTo(0.10, 2);
    expect(headGeo.widthSegments).toBe(12);
    expect(headGeo.heightSegments).toBe(8);
  });

  it('MAX_NAME_SPRITE_CACHE = 64 LRU eviction threshold', () => {
    expect(SOURCE).toMatch(/const MAX_NAME_SPRITE_CACHE = 64\b/);
    expect(MAX_NAME_SPRITE_CACHE).toBe(64);
  });

  it('head sphere is smaller than the body cylinder and smoother', () => {
    const headGeo = new THREE_STUB.SphereGeometry(0.10, 12, 8);
    const bodyGeo = new THREE_STUB.CylinderGeometry(0.12, 0.12, 0.28, 8);
    expect(headGeo.radius).toBeLessThan(bodyGeo.radiusTop);
    expect(headGeo.widthSegments).toBeGreaterThan(bodyGeo.radialSegments);
  });
});

describe('dc-presence.js — name sprite cache (LRU)', () => {
  it('remote avatars get a nameplate sprite; the local user does not', () => {
    const { h, group } = withRemoteAvatar();
    expect(group.children.some((c) => c.isSprite)).toBe(true);
    expect(h.avatarGroups().length).toBe(1);
  });

  /**
   * CHARACTERISATION — documents a remaining gap, not intended behaviour.
   *
   * _nameSpriteCache is keyed by NAME and caches the Sprite itself, so every avatar
   * sharing a display name is handed the SAME Sprite instance. A Three.js Object3D
   * has exactly one parent and `add()` reparents, so the second avatar steals the
   * nameplate off the first: with two same-named peers only the last one is labelled.
   *
   * This used to be invisible because tests/js/__mocks__/three.js `add()` did not
   * reparent; the stub is now faithful, so the defect is observable here.
   *
   * Correct design: cache the TEXTURE per name with a refcount, and give each avatar
   * its own Sprite + SpriteMaterial over that shared texture.
   */
  it('CURRENT BEHAVIOUR (gap): same-named avatars share one Sprite, so only the last is labelled', () => {
    const h = makeHarness();
    h.installScene();
    h.auth();
    h.joined({ clientId: 'aaaaaaaaaaaaaaaaaaaa', uid: 1, name: 'Twin' });
    h.joined({ clientId: 'bbbbbbbbbbbbbbbbbbbb', uid: 2, name: 'Twin' });
    const [a, b] = h.avatarGroups();
    const spriteA = a.children.find((c) => c.isSprite);
    const spriteB = b.children.find((c) => c.isSprite);

    expect(spriteB).toBeTruthy();
    expect(spriteA).toBeUndefined();          // <-- should also be a Sprite
    expect(spriteB.parent).toBe(b);           // the single instance moved to the last avatar

    // Distinct names are unaffected — each gets its own nameplate.
    const h2 = makeHarness();
    h2.installScene();
    h2.auth();
    h2.joined({ clientId: 'cccccccccccccccccccc', uid: 3, name: 'Ann' });
    h2.joined({ clientId: 'dddddddddddddddddddd', uid: 4, name: 'Bob' });
    const plates = h2.avatarGroups().map((g) => g.children.find((c) => c.isSprite));
    expect(plates.filter(Boolean).length).toBe(2);
  });

  it('LRU eviction keeps the cache at MAX_NAME_SPRITE_CACHE entries', () => {
    const cache = new Map();
    const order = new Set();
    const add = (name) => {
      if (order.size >= MAX_NAME_SPRITE_CACHE) {
        const oldest = order.values().next().value;
        order.delete(oldest);
        cache.delete(oldest);
      }
      order.add(name);
      cache.set(name, { name });
    };
    for (let i = 0; i <= MAX_NAME_SPRITE_CACHE; i++) add('user' + i);
    expect(cache.size).toBe(MAX_NAME_SPRITE_CACHE);
    expect(cache.has('user0')).toBe(false);
    expect(cache.has('user' + MAX_NAME_SPRITE_CACHE)).toBe(true);
  });
});
