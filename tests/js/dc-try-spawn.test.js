/**
 * Unit tests for dc-multi.js trySpawn door asset caching (Bug F-15)
 *
 * Verifies that trySpawn() does NOT dispose the shared cached door materials
 * (_cachedGlassMaterial, _cachedLogoTexture) when cleaning up the door group —
 * those assets are reused across all doors and must not be destroyed.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const MULTI_SRC = path.resolve(__dirname, '../../public_html/js/dc-multi.js');
const MULTI_SOURCE = fs.readFileSync(MULTI_SRC, 'utf8');

describe('dc-multi.js — trySpawn door cache (Bug F-15)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('door disposal logic — source analysis', () => {
    it('trySpawn skips disposal of _cachedGlassMaterial when tearing down door group', () => {
      // This is a static analysis test: we verify the source code contains the guard
      // that protects _cachedGlassMaterial from disposal in trySpawn's door cleanup.
      const trySpawnMatch = MULTI_SOURCE.match(/function trySpawn[\s\S]*?^}/m);
      expect(trySpawnMatch).toBeTruthy();

      const trySpawnBody = trySpawnMatch[0];
      // The fix adds a guard: if (m !== _cachedGlassMaterial) m.dispose();
      expect(trySpawnBody).toContain('_cachedGlassMaterial');
      // And protects logo texture too: if (m.map && m.map !== _cachedLogoTexture) m.map.dispose();
      expect(trySpawnBody).toContain('_cachedLogoTexture');
      // Confirm the guard pattern: dispose is conditional on not being the cached material
      expect(trySpawnBody).toMatch(/!==\s*_cachedGlassMaterial/);
    });

    it('makeGlassMaterial is a module-level singleton that returns _cachedGlassMaterial', () => {
      // Verify the caching pattern exists in the source
      const glassMatch = MULTI_SOURCE.match(/function makeGlassMaterial\(\)[\s\S]*?^}/m);
      expect(glassMatch).toBeTruthy();
      expect(glassMatch[0]).toContain('_cachedGlassMaterial');
      expect(glassMatch[0]).toMatch(/if\s*\(\s*_cachedGlassMaterial\s*\)/);
      expect(glassMatch[0]).toMatch(/_cachedGlassMaterial\s*=\s*mat/);
    });

    it('makeLogoTexture is a module-level singleton that returns _cachedLogoTexture', () => {
      const logoMatch = MULTI_SOURCE.match(/function makeLogoTexture\(\)[\s\S]*?^}/m);
      expect(logoMatch).toBeTruthy();
      expect(logoMatch[0]).toContain('_cachedLogoTexture');
      expect(logoMatch[0]).toMatch(/if\s*\(\s*_cachedLogoTexture\s*\)/);
      expect(logoMatch[0]).toMatch(/_cachedLogoTexture\s*=\s*t/);
    });

    it('buildDoor reuses the cached glass material and logo texture', () => {
      // buildDoor calls makeGlassMaterial() and makeLogoTexture() to get cached assets
      const buildDoorMatch = MULTI_SOURCE.match(/function buildDoor\(\)[\s\S]*?^}/m);
      expect(buildDoorMatch).toBeTruthy();
      expect(buildDoorMatch[0]).toContain('makeGlassMaterial()');
      expect(buildDoorMatch[0]).toContain('makeLogoTexture()');
    });

    it('S.door = null clears the door reference after disposal (Fix 8)', () => {
      // The comment "Fix 8" documents the original fix; the pattern S.door = null
      // after the traverse/dispose block should still be present.
      const trySpawnMatch = MULTI_SOURCE.match(/function trySpawn[\s\S]*?^}/m);
      expect(trySpawnMatch).toBeTruthy();
      expect(trySpawnMatch[0]).toContain('S.door = null');
    });

    it('dispose guards are applied only to door mesh materials in trySpawn', () => {
      // Verify that the door group traversal (S.door.group.traverse) is what contains
      // the _cachedGlassMaterial guards — not some global blanket dispose.
      const trySpawnMatch = MULTI_SOURCE.match(/function trySpawn[\s\S]*?^}/m);
      expect(trySpawnMatch).toBeTruthy();
      const trySpawnBody = trySpawnMatch[0];

      // The guards must be inside the S.door.group.traverse callback
      const traverseIdx = trySpawnBody.indexOf('S.door.group.traverse');
      const postTraverse = trySpawnBody.slice(traverseIdx);
      // Guards should come after the traverse call, before the scene.remove
      expect(postTraverse).toContain('_cachedGlassMaterial');
      expect(postTraverse).toContain('_cachedLogoTexture');
    });
  });
});
