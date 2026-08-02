/**
 * Unit tests for cable geometry constants (Step 8.3 — reduce cable triangle bill)
 *
 * Verifies:
 * 1. CABLE_RADIAL = 5 (tube cross-section segments, down from 8)
 * 2. maxTubular = 24/96 (LOD cap, down from 40/220)
 * 3. tubular divisor = len/4 (up from len/2.2, producing longer segments = fewer triangles)
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

describe('cable geometry constants — Step 8.3', () => {

  describe('CABLE_RADIAL', () => {
    it('is set to 5 (reduced from 8 to lower triangle count)', () => {
      const match = SRC.match(/^const CABLE_RADIAL\s*=\s*(\d+);/m);
      expect(match).not.toBeNull();
      expect(parseInt(match[1], 10)).toBe(5);
    });
  });

  describe('maxTubular LOD cap', () => {
    it('is 24 when far from cables (reduced from 40)', () => {
      const match = SRC.match(/const maxTubular\s*=\s*farFromCables\s*\?\s*(\d+)\s*:\s*\d+/);
      expect(match).not.toBeNull();
      expect(parseInt(match[1], 10)).toBe(24);
    });

    it('is 96 when close to cables (reduced from 220)', () => {
      const match = SRC.match(/const maxTubular\s*=\s*farFromCables\s*\?\s*\d+\s*:\s*(\d+)/);
      expect(match).not.toBeNull();
      expect(parseInt(match[1], 10)).toBe(96);
    });
  });

  describe('tubular segment divisor', () => {
    it('uses len/4 for longer tubular segments (reduced triangle count)', () => {
      // The tubular calculation should use /4 instead of /2.2
      const tubularCalcPattern = /Math\.min\(maxTubular,\s*Math\.max\(10,\s*Math\.round\(len\s*\/\s*4\)\)\)/;
      expect(SRC).toMatch(tubularCalcPattern);
    });

    it('does NOT use the old len/2.2 divisor', () => {
      const oldPattern = /len\s*\/\s*2\.2/;
      expect(SRC).not.toMatch(oldPattern);
    });
  });

});
