// Minimal Three.js mock for unit testing dc-multi.js and dc-presence.js
// Matches the subset of the Three.js API actually used by these modules

export const Vector3 = class {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  equals(v) { return this.x === v.x && this.y === v.y && this.z === v.z; }
  addScaledVector() { return this; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  normalize() { return this; }
  lerp() { return this; }
  distanceToSquared(v) {
    const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }
};

export const Euler = class {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') {
    this.x = x; this.y = y; this.z = z; this.order = order;
  }
  set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; return this; }
  setFromQuaternion() { return this; }
};

// Faithful enough for dc-presence's avatar bookkeeping: add()/remove() maintain
// children + parent, and traverse() walks the subtree (used by its teardown paths).
export const Group = class {
  constructor() {
    this.position = new Vector3();
    this.rotation = new Euler();
    this.scale = new Vector3(1, 1, 1);
    this.visible = true;
    this.children = [];
    this.parent = null;
  }
  // Real Three.js Object3D.add() REPARENTS: it detaches the object from its previous
  // parent first, because an Object3D has exactly one parent. The stub used to only
  // push and overwrite .parent, which made a shared object look like it was in two
  // groups at once — and hid the fact that dc-presence's per-NAME Sprite cache hands
  // the same Sprite instance to every avatar with that name, so they fight over one
  // nameplate and all but the last lose it. Keep this faithful.
  add(o) {
    if (o) {
      if (o.parent && o.parent !== this && typeof o.parent.remove === 'function') {
        o.parent.remove(o);
      }
      if (this.children.indexOf(o) === -1) this.children.push(o);
      o.parent = this;
    }
    return this;
  }
  remove(o) {
    const i = this.children.indexOf(o);
    if (i !== -1) { this.children.splice(i, 1); if (o) o.parent = null; }
    return this;
  }
  traverse(cb) {
    cb(this);
    for (const c of this.children.slice()) {
      if (c && typeof c.traverse === 'function') c.traverse(cb);
      else cb(c);
    }
  }
};

export const MathUtils = {
  lerp: (a, b, t) => a + (b - a) * t,
};

export const LoopRepeat = { REPEAT: 0 };
export const LoopOnce = { LOOP_ONCE: 0 };

export const AnimationMixer = class {
  constructor() {}
  clipAction() { return new AnimationAction(); }
  stopAllAction() {}
  uncacheRoot() {}
  update() {}
};

export const AnimationAction = class {
  constructor() {
    this.enabled = true;
    this.userData = {};
  }
  setEffectiveWeight() { return this; }
  setLoop(loop, count) { this.loop = loop; return this; }
  clampWhenFinished() { return this; }
  fadeIn() { return this; }
  fadeOut() { return this; }
  play() { return this; }
  reset() { return this; }
  getClip() { return { duration: 3 }; }
};

export const Box3 = class {
  setFromObject() { this.min = { y: 0 }; this.max = { y: 1 }; return this; }
};

export const SRGBColorSpace = 'srgb';

export const MeshLambertMaterial = class {
  constructor(opts = {}) {
    this.color = opts.color || 0xffffff;
  }
};

export const MeshPhysicalMaterial = class {
  constructor(opts = {}) {
    this.color = opts.color || 0xffffff;
    this.metalness = opts.metalness ?? 0;
    this.roughness = opts.roughness ?? 1;
    this.transparent = opts.transparent ?? false;
    this.opacity = opts.opacity ?? 1;
    this.reflectivity = opts.reflectivity ?? 0.5;
    this.clearcoat = opts.clearcoat ?? 0;
    this.clearcoatRoughness = opts.clearcoatRoughness ?? 0;
    this.side = opts.side ?? 0;
  }
};

export const MeshStandardMaterial = class {
  constructor(opts = {}) {
    this.color = opts.color || 0xffffff;
    this.metalness = opts.metalness ?? 0;
    this.roughness = opts.roughness ?? 1;
  }
};

export const MeshBasicMaterial = class {
  constructor(opts = {}) {
    this.map = opts.map || null;
    this.transparent = opts.transparent ?? false;
    this.opacity = opts.opacity ?? 1;
    this.depthWrite = opts.depthWrite ?? true;
    this.side = opts.side ?? 0;
  }
};

export const Mesh = class {
  constructor(geo, mat) {
    this.geometry = geo;
    this.material = mat;
    this.position = new Vector3();
    this.rotation = new Euler();
    this.visible = true;
    this.castShadow = false;
    this.frustumCulled = false;
    this.isMesh = true;
    this.parent = null;
  }
};

export const CylinderGeometry = class {
  constructor(radiusTop, radiusBottom, height, radialSegments) {
    this.radiusTop = radiusTop;
    this.radiusBottom = radiusBottom;
    this.height = height;
    this.radialSegments = radialSegments;
  }
};

export const SphereGeometry = class {
  constructor(radius, widthSegments, heightSegments) {
    this.radius = radius;
    this.widthSegments = widthSegments;
    this.heightSegments = heightSegments;
  }
};

export const BoxGeometry = class {
  constructor(width, height, depth) {
    this.width = width;
    this.height = height;
    this.depth = depth;
  }
};

export const PlaneGeometry = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }
};

export const CanvasTexture = class {
  constructor(canvas) {
    this.canvas = canvas;
    this.colorSpace = '';
  }
  dispose() {}
};

export const Sprite = class {
  constructor(material) {
    this.material = material;
    this.position = new Vector3();
    this.scale = new Vector3(1, 1, 1);
    this.visible = true;
    this.isSprite = true;   // dc-presence's teardown branches on this
    this.parent = null;
  }
};

export const SpriteMaterial = class {
  constructor(opts = {}) {
    this.map = opts.map || null;
    this.transparent = opts.transparent ?? true;
    this.depthTest = opts.depthTest ?? true;
    this.disposed = false;
  }
  dispose() { this.disposed = true; }
};

// NOTE: CanvasTexture is declared once, above. A second `export const CanvasTexture`
// used to live here, which made this whole stub fail to parse
// ("Identifier 'CanvasTexture' has already been declared") and took every test that
// imports it down with it. Keep exports unique.
