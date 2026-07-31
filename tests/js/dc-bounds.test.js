/**
 * tests/js/dc-bounds.test.js — CONTRACT BOT-BOUNDS, revised contract
 *
 * The hub needs the room's world extents so it can spawn and wander its bot near
 * real players. The client reports them as an optional `bounds` field,
 * `{minX,maxX,minZ,maxZ}`, sourced from `window.DC.roomBounds`.
 *
 * ---------------------------------------------------------------------------
 * The bug this file is a regression test for
 * ---------------------------------------------------------------------------
 * `bounds` used to ride on `dc.presence.join` ONLY, and it lost a race it could
 * never win:
 *
 *   - `sceneReady()` (dc-presence.js:190) only checks `window.DC && window.DC.scene`,
 *     and dc.js exposes `scene` as a GETTER over a variable assigned during init()
 *     — so it is truthy almost immediately.
 *   - `roomBounds` is only assigned inside `buildRoom()` (dc.js:2603), after the
 *     ~1.5 MB /ajax/datacenter.php fetch and the geometry build — seconds later.
 *   - WS auth reliably wins that race, so `joinScene()` ran with
 *     `roomBounds === null` and the join shipped with no `bounds`.
 *   - the `joined` latch then made it PERMANENT: dc-multi's later
 *     `DC_PRESENCE_JOIN()` call (by which time bounds ARE available) takes the
 *     `if (joined)` branch and degrades into a `dc.presence.move`, which carried
 *     no bounds either. The hub therefore never learned the room extents, which
 *     is very likely why the bot was never seen.
 *
 * ---------------------------------------------------------------------------
 * Revised contract asserted below
 * ---------------------------------------------------------------------------
 *   1. `bounds` stays optional on `dc.presence.join`.
 *   2. `bounds` becomes optional on `dc.presence.move` too, same shape.
 *   3. The extents are reported ONCE shortly after the room builds, via the
 *      corrective move — and re-reported after a location switch.
 *   4. They are NOT attached to every move: that is a 50ms-batched hot path.
 *   5. Absent or invalid extents are OMITTED entirely — never sent as null,
 *      NaN, or a degenerate box.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { loadStack, PRESENCE_SOURCE } from './helpers/dc-stack.js';

const ROOM = { minX: -50, maxX: 250, minZ: 100, maxZ: 300 };
const ROOM_B = { minX: 400, maxX: 900, minZ: -200, maxZ: 80 };

/**
 * Authenticated with the room NOT yet built — the real startup order, and the
 * exact race that lost the bounds.
 */
function authedBeforeRoomBuilds(extra = {}) {
  const h = loadStack({ scene: true, sessionId: 'php-sess-abc', sceneExtra: Object.assign({ roomBounds: null }, extra) });
  h.open();
  h.authOk();
  h.flushRaf();
  return h;
}

/** Every presence frame that carried a `bounds` field, across all sockets. */
function boundsFrames(h) {
  return h.allFrames().filter((f) => f.op && f.op.indexOf('dc.presence.') === 0 && f.data && f.data.bounds !== undefined);
}

/** Simulate the player walking: throttle-respecting moves, each one flushed. */
function walk(h, steps = 12) {
  for (let i = 0; i < steps; i++) {
    h.clock.t += 200;                       // clear the 150ms move throttle
    h.win.DC_PRESENCE_MOVE(i * 1.5, i * 2, 0.1 * i);
    h.flushRaf();                           // dc-ws coalesces per frame, so flush each
  }
  h.runTimers();
}

// ================================================================
// 1. the race regression — the test that would have caught the bug
// ================================================================
describe('BOT-BOUNDS — regression: auth wins the race against buildRoom()', () => {
  it('the join goes out with NO bounds when roomBounds is still null', () => {
    const h = authedBeforeRoomBuilds();
    const join = h.opsSent('dc.presence.join')[0];
    expect(join).toBeTruthy();                       // guard: a join really went out
    expect(join.data.x).toBe(100);                   // ...at the roomSpawn pose
    expect(join.data.z).toBe(200);
    expect('bounds' in join.data).toBe(false);       // omitted, not null
    h.expectClean();
  });

  it('once roomBounds is populated the extents ARE reported exactly once', () => {
    const h = authedBeforeRoomBuilds();
    expect(boundsFrames(h).length).toBe(0);          // guard: nothing yet

    // buildRoom() finishes, seconds after auth.
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h);

    const reported = boundsFrames(h);
    expect(reported.length).toBe(1);
    expect(reported[0].op).toBe('dc.presence.move');
    expect(reported[0].data.bounds).toEqual(ROOM);
    h.expectClean();
  });

  it('the corrective move that dc-multi triggers on re-lock carries the extents', () => {
    // This is the exact call the old code threw away: DC_PRESENCE_JOIN() again,
    // with bounds now available, degrading into a move via the `joined` latch.
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    h.clock.t += 500;
    h.win.DC_PRESENCE_JOIN(120, 210, 0.5);
    h.flushRaf();
    h.runTimers();

    expect(h.opsSent('dc.presence.join').length).toBe(1);   // still exactly one join
    const reported = boundsFrames(h);
    expect(reported.length).toBe(1);
    expect(reported[0].op).toBe('dc.presence.move');
    expect(reported[0].data.bounds).toEqual(ROOM);
    h.expectClean();
  });

  it('the reported extents are the REAL room, not a fallback or a zero box', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM_B);
    walk(h);
    const b = boundsFrames(h)[0].data.bounds;
    expect(b).toEqual(ROOM_B);
    expect(b.maxX - b.minX).toBeGreaterThan(0);
    expect(b.maxZ - b.minZ).toBeGreaterThan(0);
  });

  it('the bounds payload carries exactly the four extent keys', () => {
    const h = authedBeforeRoomBuilds();
    // dc.js may hang extra properties off its own object; only the four ship.
    h.win.DC.roomBounds = Object.assign({}, ROOM, { doorSide: 'S', doorHalf: 8, _internal: 1 });
    walk(h);
    const b = boundsFrames(h)[0].data.bounds;
    expect(Object.keys(b).sort()).toEqual(['maxX', 'maxZ', 'minX', 'minZ']);
  });
});

// ================================================================
// 2. reported once, never on every move
// ================================================================
describe('BOT-BOUNDS — reported once, not on the hot path', () => {
  it('40 subsequent moves carry no further bounds', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 40);
    expect(boundsFrames(h).length).toBe(1);
    // ...and there really were plenty of moves to hide in.
    expect(h.allFrames().filter((f) => f.op === 'dc.presence.move').length).toBeGreaterThan(10);
    h.expectClean();
  });

  it('a room that is already built at auth time reports on the join instead', () => {
    const h = loadStack({ scene: true, sessionId: 's' });   // roomBounds valid from the start
    h.open();
    h.authOk();
    h.flushRaf();
    const join = h.opsSent('dc.presence.join')[0];
    expect(join.data.bounds).toEqual({ minX: -50, maxX: 250, minZ: 100, maxZ: 300 });

    walk(h, 20);
    // Exactly one report total — the join. No move repeats it.
    expect(boundsFrames(h).length).toBe(1);
    expect(boundsFrames(h)[0].op).toBe('dc.presence.join');
    h.expectClean();
  });

  it('unchanged roomBounds never triggers a second report', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 10);
    expect(boundsFrames(h).length).toBe(1);
    // Same extents, a fresh object identity — value equality must win.
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 10);
    expect(boundsFrames(h).length).toBe(1);
    h.expectClean();
  });

  it('a reconnect re-joins and reports the extents once for the new session', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 5);
    expect(boundsFrames(h).length).toBe(1);

    h.close(1006);
    h.runTimers(1);
    h.open();
    h.authOk();
    h.flushRaf();
    walk(h, 5);
    // One report per session, and the fresh join already knows the extents.
    expect(boundsFrames(h).length).toBe(2);
    h.expectClean();
  });
});

// ================================================================
// 3. the dc:respawn carrier — bounds land without the player moving
// ================================================================
describe('BOT-BOUNDS — dc:respawn reports the extents without the player moving', () => {
  it('the AFK case: respawn after the room builds reports once, zero player input', () => {
    // This is the failure mode the walk()-driven tests cannot catch. Attract mode,
    // a character model that never loaded, or an AFK admin never generates a move,
    // so if dc:respawn did not carry the extents the hub would never get them.
    const h = authedBeforeRoomBuilds();
    expect(boundsFrames(h).length).toBe(0);

    h.win.DC.roomBounds = Object.assign({}, ROOM);   // buildRoom()
    h.fire('dc:respawn', { x: 100, z: 200 });        // spawnInside(), dc.js:2621
    h.flushRaf();

    const reported = boundsFrames(h);
    expect(reported.length).toBe(1);
    expect(reported[0].op).toBe('dc.presence.move');
    expect(reported[0].data.bounds).toEqual(ROOM);
    h.expectClean();
  });

  it('respawn while roomBounds is still null sends nothing', () => {
    const h = authedBeforeRoomBuilds();
    h.fire('dc:respawn', { x: 100, z: 200 });
    h.flushRaf();
    expect(boundsFrames(h).length).toBe(0);
    h.expectClean();
  });

  it('respawn with a degenerate box sends nothing', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = { minX: 5, maxX: 5, minZ: 0, maxZ: 9 };
    h.fire('dc:respawn', {});
    h.flushRaf();
    expect(boundsFrames(h).length).toBe(0);
    h.expectClean();
  });

  /**
   * dc.js fires dc:respawn from spawnInside(), reachable two ways: the location
   * switch in displayDatacenter(), and the "you re-locked the pointer while stuck
   * in a rack / outside the walls" recovery in the PointerLockControls `lock`
   * handler (dc.js:2709). onRespawn() re-arms unconditionally, so the second path
   * re-sends the same extents. That is bounded by user clicks — NOT the per-frame
   * path the contract forbids — so it is acceptable; what must never happen is the
   * report leaking back onto the move stream.
   */
  it('a same-room respawn re-sends the extents but never taints later moves', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 4);
    expect(boundsFrames(h).length).toBe(1);

    h.clock.t += 1000;
    h.fire('dc:respawn', {});       // re-lock while stuck; same room
    h.flushRaf();
    expect(boundsFrames(h).length).toBe(2);
    expect(boundsFrames(h)[1].data.bounds).toEqual(ROOM);

    // The important half: the move stream is clean again immediately.
    walk(h, 30);
    expect(boundsFrames(h).length).toBe(2);
    h.expectClean();
  });

  it('rendering frames alone never triggers a bounds report', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    h.fire('dc:respawn', {});
    h.flushRaf();
    const after = boundsFrames(h).length;
    expect(after).toBe(1);
    for (let i = 0; i < 200; i++) { h.frame(1 / 60, 16); h.flushRaf(); }
    expect(boundsFrames(h).length).toBe(after);
    h.expectClean();
  });

  it('respawn while DC_PRESENCE_ENABLED is false sends nothing', () => {
    // The kill switch is set by dc-presence on every disconnect / auth failure, and
    // dc.js keeps firing dc:respawn regardless (location switches, stuck-player
    // recovery). Nothing may leak out while presence is suppressed.
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    h.close(1006);                                 // -> DC_PRESENCE_ENABLED = false
    expect(h.win.DC_PRESENCE_ENABLED).toBe(false);
    const before = h.allFrames().length;

    h.fire('dc:respawn', { x: 1, z: 2 });
    h.flushRaf();
    expect(h.allFrames().length).toBe(before);
    expect(boundsFrames(h).length).toBe(0);
    h.expectClean();
  });

  it('respawn is a silent no-op with the hub unreachable', () => {
    const h = loadStack({ throwOnConstruct: true, scene: true });
    expect(() => {
      h.fire('dc:respawn', { x: 1, z: 2 });
      h.flushRaf();
    }).not.toThrow();
    expect(h.allFrames()).toEqual([]);
    h.expectClean();
  });

  it('respawn before we are authenticated sends nothing', () => {
    const h = loadStack({ scene: true, sessionId: 's' });
    h.open();
    h.fire('dc:respawn', { x: 1, z: 2 });
    h.flushRaf();
    expect(boundsFrames(h).length).toBe(0);
    h.expectClean();
  });
});

// ================================================================
// 4. location switch re-reports (the real dc.js sequence)
// ================================================================
describe('BOT-BOUNDS — a location switch re-reports the new extents', () => {
  it('the full clearScene -> buildRoom -> spawnInside sequence re-reports once', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    h.fire('dc:respawn', {});
    h.flushRaf();
    expect(boundsFrames(h).length).toBe(1);
    expect(boundsFrames(h)[0].data.bounds).toEqual(ROOM);

    // dc.js's displayDatacenter() runs clearScene() (which calls DC_PRESENCE_LEAVE
    // and nulls roomBounds), buildRoom(), then spawnInside() — all synchronously,
    // so nothing can observe the null gap. dc-multi then re-announces on dc:respawn.
    h.clock.t += 1000;
    h.switchLocation(ROOM_B);

    const reported = boundsFrames(h);
    expect(reported.length).toBe(2);
    expect(reported[1].data.bounds).toEqual(ROOM_B);
    h.expectClean();
  });

  it('the post-switch join is the carrier (LEAVE cleared the joined latch)', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    h.fire('dc:respawn', {});
    h.flushRaf();

    h.clock.t += 1000;
    h.switchLocation(ROOM_B, { x: 500, z: 0, yaw: 0 });

    const joins = h.allFrames().filter((f) => f.op === 'dc.presence.join');
    expect(joins.length).toBe(2);                       // one per room
    expect(joins[1].data.bounds).toEqual(ROOM_B);       // the new room's extents
    expect(joins[1].data.x).toBe(500);
    h.expectClean();
  });

  it('the switch announces a leave and then a fresh join (the bounds carrier)', () => {
    // dc.js's clearScene() calls DC_PRESENCE_LEAVE() before rebuilding, so we
    // genuinely disappear from every other client for the duration of the switch.
    // The re-join that follows is what puts us back AND carries the new extents —
    // before the fix there was no re-join until the next pointer re-lock, so you
    // stayed invisible to everyone else.
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    h.fire('dc:respawn', {});
    h.flushRaf();

    const beforeLeaves = h.allFrames().filter((f) => f.op === 'dc.presence.leave').length;
    h.clock.t += 1000;
    h.switchLocation(ROOM_B, { x: 500, z: 10, yaw: 0 });

    const leaves = h.allFrames().filter((f) => f.op === 'dc.presence.leave');
    const joins = h.allFrames().filter((f) => f.op === 'dc.presence.join');
    expect(leaves.length).toBe(beforeLeaves + 1);
    expect(leaves[leaves.length - 1].data).toEqual({});
    expect(joins.length).toBe(2);
    expect(joins[1].data).toEqual({ x: 500, z: 10, yaw: 0, bounds: ROOM_B });
    h.expectClean();
  });

  it('three location switches produce three reports, one each', () => {
    const h = authedBeforeRoomBuilds();
    const rooms = [
      { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
      { minX: 20, maxX: 40, minZ: 20, maxZ: 40 },
      { minX: -90, maxX: -10, minZ: -90, maxZ: -10 },
    ];
    rooms.forEach((r, i) => {
      h.clock.t += 1000;
      h.switchLocation(r, { x: r.minX + 1, z: r.minZ + 1, yaw: i });
    });
    const reported = boundsFrames(h);
    expect(reported.length).toBe(3);
    expect(reported.map((f) => f.data.bounds)).toEqual(rooms);
    h.expectClean();
  });

  it('a switch into a room whose build fails reports nothing, then recovers', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    h.fire('dc:respawn', {});
    h.flushRaf();
    expect(boundsFrames(h).length).toBe(1);

    h.clock.t += 1000;
    h.switchLocation(null);                 // buildRoom() never assigned extents
    expect(boundsFrames(h).length).toBe(1);

    // The room eventually builds and the next move carries them.
    h.win.DC.roomBounds = Object.assign({}, ROOM_B);
    walk(h, 5);
    expect(boundsFrames(h).length).toBe(2);
    expect(boundsFrames(h)[1].data.bounds).toEqual(ROOM_B);
    h.expectClean();
  });

  it('switching straight from one room to another (no null gap) re-reports once', () => {
    // pendingBounds() compares the extents by VALUE, not identity. That matters
    // twice over: dc.js hands out a fresh roomBounds object on every buildRoom()
    // (identity would re-report the same room forever), and clearScene()'s null gap
    // is invisible to the client because it happens synchronously inside
    // displayDatacenter() — so a location switch is ONLY observable as a change in
    // the four numbers. A boolean "already reported" latch fails this test.
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 5);
    expect(boundsFrames(h).length).toBe(1);

    h.win.DC.roomBounds = Object.assign({}, ROOM_B);   // no null in between
    walk(h, 5);
    const reported = boundsFrames(h);
    expect(reported.length).toBe(2);
    expect(reported[0].data.bounds).toEqual(ROOM);
    expect(reported[1].data.bounds).toEqual(ROOM_B);
    h.expectClean();
  });

  it('a rebuilt room with identical extents is NOT re-reported (value, not identity)', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 5);
    expect(boundsFrames(h).length).toBe(1);
    // buildRoom() ran again for the same location: same numbers, new object.
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 10);
    expect(boundsFrames(h).length).toBe(1);
    h.expectClean();
  });

  it('roomBounds going null between moves reports nothing until it comes back', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 4);
    expect(boundsFrames(h).length).toBe(1);

    h.win.DC.roomBounds = null;
    walk(h, 4);
    expect(boundsFrames(h).length).toBe(1);      // nothing to report while null

    h.win.DC.roomBounds = Object.assign({}, ROOM_B);
    walk(h, 4);
    const reported = boundsFrames(h);
    expect(reported.length).toBe(2);
    expect(reported[1].data.bounds).toEqual(ROOM_B);
    h.expectClean();
  });
});

// ================================================================
// 4. selfBounds() validation — omitted, never null/NaN
// ================================================================
describe('BOT-BOUNDS — invalid extents are omitted, never sent as null or NaN', () => {
  const invalid = {
    'null roomBounds': null,
    'undefined roomBounds': undefined,
    'non-numeric strings': { minX: '-50', maxX: '250', minZ: '100', maxZ: '300' },
    'NaN minX': { minX: NaN, maxX: 250, minZ: 100, maxZ: 300 },
    'Infinity maxX': { minX: -50, maxX: Infinity, minZ: 100, maxZ: 300 },
    '-Infinity minZ': { minX: -50, maxX: 250, minZ: -Infinity, maxZ: 300 },
    'missing maxZ': { minX: -50, maxX: 250, minZ: 100 },
    'degenerate maxX === minX': { minX: 10, maxX: 10, minZ: 100, maxZ: 300 },
    'inverted maxX < minX': { minX: 250, maxX: -50, minZ: 100, maxZ: 300 },
    'degenerate maxZ === minZ': { minX: -50, maxX: 250, minZ: 100, maxZ: 100 },
    'inverted maxZ < minZ': { minX: -50, maxX: 250, minZ: 300, maxZ: 100 },
    'empty object': {},
  };

  for (const [label, value] of Object.entries(invalid)) {
    it(`omits bounds entirely for ${label} (on join)`, () => {
      const h = loadStack({ scene: true, sessionId: 's', sceneExtra: { roomBounds: value } });
      h.open();
      h.authOk();
      h.flushRaf();
      const join = h.opsSent('dc.presence.join')[0];
      expect(join).toBeTruthy();
      expect('bounds' in join.data).toBe(false);
      expect(join.data.bounds).toBeUndefined();
      h.expectClean();
    });

    it(`omits bounds entirely for ${label} (on move)`, () => {
      const h = authedBeforeRoomBuilds();
      h.win.DC.roomBounds = value;
      walk(h, 8);
      expect(boundsFrames(h).length).toBe(0);
      const moves = h.allFrames().filter((f) => f.op === 'dc.presence.move');
      expect(moves.length).toBeGreaterThan(0);      // guard: moves really went out
      for (const m of moves) expect('bounds' in m.data).toBe(false);
      h.expectClean();
    });
  }

  it('an invalid box followed by a valid one reports only the valid one', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = { minX: 10, maxX: 10, minZ: 0, maxZ: 5 };   // degenerate
    walk(h, 5);
    expect(boundsFrames(h).length).toBe(0);
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 5);
    expect(boundsFrames(h).length).toBe(1);
    expect(boundsFrames(h)[0].data.bounds).toEqual(ROOM);
    h.expectClean();
  });

  it('selfBounds() still validates finiteness and non-degeneracy in the source', () => {
    // Cheap tripwire: the four numeric checks and the ordering checks must survive
    // whatever shape the reporting logic ends up taking.
    expect(PRESENCE_SOURCE).toMatch(/function selfBounds \(\)/);
    expect(PRESENCE_SOURCE).toMatch(/isNum\(b\.minX\)/);
    expect(PRESENCE_SOURCE).toMatch(/isNum\(b\.maxX\)/);
    expect(PRESENCE_SOURCE).toMatch(/isNum\(b\.minZ\)/);
    expect(PRESENCE_SOURCE).toMatch(/isNum\(b\.maxZ\)/);
    expect(PRESENCE_SOURCE).toMatch(/b\.maxX <= b\.minX/);
    expect(PRESENCE_SOURCE).toMatch(/b\.maxZ <= b\.minZ/);
  });

  it('a page with no window.DC at all sends no bounds and does not throw', () => {
    const h = loadStack({ sessionId: 's' });     // no DC
    h.open();
    h.authOk();
    expect(() => walk(h, 6)).not.toThrow();
    expect(boundsFrames(h).length).toBe(0);
    h.expectClean();
  });
});

// ================================================================
// 5. the move payload keeps its documented shape
// ================================================================
describe('BOT-BOUNDS — move payload shape', () => {
  it('a plain move is exactly {x, z, yaw} — no facing, no clientId', () => {
    const h = authedBeforeRoomBuilds();
    h.clock.t += 500;
    h.win.DC_PRESENCE_MOVE(11, 22, 0.75);
    h.flushRaf();
    const move = h.opsSent('dc.presence.move')[0];
    expect(Object.keys(move.data).sort()).toEqual(['x', 'yaw', 'z']);
    expect(move.data).toEqual({ x: 11, z: 22, yaw: 0.75 });
    expect(move.data.facing).toBeUndefined();
    expect(move.data.clientId).toBeUndefined();
  });

  it('a bounds-carrying move is {x, z, yaw, bounds} and nothing more', () => {
    const h = authedBeforeRoomBuilds();
    h.win.DC.roomBounds = Object.assign({}, ROOM);
    walk(h, 4);
    const frame = boundsFrames(h)[0];
    expect(Object.keys(frame.data).sort()).toEqual(['bounds', 'x', 'yaw', 'z']);
    expect(frame.data.clientId).toBeUndefined();
    expect(frame.data.facing).toBeUndefined();
  });

  it('a bounds-carrying join is {x, z, yaw, bounds} and nothing more', () => {
    const h = loadStack({ scene: true, sessionId: 's' });
    h.open();
    h.authOk();
    h.flushRaf();
    const join = h.opsSent('dc.presence.join')[0];
    expect(Object.keys(join.data).sort()).toEqual(['bounds', 'x', 'yaw', 'z']);
  });

  it('bounds never rides on dc.presence.leave', () => {
    const h = loadStack({ scene: true, sessionId: 's' });
    h.open();
    h.authOk();
    h.win.DC_PRESENCE_LEAVE();
    h.flushRaf();
    const leave = h.opsSent('dc.presence.leave')[0];
    expect(leave).toBeTruthy();
    expect(leave.data).toEqual({});
  });
});
