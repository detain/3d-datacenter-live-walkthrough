/**
 * dc-presence.js — Multi-user presence overlay for dc.html 3D datacenter.
 *
 * Maintains a map of connected users (uid → {x, z, yaw, name}) and renders
 * their avatars in the Three.js scene as simple cylinder+sphere figures with
 * nameplates. Updates are driven by dc:v1-event CustomEvents dispatched by
 * dc-ws.js when the server broadcasts dc.presence.joined/updated/left.
 *
 * ---------------------------------------------------------------------------
 * Exports (window)
 * ---------------------------------------------------------------------------
 *   DC_PRESENCE_JOIN(x, z, yaw)  — announce entry into the 3D scene
 *   DC_PRESENCE_MOVE(x, z, yaw)  — throttled position/rotation broadcast
 *   DC_PRESENCE_LEAVE()          — announce departure from the scene
 *
 * State (window.DC_PRESENCE)
 *   uid       — our own numeric uid
 *   name      — our own display name
 *   remote    — Map<uid, {x, z, yaw, name, group, avatar, targetX, targetZ}>
 *
 * UI element
 *   #dcPresence — floating HUD badge top-right showing connected-user count
 *
 * ---------------------------------------------------------------------------
 * Events consumed
 * ---------------------------------------------------------------------------
 *   dc:auth-success   — auth succeeded; initialise local state and join scene
 *   dc:auth-failure   — auth failed; nuke all remote avatars
 *   dc:disconnected   — WS lost; nuke all remote avatars
 *   dc:v1-event       — {op, data} for dc.presence.joined/updated/left
 */

(function () {
	'use strict';

	/* -------------------------- constants -------------------------- */

	var THROTTLE_MS = 150;   // minimum interval between dc.presence.move sends
	var LERP_SPEED  = 12;    // avatar position lerp factor per second (scene units)

	/* -------------------------- shared geometry/materials (Fix 4) -------------------------- */
	/* eslint-disable no-undef */
	var AVATAR_BODY_GEO = new THREE.CylinderGeometry(0.12, 0.12, 0.28, 8);
	var AVATAR_HEAD_GEO = new THREE.SphereGeometry(0.10, 12, 8);
	var BODY_MAT = new THREE.MeshLambertMaterial({ color: 0x2255cc });
	var HEAD_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f4ff });
	/* eslint-enable no-undef */

	/* -------------------------- scene-ready flag (Fix 5) -------------------------- */
	var _sceneReady = false;

	/* -------------------------- name-sprite canvas pool (Fix B) -------------------------- */
	/* eslint-disable no-undef */
	var _nameCanvas = document.createElement('canvas');
	_nameCanvas.width = 256;
	_nameCanvas.height = 48;
	var _nameCtx = _nameCanvas.getContext('2d');

	/** @type {Map<string, THREE.CanvasTexture>} Cache texture per username (Fix 1) */
	var _nameSpriteCache = new Map();
	var _nameSpriteCacheOrder = [];
	var MAX_NAME_SPRITE_CACHE = 64;
	/* eslint-enable no-undef */

	/* -------------------------- state ---------------------------- */

	/** @type {{uid:number|null, name:string|null, remote:Map}} */
	var state = {
		uid:   null,
		name:  null,
		remote: new Map()
	};

	/** Pending join parameters awaiting scene readiness {x, z, yaw} */
	var pendingJoin = null;

	/** Time of last move send (for throttle) */
	var lastMoveAt = 0;

	/** Flag to ensure we only set up the scene-watcher once */
	var sceneWatcherStarted = false;

	/** DOM refs */
	var elDot   = null;
	var elCount = null;

	/* -------------------------- helpers -------------------------- */

	/**
	 * Guard: ensure we have a valid local uid before doing presence work.
	 * @returns {boolean}
	 */
	function hasLocalUid() {
		return state.uid !== null && state.uid !== undefined;
	}

	/**
	 * Guard: ensure the Three.js scene is available.
	 * @returns {boolean}
	 */
	function sceneReady() {
		return !!(window.DC && window.DC.scene);
	}

	/**
	 * Send a fire-and-forget presence envelope.
	 * @param {string} op
	 * @param {Object} data
	 */
	function send(op, data) {
		if (typeof window.DC_PRESENCE_SEND === 'function') {
			window.DC_PRESENCE_SEND(op, data);
		}
	}

	/**
	 * Update the presence indicator badge in the top-right HUD.
	 */
	function updateIndicator() {
		var count = state.remote.size + (hasLocalUid() ? 1 : 0);
		if (elCount) elCount.textContent = String(count);
		if (elDot) {
			if (hasLocalUid() && count > 0) {
				elDot.classList.add('active');
			} else {
				elDot.classList.remove('active');
			}
		}
	}

	/* ---------------------- avatar mesh -------------------------- */

	/**
	 * Build a simple avatar (cylinder body + sphere head + name sprite) for a remote user.
	 * Nameplate is hidden for the local user (can't see your own nameplate).
	 *
	 * @param {number} uid
	 * @param {string} name
	 * @param {number} x
	 * @param {number} z
	 * @param {number} yaw
	 * @returns {THREE.Group}
	 */
	function buildAvatar(uid, name, x, z, yaw) {
		// Lazy-import to avoid referencing THREE before scene is ready
		/* eslint-disable no-undef */
		var scene   = window.DC.scene;
		var isLocal = hasLocalUid() && String(uid) === String(state.uid);

		// Cylinder body (blue) — use shared geometry/material (Fix 4)
		var body    = new THREE.Mesh(AVATAR_BODY_GEO, BODY_MAT);
		body.position.y = 0.14;  // sit on ground (y=0)
		body.castShadow = true;

		// Sphere head (white) — use shared geometry/material (Fix 4)
		var head    = new THREE.Mesh(AVATAR_HEAD_GEO, HEAD_MAT);
		head.position.y = 0.38;  // top of cylinder + small gap
		head.castShadow = true;

		var group = new THREE.Group();
		group.add(body);
		group.add(head);

		// Name sprite (hidden for local user)
		if (!isLocal && name) {
			var sprite = makeNameSprite(name);
			sprite.position.y = 0.62;
			group.add(sprite);
		}

		group.position.set(x, 0, z);
		group.rotation.y = yaw;
		scene.add(group);
		/* eslint-enable no-undef */

		return group;
	}

	/**
	 * Create a THREE.Sprite name label above an avatar's head.
	 * @param {string} name
	 * @returns {THREE.Sprite}
	 */
	function makeNameSprite(name) {
		/* eslint-disable no-undef */
		// Return cached texture for this username (Fix 1)
		if (_nameSpriteCache.has(name)) {
			var cachedTex = _nameSpriteCache.get(name);
			// Move to end of order (most recently used)
			var idx = _nameSpriteCacheOrder.indexOf(name);
			if (idx !== -1) { _nameSpriteCacheOrder.splice(idx, 1); }
			_nameSpriteCacheOrder.push(name);
			var cachedMat = new THREE.SpriteMaterial({ map: cachedTex, transparent: true, depthTest: false });
			var cachedSprite = new THREE.Sprite(cachedMat);
			cachedSprite.scale.set(1.6, 0.30, 1);
			return cachedSprite;
		}

		var canvas = _nameCanvas;   // reuse the pooled canvas (Fix B)
		var ctx = _nameCtx;         // reuse the pooled context
		ctx.clearRect(0, 0, 256, 48); // clear residual from previous sprite

		// Pill-shaped background
		ctx.fillStyle = 'rgba(18,22,32,0.82)';
		var r = 14;
		ctx.beginPath();
		ctx.moveTo(r, 0);
		ctx.lineTo(256 - r, 0);
		ctx.arcTo(256, 0, 256, r, r);
		ctx.lineTo(256, 48 - r);
		ctx.arcTo(256, 48, 256 - r, 48, r);
		ctx.lineTo(r, 48);
		ctx.arcTo(0, 48, 0, 48 - r, r);
		ctx.lineTo(0, r);
		ctx.arcTo(0, 0, r, 0, r);
		ctx.closePath();
		ctx.fill();

		// Name text
		ctx.fillStyle = '#ffffff';
		ctx.font = 'bold 18px Arial, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(name, 128, 24);

		var texture = new THREE.CanvasTexture(canvas);
		// LRU eviction: if at max capacity, dispose and remove oldest
		if (_nameSpriteCacheOrder.length >= MAX_NAME_SPRITE_CACHE) {
			var oldest = _nameSpriteCacheOrder.shift();
			var oldTex = _nameSpriteCache.get(oldest);
			if (oldTex) { oldTex.dispose(); _nameSpriteCache.delete(oldest); }
		}
		_nameSpriteCacheOrder.push(name);
		_nameSpriteCache.set(name, texture);
		var mat     = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
		var sprite  = new THREE.Sprite(mat);
		sprite.scale.set(1.6, 0.30, 1);
		/* eslint-enable no-undef */

		return sprite;
	}

	/* ---------------------- presence handlers -------------------- */

	/**
	 * Handle dc.presence.joined from the server broadcast.
	 * @param {{uid:number, name:string, x:number, z:number, yaw:number}} data
	 */
	function onJoined(data) {
		// Guard: we don't know our own uid yet — queue it
		if (!hasLocalUid()) {
			pendingJoin = { x: data.x || 0, z: data.z || 0, yaw: data.yaw || 0 };
			return;
		}

		// Guard: this is us — we've already rendered ourselves
		if (String(data.uid) === String(state.uid)) return;

		// Guard: already have this user
		if (state.remote.has(data.uid)) return;

		// Guard: scene must be ready
		if (!sceneReady()) return;

		var entry = {
			uid:    data.uid,
			name:   data.name || '?',
			x:      data.x || 0,
			z:      data.z || 0,
			yaw:    data.yaw || 0,
			targetX: data.x || 0,
			targetZ: data.z || 0,
			group:  null,
			avatar: null
		};

		entry.group  = buildAvatar(data.uid, entry.name, entry.x, entry.z, entry.yaw);
		entry.avatar = entry.group;

		state.remote.set(data.uid, entry);
		updateIndicator();
	}

	/**
	 * Handle dc.presence.updated from the server broadcast.
	 * @param {{uid:number, x:number, z:number, yaw:number}} data
	 */
	function onUpdated(data) {
		// Guard: ignore updates for unknown remote users
		var entry = state.remote.get(data.uid);
		if (!entry) return;

		// Update target position for lerping
		entry.targetX = data.x !== undefined ? data.x : entry.targetX;
		entry.targetZ = data.z !== undefined ? data.z : entry.targetZ;
		if (data.yaw !== undefined) entry.yaw = data.yaw;

		updateIndicator();
	}

	/**
	 * Handle dc.presence.left from the server broadcast.
	 * @param {{uid:number}} data
	 */
	function onLeft(data) {
		var entry = state.remote.get(data.uid);
		if (!entry) return;

		// Dispose cached name sprite texture and clear from cache (Fix 2)
		if (entry.name && _nameSpriteCache.has(entry.name)) {
			var tex = _nameSpriteCache.get(entry.name);
			tex.dispose();
			_nameSpriteCache.delete(entry.name);
			var idx = _nameSpriteCacheOrder.indexOf(entry.name);
			if (idx !== -1) _nameSpriteCacheOrder.splice(idx, 1);
		}

		if (entry.group && sceneReady()) {
			entry.group.traverse(function (child) {
				if (child.isSprite && child.material) {
					if (child.material.map) {
						child.material.map.dispose();
					}
					child.material.dispose();
				}
			});
			window.DC.scene.remove(entry.group);
			entry.group = null;
		}
		state.remote.delete(data.uid);
		updateIndicator();
	}

	/* -------------------------- per-frame lerp ------------------ */

	/**
	 * Lerp all remote avatars toward their target positions each animation frame.
	 * Called from dc-multi's render loop via DC.tick array iteration.
	 * @param {number} dt — delta time in seconds
	 */
	function tickAvatars(dt) {
		if (document.hidden) return;
		if (!_sceneReady) return;

		state.remote.forEach(function (entry) {
			if (!entry.group) return;

			// Use real dt; fall back to 1/60 if not provided (Fix 3)
			var speed = (typeof dt === 'number' && dt > 0) ? dt : (1 / 60);
			var lerpFactor = LERP_SPEED * speed;

			// Lerp X
			var dx = entry.targetX - entry.group.position.x;
			if (Math.abs(dx) > 0.001) {
				entry.group.position.x += dx * Math.min(1, lerpFactor);
			}

			// Lerp Z
			var dz = entry.targetZ - entry.group.position.z;
			if (Math.abs(dz) > 0.001) {
				entry.group.position.z += dz * Math.min(1, lerpFactor);
			}

			// Apply yaw (instant, not lerped — keeps rotation snappy)
			entry.group.rotation.y = entry.yaw;
		});
	}

	/* -------------------------- scene watcher -------------------- */

	/**
	 * Poll until DC.scene is available, then process any pending join and
	 * set up the per-frame avatar lerp hook.
	 */
	function watchScene() {
		if (sceneWatcherStarted) return;
		sceneWatcherStarted = true;

		var tryReady = function () {
			if (!sceneReady()) {
				setTimeout(tryReady, 80);
				return;
			}

			// Scene is now ready — process pending join
			if (pendingJoin) {
				joinScene(pendingJoin.x, pendingJoin.z, pendingJoin.yaw);
				pendingJoin = null;
			}

			// Mark scene ready so tickAvatars runs each frame (Fix 5)
			_sceneReady = true;

			// Register tickAvatars into DC's tick callback array — no chaining (Fix 1)
			// Gate at registration level: skip entirely when tab is hidden (avoids call overhead)
			if (window.DC._presenceTicks) {
				window.DC._presenceTicks.push(function (dt) { if (document.hidden) return; tickAvatars(dt); });
			} else {
				window.DC._presenceTicks = [function (dt) { if (document.hidden) return; tickAvatars(dt); }];
				// First presence module to register: wrap DC.tick to iterate the array
				var origTick = window.DC.tick.bind(window.DC);
				window.DC.tick = function (dt) {
					origTick(dt);
					for (var i = 0; i < window.DC._presenceTicks.length; i++) {
						window.DC._presenceTicks[i](dt);
					}
				};
			}
		};

		tryReady();
	}

	/* ----------------------- join / move / leave ----------------- */

	/**
	 * Add our avatar to the scene and broadcast dc.presence.join.
	 * @param {number} x
	 * @param {number} z
	 * @param {number} yaw
	 */
	function joinScene(x, z, yaw) {
		if (!sceneReady() || !hasLocalUid()) return;

		// If a remote avatar entry somehow exists for us (stale server state), skip
		if (state.remote.has(state.uid)) return;

		send('dc.presence.join', { x: x, z: z, yaw: yaw });
	}

	/**
	 * Announce our departure from the scene.
	 */
	function leaveScene() {
		if (!hasLocalUid()) return;
		send('dc.presence.leave', {});
	}

	/**
	 * Broadcast a position/rotation update (throttled).
	 * @param {number} x
	 * @param {number} z
	 * @param {number} yaw
	 */
	function moveScene(x, z, yaw) {
		var now = performance.now();
		if (now - lastMoveAt < THROTTLE_MS) return;
		lastMoveAt = now;
		send('dc.presence.move', { x: x, z: z, yaw: yaw });
	}

	/* ----------------------- event listeners -------------------- */

	/**
	 * Handle dc:auth-success — initialise local state and attempt to join scene.
	 * @param {{uid:number, name:string}} data
	 */
	function onAuthSuccess(data) {
		state.uid  = data.uid;
		state.name = data.name || '';

		// Watch for scene readiness; onAuthSuccess is also our signal to join
		watchScene();

		// If scene is already ready, join immediately
		if (sceneReady()) {
			joinScene(0, 0, 0);
		} else {
			// Defer join until scene is ready (watchScene handles this)
		}
	}

	/**
	 * Handle dc:auth-failure or dc:disconnected — nuke all remote avatars.
	 */
	function onAuthFailureOrDisconnect() {
		pendingJoin = null;  // clear any pending join (Fix 2: top, before teardown)

		// Remove all remote avatars from scene
		if (sceneReady()) {
			state.remote.forEach(function (entry) {
				// Dispose cached name sprite texture (Fix 4)
				if (entry.name && _nameSpriteCache.has(entry.name)) {
					var tex = _nameSpriteCache.get(entry.name);
					tex.dispose();
					_nameSpriteCache.delete(entry.name);
				}
				if (entry.group) window.DC.scene.remove(entry.group);
			});
		}
		// Clear name sprite cache (Fix 4)
		_nameSpriteCache.forEach(function (tex) { tex.dispose(); });
		_nameSpriteCache.clear();
		_nameSpriteCacheOrder = [];

		state.remote.clear();
		state.uid  = null;
		state.name = null;
		updateIndicator();
	}

	/**
	 * Handle dc:v1-event — route presence ops to their handlers.
	 * @param {{op:string, data:Object}} detail
	 */
	function onV1Event(detail) {
		var op   = detail.op;
		var data = detail.data || {};

		if (op === 'dc.presence.joined') {
			onJoined(data);
		} else if (op === 'dc.presence.updated') {
			onUpdated(data);
		} else if (op === 'dc.presence.batch_updated') {
			// data is { uid1: {x,z,yaw,name,...}, uid2: {...}, ... }
			// emitted by Events.php when 2+ clients move within a 50ms window
			if (data && typeof data === 'object') {
				for (var uid in data) {
					if (!Object.prototype.hasOwnProperty.call(data, uid)) continue;
					if (uid === String(state.uid)) continue;  // skip self
					var entry = data[uid];
					var remoteEntry = state.remote.get(uid);
					if (remoteEntry) {
						// Update lerp targets for smooth transition
						if (entry.x !== undefined) remoteEntry.targetX = entry.x;
						if (entry.z !== undefined) remoteEntry.targetZ = entry.z;
						if (entry.yaw !== undefined) remoteEntry.yaw = entry.yaw;
						// name might have changed
						if (entry.name) remoteEntry.name = entry.name;
					}
					// else: unknown uid, ignore (could be a stale broadcast)
				}
			}
		} else if (op === 'dc.presence.left') {
			onLeft(data);
		}
	}

	/* -------------------------- bootstrap ----------------------- */

	function init() {
		// Cache DOM refs
		elDot   = document.getElementById('dcPresenceDot');
		elCount = document.getElementById('dcPresenceCount');

		// Listen for auth events
		document.addEventListener('dc:auth-success',  function (e) { onAuthSuccess(e.detail); });
		document.addEventListener('dc:auth-failure',  function ()    { onAuthFailureOrDisconnect(); });
		document.addEventListener('dc:disconnected', function ()    { onAuthFailureOrDisconnect(); });

		// Listen for presence broadcasts from dc-ws.js
		document.addEventListener('dc:v1-event', function (e) { onV1Event(e.detail); });

		updateIndicator();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	/* -------------------------- public API ---------------------- */

	window.DC_PRESENCE_JOIN  = joinScene;
	window.DC_PRESENCE_MOVE  = moveScene;
	window.DC_PRESENCE_LEAVE = leaveScene;

}());
