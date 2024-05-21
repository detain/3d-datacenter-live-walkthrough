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
import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';
import Stats from "three/addons/libs/stats.module.js";
let camera, scene, renderer, controls, controlObject, stats, gui, locations = {}, maxAnisotropy; // Declare global variables
let prevTime = performance.now();
let racksShown = false, showServers = true;
let objects = {racks: {}, servers: {}, ports: {}, rackLabels: {}, labels: {}}, models = { racks: {}, servers: {} }, locationNames = {};
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
const clock = new THREE.Clock();
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const vertex = new THREE.Vector3();
const color = new THREE.Color();
//const loaderDae = new ColladaLoader();
const loaderGltf = new GLTFLoader();
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

function displayGui() {
    gui = new GUI();	
    gui.add( options, 'location', locationNames).onChange( (value) => { displayDatacenter(); });
    const displayFolder = gui.addFolder( 'Display' );
    displayFolder.add(options, 'showLabels').onChange( (value) => { displayDatacenter(); });
    displayFolder.add(options, 'showNetwork').onChange( (value) => { displayDatacenter(); });
    displayFolder.add(options, 'useFirstPerson').onChange( (value) => { 

        displayDatacenter(); 
    });
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
			for (let locationIdx in data.locations) {
				locationNames[data.locations[locationIdx].name] = Number(locationIdx);
			}
            displayGui();
            displayDatacenter();
		})
		.catch(error => {
			console.error('There was a problem with the fetch operation:', error);
		});
}

function clearScene() {    
    for (let key in objects) {
      if (objects.hasOwnProperty(key)) {
        let innerObject = objects[key];
        for (let innerKey in innerObject) {
          if (innerObject.hasOwnProperty(innerKey)) {
            scene.remove(innerObject[innerKey]);
          }
        }
        objects[key] = {}; 
      }
    }
	scene.traverse(function (child) {
		if (child.isSkinnedMesh) child.skeleton.dispose();
	});
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
				loaderGltf.load('https://'+options.domain+'/images/3d/racks/' + currentModel + '.glb', function (gltf) {
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
						models.racks[modelIdx] = model;

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
                        model.traverse((n) => {
                            if (n.isMesh) {
                                n.castShadow = true;
                                n.receiveShadow = true;
                                //n.material.map.anisotropy = 16;
                            }
                        });
						//model.rotation.z = rotationAngle; // Rotate around the Y-axis
						models.servers[modelIdx] = model;
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
    const modelName = rackTypes[modelIdx];
    const racks = locations[options.location].racks;
    for (const rackKey in racks) {
        if (racks.hasOwnProperty(rackKey)) {
            const rack = racks[rackKey];
            if (rack.type === modelIdx) {
                const { x: positionX, z: positionZ } = convertRackCoordinatesToPosition(rack.x, rack.y);
                const model = SkeletonUtils.clone(models.racks[modelIdx]);
                model.position.set(positionX, 0, positionZ);
                scene.add(model);
                objects.racks[rackKey] = model;
                rack.id = rackKey;
                displayRackText(rack.name, rack, positionX, positionZ);
            }
        }
    }
}

function displayServers(modelIdx) {
    const [modelName, modelUnits] = serverTypes[modelIdx];
    const racks = locations[options.location].racks;
    for (const rackKey in racks) {
        if (racks.hasOwnProperty(rackKey)) {
            const rack = racks[rackKey];
            for (const serverId of Object.keys(rack.servers)) {
                const server = rack.servers[serverId];
                if (server.type === modelIdx) {
                    const { x: positionX, y: positionY, z: positionZ } = convertServerCoordinatesToPosition(rack.x, rack.y, server.start);
                    const model = SkeletonUtils.clone(models.servers[modelIdx]);
                    model.position.set(positionX, positionY, positionZ);
                    scene.add(model);
                    objects.servers[serverId] = model;
                    server.id = serverId;
                    displayServerText(server.hostname, server, positionX, positionY, positionZ);
                }
            }
        }
    }
}

function displayRackText(text, asset, x, z) {
    if (options.showLabels == false) {
        return;
    }
    displayText(text, asset, x - 2.5, 19.5, z + 4);
}

function displayServerText(text, asset, x, y, z) {
    if (options.showLabels == false) {
        return;
    }
    displayText(text, asset, x + 3.5, y + 0.25, z + 0.2);
}

function displayText(text, data, x, y, z) {
    // Create a canvas element
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    // Set canvas dimensions
    canvas.width = 320;
    canvas.height = 32;
    // Set the text properties
    context.font = '20px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    // Fill the background with a color (optional)
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // Optional: Outline the text for better visibility
    context.strokeStyle = 'gray';
    context.lineWidth = 2;
    context.strokeText(text, canvas.width / 2, canvas.height / 2);
    // Draw the text
    context.fillStyle = 'black';
    context.lineWidth = 1;
    context.fillText(text, canvas.width  / 2, canvas.height / 2);
    // Create a texture from the canvas
    const texture = new THREE.CanvasTexture(canvas);
    // Create a plane geometry
    const geometry = new THREE.PlaneGeometry(2.5,0.25);
    // Create a material using the texture
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    // Create the mesh and apply the material
    const plane = new THREE.Mesh(geometry, material);
    plane.position.set(x, y, z);
    // Add the plane to the scene
    scene.add(plane);
    if (typeof data.hostname != "undefined") {
        objects.labels[data.hostname] = plane;
    } else {
        objects.rackLabels[data.name] = plane;
    }
}

function displaySwitches() {
    if (options.showNetwork == false) {
        return;
    }
    const material = new THREE.LineBasicMaterial( { color: 0x0000ff } );
    const racks = locations[options.location].racks;
    let startX, endX, positionX, startY, endY, positionY, startZ, endZ, positionZ, ret, points, geometry;
    for (const rackKey in racks) {
        if (racks.hasOwnProperty(rackKey)) {
            const rack = racks[rackKey];
            for (const switchId of Object.keys(rack.switches)) {
                const switchData = rack.switches[switchId];
                const { x: positionX, y: positionY, z: positionZ } = convertServerCoordinatesToPosition(rack.x, rack.y, switchData.start);
                //displayText(switchData.name, switchData.asset, positionX, positionY, positionZ);
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
                    ret = convertServerCoordinatesToPosition(locations[portData.datacenter].racks[portData.rack].x, locations[portData.datacenter].racks[portData.rack].y, locations[portData.datacenter].racks[portData.rack].servers[portData.asset].start);
                    endX = ret.x;
                    endY = ret.y;
                    endZ = ret.z;
                    points = [];
                    points.push(new THREE.Vector3(startX, startY, startZ));
                    points.push(new THREE.Vector3(startX, startY, startZ + 1));
                    points.push(new THREE.Vector3(endX + 1, endY + 0.25, endZ + 1));
                    points.push(new THREE.Vector3(endX + 1, endY + 0.25, endZ));
                    geometry = new THREE.BufferGeometry().setFromPoints( points );
                    const line = new THREE.Line( geometry, material );
                    scene.add(line);
                    objects.ports[portId] = line;
                }
            }
        }
    }
}

function loadFloor() {
	const helper = new THREE.GridHelper(500, 50);
	helper.position.y = 0;
	helper.material.opacity = 0.25;
	helper.material.transparent = true;
	scene.add(helper);
}

function setupControls() {
    const blocker = document.getElementById("blocker");
    const instructions = document.getElementById("instructions");
    if (options.useFirstPerson == true) {
        controls = new FirstPersonControls( camera, renderer.domElement );
        instructions.style.display = "none";
        blocker.style.display = "none";
    } else {
        controls = new PointerLockControls(camera, renderer.domElement);
        // Event listener for clicking to lock controls
        instructions.addEventListener("click", function () {
            controls.lock();
        });
        // Event listeners for lock and unlock events
        controls.addEventListener("lock", function () {
            instructions.style.display = "none";
            blocker.style.display = "none";
        });
        controls.addEventListener("unlock", function () {
            blocker.style.display = "block";
            instructions.style.display = "";
        });
        // Event listeners for keyboard input
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("keyup", onKeyUp);
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
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
    setupControls();
    // Load floor
    loadFloor();
    // Add stats monitor
    stats = new Stats();
    document.body.appendChild(stats.dom);
    // Event listener for window resize
    window.addEventListener("resize", onWindowResize);
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    if (options.useFirstPerson == true) {
        controls.update( clock.getDelta() );
    } else {
        const time = performance.now();
        // Update controls if locked
        if (controls.isLocked === true) {
            updateControls(time);
        }
    }
    // Render the scene
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
    controls.moveRight(-velocity.x * delta);
    controls.moveForward(-velocity.z * delta);
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

init();
animate();
