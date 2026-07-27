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

	var THROTTLE_MS = 250;   // minimum interval between dc.presence.move sends
	var LERP_SPEED  = 12;    // avatar position lerp factor per second (scene units)

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

		// Cylinder body (blue)
		var bodyGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.28, 8);
		var bodyMat = new THREE.MeshLambertMaterial({ color: 0x2255cc });
		var body    = new THREE.Mesh(bodyGeo, bodyMat);
		body.position.y = 0.14;  // sit on ground (y=0)
		body.castShadow = true;

		// Sphere head (white)
		var headGeo = new THREE.SphereGeometry(0.10, 12, 8);
		var headMat = new THREE.MeshLambertMaterial({ color: 0xf0f4ff });
		var head    = new THREE.Mesh(headGeo, headMat);
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
		var canvas  = document.createElement('canvas');
		canvas.width  = 256;
		canvas.height = 48;
		var ctx = canvas.getContext('2d');

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
		var mat     = new THREE.SpriteMaterial({ map: texture, depthTest: false });
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

		if (entry.group && sceneReady()) {
			window.DC.scene.remove(entry.group);
		}
		state.remote.delete(data.uid);
		updateIndicator();
	}

	/* -------------------------- per-frame lerp ------------------ */

	/**
	 * Lerp all remote avatars toward their target positions each animation frame.
	 * Called from dc-multi's render loop via DC_PRESENCE_TICK.
	 * @param {number} dt — delta time in seconds
	 */
	function tickAvatars(dt) {
		if (!sceneReady()) return;

		state.remote.forEach(function (entry) {
			if (!entry.group) return;

			// Lerp X
			var dx = entry.targetX - entry.group.position.x;
			if (Math.abs(dx) > 0.001) {
				entry.group.position.x += dx * Math.min(1, LERP_SPEED * dt);
			}

			// Lerp Z
			var dz = entry.targetZ - entry.group.position.z;
			if (Math.abs(dz) > 0.001) {
				entry.group.position.z += dz * Math.min(1, LERP_SPEED * dt);
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

			// Wire per-frame avatar lerp into dc-multi's tick
			if (window.DC && typeof window.DC.tick === 'function') {
				var origTick = window.DC.tick;
				window.DC.tick = function () {
					origTick.apply(this, arguments);
					// estimate ~60fps so dt≈1/60
					tickAvatars(1 / 60);
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
		// Remove all remote avatars from scene
		if (sceneReady()) {
			state.remote.forEach(function (entry) {
				if (entry.group) window.DC.scene.remove(entry.group);
			});
		}
		state.remote.clear();
		state.uid  = null;
		state.name = null;
		pendingJoin = null;
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
