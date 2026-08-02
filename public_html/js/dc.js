/*
TODO
* collision prevent+ion / no walking into racks
* Add Pathing to move to a target server/rack
* Add pathing to draw lines between objects like network ports to servers
* properly align/rotate all models
* mini-map view
* walls
* labels on racks/servers
* highlight object looking at
*/
import * as THREE from "three";
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { FirstPersonControls } from "three/addons/controls/FirstPersonControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
// Relative, but with the cache-buster spelled out: a bare "./dc-gui.js" would resolve against
// dc.js's own URL and drop the ?v=, so the adapter would go on being served from cache after an
// edit that only bumped the <script> tags. dc.html modulepreloads the same URL.
import { createPanel } from './dc-gui.js?v=p53';
import Stats from "three/addons/libs/stats.module.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
let camera, scene, renderer, controls, controlObject, stats, inspector, gui, locations = {}, maxAnisotropy; // Declare global variables
const VIEW_OPTS = { Overview: 'overview', 'Top-down': 'top', Aisle: 'aisle', Labels: 'labels', Cables: 'cables' };
const _viewProxy = { view: 'overview' };   // bound to the GUI 'View' dropdown (replaces the #dcViews button bar)
let prevTime = performance.now();
let racksShown = false, showServers = true;
let objects = {instanced: [], network: null, rackLabels: [], labels: [], room: null, community: null}, models = { racks: {}, servers: {} }, locationNames = {};
let sunCore = null, sunGlow = null;  // sun spheres (Fix #5 disposal)
let rackColliders = []; // x/z footprints of placed racks (for collision)
let roomBounds = null;  // {minX,maxX,minZ,maxZ} wall extents (collide against the walls)
let roomSpawn = null;   // {x,y,z,lookX,lookZ} a safe spot inside the room to drop the player
// --- multi-building LOD: neighbours show cheap rack BLOCKS, swapped to full models on approach ---
let lodBuildings = [];  // per-neighbour state {id, foot, dx,dz, wall rect, door, blocks, blockColliders, full, loading}
// Spatial hash for fast LOD building lookup (Fix A: collideWorld spatial grid)
const _spatialGrid = {};
const _gridCellSize = 50;  // units per grid cell

// Idle-frame skip tracking: after 18000 idle frames (5 min at 60fps), skip expensive per-frame updates
const _IDLE_FRAME_THRESHOLD = 18000;
let _tickSkippedFrames = 0;
let _skipExpensiveUpdates = false;

// IDEA-2: WebGL context loss state (set by context loss/restored event listeners in init())
let _contextLost = false;
let _sessionBackup = null;
// Device loss on the node renderer (webgpu mode, either backend) has no "restored" counterpart — a lost
// WebGPU device never comes back — so recovery is a reload plus this sessionStorage handoff. It is
// written ONLY by onDeviceLost, and read exactly once on the next boot: an ordinary page load and the
// renderer-switch button's reload must never be mistaken for a device-loss recovery, and a tab reloaded
// long afterwards must not be teleported to wherever the lost session happened to be standing.
const _RESTORE_KEY = 'dcSessionBackup';
const _RESTORE_MAX_AGE_MS = 60000;
let _pendingRestore = null;
// Animation loop callback storage (Fix: module-level declaration for setAnimationLoop)
let _animationLoopCb = null;

// MINOR-4: cancel-then-send pattern to avoid duplicate _updateViewport calls during location switch
let _viewportPending = null;
// MINOR-7: requestIdleCallback polyfill - reuse a single MessageChannel instead of creating one per call
let _ricChannel = null;
function scheduleViewportUpdate(data) {
    if (_viewportPending) {
        clearTimeout(_viewportPending);
        _viewportPending = null;
    }
    _viewportPending = setTimeout(() => {
        if (window.DC_WS && window.DC_WS._updateViewport) {
            window.DC_WS._updateViewport(data);
        }
        _viewportPending = null;
    }, 100);  // 100ms debounce
}
// three.js WebGLAnimation re-arms requestAnimationFrame AFTER invoking the loop callback:
//     onAnimationFrame() { animationLoop(time, frame); requestId = requestAnimationFrame(onAnimationFrame); }
// so ONE exception escaping the callback permanently stops rendering — the scene freezes on the last
// drawn frame with no console trace beyond the error itself, which looks exactly like "I clicked and
// nothing happens". Always hand the renderer a guarded wrapper so a transient per-frame error costs one
// frame instead of the whole session, and shout about it so the real bug is visible.
let _loopErrorCount = 0;
const _LOOP_ERROR_LOG_LIMIT = 10;
function _guardLoop(cb) {
    if (typeof cb !== 'function') return cb;
    return function (time, frame) {
        try {
            cb(time, frame);
            _loopErrorCount = 0;  // Reset on successful frame (MINOR-9)
        } catch (err) {
            _loopErrorCount++;
            if (_loopErrorCount <= _LOOP_ERROR_LOG_LIMIT) {
                console.error('[dc] render-loop error #' + _loopErrorCount + ' (frame skipped, loop kept alive):', err);
                if (_loopErrorCount === _LOOP_ERROR_LOG_LIMIT) {
                    console.error('[dc] further render-loop errors will be counted in DC.loopErrors but not logged');
                }
            }
        }
    };
}

// --- requestIdleCallback polyfill (MAJOR-8: fix broken fallback) ---
const _ric = requestIdleCallback
    ? (cb, opts) => requestIdleCallback(cb, opts)
    : (cb) => {
        if (!_ricChannel) {
            _ricChannel = new MessageChannel();
            _ricChannel.port1.onmessage = (e) => {
                if (_ricChannel._cb) {
                    const cb = _ricChannel._cb;
                    _ricChannel._cb = null;
                    cb({ didTimeout: false });
                }
            };
        }
        _ricChannel._cb = cb;
        _ricChannel.port2.postMessage(null);
    };

// --- FPS monitoring for automatic quality scaling ---
const FPS_WINDOW = 60;          // frames to average over (must be before ring buffer)
// MAJOR-3: Use a ring buffer (fixed-size array + head index) for O(1) insert instead of O(n) Array.shift()
const _fpsHistory = new Array(FPS_WINDOW).fill(0);  // rolling window of frame times (ms)
let _fpsHead = 0;                 // index of oldest slot (wraps around)
let _fpsCount = 0;                // how many slots are filled (max FPS_WINDOW)
let _lastFrameTime = 0;         // timestamp of last frame
let _qualityDowngradeTime = 0;  // when we last downgraded (debounce guard)
let _lastUpgradeTime = 0;       // when we last upgraded (debounce guard)
const FPS_TARGET = 55;          // FPS below this triggers a downgrade
const FPS_RECOVERY = 65;        // FPS needed to suggest an upgrade
const DOWNGRADE_COOLDOWN = 10000; // ms between downgrades (debounce)
const UPGRADE_COOLDOWN = 3000;   // ms between upgrades (debounce)

// Quality settings — progressively reduced when FPS drops. Exposed via DC.quality.
const S = {
    pixelScale: 1.0,    // renderer pixel ratio multiplier (1.0 = full, 0.75 = 75%, etc.)
    shadowMapEnabled: true,
    shadowMapSize: 2048, // shadow map resolution (reduced on quality downgrade)
    lodBias: 0,         // LOD bias offset added to S.lodBias; >0 makes LOD more aggressive (culls sooner)
};
let _shadowMapSize = 2048; // internal shadow map size state (applied when shadows are active)

function _gridKey(x, z) {
    return Math.floor(x / _gridCellSize) + ',' + Math.floor(z / _gridCellSize);
}

function _insertIntoGrid(building) {
    // A building spans multiple grid cells. Insert into all cells it overlaps.
    // building has minX, maxX, minZ, maxZ directly on it (not .bounds)
    const minCx = Math.floor((building.minX - 1) / _gridCellSize);
    const maxCx = Math.floor((building.maxX + 1) / _gridCellSize);
    const minCz = Math.floor((building.minZ - 1) / _gridCellSize);
    const maxCz = Math.floor((building.maxZ + 1) / _gridCellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
            const key = cx + ',' + cz;
            if (!_spatialGrid[key]) _spatialGrid[key] = [];
            _spatialGrid[key].push(building);
        }
    }
}

function _rebuildSpatialGrid() {
    // eslint-disable-next-line no-unused-vars
    for (const k in _spatialGrid) delete _spatialGrid[k];
    for (const nb of lodBuildings) {
        _insertIntoGrid(nb);
    }
}

// Spatial grid for rackColliders — keyed by grid cell, value is array of collider indices (Fix #3)
const _rackGrid = {};
const RACK_GRID_CELL = 10;  // 10-unit cells for racks (smaller than building-scale GRID_CELL=50)

// Cache: locationId → { geometry, tubeCount } for cable geometry (Fix #10)
const _cableGeometryCache = new Map();
const _cableCacheOrder = new Set();  // O(1) add/has/delete; insertion order maintained for LRU
const MAX_CABLE_CACHE = 8;  // MAJOR-9: increased from 3 to 8

// Cache: poster spec string → CanvasTexture (Fix #11)
const _posterTextureCache = new Map();

// Cache: location name string → sign CanvasTexture (Fix #18)
const _signTextureCache = new Map();

// Cache: seed → floor CanvasTexture (Fix #5)
const _floorTextureCache = new Map();

// Cache: hostname string → CanvasTexture (Fix #7 / CRIT-12: moved to module scope to avoid TDZ)
const _labelTextureCache = new Map();

// Cache: seed → ceiling CanvasTexture (Fix #4)
const _ceilingTextureCache = new Map();

// LRU eviction for texture caches (Fix #19)
const MAX_TEXTURE_CACHE = 128;
const _cacheOrder = {
    label: new Set(), poster: new Set(), sign: new Set(), floor: new Set(), ceiling: new Set()
};

function cacheWithEvict(cacheMap, key, value, orderSet) {
    if (cacheMap.has(key)) {
        // move to end (most recently used): delete and re-add is O(1) with Set
        orderSet.delete(key);  // O(1) delete
        orderSet.add(key);     // O(1) add
        cacheMap.set(key, value);
        return;
    }
    if (cacheMap.size >= MAX_TEXTURE_CACHE) {
        const oldest = orderSet.values().next().value;  // O(1) get first (LRU)
        orderSet.delete(oldest);  // O(1) delete
        const oldVal = cacheMap.get(oldest);
        if (oldVal && oldVal.dispose) oldVal.dispose();
        cacheMap.delete(oldest);
    }
    orderSet.add(key);  // O(1) add
    cacheMap.set(key, value);
}

function _rackGridKey(x, z) {
    return Math.floor(x / RACK_GRID_CELL) * 10000 + Math.floor(z / RACK_GRID_CELL);
}

function _insertRackCollider(c, idx) {
    // A rack collider spans from c.minX to c.maxX, c.minZ to c.maxZ
    const minCx = Math.floor((c.minX - 0.5) / RACK_GRID_CELL);
    const maxCx = Math.floor((c.maxX + 0.5) / RACK_GRID_CELL);
    const minCz = Math.floor((c.minZ - 0.5) / RACK_GRID_CELL);
    const maxCz = Math.floor((c.maxZ + 0.5) / RACK_GRID_CELL);
    for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cz = minCz; cz <= maxCz; cz++) {
            const key = cx * 10000 + cz;
            if (!_rackGrid[key]) _rackGrid[key] = [];
            if (!_rackGrid[key].includes(idx)) _rackGrid[key].push(idx);
        }
    }
}

// Set of already-inserted collider indices to avoid duplicates when rebuilding during async loads
const _rackCollidersInserted = new Set();

function _rebuildRackGrid() {
    // Accumulate colliders: only insert new ones that aren't already in the grid
    for (let i = 0; i < rackColliders.length; i++) {
        if (!_rackCollidersInserted.has(i)) {
            _insertRackCollider(rackColliders[i], i);
            _rackCollidersInserted.add(i);
        }
    }
}

let dcBuildings = [];   // wall/door descriptor for EVERY building (current + neighbours) -> walk-between collision
let wallColliders = []; // thin AABB slabs for all building walls (door gaps open) + the lot perimeter
let neighborBlinds = []; // venetian-blind handles for the neighbour windows (slats+cords InstancedMeshes), animated by updateBlinds
let neighborDoors = []; // iS-logo glass double doors per neighbour (swing open on approach), animated by updateNeighborDoors
let _posCtrls = null, _guiPosLast = 0; // the x/y/z GUI controllers; their left labels are refreshed by updateGuiPos()
// Resolved once init() knows whether the three.js Inspector attached, i.e. which backend the settings
// panel gets. Pre-resolved so the classic renderer never waits on it (see init()).
let _panelBackendReady = Promise.resolve();
let _panelBackendSettled = () => {};
let roomDoors = [];     // the main building's solid SWING doors (back + left), animated by updateRoomDoors
let roomSideDoors = []; // their {side,c,half} descriptors -> the current building's extra collision door gaps
let lodFocus = null;    // {x,z} the player's ground position (set by dc-multi); the LOD keys off this, not the orbit camera
const LOD_ENTER_PAD = 28; // a neighbour swaps to FULL models when the focus point is within this many units of its walls
const LOD_EXIT_PAD = 80;  // ...and back to BLOCKS once beyond this (hysteresis stops thrashing at the threshold)
const LOD_MAX_FULL = 1;   // neighbours at full detail at once (the current building is always full -> budget is 2 buildings)
let _lodDistanceMult = 1.0; // GUI-adjustable multiplier for LOD distance thresholds (updateLOD applies this at runtime)
const options = {
    useFirstPerson: false,
    showLabels: true,
    showNetwork: true,
    showWalls: true,    // room walls (built from the rack-layout bounds)
    showCeiling: true,  // ceiling + fluorescent fixtures + HVAC ducts
    faultyLights: 1,    // PERCENT of fixtures that flicker, in EVERY building (0..100; default 1%)
    disco: false,       // when on, every light fixture cycles a random colour every 3-5s
	moveForward: false,
	moveBackward: false,
	moveLeft: false,
	moveRight: false,
	canJump: false,
	collisionMovement: true,
	gravityMs2: 9.8,    // jump gravity (m/s²); slider lives in the Movement folder. moon 1.6 .. earth 9.8 .. 40 = barely a hop
	domain: '',         // data + 3D assets load from THIS origin (same-origin -> no CORS). Set a host here only to pull from elsewhere.
	location: 4,
	heightInches: 70,   // player standing/eye height: 3.5ft (42") .. 8ft (96"), default 5'10"
	waistInches: 36,    // player waist size -> collision radius: 15" .. 60", default 36"
	scaleX: 8,  // Scale factor for x position
	scaleZ: 9,  // Scale factor for z position
};
const clock = new THREE.Clock();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const vertex = new THREE.Vector3();
const color = new THREE.Color();
//const loaderDae = new ColladaLoader();
const loaderGltf = new GLTFLoader();
loaderGltf.setMeshoptDecoder(MeshoptDecoder); // decode EXT_meshopt_compression GLBs
const rackTypes = [
	'',
	"1182_096_2",
	"5307_824_2",
	"5507_150_2",
	"7000_562_2",
	"7831_800_2",
	"SB838072AFB18",
	"WZ-IT-426060-69AA-2-011_0",
	"gltf/exported-centered/Open-19-inch-free-standing-rack",
	"gltf/exported-centered/Rack",
	"gltf/exported-centered/APC+AR3100+42U",
	"gltf/exported-centered/Server Rack 45 RMU 20x15x84",
	"gltf/exported-centered/LogDev 42U 4 Post Server Rack 5000 36x24x78",
	"gltf/exported-centered/42U+cabinet"
// 'gltf/exported-centered/Panduit CS1 Server Rack 42x32x84', // d
	// 'gltf/exported-centered/Server Rack Shell', // d
	// 'gltf/exported-centered/KabinPLUS 42U 600 x 1000',  // d
	// 'gltf/exported-centered/KabinPLUS 42U 600 x 1100', // d
	// 'gltf/exported-centered/KabinPLUS 42U 600 x 1200', // d
	//'gltf/exported-centered/Huawei 44u Data Center cabinet', // d
	//'gltf/exported-centered/Rack NetShelter 42U - APC', // d
	//'gltf/exported-centered/KabinPLUS 42U 800 x 1200',// d
	// 'gltf/exported-centered/APC+Rack+Cabinet+42U+800x1200', // dark
	// 'gltf/exported-centered/Fujitsu PrimeCenter M1 42U', // l
];
const serverTypes = [
			['',1],
	["Barracuda 350 1U", 1],
	//["Cisco Catalyst 3750G-24", 1],
	//["Cisco Catalyst 3750G-48", 1],
	//["Cisco Small Business SG220-26", 1],
	//["Cisco Small Business SG220-50", 1],
	//["Dell EMC PowerEdge R240 1u", 1],
	//["Dell-PowerEdge-1750-1U", 1],
	["Dell PowerEdge 850 1U", 1],
	["Dell PowerEdge R210", 1],
	//["Dell-PowerEdge-R430", 1],
	//["F5 Big IP Load Balancing Device", 1],
	//["IBM eServer xSeries 336", 1],
	["IBM system x3530 M4", 1],
	//["IOGear Miniview Ultra KVM Switch", 1],
	//["Juniper-EX3300", 1],
	//["Middle Atlantic PD-2020R-NS Rack Power Strip PSU", 1],
	//["pdu_front", 1],
	//["SEDNA 19 1U RACK MOUNTED USB HUB", 1],
	//["SuperMicro6015X", 1],
	["TrendNet_TEG-S16Dg_tab_front", 1],
	["Tripp-lite rack power strip", 1],
	["Cisco-ASR-1002-no-interfaces", 2],
	//["Cisco+ASR1002-X", 2],
	//["Cisco+ASR9001", 2],
	["Cisco HyperFlex HX240c M5", 2],
	//["Cisco+Nexus+5596UP", 2],
	//["Cisco UCS C210 M2", 2],
	//["Cisco UCS C240 M5", 2],
	["Dell PowerEdge 2650 2U", 2],
	["Dell PowerEdge R710", 2],
	["HP Integrity RX2660", 2],
	//["IBM eServer xSeries 345", 2],
	//["IBM Power 730", 2],
	//["IBM Power Linux (7R2)", 2],
	//["Lenovo ThinkServer RD240", 2],
	["Lenovo ThinkSystem SR650", 2],
	//["SGI Altix 350", 2],
	["Sun Oracle SPARC T4-1", 2],
	//["SunOracle X2-8L", 2],
	["SuperMicro 2U Server", 2],
	["Unisys ES3000 Model 3580R G3", 2],
	["Cisco 3925 Router", 2],
	["Cisco 3945 Router", 3],
	//["Cisco UCS C460 M2", 4],
	//["Dell PowerEdge R910 4U", 4],
	["IBM eServer pSeries 615 (6C3P)", 4],
	//["IBM Power8 S814 4U", 4],
	//["IBM System p 520", 4],
	//["IBM (System x3850 x6)", 4],
	//["Lenovo ThinkSystem SR950 mission-critical 4U", 4],
	["Sun Microsystems Netra T4 1", 4],
	["Sun Microsystems SunFire V440", 4],
	//["Sun Microsystems SunFire V445", 4],
	//["HP ProLiant ML350 G5", 5],
	//["HP ProLiant ML370 G5", 5],
	//["Cisco Catalyst 6506e", 11],
	["Cisco Catalyst 4510r", 13],
];

// --- FPS tracking for automatic quality scaling ---
function _updateFPS(now) {
    if (_lastFrameTime > 0) {
        const delta = now - _lastFrameTime;
        // MAJOR-3: Ring buffer — O(1) insert instead of O(n) Array.shift()
        _fpsHistory[_fpsHead] = delta;
        _fpsHead = (_fpsHead + 1) % FPS_WINDOW;
        if (_fpsCount < FPS_WINDOW) _fpsCount++;
        // Note: _fpsCount stops incrementing once FPS_WINDOW (60) is reached
        // The check above is redundant after buffer fills but kept for clarity
    }
    _lastFrameTime = now;
}

function _autoQualityScale(now) {
    if (_fpsCount < FPS_WINDOW) return; // not enough data yet

    // MAJOR-3: Iterate over the correct ring buffer slots (not the whole array)
    // Buffer is full: oldest is at _fpsHead, iterate all FPS_WINDOW slots in order (oldest → newest)
    let sum = 0;
    for (let i = 0; i < FPS_WINDOW; i++) {
        const idx = (_fpsHead + i) % FPS_WINDOW;
        sum += _fpsHistory[idx];
    }
    const avgFrameTime = sum / FPS_WINDOW;
    const fps = 1000 / avgFrameTime;

    if (fps < FPS_TARGET) {
        if (now - _qualityDowngradeTime < DOWNGRADE_COOLDOWN) return; // debounce: don't spam downgrades
        _qualityDowngradeTime = now;
        _reduceQuality();
    } else if (fps > FPS_RECOVERY) {
        if (now - _lastUpgradeTime < UPGRADE_COOLDOWN) return; // debounce: don't spam upgrades
        _lastUpgradeTime = now;
        _upgradeQuality();
    }
}

function _reduceQuality() {
    // Step 1: reduce pixel scale (renderer resolution)
    if (S.pixelScale > 0.5) {
        S.pixelScale = Math.max(0.5, S.pixelScale - 0.25);
        if (renderer) {
            renderer.setPixelRatio(Math.min(window.devicePixelRatio * S.pixelScale, 2));
        }
        _notifyQualityChange('pixelScale', S.pixelScale);
        return;
    }

    // Step 2: halve the shadow map size
    if (_shadowMapSize >= 1024) {
        _shadowMapSize = Math.max(512, _shadowMapSize / 2);
        S.shadowMapSize = _shadowMapSize;
        // Re-configure the active shadow lights with the new map size
        _applyShadowMapSize();
        _notifyQualityChange('shadowMap', _shadowMapSize);
        return;
    }

    // Step 3: make LOD more aggressive (higher bias = objects switch to low-LOD sooner)
    S.lodBias = Math.min(S.lodBias + 0.5, 2);
    _notifyQualityChange('lodBias', S.lodBias);
}

function _upgradeQuality() {
    // Reverse Step 3: reduce LOD bias (make LOD less aggressive)
    if (S.lodBias > 0) {
        S.lodBias = Math.max(0, S.lodBias - 0.5);
        _notifyQualityChange('lodBias', S.lodBias);
        return;
    }

    // Reverse Step 2: double the shadow map size
    if (_shadowMapSize <= 1024) {
        _shadowMapSize = Math.min(2048, _shadowMapSize * 2);
        S.shadowMapSize = _shadowMapSize;
        _applyShadowMapSize();
        _notifyQualityChange('shadowMap', _shadowMapSize);
        return;
    }

    // Reverse Step 1: increase pixel scale
    if (S.pixelScale < 1.0) {
        S.pixelScale = Math.min(1.0, S.pixelScale + 0.25);
        if (renderer) {
            renderer.setPixelRatio(Math.min(window.devicePixelRatio * S.pixelScale, 2));
        }
        _notifyQualityChange('pixelScale', S.pixelScale);
        return;
    }
}

function _applyShadowMapSize() {
    // Walk the scene and update any shadow-casting lights' shadow map size.
    // Called when _shadowMapSize changes due to auto-quality scaling.
    if (!scene) return;
    scene.traverse((obj) => {
        if (obj.isDirectionalLight || obj.isSpotLight) {
            if (obj.shadow && obj.shadow.map) {
                obj.shadow.mapSize.set(_shadowMapSize, _shadowMapSize);
                obj.shadow.map.dispose();
                obj.shadow.map = null;
                if (obj.shadow.camera) obj.shadow.camera.updateProjectionMatrix();
            }
        }
    });
}

function _notifyQualityChange(setting, value) {
    const notification = document.createElement('div');
    notification.style.cssText =
        'position:fixed;bottom:20px;right:20px;background:#ff9800;color:#000;' +
        'padding:8px 16px;border-radius:4px;font-family:sans-serif;font-size:12px;' +
        'z-index:99999;opacity:0;transition:opacity 0.3s;';
    notification.textContent = `\u26a0\ufe0f Auto-reduced quality: ${setting} \u2192 ${typeof value === 'number' ? value.toFixed(2) : value}`;
    document.body.appendChild(notification);
    requestAnimationFrame(() => { notification.style.opacity = '1'; });
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 300);
    }, 4000);
}

function displayDatacenter() {
    clearScene();
    buildRoom();
    getRackModels();
    getServerModels();
    displaySwitches();
    buildCommunity(); // the other datacenters as exterior shells around this one
    spawnInside();    // place the player within the walls on load / location change
    attachKeyHandlers(); // Bug #1: re-attach key handlers after scene rebuild
    // Re-add stats panel if it was removed by clearScene()
    if (stats && stats.dom && !stats.dom.parentNode) {
        document.body.appendChild(stats.dom);
    }
}

function setNetworkVisible(visible) {
    if (objects.network) objects.network.visible = visible;
    for (const b of lodBuildings) if (b.full && b.full.network) b.full.network.visible = visible;   // full neighbours' cabling too
}

// Refresh the x/y/z controllers' labels with the live camera position (throttled; programmatic camera
// moves don't fire onChange). Deliberately not the Inspector's own .listen() label loop — that one is
// per-frame and cannot be cancelled.
function updateGuiPos() {
    if (!_posCtrls || !camera) return;
    const now = performance.now();
    if (now - _guiPosLast < 200) return; _guiPosLast = now;
    for (const c of _posCtrls) c.label(c._ax, Math.round(camera.position[c._ax]));
}
function displayGui() {
    // Fix #17: Dispose old gui before creating a new one to prevent ghost DOM elements. The
    // backend-specific teardown (MAJOR-15's controller off() sweep for lil-gui, the paramList
    // removal for the Inspector) lives in the adapter's destroy().
    if (gui) {
        gui.destroy();
        gui = null;
    }
    // In webgpu mode the panel is the Inspector's Parameters tab; everywhere else it is lil-gui.
    // `inspector` is null unless the real addon attached, which is the only honest signal —
    // renderer.inspector is never falsy on the node renderer.
    gui = createPanel({ inspector });
    gui.add( options, 'location', locationNames).listen().onChange( () => { switchLocation(); });
    const displayFolder = gui.addFolder( 'Display' );
    displayFolder.add(options, 'showLabels'); // honored per-frame by updateLabels()
    displayFolder.add(options, 'showNetwork').onChange( (value) => { setNetworkVisible(value); });
    displayFolder.add(options, 'showWalls').name('walls').onChange((v) => { if (objects.room) objects.room.walls.visible = v; });
    displayFolder.add(options, 'showCeiling').name('ceiling').onChange((v) => { if (objects.room) objects.room.ceiling.visible = v; });
    const fc = displayFolder.add(options, 'faultyLights', 0, 100, 1);
    fc.onChange(() => fc.label('faulty lights', options.faultyLights + '%')).onFinishChange(() => displayDatacenter());
    fc.label('faulty lights', options.faultyLights + '%');
    displayFolder.add(options, 'disco').name('disco').onChange((v) => { if (!v) resetDisco(); });   // unchecked default; cycles each fixture's colour
    displayFolder.add(options, 'useFirstPerson').onChange( () => { setupControls(); });
    const moveFolder = gui.addFolder( 'Movement' );
    // live camera position. value lives in the LEFT label (the right number box is hidden via css);
    // refreshed by updateGuiPos() each frame since programmatic camera moves don't fire onChange.
    const xc = moveFolder.add(camera.position, 'x', -250, 250).listen(); xc._ax = 'x';
    const yc = moveFolder.add(camera.position, 'y', -250, 250).listen(); yc._ax = 'y';
    const zc = moveFolder.add(camera.position, 'z', -250, 250).listen(); zc._ax = 'z';
    _posCtrls = [xc, yc, zc];
    for (const c of _posCtrls) c.label(c._ax, Math.round(camera.position[c._ax]));
    /*moveFolder.add( options, 'moveLeft').listen().disable();
			moveFolder.add( options, 'moveRight').listen().disable();
			moveFolder.add( options, 'moveForward').listen().disable();
			moveFolder.add( options, 'moveBackward').listen().disable();*/
    moveFolder.add( options, 'collisionMovement');
    const gc = moveFolder.add( options, 'gravityMs2', 1.6, 14, 0.1 ).onChange(() => gc.label('Gravity', options.gravityMs2 + ' m/s²'));
    gc.label('Gravity', options.gravityMs2 + ' m/s²');
    const lodFolder = gui.addFolder('LOD');
    lodFolder.add({ distanceMult: 1.0 }, 'distanceMult', 0.5, 2.0).name('LOD Distance').step(0.1).onChange(v => {
        _lodDistanceMult = v;
    });
    // height + waist: the formatted value lives in the controller label (colourised) and refreshes on change.
    const hLbl = (i) => `${Math.floor(i / 12)}' ${i % 12}"`;
    const hc = moveFolder.add( options, 'heightInches', 42, 96, 1 ).onChange(() => { camera.position.y = eyeHeight(); hc.label('height', hLbl(options.heightInches)); });
    hc.label('height', hLbl(options.heightInches));
    const wc = moveFolder.add( options, 'waistInches', 15, 60, 1 ).onChange(() => wc.label('waist', options.waistInches + '"'));
    wc.label('waist', options.waistInches + '"');
    moveFolder.open(); // expanded on load
    buildLocationButtons();
}
function mergeLocations(data) {
    // The response always carries the full locations list (names, for the dropdown); only the
    // requested location has its racks populated. Keep already-loaded full data; fill in names.
    for (const idx of Object.keys(data.locations)) {
        const incoming = data.locations[idx];
        const hasRacks = incoming.racks && Object.keys(incoming.racks).length > 0;
        if (hasRacks || !locations[idx]) {
            locations[idx] = incoming;
        }
        locationNames[incoming.name] = Number(idx);
    }
}

// Build a URL for datacenter data + 3D assets. Same-origin by default (options.domain==''), which
// avoids CORS — mystage/prod serve their own /ajax + /images/3d. Set options.domain to pull elsewhere.
function dcUrl(path) { return (options.domain ? 'https://' + options.domain : '') + path; }
function fetchLocation(locId) {
    return fetch(dcUrl('/ajax/datacenter.php?location=' + Number(locId)))
        .then((response) => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then((data) => { mergeLocations(data); });
}

function locationLoaded(locId) {
    const loc = locations[locId];
    return !!(loc && loc.racks && Object.keys(loc.racks).length > 0);
}

function switchLocation() {
    const el = document.getElementById('dcLocations');
    if (el) el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.loc) === Number(options.location)));
    // Fly out of the current building and down into the new one (data is already loaded up front).
    if (locationLoaded(options.location)) {
        flyTransition(options.location);
    } else {
        fetchLocation(options.location)
            .then(() => flyTransition(options.location))
            .catch((error) => console.error('There was a problem loading the location:', error));
    }
}

// Vertical list of location buttons down the left side, kept in sync with the GUI dropdown.
function buildLocationButtons() {
    const el = document.getElementById('dcLocations');
    if (!el) return;
    el.innerHTML = '';
    const entries = Object.keys(locationNames).map((name) => ({ name, id: Number(locationNames[name]) }));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const { name, id } of entries) {
        const btn = document.createElement('button');
        // collapsed label = the bit before the first space or dash (e.g. "DFW1", "TEB3");
        // the full name shows only on hover (CSS swaps the two spans).
        const short = name.split(/[\s-]+/)[0] || name;
        const sEl = document.createElement('span'); sEl.className = 'dc-loc-short'; sEl.textContent = short;
        const fEl = document.createElement('span'); fEl.className = 'dc-loc-full'; fEl.textContent = name;
        btn.appendChild(sEl); btn.appendChild(fEl);
        btn.dataset.loc = id;
        btn.title = name;
        if (id === Number(options.location)) btn.classList.add('active');
        btn.addEventListener('click', () => {
            if (Number(options.location) === id) return;
            options.location = id;
            switchLocation();
        });
        el.appendChild(btn);
    }
}

// Pull the device-loss handoff, if any. Consumed exactly once: the key is removed on read, so a later
// reload can never replay it, and anything older than _RESTORE_MAX_AGE_MS or not shaped like a backup
// is dropped. Storage access itself can throw (blocked cookies / private mode), which must not stop the
// scene from booting.
function _takeSessionRestore() {
    let raw = null;
    try {
        raw = window.sessionStorage.getItem(_RESTORE_KEY);
        if (raw !== null) window.sessionStorage.removeItem(_RESTORE_KEY);
    } catch (e) {
        return null;
    }
    if (!raw) return null;
    let data = null;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (!data || typeof data !== 'object') return null;
    const age = Date.now() - Number(data.ts);
    if (!(age >= 0 && age < _RESTORE_MAX_AGE_MS)) return null;
    return data;
}

// Location half of the restore, and it has to land before displayDatacenter() builds a room. Only a
// location the fetch actually returned is accepted — buildRoom() reads racks straight off
// locations[options.location], so a backup naming a location that no longer exists would throw.
function _restoreLocation() {
    if (!_pendingRestore) return;
    const loc = Number(_pendingRestore.loc);
    if (!Number.isFinite(loc) || loc <= 0 || !locationLoaded(loc)) return;
    options.location = loc;
}

// Camera half, after displayDatacenter()'s spawnInside() has dropped the player at the room default.
// Same two fields the webglcontextrestored handler replays, but these came back through JSON, so the
// coordinates are re-checked rather than trusted — and they only mean anything in the room they were
// captured in, so a refused location restore has to take the position with it rather than drop the
// player at another building's coordinates.
function _restoreCamera() {
    const s = _pendingRestore;
    _pendingRestore = null;
    if (!s || !camera || !s.pos) return;
    if (Number(s.loc) !== Number(options.location)) return;
    const x = Number(s.pos.x), y = Number(s.pos.y), z = Number(s.pos.z), yaw = Number(s.yaw);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    camera.position.set(x, y, z);
    camera.rotation.y = Number.isFinite(yaw) ? yaw : 0;
}

function loadDatacenter() {
    // Fetch ALL locations at once so every building's footprint is known for the community layout.
    fetch(dcUrl('/ajax/datacenter.php'))
        .then((r) => { if (!r.ok) throw new Error('Network response was not ok'); return r.json(); })
        .then((data) => {
            mergeLocations(data);
            _restoreLocation();     // before the dropdown and the room read options.location
            return _panelBackendReady;
        })
        .then(() => {
            displayGui();
            displayDatacenter();
            _restoreCamera();       // after spawnInside() placed the player at the room default
            const loading = document.getElementById('dcLoading');
            if (loading) loading.style.display = 'none';
        })
        .catch((error) => console.error('There was a problem with the fetch operation:', error));
}

function clearScene() {
    // BUG-2: Ensure presence state is cleaned up before scene disposal
    if (typeof window.DC_PRESENCE_LEAVE === 'function') {
        window.DC_PRESENCE_LEAVE();
    }
    // Remove stats.dom from DOM if present (stats.dom is appended once in init() but clearScene()
    // tears down the scene — without removal the panel would stay in the body indefinitely)
    if (stats && stats.dom && stats.dom.parentNode) {
        stats.dom.parentNode.removeChild(stats.dom);
    }
    // Reset idle skip state (Bug #2: clearScene must not leave stale skip mode from a previous scene)
    _tickSkippedFrames = 0;
    _skipExpensiveUpdates = false;
    // NOTE: do NOT detachKeyHandlers() here. attachKeyHandlers() is already idempotent (guarded by
    // keyHandlersAttached), so a rebuild could never stack duplicate listeners — detaching only opened a
    // window where WASD was dead until something re-attached, which is worse than the problem it "fixed".
    rackColliders = []; // rebuilt as racks are re-placed
    // Reset spatial grids (Fix #3)
    for (const k in _rackGrid) delete _rackGrid[k];
    _rackCollidersInserted.clear();
    // Clear cable geometry cache (Fix #10)
    for (const [, cached] of _cableGeometryCache) {
        cached.geometry.dispose();
    }
    _cableGeometryCache.clear();
    // Clear texture caches — label textures are NOT disposed here because they may still be
    // referenced by label Mesh objects; updateLabels() rebuilds them on demand. Only dispose
    // the per-label material.map in the label cleanup loop below (Fix #18).
    _posterTextureCache.forEach(tex => tex.dispose());
    _posterTextureCache.clear();
    _signTextureCache.forEach(tex => tex.dispose());
    _signTextureCache.clear();
    _floorTextureCache.forEach(tex => tex.dispose());
    _floorTextureCache.clear();
    _ceilingTextureCache.forEach(tex => tex.dispose());
    _ceilingTextureCache.clear();
    _labelTextureCache.forEach(tex => tex.dispose());
    _labelTextureCache.clear();
    Object.keys(_cacheOrder).forEach(k => _cacheOrder[k] = new Set());
    roomBounds = null; roomSpawn = null;
    // Multi-building LOD: dispose any neighbour FULL models (their group is added straight to the scene,
    // separate from objects.community). Geometry/material are shared cached templates -> only free each
    // InstancedMesh's instanceMatrix (inst.dispose), like objects.instanced above. Block meshes live in
    // objects.community and are disposed by its traverse below.
    for (const b of lodBuildings) {
        if (b.full) {
            scene.remove(b.full.group);
            b.full.group.traverse((n) => {
                if (!n.isMesh) return;
                if (n.isInstancedMesh) { n.dispose(); return; }   // shared cached rack/server geo+mat -> instanceMatrix only
                n.geometry.dispose();
                const mats = Array.isArray(n.material) ? n.material : [n.material];
                for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }   // interior meshes own unique geo/mat/maps
            });
            b.full = null;
        }
        b.loading = false;
    }
    for (const h of neighborBlinds) { if (h.inst) h.inst.dispose(); if (h.cords) h.cords.dispose(); } // free instanceMatrix; the meshes live in objects.community (disposed below)
    lodBuildings = []; dcBuildings = []; wallColliders = []; neighborBlinds = []; neighborDoors = []; roomDoors = []; roomSideDoors = [];
    // The building spatial hash indexes the objects we just dropped. Leaving it populated makes
    // collideWorld keep colliding against the PREVIOUS location's buildings (invisible walls), so it
    // has to be cleared with lodBuildings, not only where it is rebuilt.
    for (const k in _spatialGrid) delete _spatialGrid[k];
    // Instanced model meshes: detach + dispose the per-instance buffer. Their geometry and
    // material are the cached model templates in models.* (shared across rebuilds), so they
    // are kept; InstancedMesh.dispose() only frees the instanceMatrix buffer.
    for (const inst of objects.instanced) {
        scene.remove(inst);
        inst.dispose();
    }
    objects.instanced = [];
    // Merged network lines: a single LineSegments with its own geometry + material -> dispose.
    if (objects.network) {
        scene.remove(objects.network);
        objects.network.geometry.dispose();
        objects.network.material.dispose();
        objects.network = null;
    }
    // Labels are flat quads sharing LABEL_GEO: dispose each one's material + its lazily-built
    // CanvasTexture map, but never the shared geometry.
    for (const bucket of ['rackLabels', 'labels']) {
        for (const label of objects[bucket]) {
            scene.remove(label);
            if (label.material.map) label.material.map.dispose();
            label.material.dispose();
        }
        objects[bucket] = [];
    }
    // Room shell (walls / ceiling / fluorescent fixtures / ducts): a Group of plain meshes whose
    // geometries + materials are built fresh per location, so dispose them all on rebuild.
    if (objects.room) {
        scene.remove(objects.room.group);
        objects.room.group.traverse((n) => {
            if (n.isMesh) {
                n.geometry.dispose();
                const mats = Array.isArray(n.material) ? n.material : [n.material];
                for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
            }
        });
        objects.room = null;
    }
    // Community: exterior shells of the other buildings -> dispose meshes + their sign textures.
    if (objects.community) {
        scene.remove(objects.community);
        objects.community.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); const m = n.material; if (m.map) m.map.dispose(); m.dispose(); } });
        objects.community = null;
    }
    // Sun spheres (Fix #5)
    if (sunCore) { scene.remove(sunCore); sunCore.geometry.dispose(); sunCore.material.dispose(); sunCore = null; }
    if (sunGlow) { scene.remove(sunGlow); sunGlow.geometry.dispose(); sunGlow.material.dispose(); sunGlow = null; }
}

function convertRackCoordinatesToPosition(x, y) {
    // Convert x/y coordinates to three.js x/z position for the rack
    const offsetX = -100; // Offset to center the racks
    const offsetZ = -100;
    const positionX = offsetX + (x * options.scaleX);
    const positionZ = offsetZ + (y * options.scaleZ);
    const maxX = offsetX + ((x + 1) * options.scaleX);
    const maxZ = offsetZ + ((y + 1) * options.scaleZ);
    return { x: positionX, z: positionZ, max_x: maxX, max_z: maxZ };
}

function convertServerCoordinatesToPosition(rackX, rackY, start) {
    // Get the rack position
    const rackPosition = convertRackCoordinatesToPosition(rackX, rackY);

    // Adjust rack position for the server position
    const serverPositionX = rackPosition.x - 2.4; // Modify x position for server
    const serverPositionY = 0.5 * start; // Calculate y position for server
    const serverPositionZ = rackPosition.z + 2.6; // Modify z position for server

    return { x: serverPositionX, y: serverPositionY, z: serverPositionZ };
}

const UNITS_PER_INCH = 15 / 70; // scene units per inch (so 5'10" = 70" maps to the original eye height ~15)
function eyeHeight() { return options.heightInches * UNITS_PER_INCH; }
function playerRadius() { return Math.max(0.2, (options.waistInches / (2 * Math.PI)) * UNITS_PER_INCH); }

// Collision: rackColliders holds each rack's x/z footprint (built in buildInstanced). A position
// (x,z) with radius r collides if it overlaps any footprint -> used to block walking into racks.
function collidesAt(x, z, r) {
    // walls: keep the player inside the room
    if (roomBounds && (x - r <= roomBounds.minX || x + r >= roomBounds.maxX || z - r <= roomBounds.minZ || z + r >= roomBounds.maxZ)) return true;
    // Fast spatial grid lookup: only check rack colliders in nearby cells (Fix #3)
    const cx = Math.floor(x / RACK_GRID_CELL);
    const cz = Math.floor(z / RACK_GRID_CELL);
    const check = [];
    // Fix 2: use a Set for O(1) deduplication lookups instead of O(n) .includes()
    const checkSet = new Set();
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const cell = _rackGrid[(cx + dx) * 10000 + (cz + dz)];
            if (cell) {
                for (const idx of cell) {
                    if (!checkSet.has(idx)) { check.push(idx); checkSet.add(idx); }
                }
            }
        }
    }
    if (check.length === 0) {
        // Fallback: rack grid empty (shouldn't happen), use full scan
        for (const c of rackColliders) {
            if (x + r >= c.minX && x - r <= c.maxX && z + r >= c.minZ && z - r <= c.maxZ) return true;
        }
        return false;
    }
    for (const idx of check) {
        const c = rackColliders[idx];
        if (!c) continue;
        if (x + r >= c.minX && x - r <= c.maxX && z + r >= c.minZ && z - r <= c.maxZ) return true;
    }
    return false;
}

// GLB variant subdirs to try, best-compression first; '' = the full original model.
// meshopt:       geometry quantized + EXT_meshopt_compression (decoded by MeshoptDecoder)
// webp-simplify: decimated geometry + webp textures
// Both mirror the model's own path, so the same name resolves across all three.
const GLB_VARIANTS = ['meshopt', 'webp-simplify', ''];

function glbVariantUrl(basePath, relName, variant) {
    if (!variant) return basePath + relName + '.glb';
    // Insert the variant subdir before the final path component so both bare names
    // ("1182_096_2") and nested names ("gltf/exported-centered/Rack") resolve.
    const slash = relName.lastIndexOf('/');
    const dir = slash >= 0 ? relName.slice(0, slash + 1) : '';
    const file = slash >= 0 ? relName.slice(slash + 1) : relName;
    return basePath + dir + variant + '/' + file + '.glb';
}

// One-line banner for things the user has to be told about but that don't stop the scene. dc-multi.js
// has hud() for the same job, but that is a module-local function inside an OPTIONAL overlay: dc.js
// is the core module and dc.html can (and in the Playwright fixture does) run it with dc-multi absent,
// so calling hud() from here was a straight ReferenceError — every "all GLB variants failed" ended in
// an uncaught throw and the warning it was trying to show reached nobody. Styled inline, like the
// context-lost overlay, because dc.html's stylesheet is not this module's to grow.
let _noticeEl = null;
let _noticeTimer = null;

function notice(text, ms = 12000) {
    if (_noticeTimer !== null) { clearTimeout(_noticeTimer); _noticeTimer = null; }
    if (!text) {
        if (_noticeEl && _noticeEl.parentNode) _noticeEl.parentNode.removeChild(_noticeEl);
        _noticeEl = null;
        return;
    }
    if (!_noticeEl) {
        _noticeEl = document.createElement('div');
        _noticeEl.id = 'dcNotice';
        // z-index above #dcLoading (40): a load-time warning that the loading curtain covers is no
        // warning at all. Sits below dc-multi's #dcPlayerHud (top:10px) so the two can't overlap.
        _noticeEl.style.cssText = 'position:fixed;top:44px;left:50%;transform:translateX(-50%);z-index:41;'
            + 'padding:6px 12px;background:rgba(120,28,28,0.9);color:#fff;border-radius:5px;'
            + 'font:12px Arial, sans-serif;pointer-events:none;max-width:70vw;text-align:center;';
        document.body.appendChild(_noticeEl);
    }
    _noticeEl.textContent = text;
    if (ms > 0) _noticeTimer = setTimeout(() => { _noticeTimer = null; notice(''); }, ms);
}

// Resolve a rack/server TYPE index to the model name to fetch, or null when there is nothing to
// fetch. Two very different cases both land on null and must stay distinguishable:
//   - index 0 is the deliberate "no model" placeholder ('' in rackTypes, ['',1] in serverTypes).
//     A payload may legitimately carry it, so it is skipped SILENTLY.
//   - an index past the end of the array is bad inventory data. /ajax/datacenter.php's ?test=1
//     grid emitted server type 22 against a 22-entry serverTypes (max index 21), and
//     getServerModels()'s destructuring of the resulting undefined threw a TypeError that took
//     displayDatacenter() down with it — no switches, no community, no key handlers, loading
//     curtain never lifted. Warn and skip; a scene missing one model beats no scene.
// Neither case is a load FAILURE, so neither may reach notice() — that banner is reserved for
// GLBs that were actually requested and 404'd.
function rackModelName(t) {
    const name = rackTypes[t];
    if (name === undefined) { console.warn('[dc] Unknown rack type', t, '— skipping'); return null; }
    return name || null;
}
function serverModelName(t) {
    const entry = serverTypes[t];
    if (entry === undefined) { console.warn('[dc] Unknown server type', t, '— skipping'); return null; }
    return entry[0] || null;
}

function loadGlbWithFallback(basePath, relName, onLoad, onGiveUp) {
    // onGiveUp fires on every path that will NOT produce a model — a missing name and the
    // all-variants-failed branch — so a caller awaiting this load always gets an answer. Without it
    // loadRackType()/loadServerType() resolved only from onLoad, and one skipped or 404'd model in a
    // neighbouring building parked loadBuildingModels() on its full 12s Promise.race timeout before
    // the building could swap to full detail. The timeout stays as a backstop, not as the normal path.
    // The name guard below is a backstop too: rackModelName()/serverModelName() screen index 0 (the
    // empty-string placeholder) out before it gets here, and it must stay screened — unguarded it is
    // three doomed requests (<basePath>.glb, <basePath>meshopt/.glb, <basePath>webp-simplify/.glb)
    // landing in the failure branch, i.e. a user-facing "some 3D models failed to load" banner about a
    // model nobody asked for.
    if (!relName) {
        console.warn('[dc] Skipping GLB load with no model name for', basePath);
        if (onGiveUp) onGiveUp();
        return;
    }
    let i = 0;
    const tryNext = () => {
        const url = glbVariantUrl(basePath, relName, GLB_VARIANTS[i]);
        const isLast = i === GLB_VARIANTS.length - 1;
        i += 1;
        loaderGltf.load(url, onLoad, undefined, isLast
            ? (err) => {
                console.error('[dc] All GLB variants failed for', basePath, relName, err);
                notice('Warning: Some 3D models failed to load — scene may be incomplete');
                if (onGiveUp) onGiveUp();
            }
            : tryNext);
    };
    tryNext();
}

// Phase 4: render each unique model type as InstancedMesh-per-sub-mesh (one draw call per
// sub-mesh for ALL placements of that type) instead of cloning the whole model per object.
const _instMatrix = new THREE.Matrix4();
const _placeMatrix = new THREE.Matrix4();

function extractModelMeshes(root, scale) {
    // Normalize the loaded model (origin, no rotation, fixed scale) and capture each sub-mesh's
    // geometry + material + its transform in model space, plus the whole model's bounding box
    // (used to size/centre the look-highlight box to the real item, e.g. its 1U/2U/3U height).
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
    const parts = [];
    const box = new THREE.Box3();
    const _b = new THREE.Box3();
    root.traverse((n) => {
        if (n.isMesh && n.geometry) {
            parts.push({ geometry: n.geometry, material: n.material, matrix: n.matrixWorld.clone() });
            if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
            _b.copy(n.geometry.boundingBox).applyMatrix4(n.matrixWorld);
            box.union(_b);
        }
    });
    return { parts, box };
}

// `sink` (optional) redirects output to a per-building group instead of the live scene/current-building
// state: { group, meshes:[], colliders:[] }. Default (undefined) = current building -> scene + objects.instanced
// + rackColliders, exactly as before. Used to render a NEIGHBOUR's full models at its world offset.
function buildInstanced(model, placements, kind, sink) {
    const n = placements.length;
    if (!model || !model.parts || n === 0) return;
    const assetIds = placements.map((p) => p.assetId);
    const assetData = placements.map((p) => p.asset);
    const container = sink ? sink.group : scene;
    const instList = sink ? sink.meshes : objects.instanced;
    const collList = sink ? sink.colliders : rackColliders;
    const created = [];
    for (const part of model.parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, n);
        for (let k = 0; k < n; k++) {
            const p = placements[k];
            _placeMatrix.makeTranslation(p.x, p.y, p.z);
            _instMatrix.multiplyMatrices(_placeMatrix, part.matrix);
            inst.setMatrixAt(k, _instMatrix);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        inst.userData.kind = kind;           // 'rack' | 'server'
        inst.userData.assetIds = assetIds;   // instanceId -> rack/server id
        inst.userData.assetData = assetData; // instanceId -> asset object (hostname/name/id)
        inst.userData.placements = placements; // instanceId -> {x,y,z} placement (highlight box)
        inst.userData.modelBox = model.box;    // model-space bounds (highlight box size)
        container.add(inst);
        instList.push(inst);
        inst.frustumCulled = false;  // Fix #8: instances spread wide -> loose bounding sphere
        created.push(inst);
    }
    // Racks are the only collidable furniture. model.box unions EVERY sub-mesh -- including the
    // flat floor tile under each rack (~2x the rack's width) -- so it is far too wide to collide
    // against. Build the footprint from only the TALL sub-meshes (the rack body / doors you would
    // actually walk into), then offset by each placement (= rack centre) for an accurate collider.
    if (kind === 'rack' && model.parts.length) {
        const _c = new THREE.Vector3();
        const partBoxes = model.parts.map((part) => {
            if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
            const gb = part.geometry.boundingBox, pb = new THREE.Box3();
            for (const X of [gb.min.x, gb.max.x])
                for (const Y of [gb.min.y, gb.max.y])
                    for (const Z of [gb.min.z, gb.max.z])
                        pb.expandByPoint(_c.set(X, Y, Z).applyMatrix4(part.matrix));
            return pb;
        });
        const maxH = Math.max(...partBoxes.map((pb) => pb.max.y - pb.min.y));
        const fb = new THREE.Box3();
        for (const pb of partBoxes) {
            if ((pb.max.y - pb.min.y) >= 0.2 * maxH) fb.union(pb); // skip flat floor tiles / shadows
        }
        if (!fb.isEmpty()) {
            for (const inst of created) inst.userData.footBox = fb; // tight highlight box (excludes the wide floor tile)
            for (const p of placements) {
                collList.push({
                    minX: p.x + fb.min.x, maxX: p.x + fb.max.x,
                    minZ: p.z + fb.min.z, maxZ: p.z + fb.max.z,
                });
            }
        }
    }
}

function getRackModels() {
	let idx;
	const usedRacksSet = new Set();
	let usedRacks;
	usedRacksSet.clear();
	for (idx in locations[options.location].racks) {
		usedRacksSet.add(locations[options.location].racks[idx].type);
	}
	usedRacks = Array.from(usedRacksSet);
	//console.log(usedRacks);
	usedRacks.forEach((idx) => {
		if (typeof models.racks[idx] == 'undefined') {
			//console.log("Loading Rack "+idx);
			// Create a closure to capture the current value of idx
			(function (modelIdx) {
				// Same screen loadRackType() has always had, which this loader was missing: a type
				// with no model of its own is skipped, not handed to the loader.
				const currentModel = rackModelName(modelIdx);
				if (currentModel === null) return;
				loadGlbWithFallback(dcUrl('/images/3d/racks/'), currentModel, function (gltf) {
						const scale = 10;
						const rotationAngle = Math.PI / 2; // 90 degrees in radians
						const model = gltf.scene;
						if (scale !== false) {
							model.scale.set(scale, scale, scale);
						}
                        model.traverse((n) => {
                            if (n.isMesh) {
                                n.castShadow = true;
                                n.receiveShadow = true;
                                //n.material.map.anisotropy = 16;
                            }
                        });

						//model.rotation.y = rotationAngle; // Rotate around the Y-axis
						models.racks[modelIdx] = extractModelMeshes(model, 10);

						/* const box = new THREE.Box3().setFromObject(model);
						const dimensions = new THREE.Vector3();
						box.getSize(dimensions);
						console.log('Dimensions:', dimensions.x, dimensions.y, dimensions.z);*/

						//console.log("checking racks len "+Object.keys(models.racks).length+" against type len "+rackTypes.length);
						displayRacks(modelIdx);
					}
				);
			})(idx);
		} else {
			displayRacks(idx);
		}
	});
	//console.log("Got to the end of the loading racks code block");
}

function getServerModels() {
	let idxRack, idxServer, modelName, modelUnits;
	const usedServerSet = new Set();
	let usedServers;
	usedServerSet.clear();
	for (idxRack in locations[options.location].racks) {
		for (idxServer in locations[options.location].racks[idxRack].servers) {
			usedServerSet.add(locations[options.location].racks[idxRack].servers[idxServer].type);
		}
	}
	usedServers = Array.from(usedServerSet);
	usedServers.forEach((idxServer) => {
		//console.log('idx server '+idxServer);
		if (typeof models.servers[idxServer] == 'undefined') {
			// Create a closure to capture the current value of idx
			(function (modelIdx) {
				// Was an unguarded destructure of the raw serverTypes entry; a type the array has
				// no entry for threw out of the forEach and killed the rest of displayDatacenter().
				const currentModel = serverModelName(modelIdx);
				if (currentModel === null) return;
                //console.log("Loading Server "+currentModel);
				//loaderDae.load('https://'+options.domain+'/images/3d/servers/dae/'+currentModel+'/model.dae', function (collada) {
				loadGlbWithFallback(dcUrl('/images/3d/servers/gltf/exported-centered/'), currentModel, function (gltf) {
						//const scale = 0.26;
						const scale = 10;
						const rotationAngle = Math.PI / 2; // 90 degrees in radians
						const model = gltf.scene;
						if (scale !== false) {
							model.scale.set(scale, scale, scale);
						}
                        model.traverse((n) => {
                            if (n.isMesh) {
                                n.castShadow = true;
                                n.receiveShadow = true;
                                //n.material.map.anisotropy = 16;
                            }
                        });
						//model.rotation.z = rotationAngle; // Rotate around the Y-axis
						models.servers[modelIdx] = extractModelMeshes(model, 10);
						//console.log(gltf);
						//console.log("finished loading server " + currentModel);
						displayServers(modelIdx);
					}
				);
			})(idxServer);
		} else {
			displayServers(idxServer);
		}
	});
}

function displayRacks(modelIdx) {
    const racks = locations[options.location].racks;
    const placements = [];
    for (const rackKey of Object.keys(racks)) {
        const rack = racks[rackKey];
        if (rack.type === modelIdx) {
            const { x: positionX, z: positionZ } = convertRackCoordinatesToPosition(rack.x, rack.y);
            rack.id = rackKey;
            placements.push({ x: positionX, y: 0, z: positionZ, assetId: rackKey, asset: rack });
            displayRackText(rack.name, rack, positionX, positionZ);
        }
    }
    buildInstanced(models.racks[modelIdx], placements, 'rack');
    _rackCollidersInserted.clear(); // Ensure clean rebuild on every displayRacks() call (Bug #2)
    _rebuildRackGrid(); // Update spatial grid with new rack colliders (Fix #3)
}

function displayServers(modelIdx) {
    const racks = locations[options.location].racks;
    const placements = [];
    for (const rackKey of Object.keys(racks)) {
        const rack = racks[rackKey];
        for (const serverId of Object.keys(rack.servers)) {
            const server = rack.servers[serverId];
            if (server.type === modelIdx) {
                const { x: positionX, y: positionY, z: positionZ } = convertServerCoordinatesToPosition(rack.x, rack.y, server.start);
                server.id = serverId;
                placements.push({ x: positionX, y: positionY, z: positionZ, assetId: serverId, asset: server });
                displayServerText(server.hostname, server, positionX, positionY, positionZ);
            }
        }
    }
    buildInstanced(models.servers[modelIdx], placements, 'server');
}

function displayRackText(text, asset, x, z) {
    return displayText(text, asset, x - 2.5, 19.5, z + 4.2); // just proud of the rack front face
}

function displayServerText(text, asset, x, y, z) {
    return displayText(text, asset, x + 3.5, y + 0.25, z + 0.2);
}

const LABEL_DISTANCE = 40;                                  // draw a label only within this many world units
const LABEL_DISTANCE_SQ = LABEL_DISTANCE * LABEL_DISTANCE;
const MAX_LABELS = 200;                                     // max labels to texture at once (IDEA-6)
const _labelCamPos = new THREE.Vector3();
// Shared quad geometry for ALL flat labels. NOT disposed on scene clear because
// it remains in use by every label Mesh — disposing it would break all live labels.
// New label quads reuse this same geometry instance (scaled via label.scale.set).
const LABEL_GEO = new THREE.PlaneGeometry(1, 1);

// _labelTextureCache is declared at module scope (see CRIT-12 fix)
// Cache: hostname string → CanvasTexture (Fix #7)

function makeLabelTexture(text) {
    if (_labelTextureCache.has(text)) {
        return _labelTextureCache.get(text);
    }
    const scale = 3; // supersample the label canvas so the text stays crisp up close
    const w = 320 * scale, h = 32 * scale;
    const fontFamily = 'Verdana, "Segoe UI", Arial, sans-serif';
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    if ('letterSpacing' in context) context.letterSpacing = (1.5 * scale) + 'px';
    // fit the hostname within the label width (shrink the font for very long names so nothing clips)
    let fontSize = 18 * scale;
    context.font = fontSize + 'px ' + fontFamily;
    const maxW = w - 12 * scale;
    const measured = context.measureText(text).width;
    if (measured > maxW) {
        fontSize = Math.max(8 * scale, fontSize * maxW / measured);
        context.font = fontSize + 'px ' + fontFamily;
    }
    context.fillStyle = 'white';
    context.fillRect(0, 0, w, h);
    context.strokeStyle = 'gray';
    context.lineWidth = 2 * scale;
    context.strokeText(text, w / 2, h / 2);
    context.fillStyle = 'black';
    context.lineWidth = 1 * scale;
    context.fillText(text, w / 2, h / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy || 1; // sharpen at oblique viewing angles
    cacheWithEvict(_labelTextureCache, text, texture, _cacheOrder.label);
    return texture;
}

// Labels are flat quads fixed to the front face (facing +z, the aisle side) -- a "sticker" on each
// rack/case, NOT a billboard, so they don't rotate to follow the camera. The canvas texture is built
// LAZILY the first time the label comes within LABEL_DISTANCE; updateLabels() (per frame)
// distance-culls them so only the nearby handful actually draw. This bounds both label
// build cost and draw-call count regardless of how big the location is.
function displayText(text, data, x, y, z) {
    const label = new THREE.Mesh(LABEL_GEO, new THREE.MeshBasicMaterial());
    label.position.set(x, y, z);
    label.scale.set(2.5, 0.25, 1);   // matches the 10:1 label-texture aspect; +z normal = faces the aisle
    label.visible = false;
    label.userData.text = text;
    label.userData.drawn = false;
    scene.add(label);
    if (typeof data.hostname != "undefined") {
        objects.labels.push(label);
    } else {
        objects.rackLabels.push(label);
    }
    return label;
}

function updateLabels() {
    if (!camera) return;
    const show = options.showLabels;
    camera.getWorldPosition(_labelCamPos);

    // IDEA-6: If too many labels, only texture the closest MAX_LABELS to avoid overworking the GPU
    const allLabels = [...objects.labels, ...objects.rackLabels];
    if (allLabels.length > MAX_LABELS) {
        // Sort by distance and mark the furthest as "de-prioritized" (skip texture creation)
        const withDist = allLabels.map(s => ({
            sprite: s,
            distSq: s.position.distanceToSquared(_labelCamPos),
        }));
        withDist.sort((a, b) => a.distSq - b.distSq);
        // Mark all beyond MAX_LABELS as not-to-render, so updateLabels below skips them
        for (let i = MAX_LABELS; i < withDist.length; i++) {
            withDist[i].sprite.userData.dePrioritized = true;
        }
    }

    for (const arr of [objects.labels, objects.rackLabels]) {
        for (const sprite of arr) {
            const near = show && sprite.position.distanceToSquared(_labelCamPos) < LABEL_DISTANCE_SQ;
            // IDEA-6: Skip texture creation for de-prioritized labels (too far/too many)
            const canTexture = near && !sprite.userData.drawn && !sprite.userData.dePrioritized;
            if (canTexture) {
                sprite.material.map = makeLabelTexture(sprite.userData.text);
                sprite.material.needsUpdate = true;
                sprite.userData.drawn = true;
            }
            sprite.visible = near && !sprite.userData.dePrioritized;
        }
    }
}

// Cable-routing geometry (world units). Racks are ~19 tall; items sit at the rack front
// (z = rackBase + 2.6). Tune these to taste.
const CABLE_REAR = -2;     // z offset to the rear of the rack (cables exit the back)
const CABLE_OVERHEAD = 22; // y height of the overhead cable tray (above the racks)
const CABLE_END = 5;       // how far beyond a rack group's end racks the cables turn out
const CABLE_SPREAD = 1.1;  // per-cable offset so bundled cables sit beside each other, not on one line
const CABLE_RADIUS = 0.05;  // cable thickness in world units (true scale ~0.03; a touch thicker so it reads)
const CABLE_RADIAL = 8;     // tube cross-section sides (8 = more circular at close range)
// Cable colours: random-ish per cable for now (could key off link speed later). Blue-dominant
// with blue + orange accents, like a real patch field.
const CABLE_COLORS = [ // 60% yellow, 20% blue, 20% orange
    0xe2c044, 0xe2c044, 0xe2c044, 0xe2c044, 0xe2c044, 0xe2c044,
    0x2a5bd7, 0x2a5bd7,
    0xe8771a, 0xe8771a,
];
const _cableColor = new THREE.Color();
const _cdir1 = new THREE.Vector3();
const _cdir2 = new THREE.Vector3();

function makeRng(seed) {
    // deterministic per-cable RNG (so sag is varied but stable across rebuilds)
    let s = (seed >>> 0);
    if (s === 0) {
        // Hash the seed string to get a non-zero value, preserving some entropy
        const str = String(seed);
        for (let i = 0; i < str.length; i++) s = Math.imul(s ^ str.charCodeAt(i), 2660689);
        s = (s >>> 0) || 1;
    }
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function pushCableSag(out, a, b, rng) {
    // long, mostly-horizontal runs bow down in a FEW humps (1-2 usually, 4 max) at random
    // positions and depths, like a draped cable bundle -- not an even repeating scallop.
    const horiz = Math.hypot(b.x - a.x, b.z - a.z);
    if (horiz <= 9 || Math.abs(b.y - a.y) > 1.6) return;
    let n = Math.min(4, 1 + Math.floor(horiz / 34)); // longer runs allow more humps
    if (n > 1 && rng() < 0.45) n -= 1;               // often drop one -> mostly 1-2 humps
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    let prevT = 0;
    for (let i = 0; i < n; i++) {
        const lo = i / n, hi = (i + 1) / n;
        const t = lo + (0.25 + rng() * 0.5) * (hi - lo);                       // jittered hump position
        if (i > 0) {
            const tt = (prevT + t) / 2;                                       // tie point (back up) between humps
            out.push(new THREE.Vector3(a.x + dx * tt, a.y + dy * tt, a.z + dz * tt));
        }
        const depth = Math.min(2.8, (horiz / n) * 0.14) * (0.55 + rng() * 0.8); // varied depth
        out.push(new THREE.Vector3(a.x + dx * t, a.y + dy * t - depth, a.z + dz * t));
        prevT = t;
    }
}

function cableCurvePoints(corners, rng) {
    // Mostly-straight runs with only a small rounded fillet at each bend (the cable arcs just a
    // little at corners) + a few random sag humps on long spans, rather than one big bowing spline.
    const FILLET = 1.6;
    const out = [corners[0].clone()];
    for (let i = 1; i < corners.length - 1; i++) {
        const prev = corners[i - 1], cur = corners[i], next = corners[i + 1];
        _cdir1.subVectors(cur, prev); const lin = _cdir1.length(); _cdir1.normalize();
        _cdir2.subVectors(next, cur); const lout = _cdir2.length(); _cdir2.normalize();
        const fin = Math.min(FILLET, lin * 0.45), fout = Math.min(FILLET, lout * 0.45);
        const approach = cur.clone().addScaledVector(_cdir1, -fin);
        pushCableSag(out, out[out.length - 1], approach, rng);
        out.push(approach);                                  // end of the straight run
        out.push(cur.clone().addScaledVector(_cdir2, fout)); // start of the next run (rounds the corner)
    }
    pushCableSag(out, out[out.length - 1], corners[corners.length - 1], rng);
    out.push(corners[corners.length - 1].clone());
    return out;
}

function displaySwitches(locId, dx, dz, sink) {
    // One merged tube mesh for ALL switchport cabling (1 draw call): each cable is a rounded 3D
    // tube (matte "plastic" cylinder) routed like real structured cabling. Racks form groups
    // (contiguous runs within a row). A cable goes out the back -> up to its row's overhead tray
    // -> along to the nearest END of its group -> trunk across to the destination group's nearest
    // end -> along that row to the asset. Same-rack links stay short; same-group links run along
    // the shared row tray without leaving the group.
    locId = (locId === undefined) ? options.location : locId;
    dx = dx || 0; dz = dz || 0;
    const intraOnly = !!sink;   // neighbours: only draw cables whose endpoints are inside THIS building
    const cacheKey = sink ? locId + ':n' : locId;  // cache main and neighbour cable geometry separately
    const racks = (locations[locId] || {}).racks; if (!racks) return;

    // IDEA-4: Cable geometry LOD — reduce tubular segments when camera is far (overview mode)
    const camY = camera ? camera.position.y : 0;
    const farFromCables = camY > 25;
    const maxTubular = farFromCables ? 40 : 220;

    // Fix #10: Cache cable geometry per location (main and neighbours separately, not LOD-reduced)
    if (!farFromCables && _cableGeometryCache.has(cacheKey)) {
        const cached = _cableGeometryCache.get(cacheKey);
        // Reuse cached merged geometry (clone so dispose doesn't affect cache)
        const geo = cached.geometry.clone();
        if (objects.network) {
            scene.remove(objects.network);
            objects.network.geometry.dispose();
            objects.network.material.dispose();
        }
        objects.network = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25 }));
        objects.network.visible = options.showNetwork;
        objects.network.frustumCulled = false;
        scene.add(objects.network);
        return;
    }

    const tubes = [];
    const addCable = (pts, hex, off, seed) => {
        const vecs = [];
        for (let k = 0; k < pts.length; k++) {
            const p = pts[k];
            let x = p[0] + dx, y = p[1], z = p[2] + dz;   // shift the whole route into this building's plot
            // offset the middle of the route (not the exact port/asset ends) so bundled cables spread
            if (off && k > 0 && k < pts.length - 1) { x += off.x; y += off.y; z += off.z; }
            const v = new THREE.Vector3(x, y, z);
            if (vecs.length === 0 || vecs[vecs.length - 1].distanceToSquared(v) > 1e-6) vecs.push(v);
        }
        if (vecs.length < 2) return;
        let len = 0;
        for (let i = 1; i < vecs.length; i++) len += vecs[i - 1].distanceTo(vecs[i]);
        const curve = new THREE.CatmullRomCurve3(cableCurvePoints(vecs, makeRng(seed || 1)));
        const tubular = Math.min(maxTubular, Math.max(10, Math.round(len / 2.2)));
        const geo = new THREE.TubeGeometry(curve, tubular, CABLE_RADIUS, CABLE_RADIAL, false);
        const count = geo.attributes.position.count;
        const colors = new Float32Array(count * 3);
        _cableColor.set(hex);
        for (let i = 0; i < count; i++) {
            colors[i * 3] = _cableColor.r;
            colors[i * 3 + 1] = _cableColor.g;
            colors[i * 3 + 2] = _cableColor.b;
        }
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        tubes.push(geo);
    };
    // Group racks into contiguous runs within each row (rack.y); a group's "ends" are its
    // leftmost / rightmost racks (plus CABLE_END), and its row tray runs along the rear at z=rowZ.
    const rows = {};
    for (const k of Object.keys(racks)) { const r = racks[k]; (rows[r.y] = rows[r.y] || new Set()).add(r.x); }
    const groupOf = (gx, gy) => {
        const set = rows[gy];
        let xMin = gx, xMax = gx;
        if (set) { while (set.has(xMin - 1)) xMin--; while (set.has(xMax + 1)) xMax++; }
        return { y: gy, xMin, xMax };
    };
    const groupEnds = (g) => {
        const left = convertRackCoordinatesToPosition(g.xMin, g.y);
        const right = convertRackCoordinatesToPosition(g.xMax, g.y);
        return { leftX: left.x - CABLE_END, rightX: right.x + CABLE_END, rowZ: left.z + CABLE_REAR };
    };
    for (const rackKey of Object.keys(racks)) {
        const rack = racks[rackKey];
        const baseA = convertRackCoordinatesToPosition(rack.x, rack.y);
        const rearAz = baseA.z + CABLE_REAR;
        const srcGroup = groupOf(rack.x, rack.y);
        const srcEnds = groupEnds(srcGroup);
        for (const switchId of Object.keys(rack.switches)) {
            const switchData = rack.switches[switchId];
            const { x: positionX, y: positionY, z: positionZ } = convertServerCoordinatesToPosition(rack.x, rack.y, switchData.start);
            const portWidth = Math.ceil(switchData.totalPorts / 2);
            for (const portId of Object.keys(switchData.ports)) {
                const portData = switchData.ports[portId];
                let px = portData.justport;
                let py = positionY + 0.3;
                if (px > portWidth) { px -= portWidth; py -= 0.15; }
                px = positionX + 0.15 + (0.15 * px);
                const pz = positionZ;
                if (intraOnly && String(portData.datacenter) !== String(locId)) { continue; } // neighbour: only its own internal cabling
                const destLoc = locations[portData.datacenter];
                const destRack = (destLoc && destLoc.racks) ? destLoc.racks[portData.rack] : null;
                const destServer = (destRack && destRack.servers) ? destRack.servers[portData.asset] : null;
                if (!destServer) { continue; } // endpoint not in the loaded location (e.g. cross-DC link)
                const ret = convertServerCoordinatesToPosition(destRack.x, destRack.y, destServer.start);
                const ex = ret.x, ey = ret.y;
                const cableHex = CABLE_COLORS[(((Number(switchId) || 0) + portData.justport * 3) % CABLE_COLORS.length + CABLE_COLORS.length) % CABLE_COLORS.length];
                const seed = (((Number(switchId) || 0) * 131 + portData.justport * 17 + 1) >>> 0);
                const off = {
                    x: (((seed * 53) % 1000) / 1000 - 0.5) * CABLE_SPREAD,
                    y: (((seed * 29) % 1000) / 1000 - 0.5) * CABLE_SPREAD * 0.6,
                    z: (((seed * 97) % 1000) / 1000 - 0.5) * CABLE_SPREAD,
                };
                const sameRack = (String(portData.datacenter) === String(locId)) && (String(portData.rack) === String(rackKey));
                const destGroup = groupOf(destRack.x, destRack.y);
                const sameGroup = (String(portData.datacenter) === String(locId))
                    && destGroup.y === srcGroup.y && destGroup.xMin === srcGroup.xMin && destGroup.xMax === srcGroup.xMax;
                // Switch end: out the FRONT port, sideways to the nearest rack edge, UP that side
                // (so patches hug the rack side instead of climbing the front over the servers),
                // then over the top to the rear overhead tray.
                const sideX = (px <= baseA.x ? baseA.x - 2.7 : baseA.x + 2.7);
                const switchStart = [
                    [px, py, pz],                    // front port
                    [px, py, pz + 1.8],              // out the front a touch
                    [sideX, py, pz + 1.8],           // across to the side edge of the rack
                    [sideX, 19.5, pz + 1.8],         // up the side edge, clear of the server faces
                    [sideX, CABLE_OVERHEAD, rearAz], // over the top to the rear overhead tray
                ];
                if (sameRack || sameGroup) {
                    // along the overhead to the server's column, then drop BEHIND it and come straight in
                    addCable([
                        ...switchStart,
                        [ex, CABLE_OVERHEAD, rearAz],
                        [ex, ey, rearAz - 3.5],   // back a bit more behind the system
                        [ex, ey, rearAz],         // straight in to its back
                    ], cableHex, off, seed);
                } else {
                    // different rack group: trunk across via the row ends, then into the server's BACK
                    const destEnds = groupEnds(destGroup);
                    const srcEndX = Math.abs(srcEnds.leftX - ex) <= Math.abs(srcEnds.rightX - ex) ? srcEnds.leftX : srcEnds.rightX;
                    const destEndX = Math.abs(destEnds.leftX - srcEndX) <= Math.abs(destEnds.rightX - srcEndX) ? destEnds.leftX : destEnds.rightX;
                    addCable([
                        ...switchStart,
                        [srcEndX, CABLE_OVERHEAD, rearAz],         // along the row to the chosen end
                        [srcEndX, CABLE_OVERHEAD, destEnds.rowZ],  // trunk across to the destination row
                        [destEndX, CABLE_OVERHEAD, destEnds.rowZ], // along the trunk to the destination group's end
                        [ex, CABLE_OVERHEAD, destEnds.rowZ],       // along the destination row to the asset's rack
                        [ex, ey, destEnds.rowZ - 3.5],             // back a bit more behind the system
                        [ex, ey, destEnds.rowZ],                   // straight in to its back
                    ], cableHex, off, seed);
                }
            }
        }
    }
    if (tubes.length === 0) { if (!sink) objects.network = null; return; }

    // IDEA-8: Progressive cable loading - when many cables, defer merge to avoid main-thread blocking
    if (tubes.length > 150 && !sink) {
        const _tubes = tubes;
        const _locId = cacheKey;
        _ric(() => {
            const geometry = BufferGeometryUtils.mergeGeometries(_tubes, false);
            _tubes.forEach((g) => g.dispose());
            // Fix #8: LRU eviction for cable geometry cache (MINOR-1: use Set for O(1) ops)
            if (_cableGeometryCache.has(_locId)) {
                _cableCacheOrder.delete(_locId);  // O(1) delete
            } else if (_cableGeometryCache.size >= MAX_CABLE_CACHE) {
                const oldest = _cableCacheOrder.values().next().value;  // O(1) get first (LRU)
                _cableCacheOrder.delete(oldest);  // O(1) delete
                const oldVal = _cableGeometryCache.get(oldest);
                if (oldVal) oldVal.geometry.dispose();
                _cableGeometryCache.delete(oldest);
            }
            _cableCacheOrder.add(_locId);  // O(1) add
            _cableGeometryCache.set(_locId, { geometry: geometry.clone(), tubeCount: _tubes.length });
            if (objects.network) {
                scene.remove(objects.network);
                objects.network.geometry.dispose();
                objects.network.material.dispose();
            }
            const material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25 });
            const cables = new THREE.Mesh(geometry, material);
            cables.visible = options.showNetwork;
            cables.frustumCulled = false;
            (sink ? sink.group : scene).add(cables);
            if (sink) sink.network = cables; else objects.network = cables;
        });
        return;
    }

    // Small-to-medium cable count: merge synchronously (fast enough)
    const geometry = BufferGeometryUtils.mergeGeometries(tubes, false);
    tubes.forEach((g) => g.dispose());
    // Fix #10: Cache the merged cable geometry (main and neighbours separately)
    // Fix #8: LRU eviction for cable geometry cache (MINOR-1: use Set for O(1) ops)
    if (_cableGeometryCache.has(cacheKey)) {
        _cableCacheOrder.delete(cacheKey);  // O(1) delete
    } else if (_cableGeometryCache.size >= MAX_CABLE_CACHE) {
        const oldest = _cableCacheOrder.values().next().value;  // O(1) get first (LRU)
        _cableCacheOrder.delete(oldest);  // O(1) delete
        const oldVal = _cableGeometryCache.get(oldest);
        if (oldVal) oldVal.geometry.dispose();
        _cableGeometryCache.delete(oldest);
    }
    _cableCacheOrder.add(cacheKey);  // O(1) add
    _cableGeometryCache.set(cacheKey, { geometry: geometry.clone(), tubeCount: tubes.length });
    // matte plastic base + a clearcoat layer for a slight gloss / rounded depth on the cables
    const material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    const cables = new THREE.Mesh(geometry, material);
    cables.visible = options.showNetwork;
    cables.frustumCulled = false;
    (sink ? sink.group : scene).add(cables);
    if (sink) sink.network = cables; else objects.network = cables;
}

// Procedural floor tile: slightly off-white tiles with seams + sporadic tiny speckles. Drawn as a
// block of tiles so the speckle pattern doesn't visibly repeat tile-to-tile.
function makeFloorTexture(seed) {
    if (_floorTextureCache.has(seed)) {
        return _floorTextureCache.get(seed);
    }
	// Fix #12: Use seeded RNG so the same location always produces the same floor pattern
	const rng = makeRng(seed || 0);
	const tiles = 4, px = 128, size = tiles * px;
	const c = document.createElement('canvas'); c.width = c.height = size;
	const g = c.getContext('2d');
	g.fillStyle = '#cfcabc'; g.fillRect(0, 0, size, size);     // grey-beige base (darker -> tiles don't blow out white)
	for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) {   // slight per-tile shade variation
		const v = ((rng() * 14) | 0) - 7; g.fillStyle = `rgb(${207 + v},${202 + v},${188 + v})`; g.fillRect(tx * px + 2, ty * px + 2, px - 4, px - 4);
	}
	g.strokeStyle = '#938e7f'; g.lineWidth = 3;                // distinctly darker grout so the squares read
	for (let i = 0; i <= tiles; i++) { const p = i * px; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.moveTo(0, p); g.lineTo(size, p); g.stroke(); }
	for (let i = 0; i < 720; i++) {                            // random speckles, mixed light + dark for contrast
		const x = rng() * size, y = rng() * size, r = rng() * 1.7 + 0.5;
		g.fillStyle = rng() < 0.5 ? '#86816f' : '#c7c2b2';
		g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
	}
	const t = new THREE.CanvasTexture(c);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = maxAnisotropy || 1;
    cacheWithEvict(_floorTextureCache, seed, t, _cacheOrder.floor);
    return t;
}

function loadFloor() {
	// Outdoor ground for the community: a large asphalt lot. Each building's interior tile floor is
	// added per-location in buildRoom (sitting on top of this).
	const asphalt = new THREE.Mesh(
		new THREE.PlaneGeometry(4000, 4000),
		new THREE.MeshStandardMaterial({ color: 0x33343a, roughness: 0.96, metalness: 0.0 })
	);
	asphalt.rotation.x = -Math.PI / 2;
	asphalt.position.y = -0.1;
	scene.add(asphalt);
}

// Room shell built around the racks. We have no real room dimensions in the data, so derive them
// from the rack-layout bounds + a margin. Produces 4 walls + a ceiling, with fluorescent strip
// fixtures and HVAC ducts along the top. Walls and ceiling are independently toggleable.
const ROOM_MARGIN = 28;     // gap from the outermost rack footprints to the walls
const ROOM_CEIL_Y = 38.5;   // ceiling height (~15 ft at this scene scale; racks are ~20 / ~7.8 ft)
const CEIL_TILE = 36 * UNITS_PER_INCH; // 3 ft drop-ceiling tiles

// White drop-ceiling tile: a square panel with a slight recessed gap (the grid) around each edge,
// so when repeated it reads as a suspended tile ceiling.
function makeCeilingTexture(seed) {
	if (_ceilingTextureCache.has(seed)) {
		return _ceilingTextureCache.get(seed);
	}
	const rng = makeRng(seed ?? 0);
	const px = 128, c = document.createElement('canvas'); c.width = c.height = px;
	const g = c.getContext('2d');
	g.fillStyle = '#fbfbfa'; g.fillRect(0, 0, px, px);       // white panel
	g.fillStyle = '#cdcdc8'; const gap = 5;                  // slight recessed gap (the grid) between tiles
	g.fillRect(0, 0, px, gap); g.fillRect(0, 0, gap, px); g.fillRect(0, px - gap, px, gap); g.fillRect(px - gap, 0, gap, px);
	for (let i = 0; i < 120; i++) { g.fillStyle = rng() < 0.5 ? '#f3f3f1' : '#f6f6f4'; g.fillRect(rng() * px, rng() * px, 1, 1); } // very faint fibreboard speckle
	const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAnisotropy || 1;
    cacheWithEvict(_ceilingTextureCache, seed, t, _cacheOrder.ceiling);
    return t;
}

// "Lost cat" flyer for the bulletin board.
// MINOR-7 Note: Not cached — generated fresh each call. Should be cached per location+neighbor if perf is an issue.
function makeLostCatTexture() {
	const w = 300, h = 380, c = document.createElement('canvas'); c.width = w; c.height = h;
	const g = c.getContext('2d');
	g.fillStyle = '#fdfdf6'; g.fillRect(0, 0, w, h);
	g.strokeStyle = '#ccccc4'; g.lineWidth = 2; g.strokeRect(4, 4, w - 8, h - 8);
	g.textAlign = 'center';
	g.fillStyle = '#b00000'; g.font = 'bold 46px Arial'; g.fillText('LOST CAT', w / 2, 58);
	// simple cat face
	g.fillStyle = '#7a7a7a'; g.strokeStyle = '#444';
	g.beginPath(); g.moveTo(w / 2 - 56, 150); g.lineTo(w / 2 - 30, 96); g.lineTo(w / 2 - 8, 150); g.closePath(); g.fill();
	g.beginPath(); g.moveTo(w / 2 + 56, 150); g.lineTo(w / 2 + 30, 96); g.lineTo(w / 2 + 8, 150); g.closePath(); g.fill();
	g.beginPath(); g.arc(w / 2, 178, 58, 0, Math.PI * 2); g.fill();
	g.fillStyle = '#fff'; g.beginPath(); g.arc(w / 2 - 22, 172, 10, 0, 7); g.arc(w / 2 + 22, 172, 10, 0, 7); g.fill();
	g.fillStyle = '#222'; g.beginPath(); g.arc(w / 2 - 22, 173, 4.5, 0, 7); g.arc(w / 2 + 22, 173, 4.5, 0, 7); g.fill();
	g.fillStyle = '#333'; g.font = '21px Arial'; g.fillText('Have you seen Mittens?', w / 2, 280);
	g.font = '16px Arial'; g.fillText('Last seen near Rack B12', w / 2, 312); g.fillText('Reward! Call x4477', w / 2, 338);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAnisotropy || 1; return t;
}

// Old-fashioned pin-up calendar (a tasteful retro silhouette + a month grid) for the back of a door.
// MINOR-7 Note: Not cached — generated fresh each call. Should be cached per location+neighbor if perf is an issue.
function makeCalendarTexture() {
	const w = 220, h = 340, c = document.createElement('canvas'); c.width = w; c.height = h;
	const g = c.getContext('2d');
	g.fillStyle = '#f3e7cf'; g.fillRect(0, 0, w, h);                         // aged paper
	g.strokeStyle = '#b09a6a'; g.lineWidth = 3; g.strokeRect(5, 5, w - 10, h - 10);
	g.textAlign = 'center'; g.fillStyle = '#a8332b'; g.font = "bold 22px Georgia"; g.fillText("PIN-UPS of '54", w / 2, 32);
	// tasteful single-colour silhouette: head + hourglass torso + two legs + a raised arm
	g.fillStyle = '#6e3a2c';
	g.beginPath(); g.arc(w / 2, 78, 13, 0, Math.PI * 2); g.fill();
	g.beginPath(); g.moveTo(w / 2 - 18, 98); g.quadraticCurveTo(w / 2 - 6, 130, w / 2 - 16, 162); g.lineTo(w / 2 + 16, 162); g.quadraticCurveTo(w / 2 + 6, 130, w / 2 + 18, 98); g.quadraticCurveTo(w / 2, 86, w / 2 - 18, 98); g.fill();
	g.beginPath(); g.moveTo(w / 2 - 15, 160); g.quadraticCurveTo(w / 2 - 17, 200, w / 2 - 9, 226); g.lineTo(w / 2 - 1, 226); g.quadraticCurveTo(w / 2 - 3, 195, w / 2, 164); g.fill();
	g.beginPath(); g.moveTo(w / 2 + 15, 160); g.quadraticCurveTo(w / 2 + 17, 200, w / 2 + 9, 226); g.lineTo(w / 2 + 1, 226); g.quadraticCurveTo(w / 2 + 3, 195, w / 2, 164); g.fill();
	g.strokeStyle = '#6e3a2c'; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.moveTo(w / 2 + 8, 104); g.quadraticCurveTo(w / 2 + 32, 86, w / 2 + 26, 62); g.stroke();
	// month + day grid
	g.fillStyle = '#333'; g.font = 'bold 18px Georgia'; g.fillText('JULY', w / 2, 252);
	g.font = '11px Arial'; const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
	for (let i = 0; i < 7; i++) { g.fillStyle = '#a8332b'; g.fillText(days[i], 24 + i * 28, 270); }
	g.fillStyle = '#333'; let day = 1;
	for (let r = 0; r < 6 && day <= 31; r++) for (let i = 0; i < 7; i++) { if (r === 0 && i < 4) continue; if (day > 31) break; g.fillText(String(day++), 24 + i * 28, 286 + r * 14); }
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAnisotropy || 1; return t;
}
// --- Funny tech "motivational" posters for the office walls: matte-black poster, a white-keyline image
// with a simple tech icon, a big phrase, and a deadpan blurb. Framed + hung on the inside walls. ---
const POSTER_ICONS = {
	floppy(g, cx, cy, s) {
		const w = s, x = cx - w / 2, y = cy - w / 2;
		g.fillStyle = '#26303c'; g.fillRect(x, y, w, w);
		g.fillStyle = '#8a9099'; g.fillRect(x + w * 0.52, y, w * 0.34, w * 0.34);
		g.fillStyle = '#11161d'; g.fillRect(x + w * 0.6, y + w * 0.05, w * 0.1, w * 0.24);
		g.fillStyle = '#d9dde2'; g.fillRect(x + w * 0.16, y + w * 0.5, w * 0.68, w * 0.42);
		g.strokeStyle = '#9aa0a8'; g.lineWidth = Math.max(2, s * 0.012);
		for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(x + w * 0.2, y + w * 0.58 + i * w * 0.09); g.lineTo(x + w * 0.8, y + w * 0.58 + i * w * 0.09); g.stroke(); }
	},
	keyboard(g, cx, cy, s) {
		const w = s * 1.25, h = s * 0.6, x = cx - w / 2, y = cy - h / 2;
		g.fillStyle = '#2b313a'; g.fillRect(x, y, w, h);
		g.fillStyle = '#c7ccd3'; const cols = 9, k = (w - s * 0.1) / cols;
		for (let r = 0; r < 3; r++) for (let cc = 0; cc < cols; cc++) g.fillRect(x + s * 0.05 + cc * k + 1, y + s * 0.05 + r * (k * 0.62) + 1, k - 3, k * 0.5);
		g.fillRect(x + w * 0.3, y + h - s * 0.12, w * 0.4, s * 0.09);
	},
	ethernet(g, cx, cy, s) {
		const w = s * 0.66, h = s * 0.86, x = cx - w / 2, y = cy - h / 2;
		g.fillStyle = '#2b313a'; g.fillRect(x + w * 0.38, y, w * 0.24, h * 0.16);
		g.fillStyle = '#d9dde2'; g.fillRect(x, y + h * 0.16, w, h * 0.56);
		g.beginPath(); g.moveTo(x, y + h * 0.72); g.lineTo(x + w, y + h * 0.72); g.lineTo(x + w * 0.66, y + h); g.lineTo(x + w * 0.34, y + h); g.closePath(); g.fill();
		g.fillStyle = '#e7c558'; for (let i = 0; i < 6; i++) g.fillRect(x + w * 0.1 + i * w * 0.14, y + h * 0.2, w * 0.08, h * 0.22);
	},
	power(g, cx, cy, s) {
		const r = s * 0.4; g.strokeStyle = '#3fd27a'; g.lineWidth = Math.max(4, s * 0.11); g.lineCap = 'round';
		g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2 + 0.5, -Math.PI / 2 - 0.5 + Math.PI * 2); g.stroke();
		g.beginPath(); g.moveTo(cx, cy - r - s * 0.12); g.lineTo(cx, cy - s * 0.02); g.stroke();
	},
};
const POSTERS = [
	{ title: 'Teamwork',       blurb: 'Because saving your work is everyone’s job — right up until someone force-pushes to main.', icon: 'floppy' },
	{ title: 'Perseverance',   blurb: 'It’s not down. It’s pursuing five-nines from a bold new direction.',                       icon: 'power' },
	{ title: 'Persistence',    blurb: 'Have you tried turning it off and on again? Now do it four hundred more times.',                     icon: 'keyboard' },
	{ title: 'Make It Happen', blurb: 'Deploy on a Friday. The on-call engineer believes in you.',                                         icon: 'ethernet' },
];
function makePosterTexture(spec) {
	const cacheKey = JSON.stringify(spec);
	if (_posterTextureCache.has(cacheKey)) {
		return _posterTextureCache.get(cacheKey);
	}
	const W = 460, H = 576, c = document.createElement('canvas'); c.width = W; c.height = H;
	const g = c.getContext('2d');
	g.fillStyle = '#0b0b0c'; g.fillRect(0, 0, W, H);
	const ix = 40, iy = 36, iw = W - 80, ih = 320;
	const grd = g.createLinearGradient(0, iy, 0, iy + ih); grd.addColorStop(0, '#33424f'); grd.addColorStop(1, '#0f151b');
	g.fillStyle = grd; g.fillRect(ix, iy, iw, ih);
	g.strokeStyle = '#e9e9e9'; g.lineWidth = 2; g.strokeRect(ix - 6, iy - 6, iw + 12, ih + 12);
	POSTER_ICONS[spec.icon](g, ix + iw / 2, iy + ih / 2, Math.min(iw, ih) * 0.46);
	g.fillStyle = '#e7c558'; g.textAlign = 'center';
	let fs = 50; g.font = 'bold ' + fs + 'px Georgia, serif';
	while (g.measureText(spec.title.toUpperCase()).width > W - 56 && fs > 18) { fs -= 2; g.font = 'bold ' + fs + 'px Georgia, serif'; }
	g.fillText(spec.title.toUpperCase(), W / 2, iy + ih + 70);
	g.fillStyle = '#cfd3d8'; g.font = 'italic 20px Georgia, serif';
	const words = spec.blurb.split(' '); let line = '', y = iy + ih + 112;
	for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (g.measureText(t).width > W - 64 && line) { g.fillText(line, W / 2, y); line = wd; y += 28; } else line = t; }
	if (line) g.fillText(line, W / 2, y);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAnisotropy || 1;
	cacheWithEvict(_posterTextureCache, cacheKey, tex, _cacheOrder.poster);
	return tex;
}
// Hang the 4 posters on the inside walls of a building (near corners, where the wall is solid). parent =
// the building's walls/group; b = its {minX,maxX,minZ,maxZ} bounds.
function addPosters(parent, b) {
	const PW = 5, PH = 6.25, y = 13.5, frameMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.7 });
	// FD = frame depth; its back embeds in the wall and its front stands `front` units into the room; the
	// poster plane sits just proud of the frame face. The generous standoff (plus a depth bias) clears the
	// wall thickness (0.4 main / 0.6 neighbour) so the poster never z-fights the wall behind it.
	const FD = 0.5, front = 0.45, frameC = front - FD / 2, posterOff = front + 0.12;
	const place = (spec, axis, fixed, along, inward) => {
		const tex = makePosterTexture(spec);
		const frame = new THREE.Mesh(axis === 'x' ? new THREE.BoxGeometry(PW + 0.5, PH + 0.5, FD) : new THREE.BoxGeometry(FD, PH + 0.5, PW + 0.5), frameMat);
		const poster = new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
		if (axis === 'x') { frame.position.set(along, y, fixed + inward * frameC); poster.position.set(along, y, fixed + inward * posterOff); poster.rotation.y = inward < 0 ? Math.PI : 0; }
		else { frame.position.set(fixed + inward * frameC, y, along); poster.position.set(fixed + inward * posterOff, y, along); poster.rotation.y = inward > 0 ? Math.PI / 2 : -Math.PI / 2; }
		parent.add(frame); parent.add(poster);
	};
	place(POSTERS[0], 'x', b.maxZ, b.minX + 8, -1);   // front wall, near minX corner
	place(POSTERS[1], 'z', b.maxX, b.minZ + 8, -1);   // right wall, near minZ corner
	place(POSTERS[2], 'x', b.minZ, b.maxX - 8, +1);   // back wall, near maxX corner
	place(POSTERS[3], 'z', b.minX, b.maxZ - 8, +1);   // left wall, near maxZ corner
}
// ---- Community: render every datacenter as a building. The current one is built in full
// (interior + room); the rest are simple exterior shells placed on a street grid around it. ----
function locName(id) {
	for (const n in locationNames) if (Number(locationNames[n]) === Number(id)) return n;
	return String(id);
}
function locationFootprint(id) {
	const racks = (locations[id] || {}).racks || {};
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
	for (const k in racks) { const r = racks[k]; const p = convertRackCoordinatesToPosition(r.x, r.y); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
	if (!isFinite(minX)) return null;
	const pad = 4 + ROOM_MARGIN;
	return { w: (maxX - minX) + 2 * pad, d: (maxZ - minZ) + 2 * pad, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}
function makeSignTexture(text) {
	if (_signTextureCache.has(text)) {
		return _signTextureCache.get(text);
	}
	const w = 256, h = 64, c = document.createElement('canvas'); c.width = w; c.height = h;
	const g = c.getContext('2d');
	g.fillStyle = '#1d2430'; g.fillRect(0, 0, w, h);
	g.strokeStyle = '#3a4350'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
	g.fillStyle = '#ffd23a'; g.textAlign = 'center'; g.textBaseline = 'middle';
	let fs = 30; g.font = 'bold ' + fs + 'px Arial';
	while (g.measureText(text).width > w - 20 && fs > 10) { fs -= 2; g.font = 'bold ' + fs + 'px Arial'; }
	g.fillText(text, w / 2, h / 2 + 2);
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = maxAnisotropy || 1;
	cacheWithEvict(_signTextureCache, text, t, _cacheOrder.sign);
	return t;
}
const WIN_SZ = 96 * UNITS_PER_INCH;     // 8 ft windows
const WIN_BOTTOM = 18 * UNITS_PER_INCH; // sill ~1.5 ft off the ground
const MULLION = 3 * UNITS_PER_INCH;     // 3" matte-black metal frame between adjacent windows
// --- Venetian window blinds (slats tilted ~30deg). DOWN by default (covers ~half the glass -> cuts
// see-through overdraw); auto-raise (bottom-up gather) when the viewer gets close to a window, then
// descend again 2s after they walk away. Built once per room as ONE InstancedMesh for all slats. ---
const BLIND_SLATS = 32;                       // slats per window
const BLIND_TILT = 30 * Math.PI / 180;        // slat tilt when lowered
const BLIND_DEPTH = 0.42;                      // front-back lath width (units) -> ~half-blocks at 30deg at this density
const BLIND_THICK = 0.09;                      // slat thickness
const BLIND_NEAR = 28;                         // raise the blinds within this distance of a window
const BLIND_DESCEND_DELAY = 2.0;               // seconds after leaving before they descend again
const BLIND_RATE = 0.85;                       // open/close speed (full travel ~1.2s)
let windowSlots = [];                          // {axis,fixed,c,gw,midY} pushed by windowWall, drained by buildBlinds
let _blindLast = 0;
// Exterior detailing: a long ribbon of 8' "privacy glass" windows (dark from outside) with
// matte-black mullions between them, plus a door near the middle of the front ribbon.
function addBuildingExterior(parent, px, pz, w, d, H) {
	const glass = makeDarkGlassMaterial();   // neighbouring buildings -> dark mirrored glass from outside
	const mullMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95, metalness: 0.25 });
	const winY = WIN_BOTTOM + WIN_SZ / 2, pitch = WIN_SZ + MULLION;
	// ribbon of windows centred on a wall. side 'z' = front/back (vary x); side 'x' = sides (vary z).
	const ribbon = (centreAlong, fixed, avail, side, withDoor) => {
		const count = Math.max(1, Math.floor(avail / pitch));
		const start = centreAlong - (count * pitch - MULLION) / 2 + WIN_SZ / 2;
		const doorIdx = withDoor ? Math.floor(count / 2) : -1;
		for (let i = 0; i < count; i++) {
			const a = start + i * pitch;
			if (i !== doorIdx) {
				const win = new THREE.Mesh(new THREE.PlaneGeometry(WIN_SZ, WIN_SZ), glass);
				if (side === 'x') { win.rotation.y = Math.PI / 2; win.position.set(fixed, winY, a); } else win.position.set(a, winY, fixed);
				parent.add(win);
			}
			if (i < count - 1) {
				const m = new THREE.Mesh(side === 'x' ? new THREE.BoxGeometry(0.5, WIN_SZ, MULLION) : new THREE.BoxGeometry(MULLION, WIN_SZ, 0.5), mullMat);
				if (side === 'x') m.position.set(fixed, winY, a + pitch / 2); else m.position.set(a + pitch / 2, winY, fixed);
				parent.add(m);
			}
		}
		return { doorAt: start + (doorIdx < 0 ? 0 : doorIdx) * pitch };
	};
	const fz = pz + d / 2;
	const ddx = ribbon(px, fz + 0.12, w - 8, 'z', true).doorAt;  // front ribbon + a centred door
	const frame = new THREE.Mesh(new THREE.BoxGeometry(8.5, 17.5, 0.6), new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.75 })); frame.position.set(ddx, 8.9, fz + 0.25); parent.add(frame);
	const door = new THREE.Mesh(new THREE.BoxGeometry(7.5, 16.5, 0.4), new THREE.MeshStandardMaterial({ color: 0x4a3c2c, roughness: 0.7 })); door.position.set(ddx, 8.4, fz + 0.45); parent.add(door);
	const knob = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 10), new THREE.MeshStandardMaterial({ color: 0xd9c46a, metalness: 0.8, roughness: 0.3 })); knob.position.set(ddx + 2.8, 8.4, fz + 0.7); parent.add(knob);
	ribbon(pz, px + w / 2 + 0.12, d - 8, 'x', false);            // right side ribbon
	ribbon(pz, px - w / 2 - 0.12, d - 8, 'x', false);            // left side ribbon
}
// Slightly-tinted glass: clear enough to read as a regular window from inside (you see out), with a
// light sheen + reflection that gives it a glassy/reflective look from outside.
function makeGlassMaterial() {
	return new THREE.MeshPhysicalMaterial({ color: 0x9fb6c4, metalness: 0.0, roughness: 0.05, transparent: true, opacity: 0.26, reflectivity: 0.6, envMapIntensity: 1.5, clearcoat: 0.6, clearcoatRoughness: 0.05, side: THREE.DoubleSide });
}
// Dark mirrored "privacy glass" for the OUTSIDE face: heavily tinted + much less transparent than the
// interior glass, with a strong reflective sheen so from outside it reads as a dark glassy mirror
// (not the old see-through pane). Used for the neighbouring buildings + the outward face of room windows.
function makeDarkGlassMaterial(side) {
	return new THREE.MeshPhysicalMaterial({ color: 0x0d1216, metalness: 0.5, roughness: 0.08, transparent: true, opacity: 0.82, reflectivity: 0.95, envMapIntensity: 2.6, clearcoat: 0.9, clearcoatRoughness: 0.04, side: side === undefined ? THREE.DoubleSide : side });
}
// A wall with a real ribbon of 8' windows: solid below the sill + above the head, a glass band (with
// matte-black mullions) between -> see-through from inside, reflective from outside. axis 'x' spans x
// (z = fixed); 'z' spans z (x = fixed). doorC = door centre along the wall, or null.
function windowWall(parent, axis, fixed, c0, c1, H, wallMat, glass, mullMat, doorC, swing, doorW) {
	const len = c1 - c0, cen = (c0 + c1) / 2, th = 0.4;
	const sill = WIN_BOTTOM, head = WIN_BOTTOM + WIN_SZ, DOOR_H = 17.5;
	let retDoor = null;   // when swing=true, the {pivot,...} for the door panel so the caller can animate it
	const wall = (w, h, along, y) => { const g = axis === 'x' ? new THREE.BoxGeometry(w, h, th) : new THREE.BoxGeometry(th, h, w); const m = new THREE.Mesh(g, wallMat); axis === 'x' ? m.position.set(along, y, fixed) : m.position.set(fixed, y, along); parent.add(m); };
	wall(len, H - head, cen, (head + H) / 2);                        // top strip (above the windows)
	if (doorC == null) { wall(len, sill, cen, sill / 2); }           // bottom strip (below the windows)
	else {
		const dw = doorW || 16, lL = (doorC - dw / 2) - c0, rL = c1 - (doorC + dw / 2);
		if (lL > 1) wall(lL, sill, c0 + lL / 2, sill / 2);
		if (rL > 1) wall(rL, sill, c1 - rL / 2, sill / 2);
		wall(dw, head - DOOR_H, doorC, (DOOR_H + head) / 2);         // panel above the door
		const doorMat = new THREE.MeshStandardMaterial({ color: 0x4a3c2c, roughness: 0.7 });
		const knobMat = new THREE.MeshStandardMaterial({ color: 0xd9c46a, metalness: 0.8, roughness: 0.3 });
		if (swing) {   // hinge the panel at one edge so it can swing open (buildRoom registers it for animation)
			const pivot = new THREE.Group();
			axis === 'x' ? pivot.position.set(doorC - dw / 2, 0, fixed) : pivot.position.set(fixed, 0, doorC - dw / 2);
			const dm = new THREE.Mesh(axis === 'x' ? new THREE.BoxGeometry(dw, DOOR_H, 0.5) : new THREE.BoxGeometry(0.5, DOOR_H, dw), doorMat);
			axis === 'x' ? dm.position.set(dw / 2, DOOR_H / 2, 0) : dm.position.set(0, DOOR_H / 2, dw / 2); pivot.add(dm);
			const kb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 10), knobMat);
			axis === 'x' ? kb.position.set(dw - 1.4, 9, 0.45) : kb.position.set(0.45, 9, dw - 1.4); pivot.add(kb);
			parent.add(pivot); retDoor = { pivot, axis, fixed, doorC, dw };
		} else {
			const dm = new THREE.Mesh(axis === 'x' ? new THREE.BoxGeometry(dw, DOOR_H, 0.5) : new THREE.BoxGeometry(0.5, DOOR_H, dw), doorMat);
			axis === 'x' ? dm.position.set(doorC, DOOR_H / 2, fixed) : dm.position.set(fixed, DOOR_H / 2, doorC); parent.add(dm);
			const kb = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 10), knobMat);
			axis === 'x' ? kb.position.set(doorC + 3, 9, fixed) : kb.position.set(fixed, 9, doorC + 3); parent.add(kb);
		}
	}
	// Tile the window band (sill..head) SEAMLESSLY: solid wall with the occasional window punched in
	// (no gaps). Non-door walls get a window every ~3rd bay; the door wall is wall everywhere except
	// the door opening + exactly one window flanking each side of it.
	const midY = (sill + head) / 2, bandH = head - sill;
	const wallStrip = (x0, x1) => {                       // solid wall covering [x0,x1] of the band
		const wl = x1 - x0; if (wl < 0.1) return;
		const g = axis === 'x' ? new THREE.BoxGeometry(wl, bandH, th) : new THREE.BoxGeometry(th, bandH, wl);
		const m = new THREE.Mesh(g, wallMat); const c = (x0 + x1) / 2;
		axis === 'x' ? m.position.set(c, midY, fixed) : m.position.set(fixed, midY, c); parent.add(m);
	};
	const glassPane = (c, gw) => {                        // a window of width gw centred at c
		const gm = new THREE.Mesh(new THREE.PlaneGeometry(gw, WIN_SZ), glass);
		if (axis === 'z') gm.rotation.y = Math.PI / 2;
		axis === 'x' ? gm.position.set(c, midY, fixed) : gm.position.set(fixed, midY, c); parent.add(gm);
	};
	const mullion = (c) => {                              // thin black frame at a window edge
		const g = axis === 'x' ? new THREE.BoxGeometry(MULLION, WIN_SZ, 0.6) : new THREE.BoxGeometry(0.6, WIN_SZ, MULLION);
		const m = new THREE.Mesh(g, mullMat); axis === 'x' ? m.position.set(c, midY, fixed) : m.position.set(fixed, midY, c); parent.add(m);
	};
	const window = (c, gw) => { glassPane(c, gw); mullion(c - gw / 2); mullion(c + gw / 2); windowSlots.push({ axis, fixed, c, gw, midY }); };
	// Tile a [a,b] span of the band with 8' windows punched into 8' bays, leaving 1 or 3 solid bays
	// between windows (alternating, for a varied rhythm). The two end bays stay solid so the wall
	// corners (and the posters hung near them) sit on solid wall.
	const tileBand = (a, b) => {
		const L = b - a; if (L < WIN_SZ + 1) { wallStrip(a, b); return; }
		// floor (not round) the bay count so step is ALWAYS >= pitch > WIN_SZ -> a window always fits its
		// bay. round() can land step just under WIN_SZ on some wall lengths, which silently drops every
		// window on that wall (the bug that left some buildings nearly windowless).
		const bays = Math.max(1, Math.floor(L / (WIN_SZ + MULLION))), step = L / bays;
		let nextWin = 1, tog = 0;
		for (let i = 0; i < bays; i++) {
			const x0 = a + i * step, x1 = x0 + step, c = (x0 + x1) / 2;
			if (i === nextWin && i < bays - 1 && step > WIN_SZ) {
				wallStrip(x0, c - WIN_SZ / 2); window(c, WIN_SZ); wallStrip(c + WIN_SZ / 2, x1);
				nextWin = i + 1 + (tog++ % 4 === 3 ? 3 : 1);   // mostly 1 solid bay between windows, an occasional 3-bay pier
			} else wallStrip(x0, x1);
		}
	};
	if (doorC != null) {
		const dHalf = (doorW || 16) / 2;
		tileBand(c0, doorC - dHalf);     // corner -> door
		tileBand(doorC + dHalf, c1);     // door -> corner
	} else {
		tileBand(c0, c1);
	}
	return retDoor;
}
// Build ONE InstancedMesh holding every slat of every window (1 draw call) + a merged static mesh of
// the pull-cords. Returns the handle stored on objects.room.blinds and animated by updateBlinds().
function buildBlinds(parent, roomCx, roomCz, slots, addDarkPane) {
	if (!slots || !slots.length) return null;
	const slatGeo = new THREE.BoxGeometry(1, BLIND_THICK, BLIND_DEPTH);   // local x = width (scaled per instance)
	const slatMat = new THREE.MeshStandardMaterial({ color: 0xd7d1c4, roughness: 0.72, metalness: 0.04, side: THREE.DoubleSide });
	const inst = new THREE.InstancedMesh(slatGeo, slatMat, slots.length * BLIND_SLATS);
	inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
	inst.frustumCulled = false;
	// cords are an InstancedMesh too (2 per window) so they RETRACT with the blind (the string rises as
	// the slats gather, instead of dangling full-length over a cleared window). unit-height; scaled in layoutBlinds.
	const cordGeo = new THREE.BoxGeometry(0.1, 1, 0.1);
	const cords = new THREE.InstancedMesh(cordGeo, new THREE.MeshStandardMaterial({ color: 0x6b6b6b, roughness: 0.85 }), slots.length * 2);
	cords.instanceMatrix.setUsage(THREE.DynamicDrawUsage); cords.frustumCulled = false;
	const darkMat = addDarkPane ? makeDarkGlassMaterial(THREE.FrontSide) : null;   // dark-outside pane (main room only; neighbours use tinted glass)
	const wins = [], inch = UNITS_PER_INCH;
	for (const sl of slots) {
		const y0 = sl.midY - WIN_SZ / 2;
		let nx = 0, nz = 0, yaw = 0;                                       // inward normal + width-axis yaw
		if (sl.axis === 'x') { nz = Math.sign(roomCz - sl.fixed) || 1; }   // wall spans x -> faces +/-z
		else { nx = Math.sign(roomCx - sl.fixed) || 1; yaw = Math.PI / 2; }// wall spans z -> faces +/-x
		const inset = 0.7;
		const px = sl.axis === 'x' ? sl.c : sl.fixed + nx * inset;
		const pz = sl.axis === 'x' ? sl.fixed + nz * inset : sl.c;
		const coff = sl.gw / 2 - inch;                                     // cord (x,z) positions, an inch in from each end
		const cordXZ = sl.axis === 'x' ? [[sl.c - coff, pz], [sl.c + coff, pz]] : [[px, sl.c - coff], [px, sl.c + coff]];
		wins.push({ y0, gw: sl.gw, yaw, px, pz, cordXZ, center: new THREE.Vector3(px, sl.midY, pz), open: 0, target: 0, leaveT: -1e9 });
		if (darkMat) {
			const dg = new THREE.PlaneGeometry(sl.gw, WIN_SZ);
			if (sl.axis === 'x') { dg.rotateY(nz > 0 ? Math.PI : 0); dg.translate(sl.c, sl.midY, sl.fixed - nz * 0.2); }
			else { dg.rotateY(nx > 0 ? -Math.PI / 2 : Math.PI / 2); dg.translate(sl.fixed - nx * 0.2, sl.midY, sl.c); }
			parent.add(new THREE.Mesh(dg, darkMat));   // separate mesh per pane -> correct transparency sorting
		}
	}
	parent.add(inst); parent.add(cords);
	const handle = { inst, cords, wins };
	layoutBlinds(handle);                                                  // initial matrices -> all lowered
	return handle;
}
const _bd = new THREE.Object3D(), _qTilt = new THREE.Quaternion(), _qYaw = new THREE.Quaternion(), _bq = new THREE.Quaternion();
const _bX = new THREE.Vector3(1, 0, 0), _bY = new THREE.Vector3(0, 1, 0);
// Lay out every slat from each window's current `open` (0 = down/tilted, 1 = raised/stacked at top).
// Raise = bottom-up gather: the gather point rises from sill to head; gathered slats stack tightly
// just under it (near-flat), the rest still hang at their lowered tilt.
function layoutBlinds(h) {
	const spacing = WIN_SZ / BLIND_SLATS, pack = BLIND_THICK * 1.5;
	let idx = 0, cIdx = 0;
	for (const w of h.wins) {
		const gatherY = w.y0 + w.open * WIN_SZ;
		let G = 0; for (let i = 0; i < BLIND_SLATS; i++) if (w.y0 + (i + 0.5) * spacing <= gatherY) G++;
		for (let i = 0; i < BLIND_SLATS; i++) {
			let y, tilt;
			if (i < G) { y = gatherY - (G - 1 - i) * pack; tilt = BLIND_TILT * 0.18; }
			else { y = w.y0 + (i + 0.5) * spacing; tilt = BLIND_TILT; }
			_qTilt.setFromAxisAngle(_bX, tilt); _qYaw.setFromAxisAngle(_bY, w.yaw); _bq.copy(_qYaw).multiply(_qTilt);
			_bd.position.set(w.px, y, w.pz); _bd.quaternion.copy(_bq); _bd.scale.set(w.gw, 1, 1); _bd.updateMatrix();
			h.inst.setMatrixAt(idx++, _bd.matrix);
		}
		// cords span from the head (y1) down to the bottom of the lowest slat -> they shorten/rise with the blind
		if (h.cords) {
			const y1 = w.y0 + WIN_SZ, cordBottom = G > 0 ? (gatherY - (G - 1) * pack) : w.y0;
			const cLen = Math.max(0.01, y1 - cordBottom), cMid = (y1 + cordBottom) / 2;
			for (const c of w.cordXZ) { _bd.position.set(c[0], cMid, c[1]); _bd.quaternion.identity(); _bd.scale.set(1, cLen, 1); _bd.updateMatrix(); h.cords.setMatrixAt(cIdx++, _bd.matrix); }
		}
	}
	h.inst.instanceMatrix.needsUpdate = true;
	if (h.cords) h.cords.instanceMatrix.needsUpdate = true;
}
// Per-frame: raise the blinds on windows the viewer is near, lower them 2s after they leave.
function updateBlinds() {
	const handles = [];
	if (objects.room && objects.room.blinds) handles.push(objects.room.blinds);
	for (const h of neighborBlinds) handles.push(h);   // every neighbour's blinds raise on proximity too (from outside)
	if (!handles.length) return;
	const now = performance.now();
	let dt = _blindLast ? (now - _blindLast) / 1000 : 0; _blindLast = now;
	if (dt <= 0) return; if (dt > 0.1) dt = 0.1;
	const nowS = now / 1000, cam = camera.position, step = BLIND_RATE * dt;
	for (const h of handles) {
		let any = false;
		for (const w of h.wins) {
			if (cam.distanceTo(w.center) < BLIND_NEAR) { w.target = 1; w.leaveT = nowS; }
			else if (nowS - w.leaveT > BLIND_DESCEND_DELAY) { w.target = 0; }
			if (w.open !== w.target) {
				w.open = w.open < w.target ? Math.min(w.target, w.open + step) : Math.max(w.target, w.open - step);
				any = true;
			}
		}
		if (any) layoutBlinds(h);
	}
}
// Tinted glass for the neighbour curtain-walls: see-through enough to read the rack BLOCKS inside as
// dark cabinet rows, glassy/reflective from outside. Lighter than the room's privacy glass on purpose.
function makeNeighborGlassMaterial() {
	return new THREE.MeshPhysicalMaterial({ color: 0x243443, metalness: 0.4, roughness: 0.12, transparent: true, opacity: 0.5, reflectivity: 0.7, envMapIntensity: 1.8, clearcoat: 0.5, clearcoatRoughness: 0.06, side: THREE.DoubleSide });
}
// Cheap rack proxies for a neighbour: one tall box per real rack, MERGED into a single opaque mesh
// (1 draw call for the whole building) + matching x/z colliders. Placed by the same coordinate
// transform as the current building, offset by (dx,dz) into the neighbour's community plot.
const BLOCK_W = 5.4, BLOCK_D = 6.4, BLOCK_H = 18;   // a cabinet-ish proxy (real racks are ~20u tall)
function buildRackBlocks(id, dx, dz, mat) {
	const racks = (locations[id] || {}).racks || {};
	const geos = [], colliders = [];
	for (const k in racks) {
		const r = racks[k];
		const p = convertRackCoordinatesToPosition(r.x, r.y);
		const wx = p.x + dx, wz = p.z + dz;
		const g = new THREE.BoxGeometry(BLOCK_W, BLOCK_H, BLOCK_D); g.translate(wx, BLOCK_H / 2, wz); geos.push(g);
		colliders.push({ minX: wx - BLOCK_W / 2, maxX: wx + BLOCK_W / 2, minZ: wz - BLOCK_D / 2, maxZ: wz + BLOCK_D / 2 });
	}
	if (!geos.length) return null;
	const mesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(geos), mat);
	geos.forEach((g) => g.dispose());
	return { mesh, colliders };
}
// An open doorway frame (two posts + a lintel) on one side of a neighbour: 'N'/'S' = a gap in the
// z-wall (varies x), 'E'/'W' = a gap in the x-wall (varies z). doorC is the gap centre along that wall.
function addDoorway(grp, side, px, pz, f, doorC, doorHalf, dH, mat) {
	const post = (x, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, dH, 0.9), mat); m.position.set(x, dH / 2, z); grp.add(m); };
	if (side === 'N' || side === 'S') {
		const fz = pz + (side === 'S' ? f.d / 2 : -f.d / 2);
		post(doorC - doorHalf, fz); post(doorC + doorHalf, fz);
		const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorHalf * 2 + 1.8, 1.3, 0.9), mat); lintel.position.set(doorC, dH, fz); grp.add(lintel);
	} else {
		const fx = px + (side === 'E' ? f.w / 2 : -f.w / 2);
		post(fx, doorC - doorHalf); post(fx, doorC + doorHalf);
		const lintel = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, doorHalf * 2 + 1.8), mat); lintel.position.set(fx, dH, doorC); grp.add(lintel);
	}
}
// A neighbour's outer shell, matching the current building's exterior: mostly SOLID wall with the
// occasional window (every ~3rd bay). Built as ONE merged opaque mesh per building (cheap for ~11 of
// them) plus its window panes. The door-side wall is left open at the doorway (doorSide N/S/E/W).
function buildNeighborShell(grp, px, pz, f, H, doorSide, doorC, doorHalf, wallMat, glassMat) {
	const TH = 0.6, sill = WIN_BOTTOM, head = WIN_BOTTOM + WIN_SZ, doorH = sill + WIN_SZ * 0.8;
	const midY = (sill + head) / 2, bandH = head - sill;
	const minX = px - f.w / 2, maxX = px + f.w / 2, minZ = pz - f.d / 2, maxZ = pz + f.d / 2;
	const op = [], panes = [], slots = [];
	const wbox = (axis, fixed, aC, aLen, yC, yH) => { if (aLen < 0.1 || yH < 0.1) return; const g = axis === 'x' ? new THREE.BoxGeometry(aLen, yH, TH) : new THREE.BoxGeometry(TH, yH, aLen); g.translate(axis === 'x' ? aC : fixed, yC, axis === 'x' ? fixed : aC); op.push(g); };
	const pane = (axis, fixed, aC, gw) => { const g = new THREE.PlaneGeometry(gw, WIN_SZ); if (axis === 'z') g.rotateY(Math.PI / 2); g.translate(axis === 'x' ? aC : fixed, midY, axis === 'x' ? fixed : aC); panes.push(g); slots.push({ axis, fixed, c: aC, gw, midY }); };
	const wall = (axis, fixed, c0, c1, hasDoor) => {
		const cuts = [c0, c1]; if (hasDoor) cuts.push(doorC - doorHalf, doorC + doorHalf); cuts.sort((a, b) => a - b);
		for (let i = 0; i < cuts.length - 1; i++) {
			const a = cuts[i], b = cuts[i + 1], segLen = b - a; if (segLen < 0.1) continue;
			if (hasDoor && a >= doorC - doorHalf - 0.01 && b <= doorC + doorHalf + 0.01) { wbox(axis, fixed, (a + b) / 2, segLen, (doorH + H) / 2, H - doorH); continue; } // wall above the doorway only
			wbox(axis, fixed, (a + b) / 2, segLen, sill / 2, sill);           // solid below the windows
			wbox(axis, fixed, (a + b) / 2, segLen, (head + H) / 2, H - head); // solid above the windows
			const bays = Math.max(1, Math.floor(segLen / (WIN_SZ + MULLION))), step = segLen / bays;   // floor -> step always >= pitch > WIN_SZ so windows always fit (same fix as the main building)
			let nextWin = 1, tog = 0;
			for (let k = 0; k < bays; k++) {
				const x0 = a + k * step, x1 = x0 + step, cc = (x0 + x1) / 2;
				if (k === nextWin && k < bays - 1 && step > WIN_SZ) {           // window (1 or 3 solid bays between): solid flanks + a glass pane
					wbox(axis, fixed, (x0 + cc - WIN_SZ / 2) / 2, (cc - WIN_SZ / 2) - x0, midY, bandH);
					wbox(axis, fixed, (cc + WIN_SZ / 2 + x1) / 2, x1 - (cc + WIN_SZ / 2), midY, bandH);
					pane(axis, fixed, cc, WIN_SZ);
					nextWin = k + 1 + (tog++ % 4 === 3 ? 3 : 1);   // mostly 1 solid bay between windows, an occasional 3-bay pier
				} else wbox(axis, fixed, cc, step, midY, bandH);              // solid wall bay
			}
		}
	};
	wall('x', minZ, minX, maxX, doorSide === 'N');   // back
	wall('x', maxZ, minX, maxX, doorSide === 'S');   // front
	wall('z', minX, minZ, maxZ, doorSide === 'W');   // left
	wall('z', maxX, minZ, maxZ, doorSide === 'E');   // right
	if (op.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(op), wallMat); op.forEach((g) => g.dispose()); grp.add(m); }
	for (const g of panes) grp.add(new THREE.Mesh(g, glassMat));   // individual panes -> correct transparency sorting
	return slots;   // window slots (world coords) -> buildBlinds gives this neighbour the same venetian blinds
}
// InterServer "iS" mark on a transparent canvas (orange i-stem + blue dot + blue swoosh S), for the
// neighbour entrance doors (mirrors dc-multi's main-building door logo).
function makeISLogoTexture() {
	const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
	const g = c.getContext('2d'), blue = '#2E8BCE', orange = '#F39019';
	g.fillStyle = orange; g.fillRect(s * 0.20, s * 0.30, s * 0.075, s * 0.55);
	g.fillStyle = blue; g.fillRect(s * 0.19, s * 0.14, s * 0.095, s * 0.095);
	g.strokeStyle = blue; g.lineWidth = s * 0.085; g.lineCap = 'round'; g.beginPath();
	g.moveTo(s * 0.80, s * 0.27);
	g.bezierCurveTo(s * 0.46, s * 0.13, s * 0.40, s * 0.45, s * 0.62, s * 0.52);
	g.bezierCurveTo(s * 0.86, s * 0.60, s * 0.72, s * 0.92, s * 0.34, s * 0.78);
	g.stroke();
	const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
// Two glass leaves with the iS logo at a neighbour's doorway (doorSide N/S/E/W). They swing OUTWARD on
// their hinges, opened on approach by updateNeighborDoors. Returns a handle stored in neighborDoors.
function buildNeighborDoor(grp, b, logoTex, glassMat, frameMat) {
	const side = b.doorSide, doorC = b.doorC, HW = b.doorHalf, H = WIN_BOTTOM + WIN_SZ * 0.8;
	const axis = (side === 'N' || side === 'S') ? 'x' : 'z';
	const F = side === 'S' ? b.maxZ : side === 'N' ? b.minZ : side === 'E' ? b.maxX : b.minX;
	const outSign = (side === 'S' || side === 'E') ? 1 : -1;
	const w = HW - 0.12;
	const mkLeaf = (sign) => {
		const pivot = new THREE.Group();
		if (axis === 'x') pivot.position.set(doorC + sign * HW, 0, F); else pivot.position.set(F, 0, doorC + sign * HW);
		const lc = -sign * w / 2;   // pane centre offset from the hinge toward the door centre
		const pane = new THREE.Mesh(axis === 'x' ? new THREE.BoxGeometry(w, H, 0.16) : new THREE.BoxGeometry(0.16, H, w), glassMat);
		if (axis === 'x') pane.position.set(lc, H / 2, 0); else pane.position.set(0, H / 2, lc); pivot.add(pane);
		const rail = new THREE.Mesh(axis === 'x' ? new THREE.BoxGeometry(w, 0.18, 0.22) : new THREE.BoxGeometry(0.22, 0.18, w), frameMat);
		if (axis === 'x') rail.position.set(lc, H - 0.1, 0); else rail.position.set(0, H - 0.1, lc); pivot.add(rail);
		[0.12, -0.12].forEach((d) => {
			const lg = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.7, w * 0.7), new THREE.MeshBasicMaterial({ map: logoTex, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide }));
			// face the logo OUTWARD per door side so it reads correct from outside (mirrored from inside), like the main building
			if (axis === 'x') { lg.rotation.y = outSign > 0 ? 0 : Math.PI; lg.position.set(lc, H * 0.55, d); }
			else { lg.rotation.y = outSign > 0 ? Math.PI / 2 : -Math.PI / 2; lg.position.set(d, H * 0.55, lc); }
			pivot.add(lg);
		});
		grp.add(pivot); return pivot;
	};
	const left = mkLeaf(-1), right = mkLeaf(1);
	const leftSign = axis === 'x' ? -outSign : outSign;   // open angle sign so the leaves swing outward
	return { left, right, leftSign, cx: axis === 'x' ? doorC : F, cz: axis === 'x' ? F : doorC, open: 0, target: 0, lastNear: -1e9 };
}
let _ndLast = 0;
// Per-frame: swing each neighbour's entrance doors open when the player nears, shut a few seconds after.
function updateNeighborDoors() {
	if (!neighborDoors.length || !camera) return;
	const now = performance.now();
	let dt = _ndLast ? (now - _ndLast) / 1000 : 0; _ndLast = now;
	if (dt <= 0) return; if (dt > 0.1) dt = 0.1;
	const fx = lodFocus ? lodFocus.x : camera.position.x, fz = lodFocus ? lodFocus.z : camera.position.z;
	for (const d of neighborDoors) {
		if (Math.hypot(fx - d.cx, fz - d.cz) < 18) d.lastNear = now;
		d.target = (now - d.lastNear < 3000) ? 1 : 0;
		d.open += (d.target - d.open) * Math.min(1, dt * 6);
		if (Math.abs(d.open - d.target) < 0.002) d.open = d.target;
		const a = d.open * Math.PI / 2;
		d.left.rotation.y = d.leftSign * a; d.right.rotation.y = -d.leftSign * a;
	}
}
let _rdLast = 0;
// Per-frame: swing the main building's solid back/left doors open when the player nears, shut after 3s.
function updateRoomDoors() {
	if (!roomDoors.length || !camera) return;
	const now = performance.now();
	let dt = _rdLast ? (now - _rdLast) / 1000 : 0; _rdLast = now;
	if (dt <= 0) return; if (dt > 0.1) dt = 0.1;
	const fx = lodFocus ? lodFocus.x : camera.position.x, fz = lodFocus ? lodFocus.z : camera.position.z;
	for (const d of roomDoors) {
		if (Math.hypot(fx - d.cx, fz - d.cz) < 16) d.lastNear = now;
		d.target = (now - d.lastNear < 3000) ? 1 : 0;
		d.open += (d.target - d.open) * Math.min(1, dt * 6);
		if (Math.abs(d.open - d.target) < 0.002) d.open = d.target;
		d.pivot.rotation.y = d.openSign * d.open * Math.PI / 2;
	}
}
function buildCommunity() {
	lodBuildings = []; dcBuildings = []; wallColliders = []; neighborBlinds = []; neighborDoors = [];
	// eslint-disable-next-line no-unused-vars
	for (const k in _spatialGrid) delete _spatialGrid[k]; // clear spatial hash (Fix A)
	const ids = Object.keys(locationNames).map((n) => Number(locationNames[n])).filter((id) => locationLoaded(id));
	ids.sort((a, b) => locName(a).localeCompare(locName(b)));
	// the CURRENT building's walls/door go in the descriptor list too (walkability + lot perimeter)
	if (roomBounds) dcBuildings.push({ id: Number(options.location), kind: 'current', minX: roomBounds.minX, maxX: roomBounds.maxX, minZ: roomBounds.minZ, maxZ: roomBounds.maxZ, doorSide: 'S', doorC: (roomBounds.minX + roomBounds.maxX) / 2, doorHalf: 8, extraDoors: roomSideDoors });
	if (ids.length >= 2) {
		const foot = {}; let maxW = 0, maxD = 0;
		for (const id of ids) { const f = locationFootprint(id); if (f) { foot[id] = f; maxW = Math.max(maxW, f.w); maxD = Math.max(maxD, f.d); } }
		const ncols = Math.ceil(Math.sqrt(ids.length));
		const cellW = maxW + 90, cellD = maxD + 90;                 // ~street width between plots
		const cell = {}; ids.forEach((id, i) => { cell[id] = { col: i % ncols, row: Math.floor(i / ncols) }; });
		const cur = sceneBounds();                                  // the current building's world centre
		const ci = cell[options.location] || { col: 0, row: 0 };
		const grp = new THREE.Group();
		const wallMat = new THREE.MeshStandardMaterial({ color: 0xcfc8b8, roughness: 0.9 });
		const roofMat = new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.85 });
		const frameMat = new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.75 });
		const glassMat = makeNeighborGlassMaterial();
		const blockMat = new THREE.MeshStandardMaterial({ color: 0x2a2f37, roughness: 0.68, metalness: 0.14, emissive: 0x10141b });
		const sill = WIN_BOTTOM;
		// shared assets for the neighbour entrance doors (iS-logo glass leaves, like the main building's door)
		const logoTex = makeISLogoTexture();
		const doorGlassMat = new THREE.MeshPhysicalMaterial({ color: 0x9fb6c4, metalness: 0, roughness: 0.06, transparent: true, opacity: 0.34, reflectivity: 0.6, clearcoat: 0.6, clearcoatRoughness: 0.05, side: THREE.DoubleSide });
		const doorFrameMat = new THREE.MeshStandardMaterial({ color: 0x20242a, metalness: 0.7, roughness: 0.4 });
		for (const id of ids) {
			if (Number(id) === Number(options.location)) continue;  // current building is the real one
			const f = foot[id]; if (!f) continue;
			const px = cur.cx + (cell[id].col - ci.col) * cellW;
			const pz = cur.cz + (cell[id].row - ci.row) * cellD;
			const H = ROOM_CEIL_Y, dx = px - f.cx, dz = pz - f.cz;
			// doorway faces the HUB (the current building you walk out from) so you cross the street straight in.
			// pick the wall side whose outward normal points toward the hub centre; collision opens that gap to match.
			const doorHalf = 8, dH = sill + WIN_SZ * 0.8, toHubX = cur.cx - px, toHubZ = cur.cz - pz;
			let doorSide, doorC;
			if (Math.abs(toHubZ) >= Math.abs(toHubX)) { doorSide = toHubZ < 0 ? 'N' : 'S'; doorC = px; }
			else { doorSide = toHubX < 0 ? 'W' : 'E'; doorC = pz; }
			// mostly-solid walls with the occasional window (matches the current building), then roof + sign + doorway
			const winSlots = buildNeighborShell(grp, px, pz, f, H, doorSide, doorC, doorHalf, wallMat, glassMat);
			const bh = buildBlinds(grp, px, pz, winSlots, false);   // same venetian blinds as the main room (tinted glass already dark from outside -> no extra pane)
			if (bh) neighborBlinds.push(bh);
			const roof = new THREE.Mesh(new THREE.BoxGeometry(f.w + 4, 1.5, f.d + 4), roofMat); roof.position.set(px, H + 1.25, pz); grp.add(roof);   // sits a touch above the wall top so the interior drop-ceiling hides its underside (no z-fight)
			const sign = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(f.w * 0.7, 46), 11), new THREE.MeshBasicMaterial({ map: makeSignTexture(locName(id)) }));
			sign.position.set(px, H * 0.74, pz + f.d / 2 + 0.5); grp.add(sign);
			addDoorway(grp, doorSide, px, pz, f, doorC, doorHalf, dH, frameMat);
			neighborDoors.push(buildNeighborDoor(grp, { doorSide, doorC, doorHalf, minX: px - f.w / 2, maxX: px + f.w / 2, minZ: pz - f.d / 2, maxZ: pz + f.d / 2 }, logoTex, doorGlassMat, doorFrameMat));
			// cheap rack BLOCKS inside (collision + LOD placeholder; glimpsed through the windows, full models on approach)
			const blk = buildRackBlocks(id, dx, dz, blockMat);
			if (blk) grp.add(blk.mesh);
			lodBuildings.push({ id: Number(id), foot: f, dx, dz, cx: px, cz: pz,
				minX: px - f.w / 2, maxX: px + f.w / 2, minZ: pz - f.d / 2, maxZ: pz + f.d / 2, doorSide, doorC, doorHalf,
				blocks: blk ? blk.mesh : null, blockColliders: blk ? blk.colliders : [], full: null, loading: false, _dist: Infinity });
			dcBuildings.push({ id: Number(id), kind: 'neighbor', minX: px - f.w / 2, maxX: px + f.w / 2, minZ: pz - f.d / 2, maxZ: pz + f.d / 2, doorSide, doorC, doorHalf });
		}
		_rebuildSpatialGrid(); // build spatial hash for collideWorld (Fix A)
		scene.add(grp); objects.community = grp;
	}
	buildWallColliders();
}
// Thin AABB slabs for every building wall, with the door-side wall split around its gap so doorways are
// passable, plus a fence around the whole lot. Fed to collideWorld() for walk-between collision.
function buildWallColliders() {
	wallColliders = [];
	const T = 1.4, push = (minX, maxX, minZ, maxZ) => wallColliders.push({ minX, maxX, minZ, maxZ });
	// add a wall spanning [c0,c1] along `axis` at the fixed cross-coord; if splitC != null leave a door gap
	const addWall = (axis, fixed, c0, c1, splitC, splitHalf) => {
		const segs = splitC == null ? [[c0, c1]] : [];
		if (splitC != null) { if (splitC - splitHalf > c0) segs.push([c0, splitC - splitHalf]); if (splitC + splitHalf < c1) segs.push([splitC + splitHalf, c1]); }
		for (const s of segs) { if (axis === 'x') push(s[0] - T, s[1] + T, fixed - T, fixed + T); else push(fixed - T, fixed + T, s[0] - T, s[1] + T); }
	};
	let LX = Infinity, RX = -Infinity, BZ = Infinity, FZ = -Infinity;
	for (const b of dcBuildings) {
		LX = Math.min(LX, b.minX); RX = Math.max(RX, b.maxX); BZ = Math.min(BZ, b.minZ); FZ = Math.max(FZ, b.maxZ);
		const doors = [{ side: b.doorSide, c: b.doorC, half: b.doorHalf }].concat(b.extraDoors || []); // primary + any extra doors
		const dOn = (side) => doors.find((d) => d.side === side);
		const dN = dOn('N'), dS = dOn('S'), dW = dOn('W'), dE = dOn('E');
		addWall('x', b.minZ, b.minX, b.maxX, dN ? dN.c : null, dN ? dN.half : 0); // back  (minZ)
		addWall('x', b.maxZ, b.minX, b.maxX, dS ? dS.c : null, dS ? dS.half : 0); // front (maxZ)
		addWall('z', b.minX, b.minZ, b.maxZ, dW ? dW.c : null, dW ? dW.half : 0); // left  (minX)
		addWall('z', b.maxX, b.minZ, b.maxZ, dE ? dE.c : null, dE ? dE.half : 0); // right (maxX)
	}
	if (isFinite(LX)) {                                          // lot perimeter so you can't wander to infinity
		const M = 80, TT = 6; LX -= M; RX += M; BZ -= M; FZ += M;
		push(LX - TT, RX + TT, BZ - TT, BZ); push(LX - TT, RX + TT, FZ, FZ + TT);
		push(LX - TT, LX, BZ - TT, FZ + TT); push(RX, RX + TT, BZ - TT, FZ + TT);
	}
}
// distance from (x,z) to a building's wall rect (0 when inside) -> drives the LOD swap
function distToRect(x, z, b) {
	const dx = Math.max(b.minX - x, 0, x - b.maxX), dz = Math.max(b.minZ - z, 0, z - b.maxZ);
	return Math.hypot(dx, dz);
}
// Unified walk-between collision: all building WALLS (door gaps open) + the current building's racks +
// each neighbour's ACTIVE interior (blocks, or full racks once swapped). Read live, so no rebuilds.
// dc.html still confines itself via roomBounds; only the dc-multi player uses this.
function collideWorld(x, z, r) {
	const hit = (c) => x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ;
	for (const c of wallColliders) if (hit(c)) return true;
	for (const c of rackColliders) if (hit(c)) return true;     // current building furniture (live)
	// Use spatial grid to get only nearby buildings (Fix A)
	const cx = Math.floor(x / _gridCellSize);
	const cz = Math.floor(z / _gridCellSize);
	// MAJOR-2: Use a Set for O(1) deduplication instead of O(n) .includes() per item
	const nearbySet = new Set();
	// Collect from the 3x3 neighborhood of cells
	for (let dx = -1; dx <= 1; dx++) {
		for (let dz = -1; dz <= 1; dz++) {
			const cell = _spatialGrid[(cx + dx) + ',' + (cz + dz)];
			if (cell) {
				for (const nb of cell) {
					// Avoid duplicates if building spans multiple cells — O(1) with Set
					nearbySet.add(nb);
				}
			}
		}
	}
	// Fallback: if grid is empty (shouldn't happen), fall back to full scan
	if (nearbySet.size === 0) for (const nb of lodBuildings) nearbySet.add(nb);
	for (const b of nearbySet) {
		if (!b) continue;
		if (x < b.minX - r - 1 || x > b.maxX + r + 1 || z < b.minZ - r - 1 || z > b.maxZ + r + 1) continue; // far from this plot -> skip its interior
		// A neighbour mid-swap (enterFull/exitFull run from async model loads, between frames) can be
		// missing its collider list. collideWorld is called from the render loop, and an exception there
		// kills the loop outright, so never assume the array is there.
		const cols = (b.full ? b.full.colliders : b.blockColliders) || [];
		for (let i = 0; i < cols.length; i++) {
			const c = cols[i];
			if (!c) continue;
			if (hit(c)) return true;
		}
	}
	return false;
}
// Load a rack/server model TYPE into the shared cache (models.racks/servers, keyed by type index) if
// missing, resolving when ready. Mirrors getRackModels()/getServerModels()'s loader; reused for both the
// current building and neighbours, so any type a neighbour needs is fetched once and shared thereafter.
function loadRackType(t) {
	return new Promise((res) => {
		if (models.racks[t] !== undefined) return res();
		const name = rackModelName(t);
		if (name === null) return res();          // nothing to fetch -> settle now, don't wait out the race below
		loadGlbWithFallback(dcUrl('/images/3d/racks/'), name, (gltf) => {
			const model = gltf.scene; model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
			models.racks[t] = extractModelMeshes(model, 10); res();
		}, res);                                  // every variant 404'd: already logged + noticed, just stop blocking
	});
}
function loadServerType(t) {
	return new Promise((res) => {
		if (models.servers[t] !== undefined) return res();
		const name = serverModelName(t);
		if (name === null) return res();
		loadGlbWithFallback(dcUrl('/images/3d/servers/gltf/exported-centered/'), name, (gltf) => {
			const model = gltf.scene; model.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
			models.servers[t] = extractModelMeshes(model, 10); res();
		}, res);
	});
}
// Ensure every rack + server type used by location `id` is loaded, then call cb. The 12s race guard means
// a 404'd variant can never permanently wedge a building in the "loading" state.
function loadBuildingModels(id, cb) {
	const racks = (locations[id] || {}).racks || {};
	const rt = new Set(), st = new Set();
	for (const k in racks) { rt.add(racks[k].type); const sv = racks[k].servers || {}; for (const sk in sv) st.add(sv[sk].type); }
	const tasks = [];
	rt.forEach((t) => { if (models.racks[t] === undefined) tasks.push(loadRackType(t)); });
	st.forEach((t) => { if (models.servers[t] === undefined) tasks.push(loadServerType(t)); });
	if (!tasks.length) return cb();
	Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, 12000))]).then(cb);
}
// Build a neighbour's FULL racks+servers (same instanced models as the current building) into its own
// group at the neighbour's world offset (dx,dz), with its own collider list. No labels/highlight (cheap,
// and keeps neighbour meshes out of the current building's pick/label sets).
function buildBuildingFull(id, dx, dz) {
	const group = new THREE.Group(), sink = { group, meshes: [], colliders: [] };
	const racks = (locations[id] || {}).racks || {};
	const byR = {};
	for (const k in racks) { const t = racks[k].type; (byR[t] || (byR[t] = [])).push({ k, r: racks[k] }); }
	for (const t in byR) {
		const model = models.racks[t]; if (!model) continue;
		const placements = byR[t].map(({ k, r }) => { const p = convertRackCoordinatesToPosition(r.x, r.y); return { x: p.x + dx, y: 0, z: p.z + dz, assetId: k, asset: r }; });
		buildInstanced(model, placements, 'rack', sink);
	}
	const byS = {};
	for (const k in racks) { const r = racks[k], sv = r.servers || {}; for (const sk in sv) { const s = sv[sk]; (byS[s.type] || (byS[s.type] = [])).push({ sk, s, r }); } }
	for (const t in byS) {
		const model = models.servers[t]; if (!model) continue;
		const placements = byS[t].map(({ sk, s, r }) => { const p = convertServerCoordinatesToPosition(r.x, r.y, s.start); return { x: p.x + dx, y: p.y, z: p.z + dz, assetId: sk, asset: s }; });
		buildInstanced(model, placements, 'server', sink);
	}
	// this building's own switch cabling (into the full group) + rack/host labels (into the global
	// objects.labels/rackLabels so updateLabels distance-culls them; tracked on sink for exitFull removal)
	displaySwitches(id, dx, dz, sink);
	sink.labels = [];
	for (const k in racks) {
		const r = racks[k], p = convertRackCoordinatesToPosition(r.x, r.y);
		const rl = displayRackText(r.name, r, p.x + dx, p.z + dz); if (rl) sink.labels.push(rl);
		const sv = r.servers || {};
		for (const sk in sv) { const s = sv[sk], sp = convertServerCoordinatesToPosition(r.x, r.y, s.start); const sl = displayServerText(s.hostname, s, sp.x + dx, sp.y, sp.z + dz); if (sl) sink.labels.push(sl); }
	}
	return sink;
}
// The room INTERIOR for a near neighbour, mirroring buildRoom so a full building looks like the main one:
// drop ceiling + troffer lights + HVAC ducts/pipes + a door-aware baseboard + a tiled floor, all at the
// neighbour's world bounds. Built into the full group (torn down with it on exitFull). Non-instanced
// meshes here own unique geometry/material -> exitFull disposes them; full racks are InstancedMesh (shared).
function buildNeighborInterior(group, b) {
	const minX = b.minX, maxX = b.maxX, minZ = b.minZ, maxZ = b.maxZ;
	const W = maxX - minX, D = maxZ - minZ, cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
	// drop ceiling (faces down)
	const ceilTex = makeCeilingTexture(b.id); ceilTex.repeat.set(Math.max(1, Math.round(W / CEIL_TILE)), Math.max(1, Math.round(D / CEIL_TILE)));
	const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: ceilTex, color: 0xffffff, roughness: 0.95, emissive: 0x2a2a2a, side: THREE.DoubleSide }));
	ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, ROOM_CEIL_Y, cz); group.add(ceil);
	// fluorescent troffers (one bright diffuser panel per 4-ft slot, dark housing frame). options.faultyLights
	// PERCENT of them flicker (collected in `faulty` -> returned so maybeFlicker animates them); rest merged & lit.
	const fixLenX = W - 2 * ROOM_MARGIN, fixStartX = cx - fixLenX / 2, fixEndX = cx + fixLenX / 2;
	const BULB_LEN = 48 * UNITS_PER_INCH, BULB_GAP = 1 * UNITS_PER_INCH, fixRows = Math.max(1, Math.round(D / 18));
	const bulbY = ROOM_CEIL_Y - 0.78, housingY = ROOM_CEIL_Y - 0.3, housings = [], bulbs = [], slots = [], faulty = [];
	for (let i = 0; i < fixRows; i++) {
		const z = minZ + (D * (i + 0.5) / fixRows);
		const hg = new THREE.BoxGeometry(fixLenX + 0.5, 0.5, 4.4); hg.translate(cx, housingY, z); housings.push(hg);
		for (let sx = fixStartX; sx < fixEndX - 0.05; sx += BULB_LEN + BULB_GAP) { const len = Math.min(BULB_LEN, fixEndX - sx); slots.push({ x: sx + len / 2, len, z }); }
	}
	const nFaulty = Math.max(0, Math.min(slots.length, Math.round(slots.length * (options.faultyLights || 0) / 100)));
	const faultyIdx = new Set();
	if (nFaulty >= 1 && slots.length) { faultyIdx.add(slots.length - 1); let guard = 0; while (faultyIdx.size < nFaulty && faultyIdx.size < slots.length && guard++ < 800) faultyIdx.add(Math.floor(Math.random() * slots.length)); }
	slots.forEach((s, idx) => {
		const bg = new THREE.BoxGeometry(s.len - 0.2, 0.16, 3.7); bg.translate(s.x, bulbY, s.z);
		if (faultyIdx.has(idx)) { const m = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0xffffff })); m.userData = {}; group.add(m); faulty.push(m); }
		else bulbs.push(bg);
	});
	if (housings.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(housings), new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.6, metalness: 0.3 })); housings.forEach((g) => g.dispose()); group.add(m); }
	let nbBulbDisco = null;
	if (bulbs.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(bulbs), new THREE.MeshBasicMaterial({ color: 0xffffff })); bulbs.forEach((g) => g.dispose()); group.add(m); nbBulbDisco = makeBulbDisco(m, bulbs.length); }
	// HVAC ducts (elbow runs in the gaps between rows) + a couple of pipes
	const rowGap = D / fixRows, laneZ = (k) => minZ + rowGap * k, ducts = [];
	const dbox = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); ducts.push(g); };
	const elbow = (xFrom, xTo, z, y, w, h) => { dbox(Math.abs(xTo - xFrom), h, w, (xFrom + xTo) / 2, y, z); const leg = rowGap * 1.3; dbox(w, h, leg, xTo, y, z + (z < cz ? leg / 2 : -leg / 2)); };
	elbow(minX + ROOM_MARGIN, cx + W * 0.10, laneZ(Math.max(1, Math.round(fixRows * 0.28))), ROOM_CEIL_Y - 2.4, 5, 4.2);
	elbow(maxX - ROOM_MARGIN, cx - W * 0.10, laneZ(Math.min(fixRows - 1, Math.round(fixRows * 0.72))), ROOM_CEIL_Y - 2.1, 4.5, 3.6);
	if (ducts.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(ducts), new THREE.MeshStandardMaterial({ color: 0xcdd3da, roughness: 0.24, metalness: 0.92, envMapIntensity: 2.6 })); ducts.forEach((g) => g.dispose()); group.add(m); }
	const pipes = [], pipeRun = (z, x0, len, r, y) => { const pg = new THREE.CylinderGeometry(r, r, len, 16); pg.rotateZ(Math.PI / 2); pg.translate(x0 + len / 2, y, z); pipes.push(pg); };
	const midLane = laneZ(Math.max(1, Math.round(fixRows * 0.5)));
	pipeRun(midLane + 1.3, minX + ROOM_MARGIN + W * 0.06, W * 0.52, 1.0, ROOM_CEIL_Y - 1.5);
	pipeRun(midLane - 1.3, cx + W * 0.04, W * 0.32, 0.7, ROOM_CEIL_Y - 1.5);
	if (pipes.length) { const m = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(pipes), new THREE.MeshStandardMaterial({ color: 0xc6ccd4, roughness: 0.16, metalness: 0.96, envMapIntensity: 2.9 })); pipes.forEach((g) => g.dispose()); group.add(m); }
	// dark baseboard along the inside foot of every wall, skipping this neighbour's one doorway
	const BASE_H = 1.15, BASE_T = 0.55, baseMat = new THREE.MeshStandardMaterial({ color: 0x3b3b43, roughness: 0.7, metalness: 0.18 }), dHalf = (b.doorHalf || 8) + 1;
	const baseboard = (axis, fixed, c0, c1, inward, gapC) => {
		const segs = gapC == null ? [[c0, c1]] : [];
		if (gapC != null) { if (gapC - dHalf > c0) segs.push([c0, gapC - dHalf]); if (gapC + dHalf < c1) segs.push([gapC + dHalf, c1]); }
		for (const s of segs) { const len = s[1] - s[0]; if (len < 0.3) continue; const m = new THREE.Mesh(axis === 'x' ? new THREE.BoxGeometry(len, BASE_H, BASE_T) : new THREE.BoxGeometry(BASE_T, BASE_H, len), baseMat); if (axis === 'x') m.position.set((s[0] + s[1]) / 2, BASE_H / 2, fixed + inward * BASE_T / 2); else m.position.set(fixed + inward * BASE_T / 2, BASE_H / 2, (s[0] + s[1]) / 2); group.add(m); }
	};
	baseboard('x', maxZ, minX, maxX, -1, b.doorSide === 'S' ? b.doorC : null);
	baseboard('x', minZ, minX, maxX, +1, b.doorSide === 'N' ? b.doorC : null);
	baseboard('z', minX, minZ, maxZ, +1, b.doorSide === 'W' ? b.doorC : null);
	baseboard('z', maxX, minZ, maxZ, -1, b.doorSide === 'E' ? b.doorC : null);
	// wall props (matches the main room): fire extinguisher, wall phone, bulletin board + flyer, calendar
	const feX = maxX - 0.9, feZ = cz + D * 0.2;
	const fe = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 3, 16), new THREE.MeshStandardMaterial({ color: 0xc41f1f, roughness: 0.4, metalness: 0.2 })); fe.position.set(feX, 7, feZ); group.add(fe);
	const feTop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 })); feTop.position.set(feX, 8.8, feZ); group.add(feTop);
	const phX = minX + 0.5, phZ = cz - D * 0.18;
	const ph = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.4, 1.6), new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.6 })); ph.position.set(phX, 11, phZ); group.add(ph);
	const phH = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 2.1), new THREE.MeshStandardMaterial({ color: 0x161618, roughness: 0.6 })); phH.position.set(phX + 0.5, 12.5, phZ); group.add(phH);
	const bdX = cx + W * 0.27;
	const board = new THREE.Mesh(new THREE.BoxGeometry(11, 8, 0.4), new THREE.MeshStandardMaterial({ color: 0x8d6a44, roughness: 0.85 })); board.position.set(bdX, 12, maxZ - 0.3); group.add(board);
	const flyer = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 4.3), new THREE.MeshBasicMaterial({ map: makeLostCatTexture() })); flyer.rotation.y = Math.PI; flyer.position.set(bdX, 12.2, maxZ - 0.55); group.add(flyer);
	const cal = new THREE.Mesh(new THREE.PlaneGeometry(3, 4.6), new THREE.MeshBasicMaterial({ map: makeCalendarTexture() })); cal.rotation.y = Math.PI / 2; cal.position.set(minX + 0.75, 11.5, cz + D * 0.22); group.add(cal);
	addPosters(group, { minX, maxX, minZ, maxZ });   // funny tech motivational posters on the walls
	// tiled interior floor (seeded by location so the pattern is stable across visits)
	const floorTex = makeFloorTexture(b.id), tu = 24 * UNITS_PER_INCH;
	floorTex.repeat.set(Math.max(1, Math.round(W / (4 * tu))), Math.max(1, Math.round(D / (4 * tu))));
	const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
	floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, cz); group.add(floor);
	return { faulty, bulbDisco: nbBulbDisco };   // faulty -> b.full.faulty (maybeFlicker); bulbDisco -> b.full.bulbDisco (updateDisco)
}
// Swap a neighbour BLOCKS -> FULL (async-load its models, hide the blocks, add the full interior). The
// loading flag both de-dupes concurrent triggers and acts as a cancel token (exitFull clears it mid-load).
function enterFull(b) {
	b.loading = true;
	loadBuildingModels(b.id, () => {
		if (!b.loading) return;                         // cancelled by exitFull while loading
		b.full = buildBuildingFull(b.id, b.dx, b.dz);
		const ri = buildNeighborInterior(b.full.group, b);             // interior; returns its flicker + disco handles
		b.full.faulty = ri.faulty || []; b.full.bulbDisco = ri.bulbDisco;
		scene.add(b.full.group);
		if (b.blocks) b.blocks.visible = false;
		b.loading = false;
	});
}
// Swap FULL -> BLOCKS: drop the full group, show the blocks again, cancel any in-flight load. InstancedMesh
// racks free only their instanceMatrix (geometry/material are shared cached templates); the interior meshes
// own unique geometry/material/maps -> dispose those fully.
function exitFull(b) {
	b.loading = false;
	if (b.full) {
		scene.remove(b.full.group);
		b.full.group.traverse((n) => {
			if (!n.isMesh) return;
			if (n.isInstancedMesh) { n.dispose(); return; }   // shared cached geo/mat -> only free instanceMatrix
			n.geometry.dispose();
			const mats = Array.isArray(n.material) ? n.material : [n.material];
			for (const m of mats) { if (m.map) m.map.dispose(); m.dispose(); }
		});
		// labels live in the scene + global objects.labels (for distance culling), not the group -> remove them here
		if (b.full.labels && b.full.labels.length) {
			const set = new Set(b.full.labels);
			for (const l of b.full.labels) { scene.remove(l); if (l.material.map) l.material.map.dispose(); l.material.dispose(); }
			objects.labels = objects.labels.filter((l) => !set.has(l));
			objects.rackLabels = objects.rackLabels.filter((l) => !set.has(l));
		}
		b.full = null;
	}
	if (b.blocks) b.blocks.visible = true;
}
// Per-frame LOD manager (called from DC.tick). Keep the nearest in-range neighbour(s) at full detail, up
// to LOD_MAX_FULL, everything else as blocks. Keys off the player ground position (lodFocus) when set.
function updateLOD() {
	if (!lodBuildings.length || !camera) return;
	const fx = lodFocus ? lodFocus.x : camera.position.x, fz = lodFocus ? lodFocus.z : camera.position.z;
	let fullCount = 0;
	for (const b of lodBuildings) { b._dist = distToRect(fx, fz, b); if (b.full) fullCount++; }
	const exitThresh = LOD_EXIT_PAD * _lodDistanceMult;
	const enterThresh = LOD_ENTER_PAD * _lodDistanceMult;
	for (const b of lodBuildings) { if (b.full && b._dist > exitThresh) { exitFull(b); fullCount--; } }
	if (fullCount < LOD_MAX_FULL) {
		const near = lodBuildings.filter((b) => !b.full && !b.loading && b._dist < enterThresh).sort((a, c) => a._dist - c._dist);
		for (const b of near) { if (fullCount >= LOD_MAX_FULL) break; enterFull(b); fullCount++; }
	}
}
function buildRoom() {
	const racksObj = (locations[options.location] || {}).racks || {};
	let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
	for (const k in racksObj) {
		const r = racksObj[k];
		const p = convertRackCoordinatesToPosition(r.x, r.y);
		minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
		minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
	}
	if (!isFinite(minX)) return; // no racks in this location -> no room
	// push the walls out past the rack footprints (+/-4) by the margin
	minX -= 4 + ROOM_MARGIN; maxX += 4 + ROOM_MARGIN;
	minZ -= 4 + ROOM_MARGIN; maxZ += 4 + ROOM_MARGIN;
	const W = maxX - minX, D = maxZ - minZ, cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

	const group = new THREE.Group();
	const walls = new THREE.Group();
	const ceiling = new THREE.Group();
	group.add(walls); group.add(ceiling);

	const wallMat = new THREE.MeshStandardMaterial({ color: 0xe9e2d2, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide }); // off-white / beige
	const ceilTex = makeCeilingTexture(options.location);
	ceilTex.repeat.set(Math.max(1, Math.round(W / CEIL_TILE)), Math.max(1, Math.round(D / CEIL_TILE)));
	const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, color: 0xffffff, roughness: 0.95, metalness: 0.0, emissive: 0x2a2a2a, side: THREE.DoubleSide });

	// 4 window-walls (solid strips + a see-through glass ribbon), the front one with a door
	const glass = makeGlassMaterial();
	const mullMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95, metalness: 0.25 });
	windowSlots = [];
	// back (minZ) + left (minX) walls get a REAL door opening with a solid panel that SWINGS open + is
	// walkable (collision gaps added via roomSideDoors). The front (maxZ) door stays the static panel that
	// dc-multi's glass entrance replaces.
	const sideDoorX = cx - W * 0.28, sideDoorZ = cz + D * 0.22;
	const backDoor = windowWall(walls, 'x', minZ, minX, maxX, ROOM_CEIL_Y, wallMat, glass, mullMat, sideDoorX, true, 8); // back + single swing door
	windowWall(walls, 'x', maxZ, minX, maxX, ROOM_CEIL_Y, wallMat, glass, mullMat, cx);                               // front (glass double door replaces this)
	const leftDoor = windowWall(walls, 'z', minX, minZ, maxZ, ROOM_CEIL_Y, wallMat, glass, mullMat, sideDoorZ, true, 8); // left + single swing door
	windowWall(walls, 'z', maxX, minZ, maxZ, ROOM_CEIL_Y, wallMat, glass, mullMat, null);                            // right
	const blinds = buildBlinds(walls, cx, cz, windowSlots, true); windowSlots = [];   // drain the slots windowWall just pushed
	// register the swing doors (open OUTWARD on approach, auto-close); roomSideDoors feeds the collision gaps.
	roomDoors = [];
	if (backDoor) roomDoors.push({ pivot: backDoor.pivot, openSign: 1, cx: sideDoorX, cz: minZ, open: 0, target: 0, lastNear: -1e9 });   // minZ wall: swing -z (outward)
	if (leftDoor) roomDoors.push({ pivot: leftDoor.pivot, openSign: -1, cx: minX, cz: sideDoorZ, open: 0, target: 0, lastNear: -1e9 });  // minX wall: swing -x (outward)
	roomSideDoors = [{ side: 'N', c: sideDoorX, half: 4 }, { side: 'W', c: sideDoorZ, half: 4 }];   // 8-wide doors -> ±4 collision gap

	// ceiling (horizontal plane, facing down into the room)
	const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat); ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, ROOM_CEIL_Y, cz); ceiling.add(ceil);

	// Fluorescent fixtures: a grid of 4-ft troffers (each 4 parallel bulbs) across the ceiling.
	// Non-faulty bulbs are merged into one mesh; the "faulty" ones (options.faultyLights) are built
	// as their own meshes so maybeFlicker() can blink each like a dying tube -- 1 faulty sits in a
	// corner slot, more are scattered. Housings (the dark frames) stay as merged full rows.
	const housings = [], bulbs = [], faultyMeshes = [];
	const fixLenX = W - 2 * ROOM_MARGIN;
	const fixStartX = cx - fixLenX / 2, fixEndX = cx + fixLenX / 2;
	const BULB_LEN = 48 * UNITS_PER_INCH, BULB_GAP = 1 * UNITS_PER_INCH, BULB_W = 3 * UNITS_PER_INCH;
	const bulbDz = [-1.65, -0.55, 0.55, 1.65]; // 4 bulbs across the ~4.4-wide fixture
	const fixRows = Math.max(1, Math.round(D / 18));
	const bulbY = ROOM_CEIL_Y - 0.78, housingY = ROOM_CEIL_Y - 0.3;   // bulbs hang JUST BELOW the housing so they read as lit (recessing them up inside it left only black strips); ducts now run in the gaps between rows, so no conflict
	// enumerate every troffer slot (a 4-ft, 4-bulb fixture position), row-major
	const slots = [];
	for (let i = 0; i < fixRows; i++) {
		const z = minZ + (D * (i + 0.5) / fixRows);
		const hg = new THREE.BoxGeometry(fixLenX + 0.5, 0.5, 4.4); hg.translate(cx, housingY, z); housings.push(hg);
		for (let sx = fixStartX; sx < fixEndX - 0.05; sx += BULB_LEN + BULB_GAP) {
			const len = Math.min(BULB_LEN, fixEndX - sx);
			slots.push({ x: sx + len / 2, len, z });
		}
	}
	// pick faulty slots: a corner slot first (last row, last segment), the rest random.
	// options.faultyLights is now a PERCENT of this building's fixtures.
	const nFaulty = Math.max(0, Math.min(slots.length, Math.round(slots.length * (options.faultyLights || 0) / 100)));
	const faultyIdx = new Set();
	if (nFaulty >= 1 && slots.length) {
		faultyIdx.add(slots.length - 1);
		let guard = 0;
		while (faultyIdx.size < nFaulty && faultyIdx.size < slots.length && guard++ < 800) faultyIdx.add(Math.floor(Math.random() * slots.length));
	}
	// one bright DIFFUSER panel per 4-ft troffer (a single wide lit panel reads as "on"; 4 thin tubes
	// against the wide dark housing just looked like dark strips). The dark housing frames it.
	slots.forEach((s, idx) => {
		const bg = new THREE.BoxGeometry(s.len - 0.2, 0.16, 3.7); bg.translate(s.x, bulbY, s.z);
		if (faultyIdx.has(idx)) {
			const m = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: 0xffffff })); m.userData = {}; ceiling.add(m); faultyMeshes.push(m);
		} else {
			bulbs.push(bg);
		}
	});
	const housingMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(housings), new THREE.MeshStandardMaterial({ color: 0x2c2f35, roughness: 0.6, metalness: 0.3 }));
	housings.forEach((g) => g.dispose()); ceiling.add(housingMesh);
	let roomBulbDisco = null;
	if (bulbs.length) { const bulbMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(bulbs), new THREE.MeshBasicMaterial({ color: 0xffffff })); bulbs.forEach((g) => g.dispose()); ceiling.add(bulbMesh); roomBulbDisco = makeBulbDisco(bulbMesh, bulbs.length); }

	// HVAC ducts + pipes: kept OFF the fixture rows -- they run in the GAPS between rows, never the full
	// length straight under a row, and each turns a corner (an elbow) so it reads as real ductwork.
	const rowGap = D / fixRows, laneZ = (k) => minZ + rowGap * k;   // laneZ(k) sits between two fixture rows
	const ducts = [];
	const dbox = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); ducts.push(g); };
	const elbow = (xFrom, xTo, z, y, w, h) => {                     // a partial horizontal run + a short perpendicular leg
		dbox(Math.abs(xTo - xFrom), h, w, (xFrom + xTo) / 2, y, z);
		const leg = rowGap * 1.3; dbox(w, h, leg, xTo, y, z + (z < cz ? leg / 2 : -leg / 2));
	};
	elbow(minX + ROOM_MARGIN, cx + W * 0.10, laneZ(Math.max(1, Math.round(fixRows * 0.28))), ROOM_CEIL_Y - 2.4, 5, 4.2);
	elbow(maxX - ROOM_MARGIN, cx - W * 0.10, laneZ(Math.min(fixRows - 1, Math.round(fixRows * 0.72))), ROOM_CEIL_Y - 2.1, 4.5, 3.6);
	// shiny galvanized steel: high metalness + low roughness + boosted env reflection
	const ductMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(ducts), new THREE.MeshStandardMaterial({ color: 0xcdd3da, roughness: 0.24, metalness: 0.92, envMapIntensity: 2.6 }));
	ducts.forEach((g) => g.dispose());
	ceiling.add(ductMesh);
	const pipes = [];
	const pipeRun = (z, x0, len, r, y) => { const pg = new THREE.CylinderGeometry(r, r, len, 16); pg.rotateZ(Math.PI / 2); pg.translate(x0 + len / 2, y, z); pipes.push(pg); };
	const midLane = laneZ(Math.max(1, Math.round(fixRows * 0.5)));  // a gap near the middle, pipes offset to one side of it
	pipeRun(midLane + 1.3, minX + ROOM_MARGIN + W * 0.06, W * 0.52, 1.0, ROOM_CEIL_Y - 1.5);
	pipeRun(midLane - 1.3, cx + W * 0.04, W * 0.32, 0.7, ROOM_CEIL_Y - 1.5);
	const pipeMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(pipes), new THREE.MeshStandardMaterial({ color: 0xc6ccd4, roughness: 0.16, metalness: 0.96, envMapIntensity: 2.9 }));
	pipes.forEach((g) => g.dispose());
	ceiling.add(pipeMesh);

	// --- wall detailing so the big blank planes have edges + things to read against ---
	// (the dark floor-line baseboard trim was removed — it read as a "bed rail" you'd trip over along the wall base)
	// (the back + left doors are now functional swing doors built by windowWall above)
	// fire extinguisher on the maxX wall
	const feX = maxX - 0.9, feZ = cz + D * 0.2;
	const feBody = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 3, 16), new THREE.MeshStandardMaterial({ color: 0xc41f1f, roughness: 0.4, metalness: 0.2 })); feBody.position.set(feX, 7, feZ); walls.add(feBody);
	const feTop = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 0.9, 12), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 })); feTop.position.set(feX, 8.8, feZ); walls.add(feTop);
	// wall phone on the minX wall
	const phX = minX + 0.5, phZ = cz - D * 0.18;
	const phBody = new THREE.Mesh(new THREE.BoxGeometry(0.6, 2.4, 1.6), new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.6 })); phBody.position.set(phX, 11, phZ); walls.add(phBody);
	const phHandset = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 2.1), new THREE.MeshStandardMaterial({ color: 0x161618, roughness: 0.6 })); phHandset.position.set(phX + 0.5, 12.5, phZ); walls.add(phHandset);
	// a pin-up calendar mounted ON the left swing door (child of its pivot -> hangs on the door + swings with it)
	if (leftDoor) { const cal = new THREE.Mesh(new THREE.PlaneGeometry(3, 4.6), new THREE.MeshBasicMaterial({ map: makeCalendarTexture() })); cal.rotation.y = Math.PI / 2; cal.position.set(0.32, 10.5, leftDoor.dw / 2); leftDoor.pivot.add(cal); }
	// bulletin board with a "lost cat" flyer on the far (maxZ) wall
	const bdX = cx + W * 0.27;
	const board = new THREE.Mesh(new THREE.BoxGeometry(11, 8, 0.4), new THREE.MeshStandardMaterial({ color: 0x8d6a44, roughness: 0.85 })); board.position.set(bdX, 12, maxZ - 0.3); walls.add(board);
	const flyer = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 4.3), new THREE.MeshBasicMaterial({ map: makeLostCatTexture() })); flyer.rotation.y = Math.PI; flyer.position.set(bdX, 12.2, maxZ - 0.55); walls.add(flyer);
	const pin = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 8), new THREE.MeshStandardMaterial({ color: 0xcc2222 })); pin.position.set(bdX, 14.1, maxZ - 0.6); walls.add(pin);
	addPosters(walls, { minX, maxX, minZ, maxZ });   // funny tech motivational posters on the walls

	// --- dark baseboard along the inside foot of every wall (adds depth). It stops at each doorway and
	// resumes on the far side. inward = which way that wall's interior face points (so the board hugs it).
	const BASE_H = 1.15, BASE_T = 0.55, baseMat = new THREE.MeshStandardMaterial({ color: 0x3b3b43, roughness: 0.7, metalness: 0.18 });
	const baseboard = (axis, fixed, c0, c1, inward, gapC, gapHalf) => {
		const segs = gapC == null ? [[c0, c1]] : [];
		if (gapC != null) { if (gapC - gapHalf > c0) segs.push([c0, gapC - gapHalf]); if (gapC + gapHalf < c1) segs.push([gapC + gapHalf, c1]); }
		for (const s of segs) {
			const len = s[1] - s[0]; if (len < 0.3) continue;
			const m = new THREE.Mesh(axis === 'x' ? new THREE.BoxGeometry(len, BASE_H, BASE_T) : new THREE.BoxGeometry(BASE_T, BASE_H, len), baseMat);
			if (axis === 'x') m.position.set((s[0] + s[1]) / 2, BASE_H / 2, fixed + inward * BASE_T / 2);
			else m.position.set(fixed + inward * BASE_T / 2, BASE_H / 2, (s[0] + s[1]) / 2);
			walls.add(m);
		}
	};
	baseboard('x', maxZ, minX, maxX, -1, cx, 9);        // front wall: skip the main glass entrance (±8 door + clearance)
	baseboard('x', minZ, minX, maxX, +1, sideDoorX, 5);     // back wall: skip the side swing door (8-wide)
	baseboard('z', minX, minZ, maxZ, +1, sideDoorZ, 5);     // left wall: skip the side swing door (8-wide)
	baseboard('z', maxX, minZ, maxZ, -1, null, 0);      // right wall: continuous (no door)

	// interior tile floor for this building (sits on top of the outdoor asphalt)
	const floorTex = makeFloorTexture(options.location);
	const tu = 24 * UNITS_PER_INCH;
	floorTex.repeat.set(Math.max(1, Math.round(W / (4 * tu))), Math.max(1, Math.round(D / (4 * tu))));
	const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
	floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, cz); group.add(floor);

	// dark roof slab on top (above the drop ceiling) so the main building's exterior matches the neighbours.
	// sits a touch above the wall top (like the neighbours) so the drop ceiling hides its underside (no z-fight).
	const roofSlab = new THREE.Mesh(new THREE.BoxGeometry(W + 4, 1.5, D + 4), new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.85 }));
	roofSlab.position.set(cx, ROOM_CEIL_Y + 1.25, cz); group.add(roofSlab);

	walls.visible = options.showWalls;
	ceiling.visible = options.showCeiling;
	scene.add(group);
	objects.room = { group, walls, ceiling, faulty: faultyMeshes, blinds, bulbDisco: roomBulbDisco };
	// wall colliders + a safe spawn spot (open margin near the maxZ wall, looking into the room)
	roomBounds = { minX, maxX, minZ, maxZ };
	roomSpawn = { x: cx, z: maxZ - ROOM_MARGIN * 0.5, lookX: cx, lookZ: cz };
}

// Drop the player at a safe spot inside the walls, facing the racks. If the default spot is blocked
// (it can land in a rack on some layouts), scan the open perimeter margin for a clear spot so we
// never spawn stuck inside a rack.
function spawnInside() {
    if (!roomSpawn || !camera) return;
    const r = playerRadius();
    let sx = roomSpawn.x, sz = roomSpawn.z;
    if (collidesAt(sx, sz, r)) { const o = findOpenSpawn(r); if (o) { sx = o.x; sz = o.z; } }
    camera.position.set(sx, eyeHeight(), sz);
    camera.lookAt(roomSpawn.lookX, eyeHeight(), roomSpawn.lookZ);
    velocity.set(0, 0, 0);
    // Tell the third-person overlay (dc-multi.js) where the camera landed so it can bring the
    // character along. NOTE: `S` in this file is the quality-settings object, not dc-multi's state,
    // so poking S.player here silently does nothing — this event is the only working channel.
    document.dispatchEvent(new CustomEvent('dc:respawn', { detail: { x: sx, z: sz } }));
    // IDEA-3: notify server of viewport after spawn/camera move
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    scheduleViewportUpdate({
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        dirX: dir.x,
        dirY: dir.y,
        dirZ: dir.z
    });
}

// Scan the open margin band around the racks for the first spot a player of radius r fits.
function findOpenSpawn(r) {
    if (!roomBounds) return null;
    const m = ROOM_MARGIN, step = 2; // Bug #4: reduced step from 4 to 2 for finer sampling
    for (const z of [roomBounds.maxZ - m * 0.5, roomBounds.minZ + m * 0.5]) {  // along the z walls
        for (let x = roomBounds.minX + m; x <= roomBounds.maxX - m; x += step) {
            if (!collidesAt(x, z, r)) return { x, z };
        }
    }
    for (const x of [roomBounds.maxX - m * 0.5, roomBounds.minX + m * 0.5]) {  // along the x walls
        for (let z = roomBounds.minZ + m; z <= roomBounds.maxZ - m; z += step) {
            if (!collidesAt(x, z, r)) return { x, z };
        }
    }
    // Bug #2: center fallback - verify it's not colliding before using it
    const cx = (roomBounds.minX + roomBounds.maxX) / 2;
    const cz = (roomBounds.minZ + roomBounds.maxZ) / 2;
    if (!collidesAt(cx, cz, r)) return { x: cx, z: cz };
    // Center also colliding - iterate at finer granularity to find a valid spot
    const fineStep = 1;
    for (let z = roomBounds.minZ + m; z <= roomBounds.maxZ - m; z += fineStep) {
        for (let x = roomBounds.minX + m; x <= roomBounds.maxX - m; x += fineStep) {
            if (!collidesAt(x, z, r)) return { x, z };
        }
    }
    return null; // no valid spawn found - caller should handle null return
}

let keyHandlersAttached = false;

function attachKeyHandlers() {
    if (keyHandlersAttached) return;
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    keyHandlersAttached = true;
}

function detachKeyHandlers() {
    if (!keyHandlersAttached) return;
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    keyHandlersAttached = false;
}

function setupControls() {
    const blocker = document.getElementById("blocker");
    const instructions = document.getElementById("instructions");
    // Tear down any existing controls so first-person <-> pointer-lock can swap in place
    // instead of rebuilding the whole scene.
    if (controls && typeof controls.dispose === "function") {
        controls.dispose();
    }
    if (options.useFirstPerson === true) {
        controls = new FirstPersonControls(camera, renderer.domElement);
        if (instructions) instructions.style.display = "none";
        if (blocker) blocker.style.display = "none";
        detachKeyHandlers();
    } else {
        controls = new PointerLockControls(camera, renderer.domElement);
        if (blocker) blocker.style.display = "block";
        if (instructions) instructions.style.display = "";
        // Event listeners for lock and unlock events
        controls.addEventListener("lock", function () {
            instructions.style.display = "none";
            blocker.style.display = "none";
            // stop any in-progress demo fly + reset motion so the first movement frame doesn't jolt
            flyTo.active = false;
            flyTo.t = 0;
            velocity.set(0, 0, 0);
            prevTime = performance.now();
            // if locked from a demo view that left us outside the walls, up high, or INSIDE a rack
            // (e.g. the close-up label view), drop back to a clear spot facing the racks
            const p = camera.position;
            const outside = !roomBounds || p.x < roomBounds.minX || p.x > roomBounds.maxX || p.z < roomBounds.minZ || p.z > roomBounds.maxZ || p.y > 24;
            if (outside || collidesAt(p.x, p.z, playerRadius())) spawnInside();
        });
        controls.addEventListener("unlock", function () {
            blocker.style.display = "block";
            instructions.style.display = "";
        });
        attachKeyHandlers();
    }
}

// ---- Phase 7: interaction (look-highlight, click-to-info, search + fly-to) ----
const raycaster = new THREE.Raycaster();
const _centerNdc = new THREE.Vector2(0, 0);   // screen centre = "what you're looking at"
const _hoverMatrix = new THREE.Matrix4();
const _hoverPos = new THREE.Vector3();
const _hoverSize = new THREE.Vector3();
// Fix #4: Camera forward direction helper and distance pre-check for raycastInstances
const _camFwd = new THREE.Vector3();
const _rcTempV = new THREE.Vector3();
const MAX_RAYCAST_DIST = 50;  // only raycast instanced meshes within this distance

function _getCameraForward(cam) {
    cam.getWorldDirection(_camFwd);
    return _camFwd;
}

let highlightBox = null;
let hovered = null;                            // { mesh, instanceId, kind, asset }
let _hlFrame = 0;
const flyTo = { active: false, t: 0, from: new THREE.Vector3(), to: new THREE.Vector3(), look: new THREE.Vector3() };

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ensureHighlightBox() {
    if (highlightBox) return;
    highlightBox = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
        new THREE.LineBasicMaterial({ color: 0xffcc00 })
    );
    highlightBox.visible = false;
    highlightBox.renderOrder = 999;
    scene.add(highlightBox);
}

function raycastInstances(ndc) {
    if (objects.instanced.length === 0) return null;
    // Fix #4: Fast distance pre-check — only test instanced meshes within MAX_RAYCAST_DIST
    const nearbyInstanced = objects.instanced.filter(mesh => {
        if (!mesh.isMesh) return false;
        _rcTempV.copy(mesh.position).sub(camera.position);
        const dot = _rcTempV.dot(_getCameraForward(camera));
        if (dot < 0 || dot > MAX_RAYCAST_DIST) return false;  // behind camera or too far
        return true;
    });
    if (nearbyInstanced.length === 0) return null;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(nearbyInstanced, false);
    for (const hit of hits) {
        if (hit.instanceId === undefined || hit.instanceId === null) continue;
        const ud = hit.object.userData;
        return { mesh: hit.object, instanceId: hit.instanceId, kind: ud.kind,
                 asset: ud.assetData ? ud.assetData[hit.instanceId] : null };
    }
    return null;
}

function updateHighlight() {
    if (!camera) return;
    ensureHighlightBox();
    const hit = raycastInstances(_centerNdc);
    if (!hit) { highlightBox.visible = false; hovered = null; return; }
    hovered = hit;
    const ud = hit.mesh.userData;
    const pl = ud.placements && ud.placements[hit.instanceId];
    const hlBox = ud.footBox || ud.modelBox; // racks: tight tall-parts box, not the wide floor tile
    if (pl && hlBox && !hlBox.isEmpty()) {
        // size + centre the box to the real model bounds (matches the item's 1U/2U/3U footprint)
        hlBox.getCenter(_hoverPos);
        hlBox.getSize(_hoverSize);
        highlightBox.scale.set(_hoverSize.x + 0.25, _hoverSize.y + 0.12, _hoverSize.z + 0.25);
        highlightBox.position.set(_hoverPos.x + pl.x, _hoverPos.y + pl.y, _hoverPos.z + pl.z);
    } else {
        hit.mesh.getMatrixAt(hit.instanceId, _hoverMatrix);
        _hoverPos.setFromMatrixPosition(_hoverMatrix);
        highlightBox.scale.set(6, hit.kind === 'rack' ? 19 : 1, 6);
        highlightBox.position.copy(_hoverPos);
    }
    highlightBox.visible = true;
}

function showInfo(hit) {
    const panel = document.getElementById('dcInfo');
    if (!panel || !hit || !hit.asset) return;
    const a = hit.asset;
    if (hit.kind === 'server') {
        panel.innerHTML = '<div class="dc-info-title">' + escapeHtml(a.hostname || 'server') + '</div>' +
            '<a href="/admin/?choice=none.asset_form&id=' + encodeURIComponent(a.id) +
            '" target="_blank" rel="noopener">View asset #' + escapeHtml(String(a.id)) + ' &rarr;</a>';
    } else {
        panel.innerHTML = '<div class="dc-info-title">Rack ' + escapeHtml(a.name || '') + '</div>';
    }
    panel.style.display = 'block';
}

function searchServers(query) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    const loc = locations[options.location];
    if (!q || !loc || !loc.racks) return out;
    for (const rackKey of Object.keys(loc.racks)) {
        const servers = loc.racks[rackKey].servers || {};
        for (const sid of Object.keys(servers)) {
            const s = servers[sid];
            if (s.hostname && s.hostname.toLowerCase().includes(q)) {
                out.push({ id: sid, hostname: s.hostname, rackKey });
                if (out.length >= 12) return out;
            }
        }
    }
    return out;
}

function flyToServer(rackKey, serverId) {
    const loc = locations[options.location];
    if (!loc || !loc.racks[rackKey] || !loc.racks[rackKey].servers[serverId]) return;
    const rack = loc.racks[rackKey];
    const pos = convertServerCoordinatesToPosition(rack.x, rack.y, rack.servers[serverId].start);
    flyTo.from.copy(camera.position);
    flyTo.to.set(pos.x + 8, pos.y + 4, pos.z + 8);
    flyTo.look.set(pos.x, pos.y, pos.z);
    flyTo.t = 0;
    flyTo.active = true;
}

function updateFlyTo() {
    if (!flyTo.active) return;
    flyTo.t = Math.min(1, flyTo.t + (flyTo.speed || 0.012)); // ~1.4 s glide at 60 fps
    const e = flyTo.t * flyTo.t * (3 - 2 * flyTo.t);        // smoothstep ease
    camera.position.lerpVectors(flyTo.from, flyTo.to, e);
    camera.lookAt(flyTo.look);
    if (flyTo.t >= 1) { flyTo.active = false; const cb = flyTo.onDone; flyTo.onDone = null; if (cb) cb(); }
}

// Changing locations: float up out of the current building, rebuild for the new one, then descend
// into it -- a quick (~3s) transition instead of an instant jump.
function flyTransition(toLoc) {
    const loc = locations[toLoc];
    if (!loc || !loc.racks || Object.keys(loc.racks).length === 0) {
        console.warn('flyTransition: no valid room data for location', toLoc);
        return;
    }
    const oldCx = roomBounds ? (roomBounds.minX + roomBounds.maxX) / 2 : camera.position.x;
    const oldCz = roomBounds ? (roomBounds.minZ + roomBounds.maxZ) / 2 : camera.position.z;
    flyTo.from.copy(camera.position);
    flyTo.to.set(oldCx, 175, oldCz);
    flyTo.look.set(oldCx, 0, oldCz);
    flyTo.t = 0; flyTo.speed = 0.016; flyTo.active = true;   // phase 1: rise out (~1.1s)
    flyTo.onDone = () => {
        options.location = toLoc;
        displayDatacenter();                                 // rebuild the new location (spawns inside)
        attachKeyHandlers(); // Bug #1: re-attach key handlers after fly transition rebuild
        const s = roomSpawn || { x: 0, z: 0, lookX: 0, lookZ: 0 };
        camera.position.set(s.x, 175, s.z);                  // start high above the new building...
        flyTo.from.copy(camera.position);
        flyTo.to.set(s.x, eyeHeight(), s.z);
        flyTo.look.set(s.lookX, eyeHeight(), s.lookZ);
        flyTo.t = 0; flyTo.speed = 0.012; flyTo.active = true; flyTo.onDone = null; // phase 2: descend in
        // IDEA-3: notify server of viewport after fly-to lands
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        scheduleViewportUpdate({
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z,
            dirX: dir.x,
            dirY: dir.y,
            dirZ: dir.z
        });
    };
}

function sceneBounds() {
    const loc = locations[options.location];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    if (loc && loc.racks) {
        for (const k of Object.keys(loc.racks)) {
            const p = convertRackCoordinatesToPosition(loc.racks[k].x, loc.racks[k].y);
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
        }
    }
    if (!isFinite(minX)) { minX = maxX = minZ = maxZ = 0; }
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ, minX, maxX, minZ, maxZ };
}

function viewPreset(name) {
    const b = sceneBounds();
    const span = Math.max(b.w, b.d, 40);
    if (name === 'top') return { pos: [b.cx + 40, span * 1.4 + 240, b.cz + 60], look: [b.cx, 0, b.cz] };          // high enough to see the community
    if (name === 'overview') return { pos: [b.cx + span + 280, span * 0.6 + 150, b.cz + span + 280], look: [b.cx, 10, b.cz] };
    if (name === 'aisle') return { pos: [b.cx, 14, b.maxZ + 6], look: [b.cx, 12, b.minZ - 5] };
    if (name === 'cables') return { pos: [b.minX - 14, 30, b.cz + 8], look: [b.cx, 17, b.cz] };
    if (name === 'labels') {
        const racks = locations[options.location].racks;
        let best = null, bestD = Infinity;
        for (const k of Object.keys(racks)) {
            const p = convertRackCoordinatesToPosition(racks[k].x, racks[k].y);
            const d = (p.x - b.cx) * (p.x - b.cx) + (p.z - b.cz) * (p.z - b.cz);
            if (d < bestD) { bestD = d; best = p; }
        }
        if (best) return { pos: [best.x + 1.1, 13, best.z + 10], look: [best.x + 1.1, 13, best.z + 2.8] };
    }
    return { pos: [b.cx, 18, b.maxZ + 22], look: [b.cx, 10, b.cz] };
}

function setView(name, keepBlocker) {
    const v = viewPreset(name);
    // The current building keeps its walls/ceiling in every view (so it looks like the others in the
    // community); use the GUI ceiling toggle for a roof-off peek inside.
    if (objects.room) {
        objects.room.walls.visible = options.showWalls;
        objects.room.ceiling.visible = options.showCeiling;
    }
    flyTo.from.copy(camera.position);
    flyTo.to.set(v.pos[0], v.pos[1], v.pos[2]);
    flyTo.look.set(v.look[0], v.look[1], v.look[2]);
    flyTo.t = 0;
    flyTo.active = true;
    flyTo.onDone = null; flyTo.speed = 0.012; // not a location transition
    if (controls && controls.isLocked) controls.unlock();
    if (!keepBlocker) { const bl = document.getElementById('blocker'); if (bl) bl.style.display = 'none'; }
    _viewProxy.view = name;   // keep the GUI 'View' dropdown showing the current view (it .listen()s)
    // highlight the matching preset button so the idle demo shows which view it's currently on
    document.querySelectorAll('#dcViews button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}

// When the pointer-lock prompt is showing (user not engaged) and the tab is visible, slowly cycle
// the preset "show-off" views every IDLE_VIEW_MS so the page demos itself. Pauses once the user
// clicks in (pointer locks) or the tab is hidden; the blocker message stays up the whole time.
const IDLE_VIEWS = ['overview', 'aisle', 'labels', 'cables', 'top'];
const IDLE_VIEW_MS = 5000;
let idleLastSwitch = performance.now(), idleViewIdx = -1;
function maybeCycleIdleView() {
    // DC.bench() drives the same presets on its own schedule; letting the demo also fire would
    // move the camera mid-sample and mix two views into one measurement window.
    if (_benchActive) { idleLastSwitch = performance.now(); return; }
    if (options.useFirstPerson || !controls || controls.isLocked || document.hidden || flyTo.active) { idleLastSwitch = performance.now(); return; }
    const bl = document.getElementById('blocker');
    if (!bl || bl.style.display === 'none') { idleLastSwitch = performance.now(); return; }
    if (performance.now() - idleLastSwitch >= IDLE_VIEW_MS) {
        idleLastSwitch = performance.now();
        idleViewIdx = (idleViewIdx + 1) % IDLE_VIEWS.length;
        setView(IDLE_VIEWS[idleViewIdx], true); // keepBlocker: the demo plays behind the prompt
    }
}

// --- Disco mode: each light fixture cycles a random colour every 3-5s via per-fixture VERTEX colours on
// the merged diffuser mesh (1 draw call kept). Off -> all white. Handles on objects.room.bulbDisco +
// b.full.bulbDisco (set where the bulb mesh is built). ---
const _discoColor = new THREE.Color();
function makeBulbDisco(mesh, count) {
    if (!mesh || !count) return null;
    const g = mesh.geometry, n = g.attributes.position.count;
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3)); // start white
    mesh.material.vertexColors = true; mesh.material.needsUpdate = true;
    return { mesh, count, vertsPer: Math.max(1, Math.round(n / count)), next: new Float64Array(count) };
}
function _discoHandles() {
    const h = [];
    if (objects.room && objects.room.bulbDisco) h.push(objects.room.bulbDisco);
    for (const b of lodBuildings) if (b.full && b.full.bulbDisco) h.push(b.full.bulbDisco);
    return h;
}
function updateDisco() {
    if (!options.disco) return;
    const now = performance.now();
    for (const h of _discoHandles()) {
        const col = h.mesh.geometry.attributes.color; let changed = false;
        for (let i = 0; i < h.count; i++) {
            if (now >= h.next[i]) {
                h.next[i] = now + 3000 + Math.random() * 2000;          // re-colour this fixture in 3-5s
                _discoColor.setHSL(Math.random(), 0.9, 0.6);
                const base = i * h.vertsPer * 3;
                for (let v = 0; v < h.vertsPer; v++) { col.array[base + v * 3] = _discoColor.r; col.array[base + v * 3 + 1] = _discoColor.g; col.array[base + v * 3 + 2] = _discoColor.b; }
                changed = true;
            }
        }
        if (changed) col.needsUpdate = true;
    }
}
function resetDisco() {   // back to plain white (disco toggled off)
    for (const h of _discoHandles()) { const col = h.mesh.geometry.attributes.color; col.array.fill(1); col.needsUpdate = true; for (let i = 0; i < h.count; i++) h.next[i] = 0; }
}
// Each "faulty" fixture (objects.room.faulty) flickers on its own clock: mostly lit, but every few
// seconds it stutters off/on for a moment like a dying fluorescent tube.
function maybeFlicker() {
    const arr = [];
    if (objects.room && objects.room.faulty) for (const f of objects.room.faulty) arr.push(f);          // main building
    for (const b of lodBuildings) if (b.full && b.full.faulty) for (const f of b.full.faulty) arr.push(f); // every full neighbour
    if (!arr.length) return;
    const t = performance.now();
    for (const f of arr) {
        const s = f.userData;
        if (s.next === undefined) { s.next = t + 1500 + Math.random() * 5000; s.burstEnd = 0; s.toggleAt = 0; }
        if (t < s.burstEnd) {
            if (t >= s.toggleAt) { f.visible = Math.random() < 0.55; s.toggleAt = t + 45 + Math.random() * 95; }
        } else {
            f.visible = true; // normal: lit
            if (t >= s.next) { s.burstEnd = t + 250 + Math.random() * 700; s.next = s.burstEnd + 2500 + Math.random() * 7000; s.toggleAt = 0; }
        }
    }
}

function setupInteraction() {
    if (renderer && renderer.domElement) {
        // Click to start walking (pointer lock); while walking, a click selects what you're looking at.
        renderer.domElement.addEventListener('click', () => {
            if (controls && !options.useFirstPerson && controls.isLocked === false) controls.lock();
            else if (hovered) showInfo(hovered);
        });
    }
    // Preset "show-off" camera view buttons along the bottom (wired to setView). Shown again (the GUI
    // 'View' dropdown was removed); they fade to low opacity and are clickable on the click-to-enable screen.
    document.querySelectorAll('#dcViews button[data-view]').forEach((btn) => {
        btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    const searchInput = document.getElementById('dcSearch');
    const resultsEl = document.getElementById('dcSearchResults');
    if (searchInput && resultsEl) {
        searchInput.addEventListener('input', () => {
            resultsEl.innerHTML = searchServers(searchInput.value).map((r) =>
                '<div class="dc-res" data-rack="' + escapeHtml(r.rackKey) + '" data-id="' + escapeHtml(r.id) + '">' + escapeHtml(r.hostname) + '</div>'
            ).join('');
        });
        resultsEl.addEventListener('click', (e) => {
            const el = e.target.closest('.dc-res');
            if (el) { flyToServer(el.dataset.rack, el.dataset.id); resultsEl.innerHTML = ''; searchInput.blur(); }
        });
        // don't let typing in the search box drive WASD movement
        searchInput.addEventListener('keydown', (e) => e.stopPropagation());
    }
}

async function init() {
    // Claim the device-loss handoff before anything can read options.location — loadDatacenter()'s
    // fetch resolves straight into displayGui() + displayDatacenter(), which is where it gets applied.
    _pendingRestore = _takeSessionRestore();
    // Which panel backend displayGui() gets isn't known until the Inspector's dynamic import down
    // below settles, and the fetch loadDatacenter() is about to start can beat it — the panel would
    // then come up as lil-gui in webgpu mode, on top of the Inspector, at random. Only the node
    // renderer arms the gate; on the classic build init() runs to completion synchronously before
    // any fetch callback can, so leaving the promise pre-resolved keeps that path bit-for-bit.
    if (THREE.WebGPURenderer) _panelBackendReady = new Promise((res) => { _panelBackendSettled = res; });
    // Load the datacenter information
    loadDatacenter();
    // Set up the camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 3000);
    camera.position.y = eyeHeight();
    // Create the scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xaed4f5);                 // sky blue (the community is outdoors)
    scene.fog = new THREE.Fog(0xc8e2f6, 600, 2600);              // sky-tinted haze, pushed far out
    // Add ambient light. Lighter ground term so down-facing surfaces (drop-ceiling tiles, duct/pipe
    // undersides) aren't dim when viewed from below.
    const light = new THREE.HemisphereLight(0xeeeeff, 0x9a9aa2, 2.6);
    light.position.set(0.5, 1, 0.75);
    scene.add(light);
    // soft directional light so cables (and racks) get specular highlights / depth, not flat ambient
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(60, 120, 40);
    scene.add(sun);
    // a big, glowing sun up in the sky (the directional light above is its illumination)
    const sunPos = new THREE.Vector3(560, 430, 360);
    sunCore = new THREE.Mesh(new THREE.SphereGeometry(42, 28, 20), new THREE.MeshBasicMaterial({ color: 0xfff4c8 }));
    sunCore.position.copy(sunPos); sunCore.frustumCulled = false; scene.add(sunCore);
    sunGlow = new THREE.Mesh(new THREE.SphereGeometry(80, 28, 20), new THREE.MeshBasicMaterial({ color: 0xffeeaa, transparent: true, opacity: 0.32, depthWrite: false }));
    sunGlow.position.copy(sunPos); sunGlow.frustumCulled = false; scene.add(sunGlow);
    // flat ambient fill -> overall brighter room + lifts dark undersides the hemisphere misses
    scene.add(new THREE.AmbientLight(0xfff6ec, 0.5));
    // Set up the renderer. The import map (dc.html's mode script) decided which three build loaded,
    // and the two builds export different renderers — three.webgpu.js has WebGPURenderer and NOT
    // WebGLRenderer — so the build itself is the discriminator, not the ?renderer= value.
    const isNode = !!THREE.WebGPURenderer;
    // powerPreference is deliberately absent: neither renderer is told which GPU to ask for, so the
    // browser decides (three's own default is 'default'), which on a dual-GPU laptop is normally the
    // integrated one. dc-multi.js's settings panel reports THIS object rather than a preference of
    // its own — it used to print a hardcoded 'high-performance' nothing had ever requested. Adding
    // one here changes GPU selection for every page load, so the two have to move together.
    const rendererParams = { antialias: true };
    renderer = isNode
        ? new THREE.WebGPURenderer({ ...rendererParams, forceWebGL: window.DC_RENDERER_MODE === 'webgpu-gl' })
        : new THREE.WebGLRenderer(rendererParams);
    _powerPreference = rendererParams.powerPreference || 'browser default';
    // The node renderer acquires its device asynchronously. render() before that resolves warns, and
    // getMaxAnisotropy() on the WebGL2 backend reads an extension that isn't there yet. Awaiting init()
    // is the r181+ pattern (renderAsync() is deprecated); the classic renderer is ready on construction.
    if (isNode) await renderer.init();
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    // no .capabilities on the node renderer — it exposes getMaxAnisotropy() directly
    maxAnisotropy = renderer.getMaxAnisotropy ? renderer.getMaxAnisotropy()
                                              : renderer.capabilities.getMaxAnisotropy();
    _setupRendererSwitch();

    // IDEA-2: WebGL context loss handling
    _animationLoopCb = animate;  // stored callback; honoured on restore

    // The hub is optional — DC_WS may be absent (script blocked / offline) or a stub, so never
    // assume connected() is there. Used from the context-lost/restore handlers, where a throw
    // would cost us the session backup or the scene rebuild.
    function _wsConnected() {
        return !!(window.DC_WS && typeof window.DC_WS.connected === 'function' && window.DC_WS.connected());
    }

    function _backupSession() {
        _sessionBackup = {
            authenticated: window.DC_AUTHED === true,
            session: window.DC_SESSION_ID || null,
            uid: window.DC_UID || null,
            name: window.DC_PRESENCE ? window.DC_PRESENCE.name : null,
            loc: options.location || 0,
            pos: camera ? { x: camera.position.x, y: camera.position.y, z: camera.position.z } : null,
            yaw: camera ? camera.rotation.y : 0,
            wsConnected: _wsConnected(),
            ts: Date.now()
        };
    }

    // Coerce a backed-up coordinate to a finite number. The hub's dc.presence.join handler
    // treats non-numeric x/z/yaw as 0.0, and camera.position/_sessionBackup.pos can be null
    // (context lost before the camera existed), so normalise here instead of shipping nulls.
    function _finite(v) {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    /**
     * Re-announce viewport + presence to the hub after a GPU context restore.
     *
     * DC_WS.send() takes TWO positional args — send(opString, dataObject) — and internally
     * does op.startsWith('dc.presence.'), so handing it a whole v1 envelope threw a TypeError
     * and killed the whole restore path. Everything here stays optional: the scene must work
     * with no hub at all, so DC_WS may be null / never-connected / destroyed.
     */
    function _rejoinPresence(session) {
        if (!window.DC_WS) return;
        const s = session || _sessionBackup || {};
        if (typeof window.DC_WS._updateViewport === 'function' && camera) {
            const dir = new THREE.Vector3();
            camera.getWorldDirection(dir);
            window.DC_WS._updateViewport({
                x: camera.position.x,
                y: camera.position.y,
                z: camera.position.z,
                dirX: dir.x,
                dirY: dir.y,
                dirZ: dir.z,
                viewDist: 50
            });
        }
        // prefer the live camera, fall back to the backed-up position
        const pos = camera ? camera.position : s.pos;
        const yaw = camera ? camera.rotation.y : s.yaw;
        const x = _finite(pos ? pos.x : 0);
        const z = _finite(pos ? pos.z : 0);
        const rot = _finite(yaw);
        // dc-presence owns the join: it latches so exactly one dc.presence.join goes out
        // per session (a second one here would have the hub tracking us twice), it attaches
        // the room bounds the bot needs, it honours the DC_PRESENCE_ENABLED kill switch, and
        // it reads the real PLAYER pose back from dc-multi rather than the third-person
        // CAMERA pose — which sits metres behind the player.
        if (typeof window.DC_PRESENCE_JOIN === 'function') {
            window.DC_PRESENCE_JOIN(x, z, rot);
            return;
        }
        // No dc-presence on the page: fall back to a raw frame.
        if (typeof window.DC_WS.send === 'function') {
            window.DC_WS.send('dc.presence.join', {
                loc: _finite(s.loc),          // hub ignores `loc`, kept for forward-compat
                x: x,
                z: z,
                yaw: rot
            });
        }
    }

    /**
     * Run `cb` the next time dc-ws reports an open socket. dc-ws.js dispatches 'dc:connected'
     * on document from its ws.onopen handler — that DOM event is the public hook (there is no
     * _onOpen member to override). Fires at most once and self-detaches after `timeoutMs` so a
     * connect that never succeeds doesn't leave a listener that re-joins much later.
     */
    function _onceConnected(cb, timeoutMs) {
        let done = false, timer = null;
        const handler = function () {
            if (done) return;
            done = true;
            if (timer) { clearTimeout(timer); timer = null; }
            document.removeEventListener('dc:connected', handler);
            cb();
        };
        document.addEventListener('dc:connected', handler);
        timer = setTimeout(function () {
            if (done) return;
            done = true;
            document.removeEventListener('dc:connected', handler);
        }, typeof timeoutMs === 'number' ? timeoutMs : 30000);
    }

    function _reconnectAndRejoin(session) {
        const ws = window.DC_WS;
        if (!ws) return;
        // dc-chat's "Chat: OFF" calls DC_WS.destroy(), which sets closedByUs — respect that
        // rather than dragging the socket back up behind the user's back.
        if (ws.closedByUs) return;
        _onceConnected(function () { setTimeout(function () { _rejoinPresence(session); }, 500); });
        // Only kick a fresh connect when dc-ws has nothing armed of its own: its ws.onclose
        // schedules _connect() while reconnectAttempts < maxReconnectAttempts, and connecting in
        // parallel would leave two sockets racing over the single this.ws slot.
        const attempts = ws.reconnectAttempts | 0;
        const max = typeof ws.maxReconnectAttempts === 'number' ? ws.maxReconnectAttempts : 0;
        const retryArmed = attempts > 0 && attempts < max;
        const connecting = !!(ws.ws && ws.ws.readyState === 0);  // WebSocket.CONNECTING
        if (!retryArmed && !connecting && typeof ws._connect === 'function') {
            ws._connect();
        }
    }

    function _showContextLostOverlay() {
        let overlay = document.getElementById('dc-context-lost-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'dc-context-lost-overlay';
            overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:999999;color:#fff;font-family:sans-serif;font-size:18px;';
            overlay.innerHTML = '<div style="text-align:center"><div style="font-size:32px;margin-bottom:12px">🔄</div>Restoring 3D View...<br><small>GPU context was lost</small></div>';
            document.body.appendChild(overlay);
        }
        overlay.style.display = 'flex';
    }

    function _hideContextLostOverlay() {
        const overlay = document.getElementById('dc-context-lost-overlay');
        if (overlay) overlay.remove();  // remove from DOM
    }

    // Only the classic renderer surfaces context loss as canvas events. The node renderer's WebGL2
    // backend installs its OWN webglcontextlost listener (which preventDefaults and forwards to
    // onDeviceLost), so attaching these there would run both recovery paths against one loss.
    if (renderer.isWebGLRenderer) {
        renderer.domElement.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            _contextLost = true;
            _backupSession();
            _showContextLostOverlay();
            console.warn('WebGL context lost - session backed up');
            document.dispatchEvent(new CustomEvent('dc:context-lost', { bubbles: true }));
        }, false);

        renderer.domElement.addEventListener('webglcontextrestored', () => {
            console.warn('WebGL context restored - rebuilding scene');
            _contextLost = false;
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            renderer.setSize(window.innerWidth, window.innerHeight);
            clearScene();
            displayDatacenter();
            if (_sessionBackup && _sessionBackup.pos) {
                camera.position.set(_sessionBackup.pos.x, _sessionBackup.pos.y, _sessionBackup.pos.z);
                camera.rotation.y = _sessionBackup.yaw || 0;
            }
            if (_sessionBackup && _sessionBackup.authenticated && window.DC_WS) {
                if (_wsConnected()) {
                    _rejoinPresence(_sessionBackup);
                } else {
                    _reconnectAndRejoin(_sessionBackup);
                }
            }
            renderer.setAnimationLoop(_guardLoop(_animationLoopCb));
            _hideContextLostOverlay();
            document.dispatchEvent(new CustomEvent('dc:context-restored', { bubbles: true }));
        }, false);
    } else {
        // The node renderer reports loss through one callback for both backends (WebGPU's
        // device.lost promise and the WebGL2 backend's canvas event both land here), and there is
        // no restored counterpart to pair with it: a lost device is gone for good. So this backs the
        // session up the same way, hands it to the next page through sessionStorage and reloads —
        // rebuilding a node renderer in place means disposing it and re-uploading every resource,
        // which is exactly the fragile path the classic handler above avoids by reusing its context.
        renderer.onDeviceLost = (info) => {
            if (_contextLost) return;   // WebGPU can report loss more than once; one reload is enough
            _contextLost = true;
            _backupSession();
            _showContextLostOverlay();
            try {
                window.sessionStorage.setItem(_RESTORE_KEY, JSON.stringify(_sessionBackup));
            } catch (e) {
                // storage blocked or full — still reload, just without landing on the same spot
            }
            console.warn('GPU device lost (' + ((info && info.api) || 'unknown') + ') - reloading to restore session');
            document.dispatchEvent(new CustomEvent('dc:context-lost', { bubbles: true }));
            setTimeout(() => window.location.reload(), 1500);
        };
    }
    // Neutral image-based environment so metallic surfaces (galvanized ducts/pipes, cable sheen)
    // reflect something instead of rendering black. Subtle intensity so it doesn't wash the racks.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.45;
    setupControls();
    // Lock the pointer when the user clicks the instructions overlay. Attached once here
    // (not in setupControls) so repeated first-person toggles don't stack listeners; it
    // reads the current `controls` on each click and is a no-op for FirstPersonControls.
    const instructionsEl = document.getElementById("instructions");
    if (instructionsEl) {
        instructionsEl.addEventListener("click", function () {
            if (!controls || typeof controls.lock !== "function") return;
            // Pointer lock needs a focused document. Browser extensions can hold focus in their own
            // frame, which makes requestPointerLock reject with "The document is not focused" — try
            // to take focus back first, then proceed either way.
            try { document.body.focus(); } catch (e) { /* body may not be focusable; harmless */ }
            try {
                // lock() returns a Promise in newer PointerLockControls, undefined in older ones.
                const lockResult = controls.lock();
                if (lockResult && typeof lockResult.catch === 'function') {
                    lockResult.catch(function (err) {
                        console.warn('[dc] pointer lock rejected:', err && err.message);
                    });
                }
            } catch (err) {
                console.warn('[dc] pointer lock failed:', err && err.message);
            }
        });
    }
    // Load floor
    loadFloor();
    // Perf readout. The node renderer gets the three.js Inspector instead of Stats: its Performance
    // tab reads real GPU frame times off timestamp queries, where Stats only samples rAF cadence.
    if (isNode) {
        try {
            // Dynamic import on purpose: the Inspector's Viewer tab statically imports "three/tsl",
            // which dc.html deliberately leaves out of the webgl import map. A static import here
            // would fail module resolution on the default page before any of the scene ran.
            const { Inspector } = await import('three/addons/inspector/Inspector.js');
            const created = new Inspector();
            renderer.inspector = created;   // the setter wires renderer <-> inspector both ways
            // The renderer calls inspector.init() itself, but only from inside its one-shot init()
            // promise -- already resolved back at construction -- and init() only docks the panel
            // when renderer.domElement has a parent. Both hold here, so drive it explicitly.
            created.init();
            inspector = created;
            // The Inspector's #profiler-toggle is fixed top-right at z-index 1001, over the page's
            // own top-right control row. dc.html moves that row out from under it off this class,
            // so the default page never sees the rule.
            document.body.classList.add('dc-has-inspector');
        } catch (err) {
            // A missing or broken addon must never cost us the scene; fall through to Stats.
            inspector = null;
            console.warn('[dc] three.js Inspector unavailable, using Stats:', err && err.message);
        }
    }
    // renderer.inspector is never falsy on the node renderer (it defaults to an InspectorBase), so
    // the module-level `inspector` is the only honest "the real Inspector attached" signal.
    if (!inspector) {
        stats = new Stats();
        document.body.appendChild(stats.dom);
    }
    _panelBackendSettled();   // displayGui() may now pick its backend
    // Wire up Phase 7 interaction (raycast picking + search box)
    setupInteraction();
    // Event listener for window resize
    window.addEventListener("resize", onWindowResize);
}

// Animation loop
function animate() {
    // IDEA-2: skip rendering when WebGL context is lost
    if (_contextLost) return;

    const now = performance.now();

    // Track idle frames and enable skip mode after threshold (Fix #6)
    _tickSkippedFrames++;
    if (_tickSkippedFrames >= _IDLE_FRAME_THRESHOLD) {
        _skipExpensiveUpdates = true;
    }

    if (options.useFirstPerson === true) {
        controls.update( clock.getDelta() );
    } else {
        // Update controls if locked
        if (controls.isLocked === true && !flyTo.active) {
            updateControls(now);
        }
    }
    // Idle: auto-cycle the preset views while the "click to enable" prompt is up
    maybeCycleIdleView();
    maybeFlicker();

    // FPS monitoring for automatic quality scaling (MINOR-6: skip during idle mode)
    if (!_skipExpensiveUpdates) {
        _updateFPS(now);
        _autoQualityScale(now);
    }

    // Phase 7: glide toward a search fly-to target, then highlight what we're looking at (throttled)
    updateFlyTo();
    if (!_skipExpensiveUpdates && (_hlFrame++ % 4) === 0) updateHighlight();
    // Distance-cull + lazily build labels, then render the scene (guarded by _skipExpensiveUpdates)
    if (!_skipExpensiveUpdates) updateLabels();
    if (!_skipExpensiveUpdates) updateBlinds();
    renderer.render(scene, camera);
    // Update stats monitor (absent in webgpu mode — the Inspector reports there instead)
    if (stats) stats.update();
}

// Update controls based on user input
function updateControls(time) {
    // Calculate time delta, CLAMPED. After an idle gap or a fly-to, prevTime is stale; an
    // unclamped multi-second delta makes the damping term (velocity * 10 * delta) overshoot and
    // flip sign -> the view suddenly spins/snaps and stops. Capping delta fixes that.
    const delta = Math.min(0.05, (time - prevTime) / 1000);
    // Update velocity based on user input
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    velocity.y -= (options.gravityMs2 || 9.8) * 100.0 * delta;
    direction.z = Number(options.moveForward) - Number(options.moveBackward);
    direction.x = Number(options.moveRight) - Number(options.moveLeft);
    direction.normalize();
    if (options.moveForward || options.moveBackward) velocity.z -= direction.z * 400.0 * delta;
    if (options.moveLeft || options.moveRight) velocity.x -= direction.x * 400.0 * delta;
    // Update controls position
    const prevX = camera.position.x, prevZ = camera.position.z;
    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);
    // Collision (opt-in via Movement > collisionMovement): stop at rack footprints, resolved per
    // axis so you slide along a rack face instead of sticking when walking into it diagonally.
    if (options.collisionMovement) {
        const r = playerRadius();
        if (collidesAt(camera.position.x, prevZ, r)) { camera.position.x = prevX; velocity.x = 0; }
        if (collidesAt(camera.position.x, camera.position.z, r)) { camera.position.z = prevZ; velocity.z = 0; }
    }
    camera.position.y += velocity.y * delta;
    // Handle jumping / standing height (eye height derived from the player's height in inches)
    const floorY = eyeHeight();
    if (camera.position.y < floorY) {
        velocity.y = 0;
        camera.position.y = floorY;
        options.canJump = true;
    }

    prevTime = time;
}

// Event handler for keydown
function onKeyDown(event) {
    switch (event.code) {
        case "ArrowUp":
        case "KeyW":
            options.moveForward = true;
            break;
        case "ArrowLeft":
        case "KeyA":
            options.moveLeft = true;
            break;
        case "ArrowDown":
        case "KeyS":
            options.moveBackward = true;
            break;
        case "ArrowRight":
        case "KeyD":
            options.moveRight = true;
            break;
        case "Space":
            if (options.canJump === true) velocity.y += 100; // ~2 ft hop (was 350 = a ~24 ft leap)
            options.canJump = false;
            break;
        // IDEA-5: Number keys 1-9 jump to the first 9 locations
        case "Digit1": case "Digit2": case "Digit3": case "Digit4": case "Digit5":
        case "Digit6": case "Digit7": case "Digit8": case "Digit9": {
            const idx = parseInt(event.code.replace("Digit", ""), 10) - 1;
            const locKeys = Object.keys(locationNames);
            if (locKeys[idx] !== undefined) {
                const locId = locationNames[locKeys[idx]];
                if (locId !== options.location) {
                    options.location = locId;
                    switchLocation();
                }
            }
            break;
        }
    }
}

// Event handler for keyup
function onKeyUp(event) {
    switch (event.code) {
        case "ArrowUp":
        case "KeyW":
            options.moveForward = false;
            break;
        case "ArrowLeft":
        case "KeyA":
            options.moveLeft = false;
            break;
        case "ArrowDown":
        case "KeyS":
            options.moveBackward = false;
            break;
        case "ArrowRight":
        case "KeyD":
            options.moveRight = false;
            break;
    }
}

// Event handler for window resize
function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Also re-apply pixel ratio cap in case devicePixelRatio changed (e.g., moving between displays)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

// Draw calls for the frame just rendered. The node renderer redefined info.render.calls as the
// lifetime render() count and moved the per-frame draw count to info.render.drawCalls; the classic
// renderer only has .calls, and reading it there still means draw calls.
function _drawCalls() {
    const r = renderer.info.render;
    return r.drawCalls !== undefined ? r.drawCalls : r.calls;
}

// --- renderer mode (?renderer=, resolved into the import map by the mode script in dc.html) ---
// The requested mode is a request, not an outcome: WebGPURenderer falls back to its WebGL2 backend
// whenever navigator.gpu is missing, so everything user-visible reports the BACKEND, not the URL.
let _backendName = 'webgl';
// Set from the renderer parameters in init(); read by dc-multi.js's "GPU Mode" row, which has no
// other way to know what was asked for and must not guess.
let _powerPreference = 'browser default';
const _MODE_LABELS = { webgl: 'WebGL', webgpu: 'WebGPU', 'webgpu-gl': 'WebGPU/GL' };
const _BACKEND_LABELS = { webgl: 'WebGL', webgpu: 'WebGPU', 'webgl2-fallback': 'WebGPU (GL)' };

function _rendererMode() {
    const m = window.DC_RENDERER_MODE;
    return (m === 'webgpu' || m === 'webgpu-gl') ? m : 'webgl';
}

function _setupRendererSwitch() {
    // classic WebGLRenderer has no .backend at all
    _backendName = renderer.backend ? (renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2-fallback') : 'webgl';
    const btn = document.getElementById('dcRenderer');
    if (!btn) return;
    const next = _rendererMode() === 'webgl' ? 'webgpu' : 'webgl';
    const here = _BACKEND_LABELS[_backendName] || _backendName;
    btn.textContent = here + ' ⇄ ' + _MODE_LABELS[next];
    btn.title = 'Renderer: ' + here + ' — click to reload with ' + _MODE_LABELS[next];
    btn.addEventListener('click', () => {
        // A switch is a user action, not a device-loss recovery, so the next boot must not find a
        // handoff waiting for it. init() already consumed any, this keeps that true if the order ever
        // changes.
        try { window.sessionStorage.removeItem(_RESTORE_KEY); } catch (e) { /* storage blocked */ }
        // the mode lives in the URL rather than storage, so switching is a reload with the other
        // value — every other param (?dc=, ?location=) has to survive it
        const params = new URLSearchParams(location.search);
        params.set('renderer', next);
        location.search = params.toString();
    });
}

// --- comparison harness: `await DC.bench()` from the console, once per ?renderer= mode ---
// Inert unless called. Nothing here is wired into the render loop or into init(), so a normal page
// load pays nothing for it. It walks the camera through the preset views so every mode is measured
// over one identical path, samples the FPS ring buffer the auto-quality scaler already maintains,
// and puts the camera back where it found it — a measurement must not leave the view somewhere else.
let _benchActive = false;

async function bench(seconds = 10) {
    if (_benchActive) throw new Error('[dc] bench already running');
    if (!renderer || !camera) throw new Error('[dc] scene not ready');
    _benchActive = true;
    const perView = Math.max(1000, Math.round((seconds * 1000) / IDLE_VIEWS.length));
    const homePos = camera.position.clone();
    const homeQuat = camera.quaternion.clone();
    const wasFlying = flyTo.active;
    const samples = [];
    let drawCalls = 0;
    try {
        for (const name of IDLE_VIEWS) {
            // Jump to the preset rather than setView(): a fly-to would spend most of the sample
            // window in transit, and setView() also unlocks the pointer and repaints both the
            // preset buttons and the GUI View dropdown — visible state a console measurement has
            // no business changing.
            const v = viewPreset(name);
            flyTo.active = false;
            camera.position.set(v.pos[0], v.pos[1], v.pos[2]);
            camera.lookAt(v.look[0], v.look[1], v.look[2]);
            const until = performance.now() + perView;
            while (performance.now() < until) {
                await new Promise((r) => setTimeout(r, 250));
                // A page parked for _IDLE_FRAME_THRESHOLD frames has already switched _updateFPS()
                // off, which leaves the window frozen at whatever it read minutes ago. Moving the
                // camera is exactly the activity that clears that gate everywhere else.
                _tickSkippedFrames = 0;
                _skipExpensiveUpdates = false;
                const fps = window.DC.quality._fps;   // rolling FPS_WINDOW average; null while filling
                if (fps) samples.push(fps);
                drawCalls = Math.max(drawCalls, _drawCalls());
            }
        }
    } finally {
        camera.position.copy(homePos);
        camera.quaternion.copy(homeQuat);
        flyTo.active = wasFlying;
        _benchActive = false;
    }
    let sum = 0;
    for (const f of samples) sum += f;
    return {
        mode: _rendererMode(),
        backend: _backendName,
        avgFps: samples.length ? Math.round(sum / samples.length) : null,
        // worst rolling window seen, not the worst single frame — the ring buffer only ever
        // reports an average, so a one-frame hitch is smeared across FPS_WINDOW frames
        minFps: samples.length ? Math.min(...samples) : null,
        drawCalls: drawCalls,
        dpr: renderer.getPixelRatio(),
        location: Number(options.location),
        seconds: (perView * IDLE_VIEWS.length) / 1000,
        samples: samples.length,
    };
}

// --- Phase 1 measurement handle (admin-gated page; getters add zero render work) ---
window.DC = {
    get renderer() { return renderer; },
    get backendName() { return _backendName; },   // 'webgl' | 'webgpu' | 'webgl2-fallback' — actual, not requested
    get powerPreference() { return _powerPreference; },   // what the renderer was constructed with, not a wish
    get scene() { return scene; },
    get camera() { return camera; },
    get controls() { return controls; },
    get options() { return options; },
    get gui() { return gui; },
    get inspector() { return inspector; },        // null unless the webgpu-mode Inspector attached
    get locations() { return locations; },
    get locationNames() { return locationNames; },
    get objects() { return objects; },
    get models() { return models; },
    display: displayDatacenter,
    clear: clearScene,
    cull: updateLabels,
    tick: function () {
        if (document.hidden) return;
        const now = performance.now();

        // Idle skip: after _IDLE_FRAME_THRESHOLD idle frames, gate expensive per-frame updates; reset on player movement (via setLodFocus)
        if (_skipExpensiveUpdates) {
            renderer.render(scene, camera);
            if (stats) stats.update();
            return _drawCalls();
        }
        // MINOR-10: FPS monitoring — only runs when not in idle skip mode
        if (!_skipExpensiveUpdates) {
            _updateFPS(now);
            _autoQualityScale(now);
        }
        maybeFlicker();
        updateDisco();
        maybeCycleIdleView();
        updateFlyTo();
        if ((_hlFrame++ % 4) === 0) updateHighlight();
        updateLabels();
        updateBlinds();
        updateNeighborDoors();
        updateRoomDoors();
        updateLOD();
        updateGuiPos();
        // DRAW THE FRAME. dc-multi.js delegates its whole frame to this tick ("...and the actual
        // render"), so this call is the only thing painting the canvas once the third-person overlay
        // takes over the animation loop from animate(). When the idle-skip fast path was added, this
        // render was MOVED into that branch rather than duplicated, which left the normal path
        // updating everything and drawing nothing: the scene silently froze on the last frame
        // animate() had drawn, while the camera, player, doors and location switches all kept
        // updating invisibly. Keep this here.
        renderer.render(scene, camera);
        if (stats) stats.update();
        if (++_tickSkippedFrames > _IDLE_FRAME_THRESHOLD) _skipExpensiveUpdates = true;
        return _drawCalls();
    },
    pick: function () { return raycastInstances(_centerNdc); },
    info: showInfo,
    search: searchServers,
    flyToServer: flyToServer,
    // --- handles for the dc-multi.js third-person overlay; additive, no effect on dc.html ---
    collidesAt: collidesAt,
    playerRadius: playerRadius,
    eyeHeight: eyeHeight,
    spawnInside: spawnInside,
    unitsPerInch: UNITS_PER_INCH,
    get roomBounds() { return roomBounds; },
    get roomSpawn() { return roomSpawn; },
    // --- automatic quality scaling state (read-only snapshot; mutating S directly applies immediately) ---
    get quality() {
        if (_fpsCount < FPS_WINDOW) return { ...S, _fps: null };
        let fpsSum = 0;
        for (let i = 0; i < _fpsCount; i++) {
            const idx = (_fpsHead + i) % FPS_WINDOW;
            fpsSum += _fpsHistory[idx];
        }
        const _fps = Math.round(1000 / (fpsSum / _fpsCount));
        return { ...S, _fps };
    },
    bench: bench,   // await DC.bench(seconds) — renderer A/B/C harness, see docs/dc_renderer_modes.md
    // --- multi-building LOD + walk-between handles (used by dc-multi.js; inert for dc.html) ---
    collideWorld: collideWorld,                 // walls + current racks + neighbours' active interiors
    get buildings() { return dcBuildings; },    // wall/door rects for every building (current + neighbours)
    setLodFocus: function (x, z) { lodFocus = { x, z }; _tickSkippedFrames = 0; _skipExpensiveUpdates = false; },   // dc-multi feeds the player ground pos each frame
    setAnimationLoop: function (cb) {
        _animationLoopCb = cb || animate;
        if (renderer) renderer.setAnimationLoop(_guardLoop(_animationLoopCb));
    },
    get loopErrors() { return _loopErrorCount; },
    lodState: function () { return lodBuildings.map((b) => ({ id: b.id, full: !!b.full, loading: b.loading, dist: Math.round(b._dist) })); },
};

// Top-level await: init() has to await the node renderer's device acquisition before anything can
// draw. window.DC is already assigned above, and the satellite modules poll for DC.renderer rather
// than reading it eagerly, so the extra microtask/device wait is absorbed.
await init();
_animationLoopCb = animate;
renderer.setAnimationLoop(_guardLoop(animate));
