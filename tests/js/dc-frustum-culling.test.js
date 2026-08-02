/**
 * Unit tests for Step 7.2 — Restore frustum culling
 *
 * Verifies that:
 * - Neighbour building instanced meshes have frustumCulled = true
 * - Current building instanced meshes have frustumCulled = false
 * - Player character has frustumCulled = true
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../public_html/js/dc.js'),
  'utf8'
);

const MULTI_SRC = fs.readFileSync(
  path.resolve(__dirname, '../../public_html/js/dc-multi.js'),
  'utf8'
);

// ----------------------------------------------------------------
// Step 7.2: Frustum culling restored for neighbours and player
// ----------------------------------------------------------------
describe('Step 7.2 — Restore frustum culling', () => {

  describe('dc.js — buildInstanced() sets frustumCulled based on sink parameter', () => {
    it('neighbour buildings get frustumCulled = true (sink is present)', () => {
      // The buildInstanced function sets frustumCulled = !!sink so it evaluates to true
      // for neighbours (where sink is passed) and false for current building.
      expect(DC_SRC).toMatch(/inst\.frustumCulled\s*=\s*!!\s*sink/);
    });

    it('current building calls to buildInstanced do NOT pass sink (frustumCulled = false)', () => {
      // For the current building, buildInstanced is called without the 4th argument.
      // These calls should be just 3 arguments (model, placements, kind) — no sink.
      const currentBuildingCalls = DC_SRC.match(
        /buildInstanced\(models\.racks\[\w+\],\s*placements,\s*'rack'\)/g
      );
      const currentBuildingServerCalls = DC_SRC.match(
        /buildInstanced\(models\.servers\[\w+\],\s*placements,\s*'server'\)/g
      );
      expect(currentBuildingCalls).not.toBeNull();
      expect(currentBuildingServerCalls).not.toBeNull();
    });

    it('neighbour building calls to buildInstanced DO pass sink (frustumCulled = true)', () => {
      // buildBuildingFull passes sink to buildInstanced for neighbour buildings.
      // Verify those calls include sink as the 4th argument.
      expect(DC_SRC).toMatch(/buildInstanced\(model,\s*placements,\s*'rack',\s*sink\)/);
      expect(DC_SRC).toMatch(/buildInstanced\(model,\s*placements,\s*'server',\s*sink\)/);
    });
  });

  describe('dc-multi.js — player character has frustumCulled = true', () => {
    it('character model traverse sets frustumCulled = true on meshes', () => {
      // After loading the character model, traverse sets frustumCulled = true
      // (Step 7.2: re-enable frustum culling for player character).
      const loadCharSection = MULTI_SRC.match(
        /const root\s*=\s*gltf\.scene;[\s\S]+?(?=S\.player\.add)/m
      );
      expect(loadCharSection).not.toBeNull();
      expect(loadCharSection[0]).toMatch(/o\.frustumCulled\s*=\s*true/);
    });
  });

  describe('dc.js — sun/core glow objects keep frustumCulled = false (decorative, always visible)', () => {
    it('sunCore and sunGlow keep frustumCulled = false', () => {
      // The sun objects are decorative and should remain frustumCulled = false
      // to ensure they're always rendered regardless of camera position.
      const sunCoreLine = DC_SRC.match(/sunCore[^;]*frustumCulled\s*=\s*false/);
      const sunGlowLine = DC_SRC.match(/sunGlow[^;]*frustumCulled\s*=\s*false/);
      expect(sunCoreLine).not.toBeNull();
      expect(sunGlowLine).not.toBeNull();
    });
  });

  describe('dc.js — cable network objects keep frustumCulled = false (current building)', () => {
    it('cable network meshes keep frustumCulled = false for current building', () => {
      // Cable geometry has a room-spanning bounding sphere, making frustum culling
      // ineffective. These should remain disabled for the current building.
      const cableFrustumCulledFalse = DC_SRC.match(/objects\.network\.frustumCulled\s*=\s*false/);
      const cablesFrustumCulledFalse = DC_SRC.match(/cables\.frustumCulled\s*=\s*false/g);
      expect(cableFrustumCulledFalse).not.toBeNull();
      expect(cablesFrustumCulledFalse).not.toBeNull();
    });
  });
});
