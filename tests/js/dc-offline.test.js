/**
 * tests/js/dc-offline.test.js — OWNER REQUIREMENT #1
 *
 *   "The scene must work fully when the WebSocket server is unreachable, just
 *    without multi-user."
 *
 * Every degraded transport path is driven end to end through the REAL dc-ws.js
 * and dc-presence.js (loaded together by tests/js/helpers/dc-stack.js), and in
 * each one the assertions are the same three things:
 *
 *   1. the 3D scene still initialises and keeps ticking (stays interactive),
 *   2. nothing throws — including inside a DOM listener, which dc-ws's
 *      _setStatus() swallows in a try/catch (hence h.expectClean()),
 *   3. the badge says "not multiplayer" instead of silently reading "nobody
 *      else is here".
 *
 * Paths covered: constructor throw · immediate close · close mid-handshake ·
 * auth rejected (empty session id) · a hub that accepts the socket and never
 * answers auth.hello · reconnect exhaustion · reconnect cycling.
 *
 * ---------------------------------------------------------------------------
 * The first describe() block is deliberately about the HARNESS, not the module.
 * Eight tests in this suite have already shipped asserting fictions, one of them
 * because `WebSocket` was missing from the vm sandbox so every connected-socket
 * assertion passed with no socket at all. Those guards fail loudly if that class
 * of regression comes back.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { loadStack, IDS, WS_SOURCE, PRESENCE_SOURCE } from './helpers/dc-stack.js';

// ================================================================
// Anti-vacuity guards — these protect every other test in the file
// ================================================================
describe('dc-offline — harness guards (fail loudly if assertions go vacuous)', () => {
  it('WebSocket is reachable as a BARE identifier inside the sandbox', () => {
    // dc-ws.js writes `new WebSocket(url, 'v1')` and `WebSocket.OPEN` bare, so it
    // must be a sandbox global. When it was only on `win`, the constructor threw
    // ReferenceError, the client silently sat in its degraded path, and every
    // "the client sent X over the socket" assertion in the suite was vacuous.
    expect(WS_SOURCE).toMatch(/new WebSocket\(/);
    expect(WS_SOURCE).toMatch(/WebSocket\.OPEN/);

    const h = loadStack();
    expect(h.ctl.constructed).toBe(1);
    expect(h.socket()).toBeTruthy();
    expect(h.socket().url).toBe('wss://mystage.interserver.net:7272');
    expect(h.socket().protocol).toBe('v1');
  });

  it('a genuinely opened socket reports connected() and really carries frames', () => {
    const h = loadStack();
    expect(h.client.connected()).toBe(false);   // CONNECTING
    h.open();
    expect(h.client.connected()).toBe(true);    // guard: not vacuous below
    expect(h.frames().length).toBeGreaterThan(0);
  });

  it('the mock socket THROWS on send() while not OPEN, so silent drops are impossible', () => {
    const h = loadStack();
    expect(() => h.socket().send('{}')).toThrow(/InvalidStateError/);
  });

  it('both modules are really loaded — dc-ws and dc-presence exports coexist', () => {
    const h = loadStack();
    expect(typeof h.win.DC_WS).toBe('object');
    expect(typeof h.win.DC_PRESENCE_SEND).toBe('function');   // dc-ws
    expect(typeof h.win.DC_PRESENCE_JOIN).toBe('function');   // dc-presence
    expect(h.win.DC_PRESENCE_JOIN.name).toBe('joinScene');
  });

  it('DOM events really flow from dc-ws to dc-presence (no hand-fired shortcuts)', () => {
    const h = loadStack({ scene: true });
    // dc-presence is listening for the events dc-ws dispatches on document.
    expect(h.listenerCount('dc:auth-success')).toBe(1);
    expect(h.listenerCount('dc:v1-event')).toBe(1);
    expect(h.listenerCount('dc:ws-status')).toBe(1);
    expect(h.listenerCount('dc:disconnected')).toBe(1);

    h.open();
    h.authOk();   // a socket FRAME, not a synthesised CustomEvent
    // dc-presence saw it and wrote the badge at the far end.
    expect(h.count()).toBe(1);
  });

  it('h.expectClean() actually detects a listener that threw', () => {
    const h = loadStack({ scene: true });
    h.doc.addEventListener('dc:ws-status', () => { throw new Error('boom'); });
    h.open();                    // dispatches dc:ws-status('connected')
    expect(() => h.expectClean()).toThrow(/boom/);
  });

  it('an op-LESS correlated reply is what actually authenticates the client', () => {
    const h = loadStack();
    h.open();
    const helloId = h.client._helloId;
    expect(typeof helloId).toBe('string');
    // The exact wire frame, written out in full: no `op` key exists on it. An
    // earlier revision of this suite asserted an op-shaped `auth.welcome` event
    // the hub never sends, which is how "can never authenticate" shipped.
    h.deliver({
      v: 1,
      re: helloId,
      ok: true,
      data: { session: 'sess', uid: 42, clientId: IDS.self, name: 'Tester', hub_time: 1700000000 },
    });
    expect(h.win.DC_AUTHED).toBe(true);
    expect(h.win.DC_UID).toBe(42);
    expect(h.win.DC_CLIENT_ID).toBe(IDS.self);
    // Replies clear the stored hello id — that is how dc-ws correlates them.
    expect(h.client._helloId).toBeNull();
  });

  it('client ids in fixtures are 20-char hex STRINGS, never ints', () => {
    for (const key of ['self', 'selfTab2', 'remote', 'remote2']) {
      expect(typeof IDS[key]).toBe('string');
      expect(IDS[key]).toMatch(/^[0-9a-f]{20}$/);
    }
  });

  it('dc-presence is loaded from source with its THREE import stripped, not stubbed out', () => {
    // If the strip ever silently produced an empty module the tests below would
    // all pass while testing nothing.
    expect(PRESENCE_SOURCE).toMatch(/^import \* as THREE from "three";$/m);
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    h.presenceJoined();
    // A real avatar built out of the real THREE stub geometry.
    expect(h.avatarGroups().length).toBe(1);
    expect(h.avatarGroups()[0].children.length).toBeGreaterThanOrEqual(2);
  });
});

// ================================================================
// A. the WebSocket constructor throws (hub unreachable / blocked)
// ================================================================
describe('dc-offline — A: WebSocket constructor throws', () => {
  it('disables multiplayer, reports error status, and does not throw out of init', () => {
    const h = loadStack({ throwOnConstruct: true, scene: true });
    expect(h.ctl.constructed).toBe(1);          // guard: we really tried
    expect(h.socket()).toBeNull();
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(h.statuses()).toEqual(['connecting', 'error']);
    h.expectClean();
  });

  it('the badge reads Offline instead of "nobody else here"', () => {
    const h = loadStack({ throwOnConstruct: true, scene: true });
    // dc-presence seeds from DC_WS.status because it missed the first event.
    expect(h.labelPrefix()).toBe('Offline · ');
    expect(h.count()).toBe(0);
    expect(h.dotActive()).toBe(false);
    expect(h.dotColor()).toBe('#d9534f');
    expect(h.badgeTitle()).toMatch(/Multiplayer unavailable/);
  });

  it('the 3D scene still initialises and keeps ticking', () => {
    const h = loadStack({ throwOnConstruct: true, scene: true });
    expect(h.win.DC).toBeTruthy();
    expect(h.win.DC.scene).toBeTruthy();
    const before = h.sceneTicks();
    for (let i = 0; i < 30; i++) h.frame(1 / 60);
    expect(h.sceneTicks()).toBe(before + 30);
    h.expectClean();
  });

  it('every presence entry point is a silent no-op (walking around is safe)', () => {
    const h = loadStack({ throwOnConstruct: true, scene: true });
    expect(() => {
      h.win.DC_PRESENCE_JOIN(10, 20, 0.5);
      for (let i = 0; i < 50; i++) {
        h.clock.t += 200;
        h.win.DC_PRESENCE_MOVE(i, i, 0);
        h.frame(1 / 60);
      }
      h.win.DC_PRESENCE_LEAVE();
      h.runTimers();
      h.flushRaf();
    }).not.toThrow();
    expect(h.allFrames()).toEqual([]);      // no socket ever existed
    expect(h.count()).toBe(0);
    h.expectClean();
  });
});

// ================================================================
// B. the socket closes immediately, before it ever opens
// ================================================================
describe('dc-offline — B: socket closes immediately (never opens)', () => {
  it('reports disconnected, keeps the scene alive, schedules a retry', () => {
    const h = loadStack({ scene: true });
    h.close(1006, 'abnormal closure');

    expect(h.statuses()).toEqual(['connecting', 'disconnected']);
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.count()).toBe(0);
    expect(h.labelPrefix()).toBe('Offline · ');
    expect(h.dotActive()).toBe(false);
    // A retry is pending, and it is the ONLY thing pending.
    expect(h.timers.length).toBe(1);
    expect(h.client.reconnectAttempts).toBe(1);

    for (let i = 0; i < 10; i++) h.frame(1 / 60);
    expect(h.sceneTicks()).toBe(10);
    h.expectClean();
  });

  it('no auth.hello was ever sent, and no presence op was attempted', () => {
    const h = loadStack({ scene: true });
    h.close(1006);
    h.win.DC_PRESENCE_JOIN(5, 6, 0);
    h.flushRaf();
    expect(h.allFrames()).toEqual([]);
    h.expectClean();
  });

  it('reconnect exhaustion turns multiplayer off for good without throwing', () => {
    const h = loadStack({ scene: true });
    // Never let a socket open: close each attempt as it is created.
    for (let i = 0; i < 12; i++) {
      h.close(1006);
      h.runTimers(1);            // fire the scheduled _connect()
    }
    expect(h.client.reconnectAttempts).toBe(h.client.maxReconnectAttempts);
    expect(h.statuses()).toContain('exhausted');
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(h.labelPrefix()).toBe('Offline · ');
    expect(h.dotColor()).toBe('#8a8f98');    // exhausted: grey, no glow
    expect(h.count()).toBe(0);

    for (let i = 0; i < 20; i++) h.frame(1 / 60);
    expect(h.sceneTicks()).toBe(20);
    h.expectClean();
  });
});

// ================================================================
// C. the socket closes mid-handshake (auth.hello sent, no reply yet)
// ================================================================
describe('dc-offline — C: close mid-handshake', () => {
  it('drops the in-flight auth.hello and leaves the client unauthenticated', () => {
    const h = loadStack({ scene: true });
    h.open();
    expect(h.client._helloId).toBeTruthy();     // guard: handshake really started
    expect(h.opsSent('auth.hello').length).toBe(1);

    h.close(1006, 'hub went away');

    expect(h.client._helloId).toBeNull();
    expect(h.client.authed).toBe(false);
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.count()).toBe(0);
    expect(h.labelPrefix()).toBe('Offline · ');
    h.expectClean();
  });

  it('a LATE auth reply arriving after the close does not authenticate', () => {
    const h = loadStack({ scene: true });
    h.open();
    const staleHelloId = h.client._helloId;
    h.close(1006);

    // The hub's answer overtakes the close. _helloId is already null, so this
    // must NOT be treated as our welcome.
    h.socket().onmessage({
      data: JSON.stringify({ v: 1, re: staleHelloId, ok: true, data: { uid: 42, clientId: IDS.self, name: 'Tester' } }),
    });
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.count()).toBe(0);
    h.expectClean();
  });

  it('the scene stays interactive across the whole aborted handshake', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.frame(1 / 60);
    h.close(1006);
    for (let i = 0; i < 20; i++) h.frame(1 / 60);
    expect(h.sceneTicks()).toBe(21);
    h.expectClean();
  });

  it('a mid-handshake close after remote avatars existed nukes them all', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    h.presenceJoined({ clientId: IDS.remote });
    h.presenceJoined({ clientId: IDS.remote2, uid: 8, name: 'Remote2' });
    expect(h.avatarGroups().length).toBe(2);
    expect(h.count()).toBe(3);

    h.close(1006);
    expect(h.avatarGroups().length).toBe(0);
    expect(h.count()).toBe(0);
    h.expectClean();
  });
});

// ================================================================
// D. auth rejected — empty / missing PHP session id
// ================================================================
describe('dc-offline — D: auth rejected (empty session id)', () => {
  it('an empty DC_SESSION_ID still produces a well-formed auth.hello', () => {
    const h = loadStack({ sessionId: '', scene: true });
    h.open();
    const hello = h.opsSent('auth.hello')[0];
    expect(hello.v).toBe(1);
    expect(typeof hello.id).toBe('string');
    expect(hello.op).toBe('auth.hello');
    expect(typeof hello.ts).toBe('number');
    expect(hello.data).toEqual({ role: 'admin', session: '' });
  });

  it('a completely absent DC_SESSION_ID degrades to session:"" (never undefined)', () => {
    const h = loadStack({ scene: true });   // no sessionId key at all
    expect(h.win.DC_SESSION_ID).toBeUndefined();
    h.open();
    expect(h.opsSent('auth.hello')[0].data.session).toBe('');
  });

  it('the ok:false reply disables presence and never renders the local user', () => {
    const h = loadStack({ sessionId: '', scene: true });
    h.open();
    h.authFail({ code: 'AUTH_FAILED', message: 'no admin session' });

    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.client.authed).toBe(false);
    expect(h.client._helloId).toBeNull();
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(h.eventsOf('dc:auth-failure').length).toBe(1);
    expect(h.eventsOf('dc:auth-failure')[0].detail.error.code).toBe('AUTH_FAILED');
    expect(h.count()).toBe(0);
    expect(h.dotActive()).toBe(false);
    h.expectClean();
  });

  it('no dc.presence.join is ever sent after a rejected auth', () => {
    const h = loadStack({ sessionId: '', scene: true });
    h.open();
    h.authFail();
    h.win.DC_PRESENCE_JOIN(1, 2, 3);
    h.clock.t += 500;
    h.win.DC_PRESENCE_MOVE(4, 5, 6);
    h.flushRaf();
    h.runTimers();
    expect(h.opsSent('dc.presence.join')).toEqual([]);
    expect(h.opsSent('dc.presence.move')).toEqual([]);
    h.expectClean();
  });

  it('an ok:false reply for a NON-auth op leaves presence completely untouched', () => {
    // Replies correlate by `re`. A rejected channel.publish / unknown op answers
    // {ok:false} too, and treating that as an auth failure wiped every avatar and
    // latched DC_PRESENCE_ENABLED=false until the next reconnect — a chat error
    // killed multiplayer.
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc' });
    h.open();
    h.authOk();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.remote2, uid: 8, name: 'Bob' });
    expect(h.count()).toBe(3);

    h.deliver({
      v: 1,
      re: 'some-channel-publish-uuid',
      ok: false,
      error: { code: 'forbidden', message: 'not a member of chat:noc' },
    });

    expect(h.win.DC_AUTHED).toBe(true);
    expect(h.client.authed).toBe(true);
    expect(h.win.DC_PRESENCE_ENABLED).toBe(true);
    expect(h.count()).toBe(3);
    expect(h.avatarGroups().length).toBe(2);
    expect(h.eventsOf('dc:auth-failure').length).toBe(0);
    h.expectClean();
  });

  it('presence keeps working after a rejected non-auth request', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc' });
    h.open();
    h.authOk();
    h.deliver({ v: 1, re: 'unrelated', ok: false, error: { code: 'bad_op', message: 'unknown op' } });
    h.clock.t += 500;
    h.win.DC_PRESENCE_MOVE(7, 8, 0.2);
    h.flushRaf();
    expect(h.opsSent('dc.presence.move').length).toBe(1);
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    expect(h.count()).toBe(2);
    h.expectClean();
  });

  it('an op-shaped auth.rejected event is handled the same way', () => {
    const h = loadStack({ sessionId: '', scene: true });
    h.open();
    h.event('auth.rejected', { error: { code: 'BAD_SESSION', message: 'expired' } });
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(h.count()).toBe(0);
    h.expectClean();
  });

  it('the scene stays interactive with auth permanently rejected', () => {
    const h = loadStack({ sessionId: '', scene: true });
    h.open();
    h.authFail();
    expect(() => {
      for (let i = 0; i < 60; i++) {
        h.clock.t += 16;
        h.win.DC_PRESENCE_MOVE(i, i, 0);
        h.frame(1 / 60);
      }
    }).not.toThrow();
    expect(h.sceneTicks()).toBe(60);
    h.expectClean();
  });
});

// ================================================================
// E. the hub accepts the socket and NEVER answers auth.hello
// ================================================================
describe('dc-offline — E: hub accepts the socket but never replies', () => {
  it('stays unauthenticated with the handshake still in flight', () => {
    const h = loadStack({ scene: true });
    h.open();
    expect(h.client.connected()).toBe(true);        // guard: really open
    expect(typeof h.client._helloId).toBe('string'); // still awaiting a reply
    expect(h.client.authed).toBe(false);
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.win.DC_PRESENCE).toBeNull();
    expect(h.statuses()).toEqual(['connecting', 'connected']);
    h.expectClean();
  });

  it('the badge shows a connected transport with nobody in the scene', () => {
    const h = loadStack({ scene: true });
    h.open();
    // Transport is genuinely up, so the label is the connected one — but we are
    // not in the scene, so the dot must NOT read live.
    expect(h.labelPrefix()).toBe('Users: ');
    expect(h.count()).toBe(0);
    expect(h.dotActive()).toBe(false);
  });

  it('the keepalive sends no ping while unauthenticated', () => {
    const h = loadStack({ scene: true });
    h.open();
    expect(h.intervals.length).toBe(1);   // guard: a keepalive really registered
    h.tickKeepalive();
    h.tickKeepalive();
    expect(h.opsSent('ping')).toEqual([]);
    expect(h.client._pingOutstandingSince).toBeNull();
    h.expectClean();
  });

  it('joining without a uid parks the pose and never recurses away', () => {
    const h = loadStack({ scene: true });
    h.open();
    expect(() => {
      h.win.DC_PRESENCE_JOIN();       // dc-multi's spawn call, pre-auth
      h.runTimers();
    }).not.toThrow();
    h.flushRaf();
    expect(h.opsSent('dc.presence.join')).toEqual([]);
    h.expectClean();
  });

  it('the per-frame presence tick is installed and the scene keeps ticking', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.win.DC_PRESENCE_JOIN();          // starts watchScene -> wraps DC.tick
    h.runTimers();
    expect(Array.isArray(h.win.DC._presenceTicks)).toBe(true);
    expect(h.win.DC._presenceTicks.length).toBe(1);

    for (let i = 0; i < 40; i++) h.frame(1 / 60);
    expect(h.sceneTicks()).toBe(40);   // the wrapper still calls the real tick
    h.expectClean();
  });

  it('never becomes authenticated no matter how long the silence lasts', () => {
    const h = loadStack({ scene: true });
    h.open();
    for (let i = 0; i < 20; i++) {
      h.clock.t += 1000;
      h.tickKeepalive();
      h.runTimers(1);
      h.frame(1 / 60);
    }
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.count()).toBe(0);
    expect(h.avatarGroups()).toEqual([]);
    h.expectClean();
  });

  it('a hub that only ever sends unrelated replies never authenticates us', () => {
    const h = loadStack({ scene: true });
    h.open();
    // ok:true, but `re` belongs to somebody else's request.
    h.deliver({ v: 1, re: 'some-other-uuid', ok: true, data: { uid: 999, clientId: IDS.remote2 } });
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.count()).toBe(0);
    expect(h.client._helloId).toBeTruthy();   // ours is still pending
    h.expectClean();
  });
});

// ================================================================
// F. reconnect cycling — no leaked timers, listeners or avatars
// ================================================================
describe('dc-offline — F: reconnect cycles leak nothing', () => {
  function cycle(h) {
    h.close(1006);
    h.runTimers(1);      // scheduled _connect() builds a fresh socket
    h.open();
    h.authOk();
  }

  it('three reconnect cycles keep exactly one keepalive interval alive', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    expect(h.intervals.length).toBe(1);
    for (let i = 0; i < 3; i++) cycle(h);
    // clearInterval in this harness really removes the registration, so this is
    // measuring dc-ws's own bookkeeping, not the fake.
    expect(h.intervals.length).toBe(1);
    h.expectClean();
  });

  it('reconnect cycles never duplicate the visibilitychange listener', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    const before = h.listenerCount('visibilitychange');
    expect(before).toBe(1);
    for (let i = 0; i < 3; i++) cycle(h);
    expect(h.listenerCount('visibilitychange')).toBe(before);
  });

  it('reconnect cycles never duplicate the presence tick registration', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    h.runTimers();
    expect(h.win.DC._presenceTicks.length).toBe(1);
    for (let i = 0; i < 3; i++) { cycle(h); h.runTimers(); }
    expect(h.win.DC._presenceTicks.length).toBe(1);
    // One scene tick per frame, not four.
    const before = h.sceneTicks();
    h.frame(1 / 60);
    expect(h.sceneTicks()).toBe(before + 1);
    h.expectClean();
  });

  it('each reconnect mints a fresh _helloId and re-authenticates cleanly', () => {
    const h = loadStack({ scene: true });
    h.open();
    const first = h.client._helloId;
    h.authOk();
    cycle(h);
    const helloIds = h.allFrames().filter((f) => f.op === 'auth.hello').map((f) => f.id);
    expect(helloIds.length).toBe(2);
    expect(helloIds[0]).toBe(first);
    expect(helloIds[1]).not.toBe(first);
    h.expectClean();
  });

  it('DC_PRESENCE_SEND does not even reach DC_WS.send once the socket is gone', () => {
    // The gate lives in dc-ws's DC_PRESENCE_SEND (`if (window.DC_WS.connected())`).
    // _sendRaw() has its own readyState check, so asserting only on written frames
    // cannot tell the two guards apart — stub send() to observe the outer one.
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    const calls = [];
    h.client.send = (op, data) => calls.push({ op, data });

    h.win.DC_PRESENCE_SEND('dc.presence.move', { x: 1, z: 2, yaw: 0 });
    expect(calls.length).toBe(1);       // guard: the stub really is wired up

    h.close(1006);
    h.win.DC_PRESENCE_SEND('dc.presence.move', { x: 3, z: 4, yaw: 0 });
    h.win.DC_PRESENCE_SEND('dc.presence.leave', {});
    expect(calls.length).toBe(1);       // gated out before send() is reached
    h.expectClean();
  });

  it('destroy() suppresses further reconnects and clears the keepalive', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    h.client.destroy();
    expect(h.client.closedByUs).toBe(true);
    expect(h.intervals.length).toBe(0);
    expect(h.client._helloId).toBeNull();
    // destroy() closed the socket; its onclose must not schedule a retry, so no
    // further socket is ever constructed.
    h.runTimers();
    h.runTimers();
    expect(h.ctl.constructed).toBe(1);
    h.expectClean();
  });

  it('the scene keeps ticking through every reconnect cycle', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk();
    h.runTimers();
    let expected = 0;
    for (let i = 0; i < 4; i++) {
      cycle(h);
      h.runTimers();
      for (let f = 0; f < 5; f++) { h.frame(1 / 60); expected++; }
    }
    expect(h.sceneTicks()).toBe(expected);
    h.expectClean();
  });
});
