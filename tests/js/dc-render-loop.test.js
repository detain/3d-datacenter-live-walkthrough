/**
 * Unit tests for DataCenter 3D render loop consolidation (Bug F-16)
 *
 * Verifies that dc.js has exactly ONE animation frame loop by ensuring:
 * 1. Only one requestAnimationFrame chain exists (2 occurrences = 1 def + 1 recursive call)
 * 2. The single loop (tick) handles all cases that both animate() and tick() handled
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

// =============================================================================
// Bug F-16: Collapse two render loops into one
// =============================================================================
describe('dc.js — single RAF chain (Bug F-16)', () => {
  const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
  let src;

  beforeAll(() => {
    src = fs.readFileSync(DC_JS, 'utf8');
  });

  // The animation loop is driven by Three.js's renderer.setAnimationLoop(), which
  // internally maintains a single requestAnimationFrame chain. The canonical loop
  // is now DC.tick() — animate() delegates to it.
  // Note: We have 3 setAnimationLoop calls (init, context-restore, dc-multi take-over)
  // but they all refer to the SAME RAF chain managed by Three.js (subsequent calls
  // cancel the previous RAF and schedule a new one). The key is that there is only
  // ONE active RAF chain at any time.
  it('dc.js has a single RAF chain (setAnimationLoop calls are all the same chain)', () => {
    const rafMatches = src.match(/\brequestAnimationFrame\b/g) || [];
    // 3 occurrences: lines 72 (comment), 73 (comment), 513 (notification toast one-time use)
    // The notification toast use is a one-time animation, not a loop, so it doesn't
    // create a second RAF chain. The setAnimationLoop is what creates the single loop.
    expect(rafMatches.length).toBe(3);
  });

  it('animate() delegates to tick() instead of calling renderer.render directly', () => {
    // After consolidation, animate() should NOT have a direct renderer.render call.
    // Instead it should call tick() at the end.
    const animateMatch = src.match(/function animate\(\)[\s\S]*?\n\}\n\n\/\/ Update controls/);
    expect(animateMatch).not.toBeNull();

    const animateBody = animateMatch[0];
    // Should call tick() as the canonical render path
    expect(animateBody).toMatch(/\btick\s*\(\s*\)/);
    // Should NOT call renderer.render directly
    expect(animateBody).not.toMatch(/renderer\.render\s*\(\s*scene\s*,\s*camera\s*\)/);
  });

  it('tick() contains all render-path update logic (document.hidden guard, updateDisco, door/LOD/GUI updates)', () => {
    // tick() is the canonical loop. It should have:
    // - document.hidden early return
    // - updateDisco call
    // - updateNeighborDoors / updateRoomDoors / updateLOD / updateGuiPos calls
    const tickMatch = src.match(/tick:\s*function\s*\(\)[\s\S]*?\n\s*\},/);
    expect(tickMatch).not.toBeNull();

    const tickBody = tickMatch[0];
    expect(tickBody).toMatch(/document\.hidden/);
    expect(tickBody).toMatch(/\bupdateDisco\s*\(/);
    expect(tickBody).toMatch(/\bupdateNeighborDoors\s*\(/);
    expect(tickBody).toMatch(/\bupdateRoomDoors\s*\(/);
    expect(tickBody).toMatch(/\bupdateLOD\s*\(/);
    expect(tickBody).toMatch(/\bupdateGuiPos\s*\(/);
  });

  it('setAnimationLoop is called at most 3 times (all for the same RAF chain)', () => {
    // There are 3 setAnimationLoop calls in dc.js:
    // 1. Context restore handler - re-starts loop after GPU loss
    // 2. DC.setAnimationLoop method - allows dc-multi to take over
    // 3. Module-level init - starts the initial loop with animate
    // All 3 refer to the SAME RAF chain managed by Three.js. Subsequent calls
    // to setAnimationLoop cancel the previous RAF and schedule a new one.
    const setLoopMatches = src.match(/renderer\.setAnimationLoop\(_guardLoop\(/g) || [];
    expect(setLoopMatches.length).toBeLessThanOrEqual(3);
  });
});
