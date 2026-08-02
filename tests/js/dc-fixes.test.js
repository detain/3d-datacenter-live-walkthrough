/**
 * Unit tests for DataCenter 3D critical fixes
 *
 * Tests the following fixes:
 * 1. dc-multi.js - whenReady() timeout: callback not called after timeout, error logged
 * 2. dc-multi.js - Cleanup removes all listeners including wheel {passive:false}
 * 3. dc-ws.js - Exponential backoff capped at 45000 (30000 * 1.5 max jitter)
 * 4. dc-ws.js - v1 error reply sets authed = false on envelope.ok === false
 * 5. dc-ws.js - keepalive only fires when authenticated
 * 6. dc-presence.js - LRU cache dedup: duplicate names don't create duplicate entries
 * 7. dc.js - Null collider guard: null entries in colliders array don't cause errors
 *
 * RULE: every test in this file must exercise the REAL source file, either by
 * importing it, by slicing a declaration out of the source text and recompiling it
 * (see tests/js/dc-model-guards.test.js), or by running it in a vm sandbox (see
 * tests/js/dc-ws.test.js). Never re-implement the logic under test inside this file —
 * such a test asserts a local copy against itself and can never fail.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

// A few tests assert against the real source text to guard contracts that must
// not silently drift back.
const fs = require('node:fs');
const path = require('node:path');

// =============================================================================
// NEW FIX: dc-ws.js multi-tab presence support
// =============================================================================
describe('dc-ws.js — multi-tab presence (DC_CLIENT_ID)', () => {
  // REPLACED (was: 'DC_PRESENCE_MOVE includes clientId in the sent message').
  // The old test built an envelope inline and asserted what it had just built, so it
  // verified nothing about the code — and it enshrined two things that are now
  // deliberately wrong: a `facing:` key (the hub reads `yaw:`, so `facing` was silently
  // dropped and yaw always arrived as 0.0) and a client-supplied `clientId`, which the
  // hub intval()'d into garbage AND never ownership-checked, letting any client move
  // another client's avatar. dc-ws.js's DC_PRESENCE_MOVE is gone; dc-presence.js owns
  // it and sends {x, z, yaw} only. This now guards the correct shape so nobody
  // "fixes" the code back toward the old assertion and reopens the hole.
  it('a presence move payload uses yaw and carries no client-supplied clientId', () => {
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../../public_html/js/dc-presence.js'),
      'utf8'
    );

    // The single dc.presence.move send site in dc-presence.js.
    const moveSend = SRC.match(/send\(\s*['"]dc\.presence\.move['"]\s*,\s*\{[^}]*\}/);
    expect(moveSend).not.toBeNull();

    expect(moveSend[0]).toMatch(/\byaw\b/);
    expect(moveSend[0]).not.toMatch(/\bfacing\b/);
    expect(moveSend[0]).not.toMatch(/\bclientId\b/);

    // And dc-ws.js must not have resurrected its duplicate senders.
    const WS_SRC = fs.readFileSync(
      path.resolve(__dirname, '../../public_html/js/dc-ws.js'),
      'utf8'
    );
    expect(WS_SRC).not.toMatch(/window\.DC_PRESENCE_MOVE\s*=/);
    expect(WS_SRC).not.toMatch(/window\.DC_PRESENCE_JOIN\s*=/);
    expect(WS_SRC).not.toMatch(/window\.DC_PRESENCE_LEAVE\s*=/);
  });
});
