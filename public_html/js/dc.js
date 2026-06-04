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
import GUI from 'lil-gui';
import Stats from "three/addons/libs/stats.module.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import * as BufferGeometryUtils from "three/addons/utils/BufferGeometryUtils.js";
let camera, scene, renderer, controls, controlObject, stats, gui, locations = {}, maxAnisotropy; // Declare global variables
let prevTime = performance.now();
let racksShown = false, showServers = true;
let objects = {instanced: [], network: null, rackLabels: [], labels: [], room: null}, models = { racks: {}, servers: {} }, locationNames = {};
let rackColliders = []; // x/z footprints of placed racks (for collision)
const options = {
    useFirstPerson: false,
    showLabels: true,
    showNetwork: true,
    showWalls: true,    // room walls (built from the rack-layout bounds)
    showCeiling: true,  // ceiling + fluorescent fixtures + HVAC ducts
	moveForward: false,
	moveBackward: false,
	moveLeft: false,
	moveRight: false,
	canJump: false,
	collisionMovement: false,
	domain: 'mystage.interserver.net',
	location: 4,
	heightInches: 70,   // player standing/eye height: 3.5ft (42") .. 8ft (96"), default 5'10"
	waistInches: 36,    // player waist size -> collision radius: 15" .. 60", default 36"
	scaleX: 8,  // Scale factor for x position
	scaleZ: 9,  // Scale factor for z position
};
const timer = new THREE.Timer();
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

function displayDatacenter() {
    clearScene();
    buildRoom();
    getRackModels();
    getServerModels();
    displaySwitches();
}

function setNetworkVisible(visible) {
    if (objects.network) objects.network.visible = visible;
}

function displayGui() {
    gui = new GUI();
    gui.add( options, 'location', locationNames).listen().onChange( () => { switchLocation(); });
    const displayFolder = gui.addFolder( 'Display' );
    displayFolder.add(options, 'showLabels'); // honored per-frame by updateLabels()
    displayFolder.add(options, 'showNetwork').onChange( (value) => { setNetworkVisible(value); });
    displayFolder.add(options, 'showWalls').name('walls').onChange((v) => { if (objects.room) objects.room.walls.visible = v; });
    displayFolder.add(options, 'showCeiling').name('ceiling').onChange((v) => { if (objects.room) objects.room.ceiling.visible = v; });
    displayFolder.add(options, 'useFirstPerson').onChange( () => { setupControls(); });
    const moveFolder = gui.addFolder( 'Movement' );
    moveFolder.add( options, 'canJump').listen().disable();
    moveFolder.add(camera.position, 'x', -250, 250).listen();
    moveFolder.add(camera.position, 'y', -250, 250).listen();
    moveFolder.add(camera.position, 'z', -250, 250).listen();
    /*moveFolder.add( options, 'moveLeft').listen().disable();
			moveFolder.add( options, 'moveRight').listen().disable();
			moveFolder.add( options, 'moveForward').listen().disable();
			moveFolder.add( options, 'moveBackward').listen().disable();*/
    moveFolder.add( options, 'collisionMovement');
    // height shown as feet+inches (e.g. 5' 10"), waist as plain inches (e.g. 36") via dropdowns,
    // since lil-gui number sliders can't reformat their numeric readout.
    const heightChoices = {}; for (let i = 42; i <= 96; i++) heightChoices[`${Math.floor(i / 12)}' ${i % 12}"`] = i;
    const waistChoices = {}; for (let i = 15; i <= 60; i++) waistChoices[`${i}"`] = i;
    moveFolder.add( options, 'heightInches', heightChoices ).name( 'height' ).onChange(() => { camera.position.y = eyeHeight(); });
    moveFolder.add( options, 'waistInches', waistChoices ).name( 'waist' );
    moveFolder.open(false);
}
function mergeLocations(data) {
    // The response always carries the full locations list (names, for the dropdown); only the
    // requested location has its racks populated. Keep already-loaded full data; fill in names.
    for (const idx in data.locations) {
        const incoming = data.locations[idx];
        const hasRacks = incoming.racks && Object.keys(incoming.racks).length > 0;
        if (hasRacks || !locations[idx]) {
            locations[idx] = incoming;
        }
        locationNames[incoming.name] = Number(idx);
    }
}

function fetchLocation(locId) {
    return fetch('https://' + options.domain + '/ajax/datacenter.php?location=' + Number(locId))
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
    // Fetch the location's data on demand (cached after first load), then (re)build the scene.
    if (locationLoaded(options.location)) {
        displayDatacenter();
    } else {
        fetchLocation(options.location)
            .then(() => displayDatacenter())
            .catch((error) => console.error('There was a problem loading the location:', error));
    }
}

function loadDatacenter() {
    fetchLocation(options.location)
        .then(() => {
            displayGui();
            displayDatacenter();
            const loading = document.getElementById('dcLoading');
            if (loading) loading.style.display = 'none';
        })
        .catch((error) => console.error('There was a problem with the fetch operation:', error));
}

function clearScene() {
    rackColliders = []; // rebuilt as racks are re-placed
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
    // Labels are billboard Sprites: dispose each one's SpriteMaterial + its lazily-built
    // CanvasTexture. The Sprite geometry is a shared three singleton -- never dispose it.
    for (const bucket of ['rackLabels', 'labels']) {
        for (const sprite of objects[bucket]) {
            scene.remove(sprite);
            if (sprite.material.map) sprite.material.map.dispose();
            sprite.material.dispose();
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
                if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose());
                else n.material.dispose();
            }
        });
        objects.room = null;
    }
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
    for (const c of rackColliders) {
        if (x + r > c.minX && x - r < c.maxX && z + r > c.minZ && z - r < c.maxZ) return true;
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

function loadGlbWithFallback(basePath, relName, onLoad) {
    let i = 0;
    const tryNext = () => {
        const url = glbVariantUrl(basePath, relName, GLB_VARIANTS[i]);
        const isLast = i === GLB_VARIANTS.length - 1;
        i += 1;
        loaderGltf.load(url, onLoad, undefined, isLast
            ? (err) => console.error('Failed to load model (all variants): ' + url, err)
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

function buildInstanced(model, placements, kind) {
    const n = placements.length;
    if (!model || !model.parts || n === 0) return;
    const assetIds = placements.map((p) => p.assetId);
    const assetData = placements.map((p) => p.asset);
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
        scene.add(inst);
        objects.instanced.push(inst);
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
            for (const p of placements) {
                rackColliders.push({
                    minX: p.x + fb.min.x, maxX: p.x + fb.max.x,
                    minZ: p.z + fb.min.z, maxZ: p.z + fb.max.z,
                });
            }
        }
    }
}

function getRackModels() {
	let idx, modelName;
	const usedRacksSet = new Set();
	let usedRacks;
	usedRacksSet.clear();
	for (idx in locations[options.location].racks) {
		usedRacksSet.add(locations[options.location].racks[idx].type);
	}
	usedRacks = Array.from(usedRacksSet);
	//console.log(usedRacks);
	usedRacks.forEach((idx) => {
		modelName = rackTypes[idx];
		if (typeof models.racks[idx] == 'undefined') {
			//console.log("Loading Rack "+modelName);
			// Create a closure to capture the current value of idx
			(function (modelIdx) {
				const currentModel = rackTypes[modelIdx];
				loadGlbWithFallback('https://'+options.domain+'/images/3d/racks/', currentModel, function (gltf) {
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
				let currentModel, currentUnits;
				[currentModel, currentUnits] = serverTypes[modelIdx];
                //console.log("Loading Server "+currentModel);
				//loaderDae.load('https://'+options.domain+'/images/3d/servers/dae/'+currentModel+'/model.dae', function (collada) {
				loadGlbWithFallback('https://'+options.domain+'/images/3d/servers/gltf/exported-centered/', currentModel, function (gltf) {
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
    displayText(text, asset, x - 2.5, 19.5, z + 4);
}

function displayServerText(text, asset, x, y, z) {
    displayText(text, asset, x + 3.5, y + 0.25, z + 0.2);
}

const LABEL_DISTANCE = 40;                                  // draw a label only within this many world units
const LABEL_DISTANCE_SQ = LABEL_DISTANCE * LABEL_DISTANCE;
const _labelCamPos = new THREE.Vector3();

function makeLabelTexture(text) {
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
    return texture;
}

// Labels are billboarding Sprites (always face the camera). The canvas texture is built
// LAZILY the first time the label comes within LABEL_DISTANCE; updateLabels() (per frame)
// distance-culls them so only the nearby handful actually draw. This bounds both label
// build cost and draw-call count regardless of how big the location is.
function displayText(text, data, x, y, z) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial());
    sprite.position.set(x, y, z);
    sprite.scale.set(2.5, 0.25, 1);
    sprite.visible = false;
    sprite.userData.text = text;
    sprite.userData.drawn = false;
    scene.add(sprite);
    if (typeof data.hostname != "undefined") {
        objects.labels.push(sprite);
    } else {
        objects.rackLabels.push(sprite);
    }
}

function updateLabels() {
    if (!camera) return;
    const show = options.showLabels;
    camera.getWorldPosition(_labelCamPos);
    for (const arr of [objects.labels, objects.rackLabels]) {
        for (const sprite of arr) {
            const near = show && sprite.position.distanceToSquared(_labelCamPos) < LABEL_DISTANCE_SQ;
            if (near && !sprite.userData.drawn) {
                sprite.material.map = makeLabelTexture(sprite.userData.text);
                sprite.material.needsUpdate = true;
                sprite.userData.drawn = true;
            }
            sprite.visible = near;
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
const CABLE_RADIAL = 6;     // tube cross-section sides (6 = round-looking)
// Cable colours: random-ish per cable for now (could key off link speed later). Blue-dominant
// with yellow + green accents, like a real patch field.
const CABLE_COLORS = [ // 60% blue, 30% yellow, 10% green
    0x2a5bd7, 0x2a5bd7, 0x2a5bd7, 0x2a5bd7, 0x2a5bd7, 0x2a5bd7,
    0xe2c044, 0xe2c044, 0xe2c044,
    0x33aa55,
];
const _cableColor = new THREE.Color();
const _cdir1 = new THREE.Vector3();
const _cdir2 = new THREE.Vector3();

function makeRng(seed) {
    // deterministic per-cable RNG (so sag is varied but stable across rebuilds)
    let s = (seed >>> 0) || 1;
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

function displaySwitches() {
    // One merged tube mesh for ALL switchport cabling (1 draw call): each cable is a rounded 3D
    // tube (matte "plastic" cylinder) routed like real structured cabling. Racks form groups
    // (contiguous runs within a row). A cable goes out the back -> up to its row's overhead tray
    // -> along to the nearest END of its group -> trunk across to the destination group's nearest
    // end -> along that row to the asset. Same-rack links stay short; same-group links run along
    // the shared row tray without leaving the group.
    const racks = locations[options.location].racks;
    const tubes = [];
    const addCable = (pts, hex, off, seed) => {
        const vecs = [];
        for (let k = 0; k < pts.length; k++) {
            const p = pts[k];
            let x = p[0], y = p[1], z = p[2];
            // offset the middle of the route (not the exact port/asset ends) so bundled cables spread
            if (off && k > 0 && k < pts.length - 1) { x += off.x; y += off.y; z += off.z; }
            const v = new THREE.Vector3(x, y, z);
            if (vecs.length === 0 || vecs[vecs.length - 1].distanceToSquared(v) > 1e-6) vecs.push(v);
        }
        if (vecs.length < 2) return;
        let len = 0;
        for (let i = 1; i < vecs.length; i++) len += vecs[i - 1].distanceTo(vecs[i]);
        const curve = new THREE.CatmullRomCurve3(cableCurvePoints(vecs, makeRng(seed || 1)));
        const tubular = Math.min(220, Math.max(10, Math.round(len / 2.2)));
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
                const sameRack = (String(portData.datacenter) === String(options.location)) && (String(portData.rack) === String(rackKey));
                const destGroup = groupOf(destRack.x, destRack.y);
                const sameGroup = (String(portData.datacenter) === String(options.location))
                    && destGroup.y === srcGroup.y && destGroup.xMin === srcGroup.xMin && destGroup.xMax === srcGroup.xMax;
                if (sameRack) {
                    // switch -> server in the SAME rack: front port, straight back to the rear
                    // riser, then across to the server's BACK (no side channel)
                    addCable([
                        [px, py, pz],
                        [px, py, rearAz],
                        [px, ey, rearAz],
                        [ex, ey, rearAz]
                    ], cableHex, off, seed);
                } else if (sameGroup) {
                    // same row/group: up to the row's overhead tray, along it, down into the server BACK
                    addCable([
                        [px, py, pz],
                        [px, py, rearAz],
                        [px, CABLE_OVERHEAD, rearAz],
                        [ex, CABLE_OVERHEAD, rearAz],
                        [ex, ey, rearAz]
                    ], cableHex, off, seed);
                } else {
                    // different rack group: out the nearest END of the source group, trunk across to
                    // the nearest END of the destination group, then along that row into the server BACK
                    const destEnds = groupEnds(destGroup);
                    const srcEndX = Math.abs(srcEnds.leftX - ex) <= Math.abs(srcEnds.rightX - ex) ? srcEnds.leftX : srcEnds.rightX;
                    const destEndX = Math.abs(destEnds.leftX - srcEndX) <= Math.abs(destEnds.rightX - srcEndX) ? destEnds.leftX : destEnds.rightX;
                    addCable([
                        [px, py, pz],
                        [px, py, rearAz],
                        [px, CABLE_OVERHEAD, rearAz],              // up to the row tray
                        [srcEndX, CABLE_OVERHEAD, rearAz],         // along the row to the chosen end
                        [srcEndX, CABLE_OVERHEAD, destEnds.rowZ],  // trunk across to the destination row
                        [destEndX, CABLE_OVERHEAD, destEnds.rowZ], // along the trunk to the destination group's end
                        [ex, CABLE_OVERHEAD, destEnds.rowZ],       // along the destination row to the asset's rack
                        [ex, ey, destEnds.rowZ]                    // down into the server's back
                    ], cableHex, off, seed);
                }
            }
        }
    }
    if (tubes.length === 0) { objects.network = null; return; }
    const geometry = BufferGeometryUtils.mergeGeometries(tubes, false);
    tubes.forEach((g) => g.dispose());
    // matte plastic base + a clearcoat layer for a slight gloss / rounded depth on the cables
    const material = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    const cables = new THREE.Mesh(geometry, material);
    cables.visible = options.showNetwork;
    cables.frustumCulled = false;
    scene.add(cables);
    objects.network = cables;
}

function loadFloor() {
	const helper = new THREE.GridHelper(500, 50);
	helper.position.y = 0;
	helper.material.opacity = 0.25;
	helper.material.transparent = true;
	scene.add(helper);
}

// Room shell built around the racks. We have no real room dimensions in the data, so derive them
// from the rack-layout bounds + a margin. Produces 4 walls + a ceiling, with fluorescent strip
// fixtures and HVAC ducts along the top. Walls and ceiling are independently toggleable.
const ROOM_MARGIN = 14;   // gap from the outermost rack footprints to the walls
const ROOM_CEIL_Y = 30;   // ceiling height (~11.7 ft at this scene scale; racks are ~20 / ~7.8 ft)
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

	const wallMat = new THREE.MeshStandardMaterial({ color: 0xc4c8d0, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });
	const ceilMat = new THREE.MeshStandardMaterial({ color: 0xb0b4bc, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide });

	// 4 walls (full-height vertical planes), one per side
	const wN = new THREE.Mesh(new THREE.PlaneGeometry(W, ROOM_CEIL_Y), wallMat); wN.position.set(cx, ROOM_CEIL_Y / 2, minZ); walls.add(wN);
	const wS = new THREE.Mesh(new THREE.PlaneGeometry(W, ROOM_CEIL_Y), wallMat); wS.position.set(cx, ROOM_CEIL_Y / 2, maxZ); walls.add(wS);
	const wW = new THREE.Mesh(new THREE.PlaneGeometry(D, ROOM_CEIL_Y), wallMat); wW.rotation.y = Math.PI / 2; wW.position.set(minX, ROOM_CEIL_Y / 2, cz); walls.add(wW);
	const wE = new THREE.Mesh(new THREE.PlaneGeometry(D, ROOM_CEIL_Y), wallMat); wE.rotation.y = Math.PI / 2; wE.position.set(maxX, ROOM_CEIL_Y / 2, cz); walls.add(wE);

	// ceiling (horizontal plane, facing down into the room)
	const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat); ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, ROOM_CEIL_Y, cz); ceiling.add(ceil);

	// fluorescent strip fixtures: parallel rows spanning the room in x, just below the ceiling.
	// Merge all housings into one mesh and all lenses into one -> 2 draw calls for every fixture.
	const housings = [], lenses = [];
	const fixLenX = W - 2 * ROOM_MARGIN;
	const fixW = Math.max(0.85, 4 * UNITS_PER_INCH); // ~4" wide strip
	const rows = Math.max(1, Math.round(D / 14));
	for (let i = 0; i < rows; i++) {
		const z = minZ + (D * (i + 0.5) / rows);
		const hg = new THREE.BoxGeometry(fixLenX, 0.5, fixW + 0.5); hg.translate(cx, ROOM_CEIL_Y - 0.5, z); housings.push(hg);
		const lg = new THREE.BoxGeometry(fixLenX - 0.6, 0.25, fixW);  lg.translate(cx, ROOM_CEIL_Y - 0.78, z); lenses.push(lg);
	}
	const housingMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(housings), new THREE.MeshStandardMaterial({ color: 0x3a3d44, roughness: 0.6, metalness: 0.3 }));
	housings.forEach((g) => g.dispose());
	const lensMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(lenses), new THREE.MeshBasicMaterial({ color: 0xfdfff0 })); // unlit -> always reads as a lit tube
	lenses.forEach((g) => g.dispose());
	ceiling.add(housingMesh); ceiling.add(lensMesh);

	// HVAC ducts: big galvanized rectangular runs along the two long sides, up near the ceiling.
	// Low metalness (no env map in the scene, so high metalness would render near-black).
	const ducts = [];
	const ductLen = W - 2 * ROOM_MARGIN, ductW = 6, ductH = 4, ductY = ROOM_CEIL_Y - 3;
	for (const zside of [minZ + ROOM_MARGIN * 0.7, maxZ - ROOM_MARGIN * 0.7]) {
		const dg = new THREE.BoxGeometry(ductLen, ductH, ductW); dg.translate(cx, ductY, zside); ducts.push(dg);
	}
	const ductMesh = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(ducts), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.5, metalness: 0.15 }));
	ducts.forEach((g) => g.dispose());
	ceiling.add(ductMesh);

	walls.visible = options.showWalls;
	ceiling.visible = options.showCeiling;
	scene.add(group);
	objects.room = { group, walls, ceiling };
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
    if (options.useFirstPerson == true) {
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
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(objects.instanced, false);
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
    if (pl && ud.modelBox && !ud.modelBox.isEmpty()) {
        // size + centre the box to the actual model bounds (matches the item's 1U/2U/3U footprint)
        ud.modelBox.getCenter(_hoverPos);
        ud.modelBox.getSize(_hoverSize);
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
    flyTo.t = Math.min(1, flyTo.t + 0.012);                 // ~1.4 s glide at 60 fps
    const e = flyTo.t * flyTo.t * (3 - 2 * flyTo.t);        // smoothstep ease
    camera.position.lerpVectors(flyTo.from, flyTo.to, e);
    camera.lookAt(flyTo.look);
    if (flyTo.t >= 1) flyTo.active = false;
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
    if (name === 'top') return { pos: [b.cx, span * 0.8 + 25, b.cz + 4], look: [b.cx, 0, b.cz] };
    if (name === 'overview') return { pos: [b.maxX + span * 0.3, span * 0.5, b.maxZ + span * 0.4], look: [b.cx, 8, b.cz] };
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

function setView(name) {
    const v = viewPreset(name);
    // Overhead/exterior views look at the layout from above/outside the room shell, where the walls
    // and ceiling would just block the view -> hide them for those; interior views honor the toggles.
    if (objects.room) {
        const exterior = (name === 'top' || name === 'overview');
        objects.room.walls.visible = exterior ? false : options.showWalls;
        objects.room.ceiling.visible = exterior ? false : options.showCeiling;
    }
    flyTo.from.copy(camera.position);
    flyTo.to.set(v.pos[0], v.pos[1], v.pos[2]);
    flyTo.look.set(v.look[0], v.look[1], v.look[2]);
    flyTo.t = 0;
    flyTo.active = true;
    if (controls && controls.isLocked) controls.unlock();
    const bl = document.getElementById('blocker'); if (bl) bl.style.display = 'none';
}

function setupInteraction() {
    if (renderer && renderer.domElement) {
        // Click to start walking (pointer lock); while walking, a click selects what you're looking at.
        renderer.domElement.addEventListener('click', () => {
            if (controls && !options.useFirstPerson && controls.isLocked === false) controls.lock();
            else if (hovered) showInfo(hovered);
        });
    }
    // Preset "show-off" camera views
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

function init() {
    // Load the datacenter information
    loadDatacenter();
    // Set up the camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 1000);
    camera.position.y = eyeHeight();
    // Create the scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    scene.fog = new THREE.Fog(0xffffff, 0, 750);
    // Add ambient light
    const light = new THREE.HemisphereLight(0xeeeeff, 0x777788, 2.5);
    light.position.set(0.5, 1, 0.75);
    scene.add(light);
    // soft directional light so cables (and racks) get specular highlights / depth, not flat ambient
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(60, 120, 40);
    scene.add(sun);
    // Set up the renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    setupControls();
    // Lock the pointer when the user clicks the instructions overlay. Attached once here
    // (not in setupControls) so repeated first-person toggles don't stack listeners; it
    // reads the current `controls` on each click and is a no-op for FirstPersonControls.
    const instructionsEl = document.getElementById("instructions");
    if (instructionsEl) {
        instructionsEl.addEventListener("click", function () {
            if (controls && typeof controls.lock === "function") controls.lock();
        });
    }
    // Load floor
    loadFloor();
    // Add stats monitor
    stats = new Stats();
    document.body.appendChild(stats.dom);
    // Wire up Phase 7 interaction (raycast picking + search box)
    setupInteraction();
    // Event listener for window resize
    window.addEventListener("resize", onWindowResize);
}

// Animation loop
function animate() {
    timer.update();
    if (options.useFirstPerson == true) {
        controls.update( timer.getDelta() );
    } else {
        const time = performance.now();
        // Update controls if locked
        if (controls.isLocked === true) {
            updateControls(time);
        }
    }
    // Phase 7: glide toward a search fly-to target, then highlight what we're looking at (throttled)
    updateFlyTo();
    if ((_hlFrame++ % 4) === 0) updateHighlight();
    // Distance-cull + lazily build labels, then render the scene
    updateLabels();
    renderer.render(scene, camera);
    // Update stats monitor
    stats.update();
}

// Update controls based on user input
function updateControls(time) {
    // Calculate time delta
    const delta = (time - prevTime) / 1000;
    // Update velocity based on user input
    velocity.x -= velocity.x * 10.0 * delta;
    velocity.z -= velocity.z * 10.0 * delta;
    velocity.y -= 9.8 * 100.0 * delta;
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
            if (options.canJump === true) velocity.y += 350;
            options.canJump = false;
            break;
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
}

// --- Phase 1 measurement handle (admin-gated page; getters add zero render work) ---
window.DC = {
    get renderer() { return renderer; },
    get scene() { return scene; },
    get camera() { return camera; },
    get controls() { return controls; },
    get options() { return options; },
    get locations() { return locations; },
    get locationNames() { return locationNames; },
    get objects() { return objects; },
    get models() { return models; },
    display: displayDatacenter,
    clear: clearScene,
    cull: updateLabels,
    tick: function () { updateFlyTo(); updateHighlight(); updateLabels(); renderer.render(scene, camera); return renderer.info.render.calls; },
    pick: function () { return raycastInstances(_centerNdc); },
    info: showInfo,
    search: searchServers,
    flyToServer: flyToServer,
};

init();
renderer.setAnimationLoop(animate);
