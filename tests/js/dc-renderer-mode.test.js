/**
 * tests/js/dc-renderer-mode.test.js — the ?renderer= URL contract (plan_dc.md phase 8)
 *
 * Two things are under test here, and the second is the point of the file:
 *
 *   1. public_html/js/dc-renderer-mode.js — parseRendererMode()/rendererImports(), pure functions
 *      over a query string.
 *   2. The inline mode script at the top of public_html/admin/dc.html, which is what actually
 *      ships. It cannot import the module (an import map has to exist before the first module
 *      specifier resolves, so the block must stay a classic script and stay first in <head>), so
 *      it carries its own copy of the rules. These tests pull that block out of the markup, run it
 *      against a stub window/document/location, and assert the import map it writes matches the
 *      module for every mode — which is what stops the copy from drifting.
 *
 * The structural assertions (first script, no type attribute, no leftover static import map) are
 * the ones that catch the failure mode with no error message: an import map that lands after
 * three.js has already been resolved simply loads the wrong build.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import {
  parseRendererMode,
  rendererImports,
  THREE_BASE,
  ADDONS_BASE,
  LIL_GUI,
} from '../../public_html/js/dc-renderer-mode.js';

const fs = require('node:fs');
const path = require('node:path');

const HTML_PATH = path.resolve(__dirname, '../../public_html/admin/dc.html');
const HTML = fs.readFileSync(HTML_PATH, 'utf8');

const REPO = path.resolve(__dirname, '../..');

// The page serves these out of /lib, which is the node_modules symlink (created by yarn's
// postinstall). Resolve through node_modules directly so the check does not depend on the symlink.
function urlToDisk(url) {
  return path.join(REPO, url.replace(/^\/lib\//, 'node_modules/'));
}

// ---------------------------------------------------------------------------
// The shipped inline block, extracted and executed
// ---------------------------------------------------------------------------

// The mode script is the first <script> in the document and writes its markup with '<\x2Fscript>',
// so the first literal closing tag is its own.
function inlineModeScript() {
  const open = HTML.indexOf('<script>');
  const close = HTML.indexOf('</script>', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return HTML.slice(open + '<script>'.length, close);
}

function runInline(search) {
  const win = {};
  const writes = [];
  const doc = { write: (s) => writes.push(s) };
  const loc = { search };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'location', inlineModeScript())(win, doc, loc);
  const maps = writes.filter((w) => w.includes('type="importmap"'));
  const preloads = writes.filter((w) => w.includes('modulepreload'));
  let imports = null;
  if (maps.length === 1) {
    const json = maps[0].slice(maps[0].indexOf('>') + 1, maps[0].lastIndexOf('<'));
    imports = JSON.parse(json).imports;
  }
  return { mode: win.DC_RENDERER_MODE, imports, maps, preloads, writes };
}

const MODES = [
  { search: '', mode: 'webgl' },
  { search: '?renderer=webgl', mode: 'webgl' },
  { search: '?renderer=webgpu', mode: 'webgpu' },
  { search: '?renderer=webgpu-gl', mode: 'webgpu-gl' },
];

// ---------------------------------------------------------------------------
// parseRendererMode()
// ---------------------------------------------------------------------------
describe('parseRendererMode() — mode resolution', () => {
  it('defaults to webgl with no query string at all', () => {
    for (const search of ['', undefined, null, '?', '?dc=5']) {
      expect(parseRendererMode(search).mode).toBe('webgl');
    }
  });

  it('accepts the two node-renderer modes', () => {
    expect(parseRendererMode('?renderer=webgpu').mode).toBe('webgpu');
    expect(parseRendererMode('?renderer=webgpu-gl').mode).toBe('webgpu-gl');
  });

  it('falls back to webgl for any unrecognised value', () => {
    for (const val of ['', 'webgl2', 'vulkan', 'WEBGPU', 'WebGPU', 'webgpu ', ' webgpu', 'gpu']) {
      expect(parseRendererMode('?renderer=' + val).mode).toBe('webgl');
    }
  });

  it('reads the parameter with or without the leading ?', () => {
    expect(parseRendererMode('renderer=webgpu').mode).toBe('webgpu');
    expect(parseRendererMode('?renderer=webgpu').mode).toBe('webgpu');
  });

  it('finds the parameter among the page\'s other params, in any position', () => {
    expect(parseRendererMode('?dc=5&renderer=webgpu&location=2').mode).toBe('webgpu');
    expect(parseRendererMode('?renderer=webgpu&dc=5').mode).toBe('webgpu');
    expect(parseRendererMode('?dc=5&location=2&renderer=webgpu-gl').mode).toBe('webgpu-gl');
  });

  it('takes the first value when the parameter is repeated', () => {
    expect(parseRendererMode('?renderer=webgpu&renderer=webgl').mode).toBe('webgpu');
    expect(parseRendererMode('?renderer=nonsense&renderer=webgpu').mode).toBe('webgl');
  });
});

describe('parseRendererMode() — build selection', () => {
  it('loads the classic build in webgl mode', () => {
    const r = parseRendererMode('');
    expect(r.buildFile).toBe(THREE_BASE + 'three.module.js');
  });

  it('loads the node build in both webgpu modes — forceWebGL is a renderer option, not a build', () => {
    expect(parseRendererMode('?renderer=webgpu').buildFile).toBe(THREE_BASE + 'three.webgpu.js');
    expect(parseRendererMode('?renderer=webgpu-gl').buildFile).toBe(THREE_BASE + 'three.webgpu.js');
  });

  it('maps no webgpu-only specifiers in webgl mode, so an accidental import fails loudly', () => {
    expect(parseRendererMode('').extraImports).toEqual({});
  });

  it('maps three/webgpu at the same file as three, plus three/tsl, for the Inspector', () => {
    for (const search of ['?renderer=webgpu', '?renderer=webgpu-gl']) {
      const r = parseRendererMode(search);
      expect(r.extraImports).toEqual({
        'three/webgpu': r.buildFile,
        'three/tsl': THREE_BASE + 'three.tsl.js',
      });
    }
  });

  it('returns a fresh extraImports object per call — callers merge into it', () => {
    const a = parseRendererMode('?renderer=webgpu');
    a.extraImports['three/tsl'] = 'clobbered';
    expect(parseRendererMode('?renderer=webgpu').extraImports['three/tsl'])
      .toBe(THREE_BASE + 'three.tsl.js');
    const first = parseRendererMode('').extraImports;
    first.injected = 'x';
    expect(parseRendererMode('').extraImports).toEqual({});
  });

  it('points every mapped specifier at a file that actually ships', () => {
    const files = new Set();
    for (const { search } of MODES) {
      for (const url of Object.values(rendererImports(search))) {
        if (url.endsWith('/')) continue;   // three/addons/ is a prefix mapping, checked below
        files.add(url);
      }
    }
    expect(files.size).toBeGreaterThanOrEqual(4);
    for (const url of files) {
      expect(fs.existsSync(urlToDisk(url)), url + ' is missing on disk').toBe(true);
    }
    expect(fs.existsSync(urlToDisk(ADDONS_BASE))).toBe(true);
  });
});

describe('rendererImports() — the whole map', () => {
  it('always maps three, three/addons/ and lil-gui', () => {
    for (const { search } of MODES) {
      const imports = rendererImports(search);
      expect(imports.three).toBe(parseRendererMode(search).buildFile);
      expect(imports['three/addons/']).toBe(ADDONS_BASE);
      expect(imports['lil-gui']).toBe(LIL_GUI);
    }
  });

  it('has exactly four entries in webgl mode and six in the webgpu modes', () => {
    expect(Object.keys(rendererImports('')).sort())
      .toEqual(['lil-gui', 'three', 'three-mesh-bvh', 'three/addons/']);
    expect(Object.keys(rendererImports('?renderer=webgpu')).sort())
      .toEqual(['lil-gui', 'three', 'three-mesh-bvh', 'three/addons/', 'three/tsl', 'three/webgpu']);
  });
});

// ---------------------------------------------------------------------------
// dc.html's inline copy of the same rules
// ---------------------------------------------------------------------------
describe('dc.html mode script — placement (an import map written too late is silent)', () => {
  it('is the very first script in the document', () => {
    const firstScript = HTML.indexOf('<script');
    expect(firstScript).toBeGreaterThan(-1);
    expect(HTML.slice(firstScript, firstScript + '<script>'.length)).toBe('<script>');
  });

  it('sits inside <head>, before any module script', () => {
    const head = HTML.indexOf('<head>');
    const firstScript = HTML.indexOf('<script');
    const firstModule = HTML.indexOf('<script type="module"');
    expect(head).toBeGreaterThan(-1);
    expect(firstScript).toBeGreaterThan(head);
    expect(firstScript).toBeLessThan(HTML.indexOf('</head>'));
    expect(firstScript).toBeLessThan(firstModule);
  });

  it('is a classic script — no type, defer or async, which would run it after module resolution', () => {
    const open = HTML.indexOf('<script>');
    const tail = HTML.slice(open, HTML.indexOf('</script>', open));
    expect(tail.slice(0, 8)).toBe('<script>');
    expect(HTML.slice(0, open)).not.toMatch(/<script/);
  });

  it('leaves no static import map in the markup — the written one must be the only one', () => {
    const after = HTML.slice(HTML.indexOf('</script>', HTML.indexOf('<script>')));
    expect(after).not.toMatch(/<script\s+type="importmap"/);
  });
});

describe('dc.html mode script — agrees with dc-renderer-mode.js', () => {
  for (const { search, mode } of MODES) {
    const label = search || '(no query string)';

    it(`${label} → DC_RENDERER_MODE = ${mode}`, () => {
      expect(runInline(search).mode).toBe(mode);
    });

    it(`${label} → writes exactly the import map the module describes`, () => {
      const out = runInline(search);
      expect(out.maps).toHaveLength(1);
      expect(out.imports).toEqual(rendererImports(search));
    });

    it(`${label} → preloads the build it just mapped`, () => {
      const out = runInline(search);
      const { buildFile } = parseRendererMode(search);
      expect(out.preloads).toHaveLength(2); // three.js + three-mesh-bvh
      expect(out.preloads[0]).toContain('href="' + buildFile + '"');
      expect(out.imports.three).toBe(buildFile);
    });
  }

  it('falls back to webgl on an unknown value, exactly like the module does', () => {
    for (const val of ['vulkan', 'WEBGPU', '']) {
      const out = runInline('?renderer=' + val);
      expect(out.mode).toBe('webgl');
      expect(out.imports).toEqual(rendererImports('?renderer=' + val));
      expect(out.imports['three/webgpu']).toBeUndefined();
    }
  });

  it('writes the import map before the preload, so the map is in place either way', () => {
    const out = runInline('?renderer=webgpu');
    expect(out.writes).toHaveLength(3); // importmap + two modulepreloads (three.js + three-mesh-bvh)
    expect(out.writes[0]).toContain('importmap');
    expect(out.writes[1]).toContain('modulepreload');
  });

  it('escapes its own closing tag so the written map is not cut short', () => {
    // '<\x2Fscript>' in the source, '</script>' at runtime — a literal here would end the block.
    expect(inlineModeScript()).not.toMatch(/<\/script>/);
    expect(runInline('').maps[0].endsWith('</script>')).toBe(true);
  });
});
