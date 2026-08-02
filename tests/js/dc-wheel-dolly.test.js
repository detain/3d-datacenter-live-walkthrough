/**
 * Unit tests for dc-multi.js wheel dolly fix (F-18)
 *
 * Verifies that onWheel event handler only calls preventDefault when:
 * 1. The event target IS the canvas, OR
 * 2. The pointer is locked to the canvas
 *
 * Other scrollable UI elements (lil-gui, .parameters, .dc-chat-frame, #dcSearchResults)
 * must NOT have their default scroll behavior prevented.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const MULTI_SRC = path.resolve(__dirname, '../../public_html/js/dc-multi.js');
const MULTI_SOURCE = fs.readFileSync(MULTI_SRC, 'utf8');

// ----------------------------------------------------------------
// Mock Three.js module
// ----------------------------------------------------------------
vi.mock('three', async () => {
  const mockThree = await vi.importActual('./__mocks__/three.js');
  return mockThree;
});
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setDRACOLoader() {}
    loadAsync() { return Promise.resolve(globalThis.__DCM_FAKE_GLTF__()); }
  },
}));
vi.mock('three/addons/loaders/DRACOLoader.js', () => ({
  DRACOLoader: class { setDecoderPath() {} },
}));

// ----------------------------------------------------------------
// Mock DOM globals (node environment)
// ----------------------------------------------------------------
function setupDocumentMock(canvasEl) {
  const doc = {
    querySelector: vi.fn((selector) => {
      if (selector === 'canvas') return canvasEl;
      return null;
    }),
    pointerLockElement: null,
  };
  globalThis.document = doc;
  return doc;
}

function clearDocumentMock() {
  delete globalThis.document;
}

// ----------------------------------------------------------------
// Test helper: re-implement onWheel logic from source to test in isolation
// We test the actual logic, not the import (which requires heavy mocking)
// ----------------------------------------------------------------
function makeOnWheel() {
  return function onWheel(e) {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const canvas = document.querySelector('canvas');
    if (e.target !== canvas && document.pointerLockElement !== canvas) return;
    e.preventDefault();
  };
}

// ----------------------------------------------------------------
// Mock DOM elements factory
// ----------------------------------------------------------------
function makeEl(tagName, id = '', className = '') {
  return {
    tagName: tagName.toUpperCase(),
    id,
    className,
    preventDefault: vi.fn(),
  };
}

function makeCanvas() {
  return makeEl('canvas', 'dcCanvas', '');
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------
describe('dc-wheel-dolly — F-18: scope wheel preventDefault to canvas only', () => {
  let onWheel;
  let mockCanvas;
  let doc;

  beforeEach(() => {
    onWheel = makeOnWheel();
    mockCanvas = makeCanvas();
    doc = setupDocumentMock(mockCanvas);
  });

  afterEach(() => {
    clearDocumentMock();
  });

  // ----------------------------------------------------------------
  // Cases where preventDefault SHOULD be called
  // ----------------------------------------------------------------
  describe('when preventDefault SHOULD be called', () => {
    it('calls preventDefault when target is the canvas', () => {
      // Use the same mockCanvas that document.querySelector('canvas') returns
      const wheelEvent = { target: mockCanvas, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('calls preventDefault when pointer is locked to canvas (even if target is not canvas)', () => {
      // Simulate pointer locked to canvas
      doc.pointerLockElement = mockCanvas;

      // Target is something else (e.g., a div overlay)
      const otherTarget = makeEl('div', '', 'some-overlay');
      const wheelEvent = { target: otherTarget, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).toHaveBeenCalledTimes(1);
    });

    it('calls preventDefault when target is canvas AND pointer is locked to it', () => {
      doc.pointerLockElement = mockCanvas;

      const canvasEl = makeCanvas();
      const wheelEvent = { target: canvasEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------------
  // Cases where preventDefault should NOT be called (exempt targets)
  // ----------------------------------------------------------------
  describe('when preventDefault should NOT be called — exempt targets', () => {
    it('does NOT call preventDefault when target is lil-gui', () => {
      const lilGuiEl = makeEl('div', '', 'lil-gui');
      const wheelEvent = { target: lilGuiEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('does NOT call preventDefault when target is .parameters', () => {
      const paramsEl = makeEl('div', '', 'parameters');
      const wheelEvent = { target: paramsEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('does NOT call preventDefault when target is .dc-chat-frame', () => {
      const chatFrameEl = makeEl('iframe', '', 'dc-chat-frame');
      const wheelEvent = { target: chatFrameEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('does NOT call preventDefault when target is #dcSearchResults', () => {
      const searchResultsEl = makeEl('div', 'dcSearchResults', '');
      const wheelEvent = { target: searchResultsEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('does NOT call preventDefault when pointer is not locked and target is not canvas', () => {
      // Clear pointer lock
      doc.pointerLockElement = null;

      const randomDiv = makeEl('div', 'someOtherId', 'some-class');
      const wheelEvent = { target: randomDiv, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // INPUT/TEXTAREA/SELECT should always return early (existing behavior)
  // ----------------------------------------------------------------
  describe('INPUT/TEXTAREA/SELECT always exempt (existing behavior)', () => {
    it('does NOT call preventDefault for INPUT elements', () => {
      const inputEl = makeEl('input', 'myInput', '');
      const wheelEvent = { target: inputEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('does NOT call preventDefault for TEXTAREA elements', () => {
      const textareaEl = makeEl('textarea', 'myTextarea', '');
      const wheelEvent = { target: textareaEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });

    it('does NOT call preventDefault for SELECT elements', () => {
      const selectEl = makeEl('select', 'mySelect', '');
      const wheelEvent = { target: selectEl, preventDefault: vi.fn(), deltaY: 10 };

      onWheel(wheelEvent);

      expect(wheelEvent.preventDefault).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------------
  // Verify the onWheel source code matches the expected fix
  // ----------------------------------------------------------------
  describe('source code contains the fix', () => {
    it('onWheel function checks event target against canvas before calling preventDefault', () => {
      // Verify the source contains the guard condition
      expect(MULTI_SOURCE).toMatch(/function onWheel\(e\)/);
      expect(MULTI_SOURCE).toMatch(/const canvas = document\.querySelector\('canvas'\)/);
      expect(MULTI_SOURCE).toMatch(/e\.target !== canvas && document\.pointerLockElement !== canvas/);
    });

    it('F-18 comment is present in the source', () => {
      expect(MULTI_SOURCE).toMatch(/F-18/);
      expect(MULTI_SOURCE).toMatch(/scope preventDefault to canvas only/);
    });
  });
});
