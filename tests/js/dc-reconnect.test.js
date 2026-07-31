/**
 * tests/js/dc-reconnect.test.js — reconnect / backoff regression suite
 *
 * ---------------------------------------------------------------------------
 * The bug (observed live on the running hub, confirmed in the server console)
 * ---------------------------------------------------------------------------
 * `onopen` in public_html/js/dc-ws.js resets BOTH `reconnectAttempts = 0` and
 * `reconnectDelay = 3000`. But the WebSocket handshake succeeds even when auth is
 * going to fail: the hub accepts the socket, rejects `auth.hello`, and closes.
 * So every failed-auth cycle re-opens, resets the counters, and retries at a flat
 * 3 seconds — forever:
 *
 *   - `maxReconnectAttempts = 10` is never reached
 *   - the exponential backoff never accumulates
 *   - the `else if (!self.closedByUs)` branch that latches degraded state and
 *     reports `exhausted` is UNREACHABLE for auth failures
 *
 * Who hits it: `/admin/dc.html` loaded directly (`DC_SESSION_ID` defaults to `""`,
 * so the hub answers `bad_session`), logged-out visitors, and anyone whose session
 * expires with the tab open. `/admin/dc.html` is also the Playwright fixture, so
 * E2E runs generate the storm too.
 *
 * ---------------------------------------------------------------------------
 * Contract asserted here
 * ---------------------------------------------------------------------------
 *   1. The backoff resets only on SUCCESSFUL AUTH, never merely on `onopen`.
 *   2. Terminal auth errors — `bad_session`, `unsupported_credential`,
 *      `ip_not_allowed` — are not retryable: one attempt, then latch degraded.
 *   3. Retryable failures still back off and still exhaust.
 *   4. A hub RESTART while authenticated must still reconnect and re-auth. A naive
 *      "never retry after a failure" fix breaks this, so it is pinned.
 *   5. In every failure mode the 3D scene stays initialised and interactive and
 *      nothing throws unhandled.
 *   6. `pong` is an EVENT (`op:'pong'`), not a `re`+`ok` reply — pinned so nobody
 *      "fixes" the server into a shape that silently turns the keepalive watchdog
 *      into a disconnect loop.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { loadStack, IDS, WS_SOURCE } from './helpers/dc-stack.js';

/** Auth error codes the hub returns that must NOT be retried. */
const TERMINAL_CODES = ['bad_session', 'unsupported_credential', 'ip_not_allowed'];

/**
 * One open -> auth-rejected -> close cycle, then let any scheduled reconnect run.
 * Mirrors the hub: the handshake succeeds, auth.hello is rejected, the hub closes.
 *
 * Returns false once the client has stopped producing fresh sockets, so a loop can
 * tell "still retrying" from "gave up" instead of re-driving a dead socket.
 * @returns {boolean} whether a NEW socket was constructed for the next attempt
 */
function authFailCycle(h, code = 'server_error') {
  const ws = h.socket();
  if (!ws || ws.readyState !== 0) return false;    // nothing fresh to connect
  const before = h.ctl.constructed;
  h.open();
  h.authFail({ code, message: 'rejected' });
  h.close(1006, 'auth rejected');
  h.runTimers(1);
  return h.ctl.constructed > before;
}

/** Drain any reconnect schedule for a while and report how many sockets appeared. */
function settle(h, rounds = 25) {
  for (let i = 0; i < rounds; i++) h.runTimers(1);
  return h.ctl.constructed;
}

// ================================================================
// 1. the storm itself — terminal auth failure must not retry
// ================================================================
describe('reconnect — a terminal auth failure latches degraded (no 3s storm)', () => {
  it('empty DC_SESSION_ID + bad_session produces exactly ONE auth attempt', () => {
    const h = loadStack({ scene: true, sessionId: '' });
    expect(h.opsSent('auth.hello').length).toBe(0);   // guard: nothing sent yet

    h.open();
    expect(h.opsSent('auth.hello')[0].data.session).toBe('');   // the real trigger
    h.authFail({ code: 'bad_session', message: 'no session' });
    h.close(1006, 'auth rejected');

    // No retry may be scheduled, no matter how long we wait.
    expect(settle(h)).toBe(1);
    expect(h.allFrames().filter((f) => f.op === 'auth.hello').length).toBe(1);
    h.expectClean();
  });

  it('and it latches degraded rather than looping', () => {
    const h = loadStack({ scene: true, sessionId: '' });
    h.open();
    h.authFail({ code: 'bad_session', message: 'no session' });
    h.close(1006);
    settle(h);

    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(h.win.DC_AUTHED).toBe(false);
    expect(h.count()).toBe(0);
    expect(h.labelPrefix()).toBe('Offline · ');
    // No timer is left holding a retry.
    expect(h.timers.length).toBe(0);
    h.expectClean();
  });

  for (const code of TERMINAL_CODES) {
    it(`${code} is treated as non-retryable`, () => {
      const h = loadStack({ scene: true, sessionId: '' });
      h.open();
      h.authFail({ code, message: code });
      h.close(1006);
      expect(settle(h)).toBe(1);
      expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
      h.expectClean();
    });
  }

  it('an op-shaped auth.rejected with a terminal code also stops the retries', () => {
    const h = loadStack({ scene: true, sessionId: '' });
    h.open();
    h.event('auth.rejected', { error: { code: 'bad_session', message: 'no session' } });
    h.close(1006);
    expect(settle(h)).toBe(1);
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    h.expectClean();
  });

  it('the scene stays interactive through a terminal auth failure', () => {
    const h = loadStack({ scene: true, sessionId: '' });
    h.open();
    h.authFail({ code: 'bad_session' });
    h.close(1006);
    settle(h);
    expect(() => {
      for (let i = 0; i < 60; i++) {
        h.clock.t += 16;
        h.win.DC_PRESENCE_MOVE(i, i, 0);
        h.frame(1 / 60);
      }
      h.win.DC_PRESENCE_JOIN();
      h.win.DC_PRESENCE_LEAVE();
      h.flushRaf();
    }).not.toThrow();
    expect(h.sceneTicks()).toBe(60);
    h.expectClean();
  });
});

// ================================================================
// 2. a successful open must NOT reset the backoff
//
// These drive a RETRYABLE rejection with a real session id. An empty session id is
// itself terminal (nothing to authenticate with), so it would stop after one
// attempt and never exercise the backoff at all.
// ================================================================
describe('reconnect — the backoff resets on successful AUTH, not on open', () => {
  const RETRYABLE = { scene: true, sessionId: 'php-sess-abc', random: 0.9999 };

  it('reconnectAttempts increases monotonically across failed-auth cycles', () => {
    const h = loadStack(RETRYABLE);
    const seen = [];
    for (let i = 0; i < 5; i++) {
      expect(authFailCycle(h, 'server_error')).toBe(true);   // guard: still retrying
      seen.push(h.client.reconnectAttempts);
    }
    // The bug: onopen zeroed this every cycle, so `seen` was [1,1,1,1,1].
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    h.expectClean();
  });

  it('reconnectDelay accumulates instead of staying pinned at 3000ms', () => {
    const h = loadStack(RETRYABLE);
    expect(h.client.reconnectDelay).toBe(3000);
    for (let i = 0; i < 4; i++) authFailCycle(h, 'server_error');
    // Roughly doubling per attempt with the jitter pinned near 1.0.
    expect(h.client.reconnectDelay).toBeGreaterThan(20000);
    expect(h.client.reconnectDelay).toBeLessThanOrEqual(30000);
    h.expectClean();
  });

  it('the delay is capped at 30000ms however many cycles run', () => {
    const h = loadStack(RETRYABLE);
    for (let i = 0; i < 9; i++) authFailCycle(h, 'server_error');
    expect(h.client.reconnectDelay).toBeLessThanOrEqual(30000);
    h.expectClean();
  });

  it('repeated failed auth EXHAUSTS instead of retrying forever', () => {
    const h = loadStack(RETRYABLE);
    for (let i = 0; i < 15; i++) authFailCycle(h, 'server_error');
    expect(h.client.reconnectAttempts).toBe(h.client.maxReconnectAttempts);
    expect(h.statuses()).toContain('exhausted');
    // ...and then it really stops.
    const before = h.ctl.constructed;
    settle(h);
    expect(h.ctl.constructed).toBe(before);
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(h.count()).toBe(0);
    h.expectClean();
  });

  it('the total number of auth attempts is bounded, not unbounded', () => {
    const h = loadStack(RETRYABLE);
    for (let i = 0; i < 40; i++) authFailCycle(h, 'server_error');
    const attempts = h.allFrames().filter((f) => f.op === 'auth.hello').length;
    // The bug produced one attempt per iteration, forever.
    expect(attempts).toBeLessThanOrEqual(h.client.maxReconnectAttempts + 1);
    expect(attempts).toBeGreaterThan(1);      // guard: it really did retry a while
    h.expectClean();
  });

  it('an empty session id + a RETRYABLE code still retries, but boundedly', () => {
    // Terminality is a property of the hub's error CODE, not of our own session
    // string: a transient server_error from a mid-restart hub must stay retryable
    // even when DC_SESSION_ID happens to be empty. The anti-storm guarantee is that
    // it is BOUNDED, not that it never retries.
    const h = loadStack({ scene: true, sessionId: '', random: 0.9999 });
    for (let i = 0; i < 40; i++) authFailCycle(h, 'server_error');
    const attempts = h.allFrames().filter((f) => f.op === 'auth.hello').length;
    expect(attempts).toBeLessThanOrEqual(h.client.maxReconnectAttempts + 1);
    expect(h.statuses()).toContain('exhausted');
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    h.expectClean();
  });

  it('a bare close with a hello still pending is retried (mid-restart hub) but bounded', () => {
    // The hub can hang up without answering. That looks identical to a restart, so
    // it must NOT latch terminal — it just burns one attempt from the budget.
    const h = loadStack({ scene: true, sessionId: '', random: 0.9999 });
    for (let i = 0; i < 40; i++) {
      const ws = h.socket();
      if (!ws || ws.readyState !== 0) break;
      h.open();
      h.close(1006, 'hub hung up');
      h.runTimers(1);
    }
    expect(h.ctl.constructed).toBeLessThanOrEqual(h.client.maxReconnectAttempts + 1);
    expect(h.statuses()).toContain('exhausted');
    expect(settle(h, 40)).toBe(h.ctl.constructed);
    h.expectClean();
  });

  it('the source resets the backoff from the auth-success path, not from onopen', () => {
    // Cheap tripwire against a revert: the two resets must not sit in onopen.
    const onopen = WS_SOURCE.slice(
      WS_SOURCE.indexOf('this.ws.onopen = function'),
      WS_SOURCE.indexOf('this.ws.onmessage = function')
    );
    expect(onopen.length).toBeGreaterThan(50);      // guard: the slice found the block
    expect(onopen).not.toMatch(/reconnectAttempts\s*=\s*0/);
    expect(onopen).not.toMatch(/reconnectDelay\s*=\s*3000/);
  });

  it('the scene stays interactive through the whole storm window', () => {
    const h = loadStack(RETRYABLE);
    let frames = 0;
    for (let i = 0; i < 15; i++) {
      authFailCycle(h, 'server_error');
      for (let f = 0; f < 4; f++) { h.frame(1 / 60); frames++; }
    }
    expect(frames).toBe(60);
    expect(h.sceneTicks()).toBe(frames);
    h.expectClean();
  });
});

// ================================================================
// 3. hub unreachable at load — bounded retries, then degraded
// ================================================================
describe('reconnect — hub unreachable at load is bounded', () => {
  it('a socket that never opens retries at most maxReconnectAttempts times', () => {
    const h = loadStack({ scene: true, random: 0.9999 });
    for (let i = 0; i < 30; i++) { h.close(1006); h.runTimers(1); }
    expect(h.client.reconnectAttempts).toBe(h.client.maxReconnectAttempts);
    expect(h.ctl.constructed).toBe(h.client.maxReconnectAttempts + 1);
    expect(h.statuses()).toContain('exhausted');
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    h.expectClean();
  });

  it('nothing further is attempted after exhaustion', () => {
    const h = loadStack({ scene: true, random: 0.9999 });
    for (let i = 0; i < 30; i++) { h.close(1006); h.runTimers(1); }
    const before = h.ctl.constructed;
    expect(settle(h, 50)).toBe(before);
    expect(h.timers.length).toBe(0);
    h.expectClean();
  });

  it('a constructor throw stops immediately — no retry loop at all', () => {
    const h = loadStack({ scene: true, throwOnConstruct: true });
    expect(settle(h, 50)).toBe(1);
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    h.expectClean();
  });

  it('the scene stays interactive across every retry', () => {
    const h = loadStack({ scene: true, random: 0.9999 });
    let frames = 0;
    for (let i = 0; i < 30; i++) {
      h.close(1006);
      h.runTimers(1);
      h.frame(1 / 60);
      frames++;
    }
    expect(h.sceneTicks()).toBe(frames);
    h.expectClean();
  });
});

// ================================================================
// 4. a hub RESTART while authenticated must still recover
// ================================================================
describe('reconnect — a hub restart while authenticated still recovers', () => {
  it('reconnects and re-authenticates after the hub drops us', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    h.open();
    h.authOk();
    expect(h.count()).toBe(1);

    h.close(1006, 'hub restarting');
    expect(h.client.authed).toBe(false);
    h.runTimers(1);                     // the retry must still happen
    expect(h.ctl.constructed).toBe(2);

    h.open();
    h.authOk();
    expect(h.win.DC_AUTHED).toBe(true);
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('a successful auth resets the backoff counters', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    // Burn a few retries first so there is something to reset.
    for (let i = 0; i < 3; i++) { h.close(1006); h.runTimers(1); }
    expect(h.client.reconnectAttempts).toBe(3);
    expect(h.client.reconnectDelay).toBeGreaterThan(3000);

    h.open();
    h.authOk();
    expect(h.client.reconnectAttempts).toBe(0);
    expect(h.client.reconnectDelay).toBe(3000);
    h.expectClean();
  });

  it('ten hub restarts in a row all recover (the counter never runs out)', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    h.open();
    h.authOk();
    for (let i = 0; i < 10; i++) {
      h.close(1006, 'hub restarting');
      h.runTimers(1);
      h.open();
      h.authOk();
      expect(h.win.DC_AUTHED).toBe(true);
    }
    expect(h.count()).toBe(1);
    expect(h.client.reconnectAttempts).toBe(0);
    h.expectClean();
  });

  it('a session that expires mid-flight degrades and does not storm', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    h.open();
    h.authOk();
    expect(h.count()).toBe(1);

    // The hub restarts; our PHP session has since expired.
    h.close(1006, 'hub restarting');
    h.runTimers(1);
    h.open();
    h.authFail({ code: 'bad_session', message: 'expired' });
    h.close(1006);

    const before = h.ctl.constructed;
    expect(settle(h)).toBe(before);
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(h.count()).toBe(0);
    h.expectClean();
  });

  /**
   * onclose must clear the WINDOW mirror `window.DC_AUTHED`, not only the instance
   * flag `self.authed`. Three modules read the mirror and will otherwise believe
   * they are still authenticated on a dead socket:
   *   public_html/js/dc-chat.js:733   — re-joins chat:noc over nothing
   *   public_html/js/dc-multi.js:941  — DCM.getConnected() reports connected
   *   public_html/js/dc.js:3096       — the GPU-context-loss session backup records
   *                                     authenticated:true and tries to restore auth
   */
  it('window.DC_AUTHED is cleared as soon as the socket closes', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    h.open();
    h.authOk();
    expect(h.win.DC_AUTHED).toBe(true);       // guard: it really was set

    h.close(1006, 'hub restarting');
    expect(h.client.authed).toBe(false);
    expect(h.win.DC_AUTHED).toBe(false);
    h.expectClean();
  });

  it('window.DC_AUTHED comes back true after a successful re-auth', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    h.open();
    h.authOk();
    h.close(1006, 'hub restarting');
    expect(h.win.DC_AUTHED).toBe(false);

    h.runTimers(1);
    h.open();
    h.authOk();
    expect(h.win.DC_AUTHED).toBe(true);
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('DC_AUTHED stays false through a whole exhausted retry sequence', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    h.open();
    h.authOk();
    h.close(1006);
    for (let i = 0; i < 15; i++) {
      expect(h.win.DC_AUTHED).toBe(false);
      h.runTimers(1);
      const ws = h.socket();
      if (ws && ws.readyState === 0) { h.open(); h.close(1006); }
    }
    expect(h.win.DC_AUTHED).toBe(false);
    h.expectClean();
  });

  it('remote avatars survive nothing but come back cleanly after the restart', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc', random: 0.9999 });
    h.open();
    h.authOk();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.bot, uid: 900, name: 'NOC Bot' });
    expect(h.count()).toBe(3);

    h.close(1006, 'hub restarting');
    expect(h.avatarGroups().length).toBe(0);
    h.runTimers(1);
    h.open();
    h.authOk();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.bot, uid: 900, name: 'NOC Bot' });
    expect(h.count()).toBe(3);
    expect(h.avatarGroups().length).toBe(2);
    h.expectClean();
  });
});

// ================================================================
// 5. pong is an EVENT, not a reply — pin the wire shape
// ================================================================
describe('reconnect — pong wire shape pins the keepalive watchdog', () => {
  /** Authenticated with one keepalive ping outstanding. */
  function pinged() {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc' });
    h.open();
    h.authOk();
    expect(h.intervals.length).toBe(1);       // guard: keepalive registered
    h.tickKeepalive();
    const pings = h.opsSent('ping');
    expect(pings.length).toBe(1);             // guard: a ping really went out
    expect(h.client._pingOutstandingSince).toBeTruthy();
    return { h, pingId: pings[0].id };
  }

  it('an EVENT-shaped pong (op:"pong") clears the watchdog and records latency', () => {
    const { h } = pinged();
    // Events.php:825 answers a client ping with an event frame: v/id/op/ts/data,
    // and NO `ok`. This is the only shape dc-ws recognises as a pong.
    h.deliver({ v: 1, id: 'srv-evt-1', op: 'pong', ts: 1700000000, data: {} });
    expect(h.client._pingOutstandingSince).toBeNull();
    expect(h.client._lastPongTs).toBeTruthy();
    expect(typeof h.win.DC_LATENCY).toBe('number');
    h.expectClean();
  });

  it('a REPLY-shaped pong (re + ok, no op) does NOT clear the watchdog', () => {
    // Documents the stakes: if the server were "fixed" to answer ping with a
    // correlated reply, dc-ws would never see a pong, the watchdog would fire, and
    // the client would close and reconnect every 60s forever.
    const { h, pingId } = pinged();
    h.deliver({ v: 1, re: pingId, ok: true, data: {} });
    expect(h.client._pingOutstandingSince).not.toBeNull();
    expect(h.win.DC_LATENCY).toBeNull();
    h.expectClean();
  });

  it('and the un-cleared watchdog really does force a reconnect', () => {
    const { h, pingId } = pinged();
    h.deliver({ v: 1, re: pingId, ok: true, data: {} });     // wrong shape
    // Age the outstanding ping past 2x the 30s keepalive interval.
    h.client._pingOutstandingSince = Date.now() - 61000;
    h.tickKeepalive();
    expect(h.socket().readyState).toBe(3);                   // CLOSED
    expect(h.statuses()).toContain('disconnected');
    h.expectClean();
  });

  it('an event-shaped pong keeps the socket alive across many keepalive ticks', () => {
    const { h } = pinged();
    for (let i = 0; i < 10; i++) {
      h.deliver({ v: 1, id: 'srv-evt-' + i, op: 'pong', ts: 1700000000, data: {} });
      h.tickKeepalive();
    }
    expect(h.client.connected()).toBe(true);
    expect(h.win.DC_AUTHED).toBe(true);
    expect(h.statuses()).not.toContain('disconnected');
    h.expectClean();
  });

  it('an inbound server ping is answered with an op-shaped pong', () => {
    const h = loadStack({ scene: true, sessionId: 'php-sess-abc' });
    h.open();
    h.authOk();
    h.event('ping', { t: 1 });
    const pongs = h.opsSent('pong');
    expect(pongs.length).toBe(1);
    expect(pongs[0].op).toBe('pong');
    expect(pongs[0].v).toBe(1);
    expect(typeof pongs[0].id).toBe('string');
    expect(pongs[0].re).toBeUndefined();      // we answer with an event, not a reply
    h.expectClean();
  });
});
