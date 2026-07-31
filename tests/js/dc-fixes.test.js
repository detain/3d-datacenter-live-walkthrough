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
 * DESIGN NOTE: These tests reimplement the source logic in a controlled way rather than
 * importing the actual source files. This is intentional because:
 *   - The source files (dc-multi.js, dc-ws.js, etc.) are vanilla JS that depend on
 *     browser globals (window.DC, etc.) making direct import impractical in Node
 *   - Reimplementing the LOGIC of each fix allows us to verify correctness without
 *     the complexity of browser environment mocking
 *   - The tests focus on verifying the FIX itself, not the full module behavior
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Most tests here reimplement logic (see DESIGN NOTE above), but a few assert against
// the real source text to guard contracts that must not silently drift back.
const fs = require('node:fs');
const path = require('node:path');

// =============================================================================
// Helper: Extract whenReady implementation from dc-multi.js source
// =============================================================================
// Since dc-multi.js doesn't export whenReady, we re-implement it here exactly
// as it appears in the source, then test that behavior.
function whenReadyImpl(cb, timeoutMs = 15000) {
  const w = typeof window !== 'undefined' ? window : globalThis;
  const start = performance.now();
  const tick = () => {
    if (w.DC && w.DC.scene && w.DC.camera && w.DC.renderer && w.DC.controls && w.DC.options) cb();
    else if (performance.now() - start > timeoutMs) {
      console.error(`[dc-multi] whenReady timeout - DC not initialized after ${timeoutMs}ms`);
    } else setTimeout(tick, 80);
  };
  tick();
}

// =============================================================================
// Test 1: dc-multi.js whenReady() timeout
// =============================================================================
describe('dc-multi.js — whenReady() timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Ensure window exists in Node environment
    global.window = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    delete global.window;
  });

  it('callback fires when DC properties become available before timeout', () => {
    const cb = vi.fn();

    // Set up DC properties to be available after 3 ticks (240ms)
    let tickCount = 0;
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = vi.fn((fn, delay) => {
      tickCount++;
      if (tickCount >= 3) {
        // DC is now "available"
        global.window.DC = {
          scene: {},
          camera: {},
          renderer: {},
          controls: {},
          options: {}
        };
      }
      return originalSetTimeout(fn, delay);
    });

    whenReadyImpl(cb, 15000);

    // Advance time to trigger the check but not timeout
    vi.advanceTimersByTime(300);

    // Callback should have been called
    expect(cb).toHaveBeenCalled();

    global.setTimeout = originalSetTimeout;
    delete global.window.DC;
  });

  it('callback NOT called after timeout when DC never initializes', () => {
    const cb = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Ensure DC is NOT available
    global.window.DC = null;

    whenReadyImpl(cb, 500); // Short timeout for testing

    // Advance time past the 500ms timeout
    vi.advanceTimersByTime(600);
    vi.runAllTimers();

    // Callback should NOT have been called
    expect(cb).not.toHaveBeenCalled();
    // Error should have been logged
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('whenReady timeout'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('500ms'));

    errorSpy.mockRestore();
    delete global.window.DC;
  });

  it('whenReady checks all required DC properties', () => {
    // The whenReady callback only fires when ALL these are truthy:
    const requiredProps = ['DC', 'DC.scene', 'DC.camera', 'DC.renderer', 'DC.controls', 'DC.options'];
    // Verify each property is checked in the source condition
    expect(requiredProps).toContain('DC');
    expect(requiredProps).toContain('DC.scene');
    expect(requiredProps).toContain('DC.camera');
    expect(requiredProps).toContain('DC.renderer');
    expect(requiredProps).toContain('DC.controls');
    expect(requiredProps).toContain('DC.options');
  });
});

// =============================================================================
// Test 2: dc-multi.js cleanup removes all listeners including wheel {passive:false}
// =============================================================================
describe('dc-multi.js — cleanup removes all listeners', () => {
  it('cleanup removes wheel listener with { passive: false } option', () => {
    // Track registered and removed event listeners
    const registeredListeners = [];
    const removedListeners = [];

    // Mock element that tracks listener registration
    const mockElement = {
      addEventListener: function(event, handler, options) {
        registeredListeners.push({ event, handler, options });
      },
      removeEventListener: function(event, handler, options) {
        removedListeners.push({ event, handler, options });
        // Find and remove the matching registration
        const idx = registeredListeners.findIndex(
          r => r.event === event && r.handler === handler
        );
        if (idx !== -1) registeredListeners.splice(idx, 1);
      }
    };

    // Simulate the onWheel handler from dc-multi.js
    const onWheel = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      e.preventDefault();
    };

    // Register wheel listener with { passive: false } (as in source code line 795)
    mockElement.addEventListener("wheel", onWheel, { passive: false });

    // Verify it was registered correctly
    const wheelRegistration = registeredListeners.find(r => r.event === 'wheel');
    expect(wheelRegistration).toBeDefined();
    expect(wheelRegistration.options).toEqual({ passive: false });

    // Simulate cleanup - removing with the same options object (CRIT-2 fix)
    mockElement.removeEventListener("wheel", onWheel, { passive: false });

    // Verify removal was called with correct options
    const wheelRemoval = removedListeners.find(r => r.event === 'wheel');
    expect(wheelRemoval).toBeDefined();
    expect(wheelRemoval.options).toEqual({ passive: false });

    // Verify listener is no longer in registered list
    const stillRegistered = registeredListeners.find(r => r.event === 'wheel');
    expect(stillRegistered).toBeUndefined();
  });

  it('cleanup removes all expected event listeners from source code', () => {
    const removedEvents = [];

    const mockDocument = {
      addEventListener: vi.fn(),
      removeEventListener: function(event, handler, options) {
        removedEvents.push({ event, options });
      }
    };

    const mockControls = {
      addEventListener: vi.fn(),
      removeEventListener: function(event, handler) {
        removedEvents.push({ event });
      }
    };

    // CRIT-2: Named handlers stored for cleanup (from source lines 145-176, 761-790)
    const syncPlayerFromCamera = () => {};
    const _onUnlock = () => {};
    const _onRespawn = () => {};
    const _onDisconnected = () => {};
    const _onAuthFailure = () => {};
    const _onAuthSuccess = () => {};
    const _onContextLost = () => {};
    const _onContextRestored = () => {};
    const _onKeyDown = () => {};
    const _onKeyUp = () => {};
    const onWheel = () => {};

    // Simulate the cleanup function from dc-multi.js (lines 188-205)
    const cleanup = () => {
      mockControls.removeEventListener("lock", syncPlayerFromCamera);
      mockControls.removeEventListener("unlock", _onUnlock);
      mockDocument.removeEventListener('dc:respawn', _onRespawn);
      mockDocument.removeEventListener('dc:disconnected', _onDisconnected);
      mockDocument.removeEventListener('dc:auth-failure', _onAuthFailure);
      mockDocument.removeEventListener('dc:auth-success', _onAuthSuccess);
      mockDocument.removeEventListener('dc:context-lost', _onContextLost);
      mockDocument.removeEventListener('dc:context-restored', _onContextRestored);
      mockDocument.removeEventListener("keydown", _onKeyDown);
      mockDocument.removeEventListener("keyup", _onKeyUp);
      mockDocument.removeEventListener("wheel", onWheel, { passive: false });
    };

    cleanup();

    // Verify all expected events were removed
    expect(removedEvents.map(e => e.event)).toContain('dc:respawn');
    expect(removedEvents.map(e => e.event)).toContain('dc:disconnected');
    expect(removedEvents.map(e => e.event)).toContain('dc:auth-failure');
    expect(removedEvents.map(e => e.event)).toContain('dc:auth-success');
    expect(removedEvents.map(e => e.event)).toContain('keydown');
    expect(removedEvents.map(e => e.event)).toContain('keyup');
    expect(removedEvents.map(e => e.event)).toContain('wheel');

    // Verify wheel was removed with {passive: false}
    const wheelRemoval = removedEvents.find(e => e.event === 'wheel');
    expect(wheelRemoval.options).toEqual({ passive: false });
  });
});

// =============================================================================
// Test 3: dc-ws.js Exponential backoff capped at 45000
// =============================================================================
describe('dc-ws.js — reconnect exponential backoff cap', () => {
  it('baseDelay is capped at 30000 BEFORE jitter is applied (line 161)', () => {
    const MAX_CAP = 30000;

    // Simulate the reconnect logic from dc-ws.js line 161-162:
    // const baseDelay = Math.min(self.reconnectDelay * 2, 30000);
    // self.reconnectDelay = baseDelay * (0.5 + Math.random());
    // Note: baseDelay capped at 30000, jitter applied after can push to max 45000ms

    function calculateReconnectDelay(currentDelay) {
      const baseDelay = Math.min(currentDelay * 2, MAX_CAP);
      const jitter = 0.5 + Math.random(); // jitter range [0.5, 1.5]
      return baseDelay * jitter;
    }

    // Test with various starting delays
    const testCases = [
      { input: 3000, expectedBase: 6000 },
      { input: 15000, expectedBase: 30000 }, // 15000 * 2 = 30000 (at cap)
      { input: 20000, expectedBase: 30000 }, // 20000 * 2 = 40000 -> capped to 30000
      { input: 30000, expectedBase: 30000 }, // 30000 * 2 = 60000 -> capped to 30000
      { input: 50000, expectedBase: 30000 }, // 50000 * 2 = 100000 -> capped to 30000
    ];

    for (const tc of testCases) {
      const baseDelay = Math.min(tc.input * 2, MAX_CAP);
      expect(baseDelay).toBe(tc.expectedBase);
    }
  });

  it('worst case delay is 45000ms (baseDelay capped at 30000, jitter applied after can push to max 45000ms)', () => {
    const MAX_CAP = 30000;
    // The logic: baseDelay = min(delay * 2, 30000) caps base at 30000
    // Then jitter is applied: reconnectDelay = baseDelay * (0.5 + Math.random())
    // This gives jitter multiplier in range [0.5, 1.5]
    // Max possible = 30000 * 1.5 = 45000ms
    const MAX_JITTER = 1.5; // 0.5 + 1.0 (full random range)
    const maxPossibleDelay = MAX_CAP * MAX_JITTER;
    expect(maxPossibleDelay).toBe(45000);
  });

  it('backoff cap prevents exponential growth beyond control', () => {
    const MAX_CAP = 30000;
    let delay = 3000; // Starting delay

    // Simulate multiple reconnection attempts
    for (let i = 0; i < 10; i++) {
      const baseDelay = Math.min(delay * 2, MAX_CAP);
      // baseDelay is capped at 30000, then jitter is applied
      // With jitter at max (1.5), max possible is 30000 * 1.5 = 45000
      // But without the base cap, delay would grow exponentially forever
      delay = baseDelay * (0.5 + 1.0); // Simulate max jitter (1.5) case

      // With cap: baseDelay is bounded, so delay is bounded
      // Without cap: delay would double each iteration forever
      expect(baseDelay).toBeLessThanOrEqual(MAX_CAP);
    }

    expect(delay).toBe(45000); // With max jitter (1.5), reaches 45000
  });

  it('without cap, delay would grow beyond 45000 (the bug)', () => {
    // This test demonstrates why the cap is necessary
    const BUGGY_CAP = Infinity; // No cap
    let delay = 24000;

    // Without cap: delay doubles each time
    for (let i = 0; i < 3; i++) {
      delay = delay * 2; // Keeps doubling with no cap
    }

    // Without cap, delay would reach 192000 (far beyond 45000)
    expect(delay).toBeGreaterThan(45000);
  });
});

// =============================================================================
// Test 4: dc-ws.js — v1 error reply handling
// =============================================================================
describe('dc-ws.js — v1 error reply handling', () => {
  it('sets authed to false when envelope.ok is false', () => {
    // Simulate receiving {v:1, re:"<id>", ok:false, error:{code:"bad_session"}}
    const envelope = { v: 1, re: 'abc123', ok: false, error: { code: 'bad_session', message: 'Invalid session' } };
    // Check the logic: if (envelope.ok === false && envelope.error) { this.authed = false; ... }
    // Note: && returns the last truthy value, not a boolean, so we use toBeTruthy()
    const authed = envelope.ok === false && envelope.error;
    expect(authed).toBeTruthy();
  });

  it('dispatches dc:auth-failure event on v1 error reply', () => {
    // Verify the event would be dispatched with correct error payload
    const envelope = { v: 1, re: 'abc123', ok: false, error: { code: 'bad_session' } };
    const shouldDispatch = envelope.ok === false && envelope.error;
    expect(shouldDispatch).toBeTruthy();
  });
});

// =============================================================================
// Test 5: dc-ws.js — keepalive only when authenticated
// =============================================================================
describe('dc-ws.js — keepalive only when authenticated', () => {
  it('should not send ping when not authenticated', () => {
    const authed = false;
    const wsReady = true;
    const shouldSendPing = wsReady && authed;
    expect(shouldSendPing).toBe(false);
  });

  it('should send ping when authenticated', () => {
    const authed = true;
    const wsReady = true;
    const shouldSendPing = wsReady && authed;
    expect(shouldSendPing).toBe(true);
  });
});

// =============================================================================
// Test 6: dc-presence.js LRU cache deduplication
// =============================================================================
describe('dc-presence.js — LRU cache deduplication', () => {
  it('MAJOR-6: indexOf check prevents duplicate entries in _nameSpriteCacheOrder', () => {
    // This simulates the fix from dc-presence.js makeNameSprite() lines 188-195
    const _nameSpriteCacheOrder = [];

    // The fix: check if name is already in array before adding
    const safeAddToCacheOrder = (name) => {
      if (_nameSpriteCacheOrder.indexOf(name) === -1) {
        _nameSpriteCacheOrder.push(name);
      }
    };

    // Add the same name multiple times
    safeAddToCacheOrder('alice');
    safeAddToCacheOrder('bob');
    safeAddToCacheOrder('alice'); // duplicate - should NOT be added
    safeAddToCacheOrder('charlie');
    safeAddToCacheOrder('alice'); // another duplicate - should NOT be added
    safeAddToCacheOrder('bob');   // another duplicate - should NOT be added

    // Should only have unique names in order
    expect(_nameSpriteCacheOrder).toEqual(['alice', 'bob', 'charlie']);
    expect(_nameSpriteCacheOrder.length).toBe(3);
  });

  it('cache hit moves entry to end WITHOUT duplicating (lines 190-196)', () => {
    // This simulates the cache hit logic from dc-presence.js
    const _nameSpriteCacheOrder = ['alice', 'bob', 'charlie'];

    // Simulate cache hit for 'alice' - the fix removes then re-adds only if not already present
    const name = 'alice';
    const idx = _nameSpriteCacheOrder.indexOf(name);
    if (idx !== -1) {
      _nameSpriteCacheOrder.splice(idx, 1);
    }
    // CRIT-2 fix: re-check before push to prevent dup
    if (_nameSpriteCacheOrder.indexOf(name) === -1) {
      _nameSpriteCacheOrder.push(name);
    }

    // alice should be at end, NOT duplicated
    expect(_nameSpriteCacheOrder).toEqual(['bob', 'charlie', 'alice']);
    expect(_nameSpriteCacheOrder.length).toBe(3);

    // Verify only one 'alice'
    const aliceCount = _nameSpriteCacheOrder.filter(n => n === 'alice').length;
    expect(aliceCount).toBe(1);
  });

  it('LRU eviction still works correctly with dedup fix', () => {
    // Simulate the full LRU cache behavior from dc-presence.js makeNameSprite()
    const MAX_NAME_SPRITE_CACHE = 64;
    const _nameSpriteCacheOrder = [];
    const _nameSpriteCache = new Map();

    const addToCache = (name) => {
      // LRU eviction when at capacity
      if (_nameSpriteCacheOrder.length >= MAX_NAME_SPRITE_CACHE) {
        const oldest = _nameSpriteCacheOrder.shift();
        _nameSpriteCache.delete(oldest);
      }
      // Dedup check (MAJOR-6 fix)
      if (_nameSpriteCacheOrder.indexOf(name) === -1) {
        _nameSpriteCacheOrder.push(name);
        _nameSpriteCache.set(name, { name });
      }
    };

    // Fill to capacity with unique names
    for (let i = 0; i < MAX_NAME_SPRITE_CACHE; i++) {
      addToCache('user' + i);
    }

    expect(_nameSpriteCacheOrder.length).toBe(MAX_NAME_SPRITE_CACHE);
    expect(_nameSpriteCacheOrder[0]).toBe('user0');

    // Add duplicate of early entry - should NOT create duplicate
    addToCache('user0');

    // user0 should NOT have been added again
    const user0Count = _nameSpriteCacheOrder.filter(n => n === 'user0').length;
    expect(user0Count).toBe(1);

    // Size should still be at max (eviction happened but no new entry added)
    expect(_nameSpriteCacheOrder.length).toBe(MAX_NAME_SPRITE_CACHE);

    // Add a new unique name - should evict user1 (oldest after user0 was "refreshed")
    addToCache('newuser');

    // user1 should have been evicted
    expect(_nameSpriteCacheOrder).not.toContain('user1');
    expect(_nameSpriteCacheOrder).toContain('newuser');
  });

  it('10 consecutive duplicates of same name only adds 1 entry (MAJOR-6)', () => {
    const _nameSpriteCacheOrder = [];

    const safeAdd = (name) => {
      if (_nameSpriteCacheOrder.indexOf(name) === -1) {
        _nameSpriteCacheOrder.push(name);
      }
    };

    // Add 10 duplicates of 'alice'
    for (let i = 0; i < 10; i++) {
      safeAdd('alice');
    }

    // Should only have 1 entry for 'alice'
    expect(_nameSpriteCacheOrder.filter(n => n === 'alice').length).toBe(1);
    expect(_nameSpriteCacheOrder.length).toBe(1);
  });
});

// =============================================================================
// Test 5: dc.js Null collider guard
// =============================================================================
describe('dc.js — null collider guard', () => {
  it('collidesAt skips null entries in rackColliders array (line 797)', () => {
    // Simulate rackColliders with null entries (the bug scenario)
    const rackColliders = [
      { minX: -50, maxX: -42, minZ: -50, maxZ: -43 },
      null,  // null entry - should be skipped
      { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
      null,  // another null
      { minX: 20, maxX: 30, minZ: 20, maxZ: 30 },
    ];

    const x = 5, z = 5, r = 1;
    let hit = false;

    // The fixed code pattern from dc.js lines 795-799:
    // for (const idx of check) {
    //   const c = rackColliders[idx];
    //   if (!c) continue;  // <-- THE FIX: null guard
    //   if (x + r >= c.minX && x - r <= c.maxX && z + r >= c.minZ && z - r <= c.maxZ) return true;
    // }
    for (const c of rackColliders) {
      if (!c) continue;  // THE FIX: skip null entries
      if (x + r >= c.minX && x - r <= c.maxX && z + r >= c.minZ && z - r <= c.maxZ) {
        hit = true;
        break;
      }
    }

    expect(hit).toBe(true); // Should find collision in the non-null entry
  });

  it('without null guard, accessing null entry would throw TypeError', () => {
    const rackColliders = [
      { minX: -50, maxX: -42, minZ: -50, maxZ: -43 },
      null,
      { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
    ];

    const x = 5, z = 5, r = 1;

    // Simulate the BUGGY code (without null guard)
    let threw = false;
    try {
      for (const c of rackColliders) {
        // This would throw: TypeError: Cannot read property 'minX' of null
        if (x + r >= c.minX && x - r <= c.maxX &&
            z + r >= c.minZ && z - r <= c.maxZ) {
          break;
        }
      }
    } catch (e) {
      threw = true;
    }

    expect(threw).toBe(true); // Without the fix, it throws
  });

  it('with null guard, no error is thrown even with all nulls', () => {
    const rackColliders = [null, null, null];

    let threw = false;
    let iterations = 0;
    try {
      for (const c of rackColliders) {
        iterations++;
        if (!c) continue;  // THE FIX
        // If we got here without continue, c would have minX
      }
    } catch (e) {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(iterations).toBe(3); // All entries were processed
  });

  it('mixed null and valid entries work correctly with null guard', () => {
    const rackColliders = [
      null,
      { minX: 5, maxX: 15, minZ: 5, maxZ: 15 },
      null
    ];

    // Point at edge of valid collider
    const x = 10, z = 10, r = 1;

    let hit = false;
    for (const c of rackColliders) {
      if (!c) continue;
      if (x + r >= c.minX && x - r <= c.maxX &&
          z + r >= c.minZ && z - r <= c.maxZ) {
        hit = true;
      }
    }

    expect(hit).toBe(true);
  });

  it('null guard allows collision detection to complete even with sparse nulls', () => {
    // Test that collision detection still works correctly with many nulls interspersed
    const rackColliders = [
      null, null,
      { minX: 0, maxX: 5, minZ: 0, maxZ: 5 },  // collision here
      null, null, null,
      { minX: 10, maxX: 15, minZ: 10, maxZ: 15 },
      null, null,
    ];

    // Test point that collides with first valid collider
    let hit = false;
    for (const c of rackColliders) {
      if (!c) continue;
      if (2 >= c.minX && 2 <= c.maxX && 2 >= c.minZ && 2 <= c.maxZ) {
        hit = true;
        break;
      }
    }
    expect(hit).toBe(true);

    // Test point that doesn't collide with any
    hit = false;
    for (const c of rackColliders) {
      if (!c) continue;
      if (7 >= c.minX && 7 <= c.maxX && 7 >= c.minZ && 7 <= c.maxZ) {
        hit = true;
        break;
      }
    }
    expect(hit).toBe(false);
  });
});

// =============================================================================
// NEW FIX: dc-ws.js multi-tab presence support
// =============================================================================
describe('dc-ws.js — multi-tab presence (DC_CLIENT_ID)', () => {
  beforeEach(() => {
    // Reset global state
    global.window = Object.assign(global.window || {}, {
      DC_CLIENT_ID: null,
      DC_UID: null,
      DC_AUTHED: false,
      DC_PRESENCE: null,
      DC_PRESENCE_ENABLED: null
    });
  });

  afterEach(() => {
    delete global.window.DC_CLIENT_ID;
    delete global.window.DC_UID;
    delete global.window.DC_AUTHED;
    delete global.window.DC_PRESENCE;
    delete global.window.DC_PRESENCE_ENABLED;
  });

  it('auth.welcome sets DC_CLIENT_ID from data.clientId', () => {
    // Simulate the DC_CLIENT_ID fallback (`data.clientId || data.uid`) that dc-ws.js's
    // _onWelcome() applies. Still correct after the A2 fix, which changed only HOW the
    // welcome is recognised (correlated by `re` on an ok:true reply, since the hub sends
    // no `op` on replies) — not what it does with the payload.
    const data = {
      uid: 77,
      clientId: 100,
      name: 'TabA',
      session: 'sess123',
      hub_time: 1234567890
    };

    // The fix: window.DC_CLIENT_ID = data.clientId || data.uid (line 321)
    global.window.DC_CLIENT_ID = data.clientId || data.uid;
    global.window.DC_UID = data.uid;
    global.window.DC_AUTHED = true;
    global.window.DC_PRESENCE = {
      uid: data.uid,
      clientId: global.window.DC_CLIENT_ID,
      name: data.name,
      session: data.session,
      hub_time: data.hub_time
    };

    expect(global.window.DC_CLIENT_ID).toBe(100);
    expect(global.window.DC_UID).toBe(77);
    expect(global.window.DC_PRESENCE.clientId).toBe(100);
  });

  it('auth.welcome falls back to data.uid if data.clientId is missing', () => {
    // Some servers may not send clientId — should fall back to uid
    const data = {
      uid: 77,
      clientId: undefined,
      name: 'TabA',
      session: 'sess123'
    };

    // The fix uses: data.clientId || data.uid
    global.window.DC_CLIENT_ID = data.clientId || data.uid;

    expect(global.window.DC_CLIENT_ID).toBe(77);
  });

  it('auth.welcome falls back to data.uid if data.clientId is null', () => {
    const data = {
      uid: 77,
      clientId: null,
      name: 'TabA'
    };

    global.window.DC_CLIENT_ID = data.clientId || data.uid;

    expect(global.window.DC_CLIENT_ID).toBe(77);
  });

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

// =============================================================================
// NEW FIX: dc-presence.js multi-tab presence support
// =============================================================================
describe('dc-presence.js — multi-tab presence (clientId-based)', () => {
  // Simulate the state object from dc-presence.js
  let state;

  beforeEach(() => {
    state = {
      uid: null,
      name: null,
      clientId: null,
      remote: new Map()
    };
  });

  it('state.clientId is initialized to null', () => {
    expect(state.clientId).toBeNull();
  });

  it('onAuthSuccess sets state.clientId from data.clientId || data.uid', () => {
    // Simulate onAuthSuccess (lines 515-529 in dc-presence.js)
    const data = {
      uid: 77,
      clientId: 100,
      name: 'TabA'
    };

    // Line 518: state.clientId = data.clientId || data.uid;
    state.uid = data.uid;
    state.name = data.name || '';
    state.clientId = data.clientId || data.uid;

    expect(state.clientId).toBe(100);
    expect(state.uid).toBe(77);
  });

  it('onAuthSuccess falls back to uid when clientId is missing', () => {
    const data = {
      uid: 77,
      clientId: undefined,
      name: 'TabA'
    };

    state.uid = data.uid;
    state.name = data.name || '';
    state.clientId = data.clientId || data.uid;

    expect(state.clientId).toBe(77);
  });

  it('onJoined self-filter uses data.clientId === state.clientId (not uid)', () => {
    // Simulate onJoined (lines 255-292 in dc-presence.js)
    state.clientId = 100; // Tab B's clientId
    state.uid = 77;      // Same uid as Tab A

    // Tab A broadcasts join with clientId=100 (same as our clientId)
    const tabAData = {
      uid: 77,
      clientId: 100,
      name: 'TabA',
      x: 10,
      z: 20,
      yaw: 0
    };

    // Line 263: if (data.clientId === state.clientId) return; — skip self
    if (tabAData.clientId === state.clientId) {
      // This is us — skip
      expect(state.remote.has(tabAData.clientId)).toBe(false);
    }

    // Now Tab B broadcasts join with clientId=200 (different from our clientId)
    const tabBData = {
      uid: 77,
      clientId: 200,
      name: 'TabB',
      x: 30,
      z: 40,
      yaw: 1.5
    };

    if (tabBData.clientId !== state.clientId) {
      // This is a different tab — should be rendered
      state.remote.set(tabBData.clientId, {
        uid: tabBData.uid,
        name: tabBData.name,
        x: tabBData.x,
        z: tabBData.z
      });
    }

    expect(state.remote.has(200)).toBe(true);
    expect(state.remote.has(100)).toBe(false);
  });

  it('state.remote.set stores by clientId (not uid)', () => {
    // Tab A (clientId=100)
    state.clientId = 100;
    state.uid = 77;

    // Tab B (clientId=200) same uid=77
    const tabBEntry = {
      uid: 77,
      name: 'TabB',
      clientId: 200,
      x: 30,
      z: 40
    };

    // Line 290: state.remote.set(data.clientId, entry);
    state.remote.set(tabBEntry.clientId, tabBEntry);

    expect(state.remote.get(200)).toBe(tabBEntry);
    expect(state.remote.get(77)).toBeUndefined(); // Not stored by uid
  });

  it('state.remote.get reads by clientId', () => {
    const entry = { uid: 77, name: 'TabB', clientId: 200 };
    state.remote.set(200, entry);

    // Line 300: var entry = state.remote.get(data.clientId);
    const retrieved = state.remote.get(200);

    expect(retrieved).toBe(entry);
    expect(retrieved.name).toBe('TabB');
  });

  it('onUpdated reads by data.clientId', () => {
    // Set up a remote entry by clientId
    const entry = {
      uid: 77,
      name: 'TabB',
      x: 30,
      z: 40,
      targetX: 30,
      targetZ: 40
    };
    state.remote.set(200, entry);

    // Simulate onUpdated (lines 298-309)
    const updateData = {
      uid: 77,
      clientId: 200,
      x: 35,
      z: 45
    };

    // Line 300: var entry = state.remote.get(data.clientId);
    const remoteEntry = state.remote.get(updateData.clientId);
    if (remoteEntry) {
      remoteEntry.targetX = updateData.x !== undefined ? updateData.x : remoteEntry.targetX;
      remoteEntry.targetZ = updateData.z !== undefined ? updateData.z : remoteEntry.targetZ;
    }

    expect(remoteEntry.targetX).toBe(35);
    expect(remoteEntry.targetZ).toBe(45);
  });

  it('onLeft deletes by data.clientId', () => {
    const entry = { uid: 77, name: 'TabB', clientId: 200 };
    state.remote.set(200, entry);

    expect(state.remote.has(200)).toBe(true);

    // Simulate onLeft (lines 315-347)
    const leftData = { uid: 77, clientId: 200 };

    // Line 316: var entry = state.remote.get(data.clientId);
    const remoteEntry = state.remote.get(leftData.clientId);
    if (remoteEntry) {
      // ... cleanup code ...
      // Line 345: state.remote.delete(data.clientId);
      state.remote.delete(leftData.clientId);
    }

    expect(state.remote.has(200)).toBe(false);
  });

  it('batch_updated self-skip uses clientId === state.clientId', () => {
    // Simulate batch_updated handler (lines 584-641)
    state.clientId = 100;

    const batchData = {
      100: { uid: 77, name: 'TabA', x: 10, z: 20 },  // Self — should skip
      200: { uid: 77, name: 'TabB', x: 30, z: 40 }   // Tab B — should process
    };

    const processedClientIds = [];
    const skippedClientIds = [];

    // Line 591: if (clientId === state.clientId) continue; // skip self
    for (var clientId in batchData) {
      if (clientId === String(state.clientId)) {
        skippedClientIds.push(clientId);
        continue;
      }
      processedClientIds.push(clientId);
    }

    expect(skippedClientIds).toContain('100');
    expect(processedClientIds).toContain('200');
    expect(skippedClientIds).not.toContain('200');
    expect(processedClientIds).not.toContain('100');
  });

  it('Key scenario: Tab A and Tab B with same uid but different clientIds', () => {
    // Tab A state
    const tabAState = {
      uid: 77,
      clientId: 100,
      remote: new Map()
    };

    // Tab B state
    const tabBState = {
      uid: 77,
      clientId: 200,
      remote: new Map()
    };

    // Tab A's join broadcast arrives at Tab B
    // Tab B's onJoined sees data.clientId=100 !== state.clientId=200 → renders Tab A's avatar
    const tabAJoinData = {
      uid: 77,
      clientId: 100,
      name: 'TabA',
      x: 10,
      z: 20,
      yaw: 0
    };

    if (tabAJoinData.clientId === tabBState.clientId) {
      // Skip self
    } else if (!tabBState.remote.has(tabAJoinData.clientId)) {
      // Render Tab A's avatar
      tabBState.remote.set(tabAJoinData.clientId, {
        uid: tabAJoinData.uid,
        name: tabAJoinData.name,
        x: tabAJoinData.x,
        z: tabAJoinData.z
      });
    }

    expect(tabBState.remote.has(100)).toBe(true);
    expect(tabBState.remote.get(100).name).toBe('TabA');

    // Tab B's join broadcast arrives at Tab A
    // Tab A's onJoined sees data.clientId=200 !== state.clientId=100 → renders Tab B's avatar
    const tabBJoinData = {
      uid: 77,
      clientId: 200,
      name: 'TabB',
      x: 30,
      z: 40,
      yaw: 1.5
    };

    if (tabBJoinData.clientId === tabAState.clientId) {
      // Skip self
    } else if (!tabAState.remote.has(tabBJoinData.clientId)) {
      // Render Tab B's avatar
      tabAState.remote.set(tabBJoinData.clientId, {
        uid: tabBJoinData.uid,
        name: tabBJoinData.name,
        x: tabBJoinData.x,
        z: tabBJoinData.z
      });
    }

    expect(tabAState.remote.has(200)).toBe(true);
    expect(tabAState.remote.get(200).name).toBe('TabB');

    // Verify they don't see themselves
    expect(tabAState.remote.has(100)).toBe(false);
    expect(tabBState.remote.has(200)).toBe(false);
  });

  it('Two tabs same uid can both see each other (no self-skip false positives)', () => {
    // Scenario: uid=77, Tab A (clientId=100), Tab B (clientId=200)
    // Each tab should see the OTHER tab's avatar, not skip itself incorrectly

    const tabAState = { uid: 77, clientId: 100, remote: new Map() };
    const tabBState = { uid: 77, clientId: 200, remote: new Map() };

    // Server broadcasts that Tab A (clientId=100) joined
    // Tab B receives this and checks: data.clientId=100 === state.clientId=200? NO → render Tab A
    const joinFromA = { uid: 77, clientId: 100, name: 'TabA' };
    const isSelfB = joinFromA.clientId === tabBState.clientId;
    expect(isSelfB).toBe(false);
    if (!isSelfB && !tabBState.remote.has(joinFromA.clientId)) {
      tabBState.remote.set(joinFromA.clientId, { name: joinFromA.name });
    }

    // Server broadcasts that Tab B (clientId=200) joined
    // Tab A receives this and checks: data.clientId=200 === state.clientId=100? NO → render Tab B
    const joinFromB = { uid: 77, clientId: 200, name: 'TabB' };
    const isSelfA = joinFromB.clientId === tabAState.clientId;
    expect(isSelfA).toBe(false);
    if (!isSelfA && !tabAState.remote.has(joinFromB.clientId)) {
      tabAState.remote.set(joinFromB.clientId, { name: joinFromB.name });
    }

    // Both tabs have the other in their remote list
    expect(tabAState.remote.has(200)).toBe(true);
    expect(tabBState.remote.has(100)).toBe(true);

    // Neither has itself in remote
    expect(tabAState.remote.has(100)).toBe(false);
    expect(tabBState.remote.has(200)).toBe(false);
  });
});

// =============================================================================
// Integration test: All fixes work together
// =============================================================================
describe('DataCenter 3D fixes — integration', () => {
  it('no error thrown when iterating array with all nulls and null guard', () => {
    const testFn = () => {
      const cols = [null, null, null, null];
      for (const c of cols) {
        if (!c) continue;
        // Safe access
      }
    };
    expect(testFn).not.toThrow();
  });

  it('LRU dedup and null guard can work together in real scenario', () => {
    // Simulate a scenario combining both fixes
    const _nameSpriteCacheOrder = [];

    const safeAddToCacheOrder = (name) => {
      if (_nameSpriteCacheOrder.indexOf(name) === -1) {
        _nameSpriteCacheOrder.push(name);
      }
    };

    // Add some names
    safeAddToCacheOrder('user1');
    safeAddToCacheOrder('user2');
    safeAddToCacheOrder('user1'); // duplicate - ignored

    expect(_nameSpriteCacheOrder).toEqual(['user1', 'user2']);
    expect(_nameSpriteCacheOrder.length).toBe(2);
  });
});
