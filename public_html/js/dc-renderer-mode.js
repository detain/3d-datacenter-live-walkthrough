/**
 * dc-renderer-mode.js — the ?renderer= contract for the datacenter walkthrough.
 *
 * Which build of three.js the page loads is decided before any module resolves: an import map has
 * to be in the document by the time the first module specifier is looked up, so the decision is
 * made by the classic inline script at the top of dc.html's <head>, which document.write()s the
 * map. That script therefore CANNOT import this file — a module script runs too late, and a
 * classic <script src> in front of it would put a blocking request on the default page for the
 * sake of six lines. It keeps its own copy of the rules instead, and this module is the executable
 * specification of them: tests/js/dc-renderer-mode.test.js runs the shipped inline block straight
 * out of dc.html and asserts it agrees with parseRendererMode() for every mode, so the two cannot
 * drift apart silently.
 *
 * Nothing on the page loads this file. Keep it that way, and keep the inline block in sync — the
 * test is the thing that notices, not the browser.
 */

// public_html/lib is the node_modules symlink, so these are the paths three.js actually ships.
export const THREE_BASE = '/lib/three/build/';
export const ADDONS_BASE = '/lib/three/examples/jsm/';
export const LIL_GUI = '/lib/lil-gui/dist/lil-gui.esm.js';
// index.module.js, NOT index.umd.cjs: the .cjs is a CommonJS bundle with no ES exports, and
// .cjs has no MIME mapping in public_html/.htaccess so it is served as application/node, which
// strict MIME checking rejects as a module script before it is even parsed.
export const THREE_MESH_BVH = '/lib/three-mesh-bvh/build/index.module.js';

/**
 * Resolve a location.search into the renderer mode and the three.js build it needs.
 *
 * The mode is a request, not an outcome: 'webgpu' still ends up on the WebGL2 backend wherever
 * navigator.gpu is missing. Anything unrecognised — absent, empty, misspelled, wrong case — is
 * 'webgl', because the default page is everyone's page and an unknown value must not break it.
 *
 * IMPORTANT: 'webgpu-gl' is a DIAGNOSTIC TOOL, not a fallback tier or production renderer. It
 * forces the node-renderer onto WebGL 2 so the architecture cost can be measured in isolation from
 * the API. It should never be presented to users as a recommended option.
 *
 * @param {string} [search] - location.search, with or without the leading '?'.
 * @returns {{mode: string, buildFile: string, extraImports: Object<string,string>}}
 */
export function parseRendererMode(search) {
    const raw = new URLSearchParams(search || '').get('renderer');
    const mode = (raw === 'webgpu' || raw === 'webgpu-gl') ? raw : 'webgl';
    const buildFile = THREE_BASE + (mode === 'webgl' ? 'three.module.js' : 'three.webgpu.js');
    // Empty on purpose in webgl mode: three.module.js has no WebGPURenderer and no node system, so
    // an accidental 'three/webgpu' or 'three/tsl' import should fail loudly there, not half-work.
    // Fresh object per call — callers merge into it.
    const extraImports = mode === 'webgl' ? {} : {
        'three/webgpu': buildFile,                  // same file as 'three', as on the three.js site
        'three/tsl': THREE_BASE + 'three.tsl.js',   // the Inspector addon imports from it
    };
    return { mode, buildFile, extraImports };
}

/**
 * The complete `imports` object of the import map dc.html writes for a given search string.
 *
 * @param {string} [search] - location.search, with or without the leading '?'.
 * @returns {Object<string,string>}
 */
export function rendererImports(search) {
    const { buildFile, extraImports } = parseRendererMode(search);
    return Object.assign({
        'three': buildFile,
        'three/addons/': ADDONS_BASE,
        'lil-gui': LIL_GUI,
        'three-mesh-bvh': THREE_MESH_BVH,
    }, extraImports);
}
