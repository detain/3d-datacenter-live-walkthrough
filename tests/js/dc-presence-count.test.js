/**
 * tests/js/dc-presence-count.test.js — OWNER REQUIREMENT #2
 *
 *   "When connected, the local user must appear in the presence count at the top."
 *
 * The count lives in #dcPresenceCount inside #dcPresenceLabel, next to
 * #dcPresenceDot, in the #dcPresence badge (public_html/admin/dc.html:134-136).
 * dc-presence.js writes it from `state.remote.size + (hasLocalUid() ? 1 : 0)`.
 *
 * Every test here drives the count through the REAL stack: a socket frame from
 * the hub → dc-ws.js → a `dc:auth-success` / `dc:v1-event` CustomEvent →
 * dc-presence.js → the DOM. Nothing hand-fires the events, so a break anywhere
 * along that chain fails these tests.
 *
 * Specifically asserted:
 *   - self is counted exactly once as soon as auth lands (connected + alone = 1)
 *   - the count tracks remote join / leave
 *   - reconnects never double-count self
 *   - a second TAB of the same uid counts as a distinct user, and neither tab
 *     counts itself twice
 *   - a rejected auth / disconnect drops the count back to 0
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { loadStack, IDS } from './helpers/dc-stack.js';

/** Authenticated, scene up, badge wired. */
function connected(opts = {}) {
  const h = loadStack(Object.assign({ scene: true, sessionId: 'php-sess-abc' }, opts));
  h.open();
  h.authOk(opts.auth);
  return h;
}

// ================================================================
// self appears in the count
// ================================================================
describe('presence count — the local user is counted', () => {
  it('is 0 before auth even though the socket is already open', () => {
    const h = loadStack({ scene: true });
    h.open();
    expect(h.client.connected()).toBe(true);   // guard: transport really up
    expect(h.count()).toBe(0);
  });

  it('becomes 1 the moment the auth reply lands — connected and alone is still one user', () => {
    const h = loadStack({ scene: true });
    h.open();
    expect(h.count()).toBe(0);
    h.authOk({ uid: 42, clientId: IDS.self, name: 'Tester' });
    expect(h.count()).toBe(1);
    expect(h.avatarGroups().length).toBe(0);   // self is drawn by dc-multi, not here
    h.expectClean();
  });

  it('the badge reads live (green .active dot) when connected and authed', () => {
    const h = connected();
    expect(h.labelPrefix()).toBe('Users: ');
    expect(h.dotActive()).toBe(true);
    // connected uses the stylesheet's .active rule — no inline colour override.
    expect(h.dotColor()).toBe('');
    expect(h.badgeTitle()).toBe('Multiplayer connected');
  });

  it('counts self once even when the hub omits clientId and only sends uid', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk({ clientId: undefined, uid: 42 });
    expect(h.count()).toBe(1);
    expect(h.win.DC_CLIENT_ID).toBe(42);       // falls back to uid
    h.expectClean();
  });

  it('counts self once for a uid of 0 (falsy but valid)', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.authOk({ uid: 0, clientId: IDS.self });
    // hasLocalUid() is a null/undefined check, not a truthiness check.
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('the deferred +200ms re-render does not change the count', () => {
    const h = connected();
    expect(h.count()).toBe(1);
    h.runTimers();          // dc-presence schedules setTimeout(updateIndicator, 200)
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('the local user is counted even with the scene not built yet', () => {
    const h = loadStack({});      // no DC at all
    h.open();
    h.authOk();
    expect(h.count()).toBe(1);
    h.expectClean();
  });
});

// ================================================================
// remote join / leave
// ================================================================
describe('presence count — tracks remote join and leave', () => {
  it('self + one remote = 2', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Remote' });
    expect(h.count()).toBe(2);
    expect(h.avatarGroups().length).toBe(1);
    h.expectClean();
  });

  it('self + two remotes = 3, and each leave decrements back down to 1', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.remote2, uid: 8, name: 'Bob' });
    expect(h.count()).toBe(3);

    h.presenceLeft({ clientId: IDS.remote });
    expect(h.count()).toBe(2);
    expect(h.avatarGroups().length).toBe(1);

    h.presenceLeft({ clientId: IDS.remote2 });
    expect(h.count()).toBe(1);              // still us
    expect(h.avatarGroups().length).toBe(0);
    h.expectClean();
  });

  it('a duplicate joined for the same clientId does not inflate the count', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    expect(h.count()).toBe(2);
    expect(h.avatarGroups().length).toBe(1);
    h.expectClean();
  });

  it('our OWN joined echo never adds a second copy of us', () => {
    const h = connected();
    // The hub broadcasts our join back to us with our own clientId.
    h.presenceJoined({ clientId: IDS.self, uid: 42, name: 'Tester' });
    expect(h.count()).toBe(1);
    expect(h.avatarGroups().length).toBe(0);
    h.expectClean();
  });

  it('a left for an unknown clientId is ignored (count unchanged)', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote });
    h.presenceLeft({ clientId: 'deadbeefdeadbeefdead' });
    expect(h.count()).toBe(2);
    h.expectClean();
  });

  it('a left for our OWN clientId cannot decrement us out of the count', () => {
    const h = connected();
    h.presenceLeft({ clientId: IDS.self, uid: 42 });
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('batch_updated (a MAP keyed by client id) moves peers without changing the count', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice', x: 0, z: 0 });
    expect(h.count()).toBe(2);
    // batch_updated data is keyed by client id — the client reads the MAP KEY.
    h.presenceBatch({
      [IDS.remote]: { uid: 7, name: 'Alice', x: 5, z: 6, yaw: 1, ts: 1700000001 },
      [IDS.self]: { uid: 42, name: 'Tester', x: 9, z: 9, yaw: 0, ts: 1700000001 },
    });
    expect(h.count()).toBe(2);              // self entry in the map is skipped
    expect(h.avatarGroups().length).toBe(1);
    h.expectClean();
  });

  it('batch_updated for an unknown key does not create a phantom user', () => {
    const h = connected();
    h.presenceBatch({ ffffffffffffffffffff: { uid: 99, name: 'Ghost', x: 1, z: 1, yaw: 0 } });
    expect(h.count()).toBe(1);
    expect(h.avatarGroups().length).toBe(0);
    h.expectClean();
  });
});

// ================================================================
// never double-counts across reconnects
// ================================================================
describe('presence count — never double-counts across reconnects', () => {
  function reconnect(h) {
    h.close(1006);
    h.runTimers(1);
    h.open();
    h.authOk();
  }

  it('a disconnect drops to 0 and a re-auth returns to exactly 1', () => {
    const h = connected();
    expect(h.count()).toBe(1);
    h.close(1006);
    expect(h.count()).toBe(0);
    h.runTimers(1);
    h.open();
    h.authOk();
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('five reconnect cycles still show exactly 1', () => {
    const h = connected();
    for (let i = 0; i < 5; i++) reconnect(h);
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('remotes from the previous session do not survive the reconnect', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.remote2, uid: 8, name: 'Bob' });
    expect(h.count()).toBe(3);

    reconnect(h);
    expect(h.count()).toBe(1);
    expect(h.avatarGroups().length).toBe(0);

    // The hub re-broadcasts them on the new connection; still 3, never 5.
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    h.presenceJoined({ clientId: IDS.remote2, uid: 8, name: 'Bob' });
    expect(h.count()).toBe(3);
    expect(h.avatarGroups().length).toBe(2);
    h.expectClean();
  });

  it('a reconnect that assigns a NEW clientId for the same uid still counts 1', () => {
    const h = connected();
    reconnect(h);
    // Hubs mint a fresh per-connection id on reconnect.
    h.close(1006);
    h.runTimers(1);
    h.open();
    h.authOk({ uid: 42, clientId: IDS.selfTab2 });
    expect(h.win.DC_CLIENT_ID).toBe(IDS.selfTab2);
    expect(h.count()).toBe(1);
    // The hub's stale broadcast for our OLD clientId must not become a remote us.
    h.presenceJoined({ clientId: IDS.self, uid: 42, name: 'Tester' });
    expect(h.count()).toBe(2);   // documented: the hub owns dedupe of its own stale ids
    h.expectClean();
  });

  it('an auth reply arriving twice does not count self twice', () => {
    const h = loadStack({ scene: true });
    h.open();
    const helloId = h.client._helloId;
    const frame = { v: 1, re: helloId, ok: true, data: { session: 's', uid: 42, clientId: IDS.self, name: 'Tester', hub_time: 1 } };
    h.deliver(frame);
    expect(h.count()).toBe(1);
    h.deliver(frame);      // replay; _helloId is already null so it is ignored
    expect(h.count()).toBe(1);
    h.expectClean();
  });
});

// ================================================================
// multiple tabs
// ================================================================
describe('presence count — multiple tabs of the same user', () => {
  it('a second tab (same uid, different clientId) counts as a distinct user', () => {
    const h = connected({ auth: { uid: 42, clientId: IDS.self } });
    // Our other tab authenticated with the same uid but its own connection id.
    h.presenceJoined({ uid: 42, clientId: IDS.selfTab2, name: 'Tester', x: 3, z: 4, yaw: 0 });
    expect(h.count()).toBe(2);
    expect(h.avatarGroups().length).toBe(1);
    h.expectClean();
  });

  it('the same-uid tab is keyed by clientId, so its move updates the right avatar', () => {
    const h = connected({ auth: { uid: 42, clientId: IDS.self } });
    h.presenceJoined({ uid: 42, clientId: IDS.selfTab2, name: 'Tester', x: 0, z: 0, yaw: 0 });
    h.presenceBatch({ [IDS.selfTab2]: { uid: 42, name: 'Tester', x: 20, z: 30, yaw: 0 } });
    // Drive the interpolation far enough to see it move toward the new target.
    for (let i = 0; i < 120; i++) h.frame(1 / 60, 16);
    const g = h.avatarGroups()[0];
    expect(g.position.x).toBeGreaterThan(10);
    expect(h.count()).toBe(2);
    h.expectClean();
  });

  it('a same-uid tab leaving takes the count back to 1, not 0', () => {
    const h = connected({ auth: { uid: 42, clientId: IDS.self } });
    h.presenceJoined({ uid: 42, clientId: IDS.selfTab2, name: 'Tester' });
    expect(h.count()).toBe(2);
    h.presenceLeft({ uid: 42, clientId: IDS.selfTab2 });
    expect(h.count()).toBe(1);
    h.expectClean();
  });

  it('three tabs of the same uid read as 3 without self appearing twice', () => {
    const h = connected({ auth: { uid: 42, clientId: IDS.self } });
    h.presenceJoined({ uid: 42, clientId: IDS.selfTab2, name: 'Tester' });
    h.presenceJoined({ uid: 42, clientId: 'aa11bb22cc33dd44ee55', name: 'Tester' });
    h.presenceJoined({ uid: 42, clientId: IDS.self, name: 'Tester' });   // our own echo
    expect(h.count()).toBe(3);
    expect(h.avatarGroups().length).toBe(2);
    h.expectClean();
  });

  it('batch_updated skips only OUR clientId, never the other same-uid tabs', () => {
    const h = connected({ auth: { uid: 42, clientId: IDS.self } });
    h.presenceJoined({ uid: 42, clientId: IDS.selfTab2, name: 'Tester', x: 0, z: 0 });
    h.presenceBatch({
      [IDS.self]: { uid: 42, x: 111, z: 111, yaw: 0 },
      [IDS.selfTab2]: { uid: 42, x: 7, z: 8, yaw: 0 },
    });
    for (let i = 0; i < 120; i++) h.frame(1 / 60, 16);
    const g = h.avatarGroups()[0];
    // Moved toward (7,8) — emphatically not to our own (111,111).
    expect(g.position.x).toBeCloseTo(7, 1);
    expect(g.position.x).toBeLessThan(20);
    h.expectClean();
  });

  /**
   * buildAvatar() must decide "is this me?" the same way the rest of the module
   * does — by CLIENT ID, not by uid. onJoined() has already filtered our own
   * connection out by clientId, so a uid comparison can only ever be true for
   * ANOTHER TAB OF THE SAME USER, which is precisely the avatar that does need a
   * nameplate. With the uid predicate your other tab renders anonymous.
   *
   * Correct predicate: `state.clientId !== null && key === idKey(state.clientId)`,
   * i.e. the remote's map key rather than its uid.
   */
  it('a same-uid / different-clientId tab DOES get a nameplate', () => {
    const h = connected({ auth: { uid: 42, clientId: IDS.self } });
    h.presenceJoined({ uid: 42, clientId: IDS.selfTab2, name: 'Tester' });

    const plate = h.nameplates()[0];
    expect(plate).toBeTruthy();
    expect(plate.isSprite).toBe(true);
    expect(plate.material.map).toBeTruthy();

    // A different uid gets one too — the two cases must not diverge.
    h.presenceJoined({ uid: 99, clientId: IDS.remote2, name: 'Someone Else' });
    expect(h.nameplates().filter(Boolean).length).toBe(2);
    h.expectClean();
  });

  it('our OWN connection is never rendered at all, so it has no nameplate', () => {
    const h = connected({ auth: { uid: 42, clientId: IDS.self } });
    // The hub echoes our own join back to us; it must not become an avatar.
    h.presenceJoined({ uid: 42, clientId: IDS.self, name: 'Tester' });
    expect(h.avatarGroups().length).toBe(0);
    expect(h.nameplates()).toEqual([]);
    expect(h.count()).toBe(1);
    h.expectClean();
  });
});

// ================================================================
// the count goes back to zero when multiplayer dies
// ================================================================
describe('presence count — drops to 0 when multiplayer dies', () => {
  it('a rejected auth after a good session clears self and all remotes', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote });
    expect(h.count()).toBe(2);
    h.event('auth.rejected', { error: { code: 'SESSION_EXPIRED', message: 'gone' } });
    expect(h.count()).toBe(0);
    expect(h.avatarGroups().length).toBe(0);
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    h.expectClean();
  });

  it('reconnect exhaustion leaves the count at 0 and the badge offline', () => {
    const h = connected();
    h.presenceJoined({ clientId: IDS.remote });
    for (let i = 0; i < 12; i++) { h.close(1006); h.runTimers(1); }
    expect(h.statuses()).toContain('exhausted');
    expect(h.count()).toBe(0);
    expect(h.labelPrefix()).toBe('Offline · ');
    h.expectClean();
  });

  it('a page with no #dcPresence markup at all never throws', () => {
    const h = loadStack({ scene: true, noBadge: true });
    expect(() => {
      h.open();
      h.authOk();
      h.presenceJoined({ clientId: IDS.remote });
      h.presenceLeft({ clientId: IDS.remote });
      h.close(1006);
    }).not.toThrow();
    expect(h.count()).toBeNull();     // no element to read
    h.expectClean();
  });
});
