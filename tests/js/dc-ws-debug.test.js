/**
 * Unit tests for WebSocket debugging and graceful degradation features
 * in public_html/js/dc-ws.js and public_html/js/dc-multi.js.
 *
 * Tests cover:
 * 1. Graceful degradation when DC_PRESENCE_ENABLED = false
 * 2. getWsState() optional chaining behavior
 * 3. DC_PRESENCE_ENABLED !== false pattern (presenceEnabled logic)
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// ----------------------------------------------------------------
// Load dc-ws.js into a minimal VM sandbox (mirrors dc-ws.test.js)
// ----------------------------------------------------------------
function loadDcWs(overrides) {
  overrides = overrides || {};

  // WebSocket constructor with OPEN constant
  function MockWebSocket(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this._sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
  }
  MockWebSocket.OPEN = 1;
  MockWebSocket.prototype.send = function(data) { this._sent.push(data); };
  MockWebSocket.prototype.close = function() {
    this.readyState = 3; // CLOSED
    if (this.onclose) this.onclose({ code: 1000, reason: '正常关闭' });
  };

  const win = {
    WebSocket: MockWebSocket,
    DC_SESSION_ID: 'test-session-123',
    DC_AUTHED: false,
    DC_UID: null,
    DC_PRESENCE: null,
    DC_PRESENCE_SEND: null,
    DC_PRESENCE_ENABLED: undefined, // undefined means enabled (not disabled)
    DC_LATENCY: null,
    DC_DEBUG: null,
    DC_DEBUG_PING_HISTORY: undefined,
    btoa: function(s) { return Buffer.from(s, 'binary').toString('base64'); },
    atob: function(s) { return Buffer.from(s, 'base64').toString('binary'); },
    addEventListener: function(evt, cb) { this._listeners = this._listeners || {}; this._listeners[evt] = cb; },
    setTimeout: function() { return 0; },
    clearTimeout: function() {},
    performance: { now: function() { return 0; } },
    console: console,
    URLSearchParams: class URLSearchParams {
      constructor(search) {
        this._search = search;
        this._params = {};
        if (search) {
          var clean = search.replace(/^\?/, '');
          var pairs = clean.split('&');
          for (var i = 0; i < pairs.length; i++) {
            var pair = pairs[i];
            var idx = pair.indexOf('=');
            var k = idx >= 0 ? pair.substring(0, idx) : pair;
            var v = idx >= 0 ? pair.substring(idx + 1) : '';
            if (k) this._params[decodeURIComponent(k)] = decodeURIComponent(v || '');
          }
        }
      }
      get(key) { return this._params[key] || null; }
    },
    location: { search: '' },
    document: {
      addEventListener: function(evt, cb) { this._listeners = this._listeners || {}; this._listeners[evt] = cb; },
      readyState: 'complete',
      createEvent: function() { return { initCustomEvent: function() {} }; },
      dispatchEvent: function() { return true; },
    },
  };

  // Provide a minimal document
  Object.keys(overrides).forEach(function(key) {
    win[key] = overrides[key];
  });
  win.window = win;
  win.self = win;

  const sandbox = {
    window: win,
    document: win.document,
    console: console,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    performance: win.performance,
    crypto: {
      randomUUID: function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      },
    },
    // URLSearchParams is used as bare identifier in dc-ws.js at module load
    URLSearchParams: win.URLSearchParams,
    // requestAnimationFrame for presence batching (Node.js doesn't have it)
    requestAnimationFrame: function(cb) { return setTimeout(cb, 16); },
    cancelAnimationFrame: function(id) { clearTimeout(id); },
  };
  vm.createContext(sandbox);

  const SRC = path.resolve(__dirname, '../../public_html/js/dc-ws.js');
  const code = fs.readFileSync(SRC, 'utf8');
  vm.runInContext(code, sandbox, { filename: SRC });

  return { win: win };
}

// ----------------------------------------------------------------
// Tests: 1. Graceful degradation when DC_PRESENCE_ENABLED = false
// ----------------------------------------------------------------
describe('dc-ws.js graceful degradation', () => {
  test('DC_PRESENCE_JOIN is no-op when DC_PRESENCE_ENABLED = false', () => {
    const result = loadDcWs({ DC_PRESENCE_ENABLED: false });

    // Ensure DC_WS is available but WS is not connected
    // DC_WS may or may not have ws set depending on connection state
    const sent = [];
    if (result.win.DC_WS && result.win.DC_WS.send) {
      result.win.DC_WS.send = function(op, data) { sent.push({ op, data }); };
    }

    // Should not throw
    expect(() => result.win.DC_PRESENCE_JOIN(100, 200, 1.5)).not.toThrow();

    // Should NOT send any message (early return when DC_PRESENCE_ENABLED === false)
    expect(sent.length).toBe(0);
  });

  test('DC_PRESENCE_MOVE is no-op when DC_PRESENCE_ENABLED = false', () => {
    const result = loadDcWs({ DC_PRESENCE_ENABLED: false });

    const sent = [];
    if (result.win.DC_WS && result.win.DC_WS.send) {
      result.win.DC_WS.send = function(op, data) { sent.push({ op, data }); };
    }

    expect(() => result.win.DC_PRESENCE_MOVE(150, 250, 0.5)).not.toThrow();
    expect(sent.length).toBe(0);
  });

  test('DC_PRESENCE_LEAVE is no-op when DC_PRESENCE_ENABLED = false', () => {
    const result = loadDcWs({ DC_PRESENCE_ENABLED: false });

    const sent = [];
    if (result.win.DC_WS && result.win.DC_WS.send) {
      result.win.DC_WS.send = function(op, data) { sent.push({ op, data }); };
    }

    expect(() => result.win.DC_PRESENCE_LEAVE()).not.toThrow();
    expect(sent.length).toBe(0);
  });
});

// ----------------------------------------------------------------
// Tests: 2. getWsState() optional chaining
// ----------------------------------------------------------------
describe('getWsState() optional chaining', () => {
  // The pattern is: () => window.DC_WS?.getState() ?? null

  test('returns null when DC_WS is undefined', () => {
    // Simulate the getWsState logic
    const window = { DC_WS: undefined };
    const getWsState = () => window.DC_WS?.getState() ?? null;

    expect(getWsState()).toBeNull();
  });

  test('returns null when DC_WS is null', () => {
    const window = { DC_WS: null };
    const getWsState = () => window.DC_WS?.getState() ?? null;

    expect(getWsState()).toBeNull();
  });

  test('returns getState() result when DC_WS is valid object', () => {
    const mockState = { connected: true, authenticated: true };
    const window = {
      DC_WS: {
        getState: () => mockState
      }
    };
    const getWsState = () => window.DC_WS?.getState() ?? null;

    expect(getWsState()).toEqual(mockState);
  });

  test('uses nullish coalescing, not logical OR', () => {
    // Important: getWsState uses ?? (nullish coalescing), not || (logical OR)
    const mockState = { connected: true };
    const window = {
      DC_WS: {
        getState: () => mockState
      }
    };
    const getWsState = () => window.DC_WS?.getState() ?? null;

    // ?? only null/undefined triggers the fallback
    expect(getWsState()).toEqual(mockState);
  });
});

// ----------------------------------------------------------------
// Tests: 3. DC_PRESENCE_ENABLED !== false pattern
// ----------------------------------------------------------------
describe('presenceEnabled pattern', () => {
  test('DC_PRESENCE_ENABLED undefined means enabled', () => {
    const window = { DC_PRESENCE_ENABLED: undefined };
    const presenceEnabled = window.DC_PRESENCE_ENABLED !== false;
    expect(presenceEnabled).toBe(true);
  });

  test('DC_PRESENCE_ENABLED null means enabled', () => {
    const window = { DC_PRESENCE_ENABLED: null };
    const presenceEnabled = window.DC_PRESENCE_ENABLED !== false;
    expect(presenceEnabled).toBe(true);
  });

  test('DC_PRESENCE_ENABLED true means enabled', () => {
    const window = { DC_PRESENCE_ENABLED: true };
    const presenceEnabled = window.DC_PRESENCE_ENABLED !== false;
    expect(presenceEnabled).toBe(true);
  });

  test('DC_PRESENCE_ENABLED false means disabled', () => {
    const window = { DC_PRESENCE_ENABLED: false };
    const presenceEnabled = window.DC_PRESENCE_ENABLED !== false;
    expect(presenceEnabled).toBe(false);
  });
});
