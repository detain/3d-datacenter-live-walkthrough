import * as THREE from "three"; // Import necessary modules from Three.js
import { PointerLockControls } from "three/addons/controls/PointerLockControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
//import { GUI } from 'three/addons/libs/lil-gui.module.min.js';
import Stats from 'three/addons/libs/stats.module.js';

let camera, scene, renderer, controls, stats, serverObj, raycaster; // Declare global variables
let moveForward = false, moveBackward = false, moveLeft = false, moveRight = false, canJump = false;
let prevTime = performance.now();
let collisionMovement = false;
const objects = [], models = [];
const PlayerHeight = 15;
const velocity = new THREE.Vector3();
const direction = new THREE.Vector3();
const vertex = new THREE.Vector3();
const color = new THREE.Color();
const racks  = [["1","1",[]],["1","10",[]],["1","11",[]],["1","22",[]],["7","6",[]],["7","7",[]],["7","8",[]],["7","9",["3","5","7","11","17","19","20","22","23","24","28","29","30","32","33","34","35","37","38","40","41","42"]],["7","10",[]],["7","11",["1"]],["7","12",["3","5","8","12","13","14","15","16","17","19","20","22","24","27","28","29","30","31","33","35","36","37","39","40","41","42"]],["7","15",[]],["7","16",["4","5","6","7","8","9","10","11","12","13","14","18","19","20","21","22","23","27","28","29","30","31","32","33","34","35","36"]],["7","17",[]],["9","6",[]],["9","7",["1"]],["9","8",["3","9","13","14","16","17","18","20","21","24","27","28","29","30","35","36","37","38","39","40","41"]]]; //,["9","9",["1"]],["9","10",["1"]],["9","11",["5","6","7","9","11","13","15","17","19","20","25","26","27","28","30","32","33","34","35","36"]],["9","12",["4","5","6","8","12","14","15","16","17","18","19","20","21","24","32","33","35","36","37","38","39","41"]],["9","15",["24"]],["9","16",[]],["9","17",["1"]],["9","18",["1"]],["9","19",[]],["9","20",["1"]],["9","21",["1"]],["12","6",["4","7","9","11","14","17","21","22","23","27","28","30","31","32","40","47"]],["12","7",["5","6","7","8","9","10","11","12","13","14","15","16","19","20","21","22","23","27","28","29","30","31","32","33","34","35","36","37","38","40","41","42"]],["12","8",["1"]],["12","9",[]],["12","10",["2","6","8","12","16","17","26","27","28","29","31","32","33","34","36","37","38","39","40"]],["12","11",["1"]],["12","12",["1"]],["12","15",["1"]],["12","16",["1"]],["12","17",["13","14","15","16","17","18","19","20","21","22","23","27","29","30","31","32","34","35","37","38","40","42","43","45","46","47","48"]],["12","18",[]],["12","19",[]],["12","20",["7","9","11","14","15","16","17","18","19","20","21","22","23","27","28","29","30","31","32","33","34","35","36","37","38","39","40","41","42","43","44","45","46","47","48"]],["12","21",[]],["14","5",[]],["14","6",[]],["14","7",["4","15","20","24"]],["14","8",["1"]]];
const rackTypes = ["1182_096_2","5307_824_2","5507_150_2","7831_800_2","SB838072AFB18","WZ-IT-426060-69AA-2-011_0", "WZ-IT-426060-69AA-2-011_0"];//,"7000_562_2", ];
const serverTypes = ['Barracuda 350 1U', 'Dell PowerEdge 850 1U', 'Cisco Small Business SG220-50'];//, 'SuperMicro6015X']; //, 'SEDNA 19 1U RACK MOUNTED USB HUB', 'pdu_front'];
function clearScene() {
	for ( const object of objects ) {
		scene.remove( object );
		scene.traverse( function ( child ) {
			if ( child.isSkinnedMesh ) child.skeleton.dispose();
		} );
	}	
	objects.length = 0;
}
function getServerModel(modelName) {
	
}
function loadFilesFromServer(modelName, x = 4, y = 1, z = 3, scale = false) {
    /*
    console.log("Loading "+modelName);
    const loader = new GLTFLoader();
    loader.load(`https://my.interserver.net/images/3d/servers/gltf/exported/${modelName}.gltf`, function (gltf) {
        const model = gltf.scene;
        // Set positions based on the serverRacks array
        const position = new THREE.Vector3(x, y, z);
        if (scale !== false) {
            model.scale.set(scale, scale, scale);
        }            
        model.position.copy(position);
        scene.add(model);
        objects.push(model);
        // No need to store information in the serverRacks array again, as it's already pre-filled
        renderer.render(scene, camera);
    }); 
    */
    console.log("Loading "+modelName);
    const loader = new ColladaLoader();
    // Load the .dae file from the serverFiles array
    loader.load(`https://my.interserver.net/images/3d/servers/dae/${modelName}/model.dae`, function (collada) {
            console.log(collada);
            //var dae = collada.scene;
            serverObj = collada.scene;
            const rotationAngle = Math.PI / 2; // 90 degrees in radians
            // Set positions based on the serverRacks array
            const position = new THREE.Vector3(x, y, z);
            if (scale !== false) {
                serverObj.scale.set(scale, scale, scale);
            }            
            serverObj.rotation.z = rotationAngle; // Rotate around the Y-axis
            serverObj.position.copy(position);
            scene.add(serverObj);
    });
}
function initServerRacks() {
    const loader = new GLTFLoader();
    racks.forEach(([x, z, servers]) => {
        const modelURL = rackTypes[Math.floor(Math.random() * rackTypes.length)];
        loader.load(`https://my.interserver.net/images/3d/racks/${modelURL}.glb`, function (gltf) {
                const model = gltf.scene;
                const scale = 10;
                const rotationAngle = Math.PI / 2; // 90 degrees in radians
                // Set positions based on the serverRacks array
                const position = new THREE.Vector3(x * 10, 1, z * 10);
                model.scale.set(scale, scale, scale);
              	model.rotation.y = rotationAngle; // Rotate around the Y-axis
                model.position.copy(position);
                scene.add(model);
                objects.push(model);
                // No need to store information in the serverRacks array again, as it's already pre-filled
                renderer.render(scene, camera);
        });
        servers.forEach(([start]) => {
            const serverURL = serverTypes[Math.floor(Math.random() * serverTypes.length)];
						loadFilesFromServer(serverURL, 2.5+(10*x), 1+(0.5*start), 2.6+(10*z), 0.26);
        });
    });
}
function loadFloor() {
                const helper = new THREE.GridHelper( 500, 500 );
                helper.position.y = 0;
                helper.material.opacity = 0.25;
                helper.material.transparent = true;
                scene.add( helper );

}
function init() {
    // Initialize the scene
    camera = new THREE.PerspectiveCamera(75,window.innerWidth / window.innerHeight,1,1000); // Set up the camera
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
        switch (event.code) { // Event listeners for keydown and keyup events
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
								const randomModelName = modelNames[Math.floor(Math.random() * modelNames.length)];
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
    initServerRacks(); // Call the initServerRacks function to load the pre-filled server racks
    renderer = new THREE.WebGLRenderer({ antialias: true }); // Set up the renderer
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);
    stats = new Stats();
    document.body.appendChild( stats.dom );    
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
    /*
    // 1U Servers
		loadFilesFromServer('Barracuda 350 1U', 12.5, 1.5, 12.6, 0.26);
    loadFilesFromServer('SuperMicro6015X', 12.5, 12, 12.6, 0.26);
    loadFilesFromServer('Dell PowerEdge 850 1U', 12.5, 12.5, 12.5, 0.26);
    loadFilesFromServer('Dell PowerEdge R210', 12.5, 13, 12.5, 0.0040);
    // 1u PDU/Network
    loadFilesFromServer('SEDNA 19 1U RACK MOUNTED USB HUB', 12.5, 19, 12.5, 0.26);
    loadFilesFromServer('Cisco Small Business SG220-50', 12.5, 19.5, 12.5, 0.26);
    loadFilesFromServer('pdu_front', 12.5, 20, 12.5, 0.26);
	
	
    loadFilesFromServer('Middle Atlantic PD-2020R-NS Rack Power Strip PSU', 7.5, 10, 2.6, 0.26);
small:
    loadFilesFromServer('Tripp-lite rack power strip', 7.5, 15, 2.6, 0.26);
    loadFilesFromServer('IOGear Miniview Ultra KVM Switch', 7.5, 9, 2.6, 0.26);

    loadFilesFromServer('Cisco Small Business SG220-26', 7.5, 5, 2.6, 0.26);
    loadFilesFromServer('Dell-PowerEdge-R430', 5.5, 8, 2.6, 0.26);

    loadFilesFromServer('SGI Altix 350', 7.5, 13, 2.6, 0.26);
    loadFilesFromServer('Dell PowerEdge 2650 2U', 4, 14, 3, 0.26);
    loadFilesFromServer('lo detail 2U', 4, 22, 3, 0.26);
    loadFilesFromServer('SuperMicro 2U Server', 4, 32, 3, 0.26);

big:
    loadFilesFromServer('Sun Oracle SPARC T4-1', 0, 9.5, 2.6, 0.0042);
    loadFilesFromServer('Lenovo ThinkSystem SR650', 3.5, 9, 2.6, 0.0042);

    loadFilesFromServer('Dell EMC PowerEdge R240 1u', .5, 5.5, 2.6, 0.0042);
    loadFilesFromServer('Dell-PowerEdge-1750-1U', 1.0, 6.0, 2.6, 0.0042);
    loadFilesFromServer('Cisco UCS C210 M2', 2.0, 7.0, 2.6, 0.0042);
    loadFilesFromServer('Cisco UCS C240 M5', 2.5, 7.5, 2.6, 0.0042);
    loadFilesFromServer('Cisco UCS C460 M2', 3.0, 8.0, 2.6, 0.0042);
    loadFilesFromServer('IBM eServer pSeries 615 (6C3P)', 3.5, 8.5, 2.6, 0.0042);
    loadFilesFromServer('IBM eServer xSeries 336', 1.0, 6.0, 2.6, 0.0042);
    loadFilesFromServer('IBM eServer xSeries 345', 1.5, 6.5, 2.6, 0.0042);
    loadFilesFromServer('IBM system x3530 M4', 2.0, 7.0, 2.6, 0.0042);
    loadFilesFromServer('IBM (System x3850 x6)', 2.5, 7.5, 2.6, 0.0042);
    loadFilesFromServer('SunOracle X2-8L', 5.0, 10.0, 2.6, 0.0042);

wont load:
    loadFilesFromServer('IBM Power8 S814 4U', 4, 13, 3);
    loadFilesFromServer('TrendNet_TEG-S16Dg_tab_front', 4, 34, 3);

2u+:
    loadFilesFromServer('Cisco HyperFlex HX240c M5', 7.5, 6, 2.6, 0.0042);
    loadFilesFromServer('Lenovo ThinkServer RD240', 7.5, 7, 2.6, 0.0042);
    loadFilesFromServer('Sun Microsystems SunFire V440', 7.5, 8, 2.6, 0.0042);
    loadFilesFromServer('Dell PowerEdge R710', 7);
    loadFilesFromServer('HP Integrity RX2660', 7, 6, 3);
    loadFilesFromServer('HP ProLiant ML350 G5', 7, 7, 3);
    loadFilesFromServer('HP ProLiant ML370 G5', 7, 8, 3);
    loadFilesFromServer('IBM Power 730', 7, 9, 3);
    loadFilesFromServer('IBM Power Linux (7R2)', 7, 10, 3);
    loadFilesFromServer('IBM System p 520', 7, 11, 3);
    loadFilesFromServer('Sun Microsystems Netra T4 1', 7, 12, 3);
    loadFilesFromServer('Sun Microsystems SunFire V445', 7, 13, 3);
    loadFilesFromServer('Unisys ES3000 Model 3580R G3', 7, 14, 3);

    loadFilesFromServer('Dell PowerEdge R910 4U', 4, 19, 3);
    loadFilesFromServer('Lenovo ThinkSystem SR950 mission-critical 4U', 4, 21, 3);
*/
