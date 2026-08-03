/**
 * E2E tests for public_html/admin/dc.html (datacenter 3D scene)
 *
 * Comprehensive test suite covering:
 * - Static HTML structure validation
 * - HUD element presence
 * - CSS styling validation
 * - WebSocket/presence globals (defensive)
 *
 * Tests that require WebGL context are marked with continue-on-error
 * since headless Chromium may not fully support WebGL.
 *
 * Run: npx playwright test --project=chromium tests/playwright/dc.spec.ts
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// The ?renderer= modes the page smoke-tests run against (plan_dc.md §3, phase 8).
//
// The mode is a request, not an outcome. Headless chromium here runs on SwiftShader and has no
// navigator.gpu, so ?renderer=webgpu constructs a WebGPURenderer that resolves to its WebGL2
// fallback backend — which is precisely the path worth pinning, since it is what every browser
// without WebGPU gets. Real WebGPU is not asserted anywhere; see the PW_WEBGPU project in
// playwright.config.ts for why.
// ---------------------------------------------------------------------------
const RENDERER_MODES = [
  { label: 'default', url: '/admin/dc.html', mode: 'webgl', build: 'three.module.js' },
  { label: '?renderer=webgpu', url: '/admin/dc.html?renderer=webgpu', mode: 'webgpu', build: 'three.webgpu.js' },
] as const;

// ---------------------------------------------------------------------------
// Helper: wait for the page to be fully loaded (static HTML ready)
// ---------------------------------------------------------------------------
async function waitForPageLoad(page: any, timeout = 60000): Promise<boolean> {
  return page
    .waitForLoadState('domcontentloaded', { timeout })
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Hermetic boot — every page load in this file goes through here.
//
// What starves the single-threaded `php -S` fixture is NOT the rack/server inventory. dc.html is
// loaded directly to bypass PHP session auth, but /ajax/datacenter.php enforces its OWN session
// check, so an unstubbed load gets a 403 there and requests exactly zero rack or server GLBs —
// measured across a full run. The load is dc-multi.js's character assets: it picks a character at
// RANDOM per page load (Math.random()) and animation sets range from ~25 GLBs to ~2500, so the same
// spec could pull 25 or 2500 files depending on the draw. That is what took the 30s budget away from
// beforeEach. Three stubs remove all of it:
//
//   - window.WebSocket, installed before any page script runs, so the real datacentered hub
//     (wss://…:7272) is NEVER contacted. dc-ws.js reads `WebSocket` as a bare identifier, which
//     resolves to the window property, so the override takes effect. No op/re handling is touched —
//     the socket simply never opens, which is a state the v1 protocol already has to survive.
//   - /ajax/datacenter.php, which turns that 403 into a room: without it displayDatacenter() never
//     runs, so #dcLoading never lifts, attachKeyHandlers() never fires and no HUD panel is built.
//   - /images/3d/mixamo/manifest.json, answered 404 so dc-multi.js takes its "no character assets"
//     branch. public_html/images/3d is gitignored, so 404 is exactly what CI sees. Nothing below
//     asserts on characters; the overlay still boots, still exposes window.DCM and still handles
//     V/R without a model (applyMode() guards S.model).
//
// The payload is keyed at location 4 ON PURPOSE. dc.js's options.location defaults to 4 and
// buildRoom()/getRackModels() read locations[options.location] straight off the merged response, so
// a payload without that id throws inside loadDatacenter()'s .then() — where the .catch() swallows
// it, leaving #dcLoading (inset:0, z-index:40) up for the life of the page and eating every pointer
// interaction, which is the same dead end as the 403. Keep this key and options.location in step.
// ---------------------------------------------------------------------------
function fullRacks(seed: number) {
  // Same shape /ajax/datacenter.php emits. Rack type 1 and server type 1 are real entries in dc.js's
  // rackTypes/serverTypes, so the room resolves two small meshopt GLBs instead of the full set.
  const racks: Record<string, any> = {};
  for (let r = 1; r <= 4; r++) {
    const servers: Record<string, any> = {};
    for (let s = 0; s < 3; s++) {
      servers[String(seed + r * 10 + s)] = { hostname: `web${r}${s}.test`, start: 1 + s * 2, size: 1, type: 1 };
    }
    racks[String(seed + r)] = { x: r, y: 2, name: `R${r}`, type: 1, servers, switches: {} };
  }
  return racks;
}

// The full tier: ONE location, complete inventory. This is what ?location=<id> returns.
const DATACENTER_STUB = { locations: { 4: { name: 'Test DC', region: 'Test', racks: fullRacks(100) } } };

/**
 * The index tier: EVERY location, racks stripped to {x, y} — datacenter.php:138-147.
 *
 * Three locations, not one, and that is load-bearing. buildCommunity() only lays out a street
 * when it can place two or more buildings, so a single-location stub cannot tell a working
 * community layout from an empty one — which is how the neighbours-and-LOD regression (R2.1)
 * survived a full E2E suite. The index tier existing at all is what makes placing a neighbour
 * possible without its inventory, so the fixture has to reproduce that asymmetry to be worth
 * anything: locations 7 and 9 are placed here and never returned in full, exactly like a real
 * boot.
 */
const DATACENTER_INDEX_STUB = {
  locations: {
    4: { name: 'Test DC', region: 'Test', racks: indexRacks(100) },
    7: { name: 'Test DC West', region: 'Test', racks: indexRacks(200) },
    9: { name: 'Test DC South', region: 'Test', racks: indexRacks(300) },
  },
};

function indexRacks(seed: number) {
  const racks: Record<string, any> = {};
  for (let r = 1; r <= 4; r++) racks[String(seed + r)] = { x: r, y: 2 };
  return racks;
}

// One switch with one port pointing at server 110, so buildPortsByAsset() has something to index
// and Group 12 can assert the Trace Cable button appears. `asset` is a NUMBER here on purpose —
// that is what PHP's (int) cast emits, and the mismatch against the string ids the info panel
// holds is what kept the button hidden for every asset (R2.6).
DATACENTER_STUB.locations[4].racks['101'].switches = {
  900: {
    name: 'sw1', asset: 0, start: 20, size: 1, totalPorts: 24, type: 6,
    ports: { 7: { justport: 1, port: 'Gi0/1', asset: 110, datacenter: 4, rack: 101 } },
  },
};

/**
 * 'throw' the WebSocket constructor throws (blocked / bad URL)
 * 'close' the socket is created and closes immediately
 * 'dead'  the socket is created already closed and stays silent
 */
type HubMode = 'throw' | 'close' | 'dead';

async function stubHub(page: any, mode: HubMode) {
  await page.addInitScript((m: string) => {
    (window as any).__wsAttempts = 0;
    function DeadSocket(this: any, url: string) {
      (window as any).__wsAttempts++;
      (window as any).__wsUrl = url;
      if (m === 'throw') throw new Error('E2E: hub unreachable');
      this.url = url;
      this.readyState = m === 'dead' ? 3 : 0;
      this.send = m === 'dead' ? () => {} : () => { throw new Error('E2E: socket is not open'); };
      this.close = () => { this.readyState = 3; };
      if (m === 'close') {
        setTimeout(() => {
          this.readyState = 3;
          if (this.onclose) this.onclose({ code: 1006, reason: 'E2E: hub unreachable' });
        }, 0);
      }
    }
    (DeadSocket as any).CONNECTING = 0;
    (DeadSocket as any).OPEN = 1;
    (DeadSocket as any).CLOSING = 2;
    (DeadSocket as any).CLOSED = 3;
    (window as any).WebSocket = DeadSocket;
  }, mode);
}

async function bootHermetic(page: any, url = '/admin/dc.html', hub: HubMode = 'dead') {
  await stubHub(page, hub);
  // Answer the two tiers separately, the way the endpoint does. Serving the full payload to
  // ?tier=index would collapse the fixture back to one location and hide anything that depends on
  // the index/full split.
  await page.route('**/ajax/datacenter.php*', (route: any) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(route.request().url().includes('tier=index') ? DATACENTER_INDEX_STUB : DATACENTER_STUB),
    })
  );
  await page.route('**/images/3d/mixamo/manifest.json*', (route: any) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'E2E: no character assets' })
  );
  await page.goto(url, { timeout: 120000 });
  await page.waitForLoadState('domcontentloaded');
}

// #dcLoading is hidden on the last line of loadDatacenter()'s success path, after displayGui() and
// displayDatacenter() have both run. That makes it the one signal covering everything a live-scene
// test needs: the HUD panel is built, attachKeyHandlers() has run, and the curtain that intercepts
// pointer events is gone.
async function waitForSceneLoaded(page: any, timeout = 90000) {
  await page.waitForFunction(() => {
    const el = document.getElementById('dcLoading');
    return !!(window as any).DC?.scene && !!el && getComputedStyle(el).display === 'none';
  }, { timeout });
}

// dc-multi.js assigns window.DCM at the tail of its whenReady() bootstrap, after setupInput() has
// attached the V/R handlers — so the global appearing is the readiness signal for this overlay.
async function waitForDCM(page: any, timeout = 90000) {
  await page.waitForFunction(() => (window as any).DCM, { timeout });
}

// DC.renderer goes truthy the instant the renderer is CONSTRUCTED, but _setupRendererSwitch() — the
// only thing that ever assigns DC.backendName — runs after `await renderer.init()`, which in webgpu
// mode is a real asynchronous device acquisition. Between those two points DC.backendName is still
// dc.js's module-level 'webgl' default, so anything gating on DC.renderer alone can read a WebGPU boot
// as a WebGL one. That same function writes the #dcRenderer label, which makes the label the honest
// "backendName has been assigned" signal.
async function waitForRendererSettled(page: any, timeout = 90000) {
  await page.waitForFunction(
    () => !!(window as any).DC?.renderer && !!document.getElementById('dcRenderer')?.textContent,
    { timeout }
  );
}

// ---------------------------------------------------------------------------
// Group 1: Static HTML Structure (no JavaScript required)
// ---------------------------------------------------------------------------
test.describe('Group 1: Static HTML Structure', () => {
  // Hermetic even though nothing here needs the scene: a bare goto still lets dc-multi.js pull a
  // random character's whole animation set through the fixture server, which is a load these tests
  // pay for and nobody collects on. See bootHermetic.
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
  });

  test('page has correct title', async ({ page }) => {
    await expect(page).toHaveTitle(/DataCenter|InterServer/);
  });

  test('#dcSearch input exists with correct attributes', async ({ page }) => {
    const searchInput = page.locator('#dcSearch');
    await expect(searchInput).toHaveCount(1);
    await expect(searchInput).toHaveAttribute('type', 'search');
    await expect(searchInput).toHaveAttribute('placeholder', /Search hostname/i);
    await expect(searchInput).toHaveAttribute('autocomplete', 'off');
  });

  test('#dcViews buttons exist with correct data-view attributes', async ({ page }) => {
    const viewButtons = page.locator('#dcViews button');
    await expect(viewButtons).toHaveCount(5);

    const expectedViews = ['overview', 'top', 'aisle', 'labels', 'cables'];
    for (const view of expectedViews) {
      const btn = page.locator(`#dcViews button[data-view="${view}"]`);
      await expect(btn).toHaveCount(1);
    }
  });

  test('#dcLocations container exists', async ({ page }) => {
    await expect(page.locator('#dcLocations')).toHaveCount(1);
  });

  test('#dcPlayer exists with person toggle button', async ({ page }) => {
    await expect(page.locator('#dcPlayer')).toHaveCount(1);
    await expect(page.locator('#dcPerson')).toHaveCount(1);
  });

  test('#dcRenderer sits outside both #dcViews and #dcPlayer', async ({ page }) => {
    // Placement, not decoration. Inside #dcViews it would break the "5 buttons" count above
    // (that locator is an unqualified `#dcViews button`); inside #dcPlayer it would vanish the
    // moment dc-multi.js hides that row after migrating its controls into the settings panel.
    await expect(page.locator('#dcRenderer')).toHaveCount(1);
    await expect(page.locator('#dcViews #dcRenderer')).toHaveCount(0);
    await expect(page.locator('#dcPlayer #dcRenderer')).toHaveCount(0);
    await expect(page.locator('#dcRenderer')).toHaveAttribute('type', 'button');
  });

  test('#dcPresence indicator exists', async ({ page }) => {
    await expect(page.locator('#dcPresence')).toHaveCount(1);
    await expect(page.locator('#dcPresenceDot')).toHaveCount(1);
    await expect(page.locator('#dcPresenceCount')).toHaveCount(1);
  });

  test('#dcInfo panel exists and is hidden', async ({ page }) => {
    await expect(page.locator('#dcInfo')).toHaveCount(1);
    const display = await page.evaluate(() => {
      const el = document.querySelector('#dcInfo');
      return el ? getComputedStyle(el).display : 'not-found';
    });
    expect(display).toBe('none');
  });

  test('#dcLoading overlay exists', async ({ page }) => {
    await expect(page.locator('#dcLoading')).toHaveCount(1);
  });

  test('#blocker and #instructions exist', async ({ page }) => {
    await expect(page.locator('#blocker')).toHaveCount(1);
    await expect(page.locator('#instructions')).toHaveCount(1);
  });

  test('#dcChar select exists (hidden)', async ({ page }) => {
    const charSelect = page.locator('#dcChar');
    await expect(charSelect).toHaveCount(1);
    const display = await charSelect.evaluate((el: Element) => getComputedStyle(el).display);
    expect(display).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Group 2: CSS Styling (verify computed styles)
// ---------------------------------------------------------------------------
test.describe('Group 2: CSS Styling', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
  });

  test('#dcSearch has correct positioning', async ({ page }) => {
    const searchInput = page.locator('#dcSearch');
    const box = await searchInput.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(100);  // left position > 100px
    expect(box!.y).toBeLessThan(50);       // top position < 50px
  });

  test('#dcViews is centered at bottom', async ({ page }) => {
    const views = page.locator('#dcViews');
    const box = await views.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(400);  // bottom of viewport
  });

  test('#dcLocations is on the left side', async ({ page }) => {
    const locations = page.locator('#dcLocations');
    const box = await locations.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeLessThan(50);  // left side
  });
});

// ---------------------------------------------------------------------------
// Group 3: Input Functionality (no WebGL required)
// ---------------------------------------------------------------------------
test.describe('Group 3: Input Functionality', () => {
  // Booted hermetically (see bootHermetic). These are HUD-level tests, but the HUD sits under
  // #dcLoading until loadDatacenter() resolves, and unstubbed that never happens (403) — so the click
  // below failed with "#dcLoading intercepts pointer events" no matter how long it waited, while the
  // fill/clear pair lost its budget to the character-asset storm. Neither is what this group is about.
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
  });

  test('dcSearch accepts text input', async ({ page }) => {
    const searchInput = page.locator('#dcSearch');
    await searchInput.fill('test-server-01');
    const value = await searchInput.inputValue();
    expect(value).toBe('test-server-01');
  });

  test('dcSearch can be cleared', async ({ page }) => {
    const searchInput = page.locator('#dcSearch');
    await searchInput.fill('test-server-01');
    await searchInput.clear();
    const value = await searchInput.inputValue();
    expect(value).toBe('');
  });

  test('#dcViews button click changes active state', async ({ page }) => {
    // A real click, not dispatchEvent: hit-testing the button is half of what this test is worth,
    // and it only becomes hittable once the loading curtain lifts.
    await waitForSceneLoaded(page);

    // Click a view button
    const aisleBtn = page.locator('#dcViews button[data-view="aisle"]');
    await aisleBtn.click();
    await page.waitForTimeout(200);

    // Button should have active class or visual change
    const hasActiveClass = await aisleBtn.evaluate((el: Element) => el.classList.contains('active'));
    expect(hasActiveClass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 4: WebSocket/Presence Globals (defensive - may not connect)
// ---------------------------------------------------------------------------
test.describe('Group 4: WebSocket/Presence Globals', () => {
  // The hub stub is what these assertions were always really about: the globals dc-ws.js/dc-presence.js
  // publish have to exist whether or not a socket ever opened. Booting bare left that to whether an
  // outbound wss://…:7272 happened to fail, which is not a test.
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
  });

  test('DC_WS global exists (may be null if not connected)', async ({ page }) => {
    const dcWsExists = await page.evaluate(() => (window as any).DC_WS !== undefined);
    expect(dcWsExists).toBe(true);
  });

  test('DC_AUTHED is a boolean', async ({ page }) => {
    // Wait a bit for initialization
    await page.waitForTimeout(1000);
    const authed = await page.evaluate(() => typeof (window as any).DC_AUTHED === 'boolean');
    expect(authed).toBe(true);
  });

  test('DC_PRESENCE_SEND is a function when DC_WS exists', async ({ page }) => {
    await page.waitForTimeout(1000);
    const hasSend = await page.evaluate(() => {
      const ws = (window as any).DC_WS;
      return ws !== undefined && typeof (window as any).DC_PRESENCE_SEND === 'function';
    });
    expect(hasSend).toBe(true);
  });

  test('DC_PRESENCE global exists when authenticated', async ({ page }) => {
    await page.waitForTimeout(1000);
    // DC_PRESENCE may be null if not authenticated
    const hasPresence = await page.evaluate(() => (window as any).DC_PRESENCE !== undefined);
    expect(hasPresence).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 5: DCM Debug Interface (requires full scene initialization)
//
// Booted hermetically (see bootHermetic), which is what makes "requires full scene initialization"
// affordable. Before that these waited on networkidle — unreachable while the fixture server is
// still dribbling out a random character's animation set — so every test in the group burned its
// whole budget in beforeEach and none of the assertions below ever ran.
//
// The readiness gate is window.DCM, not DCM.state: the global is assigned as one object at the end
// of dc-multi.js's bootstrap, so waiting on any one of its members is waiting on all of them, and
// gating on a member is how a missing member turned into six timeouts instead of one failure.
// ---------------------------------------------------------------------------
test.describe('Group 5: DCM Debug Interface', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
    await waitForDCM(page);
  });

  test('DCM global is exposed when scene is ready', async ({ page }) => {
    const hasDCM = await page.evaluate(() => (window as any).DCM !== undefined);
    expect(hasDCM).toBe(true);
  });

  test('DCM.state has expected properties', async ({ page }) => {
    const state = await page.evaluate(() => (window as any).DCM?.state);
    expect(state).toBeTruthy();
    expect(state.mode).toMatch(/^(first|third)$/);
    expect(typeof state.vy).toBe('number');
    expect(typeof state.facing).toBe('number');
    expect(typeof state.camDist).toBe('number');
  });

  test('DCM.setMode function exists', async ({ page }) => {
    const hasSetMode = await page.evaluate(() => typeof (window as any).DCM?.setMode === 'function');
    expect(hasSetMode).toBe(true);
  });

  test('DCM.toggleMode function exists', async ({ page }) => {
    const hasToggle = await page.evaluate(() => typeof (window as any).DCM?.toggleMode === 'function');
    expect(hasToggle).toBe(true);
  });

  test('V key toggles mode', async ({ page }) => {
    const initialMode = await page.evaluate(() => (window as any).DCM?.state?.mode);
    await page.keyboard.press('v');
    await page.waitForTimeout(300);
    const toggledMode = await page.evaluate(() => (window as any).DCM?.state?.mode);
    expect(toggledMode).not.toBe(initialMode);
  });

  test('R key triggers respawn', async ({ page }) => {
    // Collect any errors during respawn
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    // Press R to respawn
    await page.keyboard.press('r');
    await page.waitForTimeout(300);

    // Should not cause any JS errors
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Group 6: DC Options (requires scene init)
//
// Hermetic for the same reason as Group 5. WASD is wired by attachKeyHandlers() on the last line of
// displayDatacenter(), so DC.options existing is NOT enough to press a key against — waitForSceneLoaded
// is the gate that says the fetch chain got that far.
// ---------------------------------------------------------------------------
test.describe('Group 6: DC Options', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
    await waitForSceneLoaded(page);
  });

  test('DC.options exists with movement flags', async ({ page }) => {
    const options = await page.evaluate(() => (window as any).DC?.options);
    expect(options).toBeTruthy();
    expect(typeof options.moveForward).toBe('boolean');
    expect(typeof options.moveBackward).toBe('boolean');
    expect(typeof options.moveLeft).toBe('boolean');
    expect(typeof options.moveRight).toBe('boolean');
  });

  test('WASD keys modify movement flags', async ({ page }) => {
    // Initial state should be false
    const initial = await page.evaluate(() => ({
      forward: (window as any).DC?.options?.moveForward,
      backward: (window as any).DC?.options?.moveBackward,
      left: (window as any).DC?.options?.moveLeft,
      right: (window as any).DC?.options?.moveRight,
    }));
    expect(initial.forward).toBe(false);

    // Press W
    await page.keyboard.down('w');
    await page.waitForTimeout(100);
    const pressed = await page.evaluate(() => (window as any).DC?.options?.moveForward);
    expect(pressed).toBe(true);
    await page.keyboard.up('w');

    const released = await page.evaluate(() => (window as any).DC?.options?.moveForward);
    expect(released).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 7: WebGL Availability Check
// ---------------------------------------------------------------------------
test.describe('Group 7: WebGL Availability', () => {
  test.beforeEach(() => {
    test.setTimeout(150000);
  });

  test('WebGL context can be created', async ({ page }) => {
    await bootHermetic(page);
    const webglAvailable = await page.evaluate(() => {
      try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        return !!gl;
      } catch {
        return false;
      }
    });
    // Log result but don't fail - SwiftShader may not support WebGL
    console.log('WebGL available:', webglAvailable);
  });

  // Run for both renderer modes: a broken import map or a three.webgpu.js that fails to parse
  // shows up here as a module error and nowhere else.
  //
  // That claim used to be false, and it cost two days. This test registered only
  // page.on('pageerror'), but a module script that fails to LOAD fires an `error` event on the
  // <script> element — it never reaches window.onerror, so pageerror sees nothing. When the
  // import map pointed three-mesh-bvh at a .cjs served as application/node, the browser
  // rejected it, dc.js never evaluated, window.DC was never created, zero canvases rendered —
  // and this test passed. See dc_remediation_plan.md step R1.6.
  //
  // Two changes make it able to fail: console errors and failed requests are collected too,
  // and the test now asserts on the PRODUCT (window.DC exists, a canvas exists) rather than
  // only on the absence of a particular log line.
  for (const { label, url } of RENDERER_MODES) {
    test(`[${label}] no critical JS errors on page load`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()}`));

      await bootHermetic(page, url);
      await page.waitForTimeout(3000);  // Wait for any async initialization

      // The scene must actually exist. These two assertions are the whole point of the test:
      // an error-free page that rendered nothing is not a passing page.
      expect(await page.evaluate(() => typeof (window as any).DC)).toBe('object');
      expect(await page.locator('canvas').count()).toBeGreaterThan(0);

      // Filter out known non-critical errors. NOTE: a MIME rejection mentions neither WebGL
      // nor GPU nor "context", so it is NOT filtered here — that is deliberate. Do not widen
      // this allowlist to make a red test green; widen it only for a failure you have
      // diagnosed and decided to tolerate.
      const criticalErrors = errors.filter(
        (e) =>
          !e.includes('WebGL') &&
          !e.includes('GPU') &&
          !e.includes('context') &&
          !e.includes('Failed to load resource') &&
          !e.includes('requestfailed:')   // hermetic stubs 404 assets by design
      );

      if (criticalErrors.length > 0) {
        console.log('Critical errors found:', criticalErrors);
      }
      expect(criticalErrors).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Group 8: Hub unreachable — OWNER REQUIREMENT #1 in a real browser
//
//   "The scene must work fully when the WebSocket server is unreachable, just
//    without multi-user."
//
// Hermetic by construction — see bootHermetic at the top of this file for what is
// stubbed and why. The only thing this group adds is WHICH kind of dead hub.
//
// The Vitest specs (tests/js/dc-offline.test.js) are the real gate for this
// behaviour; this group is the in-browser confirmation, so keep its assertions on
// the HUD and input handling — what a dead hub can actually affect — rather than
// on scene assets, which have nothing to do with the socket either way.
// ---------------------------------------------------------------------------
test.describe('Group 8: Hub unreachable (scene must still work)', () => {
  async function bootWithDeadHub(page: any, mode: 'throw' | 'close') {
    await bootHermetic(page, '/admin/dc.html', mode);
    // dc-ws.js is a module script; under fixture contention it can arrive well after
    // domcontentloaded. Wait for it to have run so the assertions below have a base.
    await page
      .waitForFunction(() => 'DC_WS' in window, { timeout: 90000 })
      .catch(() => { /* asserted per-test below */ });
  }

  // The single-threaded `php -S` fixture serialises every request, so under full-suite
  // contention even a hermetic page load is slow. Give each test a generous budget so
  // contention shows up as slowness, not as a false regression.
  test.beforeEach(() => {
    test.setTimeout(150000);
  });

  test('the WebSocket stub really intercepted the hub connection', async ({ page }) => {
    // Guard: without this the whole group could pass while quietly talking to the
    // real hub, or while never attempting a connection at all.
    await bootWithDeadHub(page, 'throw');
    await page.waitForFunction(() => (window as any).__wsAttempts > 0, { timeout: 30000 });
    const attempts = await page.evaluate(() => (window as any).__wsAttempts);
    const url = await page.evaluate(() => (window as any).__wsUrl);
    expect(attempts).toBeGreaterThan(0);
    expect(url).toContain('7272');
  });

  for (const mode of ['throw', 'close'] as const) {
    test(`[${mode}] the scene still initialises`, async ({ page }) => {
      await bootWithDeadHub(page, mode);
      const ready = await page
        .waitForFunction(() => (window as any).DC && (window as any).DC.scene, { timeout: 60000 })
        .then(() => true)
        .catch(() => false);
      expect(ready).toBe(true);
      const hasOptions = await page.evaluate(() => !!(window as any).DC?.options);
      expect(hasOptions).toBe(true);
      const renderer = await page.evaluate(() => !!(window as any).DC?.renderer);
      expect(renderer).toBe(true);
    });

    test(`[${mode}] multiplayer is disabled and the badge says so`, async ({ page }) => {
      await bootWithDeadHub(page, mode);
      const offline = await page
        .waitForFunction(() => (window as any).DC_PRESENCE_ENABLED === false, { timeout: 60000 })
        .then(() => true)
        .catch(() => false);
      expect(offline).toBe(true);

      await expect(page.locator('#dcPresence')).toHaveCount(1);
      // The dot must NOT be green/live with no hub.
      const active = await page.evaluate(() =>
        document.getElementById('dcPresenceDot')?.classList.contains('active')
      );
      expect(active).toBe(false);
      const label = await page.locator('#dcPresenceLabel').textContent();
      expect(label).toMatch(/Offline|Connecting|Users/);
    });

    test(`[${mode}] the page stays interactive`, async ({ page }) => {
      test.setTimeout(120000);
      await bootWithDeadHub(page, mode);
      await page.waitForFunction(() => (window as any).DC?.options, { timeout: 60000 });

      // Search still accepts input — pure markup, always available.
      await page.locator('#dcSearch').fill('web123');
      await expect(page.locator('#dcSearch')).toHaveValue('web123');

      // View buttons still respond. dispatchEvent rather than click(): the
      // pointer-lock #blocker overlay legitimately covers the viewport until the
      // user clicks into the scene, and this test is about the page's own handlers
      // still being alive with no hub, not about overlay hit-testing.
      await page.locator('#dcViews button[data-view="top"]').dispatchEvent('click');
      await expect(page.locator('#dcViews button[data-view="top"]')).toHaveClass(/active/);

      // The HUD panels still open and close.
      await page.locator('#dcSearch').fill('');
      await expect(page.locator('#dcSearch')).toHaveValue('');
      await expect(page.locator('#dcPresence')).toBeVisible();

      // NOTE: keyboard movement is deliberately NOT asserted here. WASD handling is attached by
      // attachKeyHandlers() inside displayDatacenter(), which is downstream of the datacenter fetch
      // rather than of the hub — so it is Group 6's subject, not this group's. Group 6 covers keyboard
      // movement, and tests/js/dc-offline.test.js covers scene liveness with a dead hub.
    });

    test(`[${mode}] no unhandled JS errors from the dead hub`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      await bootWithDeadHub(page, mode);
      await page.waitForTimeout(4000);

      // The stub's own synthetic throw is expected; anything else is not. Asset and
      // WebGL noise is filtered for the same reason as Group 7.
      const critical = errors.filter(
        (e) =>
          !e.includes('E2E:') &&
          !e.includes('WebGL') &&
          !e.includes('GPU') &&
          !e.includes('context') &&
          !e.includes('Failed to load resource') &&
          !e.includes('Failed to fetch')
      );
      if (critical.length > 0) console.log('Critical errors found:', critical);
      expect(critical).toHaveLength(0);
    });

    test(`[${mode}] presence entry points are safe no-ops`, async ({ page }) => {
      await bootWithDeadHub(page, mode);
      await page.waitForFunction(() => typeof (window as any).DC_PRESENCE_JOIN === 'function', { timeout: 60000 });
      const threw = await page.evaluate(() => {
        try {
          (window as any).DC_PRESENCE_JOIN(10, 20, 0.5);
          for (let i = 0; i < 30; i++) (window as any).DC_PRESENCE_MOVE(i, i, 0);
          (window as any).DC_PRESENCE_LEAVE();
          return null;
        } catch (e: any) {
          return String(e && e.message);
        }
      });
      expect(threw).toBeNull();
    });
  }

  test('[close] the reconnect loop is bounded, not an endless 3s storm', async ({ page }) => {
    // Deliberately watches real wall-clock backoff, so it needs longer than the
    // 30s default.
    test.setTimeout(120000);
    // Regression guard for the live reconnect storm: dc.html loaded directly has an
    // empty DC_SESSION_ID, so every cycle used to re-open, reset the counters and
    // retry at a flat 3s forever. maxReconnectAttempts is 10, so the attempt count
    // must stay bounded well under a runaway loop.
    await bootWithDeadHub(page, 'close');
    await page.waitForFunction(() => (window as any).DC_PRESENCE_ENABLED === false, { timeout: 60000 });
    const first = await page.evaluate(() => (window as any).__wsAttempts);
    await page.waitForTimeout(10000);
    const second = await page.evaluate(() => (window as any).__wsAttempts);
    expect(second).toBeLessThanOrEqual(12);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Group 9: Renderer modes — the same scene smoke, once per ?renderer= value
//
// The import map that decides which build of three.js loads is written by an inline classic
// script during parse (dc.html, top of <head>). tests/js/dc-renderer-mode.test.js proves that
// script writes the right map; this group is the half it cannot cover — that the map the browser
// actually applies produces a renderer the scene can boot on.
//
// Booted hermetically, exactly like Group 8: the hub is stubbed so no WSS connection is attempted
// and /ajax/datacenter.php is stubbed so the room builds without the DB (.claude/rules/js-tests.md).
// ---------------------------------------------------------------------------
test.describe('Group 9: Renderer modes', () => {
  const boot = (page: any, url: string) => bootHermetic(page, url, 'dead');

  test.beforeEach(() => {
    // three.webgpu.js is a 2 MB unminified dev build off the same fixture server; give the boot
    // the same generous budget Group 8 uses so contention reads as slowness, not as a regression.
    test.setTimeout(150000);
  });

  for (const { label, url, mode, build } of RENDERER_MODES) {
    test(`[${label}] the mode script sets DC_RENDERER_MODE and maps the matching build`, async ({ page }) => {
      await boot(page, url);

      const applied = await page.evaluate(() => {
        const el = document.querySelector('script[type="importmap"]');
        return {
          mode: (window as any).DC_RENDERER_MODE,
          maps: document.querySelectorAll('script[type="importmap"]').length,
          imports: el ? JSON.parse(el.textContent || '{}').imports : null,
        };
      });

      expect(applied.mode).toBe(mode);
      // A second map would be ignored by the browser, which is the silent-wrong-build failure.
      expect(applied.maps).toBe(1);
      expect(applied.imports.three).toContain(build);
      expect(applied.imports['three/addons/']).toBe('/lib/three/examples/jsm/');
      if (mode === 'webgl') {
        expect(applied.imports['three/webgpu']).toBeUndefined();
        expect(applied.imports['three/tsl']).toBeUndefined();
      } else {
        expect(applied.imports['three/webgpu']).toBe(applied.imports.three);
        expect(applied.imports['three/tsl']).toContain('three.tsl.js');
      }
    });

    test(`[${label}] the scene boots and reports the backend it really got`, async ({ page }) => {
      await boot(page, url);

      const ready = await waitForRendererSettled(page)
        .then(() => true)
        .catch(() => false);
      expect(ready).toBe(true);

      const backend = await page.evaluate(() => (window as any).DC.backendName);
      // Logged rather than pinned to one value: what you get depends on the machine. Here it is
      // 'webgl' for the default build and 'webgl2-fallback' for the node build under SwiftShader,
      // but the same spec on a WebGPU-capable host reports 'webgpu' and must still pass.
      console.log(`[${label}] DC.backendName = ${backend}`);
      expect(['webgl', 'webgpu', 'webgl2-fallback']).toContain(backend);
      if (mode === 'webgl') {
        expect(backend).toBe('webgl');
      } else {
        // The node renderer always exposes a backend; the classic one has none.
        expect(['webgpu', 'webgl2-fallback']).toContain(backend);
      }

      const scene = await page.evaluate(() => !!(window as any).DC.scene);
      expect(scene).toBe(true);
    });

    test(`[${label}] the switch button labels itself and survives #dcPlayer being hidden`, async ({ page }) => {
      await boot(page, url);
      // Settle, not construction. DC.renderer is truthy from `new WebGPURenderer(...)` onward, but the
      // label this test is about is written by _setupRendererSwitch(), which dc.js only calls after
      // `await renderer.init()` — a real device acquisition in webgpu mode. Gating on DC.renderer alone
      // left the assertions below racing that await with their default 5s expect timeout, and headlessly the
      // device sometimes lost: the button was still empty, and #dcRenderer:empty is display:none, so
      // toBeVisible() read 'hidden'. waitForRendererSettled() waits for the label itself, which is the
      // documented "the switch has been set up" signal (see the helper). Nothing is weakened — if dc.js
      // never labels the button this now fails in the wait instead of the assertion.
      await waitForRendererSettled(page);

      const btn = page.locator('#dcRenderer');
      // #dcRenderer:empty is display:none, so a visible button also proves dc.js labelled it.
      await expect(btn).toBeVisible();
      await expect(btn).toHaveText(/⇄/);

      // dc-multi.js:883 does exactly this once the character manifest lands and its controls have
      // migrated into the settings panel. Done by hand rather than waited for, because the manifest
      // needs assets the fixture server cannot deliver — the regression being pinned is the button
      // being adopted back into that container, and this catches it either way.
      await page.evaluate(() => {
        const pl = document.getElementById('dcPlayer');
        if (pl) pl.style.display = 'none';
      });
      await expect(page.locator('#dcPlayer')).toBeHidden();
      await expect(btn).toBeVisible();
    });
  }
});

// ---------------------------------------------------------------------------
// Group 10: Performance regression guard
//
// DC.bench(seconds) sweeps the IDLE_VIEWS camera presets for `seconds` seconds and returns
// { backend, drawCalls, triangles, avgFps, minFps, samples, ao, shadows, shadowMapSize,
//   pixelScale }.
// NOTE the units and field names — an earlier version of this comment said "frames" and
// "fps", and the annotation below logged `undefined` as a result.
//
// WHAT CI ACTUALLY RENDERS: public_html/images/3d is gitignored, so in CI every rack and
// server GLB 404s. bootHermetic() additionally stubs the manifest to 404, so there are no
// character assets either. This benchmarks the ROOM SHELL ONLY — no racks, no servers, no
// avatars. A production room with full assets will be far heavier; these thresholds cannot
// speak to it, and must not be quoted as if they can.
//
// THRESHOLDS: derived from a measured run, not invented. See the Baseline measurements
// section of docs/dc_renderer_modes.md for the numbers and the date. The previous ceilings
// (400 / 2,000,000) were the plan's own placeholder values — roughly 32x the real triangle
// count — and could not have caught any plausible regression.
//
// Uses continue-on-error: false in CI so a regression here BLOCKS the PR.
// ---------------------------------------------------------------------------
// Measured 2026-08-03 on the CI-equivalent stub room (chromium + SwiftShader, no 3D assets):
//   drawCalls = 166, triangles = 65,898
// Ceilings are ~1.5x those figures. Re-measure and re-derive if the stub room changes.
//
// RE-MEASURED the same day, after R2.1 and the tier-aware fixture. The first reading was
// 108 / 62,418, taken while buildCommunity() was placing NO neighbours — the community layout
// was broken and the stub served one location to both tiers. Both of those are now fixed, so
// the room legitimately contains two neighbour buildings' shells and block proxies. The
// increase is the feature working, not a regression; the old numbers described a scene the
// product never intends to render.
//
// avgFps/minFps are deliberately NOT asserted: under SwiftShader the bench returns
// samples=0 and avgFps=null, so an FPS assertion would either be vacuous or flaky. Frame
// rate needs a real GPU to mean anything — see docs/dc_renderer_modes.md.
const PERF_BUDGET = { drawCalls: 250, triangles: 99000 };

test.describe('Group 10: Performance regression', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(300000);
    await bootHermetic(page);
    await waitForSceneLoaded(page);
  });

  test('DC.bench(10) stays within the measured render budget', async ({ page }) => {
    const result = await page.evaluate(async () => (window as any).DC.bench(10));

    // Printed, not just annotated: the annotation is invisible under the default reporter,
    // which is why nobody noticed it was logging undefined.
    console.log('[perf] ' + JSON.stringify(result));
    test.info().annotations.push({
      type: 'performance',
      description: `backend=${result.backend} drawCalls=${result.drawCalls} `
        + `triangles=${result.triangles} avgFps=${result.avgFps} minFps=${result.minFps} `
        + `samples=${result.samples}`,
    });

    // Ceilings are ~1.5x the measured baseline — tight enough to catch a real regression,
    // loose enough to absorb run-to-run jitter. Re-derive them if the stub room changes.
    expect(result.drawCalls).toBeLessThan(PERF_BUDGET.drawCalls);
    expect(result.triangles).toBeLessThan(PERF_BUDGET.triangles);
  });
});

// ---------------------------------------------------------------------------
// Group 11: The community layout — neighbour buildings and LOD (R2.1)
//
// This group exists because a regression that removed EVERY neighbour building, every block
// proxy, every neighbour door and the entire LOD system went unnoticed through a full plan: the
// features are only reachable once two or more locations are placed, and the old fixture served
// one. The assertions below are deliberately about counts and reachability rather than pixels —
// what broke was a filter predicate returning an empty list, and a length is exactly the shape of
// that failure.
// ---------------------------------------------------------------------------
test.describe('Group 11: Community layout and LOD', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
    await waitForSceneLoaded(page);
  });

  test('every OTHER location in the index tier gets a neighbour building', async ({ page }) => {
    // The index stub places 4, 7 and 9; only 4 is ever returned in full. lodBuildings holds
    // neighbours only — dc.js skips options.location, because that one is the real room you are
    // standing in — so 7 and 9 are the expected entries. The regression made this list empty.
    const lod = await page.evaluate(() => (window as any).DC.lodState());
    expect(Array.isArray(lod)).toBe(true);
    const ids = lod.map((b: any) => b.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([7, 9]);
  });

  test('neighbours are placed from index data alone, without their inventory', async ({ page }) => {
    // The point of the two-tier fetch: a neighbour needs a footprint to sit on the street, not a
    // server list. 7 and 9 are never returned in full by the stub, so if placement required
    // inventory there would be nothing here at all.
    const lod = await page.evaluate(() => (window as any).DC.lodState());
    expect(lod).toHaveLength(2);
    // Nothing has forced them to full detail — they are across the street and have no inventory.
    expect(lod.filter((b: any) => b.full)).toHaveLength(0);
  });

  test('updateLOD() runs instead of returning at its first line', async ({ page }) => {
    // lodState() reports the per-neighbour distance updateLOD() writes each frame. A finite
    // distance on every entry proves the loop body executed; the regression left lodBuildings
    // empty, so updateLOD() bailed on `!lodBuildings.length` forever.
    const dists = await page.evaluate(() => (window as any).DC.lodState().map((b: any) => b.dist));
    expect(dists).toHaveLength(2);
    for (const d of dists) expect(Number.isFinite(d)).toBe(true);
  });

  test('the location switcher lists every indexed location', async ({ page }) => {
    // buildLocationButtons() renders from locationNames, which the index tier fills. A location
    // that merges without a name is a button that never appears.
    await expect(page.locator('#dcLocations button')).toHaveCount(3);
  });
});

// ---------------------------------------------------------------------------
// Group 12: The info panel's action buttons (R2.6)
//
// Every user-facing deliverable of Phase 9 was unreachable in a browser while its unit tests
// passed, because those tests matched source text and the source text was there. Copy Link threw
// ReferenceError on click (dc.js is a module, so an inline onclick resolves in global scope);
// Trace Cable never rendered at all (the port index was keyed by number, looked up by string).
// These exercise the panel the way a user does: click the button, look at what happened.
//
// showInfo() takes a hit object, so these synthesise one rather than depending on a raycast
// against 3D models — public_html/images/3d is gitignored, so in CI there are no rack or server
// meshes to click on at all.
// ---------------------------------------------------------------------------
test.describe('Group 12: Info panel actions', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(150000);
    await bootHermetic(page);
    await waitForSceneLoaded(page);
  });

  /** Open the panel for stub server 110, which the stub switch has a port for. */
  const openServerPanel = (page: any, hostname = 'web10.test') => page.evaluate((h: string) => {
    (window as any).DC.info({
      mesh: { userData: {} }, instanceId: 0, kind: 'server',
      asset: { id: '110', hostname: h, status: 'active', start: 1, size: 1, make: 'Dell', model: 'R640' },
    });
  }, hostname);

  test('Copy Link writes a deep link that names the asset', async ({ page }) => {
    await openServerPanel(page);
    const copied = await page.evaluate(async () => {
      const w = window as any;
      w.__clip = null;
      navigator.clipboard.writeText = (t: string) => { w.__clip = t; return Promise.resolve(); };
      document.querySelector<HTMLButtonElement>('#dcInfo .dc-info-copy')!.click();
      await new Promise((r) => setTimeout(r, 30));
      return w.__clip;
    });
    expect(copied, 'Copy Link wrote nothing — the click handler did not run').not.toBeNull();
    const url = new URL(copied);
    expect(url.searchParams.get('asset')).toBe('110');
    expect(url.searchParams.get('location')).toBe('4');
    // No bare ?rack= — that was what the broken rackKey lookup produced.
    expect(url.searchParams.get('rack')).toBeNull();
  });

  test('Trace Cable appears for an asset that has a switch port', async ({ page }) => {
    // The port index key type in one assertion: the stub's port carries `asset: 110` (a number)
    // and the panel looks up '110' (a string).
    await openServerPanel(page);
    await expect(page.locator('#dcInfo .dc-info-trace')).toHaveCount(1);
  });

  test('Trace Cable does not appear for an asset with no connections', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).DC.info({
        mesh: { userData: {} }, instanceId: 0, kind: 'server',
        asset: { id: '999', hostname: 'unconnected.test', status: 'active', start: 1, size: 1 },
      });
    });
    await expect(page.locator('#dcInfo .dc-info-trace')).toHaveCount(0);
  });

  test('clicking Trace Cable does not throw', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openServerPanel(page);
    await page.locator('#dcInfo .dc-info-trace').click();
    await page.waitForTimeout(100);
    expect(errors).toEqual([]);
  });

  test('the close button hides the panel', async ({ page }) => {
    await openServerPanel(page);
    await expect(page.locator('#dcInfo')).toBeVisible();
    await page.locator('#dcInfo .dc-info-close').click();
    await expect(page.locator('#dcInfo')).toBeHidden();
  });

  test('a hostile hostname is rendered as text, never as markup', async ({ page }) => {
    // The XSS test the original plan called "the important one" and which was never written.
    // Hostnames come from the assets table; anyone who can name a server can reach this sink.
    await openServerPanel(page, '<img src=x onerror="window.__pwned=1">');
    const out = await page.evaluate(() => ({
      imgs: document.querySelectorAll('#dcInfo img').length,
      title: document.querySelector('#dcInfo .dc-info-title')!.textContent,
      pwned: !!(window as any).__pwned,
    }));
    expect(out.imgs).toBe(0);
    expect(out.pwned).toBe(false);
    expect(out.title).toBe('<img src=x onerror="window.__pwned=1">');
  });

  test('the action buttons are styled, not raw UA buttons', async ({ page }) => {
    // They had no CSS at all and rendered as grey system buttons on a dark translucent panel.
    await openServerPanel(page);
    const style = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('#dcInfo .dc-info-copy')!);
      return { border: cs.borderTopStyle + ' ' + cs.borderTopWidth, cursor: cs.cursor };
    });
    expect(style.border).toBe('solid 1px');
    expect(style.cursor).toBe('pointer');
  });

  test('DC.setIsolate dims the scene and clearIsolate restores it exactly', async ({ page }) => {
    // Both isolate defects at once: the pass used to skip every opaque material (so nothing
    // dimmed), and saved state keyed by object id corrupted shared materials permanently.
    const out = await page.evaluate(() => {
      const dc = (window as any).DC;
      const before: any[] = [];
      dc.scene.traverse((o: any) => {
        if (o.isMesh && o.material && !Array.isArray(o.material)) {
          before.push([o.material, o.material.opacity, o.material.transparent, o.material.depthWrite]);
        }
      });
      dc.setIsolate(new Set([dc.scene.children[0].id]));
      let dimmed = 0;
      dc.scene.traverse((o: any) => {
        if (o.isMesh && o.material && !Array.isArray(o.material) && o.material.opacity === 0.3) dimmed++;
      });
      dc.clearIsolate();
      const exact = before.every(([m, op, tr, dw]) => m.opacity === op && m.transparent === tr && m.depthWrite === dw);
      return { total: before.length, dimmed, restoredExactly: exact };
    });
    expect(out.total).toBeGreaterThan(0);
    expect(out.dimmed).toBeGreaterThan(0);
    expect(out.restoredExactly).toBe(true);
  });

  test('DC.setIsolate(null) clears instead of throwing', async ({ page }) => {
    const threw = await page.evaluate(() => {
      try { (window as any).DC.setIsolate(null); return false; } catch (e) { return true; }
    });
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group 13: Ambient occlusion — the post-processing chain on BOTH backends (R3.7)
//
// Step 7.3 built a real EffectComposer + GTAOPass chain on the classic path. Step 7.4 was supposed
// to build the node-renderer equivalent and instead shipped `_postProcessing = { ao, ready: true }`
// — the imported TSL function stored in an object, with no pipeline, no pass and no output node.
// The render branch that consumed it was byte-identical to the plain `else`, and was unreachable
// anyway because `supportsTSL` was false at the time. Nothing failed; nothing rendered either.
//
// The only way to tell a real post-processing chain from a stub is to look at the pixels, so that
// is what this group does: same frozen camera, AO off, AO on, compare. Two things had to be dealt
// with before that comparison meant anything —
//
//   1. The idle-view demo cycles the camera through five presets and flies between them. Its
//      motion swamps any image measurement, so #blocker is hidden, which makes
//      maybeCycleIdleView() bail on its own guard.
//   2. The auto-quality scaler now drops AO as its FIRST downgrade tier. SwiftShader is far below
//      FPS_TARGET, so AO was being switched off within one tick of being switched on and the two
//      captures came out byte-identical — a green test proving nothing. DC.setAutoQuality(false)
//      pins the tiers; DC.postFX().suspendedByScaler confirms it held.
//
// Occlusion can only ever darken, so mean luminance is asserted to FALL. That is the direction of
// effect a byte-length diff cannot give: noise, a broken colour channel or a black frame all change
// the bytes too. The first working draft of the node path multiplied the colour by the whole AO
// texel — GTAONode's target is RedFormat, so g and b are zero — and rendered the scene dark red.
// It changed every byte. It also dropped mean luma by 118 of 255, which is what this bound catches.
// ---------------------------------------------------------------------------
const AO_MODES = [
  { label: 'webgl (EffectComposer/GTAOPass)', url: '/admin/dc.html', mode: 'webgl' },
  { label: 'node (TSL GTAONode)', url: '/admin/dc.html?renderer=webgpu', mode: 'node' },
] as const;

/** Freeze the scene: no demo camera, no quality scaler, and a fixed camera pose. */
async function pinScene(page: any) {
  await page.evaluate(async () => {
    const bl = document.getElementById('blocker');
    if (bl) bl.style.display = 'none';
    const DC: any = (window as any).DC;
    DC.setAutoQuality(false);
    // setTimeout, not requestAnimationFrame. rAF is throttled hard when several SwiftShader pages
    // are live at once — which is exactly what the two Playwright workers produce — and an
    // rAF-driven warm-up loop stalls long past the test timeout. Nothing here needs a real
    // presented frame: tick() renders synchronously, and the one capture that must read the
    // drawing buffer does so immediately after its own tick(), before yielding.
    const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 30; i++) { DC.tick(); await yieldToLoop(); }   // let any in-flight flyTo land
  });
}

/** Render with AO on or off at a fixed camera and return the frame's mean luminance. */
async function captureLuma(page: any, ao: boolean): Promise<number> {
  return page.evaluate(async (wantAo: boolean) => {
    const DC: any = (window as any).DC;
    DC.options.ambientOcclusion = wantAo;
    DC.camera.position.set(0, 12, 40);
    DC.camera.lookAt(0, 8, 0);
    const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 12; i++) { DC.tick(); await yieldToLoop(); }
    DC.camera.position.set(0, 12, 40);
    DC.camera.lookAt(0, 8, 0);
    // No yield between this tick() and the read below: a WebGL drawing buffer is cleared once the
    // frame is presented unless preserveDrawingBuffer is set, so the capture has to happen inside
    // the same synchronous run as the render that produced it.
    DC.tick();
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    const off = document.createElement('canvas');
    off.width = c.width; off.height = c.height;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4 * 17) { sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
    return sum / n;
  }, ao);
}

for (const m of AO_MODES) {
  // Serial with ONE page for the whole block, not a boot per test. Booting the scene under
  // SwiftShader costs the better part of a minute; six boots per backend put this group alone at
  // 16 minutes. Nothing here mutates state another test depends on beyond `ambientOcclusion`,
  // which every test sets for itself.
  test.describe(`Group 13: Ambient occlusion — ${m.label}`, () => {
    test.describe.configure({ mode: 'serial', timeout: 240000 });

    let page: any;
    test.beforeAll(async ({ browser }) => {
      // describe.configure({timeout}) sets the TEST timeout; a beforeAll hook keeps its own
      // 30 s default, and booting this scene under SwiftShader takes longer than that.
      test.setTimeout(240000);
      page = await browser.newPage();
      await bootHermetic(page, m.url);
      await waitForSceneLoaded(page);
      await pinScene(page);
    });
    test.afterAll(async () => { await page?.close(); });

    test('a post-processing pipeline was built for this backend', async () => {
      // 'none' means the dynamic import failed and AO silently does nothing — the state Step 7.4
      // shipped in, except that back then it also logged "initialized".
      const fx = await page.evaluate(() => (window as any).DC.postFX());
      expect(fx.mode).toBe(m.mode);
    });

    test('DC.postFX() reports AO as inactive until it is asked for', async () => {
      const fx = await page.evaluate(() => {
        (window as any).DC.options.ambientOcclusion = false;
        return (window as any).DC.postFX();
      });
      expect(fx.requested).toBe(false);
      expect(fx.active).toBe(false);
    });

    test('DC.postFX().active follows the option once a pipeline exists', async () => {
      const fx = await page.evaluate(() => {
        (window as any).DC.options.ambientOcclusion = true;
        return (window as any).DC.postFX();
      });
      expect(fx.requested).toBe(true);
      expect(fx.active).toBe(true);
    });

    test('switching AO on changes the rendered frame, and darkens it', async () => {
      const plain = await captureLuma(page, false);
      const withAo = await captureLuma(page, true);
      const delta = withAo - plain;
      // Something must have been drawn at all — a black canvas would pass a "they differ" test.
      expect(plain).toBeGreaterThan(20);
      // Occlusion darkens. Lower bound: it must actually do something.
      expect(delta).toBeLessThan(-0.5);
      // Upper bound: and it must not do something catastrophic. -118 was the RedFormat bug.
      expect(delta).toBeGreaterThan(-40);
    });

    test('the scaler did not silently switch AO off during the measurement', async () => {
      // If this ever fails, the test above was comparing two AO-off frames and its "they differ"
      // assertion was measuring frame-to-frame noise.
      await captureLuma(page, true);
      const fx = await page.evaluate(() => (window as any).DC.postFX());
      expect(fx.suspendedByScaler).toBe(false);
      expect(fx.active).toBe(true);
    });

    test('bench() reports AO honestly rather than hardcoding false', async () => {
      // `ao: false` was hardcoded with a comment claiming AO was "not yet implemented", so every
      // bench result claimed AO was off while the composer was rendering — in the one field whose
      // whole purpose is making two runs comparable.
      const out = await page.evaluate(async () => {
        const DC: any = (window as any).DC;
        DC.options.ambientOcclusion = true;
        const on = DC.postFX().active;
        DC.options.ambientOcclusion = false;
        return { on, off: DC.postFX().active };
      });
      expect(out.on).toBe(true);
      expect(out.off).toBe(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Group 14: The auto-quality scaler's AO tier (R3.7)
//
// AO is a full extra screen-resolution pass over depth and normals with a denoise on top — the most
// expensive thing in the frame by a distance, and the first thing a person would switch off. The
// scaler had no AO tier at all, so a page struggling *because of* AO would grind its shadow map and
// pixel scale to the floor and never touch the actual cost.
//
// Running under SwiftShader is what makes this testable without faking anything: the fixture really
// is far below FPS_TARGET, so the downgrade path is the live one.
// ---------------------------------------------------------------------------
test.describe('Group 14: Auto-quality drops ambient occlusion first', () => {
  test.describe.configure({ timeout: 240000 });

  test.beforeEach(async ({ page }) => {
    await bootHermetic(page, '/admin/dc.html');
    await waitForSceneLoaded(page);
  });

  test('AO is dropped, and it is dropped BEFORE any other tier', async ({ page }) => {
    // Sampled at the tick AO is suspended, not at the end of the run. SwiftShader is so far below
    // FPS_TARGET that the scaler keeps walking down the remaining tiers afterwards — by tick 80
    // the shadow map is already at its 512 floor, which says nothing about ordering. What the
    // tier is for is that AO goes first, so the sample has to be taken when it goes.
    const out = await page.evaluate(async () => {
      const DC: any = (window as any).DC;
      const bl = document.getElementById('blocker'); if (bl) bl.style.display = 'none';
      DC.setAutoQuality(true);
      DC.options.ambientOcclusion = true;
      const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));
      // The baseline is whatever the page booted with, NOT the module defaults: dc-multi.js
      // applies a 0.8 pixel scale on load, so asserting `pixelScale === 1` here would be
      // asserting against a state this page never has.
      const before = { shadowMap: DC.quality.shadowMapSize, pixelScale: DC.quality.pixelScale };
      let atDrop = null;
      // FPS_WINDOW is 60, and _autoQualityScale() does nothing until the ring buffer is full.
      for (let i = 0; i < 120; i++) {
        DC.tick();
        if (!atDrop && DC.postFX().suspendedByScaler) {
          atDrop = { shadowMap: DC.quality.shadowMapSize, pixelScale: DC.quality.pixelScale, tick: i };
        }
        await yieldToLoop();
      }
      return { fx: DC.postFX(), before, atDrop };
    });
    expect(out.fx.requested).toBe(false);
    expect(out.fx.suspendedByScaler).toBe(true);
    expect(out.atDrop, 'the scaler never dropped AO at all').not.toBeNull();
    // Nothing cheaper had been touched yet at the moment AO went.
    expect(out.atDrop.shadowMap).toBe(out.before.shadowMap);
    expect(out.atDrop.pixelScale).toBe(out.before.pixelScale);
    // Deliberately NOT asserting which tick it fired on. The FPS ring buffer is filled by the
    // page's own animation loop from the moment it boots, not by this loop, so by the time the
    // evaluate starts it is already full and the scaler acts within a handful of manual ticks.
    // An "at least FPS_WINDOW ticks" assertion would be asserting a fiction about the harness.
  });

  test('setAutoQuality(false) pins AO on, which is what makes Group 13 measurable', async ({ page }) => {
    const out = await page.evaluate(async () => {
      const DC: any = (window as any).DC;
      const bl = document.getElementById('blocker'); if (bl) bl.style.display = 'none';
      DC.setAutoQuality(false);
      DC.options.ambientOcclusion = true;
      const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));
      for (let i = 0; i < 80; i++) { DC.tick(); await yieldToLoop(); }
      return DC.postFX();
    });
    expect(out.requested).toBe(true);
    expect(out.suspendedByScaler).toBe(false);
  });

  test('setAutoQuality reports and reflects the state it was given', async ({ page }) => {
    const out = await page.evaluate(() => {
      const DC: any = (window as any).DC;
      const a = DC.setAutoQuality(false), afterOff = DC.autoQuality;
      const b = DC.setAutoQuality(true), afterOn = DC.autoQuality;
      return { a, afterOff, b, afterOn };
    });
    expect(out).toEqual({ a: false, afterOff: false, b: true, afterOn: true });
  });
});

// ---------------------------------------------------------------------------
// Group 15: a shadow-map resize must not orphan the map on the node renderer
//
// Reported from a real WebGPU session: walking into a building turned the whole scene black, with
//   "In a draw command, kind: Draw, caused by: Texture with 'ShadowDepthTexture' label has been
//    destroyed"
// arriving one line after "[dc] quality down shadowMap -> 1024". The interior build costs enough
// frames to trip the auto-quality scaler, whose first shadow tier halves the map, and
// _applyShadowMapSize() dropped the map the way WebGLShadowMap requires:
//     shadow.map.dispose(); shadow.map = null;
// The node renderer reallocates through the OPPOSITE mechanism. ShadowNode keeps its own reference
// (this.shadowMap, ShadowNode.js:584) and its compiled TSL graph captured that render target's
// depth texture at build time, so nulling the light's copy ORPHANS it rather than clearing it:
// three.js never reallocates, and every draw keeps sampling a destroyed GPUTexture. WebGPU treats
// that as a validation error where WebGL quietly rebinds, which is why only one backend went black.
//
// What CI can and cannot show here. The default project resolves ?renderer=webgpu to the WebGL2
// fallback backend, which does not enforce destroyed-texture use: measured mean luminance was
// 147.77 before and after either way, so asserting on a black frame would be asserting on nothing.
// What IS observable on the fallback is the orphaning itself -- and the orphaning is the defect.
// The last test reproduces the old two lines inline and pins the backend-dependent outcome, so
// these assertions cannot pass vacuously on a renderer that never had the bug.
// ---------------------------------------------------------------------------
const SHADOW_MODES = [
  { label: 'node (ShadowNode)', url: '/admin/dc.html?renderer=webgpu', node: true },
  { label: 'webgl (WebGLShadowMap)', url: '/admin/dc.html', node: false },
] as const;

for (const m of SHADOW_MODES) {
  test.describe(`Group 15: shadow map resize — ${m.label}`, () => {
    // Serial with one page, for the same reason Group 13 is: booting this scene under SwiftShader
    // costs the better part of a minute. The last test deliberately leaves the light's shadow map
    // orphaned on the node path, so it must stay last and the page must not outlive the block.
    test.describe.configure({ mode: 'serial', timeout: 240000 });

    let page: any;
    test.beforeAll(async ({ browser }) => {
      test.setTimeout(240000);
      page = await browser.newPage();
      await bootHermetic(page, m.url);
      await waitForSceneLoaded(page);
      await pinScene(page);
    });
    test.afterAll(async () => { await page?.close(); });

    test('this page really is the renderer the case is about', async () => {
      // isWebGPURenderer, not backendName: ?renderer=webgpu-gl and the CI fallback both report a
      // WebGL backend while running the node path, and the node path is what the fix branches on.
      const isNode = await page.evaluate(() => !!(window as any).DC.renderer.isWebGPURenderer);
      expect(isNode).toBe(m.node);
    });

    test('after a resize the light still owns a live map, at the new size', async () => {
      const out = await page.evaluate(async () => {
        const DC: any = (window as any).DC;
        const y = () => new Promise((r) => setTimeout(r, 0));
        const lights: any[] = [];
        DC.scene.traverse((o: any) => {
          if ((o.isDirectionalLight || o.isSpotLight) && o.shadow) lights.push(o);
        });
        const L = lights[0];
        DC.setShadowMapSize(2048);
        for (let i = 0; i < 8; i++) { DC.tick(); await y(); }
        const beforeRef = L.shadow.map;
        const before = { mapped: !!L.shadow.map, w: L.shadow.map ? L.shadow.map.width : null };
        DC.setShadowMapSize(1024);
        for (let i = 0; i < 8; i++) { DC.tick(); await y(); }
        DC.tick();
        const info = DC.renderer.info.render;
        return {
          lights: lights.length,
          before,
          after: { mapped: !!L.shadow.map, w: L.shadow.map ? L.shadow.map.width : null },
          sameObject: L.shadow.map === beforeRef,
          mapSize: L.shadow.mapSize.width,
          // DC.tick()'s return value is unreliable here: dc-presence.js wraps tick and does not
          // pass the original's value back. Read the renderer's own counter instead.
          drawCalls: info.drawCalls !== undefined ? info.drawCalls : info.calls,
        };
      });
      expect(out.lights).toBeGreaterThan(0);
      expect(out.before).toEqual({ mapped: true, w: 2048 });
      // The invariant that broke: after a resize the light must still own a live render target,
      // and it must be at the size that was asked for.
      expect(out.after).toEqual({ mapped: true, w: 1024 });
      expect(out.mapSize).toBe(1024);
      // Whether it is the SAME object is the mechanism, and it differs by backend. ShadowNode's
      // renderShadow() calls shadowMap.setSize() every pass, so the node path resizes in place and
      // object identity survives -- which is precisely why the map must not be nulled out from
      // under it. WebGLShadowMap allocates a fresh WebGLRenderTarget instead.
      expect(out.sameObject).toBe(m.node);
      // And the scene is still drawing, rather than silently rendering nothing.
      expect(out.drawCalls).toBeGreaterThan(0);
    });

    test('dispose-and-null is what orphaned it, and only on the node path', async () => {
      const out = await page.evaluate(async () => {
        const DC: any = (window as any).DC;
        const y = () => new Promise((r) => setTimeout(r, 0));
        let L: any = null;
        DC.scene.traverse((o: any) => {
          if (!L && (o.isDirectionalLight || o.isSpotLight) && o.shadow) L = o;
        });
        // Exactly the two lines _applyShadowMapSize() used to run for every backend.
        if (L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; }
        for (let i = 0; i < 10; i++) { DC.tick(); await y(); }
        return { recovered: L.shadow.map !== null };
      });
      // WebGLShadowMap allocates `if (shadow.map === null)`, so there nulling IS the supported
      // mechanism and the map comes straight back. ShadowNode never reallocates, which is what
      // left the node path sampling a destroyed texture for the rest of the session. This is also
      // what stops the test above from being vacuous: the two backends disagree, so the assertions
      // are pinned to a real difference rather than to something both paths satisfy anyway.
      expect(out.recovered).toBe(!m.node);
    });
  });
}
