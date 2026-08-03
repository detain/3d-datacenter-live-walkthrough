// dc-multi.js — third-person player overlay for the datacenter walkthrough.
//
// Loaded AFTER dc.js (which builds the whole datacenter and exposes window.DC).
// This module adds a Mixamo character with animations and a first-person <-> third-person
// camera toggle, WITHOUT forking dc.js: it reuses DC.scene/camera/renderer/controls and the
// movement helpers exposed on window.DC (collidesAt, playerRadius, eyeHeight, roomSpawn...),
// and takes over the render loop so it can drive the player + animation mixer each frame.
//
// Assets come from the Mixamo downloader's manifest at /images/3d/mixamo/manifest.json
// (characters[].model is a skinned GLB; characters[].animations[].clip is a clip-only GLB
// retargeted to that character's skeleton).

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

const MANIFEST_URL = window.DC_MANIFEST_URL || "/images/3d/mixamo/manifest.json";

// Camera collision cache — avoids re-running the expensive collision loop when player hasn't moved (Fix 6)
// Includes camera direction to skip re-computation during mouse-look rotation (Fix 9)
let _lastSafeDist = 11;  // RESULT of the last ray-march (may be < camDist when something blocks)
let _lastCamDist = null; // the camDist that march was run FOR — see the cache guard below
const _lastPlayerPos = new THREE.Vector3();
let _lastCollisionCamPos = null;  // "x,z" rounded to 1 decimal
let _lastCollisionCamDir = null;  // "x,y,z" rounded to 1 decimal (camera world direction)
// Logo and glass material caches (Fix 15, Fix 16)
let _cachedLogoTexture = null;
let _cachedGlassMaterial = null;

let pixelScale = 0.8;  // last value this module asked for; the authority is DC.S.pixelScale

/**
 * Pixel scale setter — DELEGATES to dc.js, which owns the renderer.
 *
 * This module's `S` and dc.js's `S` are different objects with the same name. Writing the scale
 * into the local one (as this used to) left dc.js's S.pixelScale at its 1.0 default, so the
 * third-person overlay booted at 0.8 and then the first window resize — which goes through
 * dc.js's own pixel-ratio path — silently restored full resolution. That is F-10, and it was
 * never fixed. The formula also differed between the two files; there is now one.
 */
function setPixelScale(v) {
    if (S.DC && typeof S.DC.setPixelScale === 'function') {
        pixelScale = S.DC.setPixelScale(v);
    } else {
        // dc.js not up yet (or a test harness without it): clamp locally and let the value be
        // re-applied when the scene attaches.
        pixelScale = Math.min(Math.max(Number(v) || 1, 0.5), 1.0);
    }
    S.pixelScale = pixelScale;
}

const S = {
  DC: null, scene: null, camera: null, renderer: null, controls: null, options: null,
  loader: new GLTFLoader(),
  prevT: performance.now(),
  manifest: null,
  player: new THREE.Group(),      // ground anchor; holds the model
  model: null,                    // the loaded SkinnedMesh root
  mixer: null,
  actions: {},                    // label -> AnimationAction
  current: null,                  // currently playing label
  modelHeight: 16,                // scene units (set on load)
  mode: "third",                  // "first" | "third"
  vy: 0,                          // vertical velocity (jump)
  grounded: true,
  facing: 0,                      // character yaw (radians)
  gestureUntil: 0,                // ms timestamp; while > now a gesture overrides locomotion
  spawned: false,
  // Last camera position WE set (placeCamera/trySpawn). Lets syncPlayerFromCamera tell a plain re-lock
  // (camera still ours -> keep the character put) from a lock out of the idle demo (camera hijacked by
  // dc.js's view presets -> the character must not be teleported there).
  camPlaced: new THREE.Vector3(),
  camPlacedValid: false,
  camDist: 11,                    // third-person follow distance (scene units)
  pixelScale,                     // exposed for GUI control
  fov: 75,                        // camera field of view (degrees), adjustable via GUI
  // Presence update deduplication — only send DC_PRESENCE_MOVE when position or facing changes
  _lastPresenceX: null,
  _lastPresenceZ: null,
  _lastPresenceF: null,
};

// movement tuning (scene units/sec). dc.js's own walk terminal speed is ~40 u/s; match-ish.
// WALK/RUN are exposed via GUI sliders and update the module-level vars.
let WALK = 14, RUN = 34;
const RUN_THRESH = 22, GRAVITY = 980, JUMP_V = 130, EYE_FRAC = 0.94;
const G_PER_MS2 = 100;   // scene gravity units per 1 m/s²  (so 9.8 m/s² -> 980 = the Earth default)
// Mouse-wheel camera dolly. Scroll out: the camera pulls back AND up together up to CAM_MAX; scroll
// in: it comes closer until it crosses CAM_MIN ("inside the body"), then snaps to first-person.
// From first-person, scrolling out pops straight back to third-person just outside the body; scrolling
// further in (first-person) or further out (already at CAM_MAX) does nothing -> hard limits both ends.
const CAM_MIN = 4.5;        // closest third-person follow distance; below this -> first person
const CAM_MAX = 62;         // farthest follow distance (high + far, ~a few char-heights up)
const CAM_UP_RATIO = 0.45;  // camera also rises this fraction of the follow distance (back AND up)
const WHEEL_STEP = 5;       // follow-distance change per wheel notch
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _head = new THREE.Vector3();
const _camTarget = new THREE.Vector3();

function log(...a) { console.log("[dc-multi]", ...a); }

// ---------------------------------------------------------------- bootstrap
/**
 * Wait for the DC (datacenter) scene to be fully initialized before calling callback.
 * Polls every 80ms for up to `timeoutMs` milliseconds. If timeout is reached without
 * all DC properties being available, logs an error and does not call the callback.
 *
 * @param {function()} cb - Called when DC.scene, DC.camera, DC.renderer, DC.controls, and DC.options are all truthy
 * @param {number} [timeoutMs=15000] - Maximum milliseconds to wait before giving up
 */
function whenReady(cb, timeoutMs = 15000) {
  const start = performance.now();
  const tick = () => {
    if (window.DC && DC.scene && DC.camera && DC.renderer && DC.controls && DC.options) cb();
    else if (performance.now() - start > timeoutMs) {
      console.error(`[dc-multi] whenReady timeout - DC not initialized after ${timeoutMs}ms`);
    } else setTimeout(tick, 80);
  };
  tick();
}

whenReady(async () => {
  S.DC = window.DC;
  S.scene = DC.scene; S.camera = DC.camera; S.renderer = DC.renderer;
  S.controls = DC.controls; S.options = DC.options;
  S.scene.add(S.player);
  // Draco decoder so the optimized (Draco-compressed) character GLBs load
  const _draco = new DRACOLoader(); _draco.setDecoderPath('/lib/three/examples/jsm/libs/draco/');
  S.loader.setDRACOLoader(_draco);
  // render at a slightly lower internal resolution for FPS headroom (the datacenter is fill-heavy)
  // pixelScale factor is adjustable via GUI (0.3–1.0): balances visual quality vs FPS on GPU-limited frames
  setPixelScale(S.pixelScale);
  S.renderer.setSize(window.innerWidth, window.innerHeight);

  try {
    const res = await fetch(MANIFEST_URL, { cache: "default" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${MANIFEST_URL}`);
    S.manifest = await res.json();
  } catch (e) {
    console.warn('[dc-multi] manifest unavailable (may be normal on first load):', e.message);
  }

  if (!S.manifest || !S.manifest.characters || !S.manifest.characters.length) {
    log("no manifest/characters yet at", MANIFEST_URL, "- run the downloader's `batch` command.");
    hud("No character assets yet — run the Mixamo downloader (batch).");
  } else {
    populateCharacterPicker();
    const startId = new URLSearchParams(location.search).get("char");
    // ?char=<id|name> pins a character; otherwise pick a RANDOM one each load.
    const ch = (startId && S.manifest.characters.find(c => c.id === startId || c.name === startId))
      || S.manifest.characters[Math.floor(Math.random() * S.manifest.characters.length)];
    await loadCharacter(ch);
  }

  setupInput();
  applyMode();                                    // sets visibility for the starting mode
  // Re-sync the player anchor whenever pointer-lock engages (dc may have re-spawned the camera),
  // then re-announce presence: the matching "unlock" handler sends dc.presence.leave.
  const _onLock = () => { syncPlayerFromCamera(); announcePresence(); };
  S.controls.addEventListener("lock", _onLock);

  // CRIT-2: Store handler references so they can be removed on cleanup
  const _onUnlock = () => {
    if (typeof window.DC_PRESENCE_LEAVE === 'function') window.DC_PRESENCE_LEAVE();
  };
  /**
   * dc:respawn event handler.
   * Expected detail shape: { x: number, z: number }
   * Both coordinates are required — handler returns early if either is missing.
   */
  const _onRespawn = (e) => {
    const d = (e && e.detail) || {};
    if (typeof d.x !== 'number' || typeof d.z !== 'number') return;
    S.player.position.set(d.x, 0, d.z);
    S.vy = 0; S.spawned = true;
    // BUG-4: Repopulate character picker in case manifest was reloaded
    if (S.manifest && S.manifest.characters && S.manifest.characters.length) {
        populateCharacterPicker();
    }
    // dc.js fires dc:respawn from spawnInside(), which on a LOCATION SWITCH runs after
    // clearScene() has already called DC_PRESENCE_LEAVE() — so the hub thinks we left and
    // ignores the moves the frame loop then sends: we silently vanish from every other
    // client until the next pointer re-lock. Re-announcing here restores us, and because
    // buildRoom() has just repopulated DC.roomBounds the fresh join carries the new room's
    // BOT-BOUNDS. dc-presence latches the join, so on the initial load (where we are still
    // joined) this degrades to a corrective move rather than a second join.
    announcePresence();
  };
  const _onDisconnected = () => { window.DC_PRESENCE_ENABLED = false; };
  const _onAuthFailure = () => { window.DC_PRESENCE_ENABLED = false; };
  // Auth just succeeded. dc-presence joins on this same event and reads our live pose
  // back through window.DCM, so re-announcing here is normally a no-op — it only
  // matters when this overlay spawned the player BEFORE auth completed, in which case
  // dc-presence turns the second call into a dc.presence.move correction. Exactly one
  // dc.presence.join is sent either way (dc-presence latches it).
  const _onAuthSuccess = () => { window.DC_PRESENCE_ENABLED = true; announcePresence(); };
  const _onContextLost = () => { log('GPU context lost'); };
  const _onContextRestored = () => {
    log('GPU context restored — player state may need refresh');
    // If player was visible, trigger respawn to sync position (MAJOR-9)
    if (S.player && S.spawned) {
      trySpawn(S.player.position.x, S.player.position.z, S.facing);
    }
  };

  S.controls.addEventListener("unlock", _onUnlock);
  // dc.js re-spawns the camera on its own (lock from a demo view, location switch). Follow it so the
  // character never gets left behind in the previous room.
  document.addEventListener('dc:respawn', _onRespawn);
  // Take over the loop: drive the player, then let dc render (flyTo + highlight + labels + render).
  if (S.DC.setAnimationLoop) S.DC.setAnimationLoop(frame);
  exposeDebug();
  log("overlay active. mode =", S.mode);

  // CRIT-2: Remove all event listeners on page close/navigate to prevent memory leaks (bfcache)
  const cleanup = () => {
    S.controls.removeEventListener("lock", _onLock);
    S.controls.removeEventListener("unlock", _onUnlock);
    document.removeEventListener('dc:respawn', _onRespawn);
    document.removeEventListener('dc:disconnected', _onDisconnected);
    document.removeEventListener('dc:auth-failure', _onAuthFailure);
    document.removeEventListener('dc:auth-success', _onAuthSuccess);
    document.removeEventListener('dc:context-lost', _onContextLost);
    document.removeEventListener('dc:context-restored', _onContextRestored);
    // CRIT-2: cleanup setupInput() listeners
    document.removeEventListener("keydown", _onKeyDown);
    document.removeEventListener("keyup", _onKeyUp);
    document.removeEventListener("wheel", onWheel, { passive: false });
    if (S._dcPersonBtn) S._dcPersonBtn.removeEventListener("click", _onBtnClick);
    if (S._dcCharSel) S._dcCharSel.removeEventListener("change", _onCharChange);
    if (_cachedLogoTexture) { _cachedLogoTexture.dispose(); _cachedLogoTexture = null; }
    if (_cachedGlassMaterial) { _cachedGlassMaterial.dispose(); _cachedGlassMaterial = null; }
    if (_hudEl && _hudEl.parentNode) { _hudEl.parentNode.removeChild(_hudEl); _hudEl = null; }
  };
  window.addEventListener('beforeunload', cleanup);
  // Disable presence on disconnect/auth-failure; re-enabled on auth-success (MAJOR-6)
  document.addEventListener('dc:disconnected', _onDisconnected);
  document.addEventListener('dc:auth-failure', _onAuthFailure);
  document.addEventListener('dc:auth-success', _onAuthSuccess);

  // IDEA-2: Context loss handling (IDEA-2)
  document.addEventListener('dc:context-lost', _onContextLost);
  document.addEventListener('dc:context-restored', _onContextRestored);
});

/**
 * Load animation clips with a bounded number of requests in flight.
 *
 * The previous code fired every clip request in a single tick with no limit. Even after
 * filtering to playable labels that is ~25 simultaneous fetches competing with the rack
 * and server GLB loads and the inventory JSON, on a page whose whole problem is boot
 * time. Four at a time keeps the connection busy without starving the rest of the boot.
 *
 * @param {Array<Object>} clips   manifest entries, each with .clip (url) and .label
 * @param {string} cacheBuster    query string appended to each url (may be '')
 * @param {THREE.AnimationMixer} myMixer  the mixer that owned the character when the
 *        load started; a late clip must not attach to a different character
 * @param {number} limit          maximum requests in flight
 * @returns {Promise<void>} resolves when every clip has settled (success or failure)
 */
async function loadClipsPooled(clips, cacheBuster, myMixer, limit = 4) {
  const queue = clips.slice();
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      try {
        const ag = await S.loader.loadAsync(a.clip + cacheBuster);
        if (S.mixer !== myMixer) return;
        const clip = ag.animations && ag.animations[0];
        if (clip) S.actions[a.label || clip.name] = makeAction(clip, a);
      } catch (e) {
        log('failed clip', a.clip, e);
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, clips.length); i++) workers.push(worker());
  await Promise.all(workers);
}

// ---------------------------------------------------------------- character
async function loadCharacter(ch) {
  S.loadedCharId = ch.id;                           // remembered for the (deferred) GUI dropdown default
  if (S.charProxy) S.charProxy.character = ch.id;   // keep the GUI 'Character' dropdown in sync
  // tear down a previous model — dispose geometry, materials, and textures to prevent GPU memory leaks
  if (S.model) {
    S.player.remove(S.model);
    S.model.traverse(o => {
      if (o.geometry) { o.geometry.dispose(); }
      // A SkinnedMesh's Skeleton owns a bone TEXTURE (the per-bone matrix data three.js uploads
      // each frame). Nothing in the material walk below reaches it, so every character switch
      // leaked one bone texture — on a rig with hundreds of bones that is the largest single
      // allocation in the teardown.
      if (o.isSkinnedMesh && o.skeleton && typeof o.skeleton.dispose === 'function') {
        o.skeleton.dispose();
      }
      if (o.isMesh || o.isSkinnedMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => {
          if (!m) return;
          // Duck-type every texture-valued property instead of naming `.map` alone. Mixamo
          // characters ship normalMap / roughnessMap / metalnessMap / aoMap / emissiveMap, and
          // disposing only `.map` leaked all of them, on every switch, for the life of the tab.
          // `'minFilter' in value` is the cheapest reliable Texture marker — every three.js
          // Texture has it and nothing else on a material does.
          for (const key of Object.keys(m)) {
            const value = m[key];
            if (value && typeof value === 'object' && 'minFilter' in value
                && typeof value.dispose === 'function') {
              value.dispose();
            }
          }
          m.dispose();
        });
      }
    });
  }
  // Preserve old actions for proper mixer cleanup (must happen before S.actions is cleared)
  const oldActions = S.actions;
  S.actions = {}; S.current = null;
  if (S.mixer) {
    S.mixer.stopAllAction();
    // F-14: uncache all previously-cached actions from the old mixer to prevent memory leak.
    // stopAllAction() halts animations but does not release AnimationClip data cached in the mixer.
    for (const action of Object.values(oldActions)) {
      if (action && typeof action.getClip === 'function') {
        const clip = action.getClip();
        if (clip) S.mixer.uncacheAction(clip);
      }
    }
    if (S.model) S.mixer.uncacheRoot(S.model);
    S.mixer = null;
  }
  S.model = null;
  S.modelLoadFailed = false;
  S.headBone = null;

  log("loading character", ch.name, ch.model);
  const cb = (S.manifest && S.manifest.generated_at) ? ('?m=' + encodeURIComponent(S.manifest.generated_at)) : '';
  hud("Loading character...");
  try {
    var gltf = await S.loader.loadAsync(ch.model + cb);
  } catch (e) {
    S.modelLoadFailed = true;
    console.error("[dc-multi] model load failed:", e);
    hud("Character model failed to load — movement enabled without character");
    return;
  }
  hud("");
  const root = gltf.scene;
  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = true; } }); // Step 7.2: player benefits from frustum culling

  // scale so the model's height matches the player's configured height in scene units
  const box = new THREE.Box3().setFromObject(root);
  const h = Math.max(0.001, box.max.y - box.min.y);
  const targetH = (S.DC.eyeHeight ? S.DC.eyeHeight() : 15) / EYE_FRAC;
  const scale = targetH / h;
  root.scale.setScalar(scale);
  root.position.y = -box.min.y * scale;            // feet on the group's origin (y = 0)
  S.modelHeight = targetH;
  S.player.add(root);
  S.model = root;
  // Find the head bone so first-person can collapse it: the camera sits inside the head, so hiding the
  // head stops it catching the skull's inner faces. Mixamo names it ".../Head" (Neck / HeadTop_End excluded).
  S.headBone = null;
  root.traverse((o) => { if (!S.headBone && /head$/i.test(o.name)) S.headBone = o; });

  S.mixer = new THREE.AnimationMixer(root);
  // idle = the base GLB's own clip (the base was exported with the Idle motion + skin)
  if (gltf.animations && gltf.animations.length) S.actions.idle = makeAction(gltf.animations[0]);

  // Play idle IMMEDIATELY (the character appears after just its skinned GLB), then stream the clip-only
  // animation GLBs in the BACKGROUND so page load isn't blocked on all of them. Guard against a
  // character switch mid-load: a late clip must not attach to a different character's mixer.
  if (S.actions.idle) play("idle", 0);
  const myMixer = S.mixer;
  const allClips = ch.animations || [];
  const playable = allClips.filter((a) => a && a.label && PLAYABLE_LABELS.has(a.label));
  if (allClips.length !== playable.length) {
    log('character', ch.name, '— loading', playable.length, 'playable clips of', allClips.length, 'in the manifest');
  }
  if (playable.length === 0 && allClips.length > 0) {
    console.warn('[dc-multi] character', ch.name, 'has', allClips.length, 'clips but none carry a playable label — only idle will work');
  }
  // Deliberately not awaited: the character appears as soon as its skinned base GLB is
  // in, and the gesture clips stream in behind it.
  loadClipsPooled(playable, cb, myMixer, 4);
}

function makeAction(clip, meta) {
  const act = S.mixer.clipAction(clip);
  act.enabled = true;
  act.setEffectiveWeight(1);
  act.clampWhenFinished = true;
  act.userData = meta || {};
  return act;
}

function play(label, fade = 0.2) {
  if (!label || !S.actions[label] || S.current === label) return;
  const next = S.actions[label];
  const prev = S.current && S.actions[S.current];
  next.reset();
  next.setLoop(label === "jump" ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
  next.fadeIn(fade).play();
  if (prev && prev !== next) prev.fadeOut(fade);
  S.current = label;
}

// ---------------------------------------------------------------- per-frame
function frame() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - S.prevT) / 1000);
  S.prevT = now;
  if (!S.spawned) trySpawn();
  const _room = S.DC.objects && S.DC.objects.room;
  if (_room && _room.walls && (!S.door || S.door.roomGroup !== _room.group)) {
    try { buildDoor(); }
    catch (e) {
      console.error('[dc-multi] buildDoor failed:', e);
      const b = S.DC.roomBounds || { minX: 0, maxX: 0, maxZ: 0 };
      S.door = { roomGroup: _room.group, broken: true, openAmt: 0, cx: (b.minX + b.maxX) / 2, maxZ: b.maxZ, halfW: 4.5 };
    }
  }
  if (S.door && !S.door.broken) updateDoor(dt);

  // camera yaw/pitch come from PointerLockControls (mouse look)
  _euler.setFromQuaternion(S.camera.quaternion, "YXZ");
  const yaw = _euler.y;
  _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));     // ground-projected look forward
  _right.set(Math.cos(yaw), 0, -Math.sin(yaw));

  const o = S.options;
  const f = (o.moveForward ? 1 : 0) - (o.moveBackward ? 1 : 0);
  const r = (o.moveRight ? 1 : 0) - (o.moveLeft ? 1 : 0);
  _move.set(0, 0, 0).addScaledVector(_fwd, f).addScaledVector(_right, r);
  const moving = _move.lengthSq() > 1e-4;
  if (moving) _move.normalize();

  const speed = (o.runFast ? RUN : WALK);
  const rad = S.DC.playerRadius ? S.DC.playerRadius() : 1.0;

  // feed the LOD manager the player's ground position so neighbours swap to full models as you approach
  if (S.DC.setLodFocus) S.DC.setLodFocus(S.player.position.x, S.player.position.z);

  // horizontal move with per-axis collision. DC.collideWorld covers EVERY building's walls (door gaps
  // open), the current building's racks, and each neighbour's active interior (blocks, or full racks
  // once swapped) — so you can leave, cross the streets, and walk into another building. The current
  // building's openable front door is the one exception: its gap is always-open in collideWorld, so we
  // re-close it here while the door is shut. Movement is SKIPPED when the model is not yet loaded to
  // prevent position desync (player's accumulated movement would otherwise "teleport" the model when
  // it finally appears).
  if (moving && !S.model && !S.modelLoadFailed) {
    /* model still streaming in — hold position so it doesn't pop in mid-stride */
  } else if (moving) {
    const world = S.DC.collideWorld;
    const blocked = (bx, bz) => {
      if (currentDoorShutBlocks(bx, bz, rad)) return true;
      return world ? world(bx, bz, rad) : wallBlocked(bx, bz, rad);
    };
    const nx = S.player.position.x + _move.x * speed * dt;
    const nz = S.player.position.z + _move.z * speed * dt;
    if (!blocked(nx, S.player.position.z)) S.player.position.x = nx;
    if (!blocked(S.player.position.x, nz)) S.player.position.z = nz;
  }

  // gravity + jump (gravity comes from the shared lil-gui slider: options.gravityMs2)
  S.vy -= (S.options.gravityMs2 || 9.8) * G_PER_MS2 * dt;
  S.player.position.y += S.vy * dt;
  if (S.player.position.y <= 0) { S.player.position.y = 0; S.vy = 0; S.grounded = true; }
  else S.grounded = false;

  // character facing follows movement (third-person); smooth turn
  if (moving) {
    const target = Math.atan2(_move.x, _move.z);     // model faces +Z by default
    S.facing = lerpAngle(S.facing, target, Math.min(1, dt * 10));
    if (S.model) S.player.rotation.y = S.facing;
  }

  // Throttled presence update — only send when position or facing actually changes
  if (typeof window.DC_PRESENCE_MOVE === 'function' && window.DC_PRESENCE_ENABLED !== false) {
    if (S.model && !S.modelLoadFailed) {
      const px = S.player.position.x, pz = S.player.position.z, f = S.facing;
      // Rounded comparison to avoid floating-point noise triggering updates
      const kx = px.toFixed(2), kz = pz.toFixed(2), kf = f.toFixed(3);
      if (kx !== S._lastPresenceX || kz !== S._lastPresenceZ || kf !== S._lastPresenceF) {
        S._lastPresenceX = kx; S._lastPresenceZ = kz; S._lastPresenceF = kf;
        window.DC_PRESENCE_MOVE(px, pz, f);
      }
    }
  }

  chooseAnimation(moving, speed);
  if (S.mixer) S.mixer.update(dt);

  // Only drive the player camera while actually playing (pointer locked). When the "click to enable"
  // prompt is up (not locked), let dc.js's idle view-cycling glide the camera (attract mode) and hide
  // the character so it doesn't sit in the demo shots.
  if (S.controls.isLocked) placeCamera();
  else if (S.model) S.model.visible = false;
  // hand off to dc.js for fly-to glide, look-highlight, label culling, and the actual render
  if (S.DC.tick) S.DC.tick(dt); else S.renderer.render(S.scene, S.camera);
}

function chooseAnimation(moving, speed) {
  const now = performance.now();
  if (!S.grounded && S.actions.jump) { play("jump", 0.12); return; }
  if (now < S.gestureUntil) return;                 // a gesture is overriding locomotion
  if (moving) play(speed >= RUN_THRESH && S.actions.run ? "run" : (S.actions.walk ? "walk" : "idle"), 0.18);
  else play("idle", 0.25);
}

function placeCamera() {
  const eye = (S.DC.eyeHeight ? S.DC.eyeHeight() : 15);
  if (S.mode === "first") {
    // eyes at the player position; PointerLockControls owns the orientation. Keep the body VISIBLE so you
    // can glance down at your hands/torso and see gestures play, and turn the body to face wherever you're
    // looking. Collapse the head bone to ~0 so the camera (which sits inside the head) doesn't catch the
    // skull's inner faces. mixer.update() ran already this frame and only drives rotation, so this sticks.
    S.camera.position.set(S.player.position.x, S.player.position.y + eye, S.player.position.z);
    if (S.model) {
      S.model.visible = true;
      S.camera.getWorldDirection(_dir);
      if (Math.hypot(_dir.x, _dir.z) > 0.05) S.facing = S.player.rotation.y = Math.atan2(_dir.x, _dir.z);
    }
    if (S.headBone) S.headBone.scale.setScalar(1e-4);
    S.camPlaced.copy(S.camera.position);
    S.camPlacedValid = true;
    return;
  }
  // third person: orbit behind the player along the current look direction
  if (S.model) S.model.visible = true;
  if (S.headBone) S.headBone.scale.setScalar(1);        // restore the head (collapsed in first-person)
  _head.set(S.player.position.x, S.player.position.y + eye * 0.95, S.player.position.z);
  S.camera.getWorldDirection(_dir).normalize();      // current mouse-look direction
  // pull the camera in if a rack/wall is between head and the ideal position (any building's, now)
  // Skip expensive collision loop if player hasn't moved, camera hasn't rotated, and camDist unchanged (Fix 6, Fix 9)
  const _posKey = S.player.position.x.toFixed(1) + ',' + S.player.position.z.toFixed(1);
  const _camDirKey = Math.round(_dir.x * 20) + ',' + Math.round(_dir.y * 20) + ',' + Math.round(_dir.z * 20);
  let dist;
  const playerMoved = (
    _lastPlayerPos.x.toFixed(1) !== S.player.position.x.toFixed(1) ||
    _lastPlayerPos.z.toFixed(1) !== S.player.position.z.toFixed(1)
  );
  // The last term used to be `S.camDist === _lastSafeDist`, which compares the TARGET distance
  // against the RESULT of the march. Those are only equal when the previous frame found nothing
  // blocking — so indoors, where there is always a rack or a wall behind you, the cache could
  // never hit and the full ray-march ran every single frame. Compare against the camDist the
  // march was actually run for instead.
  if (!playerMoved && _posKey === _lastCollisionCamPos && _camDirKey === _lastCollisionCamDir && S.camDist === _lastCamDist) {
    dist = _lastSafeDist;
  } else {
    dist = S.camDist;
    const collide = S.DC.collideWorld || S.DC.collidesAt, rad = (S.DC.playerRadius ? S.DC.playerRadius() : 1.0);
    if (collide) {
      // collideWorld deliberately leaves the front doorway GAP open so you can walk out. That means a
      // player standing in the doorway had nothing to stop the camera reeling back THROUGH the shut
      // door — it ended up outside the building staring at the door, which reads as "clicking did
      // nothing". Block on the shut door and on leaving the room, exactly like movement does.
      const inside = insideRoom(S.player.position.x, S.player.position.z, 0);
      for (let d = 2; d <= S.camDist; d += 1.5) {
        const cx = _head.x - _dir.x * d, cz = _head.z - _dir.z * d;
        // MAJOR-11: Camera uses 60% radius for clearance — player uses full radius for movement collision
        if (collide(cx, cz, rad * 0.6)
          || currentDoorShutBlocks(cx, cz, rad * 0.6)
          || (inside && !insideRoom(cx, cz, rad * 0.6))) { dist = Math.max(2.5, d - 1.5); break; }
      }
    }
    _lastSafeDist = dist;
    _lastCamDist = S.camDist;
    _lastPlayerPos.copy(S.player.position);
    _lastCollisionCamPos = _posKey;
    _lastCollisionCamDir = _camDirKey;
  }
  // Position the camera `dist` behind the head ALONG the current view direction, so the head
  // sits at screen-centre. Do NOT lookAt() — orientation is owned by PointerLockControls (the
  // mouse). Repositioning from the look dir AND calling lookAt creates a feedback loop that
  // spirals the camera to straight-overhead, so we only move position here.
  // Pull back along the view dir, and ALSO rise with distance so zooming out lifts to a high/far view.
  _camTarget.set(_head.x - _dir.x * dist, _head.y - _dir.y * dist + dist * CAM_UP_RATIO, _head.z - _dir.z * dist);
  S.camera.position.lerp(_camTarget, 0.3);
  S.camPlaced.copy(S.camera.position);   // remember it's ours, so a re-lock doesn't respawn the player
  S.camPlacedValid = true;
}

// ---------------------------------------------------------------- presence
// Announce the player's REAL pose to dc-presence. This is the ONLY place this module
// starts a presence announcement, and dc-presence latches it so exactly one
// dc.presence.join goes out per authenticated session (later calls with different
// coordinates become dc.presence.move corrections). Safe to call at any time: it
// no-ops when presence is disabled, dc-presence is absent, or we have not spawned.
function announcePresence() {
  if (typeof window.DC_PRESENCE_JOIN !== 'function') return;
  if (window.DC_PRESENCE_ENABLED === false) return;
  if (!S.spawned || !S.player) return;
  // Let the throttled per-frame update fire again straight away so the hub gets a
  // fresh position right after a (re-)join.
  S._lastPresenceX = S._lastPresenceZ = S._lastPresenceF = null;
  window.DC_PRESENCE_JOIN(S.player.position.x, S.player.position.z, S.facing);
}

// ---------------------------------------------------------------- helpers
// The current building's fancy double door. DC.collideWorld leaves its doorway GAP open at all times, so
// while the door is shut we re-block that gap here (this is what makes the closed door solid; once it
// swings open the gap is a clear passage). Broken-door fallback leaves it open so a door bug can't trap
// you indoors. Returns true = blocked.
function currentDoorShutBlocks(x, z, r) {
  const d = S.door, rb = S.DC.roomBounds;
  if (!d || !rb || d.broken || d.openAmt > 0.4) return false;
  return Math.abs(x - d.cx) <= d.halfW + r && Math.abs(z - rb.maxZ) <= 2.2;
}

// Fallback room/front-door collision, used only if DC.collideWorld is unavailable (older dc.js). Blocks
// the four walls, carves out the doorway when the double door is open, and lets you roam a patio outside.
function wallBlocked(x, z, r) {
  const b = S.DC.roomBounds; if (!b) return false;
  const d = S.door;
  const cx = d ? d.cx : (b.minX + b.maxX) / 2;
  const hw = d ? d.halfW : 4.5;
  const open = !!(d && d.openAmt > 0.4);
  const inDoorX = Math.abs(x - cx) <= hw - r * 0.5;
  if (z > b.maxZ) {                                  // outside the building -> open grounds you can roam
    if (z > b.maxZ + 130) return true;               // far edge of the grounds
    if (x < cx - 95 || x > cx + 95) return true;     // grounds width
    return false;                                    // once you're outside, the door state no longer gates you
  }
  if (x < b.minX + r || x > b.maxX - r) return true; // side walls
  if (z < b.minZ + r) return true;                   // rear wall
  if (z > b.maxZ - r) return !(open && inDoorX);     // front wall — pass only through the open door
  return false;
}

// InterServer "iS" mark on a transparent canvas: orange i-stem + blue square dot + blue swoosh S.
// Cached after first creation (Fix 15)
function makeLogoTexture() {
  if (_cachedLogoTexture) return _cachedLogoTexture;
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), blue = '#2E8BCE', orange = '#F39019';
  g.fillStyle = orange; g.fillRect(s * 0.20, s * 0.30, s * 0.075, s * 0.55);   // i stem
  g.fillStyle = blue;   g.fillRect(s * 0.19, s * 0.14, s * 0.095, s * 0.095);  // i dot
  g.strokeStyle = blue; g.lineWidth = s * 0.085; g.lineCap = 'round'; g.beginPath();
  g.moveTo(s * 0.80, s * 0.27);
  g.bezierCurveTo(s * 0.46, s * 0.13, s * 0.40, s * 0.45, s * 0.62, s * 0.52);
  g.bezierCurveTo(s * 0.86, s * 0.60, s * 0.72, s * 0.92, s * 0.34, s * 0.78);
  g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  _cachedLogoTexture = t;
  return t;
}

// Glass material for the door — cached since appearance is constant (Fix 16)
function makeGlassMaterial() {
  if (_cachedGlassMaterial) return _cachedGlassMaterial;
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x9fb6c4, metalness: 0, roughness: 0.06,
    transparent: true, opacity: 0.32, reflectivity: 0.6,
    clearcoat: 0.6, clearcoatRoughness: 0.05, side: THREE.DoubleSide
  });
  _cachedGlassMaterial = mat;
  return mat;
}

// Build a taller double glass door at the room's front doorway, hiding dc.js's plain single door.
function buildDoor() {
  const D = S.DC, b = D.roomBounds, room = D.objects && D.objects.room;
  if (!b || !room || !room.walls) return;
  if (S.door && S.door.group) S.scene.remove(S.door.group);
  const cx = (b.minX + b.maxX) / 2, maxZ = b.maxZ, HW = 8, H = 23, head = 24.43, w = HW - 0.12;
  // hide the original single door panel + the wall panel above it + the knob (all near cx, front wall)
  room.walls.traverse(o => {
    if (o.isMesh && Math.abs(o.position.x - cx) < 5.2 && Math.abs(o.position.z - maxZ) < 1.3
        && o.position.y > 0.4 && o.position.y < head + 1) o.visible = false;
  });
  const grp = new THREE.Group();
  const glassMat = makeGlassMaterial();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x20242a, metalness: 0.7, roughness: 0.4 });
  const logoTex = makeLogoTexture();
  // transom header capping the opening above the leaves (so there's no see-through slot)
  const header = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 0.3, head - H, 0.3), frameMat);
  header.position.set(cx, (H + head) / 2, maxZ); grp.add(header);
  const mkLeaf = (sign) => {                              // sign: -1 left leaf, +1 right leaf
    const pivot = new THREE.Group(); pivot.position.set(cx + sign * HW, 0, maxZ);
    const lc = -sign * w / 2;                             // pane centre, extending from hinge to mid
    const pane = new THREE.Mesh(new THREE.BoxGeometry(w, H, 0.16), glassMat); pane.position.set(lc, H / 2, 0); pivot.add(pane);
    const vB = new THREE.BoxGeometry(0.18, H, 0.22), hB = new THREE.BoxGeometry(w, 0.18, 0.22);
    [lc - w / 2, lc + w / 2].forEach(px => { const m = new THREE.Mesh(vB, frameMat); m.position.set(px, H / 2, 0); pivot.add(m); });
    [H - 0.09].forEach(py => { const m = new THREE.Mesh(hB, frameMat); m.position.set(lc, py, 0); pivot.add(m); });  // top rail only — no bottom rail, so no trip lip
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 3, 0.2), new THREE.MeshStandardMaterial({ color: 0xcfd3d8, metalness: 0.8, roughness: 0.3 }));
    handle.position.set(lc - sign * (w / 2 - 0.5), H * 0.45, 0.22); pivot.add(handle);
    // InterServer "iS" mark on BOTH faces of each leaf (so it reads from inside and outside)
    [0.1, -0.1].forEach(lz => {
      const lg = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.72, w * 0.72),
        new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
      lg.position.set(lc, H * 0.58, lz); pivot.add(lg);
    });
    grp.add(pivot); return pivot;
  };
  const left = mkLeaf(-1), right = mkLeaf(1);
  S.scene.add(grp);
  S.door = { group: grp, left, right, openAmt: 0, target: 0, lastNear: -1e9, cx, maxZ, halfW: HW, roomGroup: room.group };
  log('built double glass door at', cx.toFixed(1), maxZ.toFixed(1));
}

// Open when the player is near/in the doorway; hold open while near; swing shut 5s after they leave.
function updateDoor(dt) {
  const d = S.door; if (!d) return;
  const now = performance.now();
  const dist = Math.hypot(S.player.position.x - d.cx, S.player.position.z - d.maxZ);
  if (dist < 16) d.lastNear = now;                         // open a bit earlier as you approach
  d.target = (now - d.lastNear < 3000) ? 1 : 0;
  d.openAmt += (d.target - d.openAmt) * Math.min(1, dt * 6);  // swing faster so it's open before you reach it
  if (Math.abs(d.openAmt - d.target) < 0.002) d.openAmt = d.target;
  const a = d.openAmt * Math.PI / 2;                      // up to 90° outward (+Z, away from the room)
  d.left.rotation.y = -a; d.right.rotation.y = a;
}

function trySpawn(x, z, facing) {
  if (!S.DC.roomSpawn) { S.spawned = true; return; }
  // Use passed values or fall back to roomSpawn
  const spawnX = (x !== undefined) ? x : S.DC.roomSpawn.x;
  const spawnZ = (z !== undefined) ? z : S.DC.roomSpawn.z;
  const spawnFacing = (facing !== undefined) ? facing : Math.atan2(S.DC.roomSpawn.lookX - S.DC.roomSpawn.x, S.DC.roomSpawn.lookZ - S.DC.roomSpawn.z);
  if (S.door && S.door.group) {
    S.door.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(m => {
          // F-15: don't dispose cached/shared materials — they are reused across all doors
          // _cachedGlassMaterial is reused by every door pane; _cachedLogoTexture by every logo plane
          if (m.map && m.map !== _cachedLogoTexture) m.map.dispose();
          if (m !== _cachedGlassMaterial) m.dispose();
        });
      }
    });
    S.scene.remove(S.door.group);
  }
  S.door = null; // clear cached door on location switch (Fix 8)
  const sp = S.DC.roomSpawn;
  if (!sp) return;
  S.player.position.set(spawnX, 0, spawnZ);
  S.facing = spawnFacing;
  S.player.rotation.y = S.facing;
  // seed an over-the-shoulder third-person orientation (one-time; mouse takes over once locked)
  const eye = S.DC.eyeHeight ? S.DC.eyeHeight() : 15;
  S.camera.position.set(spawnX - Math.sin(S.facing) * S.camDist, eye * 0.95 + 3, spawnZ - Math.cos(S.facing) * S.camDist);
  S.camera.lookAt(spawnX, eye * 0.95, spawnZ);
  S.camPlaced.copy(S.camera.position);
  S.camPlacedValid = true;
  S.spawned = true;
  log("spawned player at", spawnX.toFixed(1), spawnZ.toFixed(1));
  announcePresence();
}

// Is (x,z) inside the current building's walls, with `pad` of clearance?
function insideRoom(x, z, pad) {
  const b = S.DC.roomBounds;
  if (!b) return false;
  return x - pad > b.minX && x + pad < b.maxX && z - pad > b.minZ && z + pad < b.maxZ;
}

// A spot is playable if the character fits there AND there is room behind the head for the
// third-person camera. Standing in the shut doorway satisfies the first but not the second.
function playableSpot(x, z) {
  const rad = S.DC.playerRadius ? S.DC.playerRadius() : 1.0;
  const collide = S.DC.collideWorld || S.DC.collidesAt;
  if (collide && collide(x, z, rad)) return false;
  if (currentDoorShutBlocks(x, z, rad)) return false;
  // Outside the building is legitimate roaming — only enforce camera clearance while indoors.
  if (!insideRoom(x, z, 0)) return true;
  return insideRoom(x, z, CAM_MIN);
}

// Pointer lock just engaged. The camera may be ours (a re-lock after Escape, so leave the character
// where it stands) or it may have been parked somewhere by dc.js's idle "attract mode" demo, which
// glides the camera through preset views. Blindly adopting the demo camera's spot used to teleport the
// character into the front doorway / against a rack — from there the follow camera had nowhere to go
// and the screen barely changed, which is what "clicking only clears the overlay" looked like.
function syncPlayerFromCamera() {
  const cam = S.camera.position;
  const ours = S.camPlacedValid && cam.distanceToSquared(S.camPlaced) < 1;
  if (ours) { S.player.position.y = 0; S.vy = 0; S.spawned = true; return; }
  // First-person mode: PointerLockControls owns camera, don't teleport player
  if (S.mode === "first") return;
  // Cancel any existing fly animation
  if (window.DC && window.DC.flyTo) {
    window.DC.flyTo.active = false;
    window.DC.flyTo.onDone = null;
  }
  if (playableSpot(cam.x, cam.z)) {
    S.player.position.set(cam.x, 0, cam.z);
    S.vy = 0; S.spawned = true;
    return;
  }
  // Demo camera left us somewhere unplayable — drop in at the room's proper spawn instead.
  S.vy = 0;
  trySpawn();
}

// Interpolate a yaw the SHORT way round, so turning from just under +π to just over −π is a few
// degrees rather than a 358° spin.
//
// R3.11: the previous one-liner was `((b - a + PI) % (2*PI)) - PI`, which only normalises when
// `b - a >= -PI`. JavaScript's % keeps the sign of the DIVIDEND, so for a target below the current
// facing by more than half a turn the modulo returns a negative value and subtracting PI pushes
// the result further out instead of wrapping it back — down to −2π at the extreme. Both endpoints
// are the same angle, so nothing looked broken; the avatar just took the long way round, for half
// of all wrap cases. Found by R3.11 replacing the test's hand-copied lerpAngle with the real one.
function lerpAngle(a, b, t) {
  const TWO_PI = Math.PI * 2;
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return a + d * t;
}

function setMode(mode) {
  S.mode = mode;
  applyMode();
  log("mode ->", mode);
}
function toggleMode() { setMode(S.mode === "first" ? "third" : "first"); }

// Mouse wheel = camera dolly (see CAM_* constants). Scroll down = zoom out, scroll up = zoom in.
// F-18: scope preventDefault to canvas only — do not break lil-gui, .parameters, .dc-chat-frame, #dcSearchResults
function onWheel(e) {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  const canvas = document.querySelector('canvas');
  if (e.target !== canvas && document.pointerLockElement !== canvas) return;
  e.preventDefault();
  const out = e.deltaY > 0;
  if (S.mode === "first") {
    if (out) { S.camDist = CAM_MIN; setMode("third"); }   // pop straight back outside the body
    return;                                                // scrolling in while first-person: no-op
  }
  if (out) {
    S.camDist = Math.min(CAM_MAX, S.camDist + WHEEL_STEP); // back + up, capped at the high/far limit
  } else {
    const nd = S.camDist - WHEEL_STEP;
    if (nd < CAM_MIN) setMode("first");                    // all the way in -> first person
    else S.camDist = nd;
  }
}

function applyMode() {
  if (S.model) S.model.visible = true;   // visible in BOTH views now (attract mode still hides it while unlocked)
  const btn = document.getElementById("dcPerson");
  if (btn) btn.textContent = S.mode === "first" ? "👁 First-person" : "🧍 Third-person";
  hud(S.mode === "first"
    ? "First-person — scroll out: third-person · V: third-person · WASD move · Shift run · Space jump · 1-9 gestures · G/H cycle · 0 reset"
    : "Third-person — scroll: zoom in/out (→ first-person) · V: toggle · WASD move · Shift run · Space jump · 1-9 gestures · G/H cycle · 0/` reset");
}

function gesture(label) {
  const act = S.actions[label];
  if (!act || !S.grounded) return;
  const dur = (act.getClip && act.getClip().duration) ? act.getClip().duration : 3;
  S.gestureUntil = performance.now() + dur * 1000;
  S.current = null;                  // force re-trigger even if same label
  play(label, 0.15);
}

// Cancel any running gesture and return to normal: drop the gesture lock so chooseAnimation() resumes
// idle/walk/run, and snap to idle now.
function endGesture() {
  S.gestureUntil = 0;
  play(S.actions.idle ? "idle" : Object.keys(S.actions)[0], 0.2);
}

// Full ordered gesture list (locomotion excluded). Number keys 1-9 hit the first nine directly; G / H
// cycle through whatever the loaded character actually has (queries can miss for some characters).
const GESTURE_ORDER = ["dance1", "dance2", "clap", "dying", "wave", "dance3", "dance4", "salute", "cheer",
  "bow", "point", "thumbsup", "talk", "laugh", "think", "shrug", "punch", "kick", "sit", "backflip", "jacks"];
// The complete set of animation labels this module can ever play: the four locomotion
// states chooseAnimation() selects between, plus every gesture bound to a key.
// Anything outside this set is unreachable — no keybinding, no code path plays it.
// The manifest lists up to 3346 clips for some characters, of which exactly these 25
// are usable, so loadCharacter() filters against this before issuing a single request.
const PLAYABLE_LABELS = new Set(['idle', 'walk', 'run', 'jump', ...GESTURE_ORDER]);
const GESTURE_NAMES = { dance1: "Samba", dance2: "Hip-Hop", dance3: "Breakdance", dance4: "Gangnam",
  clap: "Clap", wave: "Wave", dying: "Dying", salute: "Salute", cheer: "Cheer", bow: "Bow", point: "Point",
  thumbsup: "Thumbs Up", talk: "Talk", laugh: "Laugh", think: "Think", shrug: "Shrug", punch: "Punch",
  kick: "Kick", sit: "Sit", backflip: "Backflip", jacks: "Jumping Jacks" };

function cycleGesture(dir) {
  const avail = GESTURE_ORDER.filter((l) => S.actions[l]);
  if (!avail.length) return;
  let i = avail.indexOf(S.current);
  i = i < 0 ? (dir > 0 ? 0 : avail.length - 1) : (i + dir + avail.length) % avail.length;
  const label = avail[i];
  gesture(label);
  flashGesture(GESTURE_NAMES[label] || label);
}

let _gFlashEl = null, _gFlashTimer = null;
function flashGesture(text) {                          // brief centred toast naming the gesture you cycled to
  if (!_gFlashEl) {
    _gFlashEl = document.createElement("div");
    _gFlashEl.id = "dcGesture";
    _gFlashEl.style.cssText = "position:fixed;top:46px;left:50%;transform:translateX(-50%);z-index:33;padding:5px 14px;" +
      "background:rgba(20,20,28,0.85);color:#ffd23a;border-radius:5px;font:bold 14px Arial,sans-serif;pointer-events:none;transition:opacity .3s;";
    document.body.appendChild(_gFlashEl);
  }
  clearTimeout(_gFlashTimer);
  _gFlashEl.textContent = text;
  _gFlashEl.style.opacity = "1";
  _gFlashTimer = setTimeout(() => {
    _gFlashEl.style.opacity = "0";
    _gFlashTimer = setTimeout(() => {
      if (_gFlashEl && _gFlashEl.parentNode) {
        _gFlashEl.parentNode.removeChild(_gFlashEl);
        _gFlashEl = null;
      }
    }, 300);                                           // wait for CSS transition to complete
  }, 1200);
}

// ---------------------------------------------------------------- input + UI
// Named handlers for cleanup (CRIT-2)
const _onKeyDown = (e) => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  switch (e.code) {
    case "ShiftLeft": case "ShiftRight": S.options.runFast = true; break;
    case "Space": if (S.grounded) { S.vy = JUMP_V; S.grounded = false; } break;
    // V only. 'c' is the chat-focus key (bound in dc.html); it used to ALSO toggle
    // perspective here, so pressing it flipped the camera behind the user's back while
    // they were typing. Every on-screen hint already documents V.
    case "KeyV": toggleMode(); break;
    case "Digit1": gesture("dance1"); break;
    case "Digit2": gesture("dance2"); break;
    case "Digit3": gesture("clap"); break;
    case "Digit4": gesture("dying"); break;
    case "Digit5": gesture("wave"); break;
    case "Digit6": gesture("dance3"); break;
    case "Digit7": gesture("dance4"); break;
    case "Digit8": gesture("salute"); break;
    case "Digit9": gesture("cheer"); break;
    case "KeyG": cycleGesture(1); break;                    // cycle forward through ALL gestures
    case "KeyH": cycleGesture(-1); break;                   // cycle backward
    case "Backquote": case "Digit0": endGesture(); break;   // return to normal / stop the gesture
    case "KeyR": trySpawn(); break;                       // reset player to spawn
  }
};
const _onKeyUp = (e) => {
  if (e.code === "ShiftLeft" || e.code === "ShiftRight") S.options.runFast = false;
};
const _onBtnClick = (e) => { e.stopPropagation(); toggleMode(); };
const _onCharChange = () => {
  const sel = S._dcCharSel;
  const ch = S.manifest.characters.find(c => c.id === sel.value);
  if (ch) { S.spawned = false; loadCharacter(ch); }
};

function setupInput() {
  document.addEventListener("keydown", _onKeyDown);
  document.addEventListener("keyup", _onKeyUp);
  document.addEventListener("wheel", onWheel, { passive: false });
  const btn = document.getElementById("dcPerson");
  if (btn) { S._dcPersonBtn = btn; btn.addEventListener("click", _onBtnClick); }
  const sel = document.getElementById("dcChar");
  if (sel) { S._dcCharSel = sel; sel.addEventListener("change", _onCharChange); }
}

function populateCharacterPicker() {
  if (!S.manifest || !S.manifest.characters || !S.manifest.characters.length) return;
  // Player controls live INSIDE the shared lil-gui (not free-floating buttons over it). The gui is
  // built only after the datacenter fetch resolves, which is later than this overlay boots -> poll.
  // Bounded on the same budget whenReady() uses: when that fetch fails, displayGui() never runs and
  // DC.gui never appears, and an unbounded poll then wakes the page every 120ms for as long as it
  // stays open — forever, on a page meant to be left running.
  const GUI_TIMEOUT_MS = 15000;
  const start = performance.now();
  const build = () => {
    const gui = S.DC && S.DC.gui;
    if (!gui) {
      if (performance.now() - start > GUI_TIMEOUT_MS) {
        console.error(`[dc-multi] populateCharacterPicker timeout - DC.gui not available after ${GUI_TIMEOUT_MS}ms`);
        return;
      }
      setTimeout(build, 120);
      return;
    }
    if (S.playerGui) return;
    const f = gui.addFolder("Player");
    const opts = {};
    for (const c of S.manifest.characters) opts[c.name + (c.type && c.type !== "system" ? ` (${c.type})` : "")] = c.id;
    S.charProxy = { character: (S.loadedCharId || S.manifest.characters[0].id) };
    f.add(S.charProxy, "character", opts).name("Character").listen().onChange((id) => {
      const ch = S.manifest.characters.find((c) => c.id === id);
      if (ch) { S.spawned = false; loadCharacter(ch); }
    });
    f.add({ toggle: () => toggleMode() }, "toggle").name("Toggle Perspective (1st/3rd)");
    f.add(S, 'pixelScale', 0.5, 1.0).name('Quality').step(0.1).onChange(v => { setPixelScale(v); });
    f.add({ 'DPR Cap': 'max 2.0' }, 'DPR Cap').name('DPR Cap').enable(false);
    f.add(S, 'fov', 30, 120).name('FOV').step(1).onChange(v => {
        if (S.camera) { S.camera.fov = v; S.camera.updateProjectionMatrix(); }
    });
    // Display-only: powerPreference is fixed at renderer creation and can't be changed afterwards.
    // dc.js owns that construction and is the only place a preference could be requested, so the
    // value comes from there — a copy kept here read 'high-performance' for as long as dc.js has
    // been requesting nothing at all.
    f.add({ 'GPU Mode': (S.DC && S.DC.powerPreference) || 'unknown' }, 'GPU Mode').name('GPU Mode').enable(false);
    f.add({ get walk() { return WALK; }, set walk(v) { WALK = v; } }, 'walk', 1, 30).name('Walk Speed').step(0.5).onChange(v => { WALK = v; });
    f.add({ get run() { return RUN; }, set run(v) { RUN = v; } }, 'run', 5, 60).name('Run Speed').step(0.5).onChange(v => { RUN = v; });
    f.open();
    S.playerGui = f;
    const pl = document.getElementById("dcPlayer"); if (pl) pl.style.display = "none";
  };
  build();
}

let _hudEl = null;

function hud(text) {
  if (!text || text === "") {
    if (_hudEl && _hudEl.parentNode) { _hudEl.parentNode.removeChild(_hudEl); _hudEl = null; }
    return;
  }
  if (!_hudEl) {
    _hudEl = document.createElement("div");
    _hudEl.id = "dcPlayerHud";
    document.body.appendChild(_hudEl);
  }
  _hudEl.textContent = text;
}

/**
 * Display a 4-second overlay showing keyboard controls for the DataCenter 3D walkthrough.
 * This is a debug aid; access it via `window.DCM.showHelp()`.
 */
function showHelp() {
  const help = document.createElement('div');
  help.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.9);color:#fff;padding:24px;border-radius:8px;z-index:9999;font-family:sans-serif;font-size:14px;line-height:1.8;';
  help.innerHTML = '<strong>DataCenter 3D Controls</strong><br>' +
      'W/A/S/D - Move &nbsp; Mouse - Look<br>' +
      'Space - Jump &nbsp; Shift - Run<br>' +
      '1-9 - Switch locations<br>' +
      'F - Toggle fly &nbsp; G - Toggle GUI<br>' +
      'Click - Lock pointer';
  document.body.appendChild(help);
  setTimeout(() => help.remove(), 4000);
}

/**
 * Expose debug utilities on `window.DCM` for development and troubleshooting.
 * Only available when `window.DC_DEBUG` is truthy, or on the admin dc.html page.
 *
 * @example
 * window.DCM.showHelp()           // Show controls overlay (4s)
 * window.DCM.getPosition()       // { x, z } player position
 * window.DCM.getLatency()        // WebSocket latency in ms
 */
function exposeDebug() {
  window.DCM = {
    getPosition: () => ({ x: S.player.position.x, z: S.player.position.z }),
    /** Character yaw in radians — dc-presence reads this so its join carries our real facing */
    getFacing: () => S.facing,
    getState: () => ({ mode: S.mode, spawned: S.spawned, charId: S.loadedCharId }),
    /** Internal S state — used exclusively by the animation-filter unit test */
    _S: S,
    /** loadCharacter — used exclusively by the animation-filter unit test */
    loadCharacter,
    /** loadClipsPooled — used exclusively by the animation-filter unit test */
    loadClipsPooled,
    /**
     * Live movement state. getState() above is the stable three-field summary the console helpers and
     * dc-presence read; this is the raw locomotion state (mode/vy/facing/camDist) that
     * tests/playwright/dc.spec.ts Group 5 asserts on. A getter, not a stored object, so it can never
     * report a stale pose and nothing outside can write S through it.
     */
    get state() {
      return { mode: S.mode, vy: S.vy, facing: S.facing, camDist: S.camDist, grounded: S.grounded, spawned: S.spawned };
    },
    setMode, toggleMode, gesture, endGesture, cycleGesture,
    play: (l) => play(l, 0.2),
    reload: () => location.reload(),
    setCamDist: (d) => { S.camDist = d; },
    setFacingOffset: (rad) => { S.player.rotation.y = S.facing + rad; },
    getLatency: () => window.DC_LATENCY || 0,
    getConnected: () => window.DC_AUTHED || false,
    /** Current camera viewport data from the WS layer */
    getViewport: () => window.DC_WS?._viewport || null,
    /** Show keyboard controls overlay for 4 seconds */
    showHelp,
    /** Get WebSocket connection state */
    getWsState: () => window.DC_WS?.getState() ?? null,
    /** Check if presence/multiplayer is enabled */
    getPresenceEnabled: () => window.DC_PRESENCE_ENABLED !== false,
    viewDist: 50,
  };
}
