/**
 * Unit tests for DataCenter 3D critical fixes
 *
 * Tests the following fixes:
 * 6. dc-presence.js - Multi-tab presence: LRU cache dedup + per-clientId tracking
 *
 * ANTI-PATTERN: Never re-implement the logic under test inside this file. Such a
 * test asserts a local copy against itself and can never fail. Every test must
 * exercise the REAL source file by importing it, by slicing a declaration out
 * of the source text (see tests/js/dc-model-guards.test.js), or by reading the
 * compiled source at runtime and asserting on its actual text.
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
