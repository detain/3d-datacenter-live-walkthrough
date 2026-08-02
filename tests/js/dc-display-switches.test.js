/**
 * Unit tests for displaySwitches() cable geometry cache key (Bug F-09)
 *
 * Verifies:
 * 1. cacheKey includes maxTubular (so different LOD settings have separate cache entries)
 * 2. Cache read is NOT guarded by !farFromCables (cache key differentiates, not a conditional)
 * 3. Both cache-write sites use the same cacheKey
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../public_html/js/dc.js'),
  'utf8'
);

// Extract the displaySwitches function source
const displaySwitchesMatch = SRC.match(/function displaySwitches\(locId, dx, dz, sink\)\s*\{[\s\S]*?\n^}/m);
expect(displaySwitchesMatch).not.toBeNull();
const funcSrc = displaySwitchesMatch[0];

describe('displaySwitches() cable geometry cache — Bug F-09 fix', () => {

  describe('cacheKey includes maxTubular', () => {
    it('cacheKey definition appends maxTubular to the key string', () => {
      // The cacheKey must include maxTubular so that far/close LOD settings don't share entries
      // Expected pattern: const cacheKey = (sink ? locId + ':n' : locId) + ':' + maxTubular;
      expect(funcSrc).toMatch(/const cacheKey\s*=\s*\(sink\s*\?\s*locId\s*\+\s*':n'\s*:\s*locId\)\s*\+\s*':'?\s*\+\s*maxTubular/);
    });

    it('maxTubular is declared before cacheKey so it can be referenced', () => {
      const lines = funcSrc.split('\n');
      const maxTubularLineIdx = lines.findIndex(l => /const maxTubular\s*=/.test(l));
      const cacheKeyLineIdx = lines.findIndex(l => /const cacheKey\s*=/.test(l));
      expect(maxTubularLineIdx).toBeGreaterThanOrEqual(0);
      expect(cacheKeyLineIdx).toBeGreaterThanOrEqual(0);
      expect(maxTubularLineIdx).toBeLessThan(cacheKeyLineIdx);
    });
  });

  describe('cache read is not guarded by !farFromCables', () => {
    it('cache read condition does NOT include !farFromCables guard', () => {
      // The bug had: if (!farFromCables && _cableGeometryCache.has(cacheKey))
      // After fix: the cache key itself differentiates via maxTubular, so no guard needed
      // Must NOT have !farFromCables before _cableGeometryCache.has(cacheKey)
      const guardPattern = /!\s*farFromCables\s*&&\s*_cableGeometryCache\.has\(cacheKey\)/;
      expect(funcSrc).not.toMatch(guardPattern);
    });

    it('cache read simply checks _cableGeometryCache.has(cacheKey)', () => {
      // The corrected pattern should be: if (_cableGeometryCache.has(cacheKey))
      const simpleCheckPattern = /if\s*\(\s*_cableGeometryCache\.has\(cacheKey\)\s*\)/;
      expect(funcSrc).toMatch(simpleCheckPattern);
    });
  });

  describe('both cache-write sites use the same cacheKey', () => {
    it('async path (RIC) writes with _locId which equals cacheKey', () => {
      // In the async path: _locId = cacheKey; ... _cableGeometryCache.set(_locId, ...)
      // Verify _locId is assigned from cacheKey before the set() call
      const ricSection = funcSrc.match(/const _locId\s*=\s*cacheKey[\s\S]*?_cableGeometryCache\.set\(_locId/);
      expect(ricSection).not.toBeNull();
    });

    it('sync path writes directly with cacheKey', () => {
      // In the sync path: _cableGeometryCache.set(cacheKey, ...)
      const syncSetPattern = /_cableGeometryCache\.set\(cacheKey,\s*\{/;
      expect(funcSrc).toMatch(syncSetPattern);
    });

    it('both write sites use semantically identical keys', () => {
      // Count cache write sites: should be exactly 2
      const writeSites = funcSrc.match(/_cableGeometryCache\.set\(/g);
      expect(writeSites).toHaveLength(2);

      // One uses _locId (which is set to cacheKey), one uses cacheKey directly
      // Both represent the same logical key
      const withLocId = funcSrc.match(/_cableGeometryCache\.set\(_locId,/);
      const withCacheKey = funcSrc.match(/_cableGeometryCache\.set\(cacheKey,/);
      expect(withLocId).not.toBeNull();
      expect(withCacheKey).not.toBeNull();
    });
  });
});
