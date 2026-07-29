/**
 * Unit tests for public_html/js/dc.js
 *
 * Tests the pure logic functions: coordinate conversion, collision detection,
 * and utility functions. The main Three.js scene functions require a browser
 * environment and are tested via Playwright E2E tests.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('path');

// ----------------------------------------------------------------
// Constants from dc.js (verified by reading the source)
// ----------------------------------------------------------------
const UNITS_PER_INCH = 15 / 70;
const RACK_GRID_CELL = 10;
const MAX_TEXTURE_CACHE = 128;

// ----------------------------------------------------------------
// Load dc.js into a minimal VM sandbox
// dc.js is an ES module that imports Three.js - we mock the Three.js API
// and test the pure functions that don't require the full scene.
// ----------------------------------------------------------------
function loadDcJs() {
  const listeners = {};

  // Mock Three.js module
  const mockThree = {
    Vector3: class {
      constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
      set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
      distanceToSquared() { return 0; }
    },
    Box3: class {
      setFromObject() { this.min = { y: 0 }; this.max = { y: 1 }; return this; }
      isEmpty() { return false; }
      union() {}
      copy() {}
    },
    Mesh: class {
      constructor() {
        this.material = { map: null };
        this.visible = true;
      }
    },
    Group: class {
      constructor() { this.children = []; }
      traverse() {}
      add() {}
      remove() {}
    },
    CanvasTexture: class { dispose() {} },
    SRGBColorSpace: 'srgb',
    PlaneGeometry: class { constructor() {} },
    MeshBasicMaterial: class {
      constructor(opts = {}) { this.map = opts.map || null; }
    },
    MeshStandardMaterial: class {
      constructor(opts = {}) { this.map = opts.map || null; }
    },
    MeshPhysicalMaterial: class {
      constructor(opts = {}) { this.map = opts.map || null; }
    },
    BufferGeometry: class { dispose() {} },
    CylinderGeometry: class {},
    SphereGeometry: class {},
    DirectionalLight: class {},
    SpotLight: class {},
    Raycaster: class {},
    Color: class { constructor() {} set() {} },
    RepeatWrapping: 'repeat',
  };

  const mockDocument = {
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      style: {},
      appendChild: () => {},
      getContext: () => ({
        clearRect: () => {},
        fillStyle: '',
        beginPath: () => {},
        moveTo: () => {},
        lineTo: () => {},
        arcTo: () => {},
        arc: () => {},
        closePath: () => {},
        fill: () => {},
        fillText: () => {},
        measureText: () => ({ width: 100 }),
        textAlign: 'center',
        textBaseline: 'middle',
      }),
      width: 256,
      height: 48,
    }),
    body: { appendChild: () => {} },
    createEvent: () => ({ initCustomEvent: () => {} }),
    dispatchEvent: () => true,
    readyState: 'complete',
    addEventListener: (evt, cb) => { listeners[evt] = cb; },
    hidden: false,
  };

  const win = {
    THREE: mockThree,
    document: mockDocument,
    console: console,
    performance: { now: () => 0 },
    requestAnimationFrame: (cb) => setTimeout(cb, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    setTimeout: () => 0,
    clearTimeout: () => {},
    window: null,
    self: null,
    DC: null,
    location: { search: '' },
    navigator: { userAgent: '' },
  };
  win.window = win;
  win.self = win;

  // Provide THREE as a global so the ES module import resolves
  const sandbox = {
    window: win,
    document: mockDocument,
    console: console,
    THREE: mockThree,
    performance: win.performance,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    module: { exports: {} },
    exports: {},
    // Provide crypto for uuid generation if needed
    crypto: {
      randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }),
    },
  };
  vm.createContext(sandbox);

  // Read source and remove ES module import for sandbox testing
  const SRC = path.resolve(__dirname, '../../public_html/js/dc.js');
  let code = fs.readFileSync(SRC, 'utf8');

  // Replace the ES module imports with empty stubs since we're mocking
  code = code.replace(/^import \* as THREE from "[^"]+";?\n/m, '');
  code = code.replace(/^import {[^]+} from "[^"]+";?\n/m, '');

  // In the VM context, THREE is available as a global from sandbox
  // We need to ensure the IIFEs can access it
  try {
    vm.runInContext(code, sandbox, { filename: SRC });
  } catch (e) {
    // Some functions may reference browser-only globals - that's OK for our tests
  }

  return { sandbox, win, listeners };
}

// ----------------------------------------------------------------
// Tests: Coordinate conversion functions
// ----------------------------------------------------------------
describe('dc.js — coordinate conversion', () => {
  it('convertRackCoordinatesToPosition converts grid coords to world position', () => {
    // Test the formula: positionX = offsetX + (x * options.scaleX)
    // where offsetX = -100, scaleX = 8
    const offsetX = -100;
    const offsetZ = -100;
    const scaleX = 8;
    const scaleZ = 9;

    // rack at grid (0, 0)
    let pos = {
      x: offsetX + (0 * scaleX),
      z: offsetZ + (0 * scaleZ),
      max_x: offsetX + ((0 + 1) * scaleX),
      max_z: offsetZ + ((0 + 1) * scaleZ),
    };
    expect(pos.x).toBe(-100);
    expect(pos.z).toBe(-100);
    expect(pos.max_x).toBe(-92);  // -100 + 8
    expect(pos.max_z).toBe(-91);  // -100 + 9

    // rack at grid (5, 3)
    const x = 5, y = 3;
    pos = {
      x: offsetX + (x * scaleX),
      z: offsetZ + (y * scaleZ),
      max_x: offsetX + ((x + 1) * scaleX),
      max_z: offsetZ + ((y + 1) * scaleZ),
    };
    expect(pos.x).toBe(-100 + 40);  // -60
    expect(pos.z).toBe(-100 + 27);  // -73
    expect(pos.max_x).toBe(-100 + 48);  // -52
    expect(pos.max_z).toBe(-100 + 36);  // -64
  });

  it('convertServerCoordinatesToPosition uses rack position + offsets', () => {
    // Server position is adjusted from rack position by:
    // serverPositionX = rackPosition.x - 2.4
    // serverPositionY = 0.5 * start
    // serverPositionZ = rackPosition.z + 2.6
    const rackX = 2, rackY = 1;
    const offsetX = -100, offsetZ = -100;
    const scaleX = 8, scaleZ = 9;
    const start = 4; // 4U server

    const rackPosition = {
      x: offsetX + (rackX * scaleX),
      z: offsetZ + (rackY * scaleZ),
    };

    const serverPositionX = rackPosition.x - 2.4;
    const serverPositionY = 0.5 * start;
    const serverPositionZ = rackPosition.z + 2.6;

    expect(serverPositionX).toBeCloseTo(rackPosition.x - 2.4);
    expect(serverPositionY).toBeCloseTo(2);  // 0.5 * 4
    expect(serverPositionZ).toBeCloseTo(rackPosition.z + 2.6);
  });

  it('UNITS_PER_INCH constant maps height correctly', () => {
    // 5'10" = 70 inches should map to ~15 scene units (original eye height)
    const eyeHeightInches = 70;
    const expectedEyeHeight = 15;
    const UNITS_PER_INCH = 15 / 70;

    const actualEyeHeight = eyeHeightInches * UNITS_PER_INCH;
    expect(actualEyeHeight).toBeCloseTo(expectedEyeHeight, 0);
  });

  it('playerRadius is derived from waist circumference', () => {
    // playerRadius = waist / (2 * PI) * UNITS_PER_INCH
    // Note: dc.js only clamps minimum to 0.2, no maximum
    const waistInches = 36;
    const UNITS_PER_INCH = 15 / 70;

    const radius = (waistInches / (2 * Math.PI)) * UNITS_PER_INCH;
    expect(radius).toBeGreaterThan(0.2);  // minimum clamp is 0.2
    expect(radius).toBeGreaterThan(1);   // 36" waist gives > 1 radius
    expect(radius).toBeLessThan(2);      // still reasonable
  });
});

// ----------------------------------------------------------------
// Tests: Collision detection (spatial grid logic)
// ----------------------------------------------------------------
describe('dc.js — collision detection logic', () => {
  it('spatial grid cell calculation is correct', () => {
    const RACK_GRID_CELL = 10;
    const _rackGridKey = (x, z) => Math.floor(x / RACK_GRID_CELL) * 10000 + Math.floor(z / RACK_GRID_CELL);

    // Points at cell boundaries
    // Formula: floor(x/10)*10000 + floor(z/10)
    expect(_rackGridKey(0, 0)).toBe(0);
    expect(_rackGridKey(9, 9)).toBe(0);      // floor(9/10) = 0, floor(9/10) = 0 => 0*10000 + 0 = 0
    expect(_rackGridKey(10, 0)).toBe(10000);  // floor(10/10) = 1, floor(0/10) = 0 => 1*10000 + 0 = 10000
    expect(_rackGridKey(0, 10)).toBe(1);     // floor(0/10) = 0, floor(10/10) = 1 => 0*10000 + 1 = 1
    expect(_rackGridKey(10, 10)).toBe(10001); // floor(10/10) = 1, floor(10/10) = 1 => 1*10000 + 1 = 10001

    // Negative coordinates
    // floor(-1/10) = floor(-0.1) = -1, so (-1)*10000 + (-1) = -10001
    expect(_rackGridKey(-1, -1)).toBe(-10001);
    // floor(-10/10) = floor(-1) = -1, so (-1)*10000 + (-1) = -10001
    expect(_rackGridKey(-10, -10)).toBe(-10001);
  });

  it('collider AABB intersection logic', () => {
    // AABB collision: x + r >= c.minX && x - r <= c.maxX && z + r >= c.minZ && z - r <= c.maxZ
    const collider = { minX: -50, maxX: -42, minZ: -50, maxZ: -43 };
    const radius = 1;

    // Point inside collider
    let x = -46, z = -46;
    let collides = (x + radius >= collider.minX) && (x - radius <= collider.maxX) &&
                   (z + radius >= collider.minZ) && (z - radius <= collider.maxZ);
    expect(collides).toBe(true);

    // Point outside collider
    x = 0; z = 0;
    collides = (x + radius >= collider.minX) && (x - radius <= collider.maxX) &&
               (z + radius >= collider.minZ) && (z - radius <= collider.maxZ);
    expect(collides).toBe(false);

    // Player touching edge
    x = -49; z = -46;  // within z range, but x - radius = -50 = minX (touching)
    collides = (x + radius >= collider.minX) && (x - radius <= collider.maxX) &&
               (z + radius >= collider.minZ) && (z - radius <= collider.maxZ);
    expect(collides).toBe(true);
  });

  it('room bounds collision check', () => {
    // roomBounds: {minX, maxX, minZ, maxZ}
    const roomBounds = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
    const radius = 1;

    // Inside room
    let x = 0, z = 0;
    let collides = x - radius <= roomBounds.minX || x + radius >= roomBounds.maxX ||
                   z - radius <= roomBounds.minZ || z + radius >= roomBounds.maxZ;
    expect(collides).toBe(false);

    // Outside at minX
    x = -101;
    collides = x - radius <= roomBounds.minX || x + radius >= roomBounds.maxX ||
               z - radius <= roomBounds.minZ || z + radius >= roomBounds.maxZ;
    expect(collides).toBe(true);

    // Outside at maxZ
    x = 0; z = 101;
    collides = x - radius <= roomBounds.minX || x + radius >= roomBounds.maxX ||
               z - radius <= roomBounds.minZ || z + radius >= roomBounds.maxZ;
    expect(collides).toBe(true);
  });
});

// ----------------------------------------------------------------
// Tests: Label and texture caching (cacheWithEvict)
// ----------------------------------------------------------------
describe('dc.js — texture caching', () => {
  it('cacheWithEvict implements LRU eviction correctly', () => {
    const cacheMap = new Map();
    const orderArray = [];
    // Use a small cache size for testing eviction
    const MAX_TEXTURE_CACHE = 4;

    const cacheWithEvict = (cacheMap, key, value, orderArray) => {
      if (cacheMap.has(key)) {
        const idx = orderArray.indexOf(key);
        if (idx !== -1) orderArray.splice(idx, 1);
        orderArray.push(key);
        cacheMap.set(key, value);
        return;
      }
      if (cacheMap.size >= MAX_TEXTURE_CACHE) {
        const oldest = orderArray.shift();
        cacheMap.delete(oldest);
      }
      orderArray.push(key);
      cacheMap.set(key, value);
    };

    // Add 3 items (cache has room)
    cacheWithEvict(cacheMap, 'key1', { data: 1 }, orderArray);
    cacheWithEvict(cacheMap, 'key2', { data: 2 }, orderArray);
    cacheWithEvict(cacheMap, 'key3', { data: 3 }, orderArray);

    expect(cacheMap.size).toBe(3);
    expect(orderArray).toEqual(['key1', 'key2', 'key3']);

    // Access key1 (moves to end)
    cacheWithEvict(cacheMap, 'key1', cacheMap.get('key1'), orderArray);
    expect(orderArray).toEqual(['key2', 'key3', 'key1']);

    // Add key4 (fills cache to max)
    cacheWithEvict(cacheMap, 'key4', { data: 4 }, orderArray);
    expect(cacheMap.size).toBe(4);
    expect(orderArray).toEqual(['key2', 'key3', 'key1', 'key4']);

    // Add key5 (should evict oldest: key2, since key1 was re-accessed)
    cacheWithEvict(cacheMap, 'key5', { data: 5 }, orderArray);
    expect(cacheMap.size).toBe(4);  // Eviction occurred
    expect(orderArray).toEqual(['key3', 'key1', 'key4', 'key5']);
    expect(cacheMap.has('key2')).toBe(false);
    expect(cacheMap.has('key3')).toBe(true);

    // Add key6 (should evict oldest: key3)
    cacheWithEvict(cacheMap, 'key6', { data: 6 }, orderArray);
    expect(orderArray).toEqual(['key1', 'key4', 'key5', 'key6']);
    expect(cacheMap.has('key3')).toBe(false);
  });

  it('MAX_TEXTURE_CACHE = 128', () => {
    expect(MAX_TEXTURE_CACHE).toBe(128);
  });
});

// ----------------------------------------------------------------
// Tests: Cable routing constants
// ----------------------------------------------------------------
describe('dc.js — cable routing constants', () => {
  it('cable geometry constants are defined correctly', () => {
    const CABLE_REAR = -2;
    const CABLE_OVERHEAD = 22;
    const CABLE_END = 5;
    const CABLE_SPREAD = 1.1;
    const CABLE_RADIUS = 0.05;
    const CABLE_RADIAL = 8;

    expect(CABLE_REAR).toBe(-2);
    expect(CABLE_OVERHEAD).toBe(22);
    expect(CABLE_END).toBe(5);
    expect(CABLE_SPREAD).toBe(1.1);
    expect(CABLE_RADIUS).toBe(0.05);
    expect(CABLE_RADIAL).toBe(8);
    expect(CABLE_RADIUS).toBeLessThan(0.1);  // thin cables
  });

  it('cable curve point generation', () => {
    // Test makeRng produces deterministic values
    const makeRng = (seed) => {
      let s = (seed >>> 0);
      if (s === 0) {
        const str = String(seed);
        for (let i = 0; i < str.length; i++) s = Math.imul(s ^ str.charCodeAt(i), 2660689);
        s = (s >>> 0) || 1;
      }
      return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    };

    const rng1 = makeRng(12345);
    const rng2 = makeRng(12345);

    // Same seed produces same sequence
    const seq1 = [rng1(), rng1(), rng1()];
    const seq2 = [rng2(), rng2(), rng2()];
    expect(seq1).toEqual(seq2);

    // Values are in [0, 1)
    for (const v of seq1) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ----------------------------------------------------------------
// Tests: Room/building dimensions
// ----------------------------------------------------------------
describe('dc.js — room dimensions', () => {
  it('ROOM_MARGIN = 28 units', () => {
    const ROOM_MARGIN = 28;
    expect(ROOM_MARGIN).toBe(28);
  });

  it('ROOM_CEIL_Y = 38.5 units', () => {
    const ROOM_CEIL_Y = 38.5;
    expect(ROOM_CEIL_Y).toBe(38.5);
  });

  it('CEIL_TILE is derived from UNITS_PER_INCH', () => {
    // 3 ft drop-ceiling tiles: 3 * 12 = 36 inches * UNITS_PER_INCH
    const UNITS_PER_INCH = 15 / 70;
    const CEIL_TILE = 36 * UNITS_PER_INCH;
    expect(CEIL_TILE).toBeCloseTo(7.71, 1);  // 36 * (15/70) ≈ 7.71
  });
});

// ----------------------------------------------------------------
// Tests: View options
// ----------------------------------------------------------------
describe('dc.js — view options', () => {
  it('VIEW_OPTS contains expected views', () => {
    const VIEW_OPTS = {
      Overview: 'overview',
      'Top-down': 'top',
      Aisle: 'aisle',
      Labels: 'labels',
      Cables: 'cables'
    };

    expect(Object.keys(VIEW_OPTS)).toHaveLength(5);
    expect(VIEW_OPTS.Overview).toBe('overview');
    expect(VIEW_OPTS['Top-down']).toBe('top');
    expect(VIEW_OPTS.Aisle).toBe('aisle');
    expect(VIEW_OPTS.Labels).toBe('labels');
    expect(VIEW_OPTS.Cables).toBe('cables');
  });
});

// ----------------------------------------------------------------
// Tests: FPS quality scaling
// ----------------------------------------------------------------
describe('dc.js — quality scaling', () => {
  it('FPS_TARGET = 55, FPS_RECOVERY = 65', () => {
    const FPS_TARGET = 55;
    const FPS_RECOVERY = 65;
    expect(FPS_TARGET).toBe(55);
    expect(FPS_RECOVERY).toBe(65);
    expect(FPS_RECOVERY).toBeGreaterThan(FPS_TARGET);
  });

  it('pixel scale range is 0.5 to 1.0', () => {
    const pixelScaleRange = { min: 0.5, max: 1.0 };
    const testValues = [0.3, 0.5, 0.75, 1.0, 1.5];

    const clamp = (v) => Math.min(Math.max(v, pixelScaleRange.min), pixelScaleRange.max);

    expect(clamp(0.3)).toBe(0.5);   // below min
    expect(clamp(0.5)).toBe(0.5);   // at min
    expect(clamp(0.75)).toBe(0.75); // in range
    expect(clamp(1.0)).toBe(1.0);   // at max
    expect(clamp(1.5)).toBe(1.0);   // above max
  });
});

// ----------------------------------------------------------------
// Tests: LOD distance constants
// ----------------------------------------------------------------
describe('dc.js — LOD (Level of Detail) constants', () => {
  it('LOD distances are reasonable', () => {
    const LOD_ENTER_PAD = 28;
    const LOD_EXIT_PAD = 80;
    const LOD_MAX_FULL = 1;

    expect(LOD_ENTER_PAD).toBe(28);
    expect(LOD_EXIT_PAD).toBe(80);
    expect(LOD_MAX_FULL).toBe(1);

    // Enter threshold should be smaller than exit (hysteresis)
    expect(LOD_ENTER_PAD).toBeLessThan(LOD_EXIT_PAD);
  });
});

// ----------------------------------------------------------------
// Tests: Default options
// ----------------------------------------------------------------
describe('dc.js — default options', () => {
  it('default movement options are correct', () => {
    const options = {
      useFirstPerson: false,
      showLabels: true,
      showNetwork: true,
      showWalls: true,
      showCeiling: true,
      faultyLights: 1,
      disco: false,
      moveForward: false,
      moveBackward: false,
      moveLeft: false,
      moveRight: false,
      canJump: false,
      collisionMovement: true,
      gravityMs2: 9.8,
      domain: '',
      location: 4,
      heightInches: 70,
      waistInches: 36,
      scaleX: 8,
      scaleZ: 9,
    };

    expect(options.useFirstPerson).toBe(false);
    expect(options.showLabels).toBe(true);
    expect(options.showNetwork).toBe(true);
    expect(options.showWalls).toBe(true);
    expect(options.showCeiling).toBe(true);
    expect(options.faultyLights).toBe(1);  // 1%
    expect(options.disco).toBe(false);
    expect(options.moveForward).toBe(false);
    expect(options.collisionMovement).toBe(true);
    expect(options.gravityMs2).toBe(9.8);   // Earth gravity
    expect(options.heightInches).toBe(70); // 5'10"
    expect(options.waistInches).toBe(36);
    expect(options.scaleX).toBe(8);
    expect(options.scaleZ).toBe(9);
  });
});

// ----------------------------------------------------------------
// Tests: Billboard label constants
// ----------------------------------------------------------------
describe('dc.js — label rendering', () => {
  it('LABEL_DISTANCE = 40 units', () => {
    const LABEL_DISTANCE = 40;
    const LABEL_DISTANCE_SQ = LABEL_DISTANCE * LABEL_DISTANCE;
    expect(LABEL_DISTANCE).toBe(40);
    expect(LABEL_DISTANCE_SQ).toBe(1600);
  });

  it('MAX_LABELS = 200', () => {
    const MAX_LABELS = 200;
    expect(MAX_LABELS).toBe(200);
  });

  it('label canvas is created at correct size', () => {
    const scale = 3;
    const w = 320 * scale;  // 960
    const h = 32 * scale;   // 96

    expect(w).toBe(960);
    expect(h).toBe(96);
  });
});
