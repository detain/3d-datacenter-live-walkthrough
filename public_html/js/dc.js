import * as THREE from "three"; // Import necessary modules from Three.js
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
//import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
//import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import Stats from "three/addons/libs/stats.module.js";
let camera, scene, renderer, controls, stats, serverObj, raycaster; // Declare global variables
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false, canJump = false;
let prevTime = performance.now();
let collisionMovement = false, racksShown = false, showServers = true;
const objects = [], models = { racks: {}, servers: {} };
const maxRoomServers = 0;
const PlayerHeight = 15;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const vertex = new THREE.Vector3();
const color = new THREE.Color();
//const loaderDae = new ColladaLoader();
const loaderGltf = new GLTFLoader();
const usedRacksSet = new Set();
const usedServerSet = new Set();
let usedRacks, usedServers;
let racks = [[0,1,1,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[0,2,1,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[0,3,1,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[0,4,1,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[0,5,1,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[0,6,1,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[0,7,1,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[0,8,1,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[0,9,1,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[0,10,1,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[1,1,2,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[1,2,2,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[1,3,2,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[1,4,2,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[1,5,2,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[1,6,2,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[1,7,2,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[1,8,2,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[1,9,2,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[1,10,2,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[2,1,3,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[2,2,3,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[2,3,3,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[2,4,3,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[2,5,3,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[2,6,3,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[2,7,3,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[2,8,3,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[2,9,3,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[2,10,3,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[3,1,4,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[3,2,4,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[3,3,4,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[3,4,4,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[3,5,4,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[3,6,4,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[3,7,4,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[3,8,4,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[3,9,4,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[3,10,4,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[4,1,5,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[4,2,5,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[4,3,5,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[4,4,5,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[4,5,5,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[4,6,5,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[4,7,5,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[4,8,5,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[4,9,5,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[4,10,5,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[5,1,6,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[5,2,6,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[5,3,6,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[5,4,6,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[5,5,6,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[5,6,6,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[5,7,6,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[5,8,6,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[5,9,6,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[5,10,6,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[6,1,7,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[6,2,7,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[6,3,7,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[6,4,7,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[6,5,7,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[6,6,7,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[6,7,7,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[6,8,7,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[6,9,7,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[6,10,7,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[7,1,8,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[7,2,8,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[7,3,8,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[7,4,8,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[7,5,8,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[7,6,8,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[7,7,8,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[7,8,8,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[7,9,8,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[7,10,8,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[8,1,9,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[8,2,9,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[8,3,9,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[8,4,9,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[8,5,9,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[8,6,9,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[8,7,9,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[8,8,9,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[8,9,9,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[8,10,9,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[9,1,10,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[9,2,10,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[9,3,10,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[9,4,10,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[9,5,10,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[9,6,10,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[9,7,10,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[9,8,10,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[9,9,10,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[9,10,10,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[10,1,11,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[10,2,11,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[10,3,11,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[10,4,11,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[10,5,11,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[10,6,11,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[10,7,11,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[10,8,11,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[10,9,11,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[10,10,11,[[9,1],[9,2],[9,4],[9,7],[9,11]]],[11,1,12,[[0,1],[0,2],[0,4],[0,7],[0,11]]],[11,2,12,[[1,1],[1,2],[1,4],[1,7],[1,11]]],[11,3,12,[[2,1],[2,2],[2,4],[2,7],[2,11]]],[11,4,12,[[3,1],[3,2],[3,4],[3,7],[3,11]]],[11,5,12,[[4,1],[4,2],[4,4],[4,7],[4,11]]],[11,6,12,[[5,1],[5,2],[5,4],[5,7],[5,11]]],[11,7,12,[[6,1],[6,2],[6,4],[6,7],[6,11]]],[11,8,12,[[7,1],[7,2],[7,4],[7,7],[7,11]]],[11,9,12,[[8,1],[8,2],[8,4],[8,7],[8,11]]],[11,10,12,[[9,1],[9,2],[9,4],[9,7],[9,11]]],];
const rackTypes = [
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
];
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
const serverTypes = [
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
	["IOGear Miniview Ultra KVM Switch", 1],
	//["Juniper-EX3300", 1],
	["Middle Atlantic PD-2020R-NS Rack Power Strip PSU", 1],
	["pdu_front", 1],
	["SEDNA 19 1U RACK MOUNTED USB HUB", 1],
	//["SuperMicro6015X", 1],
	["TrendNet_TEG-S16Dg_tab_front", 1],
	["Tripp-lite rack power strip", 1],
	["Cisco-ASR-1002-no-interfaces", 2],
	["Cisco+ASR1002-X", 2],
	["Cisco+ASR9001", 2],
	["Cisco HyperFlex HX240c M5", 2],
	["Cisco+Nexus+5596UP", 2],
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
	["Cisco 3925 Router", 3],
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
	["HP ProLiant ML350 G5", 5],
	//["HP ProLiant ML370 G5", 5],
	//["Cisco Catalyst 6506e", 11],
	["Cisco Catalyst 4510r", 14],
];
function generateRandomRacksLayout(sizeX = 25, sizeY = 25, maxRacks = 0) {
    const roomLayout = [];
    // Shuffle rack types to use a different type for each X row
    const shuffledRackTypes = [...rackTypes];
    for (let i = shuffledRackTypes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledRackTypes[i], shuffledRackTypes[j]] = [shuffledRackTypes[j], shuffledRackTypes[i]];
    }
    let currentRackTypeIndex = 0;
    let totalRacks = 0;
    for (let y = 1; y <= sizeY; y++) {
        let hasRackInRow = false;
        for (let x = 1; x <= sizeX; x++) {
            if (maxRacks > 0 && totalRacks >= maxRacks) {
                break;
            }
            // Randomly choose whether to add a rack or an empty space
            const isRack = Math.random() < 0.8; // Adjust the probability as needed
            if (isRack) {
                const rackTypeIdx = currentRackTypeIndex % rackTypes.length;
                const rackType = shuffledRackTypes[rackTypeIdx];
                // Use the response from generateRandomRackLayout for the Servers array
                const serversLayout = generateRandomRackLayout(30);
                // Add the rack to the room layout
                roomLayout.push([rackTypeIdx, x, y, serversLayout]);
                currentRackTypeIndex++;
                hasRackInRow = true;
                totalRacks++;
            }
        }
        // Skip rows with no racks
        if (hasRackInRow) {
            continue;
        }
    }
    return roomLayout;
}

function generateRandomRackLayout(rackHeight = 42) {
    const rackLayout = [];
    for (let i = 0; i < rackHeight; i++) {
        // Randomly choose to place a server or an empty space
        const isServer = Math.random() < 0.5;
        if (isServer) {
            // Filter server types based on remaining space
            const validServers = serverTypes.filter(([_, modelUnits]) => modelUnits <= rackHeight - i);
            if (validServers.length > 0) {
                // Choose a random server type from the filtered list
                const randomServerIndex = Math.floor(Math.random() * validServers.length);
                const [modelName, modelUnits] = validServers[randomServerIndex];
                rackLayout.push([serverTypes.indexOf(validServers[randomServerIndex]), i + 1]);
                i += modelUnits - 1; // Adjust for server height
            }
        }
    }
    return rackLayout;
}
function clearScene() {
	for (const object of objects) {
		scene.remove(object);
		scene.traverse(function (child) {
			if (child.isSkinnedMesh) child.skeleton.dispose();
		});
	}
	objects.length = 0;
}
function getRackModels() {
	let idx, modelName;
	for (idx = 0; idx < racks.length; idx++) {
		usedRacksSet.add(racks[idx][0]);
	}
	usedRacks = Array.from(usedRacksSet);
	for (idx in usedRacks) {
		modelName = rackTypes[idx];
		//console.log("Loading Rack "+modelName);
		// Create a closure to capture the current value of idx
		(function (currentModel) {
			loaderGltf.load("https://mystage.interserver.net/images/3d/racks/" + currentModel + ".glb", function (gltf) {
					const scale = 10;
					const rotationAngle = Math.PI / 2; // 90 degrees in radians
					const model = gltf.scene;
					model.scale.set(scale, scale, scale);
					model.rotation.y = rotationAngle; // Rotate around the Y-axis
					models.racks[currentModel] = model;
					//console.log(models);
					//console.log("checking racks len "+Object.keys(models.racks).length+" against type len "+rackTypes.length);
					//console.log("finished loading rack "+currentModel);
					displayRacks(currentModel);
				}
			);
		})(modelName);
	}
	console.log("Got to the end of the loading racks code block");
}
function displayRacks(modelName) {
	let lastX = 0, lastZ = 0, modelIdx = 0, model, position;
	//console.log('Displaying Racks using '+modelName);
	racks.forEach(([modelIdx, x, z, servers]) => {
		if (rackTypes[modelIdx] == modelName) {
			//console.log("Adding rack at x "+x+" z "+z+" model "+modelName);
			model = SkeletonUtils.clone(models.racks[modelName]);
			position = new THREE.Vector3(-100 + (x * 10), 1, -100 + (z * 20));
			model.position.copy(position);
			scene.add(model);
			objects.push(model);
		}
	});
}
function getServerModels() {
	let idxRack, idxServer, modelName, modelUnits;
	for (idxRack = 0; idxRack < racks.length; idxRack++) {
		if (racks[idxRack][3].length > 0) {
			for (idxServer = 0; idxServer < racks[idxRack][3].length; idxServer++) {
				usedServerSet.add(racks[idxRack][3][idxServer][0]);
			}
		}
	}
	usedServers = Array.from(usedServerSet);
	for (idxServer in usedServers) {
		[modelName, modelUnits] = serverTypes[idxServer];
		//console.log("Loading Server "+modelName);
		// Create a closure to capture the current value of idx
		(function (currentModel) {
			//loaderDae.load('https://mystage.interserver.net/images/3d/servers/dae/'+currentModel+'/model.dae', function (collada) {
			loaderGltf.load("https://mystage.interserver.net/images/3d/servers/gltf/exported-centered/" + currentModel + ".glb", function (gltf) {
					//const scale = 0.26;
					const scale = 10;				
					const rotationAngle = Math.PI / 2; // 90 degrees in radians
					const model = gltf.scene;
					if (scale !== false) {
						model.scale.set(scale, scale, scale);
					}
					//model.rotation.z = rotationAngle; // Rotate around the Y-axis
					models.servers[currentModel] = model;
					//console.log(gltf);
					console.log("finished loading server " + currentModel);
					displayServers(currentModel);
				}
			);
		})(modelName);
	}
}
function displayServers(modelName) {
	let lastX = 0, lastZ = 0, idxRack, idxServer, modelUnits, model, position;
	console.log("Displaying Servers");
	if (showServers == true) {
		racks.forEach(([idxRack, x, z, servers]) => {
			servers.forEach(([idxServer, start]) => {
				[modelName, modelUnits] = serverTypes[idxServer];
				console.log("Adding rack[" + x + "," + z + "] server starting at " + start + " model " + modelName + " size " + modelUnits + "U");
				model = SkeletonUtils.clone(models.servers[modelName]);
				//position = new THREE.Vector3(-100 + (x * 20), 1, -100 + (z * 10));
				position = new THREE.Vector3(-2 + -100 + (x * 10), 1 + 0.5 * start, 2.6 + -100 + (z * 20));
				model.position.copy(position);
				scene.add(model);
			});
		});
		renderer.render(scene, camera);
	}
}
function loadFloor() {
	const helper = new THREE.GridHelper(500, 500);
	helper.position.y = 0;
	helper.material.opacity = 0.25;
	helper.material.transparent = true;
	scene.add(helper);
}
function init() {
	//racks = generateRandomRacksLayout(7, 7);
	// Initialize the scene
	camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 1000); // Set up the camera
	camera.position.y = PlayerHeight;
	scene = new THREE.Scene(); // Create the scene
	scene.background = new THREE.Color(0xffffff);
	scene.fog = new THREE.Fog(0xffffff, 0, 750);
	const light = new THREE.HemisphereLight(0xeeeeff, 0x777788, 2.5); // Add hemisphere light for ambient lighting
	light.position.set(0.5, 1, 0.75);
	scene.add(light);
	controls = new PointerLockControls(camera, document.body); // Set up pointer lock controls
	const blocker = document.getElementById("blocker");
	const instructions = document.getElementById("instructions");
	instructions.addEventListener("click", function () {
		controls.lock(); // Event listener for locking controls
	});
	controls.addEventListener("lock", function () {
		instructions.style.display = "none"; // Event listeners for lock and unlock events
		blocker.style.display = "none";
	});
	controls.addEventListener("unlock", function () {
		blocker.style.display = "block";
		instructions.style.display = "";
	});
	scene.add(controls.getObject()); // Add controls to the scene
	const onKeyDown = function (event) {
		switch (
			event.code // Event listeners for keydown and keyup events
		) {
			case "ArrowUp":
			case "KeyW":
				moveForward = true;
				break;
			case "ArrowLeft":
			case "KeyA":
				moveLeft = true;
				break;
			case "ArrowDown":
			case "KeyS":
				moveBackward = true;
				break;
			case "ArrowRight":
			case "KeyD":
				moveRight = true;
				break;
			case "Space":
				if (canJump === true) velocity.y += 350;
				canJump = false;
				break;
			case "KeyZ":
				scene.remove(serverObj); // Remove current Collada model from the scene
				const modelNames = Object.keys(serverModels); // Get a random modelName from serverModels keys
				const randomModelName =
					modelNames[Math.floor(Math.random() * modelNames.length)];
				loadFilesFromServer(randomModelName); // Load and add the new Collada model
				break;
		}
	};
	const onKeyUp = function (event) {
		switch (event.code) {
			case "ArrowUp":
			case "KeyW":
				moveForward = false;
				break;
			case "ArrowLeft":
			case "KeyA":
				moveLeft = false;
				break;
			case "ArrowDown":
			case "KeyS":
				moveBackward = false;
				break;
			case "ArrowRight":
			case "KeyD":
				moveRight = false;
				break;
		}
	};
	document.addEventListener("keydown", onKeyDown);
	document.addEventListener("keyup", onKeyUp);
	raycaster = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 10); // Initialize Raycaster for object intersection
	loadFloor();
	getRackModels();
	getServerModels();
	renderer = new THREE.WebGLRenderer({ antialias: true }); // Set up the renderer
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(window.innerWidth, window.innerHeight);
	document.body.appendChild(renderer.domElement);
	stats = new Stats();
	document.body.appendChild(stats.dom);
	window.addEventListener("resize", onWindowResize); // Event listener for window resize
}
function onWindowResize() {
	camera.aspect = window.innerWidth / window.innerHeight; // Handle window resize
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);
}
function animate() {
	requestAnimationFrame(animate); // Animation loop
	const time = performance.now();
	if (controls.isLocked === true) {
		raycaster.ray.origin.copy(controls.getObject().position);
		raycaster.ray.origin.y -= 10;
		const intersections = raycaster.intersectObjects(objects, false); // Check for intersections with objects
		const onObject = intersections.length > 0;
		const delta = (time - prevTime) / 1000;
		velocity.x -= velocity.x * 10.0 * delta; // Update velocity based on user input
		velocity.z -= velocity.z * 10.0 * delta;
		velocity.y -= 9.8 * 100.0 * delta; // 100.0 = mass
		direction.z = Number(moveForward) - Number(moveBackward);
		direction.x = Number(moveRight) - Number(moveLeft);
		direction.normalize(); // Ensure consistent movements in all directions
		if (moveForward || moveBackward) velocity.z -= direction.z * 400.0 * delta;
		if (moveLeft || moveRight) velocity.x -= direction.x * 400.0 * delta;
		if (collisionMovement == true && onObject === true) {
			velocity.y = Math.max(0, velocity.y);
			canJump = true;
		}
		controls.moveRight(-velocity.x * delta); // Update controls position
		controls.moveForward(-velocity.z * delta);
		controls.getObject().position.y += velocity.y * delta;
		if (controls.getObject().position.y < PlayerHeight) {
			velocity.y = 0; // New behavior for jumping
			controls.getObject().position.y = PlayerHeight;
			canJump = true;
		}
	}
	prevTime = time;
	renderer.render(scene, camera); // Render the scene
	stats.update();
}
init();
animate();
