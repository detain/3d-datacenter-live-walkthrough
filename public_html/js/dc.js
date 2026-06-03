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
//import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import GUI from 'lil-gui';
import Stats from "three/addons/libs/stats.module.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
let camera, scene, renderer, controls, controlObject, stats, gui, locations = {}, maxAnisotropy; // Declare global variables
let prevTime = performance.now();
let racksShown = false, showServers = true;
let objects = {instanced: [], network: null, rackLabels: [], labels: []}, models = { racks: {}, servers: {} }, locationNames = {};
const options = {
    useFirstPerson: false,
    showLabels: true,
    showNetwork: true,
	moveForward: false,
	moveBackward: false,
	moveLeft: false,
	moveRight: false,
	canJump: false,
	collisionMovement: false,
	domain: 'mystage.interserver.net',
	location: 4,
	PlayerWidth: 3,
	PlayerHeight: 15,
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
    getRackModels();
    getServerModels();
    displaySwitches();
}

function setLabelsVisible(visible) {
    for (const obj of objects.labels) obj.visible = visible;
    for (const obj of objects.rackLabels) obj.visible = visible;
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
    displayFolder.add(options, 'useFirstPerson').onChange( () => { setupControls(); });
    const sizeFolder = gui.addFolder( 'Sizing' );
    sizeFolder.add( options, 'scaleX', 0, 100);
    sizeFolder.add( options, 'scaleZ', 0, 100);
    sizeFolder.open(false);
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
    moveFolder.add( options, 'PlayerWidth', 1, 10);
    moveFolder.add( options, 'PlayerHeight', 0, 30).onChange((value) => {
        camera.position.y = value;
    });
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
        .then(() => { displayGui(); displayDatacenter(); })
        .catch((error) => console.error('There was a problem with the fetch operation:', error));
}

function disposeMaterial(material, seen) {
    if (!material || seen.has(material)) return;
    seen.add(material);
    for (const key in material) {
        const val = material[key];
        if (val && val.isTexture) val.dispose();
    }
    material.dispose();
}

function disposeObject(obj, seen) {
    obj.traverse((child) => {
        if (child.geometry && !seen.has(child.geometry)) {
            seen.add(child.geometry);
            child.geometry.dispose();
        }
        const mat = child.material;
        if (Array.isArray(mat)) {
            mat.forEach((m) => disposeMaterial(m, seen));
        } else if (mat) {
            disposeMaterial(mat, seen);
        }
        if (child.isSkinnedMesh && child.skeleton) child.skeleton.dispose();
    });
}

function clearScene() {
    const seen = new Set();
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

function convertPositionToRackCoordinates(positionX, positionZ) {
    const x = Math.floor((positionX + 100) / options.scaleX);
    const z = Math.floor((positionZ + 100) / options.scaleZ);
    return { x, z };
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

function isRackAtPosition(positionX, positionZ) {
    const rackCoordinates = convertPositionToRackCoordinates(positionX, positionZ);
    const racks = locations[options.location].racks;
    for (const rackKey in racks) {
        if (racks.hasOwnProperty(rackKey)) {
            const rack = racks[rackKey];
            if (rack.x == rackCoordinates.x && rack.y == rackCoordinates.z) {
                return true; // Rack found at the given coordinates
            }
        }
    }
    return false; // No racks found at the given coordinates
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
    // Normalize the loaded model (origin, no rotation, fixed scale) and capture each
    // sub-mesh's geometry + material + its transform in model space (scale baked in).
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0, 0);
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
    const parts = [];
    root.traverse((n) => {
        if (n.isMesh && n.geometry) {
            parts.push({ geometry: n.geometry, material: n.material, matrix: n.matrixWorld.clone() });
        }
    });
    return parts;
}

function buildInstanced(modelParts, placements, kind) {
    const n = placements.length;
    if (!modelParts || n === 0) return;
    const assetIds = placements.map((p) => p.assetId);
    const assetData = placements.map((p) => p.asset);
    for (const part of modelParts) {
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
        scene.add(inst);
        objects.instanced.push(inst);
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
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    context.font = '20px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = 'gray';
    context.lineWidth = 2;
    context.strokeText(text, 160, 16);
    context.fillStyle = 'black';
    context.lineWidth = 1;
    context.fillText(text, 160, 16);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
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

function displaySwitches() {
    // One merged LineSegments for ALL switchport cabling (was one THREE.Line per port =
    // thousands of draw calls). Each port is a 4-point polyline -> 3 segments (point pairs).
    const racks = locations[options.location].racks;
    const positions = [];
    let startX, startY, startZ, ret, endX, endY, endZ;
    const seg = (ax, ay, az, bx, by, bz) => { positions.push(ax, ay, az, bx, by, bz); };
    for (const rackKey of Object.keys(racks)) {
        const rack = racks[rackKey];
        for (const switchId of Object.keys(rack.switches)) {
            const switchData = rack.switches[switchId];
            const { x: positionX, y: positionY, z: positionZ } = convertServerCoordinatesToPosition(rack.x, rack.y, switchData.start);
            const portWidth = Math.ceil(switchData.totalPorts / 2);
            for (const portId of Object.keys(switchData.ports)) {
                const portData = switchData.ports[portId];
                startX = portData.justport;
                startZ = positionZ;
                startY = positionY + 0.3;
                if (startX > portWidth) {
                    startX -= portWidth;
                    startY -= 0.15;
                }
                startX = positionX + 0.15 + (0.15 * startX);
                const destLoc = locations[portData.datacenter];
                const destRack = (destLoc && destLoc.racks) ? destLoc.racks[portData.rack] : null;
                const destServer = (destRack && destRack.servers) ? destRack.servers[portData.asset] : null;
                if (!destServer) { continue; } // endpoint not in the loaded location (e.g. cross-DC link)
                ret = convertServerCoordinatesToPosition(destRack.x, destRack.y, destServer.start);
                endX = ret.x;
                endY = ret.y;
                endZ = ret.z;
                seg(startX, startY, startZ, startX, startY, startZ + 1);
                seg(startX, startY, startZ + 1, endX + 1, endY + 0.25, endZ + 1);
                seg(endX + 1, endY + 0.25, endZ + 1, endX + 1, endY + 0.25, endZ);
            }
        }
    }
    if (positions.length === 0) { objects.network = null; return; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x0000ff }));
    lines.visible = options.showNetwork;
    lines.frustumCulled = false;
    scene.add(lines);
    objects.network = lines;
}

function loadFloor() {
	const helper = new THREE.GridHelper(500, 50);
	helper.position.y = 0;
	helper.material.opacity = 0.25;
	helper.material.transparent = true;
	scene.add(helper);
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
    hit.mesh.getMatrixAt(hit.instanceId, _hoverMatrix);
    _hoverPos.setFromMatrixPosition(_hoverMatrix);
    if (hit.kind === 'rack') {
        highlightBox.scale.set(6, 19, 6);
        highlightBox.position.set(_hoverPos.x, 9.5, _hoverPos.z);
    } else {
        highlightBox.scale.set(5.5, 0.6, 5.5);
        highlightBox.position.set(_hoverPos.x + 1, _hoverPos.y + 0.25, _hoverPos.z);
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

function setupInteraction() {
    if (renderer && renderer.domElement) {
        // A click selects whatever the camera is centred on (works in pointer-lock look mode).
        renderer.domElement.addEventListener('click', () => { if (hovered) showInfo(hovered); });
    }
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
    camera.position.y = options.PlayerHeight;
    // Create the scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    scene.fog = new THREE.Fog(0xffffff, 0, 750);
    // Add ambient light
    const light = new THREE.HemisphereLight(0xeeeeff, 0x777788, 2.5);
    light.position.set(0.5, 1, 0.75);
    scene.add(light);
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
    // Collision: block walking into a rack cell (opt-in via the Movement > collisionMovement toggle)
    if (options.collisionMovement && isRackAtPosition(camera.position.x, camera.position.z)) {
        camera.position.x = prevX;
        camera.position.z = prevZ;
        velocity.x = 0;
        velocity.z = 0;
    }
    camera.position.y += velocity.y * delta;
    // Handle jumping
    if (camera.position.y < options.PlayerHeight) {
        velocity.y = 0;
        camera.position.y = options.PlayerHeight;
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
