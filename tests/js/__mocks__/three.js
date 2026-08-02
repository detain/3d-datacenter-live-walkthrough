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
  // Was a no-op: returned this without modifying x/y/z. Every test that verified
  // addScaledVector was called would pass even when the result was mathematically wrong.
  addScaledVector( v, s ) {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  // Was a no-op: returned this without normalizing. The camera direction vector was
  // always (1,1,1) magnitude, so lerp targets in dc-multi.js were never reached and
  // the camera would not settle — the test assertions passed only because the value
  // never changed from its initial state.
  normalize() {
    const l = Math.sqrt( this.x * this.x + this.y * this.y + this.z * this.z );
    if ( l > 0 ) { this.x /= l; this.y /= l; this.z /= l; }
    return this;
  }
  // Was a no-op: returned this without interpolating. Camera smooth-follow tests
  // would pass because the target vector was already at its final value — the lerp
  // simply never moved it and the test never caught that.
  lerp( v, alpha ) {
    this.x += ( v.x - this.x ) * alpha;
    this.y += ( v.y - this.y ) * alpha;
    this.z += ( v.z - this.z ) * alpha;
    return this;
  }
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
  // Was a no-op: returned this without computing angles. Camera yaw (y-rotation) in
  // dc-multi.js:350 was always 0 under test, so every test that checked the rendered
  // angle was comparing against a fake zero value — a real quaternion like (0,sin(45°),0,cos(45°))
  // yielded y=0 instead of y=π/4 and the auto-scale at box center was never validated.
  setFromQuaternion( q, order = 'XYZ' ) {
    // Only the 'YXZ' order is implemented, because that is the only order the code
    // under test uses (dc-multi.js line 350 reads camera yaw with "YXZ").
    const x = q.x || 0, y = q.y || 0, z = q.z || 0, w = q.w === undefined ? 1 : q.w;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    // rotation matrix elements we need
    const m12 = yz - wx;
    const m22 = 1 - ( xx + zz );
    const m02 = xz + wy;
    const m11 = 1 - ( xx + yy ); // unused but kept for clarity
    const m10 = xy + wz;         // unused but kept for clarity
    const clamp = ( v ) => Math.max( -1, Math.min( 1, v ) );
    this.x = Math.asin( -clamp( m12 ) );
    if ( Math.abs( m12 ) < 0.9999999 ) {
      this.y = Math.atan2( m02, m22 );
      this.z = Math.atan2( xy + wz, 1 - ( xx + zz ) === 0 ? 1 : ( 1 - ( xx + zz ) ) );
    } else {
      this.y = Math.atan2( -( xz - wy ), 1 - ( yy + zz ) );
      this.z = 0;
    }
    this.order = order;
    return this;
  }
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
  constructor() {
    this._uncachedActions = [];
  }
  clipAction() { return new AnimationAction(); }
  stopAllAction() {}
  uncacheRoot() {}
  uncacheAction(clip) {
    if (clip) this._uncachedActions.push(clip);
  }
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
  constructor() {
    this.min = { x: 0, y: 0, z: 0 };
    this.max = { x: 1, y: 1, z: 1 };
  }
  // Was a no-op: it always set min.y=0 and max.y=1 regardless of the object's geometry,
  // so every model measured exactly 1 unit tall. The auto-scale maths in dc-multi.js
  // that divides by model height to fill the viewport could never be tested — the scale
  // factor was always 1 and the code path that handles non-unit models was never exercised.
  setFromObject( object ) {
    // Real three.js walks the object's geometry. The stub cannot, so it honours an
    // explicit userData.__testBounds when a test supplies one, and otherwise falls back
    // to a unit box. Without this every model measured exactly 1 unit tall and the
    // auto-scale maths in dc-multi.js could not be tested.
    const b = object && object.userData && object.userData.__testBounds;
    if ( b ) {
      this.min.x = b.min.x; this.min.y = b.min.y; this.min.z = b.min.z;
      this.max.x = b.max.x; this.max.y = b.max.y; this.max.z = b.max.z;
      return this;
    }
    this.min.x = 0; this.min.y = 0; this.min.z = 0;
    this.max.x = 1; this.max.y = 1; this.max.z = 1;
    return this;
  }
};

export const SRGBColorSpace = 'srgb';
// Real three.js uses 2 for DoubleSide. dc-multi.js:573 and :609 set side: THREE.DoubleSide,
// which was undefined under test and caused the material side to be falsy, masking that
// double-sided rendering was never actually verified.
export const DoubleSide = 2;

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
