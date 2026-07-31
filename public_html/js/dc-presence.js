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
 *   DC_PRESENCE_JOIN([x, z, yaw])  — announce entry into the 3D scene. Coordinates
 *                                    are optional: when omitted (or non-finite) the
 *                                    live player pose is read back from window.DCM,
 *                                    then window.DC.roomSpawn, then (0,0,0).
 *                                    Idempotent — exactly ONE dc.presence.join is
 *                                    sent per authenticated session; a later call
 *                                    carrying better coordinates degrades into a
 *                                    dc.presence.move correction.
 *   DC_PRESENCE_MOVE(x, z, yaw)  — throttled position/rotation broadcast
 *   DC_PRESENCE_LEAVE()          — announce departure from the scene
 *
 * Wire data (frozen v1 envelope `data` payloads)
 *   dc.presence.join  — {x, z, yaw, bounds?}  bounds = {minX,maxX,minZ,maxZ}, sourced
 *                       from window.DC.roomBounds and OMITTED when unavailable, so the
 *                       hub can spawn/wander its bot near real players (BOT-BOUNDS).
 *   dc.presence.move  — {x, z, yaw, bounds?}  same optional bounds, same shape. The join
 *                       almost always loses the race with buildRoom() (DC.scene exists
 *                       immediately, DC.roomBounds only after the datacenter fetch), so
 *                       the extents ride the first move after the room is up instead.
 *                       Sent at most ONCE per room — never on every move.
 *   dc.presence.leave — {}
 *   No client-supplied clientId is ever sent — the hub owns connection identity.
 *
 * State
 *   uid       — our own numeric uid
 *   name      — our own display name
 *   clientId  — our own per-connection id (a 20-char hex STRING from the hub)
 *   remote    — Map<String(clientId), {x, z, yaw, name, ts, vx, vy, lastUpdateTime, targetX, targetZ, group, avatar}>
 *
 * UI element
 *   #dcPresence — floating HUD badge top-right showing connected-user count and
 *                 the hub transport status (#dcPresenceDot / Label / Count).
 *
 * ---------------------------------------------------------------------------
 * Events consumed
 * ---------------------------------------------------------------------------
 *   dc:auth-success   — auth succeeded; initialise local state and join scene
 *   dc:auth-failure   — auth failed; nuke all remote avatars
 *   dc:disconnected   — WS lost; nuke all remote avatars
 *   dc:ws-status      — {status} transport state; reflected on the #dcPresence badge
 *   dc:v1-event       — {op, data} for dc.presence.joined/updated/left
 *
 * Every path here is null-safe by design: with the hub unreachable the page must
 * still work, just without multiplayer.
 */

import * as THREE from "three";

(function () {
  'use strict'

  /* -------------------------- constants -------------------------- */

  const THROTTLE_MS = 150 // minimum interval between dc.presence.move sends
  const LERP_SPEED = 12 // position smoothing rate (1/seconds) — see tickAvatars()
  const YAW_LERP_SPEED = 8 // yaw smoothing rate (1/seconds); slower than position on purpose
  const MAX_EXTRAPOLATION_S = 0.5 // stop extrapolating once an update is this stale
  const MAX_EXTRAPOLATION_CLAMP_S = 0.3 // never predict further ahead than this
  const MAX_TICK_DT_S = 0.25 // clamp a huge frame gap (backgrounded tab) so the blend stays sane
  const WATCH_SCENE_TIMEOUT_MS = 30000 // give up polling for DC.scene after this (see watchScene)

  /* -------------------------- avatar scale -------------------------- */
  /**
   * Remote avatars are built to the SAME scale as the rest of the scene.
   *
   * dc.js works in scene units where UNITS_PER_INCH = 15/70 — i.e. one unit is about
   * 4.67 inches (0.12 m), chosen so a 70-inch person's eye height is ~15 units. These
   * avatars were previously hard-coded at a 0.28-unit body plus a 0.10-radius head,
   * ~0.48 units overall: **5.7 cm tall**, roughly 1/31 life size. They were present,
   * correctly positioned and counted in the presence badge, but far too small to find
   * on screen — which is exactly what "the user count goes to 2 but I can't see the
   * bot" looks like. Derive from the scene's unit instead of magic numbers so this
   * cannot drift out of scale again.
   */
  const UNITS_PER_INCH = 15 / 70
  const AVATAR_HEIGHT_IN = 70   // 5'10", matching dc.js's default options.heightInches
  const AVATAR_HEAD_DIA_IN = 9  // an adult head is ~9in front-to-back
  const AVATAR_WAIST_IN = 34    // same waist->radius derivation dc.js playerRadius() uses

  const AVATAR_TOTAL_H = AVATAR_HEIGHT_IN * UNITS_PER_INCH                    // ~15.0
  const AVATAR_HEAD_R = (AVATAR_HEAD_DIA_IN / 2) * UNITS_PER_INCH             // ~0.96
  const AVATAR_BODY_H = AVATAR_TOTAL_H - (AVATAR_HEAD_DIA_IN * UNITS_PER_INCH) // ~13.07
  const AVATAR_BODY_R = (AVATAR_WAIST_IN / (2 * Math.PI)) * UNITS_PER_INCH    // ~1.16
  // Nameplate: the canvas is 256x48, so the sprite MUST stay at 16:3 or the text
  // distorts. Sized to read from across the room without dwarfing the avatar.
  const NAME_SPRITE_W = 6.0
  const NAME_SPRITE_H = NAME_SPRITE_W * (48 / 256)                            // 1.125
  const NAME_SPRITE_GAP = 1.2   // clearance between the top of the head and the plate

  /* -------------------------- shared geometry/materials -------------------------- */
  const AVATAR_BODY_GEO = new THREE.CylinderGeometry(AVATAR_BODY_R, AVATAR_BODY_R, AVATAR_BODY_H, 12)
  const AVATAR_HEAD_GEO = new THREE.SphereGeometry(AVATAR_HEAD_R, 16, 12)
  const BODY_MAT = new THREE.MeshLambertMaterial({ color: 0x2255cc })
  const HEAD_MAT = new THREE.MeshLambertMaterial({ color: 0xf0f4ff })

  /* -------------------------- scene-ready flag (Fix 5) -------------------------- */
  let _sceneReady = false

  /* -------------------------- name-sprite cache -------------------------- */
  /* eslint-disable no-undef */
  /* Each sprite gets its own 256x48 canvas (makeNameSprite) — the module-level "canvas
	 * pool" that used to live here was superseded by that and left unread. */

  /** @type {Map<string, {texture: THREE.CanvasTexture, sprite: THREE.Sprite}>} Cache sprite+texture per username (Fix 1) */
  const _nameSpriteCache = new Map()
  const _nameSpriteCacheOrder = new Set() // O(1) add/has/delete; insertion order maintained for LRU
  const MAX_NAME_SPRITE_CACHE = 64
  /**
	 * Sprites the cache owns. The cache is the SINGLE owner of a name sprite's material and
	 * texture, so detachGroup() must not dispose one out from under it — the same sprite may
	 * still be cached for (and shown by) another avatar with the same display name.
	 * @type {WeakSet<THREE.Sprite>}
	 */
  const _cachedSprites = new WeakSet()
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

  /** Pending join pose awaiting uid + scene readiness {x, z, yaw} */
  let pendingJoin = null

  /** True once dc.presence.join has been sent for the CURRENT authenticated session */
  let joined = false

  /** The pose we announced with that join, so a better-informed call becomes a correction */
  let joinedPose = null

  /**
	 * CONTRACT BOT-BOUNDS — the room extents last actually put on the wire, or null when the
	 * hub has none for us. Compared BY VALUE, so a location switch that hands us a fresh
	 * object with different extents re-reports while a rebuild of the same room does not.
	 * Nulled on a new session, on leave, and on respawn (the room was rebuilt).
	 * @type {{minX:number, maxX:number, minZ:number, maxZ:number}|null}
	 */
  let reportedBounds = null

  /** Time of last move send (for throttle) */
  let lastMoveAt = 0

  /** Flag to ensure we only set up the scene-watcher once */
  let sceneWatcherStarted = false

  /** Latest transport status from dc:ws-status; null until dc-ws reports one */
  let wsStatus = null

  /** DOM refs */
  let elBadge = null
  let elDot = null
  let elLabel = null
  let elCount = null

  /**
	 * How each dc:ws-status value is reflected on the #dcPresence badge. `color: null`
	 * means "let the stylesheet's #dcPresenceDot.active rule win" (dc-shared.css) — we
	 * only ever use inline styles / existing classes because the CSS is not ours to edit.
	 */
  const STATUS_UI = {
    connecting: { prefix: 'Connecting… ', color: '#e8b23a', glow: true, title: 'Connecting to the multiplayer hub…' },
    connected: { prefix: 'Users: ', color: null, glow: false, title: 'Multiplayer connected' },
    disconnected: { prefix: 'Offline · ', color: '#d9534f', glow: true, title: 'Multiplayer unavailable — hub disconnected' },
    error: { prefix: 'Offline · ', color: '#d9534f', glow: true, title: 'Multiplayer unavailable — hub error' },
    exhausted: { prefix: 'Offline · ', color: '#8a8f98', glow: false, title: 'Multiplayer unavailable — reconnect attempts exhausted' }
  }

  /* -------------------------- helpers -------------------------- */

  /**
	 * Debug-only logging. Presence runs inside the render loop, so nothing here may
	 * log unconditionally (see the per-frame log this replaced).
	 */
  function dbg () {
    if (!window.DC_DEBUG) return
    console.log.apply(console, ['[dc-presence]'].concat(Array.prototype.slice.call(arguments)))
  }

  /**
	 * @param {*} v
	 * @returns {boolean} true for a usable, finite number
	 */
  function isNum (v) {
    return typeof v === 'number' && isFinite(v)
  }

  /**
	 * Coerce a remote-supplied coordinate to something safe to put in the scene graph.
	 * `x || 0` already turned NaN into 0 (NaN is falsy) but let ±Infinity straight through,
	 * and a poisoned Object3D.position propagates through the matrix world — one bad frame
	 * from the hub can make an avatar disappear permanently.
	 * @param {*} v
	 * @param {number} fallback
	 * @returns {number}
	 */
  function num (v, fallback) {
    return isNum(v) ? v : fallback
  }

  /**
	 * Normalise a server-supplied client identifier to a string. Hub clientIds are
	 * 20-char hex strings, but object keys are always strings anyway — forcing the
	 * type keeps state.remote lookups and the skip-self test consistent even if a
	 * numeric id ever shows up.
	 * @param {*} v
	 * @returns {string|null}
	 */
  function idKey (v) {
    if (v === null || v === undefined || v === '') return null
    return String(v)
  }

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
	 * Send a fire-and-forget presence envelope. Every presence op funnels through
	 * here, so this is where the DC_PRESENCE_ENABLED kill-switch lives (it used to
	 * sit in the duplicate DC_PRESENCE_* shims in dc-ws.js, which are gone).
	 * @param {string} op
	 * @param {Object} data
	 */
  function send (op, data) {
    if (window.DC_PRESENCE_ENABLED === false) {
      dbg('presence disabled — suppressed', op)
      return
    }
    if (typeof window.DC_PRESENCE_SEND === 'function') {
      window.DC_PRESENCE_SEND(op, data)
    }
  }

  /**
	 * Replace the leading text of #dcPresenceLabel WITHOUT clobbering the
	 * #dcPresenceCount span it wraps (markup: `<span id=Label>Users: <span id=Count>`).
	 * @param {string} text
	 */
  function setLabelPrefix (text) {
    if (!elLabel) return
    const first = elLabel.firstChild
    if (first && first.nodeType === 3) {
      first.nodeValue = text
      return
    }
    if (elCount && elLabel.insertBefore && document.createTextNode) {
      elLabel.insertBefore(document.createTextNode(text), elCount)
    }
  }

  /**
	 * Update the presence indicator badge in the top-right HUD: the connected-user
	 * count plus (once dc-ws has reported one) the hub transport status, so a dead
	 * hub is visibly "Offline" instead of silently looking like "nobody else here".
	 */
  function updateIndicator () {
    const count = state.remote.size + (hasLocalUid() ? 1 : 0)
    if (elCount) elCount.textContent = String(count)

    const ui = wsStatus ? STATUS_UI[wsStatus] : null
    if (!ui) {
      // No transport status reported (dc-ws absent or older) — keep legacy behaviour.
      if (elDot && elDot.classList) {
        if (hasLocalUid() && count > 0) elDot.classList.add('active')
        else elDot.classList.remove('active')
      }
      return
    }

    setLabelPrefix(ui.prefix)
    if (elBadge && elBadge.setAttribute) elBadge.setAttribute('title', ui.title)
    if (!elDot) return

    // "Live" = transport up AND we are actually in the scene. Connected-but-alone
    // still reads green with a count of 1; anything else is visibly not-multiplayer.
    const live = wsStatus === 'connected' && hasLocalUid() && count > 0
    if (live) {
      if (elDot.classList) elDot.classList.add('active')
      if (elDot.style) { elDot.style.background = ''; elDot.style.boxShadow = '' }
      return
    }
    if (elDot.classList) elDot.classList.remove('active')
    if (elDot.style) {
      const color = ui.color || '#888'
      elDot.style.background = color
      elDot.style.boxShadow = ui.glow ? ('0 0 5px ' + color) : 'none'
    }
  }

  /**
	 * CONTRACT STATUS-EVENT — reflect dc-ws's transport status on the badge.
	 * @param {{status:string}} detail
	 */
  function onWsStatus (detail) {
    applyWsStatus(detail && detail.status)
  }

  /**
	 * @param {*} status one of the STATUS_UI keys; anything else is ignored
	 */
  function applyWsStatus (status) {
    if (!status || !Object.prototype.hasOwnProperty.call(STATUS_UI, status)) return
    wsStatus = status
    updateIndicator()
  }

  /**
	 * dc-ws.js is loaded BEFORE this module (both `type="module"`, so both run in
	 * document order) and calls _setStatus('connecting') during its own init — that
	 * first dc:ws-status event is dispatched before our listener exists and is always
	 * missed. dc-ws also records the value on the client, so read it back once at
	 * startup instead of leaving the badge blank until the socket's first async
	 * callback (which on an unreachable hub can be seconds away).
	 */
  function seedWsStatus () {
    const client = window.DC_WS
    if (!client) return // standalone dc.html, or dc-ws failed to load — stay legacy
    let status = client.status
    if (!status && typeof client.getState === 'function') {
      try { status = (client.getState() || {}).status } catch (e) { status = null }
    }
    applyWsStatus(status)
  }

  /* ---------------------- avatar mesh -------------------------- */

  /**
	 * Build a simple avatar (cylinder body + sphere head + name sprite) for a remote user.
	 * Nameplate is hidden for the local user (can't see your own nameplate).
	 *
	 * @param {string} key  the remote's map key (per-connection clientId), NOT the uid —
	 *                      identity in this module is per CONNECTION, not per account
	 * @param {string} name
	 * @param {number} x
	 * @param {number} z
	 * @param {number} yaw
	 * @returns {THREE.Group}
	 */
  function buildAvatar (key, name, x, z, yaw) {
    // Lazy-import to avoid referencing THREE before scene is ready
    /* eslint-disable no-undef */
    const scene = window.DC.scene
    // Identity is per-CONNECTION (clientId), matching the rest of the module. This used to
    // compare `uid`, which could only ever be true for ANOTHER TAB OF THE SAME USER —
    // onJoined() has already filtered our own connection out by clientId — so the one
    // avatar that does want a nameplate was the only one that never got one, and your
    // other tab rendered anonymous.
    const isLocal = state.clientId !== null && key === idKey(state.clientId)

    // Cylinder body (blue) — use shared geometry/material (Fix 4).
    // A CylinderGeometry is centred on its own origin, so lift it by half its height
    // to stand it on the floor (the group sits at y=0).
    const body = new THREE.Mesh(AVATAR_BODY_GEO, BODY_MAT)
    body.position.y = AVATAR_BODY_H / 2
    body.castShadow = true

    // Sphere head (white) — use shared geometry/material (Fix 4).
    // Centre one head-radius above the top of the body, so the crown lands exactly at
    // AVATAR_TOTAL_H and the whole figure is a true 70 inches tall.
    const head = new THREE.Mesh(AVATAR_HEAD_GEO, HEAD_MAT)
    head.position.y = AVATAR_BODY_H + AVATAR_HEAD_R
    head.castShadow = true

    const group = new THREE.Group()
    group.add(body)
    group.add(head)

    // Name sprite (hidden for local user)
    if (!isLocal && name) {
      const sprite = makeNameSprite(name)
      sprite.position.y = AVATAR_TOTAL_H + NAME_SPRITE_GAP
      group.add(sprite)
    }

    group.position.set(x, 0, z)
    group.rotation.y = yaw
    scene.add(group)
    /* eslint-enable no-undef */

    return group
  }

  /**
	 * Drop a cached name sprite and free its GPU resources.
	 *
	 * The cache is the SINGLE owner of a name sprite's material + texture — this is the only
	 * place they are disposed. Detaching an avatar group must not do it (see detachGroup),
	 * because the very same sprite object may still be cached for another avatar sharing the
	 * display name (two browser tabs of one admin), and a disposed material renders as a
	 * blank/warning nameplate for the survivor.
	 * @param {string} name
	 */
  function disposeCachedName (name) {
    const cached = _nameSpriteCache.get(name)
    _nameSpriteCache.delete(name)
    _nameSpriteCacheOrder.delete(name) // O(1) delete (MINOR-1)
    if (!cached) return
    const sprite = cached.sprite
    if (sprite) {
      _cachedSprites.delete(sprite)
      // CRIT-3: detach from whatever group is showing it before disposal.
      if (sprite.parent && typeof sprite.parent.remove === 'function') sprite.parent.remove(sprite)
      const mat = sprite.material
      if (mat && typeof mat.dispose === 'function') mat.dispose()
    }
    if (cached.texture && typeof cached.texture.dispose === 'function') cached.texture.dispose()
  }

  /**
	 * Is `name` still the display name of a remote avatar other than `exceptKey`?
	 * Guards against freeing a shared nameplate while another avatar is still using it.
	 * @param {string} name
	 * @param {string|null} exceptKey
	 * @returns {boolean}
	 */
  function nameStillInUse (name, exceptKey) {
    let inUse = false
    state.remote.forEach(function (other, key) {
      if (!inUse && key !== exceptKey && other && other.name === name) inUse = true
    })
    return inUse
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
    // LRU eviction: at or over capacity, free the oldest entry that is NOT currently on
    // screen. Evicting blindly disposed the texture+material of a sprite still parented to
    // a live avatar group, which renders as a blank nameplate plus WebGL warnings. Entries
    // still in use are skipped, so the cache is bounded by
    // MAX_NAME_SPRITE_CACHE + (live avatars) rather than growing without limit.
    if (_nameSpriteCacheOrder.size >= MAX_NAME_SPRITE_CACHE) {
      let victim = null
      for (const candidate of _nameSpriteCacheOrder) { // insertion order === LRU order
        const entry = _nameSpriteCache.get(candidate)
        if (!entry || !entry.sprite || !entry.sprite.parent) { victim = candidate; break }
      }
      if (victim !== null) disposeCachedName(victim)
    }
    _nameSpriteCacheOrder.add(name) // O(1) add
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }))
    sprite.scale.set(NAME_SPRITE_W, NAME_SPRITE_H, 1)
    _nameSpriteCache.set(name, { texture, sprite })
    _cachedSprites.add(sprite)
    /* eslint-enable no-undef */

    return sprite
  }

  /* ---------------------- presence handlers -------------------- */

  /**
	 * Handle dc.presence.joined from the server broadcast.
	 * @param {{uid:number, clientId:string, name:string, x:number, z:number, yaw:number}} data
	 */
  function onJoined (data) {
    dbg('dc.presence.joined', data)
    // Guard: we don't know our own uid yet, so we cannot tell this broadcast from
    // our own echo. Ignore it — our own join is driven by joinScene(), never by a
    // remote peer's coordinates.
    if (!hasLocalUid()) return

    const key = idKey(data.clientId) ?? idKey(data.uid)
    if (key === null) return

    // Guard: this is us — we've already rendered ourselves
    // Use clientId (not uid) to distinguish this tab from other tabs with the same session
    if (state.clientId !== null && key === idKey(state.clientId)) return

    // Guard: already have this user
    if (state.remote.has(key)) return

    // Guard: scene must be ready
    if (!sceneReady()) return

    const entry = {
      uid: data.uid,
      name: data.name || '?',
      x: num(data.x, 0),
      z: num(data.z, 0),
      yaw: num(data.yaw, 0),
      ts: data.ts ?? null,
      lastUpdateTime: performance.now(),
      vx: 0,
      vy: 0,
      targetX: num(data.x, 0),
      targetZ: num(data.z, 0),
      group: null,
      avatar: null
    }

    entry.group = buildAvatar(key, entry.name, entry.x, entry.z, entry.yaw)
    entry.avatar = entry.group

    state.remote.set(key, entry)
    updateIndicator()
  }

  /**
	 * Handle dc.presence.updated from the server broadcast.
	 * @param {{uid:number, clientId:string, x:number, z:number, yaw:number}} data
	 */
  function onUpdated (data) {
    // Guard: ignore updates for unknown remote users (use clientId for multi-tab support)
    const key = idKey(data.clientId) ?? idKey(data.uid)
    const entry = key === null ? null : state.remote.get(key)
    if (!entry) return

    // Compute and clamp velocity (same pattern as batch_updated) to prevent
    // stale large velocities from being used in tickAvatars extrapolation.
    // Non-finite coordinates are dropped rather than assigned: NaN/Infinity in entry.x
    // poisons the extrapolation and (via buildAvatar/group.position) the matrix world.
    const hasX = isNum(data.x)
    const hasZ = isNum(data.z)
    if (hasX || hasZ) {
      const now = performance.now()
      const dt = (now - (entry.lastUpdateTime || now)) / 1000
      if (dt > 0) {
        const dx = hasX ? (data.x - entry.x) : 0
        const dz = hasZ ? (data.z - entry.z) : 0
        const MAX_VELOCITY = 50
        entry.vx = num(Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dx / dt)), 0)
        entry.vy = num(Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dz / dt)), 0)
      }
      entry.lastUpdateTime = now
    }

    // Update position
    if (hasX) entry.x = data.x
    if (hasZ) entry.z = data.z

    // Update target position for lerping
    if (hasX) entry.targetX = data.x
    if (hasZ) entry.targetZ = data.z
    if (isNum(data.yaw)) entry.yaw = data.yaw

    // NO updateIndicator() here on purpose. A position update cannot change
    // state.remote.size, so the count is provably unchanged — and this runs once per
    // moving peer per network tick (N clients x ~7/s), so the DOM writes it used to do
    // were pure waste. Only join/left/auth/disconnect can move the count, and those all
    // call it. dc.presence.batch_updated already omitted it for the same reason.
  }

  /**
	 * Detach an avatar group from the scene and dispose its sprite materials.
	 * Null-safe on purpose: window.DC may never exist (hub-only page, dc.js failed
	 * to boot) and teardown must not throw in that case.
	 * @param {THREE.Group|null} group
	 */
  function detachGroup (group) {
    if (!group) return
    if (typeof group.traverse === 'function') {
      group.traverse(function (child) {
        // Cache-owned name sprites are shared between avatars with the same display name
        // and are disposed by disposeCachedName() alone — freeing one here would blank the
        // other holder's nameplate (and double-dispose the texture).
        if (child.isSprite && child.material && !_cachedSprites.has(child)) {
          if (child.material.map) child.material.map.dispose()
          child.material.dispose()
        }
      })
    }
    const scene = (window.DC && window.DC.scene) || null
    if (scene && group.parent === scene && typeof scene.remove === 'function') scene.remove(group)
    else if (group.parent && typeof group.parent.remove === 'function') group.parent.remove(group)
  }

  /**
	 * Handle dc.presence.left from the server broadcast.
	 * @param {{uid:number, clientId:string}} data
	 */
  function onLeft (data) {
    const key = idKey(data.clientId) ?? idKey(data.uid)
    const entry = key === null ? null : state.remote.get(key)
    if (!entry) return

    // Dispose cached name sprite texture+sprite and clear from cache (Fix 1)
    // MAJOR-5: guard against invalid names before cache operations
    // ...unless another avatar still answers to the same display name (two tabs of one
    // admin), in which case the cache entry stays live for them.
    if (entry.name && typeof entry.name === 'string' && entry.name.trim() !== '' &&
        !nameStillInUse(entry.name, key)) {
      disposeCachedName(entry.name)
    }

    detachGroup(entry.group)
    entry.group = null
    state.remote.delete(key)
    updateIndicator()
  }

  /* -------------------------- per-frame lerp ------------------ */

  /**
	 * Smooth all remote avatars toward their target pose, once per animation frame.
	 * Called from dc-multi's render loop via the DC._presenceTicks array.
	 *
	 * The blend factor is derived from the FRAME dt, never from the time since the
	 * last network update: at the 150ms send rate a network-derived factor reaches
	 * 1.0 and the avatar teleports, and it also makes the motion frame-rate
	 * dependent. `1 - exp(-k*dt)` is the frame-rate-independent form — two half
	 * steps land exactly where one full step does.
	 *
	 * Velocity is still used to EXTRAPOLATE the target position between updates;
	 * only the blend is dt-driven. Entries without velocity data simply aim at their
	 * last reported position — one code path for both cases.
	 *
	 * Hot loop: no allocations, no logging.
	 * @param {number} dt — delta time in seconds
	 */
  function tickAvatars (dt) {
    if (document.hidden) return
    if (state.remote.size === 0) return

    const step = isNum(dt) && dt > 0 ? Math.min(dt, MAX_TICK_DT_S) : (1 / 60)
    const blend = 1 - Math.exp(-LERP_SPEED * step)
    const yawBlend = 1 - Math.exp(-YAW_LERP_SPEED * step)
    const now = performance.now()

    state.remote.forEach(function (entry) {
      const group = entry.group
      if (!group) return

      let targetX = entry.targetX
      let targetZ = entry.targetZ

      if (isNum(entry.vx) && isNum(entry.vy) && isNum(entry.lastUpdateTime)) {
        const timeSinceUpdate = (now - entry.lastUpdateTime) / 1000
        if (timeSinceUpdate > 0 && timeSinceUpdate < MAX_EXTRAPOLATION_S) {
          // Predict ahead of the last packet, clamped so a stale velocity can't run away.
          const extrapTime = Math.min(timeSinceUpdate, MAX_EXTRAPOLATION_CLAMP_S)
          targetX = entry.x + entry.vx * extrapTime
          targetZ = entry.z + entry.vy * extrapTime
        } else {
          targetX = entry.x
          targetZ = entry.z
        }
      }

      if (!isNum(targetX)) targetX = group.position.x
      if (!isNum(targetZ)) targetZ = group.position.z

      group.position.x += (targetX - group.position.x) * blend
      group.position.z += (targetZ - group.position.z) * blend

      if (isNum(entry.yaw)) {
        let yawDiff = entry.yaw - group.rotation.y
        // Normalise to [-PI, PI] so the avatar turns the short way round
        while (yawDiff > Math.PI) yawDiff -= Math.PI * 2
        while (yawDiff < -Math.PI) yawDiff += Math.PI * 2
        group.rotation.y += yawDiff * yawBlend
      }
    })
  }

  /** Latch so a broken tick complains once, not 60 times a second. */
  let _tickErrorLogged = false

  /**
	 * The callback registered into DC._presenceTicks.
	 *
	 * The try/catch is the point. dc.js's DC.tick wrapper calls these AFTER the render, and
	 * DC.tick is driven by WebGLRenderer.setAnimationLoop, which schedules the next frame
	 * only after the callback returns — so a single throw from presence code (a malformed
	 * hub frame reaching the scene graph, a disposed material) would kill the animation loop
	 * for good and freeze the whole datacenter. Multiplayer is the optional part; the scene
	 * is not. Swallow, complain once, keep rendering.
	 * @param {number} dt
	 */
  function presenceTick (dt) {
    if (document.hidden) return
    try {
      tickAvatars(dt)
    } catch (e) {
      if (!_tickErrorLogged) {
        _tickErrorLogged = true
        console.warn('[dc-presence] avatar tick failed; multiplayer smoothing disabled for this frame', e)
      }
    }
  }

  /* -------------------------- scene watcher -------------------- */

  /**
	 * Poll until DC.scene is available, then process any pending join and
	 * set up the per-frame avatar lerp hook.
	 */
  function watchScene () {
    if (sceneWatcherStarted) return
    sceneWatcherStarted = true
    const deadline = Date.now() + WATCH_SCENE_TIMEOUT_MS

    const tryReady = function () {
      if (!sceneReady()) {
        if (Date.now() > deadline) {
          // dc.js never produced a scene (module blocked, WebGL init threw, standalone
          // page). Stop the 80ms chain instead of polling for the lifetime of the tab,
          // and re-arm the latch so a later auth-success / join starts a fresh watch if
          // the scene does eventually turn up. pendingJoin is left intact for it.
          sceneWatcherStarted = false
          dbg('scene watcher gave up after', WATCH_SCENE_TIMEOUT_MS, 'ms')
          return
        }
        setTimeout(tryReady, 80)
        return
      }

      // Scene is now ready — replay the pending join. Clear it FIRST so joinScene
      // can re-arm it when we still have no uid (auth not finished yet).
      if (pendingJoin) {
        const p = pendingJoin
        pendingJoin = null
        joinScene(p.x, p.z, p.yaw)
      }

      // Mark scene ready so tickAvatars runs each frame (Fix 5)
      _sceneReady = true

      // Register tickAvatars into DC's tick callback array — no chaining (Fix 1)
      // Gate at registration level: skip entirely when tab is hidden (avoids call overhead)
      if (window.DC._presenceTicks) {
        window.DC._presenceTicks.push(presenceTick)
      } else {
        window.DC._presenceTicks = [presenceTick]
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
	 * Resolve the pose to announce. Explicit arguments win — dc-multi passes its live
	 * player position. Otherwise ask dc-multi for it (window.DCM), then fall back to
	 * the room's spawn point, and only then to the world origin. Announcing (0,0,0)
	 * put everyone's avatar at the world origin until their first step.
	 * @param {number} [x]
	 * @param {number} [z]
	 * @param {number} [yaw]
	 * @returns {{x:number, z:number, yaw:number}}
	 */
  function resolveSelfPose (x, z, yaw) {
    let px = x
    let pz = z
    let pyaw = yaw
    const dcm = window.DCM
    const spawn = (window.DC && window.DC.roomSpawn) || null

    if (!isNum(px) || !isNum(pz)) {
      let live = null
      if (dcm && typeof dcm.getPosition === 'function') {
        try { live = dcm.getPosition() } catch (e) { live = null }
      }
      if (live && isNum(live.x) && isNum(live.z)) {
        px = live.x
        pz = live.z
      } else if (spawn && isNum(spawn.x) && isNum(spawn.z)) {
        px = spawn.x
        pz = spawn.z
      } else {
        px = 0
        pz = 0
      }
    }

    if (!isNum(pyaw)) {
      let facing = null
      if (dcm && typeof dcm.getFacing === 'function') {
        try { facing = dcm.getFacing() } catch (e) { facing = null }
      }
      if (isNum(facing)) {
        pyaw = facing
      } else if (spawn && isNum(spawn.x) && isNum(spawn.z) && isNum(spawn.lookX) && isNum(spawn.lookZ)) {
        pyaw = Math.atan2(spawn.lookX - spawn.x, spawn.lookZ - spawn.z)
      } else {
        pyaw = 0
      }
    }

    return { x: px, z: pz, yaw: pyaw }
  }

  /**
	 * CONTRACT BOT-BOUNDS — the world extents the hub should spawn/wander its bot
	 * within. dc.js sets DC.roomBounds when the scene builds and it is null before
	 * that; return null so the field is OMITTED and the server keeps its own
	 * fallback constants.
	 * @returns {{minX:number, maxX:number, minZ:number, maxZ:number}|null}
	 */
  function selfBounds () {
    const b = (window.DC && window.DC.roomBounds) || null
    if (!b) return null
    if (!isNum(b.minX) || !isNum(b.maxX) || !isNum(b.minZ) || !isNum(b.maxZ)) return null
    if (b.maxX <= b.minX || b.maxZ <= b.minZ) return null
    return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ }
  }

  /**
	 * CONTRACT BOT-BOUNDS — the bounds to attach to the NEXT outgoing presence frame, or
	 * null when there is nothing new to report.
	 *
	 * Why this exists: dc.js exposes DC.scene as soon as init() runs, but only assigns
	 * DC.roomBounds at the end of buildRoom(), which waits on the ~1.5MB
	 * /ajax/datacenter.php fetch. Auth completes in ~100-300ms, so joinScene() essentially
	 * always wins that race, selfBounds() returns null, and the join ships with no bounds —
	 * leaving the hub's bot wandering its ±50 fallback box forever. Delaying the join until
	 * the room exists is NOT the fix: that would hold the local user out of the presence
	 * list, and hang presence completely in a scene that never builds a room. Instead the
	 * bounds ride along on the corrective move that already happens once the room is up.
	 *
	 * Shape is identical to the join contract: {minX,maxX,minZ,maxZ}. Sent at most once per
	 * room — dc.presence.move is a 50ms-batched hot path and must not carry it every frame.
	 * @returns {{minX:number, maxX:number, minZ:number, maxZ:number}|null}
	 */
  function pendingBounds () {
    const b = selfBounds()
    if (!b) return null // no room (yet), or a degenerate box — selfBounds() already vetted it
    // Value comparison, not identity: dc.js hands out a fresh object on every buildRoom(),
    // so identity would re-report the same room forever, and a location switch is only
    // observable as a CHANGE in the numbers (clearScene's null gap happens synchronously
    // inside displayDatacenter(), so no send can ever see it).
    if (reportedBounds &&
        reportedBounds.minX === b.minX && reportedBounds.maxX === b.maxX &&
        reportedBounds.minZ === b.minZ && reportedBounds.maxZ === b.maxZ) return null
    return b
  }

  /**
	 * Announce our entry into the 3D scene.
	 *
	 * Idempotent: exactly ONE dc.presence.join goes out per authenticated session.
	 * dc-presence joins on dc:auth-success and dc-multi re-announces after its spawn
	 * / on re-lock; whichever runs second finds `joined` already set and degrades
	 * into a dc.presence.move correction if it knows better coordinates.
	 *
	 * @param {number} [x]   omit to use the live player position
	 * @param {number} [z]
	 * @param {number} [yaw]
	 */
  function joinScene (x, z, yaw) {
    if (window.DC_PRESENCE_ENABLED === false) return

    // Not ready to announce yet. Park only what the CALLER supplied and re-resolve at
    // replay time — resolving now would freeze in a fallback (the (0,0,0) origin) even
    // though the real pose becomes available moments later as the room builds.
    if (!hasLocalUid() || !sceneReady()) {
      pendingJoin = {
        x: isNum(x) ? x : null,
        z: isNum(z) ? z : null,
        yaw: isNum(yaw) ? yaw : null
      }
      watchScene()
      return
    }

    const pose = resolveSelfPose(x, z, yaw)

    // If a remote avatar entry somehow exists for our own connection (stale server
    // state), skip — we'd be rendering ourselves twice.
    if (state.clientId !== null && state.remote.has(idKey(state.clientId))) return

    if (joined) {
      // CONTRACT BOT-BOUNDS: this corrective move is the first frame that can carry the
      // room extents — the join itself usually went out before buildRoom() ran. Send it
      // even when the pose is unchanged, otherwise the bounds would wait on the player
      // taking a step.
      const bounds = pendingBounds()
      const moved = !joinedPose ||
        Math.abs(joinedPose.x - pose.x) > 0.01 ||
        Math.abs(joinedPose.z - pose.z) > 0.01 ||
        Math.abs(joinedPose.yaw - pose.yaw) > 0.01
      if (moved || bounds) {
        joinedPose = pose
        lastMoveAt = performance.now()
        const move = { x: pose.x, z: pose.z, yaw: pose.yaw }
        if (bounds) {
          move.bounds = bounds
          reportedBounds = bounds
        }
        send('dc.presence.move', move)
      }
      return
    }

    const data = { x: pose.x, z: pose.z, yaw: pose.yaw }
    const bounds = pendingBounds()
    if (bounds) {
      data.bounds = bounds
      reportedBounds = bounds
    }

    joined = true
    joinedPose = pose
    pendingJoin = null
    dbg('join', data)
    send('dc.presence.join', data)
  }

  /**
	 * Announce our departure from the scene. Clears the join latch so a later
	 * re-entry (pointer re-lock, reconnect) can announce itself again.
	 */
  function leaveScene () {
    joined = false
    joinedPose = null
    pendingJoin = null
    // The hub drops our presence record on leave, so the next join owes it the bounds again.
    reportedBounds = null
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
    // Track the last pose we told the hub so a re-announce (pointer re-lock) can tell
    // "nothing changed" from "correct my position".
    if (isNum(x) && isNum(z) && isNum(yaw)) joinedPose = { x, z, yaw }
    const data = { x, z, yaw }
    // CONTRACT BOT-BOUNDS: piggyback the one-per-room extents report on the first move
    // that follows the room build. Resolved AFTER the throttle check so this stays off
    // the per-frame path, and cleared immediately so no later move repeats it.
    const bounds = pendingBounds()
    if (bounds) {
      data.bounds = bounds
      reportedBounds = bounds
    }
    send('dc.presence.move', data)
  }

  /**
	 * dc.js dispatches dc:respawn from spawnInside(), which runs immediately after
	 * buildRoom() on the initial load AND on every location switch — i.e. exactly when
	 * DC.roomBounds flips from null to the new room's extents.
	 *
	 * CONTRACT BOT-BOUNDS: this is the "bounds became available but nothing else triggered
	 * a move" path. Without it the report waits on the player walking, which they may never
	 * do (attract mode, model failed to load, AFK).
	 *
	 * When we have NOT joined yet — the location-switch case, because dc.js's clearScene()
	 * calls DC_PRESENCE_LEAVE() before rebuilding — we only re-arm; the imminent
	 * dc.presence.join carries the bounds itself, which is the documented carrier.
	 */
  function onRespawn () {
    // A rebuilt room is a new room, so re-arm UNCONDITIONALLY: this also fires from dc.js's
    // "you re-locked while stuck in a rack" recovery, where the extents are unchanged but
    // re-stating them is harmless (bounded by user clicks, never per frame).
    reportedBounds = null
    if (window.DC_PRESENCE_ENABLED === false) return // no hub: nothing to report to
    if (!joined || !hasLocalUid()) return
    const bounds = pendingBounds()
    if (!bounds) return
    const pose = resolveSelfPose()
    reportedBounds = bounds
    joinedPose = pose
    lastMoveAt = performance.now()
    send('dc.presence.move', { x: pose.x, z: pose.z, yaw: pose.yaw, bounds })
  }

  /* ----------------------- event listeners -------------------- */

  /**
	 * Handle dc:auth-success — initialise local state and join the scene at our
	 * REAL position (never the hardcoded world origin).
	 * @param {{uid:number, clientId:string, name:string, session:string, hub_time:number}} data
	 */
  function onAuthSuccess (data) {
    const d = data || {}
    state.uid = d.uid
    state.name = d.name || ''
    state.clientId = idKey(d.clientId) ?? idKey(d.uid)

    // Fresh session — exactly one join must go out for it.
    joined = false
    joinedPose = null
    // Fresh session on the hub too: it has no bounds for us yet.
    reportedBounds = null
    // Re-arm presence after a previous disconnect/auth-failure turned it off.
    window.DC_PRESENCE_ENABLED = true

    // Watch for scene readiness; onAuthSuccess is also our signal to join
    watchScene()

    // Join with no coordinates: joinScene() reads the live player pose back from
    // dc-multi (window.DCM), falling back to DC.roomSpawn. If the scene is not up
    // yet it parks the pose and watchScene() replays it.
    pendingJoin = null
    joinScene()
  }

  /**
	 * Handle dc:auth-failure or dc:disconnected — nuke all remote avatars.
	 */
  function onAuthFailureOrDisconnect () {
    pendingJoin = null // clear any pending join (Fix 2: top, before teardown)
    joined = false // a reconnect must announce itself again
    joinedPose = null
    reportedBounds = null // ...and re-report the room extents with it
    // Suppress every presence send until the next successful auth. dc-multi sets the
    // same flag; doing it here too keeps presence correct without dc-multi loaded.
    window.DC_PRESENCE_ENABLED = false

    // Always dispose avatar groups — sceneReady guard was too restrictive (CRIT-3).
    // Everyone is going away here, so shared nameplates need no survivor check.
    state.remote.forEach(function (entry) {
      if (entry.name) disposeCachedName(entry.name) // Fix 1: free the cached sprite+texture
      detachGroup(entry.group)
      entry.group = null
    })
    state.remote.clear()
    state.uid = null
    state.name = null
    state.clientId = null
    updateIndicator()
  }

  /**
	 * Handle dc:v1-event — route presence ops to their handlers.
	 * @param {{op:string, data:Object}} detail
	 */
  function onV1Event (detail) {
    if (!detail) return
    const op = detail.op
    const data = detail.data || {}

    if (op === 'dc.presence.joined') {
      onJoined(data)
    } else if (op === 'dc.presence.updated') {
      onUpdated(data)
    } else if (op === 'dc.presence.batch_updated') {
      dbg('batch_updated', data)
      // data is { clientId1: {uid,name,x,z,yaw,ts,...}, clientId2: {...}, ... }
      // emitted by Events.php when 2+ clients move within a 50ms window
      if (data && typeof data === 'object') {
        const now = performance.now()
        const selfKey = state.clientId === null ? null : idKey(state.clientId)
        // `for...in` always yields STRING keys, and state.remote is keyed by
        // idKey() — normalise both sides so a numeric clientId can never slip
        // past the skip-self test or miss its lookup.
        for (const rawId in data) {
          if (!Object.prototype.hasOwnProperty.call(data, rawId)) continue
          const key = idKey(rawId)
          if (key === null) continue
          if (selfKey !== null && key === selfKey) continue // skip self
          const entry = data[rawId]
          if (!entry || typeof entry !== 'object') continue
          const remoteEntry = state.remote.get(key)
          if (remoteEntry) {
            // Preserve server timestamp if available
            if (entry.ts !== undefined) remoteEntry.ts = entry.ts

            // Calculate velocity from position delta / time delta (backwards compatible)
            const prevX = remoteEntry.x
            const prevZ = remoteEntry.z
            const prevT = remoteEntry.lastUpdateTime || now
            const dt = (now - prevT) / 1000 // seconds since last update
            // Same finiteness rule as onUpdated: a non-finite coordinate is ignored, never
            // written into the entry the render loop reads.
            const hasX = isNum(entry.x)
            const hasZ = isNum(entry.z)

            if (dt > 0) {
              const dvx = hasX ? (entry.x - prevX) / dt : 0
              const dvy = hasZ ? (entry.z - prevZ) / dt : 0
              // Clamp velocity to prevent runaway extrapolation (max 50 units/sec)
              const MAX_VELOCITY = 50
              remoteEntry.vx = num(Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dvx)), 0)
              remoteEntry.vy = num(Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, dvy)), 0)
            }

            // Update position
            if (hasX) remoteEntry.x = entry.x
            if (hasZ) remoteEntry.z = entry.z
            if (isNum(entry.yaw)) remoteEntry.yaw = entry.yaw

            // Set interpolation target
            if (hasX) remoteEntry.targetX = entry.x
            if (hasZ) remoteEntry.targetZ = entry.z

            remoteEntry.lastUpdateTime = now

            // MINOR-10: name might have changed — evict old cache entry so it rebuilds with
            // the new name, but leave it alone while another avatar still shows it.
            if (entry.name && remoteEntry.name !== entry.name) {
              const oldName = remoteEntry.name
              // remoteEntry still carries oldName, so exclude it from the in-use scan.
              if (oldName && !nameStillInUse(oldName, key)) {
                // MINOR-10: also detach from THIS avatar group in case the parent ref is stale
                if (remoteEntry.group && typeof remoteEntry.group.remove === 'function') {
                  const cached = _nameSpriteCache.get(oldName)
                  if (cached && cached.sprite) remoteEntry.group.remove(cached.sprite)
                }
                disposeCachedName(oldName)
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
    elBadge = document.getElementById('dcPresence')
    elDot = document.getElementById('dcPresenceDot')
    elLabel = document.getElementById('dcPresenceLabel')
    elCount = document.getElementById('dcPresenceCount')

    // Listen for auth events
    document.addEventListener('dc:auth-success', function (e) { onAuthSuccess(e && e.detail); updateIndicator(); setTimeout(updateIndicator, 200); })
    document.addEventListener('dc:auth-failure', function () { onAuthFailureOrDisconnect() })
    document.addEventListener('dc:disconnected', function () { onAuthFailureOrDisconnect() })

    // CONTRACT STATUS-EVENT — transport status from dc-ws.js. Seed from the current
    // value first: the initial 'connecting' is dispatched before we are listening.
    document.addEventListener('dc:ws-status', function (e) { onWsStatus(e && e.detail) })
    seedWsStatus()

    // Listen for presence broadcasts from dc-ws.js
    document.addEventListener('dc:v1-event', function (e) { onV1Event(e && e.detail) })

    // CONTRACT BOT-BOUNDS — dc.js fires this right after buildRoom(), the moment
    // DC.roomBounds exists (and again on every location switch).
    document.addEventListener('dc:respawn', function () { onRespawn() })

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
