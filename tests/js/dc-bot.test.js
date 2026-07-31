/**
 * tests/js/dc-bot.test.js — OWNER REQUIREMENT #3
 *
 *   "A server-driven bot avatar should appear near you."
 *
 * The bot is not a client-side feature. The hub spawns it and broadcasts it as an
 * ORDINARY presence entry whose client id carries a `bot_<location>` prefix
 * (e.g. `bot_secaucus`) instead of the usual 20-char hex connection id. The whole
 * point of these tests is that dc-presence.js must NOT know or care: the bot has
 * to render, move, be counted and leave exactly like a human peer, and must not
 * be special-cased away or filtered out.
 *
 * Two things make this worth testing rather than assuming:
 *   - `bot_secaucus` is NOT hex and NOT 20 characters, so anything that
 *     validated the id shape would silently drop it. idKey() only has to
 *     String()-normalise it.
 *   - the bot is the only presence entry the local user is guaranteed to see, so
 *     if it is dropped the multi-user feature looks broken even when the hub is
 *     perfectly healthy.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { loadStack, IDS, PRESENCE_SOURCE, WS_SOURCE } from './helpers/dc-stack.js';

const BOT = IDS.bot;        // 'bot_secaucus'
const BOT2 = IDS.bot2;      // 'bot_nyc'

/** Authenticated at (100,200) with the room built, ready for the hub's bot. */
function connected(auth) {
  const h = loadStack({ scene: true, sessionId: 'php-sess-abc' });
  h.open();
  h.authOk(auth);
  return h;
}

// ================================================================
// the bot is not special-cased anywhere in the client
// ================================================================
describe('bot avatar — the client contains no bot special-casing', () => {
  it('neither dc-ws.js nor dc-presence.js mentions bots at all', () => {
    // If a `bot_` branch ever appears the bot has stopped being an ordinary peer,
    // and every test below is testing a different code path than production uses.
    expect(PRESENCE_SOURCE).not.toMatch(/\bbot_/);
    expect(WS_SOURCE).not.toMatch(/\bbot_/);
    expect(PRESENCE_SOURCE).not.toMatch(/isBot|BOT_WALK|botPrefix/);
  });

  it('there is no client id shape validation that could reject a bot_ id', () => {
    // idKey() is the only normaliser, and it only rejects null/undefined/''.
    expect(PRESENCE_SOURCE).toMatch(/function idKey \(v\)/);
    expect(PRESENCE_SOURCE).not.toMatch(/\/\^\[0-9a-f\]\{20\}\$\//);
  });

  it('a bot_ prefixed id survives idKey() normalisation as a usable map key', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    // It really became a tracked remote, keyed by the raw id.
    expect(h.count()).toBe(2);
    expect(h.avatarGroups().length).toBe(1);
  });
});

// ================================================================
// it renders like any other remote avatar
// ================================================================
describe('bot avatar — renders exactly like a human peer', () => {
  it('a dc.presence.joined with a bot_ clientId builds an avatar in the scene', () => {
    const h = connected();
    expect(h.avatarGroups().length).toBe(0);   // guard: the scene starts empty
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 104, z: 197, yaw: 1.2 });

    const groups = h.avatarGroups();
    expect(groups.length).toBe(1);
    const bot = groups[0];
    expect(bot.parent).toBe(h.win.DC.scene);
    expect(bot.position.x).toBe(104);
    expect(bot.position.z).toBe(197);
    expect(bot.rotation.y).toBe(1.2);
    h.expectClean();
  });

  it('the bot avatar has the same body + head + nameplate structure as a human', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 1, z: 1, yaw: 0 });
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice', x: 2, z: 2, yaw: 0 });

    const [bot, human] = h.avatarGroups();
    const shape = (g) => ({
      meshes: g.children.filter((c) => c.isMesh).length,
      sprites: g.children.filter((c) => c.isSprite).length,
    });
    expect(shape(bot)).toEqual(shape(human));
    expect(shape(bot)).toEqual({ meshes: 2, sprites: 1 });
    h.expectClean();
  });

  it('the bot gets a visible nameplate, above its head', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 1, z: 1, yaw: 0 });
    const plate = h.nameplates()[0];
    expect(plate).toBeTruthy();
    expect(plate.isSprite).toBe(true);
    expect(plate.material.map).toBeTruthy();     // the rendered name texture

    // Relative to the avatar, not a hard-coded height: this used to pin 0.62, which
    // silently froze the whole avatar at ~1/31 life size (see below).
    const [bot] = h.avatarGroups();
    const headTop = Math.max(...bot.children.filter((c) => c.isMesh).map((m) => m.position.y));
    expect(plate.position.y).toBeGreaterThan(headTop);

    // The canvas is 256x48, so the sprite must stay at 16:3 or the text distorts.
    expect(plate.scale.x / plate.scale.y).toBeCloseTo(256 / 48, 6);
    h.expectClean();
  });

  /**
   * REGRESSION: the bot was invisible in the real scene despite being present,
   * correctly positioned and counted in the badge — the avatar was hard-coded to a
   * 0.28-unit body plus a 0.10-radius head, ~0.48 units, and this scene's unit is
   * UNITS_PER_INCH = 15/70 (~0.12 m). That is 5.7 cm tall: a speck on the floor,
   * about 1/31 life size. Assert human scale so it cannot silently shrink again.
   */
  it('the bot avatar is life-sized, not a speck on the floor', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 1, z: 1, yaw: 0 });
    const [bot] = h.avatarGroups();

    const UNITS_PER_INCH = 15 / 70;          // dc.js's scene scale
    const meshes = bot.children.filter((c) => c.isMesh);
    const crown = Math.max(...meshes.map((m) => m.position.y));
    const heightInches = crown / UNITS_PER_INCH;

    // Head centre is one radius below the crown, so the figure is a little taller than
    // `crown`; allow a generous human range rather than pinning an exact constant.
    expect(heightInches).toBeGreaterThan(48);  // taller than 4ft
    expect(heightInches).toBeLessThan(84);     // shorter than 7ft
    expect(bot.position.y).toBe(0);            // stands ON the floor
    h.expectClean();
  });

  it('the bot is counted in the #dcPresenceCount badge', () => {
    const h = connected();
    expect(h.count()).toBe(1);                   // just us
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    expect(h.count()).toBe(2);                   // us + the bot
    expect(h.dotActive()).toBe(true);
    h.expectClean();
  });

  it('renders with no uid at all (the hub need not fake one for a bot)', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: undefined, name: 'NOC Bot', x: 5, z: 6, yaw: 0 });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.count()).toBe(2);
    expect(h.nameplates()[0]).toBeTruthy();
    h.expectClean();
  });

  it('renders with a null uid', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: null, name: 'NOC Bot', x: 5, z: 6, yaw: 0 });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.count()).toBe(2);
    h.expectClean();
  });

  it('renders with no name (falls back to "?" like any nameless peer)', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: undefined, x: 1, z: 1, yaw: 0 });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.nameplates()[0]).toBeTruthy();      // '?' still gets a plate
    h.expectClean();
  });

  it('two bots from two locations both render', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'Secaucus Bot', x: 1, z: 1, yaw: 0 });
    h.presenceJoined({ clientId: BOT2, uid: 901, name: 'NYC Bot', x: 9, z: 9, yaw: 0 });
    expect(h.avatarGroups().length).toBe(2);
    expect(h.count()).toBe(3);
    expect(h.nameplates().filter(Boolean).length).toBe(2);
    h.expectClean();
  });

  it('a duplicate bot join does not create a second bot', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.count()).toBe(2);
    h.expectClean();
  });
});

// ================================================================
// it appears NEAR you
// ================================================================
describe('bot avatar — appears near the local player', () => {
  it('spawns at the hub-supplied coordinates with no clamping or re-centring', () => {
    // Our own pose, as dc-multi would report it.
    const h = loadStack({ scene: true });
    h.win.DCM = { getPosition: () => ({ x: 100, z: 200 }), getFacing: () => 0 };
    h.open();
    h.authOk();

    // The hub spawns its bot a few units away from us.
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 103.5, z: 196.25, yaw: -0.4 });
    const bot = h.avatarGroups()[0];
    expect(bot.position.x).toBeCloseTo(103.5, 10);
    expect(bot.position.z).toBeCloseTo(196.25, 10);
    // ...and that really is "near you".
    const d = Math.hypot(bot.position.x - 100, bot.position.z - 200);
    expect(d).toBeLessThan(10);
    h.expectClean();
  });

  it('renders at negative and non-integer coordinates untouched', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: -47.125, z: -3.5, yaw: -Math.PI / 3 });
    const bot = h.avatarGroups()[0];
    expect(bot.position.x).toBe(-47.125);
    expect(bot.position.z).toBe(-3.5);
    expect(bot.rotation.y).toBeCloseTo(-Math.PI / 3, 12);
    h.expectClean();
  });

  it('a bot spawned exactly at the origin is still rendered (0 is not "missing")', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 0, z: 0, yaw: 0 });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.count()).toBe(2);
    h.expectClean();
  });
});

// ================================================================
// it walks like any other remote
// ================================================================
describe('bot avatar — moves and interpolates like a human peer', () => {
  it('dc.presence.batch_updated keyed by the bot_ id moves it', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 0, z: 0, yaw: 0 });
    // data is a MAP KEYED BY CLIENT ID; the client reads the MAP KEY.
    h.presenceBatch({ [BOT]: { uid: 900, name: 'NOC Bot', x: 12, z: 16, yaw: 0.8, ts: 1700000002 } });

    const bot = h.avatarGroups()[0];
    for (let i = 0; i < 200; i++) h.frame(1 / 60, 16);
    expect(bot.position.x).toBeCloseTo(12, 1);
    expect(bot.position.z).toBeCloseTo(16, 1);
    h.expectClean();
  });

  it('dc.presence.updated with a bot_ clientId moves it', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 0, z: 0, yaw: 0 });
    h.event('dc.presence.updated', { clientId: BOT, uid: 900, x: 8, z: -4, yaw: 0 });

    const bot = h.avatarGroups()[0];
    for (let i = 0; i < 200; i++) h.frame(1 / 60, 16);
    expect(bot.position.x).toBeCloseTo(8, 1);
    expect(bot.position.z).toBeCloseTo(-4, 1);
    h.expectClean();
  });

  it('uses the same frame-rate-independent blend a human peer gets', () => {
    const LERP_SPEED = 12;
    const dt = 1 / 60;

    const bot = connected();
    bot.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 0, z: 0, yaw: 0 });
    bot.event('dc.presence.updated', { clientId: BOT, x: 10, z: 0, yaw: 0 });
    bot.frame(dt);

    const human = connected();
    human.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice', x: 0, z: 0, yaw: 0 });
    human.event('dc.presence.updated', { clientId: IDS.remote, x: 10, z: 0, yaw: 0 });
    human.frame(dt);

    const expected = 10 * (1 - Math.exp(-LERP_SPEED * dt));
    expect(bot.avatarGroups()[0].position.x).toBeCloseTo(expected, 10);
    expect(bot.avatarGroups()[0].position.x).toBeCloseTo(human.avatarGroups()[0].position.x, 12);
    // Emphatically a blend, not a snap.
    expect(bot.avatarGroups()[0].position.x).toBeLessThan(3);
  });

  it('the bot and a human peer move independently in the same batch', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 0, z: 0, yaw: 0 });
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice', x: 0, z: 0, yaw: 0 });
    h.presenceBatch({
      [BOT]: { x: 20, z: 0, yaw: 0 },
      [IDS.remote]: { x: -20, z: 0, yaw: 0 },
    });
    for (let i = 0; i < 200; i++) h.frame(1 / 60, 16);
    const [botG, humanG] = h.avatarGroups();
    expect(botG.position.x).toBeCloseTo(20, 1);
    expect(humanG.position.x).toBeCloseTo(-20, 1);
    h.expectClean();
  });

  it('dc.presence.left removes the bot and decrements the count', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    expect(h.count()).toBe(2);
    h.presenceLeft({ clientId: BOT, uid: 900 });
    expect(h.count()).toBe(1);
    expect(h.avatarGroups().length).toBe(0);
    h.expectClean();
  });

  it('a disconnect nukes the bot along with everyone else', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice' });
    expect(h.count()).toBe(3);
    h.close(1006);
    expect(h.count()).toBe(0);
    expect(h.avatarGroups().length).toBe(0);
    h.expectClean();
  });

  it('the bot comes back after a reconnect without duplicating', () => {
    const h = connected();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    h.close(1006);
    h.runTimers(1);
    h.open();
    h.authOk();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.count()).toBe(2);
    h.expectClean();
  });
});

// ================================================================
// delivery-path characterisation
// ================================================================
describe('bot avatar — delivery paths', () => {
  /**
   * CHARACTERISATION — documents current behaviour, reported to the owner.
   *
   * onV1Event()'s batch_updated branch only UPDATES entries that already exist
   * (dc-presence.js:959 "unknown clientId, ignore"). A hub that spawns its bot
   * and then only ever streams it inside dc.presence.batch_updated — without a
   * preceding dc.presence.joined — produces no avatar at all, silently. This is
   * one of the ways "the bot never showed up" can happen with a healthy hub.
   */
  it('CURRENT BEHAVIOUR: a bot seen only in batch_updated never renders', () => {
    const h = connected();
    h.presenceBatch({ [BOT]: { uid: 900, name: 'NOC Bot', x: 104, z: 197, yaw: 0, ts: 1 } });
    expect(h.avatarGroups().length).toBe(0);
    expect(h.count()).toBe(1);

    // A joined broadcast is what actually admits it.
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 104, z: 197, yaw: 0 });
    expect(h.avatarGroups().length).toBe(1);
    h.expectClean();
  });

  /**
   * CHARACTERISATION — onJoined() returns early while state.uid is still unset
   * (dc-presence.js:429). A bot broadcast that overtakes our own auth reply is
   * dropped and never retried client-side.
   */
  it('CURRENT BEHAVIOUR: a bot joined arriving before our auth reply is dropped', () => {
    const h = loadStack({ scene: true });
    h.open();
    h.event('dc.presence.joined', { clientId: BOT, uid: 900, name: 'NOC Bot', x: 1, z: 1, yaw: 0 });
    expect(h.avatarGroups().length).toBe(0);

    h.authOk();
    expect(h.avatarGroups().length).toBe(0);   // not replayed
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot' });
    expect(h.avatarGroups().length).toBe(1);   // only a re-broadcast admits it
    h.expectClean();
  });

  /**
   * CHARACTERISATION — the highest-value "why didn't the bot appear" path.
   *
   * onJoined() returns early when sceneReady() is false (dc-presence.js:441). dc.js
   * only exposes DC.scene once init() runs, and buildRoom() lands seconds later
   * after the ~1.5 MB /ajax/datacenter.php fetch — so a bot (or peer) whose join
   * broadcast arrives in that window is DROPPED. There is no client-side re-request:
   * onUpdated() and batch_updated both ignore unknown client ids, so that peer stays
   * invisible for the rest of the page load unless the hub re-broadcasts `joined`.
   */
  it('CURRENT BEHAVIOUR: a bot joined before DC.scene exists is invisible forever', () => {
    const h = loadStack({});          // no window.DC yet
    h.open();
    h.authOk();
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 104, z: 197, yaw: 0 });
    expect(h.count()).toBe(1);        // dropped; only us

    h.installScene();
    // Neither streaming path recovers it — both ignore unknown client ids.
    h.event('dc.presence.updated', { clientId: BOT, uid: 900, x: 105, z: 198, yaw: 0 });
    h.presenceBatch({ [BOT]: { uid: 900, name: 'NOC Bot', x: 106, z: 199, yaw: 0 } });
    expect(h.avatarGroups().length).toBe(0);
    expect(h.count()).toBe(1);

    // Only a fresh joined broadcast from the hub admits it.
    h.presenceJoined({ clientId: BOT, uid: 900, name: 'NOC Bot', x: 2, z: 3, yaw: 0 });
    expect(h.avatarGroups().length).toBe(1);
    expect(h.count()).toBe(2);
    h.expectClean();
  });

  it('CURRENT BEHAVIOUR: the same drop applies to human peers, not just bots', () => {
    const h = loadStack({});
    h.open();
    h.authOk();
    h.presenceJoined({ clientId: IDS.remote, uid: 7, name: 'Alice', x: 1, z: 1, yaw: 0 });
    h.installScene();
    h.presenceBatch({ [IDS.remote]: { uid: 7, name: 'Alice', x: 5, z: 5, yaw: 0 } });
    expect(h.avatarGroups().length).toBe(0);
    expect(h.count()).toBe(1);
    h.expectClean();
  });
});
