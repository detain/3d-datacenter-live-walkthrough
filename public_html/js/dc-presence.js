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
 *   remote    — Map<uid, {x, z, yaw, name, ts, vx, vy, lastUpdateTime, targetX, targetZ, group, avatar}>
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

import * as THREE from '../../../../../lib/three/build/three.module.js';

(function () {
  'use strict'

  /* -------------------------- constants -------------------------- */

  const THROTTLE_MS = 150 // minimum interval between dc.presence.move sends
  const LERP_SPEED = 12 // avatar position lerp factor per second (scene units)

  /* -------------------------- shared geometry/materials -------------------------- */
  const AVATAR_BODY_GEO = new THREE.CylinderGeometry(0.12, 0.12, 0.28, 8)
  const AVATAR_HEAD_GEO = new THREE.SphereGeometry(0.10, 12, 8)
  const BODY_MAT = new THREE.MeshLambertMaterial({ color: 0x2255cc })
  const HEAD_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f4ff })

  /* -------------------------- scene-ready flag (Fix 5) -------------------------- */
  let _sceneReady = false

  /* -------------------------- name-sprite canvas pool (Fix B) -------------------------- */
  /* eslint-disable no-undef */
  const _nameCanvas = document.createElement('canvas')
  _nameCanvas.width = 256
  _nameCanvas.height = 48
  const _nameCtx = _nameCanvas.getContext('2d')

  /** @type {Map<string, {texture: THREE.CanvasTexture, sprite: THREE.Sprite}>} Cache sprite+texture per username (Fix 1) */
  const _nameSpriteCache = new Map()
  const _nameSpriteCacheOrder = new Set() // O(1) add/has/delete; insertion order maintained for LRU
  const MAX_NAME_SPRITE_CACHE = 64
  /* eslint-enable no-undef */

  /* -------------------------- state ---------------------------- */

  /**
	 * Local presence state for this client (this browser tab).
	 * @typedef {Object} PresenceState
	 * @property {number|null} uid            - User ID (same across tabs)
	 * @property {string|null} name          - Display name
	 * @property {number|string|null} clientId - Unique per-connection ID (differs per tab); used for multi-tab support
	 * @property {Map<string, RemoteEntry>} remote - Map of remote clients keyed by clientId (not uid)
	 */

  /** @type {PresenceState} */
  const state = {
    uid: null,
    name: null,
    clientId: null,
    remote: new Map()
  }

  /** Pending join parameters awaiting scene readiness {x, z, yaw} */
  let pendingJoin = null

  /** Time of last move send (for throttle) */
  let lastMoveAt = 0

  /** Flag to ensure we only set up the scene-watcher once */
  let sceneWatcherStarted = false

  /** DOM refs */
  let elDot = null
  let elCount = null

  /* -------------------------- helpers -------------------------- */

  /**
	 * Guard: ensure we have a valid local uid before doing presence work.
	 * @returns {boolean}
	 */
  function hasLocalUid () {
    return state.uid !== null && state.uid !== undefined
  }

  /**
	 * Guard: ensure the Three.js scene is available.
	 * @returns {boolean}
	 */
  function sceneReady () {
    return !!(window.DC && window.DC.scene)
  }

  /**
	 * Send a fire-and-forget presence envelope.
	 * @param {string} op
	 * @param {Object} data
	 */
  function send (op, data) {
    if (typeof window.DC_PRESENCE_SEND === 'function') {
      window.DC_PRESENCE_SEND(op, data)
    }
  }

  /**
	 * Update the presence indicator badge in the top-right HUD.
	 */
  function updateIndicator () {
    const count = state.remote.size + (hasLocalUid() ? 1 : 0)
    if (elCount) elCount.textContent = String(count)
    if (elDot) {
      if (hasLocalUid() && count > 0) {
        elDot.classList.add('active')
      } else {
        elDot.classList.remove('active')
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
  function buildAvatar (uid, name, x, z, yaw) {
    // Lazy-import to avoid referencing THREE before scene is ready
    /* eslint-disable no-undef */
    const scene = window.DC.scene
    const isLocal = hasLocalUid() && String(uid) === String(state.uid)

    // Cylinder body (blue) — use shared geometry/material (Fix 4)
    const body = new THREE.Mesh(AVATAR_BODY_GEO, BODY_MAT)
    body.position.y = 0.14 // sit on ground (y=0)
    body.castShadow = true

    // Sphere head (white) — use shared geometry/material (Fix 4)
    const head = new THREE.Mesh(AVATAR_HEAD_GEO, HEAD_MAT)
    head.position.y = 0.38 // top of cylinder + small gap
    head.castShadow = true

    const group = new THREE.Group()
    group.add(body)
    group.add(head)

    // Name sprite (hidden for local user)
    if (!isLocal && name) {
      const sprite = makeNameSprite(name)
      sprite.position.y = 0.62
      group.add(sprite)
    }

    group.position.set(x, 0, z)
    group.rotation.y = yaw
    scene.add(group)
    /* eslint-enable no-undef */

    return group
  }

  /**
	 * Create a THREE.Sprite name label above an avatar's head.
	 * @param {string} name
	 * @returns {THREE.Sprite}
	 */
  function makeNameSprite (name) {
    /* eslint-disable no-undef */
    // Return cached sprite for this username (Fix 1 — cache the Sprite, not just the texture)
    // MAJOR-6: guard against duplicate entries in _nameSpriteCacheOrder (MINOR-1: use Set for O(1) ops)
    if (_nameSpriteCache.has(name)) {
      const cached = _nameSpriteCache.get(name)
      _nameSpriteCacheOrder.delete(name) // O(1) delete - removes if exists
      _nameSpriteCacheOrder.add(name) // O(1) add - marks as most recently used
      return cached.sprite // sprite already in scene from previous call — no new object created
    }

    // Create a fresh canvas per sprite to eliminate race condition (Fix MINOR-17)
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 48
    const ctx = canvas.getContext('2d')

    // Pill-shaped background
    ctx.fillStyle = 'rgba(18,22,32,0.82)'
    const r = 14
    ctx.beginPath()
    ctx.moveTo(r, 0)
    ctx.lineTo(256 - r, 0)
    ctx.arcTo(256, 0, 256, r, r)
    ctx.lineTo(256, 48 - r)
    ctx.arcTo(256, 48, 256 - r, 48, r)
    ctx.lineTo(r, 48)
    ctx.arcTo(0, 48, 0, 48 - r, r)
    ctx.lineTo(0, r)
    ctx.arcTo(0, 0, r, 0, r)
    ctx.closePath()
    ctx.fill()

    // Name text
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 18px Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(name, 128, 24)

    const texture = new THREE.CanvasTexture(canvas)
    // LRU eviction: if at or over max capacity, dispose and remove oldest (MINOR-1: use Set for O(1) ops)
    if (_nameSpriteCacheOrder.size >= MAX_NAME_SPRITE_CACHE) {
      const oldest = _nameSpriteCacheOrder.values().next().value // O(1) get first (LRU)
      _nameSpriteCacheOrder.delete(oldest) // O(1) delete
      const oldEntry = _nameSpriteCache.get(oldest)
      if (oldEntry) {
        // CRIT-3: remove sprite from its parent group before disposal
        oldEntry.sprite.parent?.remove(oldEntry.sprite)
        oldEntry.texture.dispose()
        if (oldEntry.sprite.material) oldEntry.sprite.material.dispose()
        _nameSpriteCache.delete(oldest)
      }
    }
    _nameSpriteCacheOrder.add(name) // O(1) add
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
    sprite.scale.set(1.6, 0.30, 1)
    _nameSpriteCache.set(name, { texture, sprite })
    /* eslint-enable no-undef */

    return sprite
  }

  /* ---------------------- presence handlers -------------------- */

  /**
	 * Handle dc.presence.joined from the server broadcast.
	 * @param {{uid:number, clientId:number, name:string, x:number, z:number, yaw:number}} data
	 */
  function onJoined (data) {
    console.log('[dc-presence] dc.presence.joined', data)
    // Guard: we don't know our own uid yet — queue it
    if (!hasLocalUid()) {
      pendingJoin = { x: data.x || 0, z: data.z || 0, yaw: data.yaw || 0 }
      return
    }

    // Guard: this is us — we've already rendered ourselves
    // Use clientId (not uid) to distinguish this tab from other tabs with the same session
    if (data.clientId === state.clientId) return

    // Guard: already have this user
    if (state.remote.has(data.clientId)) return

    // Guard: scene must be ready
    if (!sceneReady()) return

    const entry = {
      uid: data.uid,
      name: data.name || '?',
      x: data.x || 0,
      z: data.z || 0,
      yaw: data.yaw || 0,
      ts: data.ts ?? null,
      lastUpdateTime: performance.now(),
      vx: 0,
      vy: 0,
      targetX: data.x || 0,
      targetZ: data.z || 0,
      group: null,
      avatar: null
    }

    entry.group = buildAvatar(data.uid, entry.name, entry.x, entry.z, entry.yaw)
    entry.avatar = entry.group

    state.remote.set(data.clientId, entry)
    updateIndicator()
  }

  /**
	 * Handle dc.presence.updated from the server broadcast.
	 * @param {{uid:number, clientId:number, x:number, z:number, yaw:number}} data
	 */
  function onUpdated (data) {
    // Guard: ignore updates for unknown remote users (use clientId for multi-tab support)
    const entry = state.remote.get(data.clientId)
    if (!entry) return

    // Compute and clamp velocity (same pattern as batch_updated) to prevent
    // stale large velocities from being used in tickAvatars extrapolation
    if (data.x !== undefined || data.z !== undefined) {
      const now = performance.now()
      const dt = (now - (entry.lastUpdateTime || now)) / 1000
      if (dt > 0) {
        const dx = data.x !== undefined ? (data.x - entry.x) : 0
        const dz = data.z !== undefined ? (data.z - entry.z) : 0
        const MAX_VELOCITY = 50
        entry.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dx / dt))
        entry.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dz / dt))
      }
      entry.lastUpdateTime = now
    }

    // Update position
    if (data.x !== undefined) entry.x = data.x
    if (data.z !== undefined) entry.z = data.z

    // Update target position for lerping
    entry.targetX = data.x !== undefined ? data.x : entry.targetX
    entry.targetZ = data.z !== undefined ? data.z : entry.targetZ
    if (data.yaw !== undefined) entry.yaw = data.yaw

    updateIndicator()
  }

  /**
	 * Handle dc.presence.left from the server broadcast.
	 * @param {{uid:number, clientId:number}} data
	 */
  function onLeft (data) {
    const entry = state.remote.get(data.clientId)
    if (!entry) return

    // Dispose cached name sprite texture+sprite and clear from cache (Fix 1)
    // MAJOR-5: guard against invalid names before cache operations
    if (!entry.name || typeof entry.name !== 'string' || entry.name.trim() === '') {
      // Guard against invalid names — still clean up the avatar group below
    } else if (_nameSpriteCache.has(entry.name)) {
      const cached = _nameSpriteCache.get(entry.name)
      cached.texture.dispose()
      if (cached.sprite.material) cached.sprite.material.dispose()
      _nameSpriteCache.delete(entry.name)
      _nameSpriteCacheOrder.delete(entry.name) // O(1) delete (MINOR-1)
    }

    // BUG-1: check group is still in scene before removing
    if (entry.group && entry.group.parent === window.DC.scene) {
      entry.group.traverse(function (child) {
        if (child.isSprite && child.material) {
          if (child.material.map) {
            child.material.map.dispose()
          }
          child.material.dispose()
        }
      })
      window.DC.scene.remove(entry.group)
      entry.group = null
    }
    state.remote.delete(data.clientId)
    updateIndicator()
  }

  /* -------------------------- per-frame lerp ------------------ */

  /**
	 * Lerp all remote avatars toward their target positions each animation frame.
	 * Called from dc-multi's render loop via DC.tick array iteration.
	 * @param {number} dt — delta time in seconds
	 */
  function tickAvatars (dt) {
    if (document.hidden) return

    state.remote.forEach(function (entry) {
      if (!entry.group) return

      const now = performance.now()
      const name = entry.name || '?'

      // Backwards compatible: if no velocity data, use simple lerp
      if (entry.vx === undefined || entry.vy === undefined || entry.lastUpdateTime === undefined) {
        const speed = (typeof dt === 'number' && dt > 0) ? dt : (1 / 60)
        var lerpFactor = LERP_SPEED * speed

        var dx = entry.targetX - entry.group.position.x
        if (Math.abs(dx) > 0.001) {
          entry.group.position.x += dx * Math.min(1, lerpFactor)
        }

        var dz = entry.targetZ - entry.group.position.z
        if (Math.abs(dz) > 0.001) {
          entry.group.position.z += dz * Math.min(1, lerpFactor)
        }

        entry.group.rotation.y = entry.yaw
        return
      }

      // Extrapolation: predict where avatar would be based on velocity
      // Only extrapolate if we haven't received an update in a while (50-500ms)
      const timeSinceUpdate = (now - entry.lastUpdateTime) / 1000 // seconds
      const maxExtrapolationTime = 0.5 // stop extrapolating after 500ms

      // Target position: either the last known position (interpolated) or extrapolated
      let targetX, targetZ

      if (timeSinceUpdate < maxExtrapolationTime) {
        // Extrapolate: predict position based on velocity
        // Clamp extrapolation time to avoid runaway prediction
        const extrapTime = Math.min(timeSinceUpdate, 0.3) // max 300ms of extrapolation
        targetX = entry.x + entry.vx * extrapTime
        targetZ = entry.z + entry.vy * extrapTime
      } else {
        // No recent update — use last known position, no movement
        targetX = entry.x
        targetZ = entry.z
      }

      // Interpolation factor based on time since last update
      // Higher factor = faster catch-up to target
      var lerpFactor = Math.min(1.0, (timeSinceUpdate * LERP_SPEED * 2.0))

      var dx = targetX - entry.group.position.x
      var dz = targetZ - entry.group.position.z

      console.info('[dc-presence] tickAvatar', {name, x: entry.group.position.x, z: entry.group.position.z, targetX, targetZ})

      entry.group.position.x += dx * lerpFactor
      entry.group.position.z += dz * lerpFactor

      // Yaw interpolation (shorter lerp distance, same concept)
      if (entry.yaw !== undefined) {
        const targetYaw = entry.yaw
        const currentYaw = entry.group.rotation.y
        let yawDiff = targetYaw - currentYaw
        // Normalize yaw difference to [-PI, PI]
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2
        entry.group.rotation.y += yawDiff * Math.min(1.0, lerpFactor * 0.5)
      }
    })
  }

  /* -------------------------- scene watcher -------------------- */

  /**
	 * Poll until DC.scene is available, then process any pending join and
	 * set up the per-frame avatar lerp hook.
	 */
  function watchScene () {
    if (sceneWatcherStarted) return
    sceneWatcherStarted = true

    const tryReady = function () {
      if (!sceneReady()) {
        setTimeout(tryReady, 80)
        return
      }

      // Scene is now ready — process pending join
      if (pendingJoin) {
        joinScene(pendingJoin.x, pendingJoin.z, pendingJoin.yaw)
        pendingJoin = null
      }

      // Mark scene ready so tickAvatars runs each frame (Fix 5)
      _sceneReady = true

      // Register tickAvatars into DC's tick callback array — no chaining (Fix 1)
      // Gate at registration level: skip entirely when tab is hidden (avoids call overhead)
      if (window.DC._presenceTicks) {
        window.DC._presenceTicks.push(function (dt) { if (document.hidden) return; tickAvatars(dt) })
      } else {
        window.DC._presenceTicks = [function (dt) { if (document.hidden) return; tickAvatars(dt) }]
        // First presence module to register: wrap DC.tick to iterate the array
        const origTick = window.DC.tick.bind(window.DC)
        window.DC.tick = function (dt) {
          origTick(dt)
          for (let i = 0; i < window.DC._presenceTicks.length; i++) {
            window.DC._presenceTicks[i](dt)
          }
        }
      }
    }

    tryReady()
  }

  /* ----------------------- join / move / leave ----------------- */

  /**
	 * Add our avatar to the scene and broadcast dc.presence.join.
	 * @param {number} x
	 * @param {number} z
	 * @param {number} yaw
	 */
  function joinScene (x, z, yaw) {
    if (!sceneReady() || !hasLocalUid()) return

    // If a remote avatar entry somehow exists for us (stale server state), skip
    if (state.remote.has(state.uid)) return

    send('dc.presence.join', { x, z, yaw })
  }

  /**
	 * Announce our departure from the scene.
	 */
  function leaveScene () {
    if (!hasLocalUid()) return
    send('dc.presence.leave', {})
  }

  /**
	 * Broadcast a position/rotation update (throttled).
	 * @param {number} x
	 * @param {number} z
	 * @param {number} yaw
	 */
  function moveScene (x, z, yaw) {
    const now = performance.now()
    if (now - lastMoveAt < THROTTLE_MS) return
    lastMoveAt = now
    send('dc.presence.move', { x, z, yaw })
  }

  /* ----------------------- event listeners -------------------- */

  /**
	 * Handle dc:auth-success — initialise local state and attempt to join scene.
	 * @param {{uid:number, clientId:number, name:string}} data
	 */
  function onAuthSuccess (data) {
    state.uid = data.uid
    state.name = data.name || ''
    state.clientId = data.clientId || data.uid

    // Watch for scene readiness; onAuthSuccess is also our signal to join
    watchScene()

    // If scene is already ready, join immediately
    if (sceneReady()) {
      joinScene(0, 0, 0)
    } else {
      // Defer join until scene is ready (watchScene handles this)
    }
  }

  /**
	 * Handle dc:auth-failure or dc:disconnected — nuke all remote avatars.
	 */
  function onAuthFailureOrDisconnect () {
    pendingJoin = null // clear any pending join (Fix 2: top, before teardown)

    // Always dispose avatar groups — sceneReady guard was too restrictive (CRIT-3)
    state.remote.forEach(function (entry) {
      // Dispose cached name sprite texture+sprite (Fix 1)
      if (entry.name) {
        const cached = _nameSpriteCache.get(entry.name)
        if (cached) {
          cached.sprite.parent?.remove(cached.sprite)
          cached.texture.dispose()
          if (cached.sprite.material) cached.sprite.material.dispose()
          _nameSpriteCache.delete(entry.name)
          _nameSpriteCacheOrder.delete(entry.name) // O(1) delete (MINOR-1)
        }
      }
      if (entry.group && entry.group.parent === window.DC.scene) {
        entry.group.traverse(function (child) {
          if (child.isSprite && child.material) {
            if (child.material.map) {
              child.material.map.dispose()
            }
            child.material.dispose()
          }
        })
        window.DC.scene.remove(entry.group)
        entry.group = null
      }
    })
    state.remote.clear()
    state.uid = null
    state.name = null
    updateIndicator()
  }

  /**
	 * Handle dc:v1-event — route presence ops to their handlers.
	 * @param {{op:string, data:Object}} detail
	 */
  function onV1Event (detail) {
    const op = detail.op
    const data = detail.data || {}

    if (op === 'dc.presence.joined') {
      onJoined(data)
    } else if (op === 'dc.presence.updated') {
      onUpdated(data)
    } else if (op === 'dc.presence.batch_updated') {
      console.info('[dc-presence] batch_updated', data)
      // data is { clientId1: {uid,name,x,z,yaw,ts,...}, clientId2: {...}, ... }
      // emitted by Events.php when 2+ clients move within a 50ms window
      if (data && typeof data === 'object') {
        const now = performance.now()
        for (const clientId in data) {
          if (!Object.prototype.hasOwnProperty.call(data, clientId)) continue
          if (clientId === state.clientId) continue // skip self
          const entry = data[clientId]
          const remoteEntry = state.remote.get(clientId)
          if (remoteEntry) {
            // Preserve server timestamp if available
            if (entry.ts !== undefined) remoteEntry.ts = entry.ts

            // Calculate velocity from position delta / time delta (backwards compatible)
            const prevX = remoteEntry.x
            const prevZ = remoteEntry.z
            const prevT = remoteEntry.lastUpdateTime || now
            const dt = (now - prevT) / 1000 // seconds since last update

            if (dt > 0) {
              const dvx = entry.x !== undefined ? (entry.x - prevX) / dt : 0
              const dvy = entry.z !== undefined ? (entry.z - prevZ) / dt : 0
              // Clamp velocity to prevent runaway extrapolation (max 50 units/sec)
              const MAX_VELOCITY = 50
              remoteEntry.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dvx))
              remoteEntry.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dvy))
            }

            // Update position
            if (entry.x !== undefined) remoteEntry.x = entry.x
            if (entry.z !== undefined) remoteEntry.z = entry.z
            if (entry.yaw !== undefined) remoteEntry.yaw = entry.yaw

            // Set interpolation target
            if (entry.x !== undefined) remoteEntry.targetX = entry.x
            if (entry.z !== undefined) remoteEntry.targetZ = entry.z

            remoteEntry.lastUpdateTime = now

            // MINOR-10: name might have changed — evict old cache entry so it rebuilds with new name
            if (entry.name && remoteEntry.name !== entry.name) {
              const oldName = remoteEntry.name
              if (oldName && _nameSpriteCache.has(oldName)) {
                const oldCacheEntry = _nameSpriteCache.get(oldName)
                oldCacheEntry.sprite.parent?.remove(oldCacheEntry.sprite)
                // MINOR-10: also remove from avatar group directly in case parent ref was stale
                if (entry.group) {
                  entry.group.remove(oldCacheEntry.sprite)
                }
                oldCacheEntry.sprite.material.map?.dispose()
                oldCacheEntry.sprite.material.dispose()
                _nameSpriteCache.delete(oldName)
                _nameSpriteCacheOrder.delete(oldName) // O(1) delete (MINOR-1)
              }
            }
            if (entry.name) remoteEntry.name = entry.name
          }
          // else: unknown clientId, ignore (could be a stale broadcast for tab we haven't seen join yet)
        }
      }
    } else if (op === 'dc.presence.left') {
      onLeft(data)
    }
  }

  /* -------------------------- bootstrap ----------------------- */

  function init () {
    // Cache DOM refs
    elDot = document.getElementById('dcPresenceDot')
    elCount = document.getElementById('dcPresenceCount')

    // Listen for auth events
    document.addEventListener('dc:auth-success', function (e) { onAuthSuccess(e.detail); updateIndicator(); setTimeout(updateIndicator, 200); })
    document.addEventListener('dc:auth-failure', function () { onAuthFailureOrDisconnect() })
    document.addEventListener('dc:disconnected', function () { onAuthFailureOrDisconnect() })

    // Listen for presence broadcasts from dc-ws.js
    document.addEventListener('dc:v1-event', function (e) { onV1Event(e.detail) })

    updateIndicator()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  /* -------------------------- public API ---------------------- */

  window.DC_PRESENCE_JOIN = joinScene
  window.DC_PRESENCE_MOVE = moveScene
  window.DC_PRESENCE_LEAVE = leaveScene
}())
