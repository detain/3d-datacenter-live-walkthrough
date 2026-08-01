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
// Helper: wait for DCM state to be available
// ---------------------------------------------------------------------------
async function waitForDCMState(page: any, stateTimeout = 30000): Promise<boolean> {
  return page
    .waitForFunction(() => (window as any).DCM?.state, { timeout: stateTimeout })
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Helper: wait for DC.options to be available
// ---------------------------------------------------------------------------
async function waitForDCOptions(page: any, timeout = 30000): Promise<boolean> {
  return page
    .waitForFunction(() => (window as any).DC?.options, { timeout })
    .then(() => true)
    .catch(() => false);
}

// ---------------------------------------------------------------------------
// Group 1: Static HTML Structure (no JavaScript required)
// ---------------------------------------------------------------------------
test.describe('Group 1: Static HTML Structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/dc.html', { timeout: 120000 });
    await page.waitForLoadState('domcontentloaded');
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
    await page.goto('/admin/dc.html', { timeout: 120000 });
    await page.waitForLoadState('domcontentloaded');
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
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/dc.html', { timeout: 120000 });
    await page.waitForLoadState('domcontentloaded');
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
    // Wait for any JS to initialize
    await page.waitForTimeout(500);

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
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/dc.html', { timeout: 120000 });
    await page.waitForLoadState('domcontentloaded');
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
// These tests may skip if WebGL/scene isn't ready in headless mode
// ---------------------------------------------------------------------------
test.describe('Group 5: DCM Debug Interface', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/dc.html', { timeout: 120000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {
      // Network idle may not be reachable if assets are still loading
    });
  });

  test('DCM global is exposed when scene is ready', async ({ page }) => {
    const DCMReady = await waitForDCMState(page, 30000);
    if (!DCMReady) {
      test.skip();
      return;
    }
    const hasDCM = await page.evaluate(() => (window as any).DCM !== undefined);
    expect(hasDCM).toBe(true);
  });

  test('DCM.state has expected properties', async ({ page }) => {
    const DCMReady = await waitForDCMState(page, 30000);
    if (!DCMReady) {
      test.skip();
      return;
    }

    const state = await page.evaluate(() => (window as any).DCM?.state);
    expect(state).toBeTruthy();
    expect(state.mode).toMatch(/^(first|third)$/);
    expect(typeof state.vy).toBe('number');
    expect(typeof state.facing).toBe('number');
    expect(typeof state.camDist).toBe('number');
  });

  test('DCM.setMode function exists', async ({ page }) => {
    const DCMReady = await waitForDCMState(page, 30000);
    if (!DCMReady) {
      test.skip();
      return;
    }

    const hasSetMode = await page.evaluate(() => typeof (window as any).DCM?.setMode === 'function');
    expect(hasSetMode).toBe(true);
  });

  test('DCM.toggleMode function exists', async ({ page }) => {
    const DCMReady = await waitForDCMState(page, 30000);
    if (!DCMReady) {
      test.skip();
      return;
    }

    const hasToggle = await page.evaluate(() => typeof (window as any).DCM?.toggleMode === 'function');
    expect(hasToggle).toBe(true);
  });

  test('V key toggles mode', async ({ page }) => {
    const DCMReady = await waitForDCMState(page, 30000);
    if (!DCMReady) {
      test.skip();
      return;
    }

    const initialMode = await page.evaluate(() => (window as any).DCM?.state?.mode);
    await page.keyboard.press('v');
    await page.waitForTimeout(300);
    const toggledMode = await page.evaluate(() => (window as any).DCM?.state?.mode);
    expect(toggledMode).not.toBe(initialMode);
  });

  test('R key triggers respawn', async ({ page }) => {
    const DCMReady = await waitForDCMState(page, 30000);
    if (!DCMReady) {
      test.skip();
      return;
    }

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
// ---------------------------------------------------------------------------
test.describe('Group 6: DC Options', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/admin/dc.html', { timeout: 120000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  });

  test('DC.options exists with movement flags', async ({ page }) => {
    const optionsReady = await waitForDCOptions(page, 30000);
    if (!optionsReady) {
      test.skip();
      return;
    }

    const options = await page.evaluate(() => (window as any).DC?.options);
    expect(options).toBeTruthy();
    expect(typeof options.moveForward).toBe('boolean');
    expect(typeof options.moveBackward).toBe('boolean');
    expect(typeof options.moveLeft).toBe('boolean');
    expect(typeof options.moveRight).toBe('boolean');
  });

  test('WASD keys modify movement flags', async ({ page }) => {
    const optionsReady = await waitForDCOptions(page, 30000);
    if (!optionsReady) {
      test.skip();
      return;
    }

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
  test('WebGL context can be created', async ({ page }) => {
    await page.goto('/admin/dc.html');
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
  for (const { label, url } of RENDERER_MODES) {
    test(`[${label}] no critical JS errors on page load`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto(url, { timeout: 120000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(3000);  // Wait for any async initialization

      // Filter out known non-critical errors
      const criticalErrors = errors.filter(
        (e) =>
          !e.includes('WebGL') &&
          !e.includes('GPU') &&
          !e.includes('context') &&
          !e.includes('Failed to load resource')
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
// Hermetic by construction. Two things are stubbed before any page script runs:
//   - window.WebSocket, so the real datacentered hub (wss://…:7272) is NEVER
//     contacted. dc-ws.js reads `WebSocket` as a bare identifier, which resolves
//     to the window property, so the override takes effect.
//   - /ajax/datacenter.php, so no DB is touched and the room build is fast.
//
// The Vitest specs (tests/js/dc-offline.test.js) are the real gate for this
// behaviour; this group is the in-browser confirmation. Playwright is
// continue-on-error in CI, so keep the assertions about the HUD and input
// handling rather than about GLB assets the single-threaded php -S cannot serve.
// ---------------------------------------------------------------------------
test.describe('Group 8: Hub unreachable (scene must still work)', () => {
  const DATACENTER_STUB = {
    locations: {
      0: {
        name: 'Test',
        region: 'Test',
        racks: {
          1: { x: 0, y: 0, type: 0, servers: {}, switches: {} },
          2: { x: 1, y: 0, type: 1, servers: {}, switches: {} },
        },
      },
    },
  };

  /**
   * @param mode 'throw'  the WebSocket constructor throws (blocked / bad URL)
   *             'close'  the socket is created and closes immediately
   */
  async function bootWithDeadHub(page: any, mode: 'throw' | 'close') {
    await page.addInitScript((m: string) => {
      (window as any).__wsAttempts = 0;
      function DeadSocket(this: any, url: string) {
        (window as any).__wsAttempts++;
        (window as any).__wsUrl = url;
        if (m === 'throw') throw new Error('E2E: hub unreachable');
        this.url = url;
        this.readyState = 0;
        this.send = () => { throw new Error('E2E: socket is not open'); };
        this.close = () => { this.readyState = 3; };
        setTimeout(() => {
          this.readyState = 3;
          if (this.onclose) this.onclose({ code: 1006, reason: 'E2E: hub unreachable' });
        }, 0);
      }
      (DeadSocket as any).CONNECTING = 0;
      (DeadSocket as any).OPEN = 1;
      (DeadSocket as any).CLOSING = 2;
      (DeadSocket as any).CLOSED = 3;
      (window as any).WebSocket = DeadSocket;
    }, mode);

    await page.route('**/ajax/datacenter.php*', (route: any) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DATACENTER_STUB),
      })
    );

    await page.goto('/admin/dc.html', { timeout: 120000 });
    await page.waitForLoadState('domcontentloaded');
    // dc-ws.js is a module script; under fixture contention it can arrive well after
    // domcontentloaded. Wait for it to have run so the assertions below have a base.
    await page
      .waitForFunction(() => 'DC_WS' in window, { timeout: 90000 })
      .catch(() => { /* asserted per-test below */ });
  }

  // The single-threaded `php -S` fixture serialises the scene's ~100 GLB assets, so
  // under full-suite contention every page load here is slow. Give each test a
  // generous budget so contention shows up as slowness, not as a false regression.
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

      // NOTE: keyboard movement is deliberately NOT asserted here. WASD handling is
      // attached by attachKeyHandlers() inside displayDatacenter(), which waits on the
      // scene's ~100 GLB assets that the single-threaded `php -S` fixture cannot serve
      // in time (.claude/rules/js-tests.md). Group 6 covers keyboard movement, and
      // tests/js/dc-offline.test.js covers scene liveness with a dead hub.
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
// and /ajax/datacenter.php is stubbed so the room builds without the DB or the ~100 GLBs the
// single-threaded `php -S` fixture cannot serve in time (.claude/rules/js-tests.md).
// ---------------------------------------------------------------------------
test.describe('Group 9: Renderer modes', () => {
  const DATACENTER_STUB = {
    locations: {
      0: {
        name: 'Test',
        region: 'Test',
        racks: { 1: { x: 0, y: 0, type: 0, servers: {}, switches: {} } },
      },
    },
  };

  async function boot(page: any, url: string) {
    await page.addInitScript(() => {
      function DeadSocket(this: any, u: string) {
        this.url = u;
        this.readyState = 3;
        this.send = () => {};
        this.close = () => {};
      }
      (DeadSocket as any).CONNECTING = 0;
      (DeadSocket as any).OPEN = 1;
      (DeadSocket as any).CLOSING = 2;
      (DeadSocket as any).CLOSED = 3;
      (window as any).WebSocket = DeadSocket;
    });
    await page.route('**/ajax/datacenter.php*', (route: any) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DATACENTER_STUB),
      })
    );
    await page.goto(url, { timeout: 120000 });
    await page.waitForLoadState('domcontentloaded');
  }

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

      const ready = await page
        .waitForFunction(() => (window as any).DC && (window as any).DC.renderer, { timeout: 90000 })
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
      await page.waitForFunction(() => (window as any).DC && (window as any).DC.renderer, { timeout: 90000 });

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
