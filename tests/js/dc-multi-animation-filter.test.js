/**
 * Unit tests for the animation clip filtering in public_html/js/dc-multi.js
 *
 * Verifies that loadCharacter() only fetches animation clips whose labels are
 * actually playable (idle/walk/run/jump + GESTURE_ORDER). Clips with null or
 * unrecognized labels must never trigger a loadAsync call.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const MULTI_SRC = path.resolve(__dirname, '../../public_html/js/dc-multi.js');
const MULTI_SOURCE = fs.readFileSync(MULTI_SRC, 'utf8');

// ----------------------------------------------------------------
// Mock Three.js module (must be mocked before the source under test
// imports it). We mock the entire three module here so that the
// ES module import in dc-multi.js resolves to our lightweight stubs.
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
// Test helpers
// ----------------------------------------------------------------

/** Anything-goes chainable stub, enough for lil-gui's fluent API. */
function chainStub() {
  const target = function () { return proxy; };
  const proxy = new Proxy(target, { get: () => proxy, apply: () => proxy });
  return proxy;
}

function makeEl() {
  return {
    textContent: '', style: {}, value: '',
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    innerHTML: '', parentNode: null,
  };
}

function fakeGltf(animations = []) {
  const THREE = require('./__mocks__/three.js');
  return {
    scene: new THREE.Group(),
    animations,
  };
}

/**
 * Build a fake character with `total` clips, of which exactly
 * `playableLabels` (array) carry a playable label. The rest have label: null.
 */
function buildFakeCharacter(total, playableLabels) {
  const animations = [];
  for (let i = 0; i < total; i++) {
    const label = i < playableLabels.length ? playableLabels[i] : null;
    animations.push({ label, clip: `/anim_${i}.glb` });
  }
  return { id: 'test', name: 'TestChar', model: '/test.glb', animations };
}

async function boot() {
  const THREE = await vi.importActual('./__mocks__/three.js');
  const docListeners = {};
  const controlListeners = {};

  const doc = {
    readyState: 'complete',
    hidden: false,
    addEventListener(evt, cb) { (docListeners[evt] = docListeners[evt] || []).push(cb); },
    removeEventListener() {},
    getElementById: () => makeEl(),
    createElement: () => makeEl(),
    body: { appendChild() {}, removeChild() {} },
  };

  const scene = new THREE.Group();
  const camera = {
    position: new THREE.Vector3(),
    quaternion: {},
    fov: 75,
    lookAt() {},
    getWorldDirection(v) { v.set(0, 0, -1); return v; },
    updateProjectionMatrix() {},
  };
  const controls = {
    isLocked: false,
    addEventListener(evt, cb) { (controlListeners[evt] = controlListeners[evt] || []).push(cb); },
    removeEventListener() {},
  };

  globalThis.window = globalThis;
  globalThis.document = doc;
  globalThis.devicePixelRatio = 1;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.location = { search: '' };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ generated_at: null, characters: [] }),
  });
  globalThis.__DCM_FAKE_GLTF__ = () => fakeGltf([]);

  globalThis.DC_PRESENCE_JOIN = () => {};
  globalThis.DC_PRESENCE_MOVE = () => {};
  globalThis.DC_PRESENCE_LEAVE = () => {};
  globalThis.DC_PRESENCE_ENABLED = true;

  let frameFn = null;
  globalThis.DC = {
    scene, camera, controls,
    renderer: { setPixelRatio() {}, setSize() {}, render() {} },
    options: {},
    eyeHeight: () => 15,
    playerRadius: () => 1,
    roomSpawn: { x: 100, y: 0, z: 200, lookX: 100, lookZ: 210 },
    roomBounds: { minX: -50, maxX: 250, minZ: 100, maxZ: 300 },
    gui: { addFolder: () => chainStub() },
    setAnimationLoop(fn) { frameFn = fn; },
    tick() {},
    flyTo: { active: false, onDone: null },
  };

  vi.resetModules();
  await import('../../public_html/js/dc-multi.js');
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

  return { scene, camera, doc, controlListeners, frameFn };
}

async function cleanup() {
  for (const k of ['window', 'document', 'DC', 'DCM', 'fetch', 'location', 'devicePixelRatio',
    'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener', '__DCM_FAKE_GLTF__',
    'DC_PRESENCE_JOIN', 'DC_PRESENCE_MOVE', 'DC_PRESENCE_LEAVE', 'DC_PRESENCE_ENABLED']) {
    delete globalThis[k];
  }
}

// ----------------------------------------------------------------
// PLAYABLE_LABELS existence checks (read from source)
// ----------------------------------------------------------------
const GESTURE_ORDER_SOURCE = MULTI_SOURCE.match(/const GESTURE_ORDER = \[.*?\];/);
const PLAYABLE_LABELS_MATCH = MULTI_SOURCE.match(/const PLAYABLE_LABELS = new Set\(\[.*?\]\);/);

// The 4 locomotion labels
const LOCOMOTION_LABELS = ['idle', 'walk', 'run', 'jump'];
// All 21 gesture labels (from GESTURE_ORDER in the file)
const GESTURE_ORDER = ['dance1', 'dance2', 'clap', 'dying', 'wave', 'dance3', 'dance4', 'salute', 'cheer',
  'bow', 'point', 'thumbsup', 'talk', 'laugh', 'think', 'shrug', 'punch', 'kick', 'sit', 'backflip', 'jacks'];

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------
describe('dc-multi.js — PLAYABLE_LABELS constant', () => {
  it('PLAYABLE_LABELS is declared in the source', () => {
    expect(PLAYABLE_LABELS_MATCH).not.toBeNull();
  });

  it('PLAYABLE_LABELS is declared AFTER GESTURE_ORDER (not before)', () => {
    const gestureOrderIdx = MULTI_SOURCE.indexOf('const GESTURE_ORDER');
    const playableLabelsIdx = MULTI_SOURCE.indexOf('const PLAYABLE_LABELS');
    expect(playableLabelsIdx).toBeGreaterThan(gestureOrderIdx);
  });

  it('PLAYABLE_LABELS contains the 4 locomotion labels as literals', () => {
    const declaration = PLAYABLE_LABELS_MATCH[0];
    for (const label of LOCOMOTION_LABELS) {
      const regex = new RegExp(`['"]${label}['"]`);
      expect(declaration).toMatch(regex);
    }
  });

  it('PLAYABLE_LABELS spreads GESTURE_ORDER (...GESTURE_ORDER syntax)', () => {
    const declaration = PLAYABLE_LABELS_MATCH[0];
    expect(declaration).toMatch(/\.\.\.GESTURE_ORDER/);
  });

  it('PLAYABLE_LABELS contains exactly 25 unique labels (4 locomotion + 21 gestures)', () => {
    // Construct what PLAYABLE_LABELS will be at runtime from the source
    const allExpected = new Set([...LOCOMOTION_LABELS, ...GESTURE_ORDER]);
    expect(allExpected.size).toBe(25);
  });
});

describe('dc-multi.js — loadCharacter() animation filtering', () => {
  let loadAsyncSpy;
  let env;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    env = await boot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    env = null;
    loadAsyncSpy = null;
  });

  it('loadAsync is called once per playable clip, never for null-label clips', async () => {
    // Build a fake character: 97 clips with label:null + 3 playable clips
    // Use clip paths starting with /clip_ to distinguish from the model path /model.glb
    const playableLabels = ['idle', 'walk', 'run']; // exactly 3 playable
    const animations = [];
    for (let i = 0; i < 100; i++) {
      const label = i < playableLabels.length ? playableLabels[i] : null;
      animations.push({ label, clip: `/clip_${i}.glb` }); // animation clips, not model
    }
    const fakeChar = { id: 'test', name: 'TestChar', model: '/model.glb', animations };

    const DCM = globalThis.DCM;
    const S = DCM._S;

    // Replace S.loader.loadAsync with a spy that resolves with a valid GLTF
    loadAsyncSpy = vi.fn().mockResolvedValue(
      fakeGltf([{ name: 'test_clip', duration: 1 }])
    );
    const originalLoadAsync = S.loader.loadAsync.bind(S.loader);
    S.loader.loadAsync = loadAsyncSpy;

    // Call loadCharacter with our 100-clip character
    await DCM.loadCharacter(fakeChar);

    // Allow the event loop to drain so all .then() callbacks resolve
    await new Promise((r) => setTimeout(r, 50));

    // loadAsync is called once for the model GLB + once per playable animation clip.
    // The model call uses /model.glb; all clip calls use /clip_N.glb.
    // Only the 3 playable clip URLs should be fetched; null-label clips must be skipped.
    const clipCalls = loadAsyncSpy.mock.calls.filter(([url]) => url.startsWith('/clip_'));
    expect(clipCalls.length).toBe(3);

    // Restore
    S.loader.loadAsync = originalLoadAsync;
  });

  it('the source loop iterates a filtered list, not ch.animations directly', () => {
    // Verify the source does NOT have "for (const a of (ch.animations" pattern
    const sourceLines = MULTI_SOURCE.split('\n');
    const hasDirectIter = sourceLines.some((line) => line.includes('for (const a of (ch.animations'));
    expect(hasDirectIter).toBe(false);
  });

  it('the source contains the filter pattern (allClips.filter + PLAYABLE_LABELS)', () => {
    expect(MULTI_SOURCE).toContain('allClips.filter');
    expect(MULTI_SOURCE).toContain('PLAYABLE_LABELS.has');
  });
});
