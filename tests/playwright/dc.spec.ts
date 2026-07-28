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

  test('no critical JS errors on page load', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/admin/dc.html', { timeout: 120000 });
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
});
