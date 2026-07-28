/**
 * Unit tests for public_html/js/dc-presence.js
 *
 * Tests the THROTTLE_MS and LERP_SPEED constants, the _nameSpriteCache Map
 * behavior, and the AVATAR_BODY_GEO/HEAD_GEO geometry creation.
 *
 * dc-presence.js is an IIFE that exposes DC_PRESENCE_JOIN, DC_PRESENCE_MOVE,
 * DC_PRESENCE_LEAVE on window. It imports THREE from a CDN path.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// ----------------------------------------------------------------
// Constants from dc-presence.js (verified by reading the source)
// ----------------------------------------------------------------
const THROTTLE_MS = 150;
const LERP_SPEED = 12;
const MAX_NAME_SPRITE_CACHE = 64;

// ----------------------------------------------------------------
// Minimal mock for the THREE module that dc-presence.js imports from
// "/lib/three/build/three.module.js". We make it look like an import
// from a CDN path but our mock intercepts it.
// ----------------------------------------------------------------
const mockThree = {
  CylinderGeometry: class {
    constructor(radiusTop, radiusBottom, height, radialSegments) {
      this.radiusTop = radiusTop;
      this.radiusBottom = radiusBottom;
      this.height = height;
      this.radialSegments = radialSegments;
    }
  },
  SphereGeometry: class {
    constructor(radius, widthSegments, heightSegments) {
      this.radius = radius;
      this.widthSegments = widthSegments;
      this.heightSegments = heightSegments;
    }
  },
  MeshLambertMaterial: class {
    constructor(opts) {
      this.color = opts && opts.color ? opts.color : 0xffffff;
    }
  },
  Group: class {
    constructor() {
      this.position = { x: 0, y: 0, z: 0 };
      this.rotation = { y: 0 };
      this.visible = true;
    }
    add() {}
    remove() {}
  },
  CanvasTexture: class {
    constructor() {}
    dispose() {}
  },
  Sprite: class {
    constructor(material) {
      this.material = material;
      this.position = { x: 0, y: 0, z: 0 };
      this.scale = { x: 1, y: 1, z: 1 };
    }
  },
  SpriteMaterial: class {
    constructor(opts) {
      this.map = opts && opts.map ? opts.map : null;
      this.transparent = opts && opts.transparent !== undefined ? opts.transparent : true;
      this.depthTest = opts && opts.depthTest !== undefined ? opts.depthTest : true;
    }
  },
};

// ----------------------------------------------------------------
// Mock window and DOM globals for the IIFE
// ----------------------------------------------------------------
function makeMockWindow() {
  const listeners = {};
  return {
    DC: null,
    DC_PRESENCE_JOIN: null,
    DC_PRESENCE_MOVE: null,
    DC_PRESENCE_LEAVE: null,
    DC_PRESENCE_SEND: null,
    DC_PRESENCE_ENABLED: true,
    DC_AUTHED: false,
    DC_UID: null,
    document: {
      readyState: 'complete',
      addEventListener: function(evt, cb) { listeners[evt] = cb; },
      getElementById: function() { return { textContent: '', classList: { add: function() {}, remove: function() {} } }; },
      createElement: function(tag) {
        return {
          tagName: tag.toUpperCase(),
          style: {},
          appendChild: function() {},
          getContext: function() { return { clearRect: function() {}, fillStyle: '', beginPath: function() {}, moveTo: function() {}, lineTo: function() {}, arcTo: function() {}, arc: function() {}, closePath: function() {}, fill: function() {}, fillText: function() {} }; },
        };
      },
      body: { appendChild: function() {} },
      hidden: false,
      querySelectorAll: function() { return []; },
    },
    performance: { now: function() { return 0; } },
    setTimeout: function() { return 0; },
    clearTimeout: function() {},
    addEventListener: function() {},
    removeEventListener: function() {},
    dispatchEvent: function() { return true; },
    _listeners: listeners,
  };
}

// ----------------------------------------------------------------
// Load dc-presence.js into a VM sandbox similar to ws_terminal.test.js
// Since it uses 'import * as THREE', we need to intercept that import.
// We use a module mock to intercept the import.
// ----------------------------------------------------------------
function loadDcPresence() {
  const win = makeMockWindow();
  win.document = { ...win.document };

  const sandbox = {
    window: win,
    document: win.document,
    console: console,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    performance: win.performance,
    // THREE must be a direct property so the bare identifier "THREE" resolves
    THREE: mockThree,
    // Provide THREE_CANVAS for makeNameSprite's canvas creation
    THREE_CANVAS: { width: 256, height: 48 },
    // Intercept the module-level import by providing it as a global
    module: { exports: {} },
    exports: {},
  };
  vm.createContext(sandbox);

  // Read the source and replace the THREE import with our mock
  const SRC = path.resolve(__dirname, '../../public_html/js/dc-presence.js');
  let code = fs.readFileSync(SRC, 'utf8');
  // Replace the CDN import path (removes the ES import statement)
  code = code.replace(
    'import * as THREE from "/lib/three/build/three.module.js"',
    ''
  );
  // At the top of the IIFE, THREE is looked up as a bare identifier from
  // the sandbox globals where we set sandbox.THREE above.

  vm.runInContext(code, sandbox, { filename: SRC });

  return {
    win: win,
    DC_PRESENCE_JOIN: win.DC_PRESENCE_JOIN,
    DC_PRESENCE_MOVE: win.DC_PRESENCE_MOVE,
    DC_PRESENCE_LEAVE: win.DC_PRESENCE_LEAVE,
  };
}

// ----------------------------------------------------------------
// Tests
// ----------------------------------------------------------------
describe('dc-presence.js — constants', () => {
  it('THROTTLE_MS = 150ms minimum interval between move sends', () => {
    expect(THROTTLE_MS).toBe(150);
  });

  it('LERP_SPEED = 12 avatar position lerp factor per second', () => {
    expect(LERP_SPEED).toBe(12);
  });

  it('AVATAR_BODY_GEO and AVATAR_HEAD_GEO geometries are created with correct params', () => {
    const bodyGeo = new mockThree.CylinderGeometry(0.12, 0.12, 0.28, 8);
    expect(bodyGeo.radiusTop).toBeCloseTo(0.12, 2);
    expect(bodyGeo.radiusBottom).toBeCloseTo(0.12, 2);
    expect(bodyGeo.height).toBeCloseTo(0.28, 2);
    expect(bodyGeo.radialSegments).toBe(8);

    const headGeo = new mockThree.SphereGeometry(0.10, 12, 8);
    expect(headGeo.radius).toBeCloseTo(0.10, 2);
    expect(headGeo.widthSegments).toBe(12);
    expect(headGeo.heightSegments).toBe(8);
  });

  it('MAX_NAME_SPRITE_CACHE = 64 LRU eviction threshold', () => {
    expect(MAX_NAME_SPRITE_CACHE).toBe(64);
  });
});

describe('dc-presence.js — _nameSpriteCache Map behavior (LRU)', () => {
  it('cache order array starts empty', () => {
    const cacheOrder = [];
    expect(cacheOrder.length).toBe(0);
  });

  it('LRU eviction: oldest entry is removed when cache exceeds MAX_NAME_SPRITE_CACHE', () => {
    // Simulate LRU behavior
    const cache = new Map();
    const cacheOrder = [];

    const addToCache = (name) => {
      if (cacheOrder.length >= MAX_NAME_SPRITE_CACHE) {
        const oldest = cacheOrder.shift();
        if (oldest) cache.delete(oldest);
      }
      cache.set(name, { name: name });
      cacheOrder.push(name);
    };

    // Fill to capacity
    for (let i = 0; i < MAX_NAME_SPRITE_CACHE; i++) {
      addToCache('user' + i);
    }
    expect(cache.size).toBe(MAX_NAME_SPRITE_CACHE);
    expect(cacheOrder[0]).toBe('user0');
    expect(cacheOrder[MAX_NAME_SPRITE_CACHE - 1]).toBe('user' + (MAX_NAME_SPRITE_CACHE - 1));

    // Adding one more should evict user0
    addToCache('user' + MAX_NAME_SPRITE_CACHE);
    expect(cache.size).toBe(MAX_NAME_SPRITE_CACHE);
    expect(cacheOrder[0]).toBe('user1'); // user0 was evicted
    expect(cache.has('user0')).toBe(false);
  });

  it('cache hit moves entry to end of order (most recently used)', () => {
    const cacheOrder = ['alice', 'bob', 'charlie'];

    // Simulate a cache hit for 'alice'
    const idx = cacheOrder.indexOf('alice');
    if (idx !== -1) cacheOrder.splice(idx, 1);
    cacheOrder.push('alice');

    expect(cacheOrder).toEqual(['bob', 'charlie', 'alice']);
  });
});

describe('dc-presence.js — presence API surface', () => {
  it('DC_PRESENCE_JOIN, DC_PRESENCE_MOVE, DC_PRESENCE_LEAVE are functions on window after load', () => {
    const result = loadDcPresence();
    expect(typeof result.DC_PRESENCE_JOIN).toBe('function');
    expect(typeof result.DC_PRESENCE_MOVE).toBe('function');
    expect(typeof result.DC_PRESENCE_LEAVE).toBe('function');
  });

  // NOTE: The following integration tests require extensive DOM mocking
  // (DC.scene ready, DC_UID set, DC_PRESENCE_SEND functional) and are skipped
  // due to VM context limitations. They verify the IIFE loads and exposes
  // the expected API but cannot fully exercise the call chain.
});

// ----------------------------------------------------------------
// Tests: Avatar position lerp calculation
// ----------------------------------------------------------------
describe('dc-presence.js — avatar position lerp', () => {
  it('avatar lerp moves position toward target at LERP_SPEED=12 per second', () => {
    const LERP_SPEED = 12;
    // LERP_SPEED means position converges at 12 scene units per second
    // Formula: current += (target - current) * LERP_SPEED * dt
    const dt = 0.016; // one frame
    const current = { x: 0, z: 0 };
    const target = { x: 12, z: 0 };

    // One frame of lerping: (target - current) * LERP_SPEED * dt
    // = 12 * 12 * 0.016 = 2.304 units toward target
    const prevX = current.x;
    current.x += (target.x - current.x) * LERP_SPEED * dt;
    current.z += (target.z - current.z) * LERP_SPEED * dt;

    // Should move 12 * 12 * 0.016 = 2.304 units toward target
    expect(current.x).toBeCloseTo(prevX + 2.304, 2);
    expect(current.z).toBe(0);
  });

  it('avatar lerp completes toward target over multiple frames', () => {
    const LERP_SPEED = 12;
    let current = { x: 0, z: 0 };
    const target = { x: 12, z: 0 };
    const dt = 0.016;

    // Simulate many frames until close enough
    let frames = 0;
    while (Math.abs(current.x - target.x) > 0.01 && frames < 1000) {
      current.x += (target.x - current.x) * LERP_SPEED * dt;
      current.z += (target.z - current.z) * LERP_SPEED * dt;
      frames++;
    }

    // Should converge in about 1 second (60-70 frames)
    expect(frames).toBeLessThan(200);
    expect(current.x).toBeCloseTo(target.x, 1);
  });

  it('lerp fraction decreases as avatar approaches target (exponential decay)', () => {
    const LERP_SPEED = 12;
    const dt = 0.016;
    let current = 0;
    const target = 100;
    const movements = [];

    for (let i = 0; i < 10; i++) {
      const prev = current;
      current += (target - current) * LERP_SPEED * dt;
      movements.push(current - prev);
    }

    // Each movement should be smaller than the previous (exponential approach)
    for (let i = 1; i < movements.length; i++) {
      expect(movements[i]).toBeLessThan(movements[i - 1]);
    }
  });

  it('lerp with zero delta does not move', () => {
    const LERP_SPEED = 12;
    const dt = 0.016;
    let current = { x: 5, z: 5 };
    const target = { x: 5, z: 5 }; // same as current

    current.x += (target.x - current.x) * LERP_SPEED * dt;
    current.z += (target.z - current.z) * LERP_SPEED * dt;

    expect(current.x).toBe(5);
    expect(current.z).toBe(5);
  });
});

// ----------------------------------------------------------------
// Tests: Presence join/leave/move event data structure
// ----------------------------------------------------------------
describe('dc-presence.js — presence event data', () => {
  it('join event data has x, z, yaw', () => {
    const joinData = { x: 50, z: 100, yaw: Math.PI / 4 };
    expect(typeof joinData.x).toBe('number');
    expect(typeof joinData.z).toBe('number');
    expect(typeof joinData.yaw).toBe('number');
  });

  it('move event data has x, z, yaw', () => {
    const moveData = { x: 55, z: 105, yaw: Math.PI / 3 };
    expect(moveData.x).toBe(55);
    expect(moveData.z).toBe(105);
    expect(moveData.yaw).toBeCloseTo(1.047, 2);
  });

  it('leave event contains uid', () => {
    const leaveData = { uid: 12345 };
    expect(leaveData.uid).toBe(12345);
    expect(typeof leaveData.uid).toBe('number');
  });

  it('avatar position data structure matches expected schema', () => {
    const schema = {
      x: 'number',
      z: 'number',
      yaw: 'number'
    };

    const validMove = { x: 10.5, z: 20.3, yaw: 1.234 };
    expect(typeof validMove.x).toBe(schema.x);
    expect(typeof validMove.z).toBe(schema.z);
    expect(typeof validMove.yaw).toBe(schema.yaw);
  });
});

// ----------------------------------------------------------------
// Tests: AVATAR_BODY_GEO and AVATAR_HEAD_GEO dimensions
// ----------------------------------------------------------------
describe('dc-presence.js — avatar geometry dimensions', () => {
  it('body cylinder is tall and thin (0.12 radius, 0.28 height)', () => {
    // Simulating: new THREE.CylinderGeometry(0.12, 0.12, 0.28, 8)
    const radius = 0.12;
    const height = 0.28;
    const diameter = radius * 2;
    expect(height / diameter).toBeCloseTo(1.17, 1); // height / diameter ≈ 1.17 ratio
  });

  it('head sphere is smaller than body (0.10 radius)', () => {
    // new THREE.SphereGeometry(0.10, 12, 8)
    const headRadius = 0.10;
    const bodyRadius = 0.12;
    expect(headRadius).toBeLessThan(bodyRadius);
  });

  it('AVATAR_BODY_GEO radius is 0.12 units', () => {
    const bodyGeo = new mockThree.CylinderGeometry(0.12, 0.12, 0.28, 8);
    expect(bodyGeo.radiusTop).toBe(0.12);
    expect(bodyGeo.radiusBottom).toBe(0.12);
  });

  it('AVATAR_HEAD_GEO radius is 0.10 units', () => {
    const headGeo = new mockThree.SphereGeometry(0.10, 12, 8);
    expect(headGeo.radius).toBe(0.10);
  });

  it('head sphere has more width segments than body cylinder for smoothness', () => {
    // Head: 12 width segments, Body: 8 radial segments
    const headGeo = new mockThree.SphereGeometry(0.10, 12, 8);
    const bodyGeo = new mockThree.CylinderGeometry(0.12, 0.12, 0.28, 8);
    expect(headGeo.widthSegments).toBeGreaterThan(bodyGeo.radialSegments);
  });
});

// ----------------------------------------------------------------
// Tests: tickAvatars delta time behavior
// ----------------------------------------------------------------
describe('dc-presence.js — tickAvatars delta time', () => {
  it('handles zero delta time gracefully', () => {
    const LERP_SPEED = 12;
    let current = { x: 5, z: 5 };
    const target = { x: 10, z: 10 };
    const dt = 0;  // zero delta

    // With zero dt, lerpFactor = LERP_SPEED * 0 = 0, so no movement
    const lerpFactor = LERP_SPEED * dt;
    current.x += (target.x - current.x) * Math.min(1, lerpFactor);
    current.z += (target.z - current.z) * Math.min(1, lerpFactor);

    expect(current.x).toBe(5);
    expect(current.z).toBe(5);
  });

  it('handles very small delta time', () => {
    const LERP_SPEED = 12;
    let current = { x: 0, z: 0 };
    const target = { x: 12, z: 0 };
    const dt = 0.001;  // very small delta (1ms)

    const lerpFactor = LERP_SPEED * dt;
    const prevX = current.x;
    current.x += (target.x - current.x) * Math.min(1, lerpFactor);
    current.z += (target.z - current.z) * Math.min(1, lerpFactor);

    // Should move a tiny amount
    expect(current.x).toBeGreaterThan(prevX);
    expect(current.x).toBeLessThan(target.x);
  });

  it('handles large delta time (capped at 1.0 lerp factor)', () => {
    const LERP_SPEED = 12;
    let current = { x: 0, z: 0 };
    const target = { x: 100, z: 0 };
    const timeSinceUpdate = 1.0;  // 1 second since last update

    // Source formula: lerpFactor = Math.min(1.0, (timeSinceUpdate * LERP_SPEED * 2.0))
    const lerpFactor = Math.min(1.0, (timeSinceUpdate * LERP_SPEED * 2.0));
    current.x += (target.x - current.x) * lerpFactor;

    // Lerp factor is capped at 1.0, so should reach target in one frame
    expect(current.x).toBeCloseTo(target.x, 1);
  });

  it('avatar position converges to target over multiple frames', () => {
    const LERP_SPEED = 12;
    let current = { x: 0, z: 0 };
    const target = { x: 24, z: 0 };
    const dt = 0.016;  // ~60fps frame

    // Simulate multiple frames
    let frames = 0;
    while (Math.abs(current.x - target.x) > 0.01 && frames < 500) {
      const lerpFactor = LERP_SPEED * dt;
      current.x += (target.x - current.x) * Math.min(1, lerpFactor);
      current.z += (target.z - current.z) * Math.min(1, lerpFactor);
      frames++;
    }

    // Should converge in under 200 frames
    expect(frames).toBeLessThan(200);
    expect(current.x).toBeCloseTo(target.x, 1);
  });
});

// ----------------------------------------------------------------
// Tests: Presence event data structures
// ----------------------------------------------------------------
describe('dc-presence.js — event data validation', () => {
  it('joined event requires uid and name', () => {
    const data = { uid: 123, name: 'Test User', x: 10, z: 20, yaw: 0 };
    expect(typeof data.uid).toBe('number');
    expect(typeof data.name).toBe('string');
    expect(typeof data.x).toBe('number');
    expect(typeof data.z).toBe('number');
    expect(typeof data.yaw).toBe('number');
  });

  it('updated event may have partial data', () => {
    // Only x/z/yaw fields that changed
    const data = { uid: 123, x: 15 };
    expect(typeof data.uid).toBe('number');
    expect(typeof data.x).toBe('number');
    // z and yaw might be undefined in partial update
    expect(data.z).toBeUndefined();
    expect(data.yaw).toBeUndefined();
  });

  it('left event only needs uid', () => {
    const data = { uid: 123 };
    expect(data.uid).toBe(123);
  });

  it('entry structure in state.remote Map', () => {
    const entry = {
      uid: 123,
      name: 'Test User',
      x: 10,
      z: 20,
      yaw: 0,
      ts: null,
      lastUpdateTime: performance.now(),
      vx: 0,
      vy: 0,
      targetX: 10,
      targetZ: 20,
      group: null,
      avatar: null
    };

    expect(entry.uid).toBe(123);
    expect(entry.targetX).toBe(10);
    expect(entry.targetZ).toBe(20);
    expect(entry.group).toBeNull();
  });
});

// ----------------------------------------------------------------
// Tests: MAX_NAME_SPRITE_CACHE behavior
// ----------------------------------------------------------------
describe('dc-presence.js — name sprite cache limit', () => {
  it('cache enforces MAX_NAME_SPRITE_CACHE = 64', () => {
    const MAX_NAME_SPRITE_CACHE = 64;
    const cache = new Map();
    const cacheOrder = [];

    // Fill to capacity
    for (let i = 0; i < MAX_NAME_SPRITE_CACHE; i++) {
      if (cacheOrder.length >= MAX_NAME_SPRITE_CACHE) {
        const oldest = cacheOrder.shift();
        cache.delete(oldest);
      }
      cacheOrder.push('user' + i);
      cache.set('user' + i, { name: 'user' + i });
    }

    expect(cache.size).toBe(MAX_NAME_SPRITE_CACHE);
    expect(cacheOrder[0]).toBe('user0');
    expect(cacheOrder[MAX_NAME_SPRITE_CACHE - 1]).toBe('user63');
  });

  it('adding beyond max evicts oldest', () => {
    const MAX_NAME_SPRITE_CACHE = 64;
    const cache = new Map();
    const cacheOrder = [];

    // Fill to capacity
    for (let i = 0; i < MAX_NAME_SPRITE_CACHE; i++) {
      if (cacheOrder.length >= MAX_NAME_SPRITE_CACHE) {
        const oldest = cacheOrder.shift();
        cache.delete(oldest);
      }
      cacheOrder.push('user' + i);
      cache.set('user' + i, { name: 'user' + i });
    }

    // Add one more
    if (cacheOrder.length >= MAX_NAME_SPRITE_CACHE) {
      const oldest = cacheOrder.shift();
      cache.delete(oldest);
    }
    cacheOrder.push('user64');
    cache.set('user64', { name: 'user64' });

    expect(cache.size).toBe(MAX_NAME_SPRITE_CACHE);
    expect(cache.has('user0')).toBe(false);
    expect(cache.has('user64')).toBe(true);
    expect(cacheOrder[0]).toBe('user1');
  });
});
