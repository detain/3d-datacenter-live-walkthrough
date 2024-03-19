import * as THREE from "three"; // Import necessary modules from Three.js
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
//import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import Stats from "three/addons/libs/stats.module.js";
let camera, scene, renderer, controls, stats, gui, serverObj, raycaster, locations = {}; // Declare global variables
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false, canJump = false;
let prevTime = performance.now();
let collisionMovement = false, racksShown = false, showServers = true, locationId = 1;
const objects = [], models = { racks: {}, servers: {} }, locationNames = [];
const options = {
	domain: 'mystage.interserver.net',
	locationId: 2,
	location: ''
};
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
	["Cisco Catalyst 4510r", 14],
];

function loadDatacenter() {
	fetch('https://'+options.domain+'/ajax_datacenter.php')
		.then(response => {
			if (!response.ok) {
				throw new Error('Network response was not ok');
			}
			return response.json();
		})
		.then(data => {
			locations = data.locations;
			console.log('id:'+options.locationId);
		  console.log(locations[options.locationId]);
			console.log(locations[options.locationId].name);
			options.location = locations[options.locationId].name;
			let locationIdx;
			// Deal with the JSON data as an object here
			// You can access properties of the object like data.propertyName
			for (locationIdx in data.locations) {
				locationNames.push(data.locations[locationIdx].name);
			}
			gui = new GUI();	
			gui.add( options, 'location', locationNames ).onChange( (value) => {
				options.locationId = locationName2Id(value)
				console.log(options.location);
			});
			getRackModels();
			getServerModels();
		})
		.catch(error => {
			console.error('There was a problem with the fetch operation:', error);
		});
}

function locationName2Id(name) {
	  let locationIdx;
		for (locationIdx in locations) {
			if (locations[locationIdx].name == name) {
				return locationIdx;
			}
		}
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
	usedRacksSet.clear();
	for (idx in locations[options.locationId].racks) {
		usedRacksSet.add(locations[options.locationId].racks[idx].type);
	}
	usedRacks = Array.from(usedRacksSet);
	console.log(usedRacks);
	usedRacks.forEach((idx) => {
		modelName = rackTypes[idx];
		if (typeof models.racks[idx] == 'undefined') {
			//console.log("Loading Rack "+modelName);
			// Create a closure to capture the current value of idx
			(function (modelIdx) {
				const currentModel = rackTypes[modelIdx];
				loaderGltf.load('https://'+options.domain+'/images/3d/racks/' + currentModel + '.glb', function (gltf) {
						const scale = 10;
						const rotationAngle = Math.PI / 2; // 90 degrees in radians
						const model = gltf.scene;
						if (scale !== false) {
							model.scale.set(scale, scale, scale);
						}
						//model.rotation.y = rotationAngle; // Rotate around the Y-axis
						models.racks[modelIdx] = model;
						//console.log(models);
						//console.log("checking racks len "+Object.keys(models.racks).length+" against type len "+rackTypes.length);
						//console.log("finished loading rack "+currentModel);
						displayRacks(modelIdx);
					}
				);
			})(idx);
		} else {
			displayRacks(idx);
		}
	});
	console.log("Got to the end of the loading racks code block");
}

function displayRacks(modelIdx) {
	let x, z, rack, lastX = 0, lastZ = 0, model, position, idxRack;
	const modelName = rackTypes[modelIdx];
	console.log('Displaying Racks using idx '+modelIdx+' value '+modelName);
	for (idxRack in locations[options.locationId].racks) {
		rack = locations[options.locationId].racks[idxRack];
		if (locations[options.locationId].racks[idxRack].type == modelIdx) {
			x = locations[options.locationId].racks[idxRack].x;
			z = locations[options.locationId].racks[idxRack].y;
			//console.log("Adding rack at x "+x+" z "+z+" model "+modelName);
			model = SkeletonUtils.clone(models.racks[modelIdx]);
			position = new THREE.Vector3(-100 + (x * 10), 1, -100 + (z * 20));
			model.position.copy(position);
			scene.add(model);
			objects.push(model);
		}
	}
}

function getServerModels() {
	let idxRack, idxServer, modelName, modelUnits;
	usedServerSet.clear();
	for (idxRack in locations[options.locationId].racks) {
		for (idxServer in locations[options.locationId].racks[idxRack].servers) {
			usedServerSet.add(locations[options.locationId].racks[idxRack].servers[idxServer].type);
		}
	}
	usedServers = Array.from(usedServerSet);
	usedServers.forEach((idxServer) => {
		console.log('idx server '+idxServer);
		if (typeof models.servers[idxServer] == 'undefined') {
			[modelName, modelUnits] = serverTypes[idxServer];
			//console.log("Loading Server "+modelName);
			// Create a closure to capture the current value of idx
			(function (modelIdx) {
				let currentModel, currentUnits;
				[currentModel, currentUnits] = serverTypes[modelIdx];
				//loaderDae.load('https://'+options.domain+'/images/3d/servers/dae/'+currentModel+'/model.dae', function (collada) {
				loaderGltf.load('https://'+options.domain+'/images/3d/servers/gltf/exported-centered/' + currentModel + '.glb', function (gltf) {
						//const scale = 0.26;
						const scale = 10;				
						const rotationAngle = Math.PI / 2; // 90 degrees in radians
						const model = gltf.scene;
						if (scale !== false) {
							model.scale.set(scale, scale, scale);
						}
						//model.rotation.z = rotationAngle; // Rotate around the Y-axis
						models.servers[modelIdx] = model;
						//console.log(gltf);
						console.log("finished loading server " + currentModel);
						displayServers(modelIdx);
					}
				);
			})(idxServer);
		} else {
			displayServers(idxServer);
		}
	});
}

function displayServers(modelIdx) {
	let x, z, start, idxRack, idxServer, modelName, modelUnits, model, position;
	console.log("Displaying Servers");
	if (showServers == true) {
		[modelName, modelUnits] = serverTypes[modelIdx];
		for (idxRack in locations[options.locationId].racks) {
			x = locations[options.locationId].racks[idxRack].x;
			z = locations[options.locationId].racks[idxRack].y;
			for (idxServer in locations[options.locationId].racks[idxRack].servers) {
				if (locations[options.locationId].racks[idxRack].servers[idxServer].type == modelIdx) {
					start = locations[options.locationId].racks[idxRack].servers[idxServer].start;
					//console.log("Adding rack[" + x + "," + z + "] server starting at " + start + " model " + modelName + " size " + modelUnits + "U");
					model = SkeletonUtils.clone(models.servers[modelIdx]);
					//position = new THREE.Vector3(-100 + (x * 20), 1, -100 + (z * 10));
					position = new THREE.Vector3(-2.5 + -100 + (x * 10), 1 + 0.5 * start, 2.6 + -100 + (z * 20));
					model.position.copy(position);
					scene.add(model);					
				}
			}
		}
		renderer.render(scene, camera);
	}
}

function loadFloor() {
	const helper = new THREE.GridHelper(500, 50);
	helper.position.y = 0;
	helper.material.opacity = 0.25;
	helper.material.transparent = true;
	scene.add(helper);
}

function init() {
	loadDatacenter();
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
