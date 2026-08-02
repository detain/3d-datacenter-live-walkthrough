/**
 * Unit tests for DataCenter 3D pointer lock with unadjustedMovement
 *
 * Tests Bug F-39: Request pointer lock with { unadjustedMovement: true }
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

// =============================================================================
// Bug F-39: pointer lock with unadjustedMovement
// =============================================================================
describe('dc.js — pointer lock with unadjustedMovement (Bug F-39)', () => {
  it('uses renderer.domElement.requestPointerLock({ unadjustedMovement: true })', () => {
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../../public_html/js/dc.js'),
      'utf8'
    );

    // The new call site must use requestPointerLock with the unadjustedMovement option.
    expect(SRC).toMatch(/renderer\.domElement\.requestPointerLock\(\{\s*unadjustedMovement:\s*true\s*\}/);
  });

  it('has a try/catch fallback to controls.lock() on rejection', () => {
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../../public_html/js/dc.js'),
      'utf8'
    );

    // After the requestPointerLock try/catch, there must be a fallback that calls controls.lock().
    // This guards against browsers that reject { unadjustedMovement: true }.
    const requestPointerLockPattern = /requestPointerLock\(\{\s*unadjustedMovement:\s*true\s*\}/;
    const requestPointerLockIdx = SRC.search(requestPointerLockPattern);
    expect(requestPointerLockIdx).toBeGreaterThan(-1);

    // Find the try block that contains requestPointerLock, then look for the catch fallback.
    const afterRequestPointerLock = SRC.slice(requestPointerLockIdx);
    const catchFallbackPattern = /catch[^}]*controls\.lock/;
    expect(afterRequestPointerLock).toMatch(catchFallbackPattern);
  });

  it('canvas (renderer.domElement) is accessible at the pointer lock call site', () => {
    const SRC = fs.readFileSync(
      path.resolve(__dirname, '../../public_html/js/dc.js'),
      'utf8'
    );

    // Verify renderer.domElement is used in the requestPointerLock call.
    // This confirms the canvas variable is accessible at that point in the code.
    expect(SRC).toMatch(/renderer\.domElement\.requestPointerLock\(\{\s*unadjustedMovement:\s*true\s*\}/);
  });
});
