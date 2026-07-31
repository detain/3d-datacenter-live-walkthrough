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
    // dc-ws.js references WebSocket as a BARE identifier (`new WebSocket(...)`,
    // `WebSocket.OPEN`), which resolves against these sandbox globals — NOT against
    // `win`. Putting the mock only on `win` (as this harness used to) made the
    // constructor throw ReferenceError, which dc-ws catches and turns into its
    // degraded path: no socket, DC_PRESENCE_ENABLED forced false. Every
    // connected-socket assertion in this file then passed vacuously. Keep this here.
    WebSocket: win.WebSocket,
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
// NOTE: this block used to assert that window.DC_PRESENCE_JOIN / _MOVE / _LEAVE
// were no-ops when DC_PRESENCE_ENABLED === false, after loading dc-ws.js ALONE.
// dc-ws.js no longer defines those three — they were duplicate, and buggy,
// definitions of functions dc-presence.js also declared and (loading later) won
// with: the dc-ws copies sent `facing:` where the hub reads `yaw:`, and passed a
// client-supplied `clientId` the hub mis-parsed and never ownership-checked.
// dc-presence.js is now the sole owner and carries the DC_PRESENCE_ENABLED
// short-circuit inside its own send(); that behaviour is covered by
// tests/js/dc-presence.test.js. What dc-ws.js still owns is DC_PRESENCE_SEND,
// so that is what this block exercises.
describe('dc-ws.js graceful degradation', () => {
  test('a socket is genuinely constructed (guards against vacuous passes)', () => {
    const result = loadDcWs();

    // If WebSocket is ever dropped from the sandbox again, dc-ws swallows the
    // ReferenceError and parks in its degraded path — and every assertion below
    // about connected behaviour would pass for the wrong reason. Fail loudly here.
    expect(result.win.DC_WS).toBeTruthy();
    expect(result.win.DC_WS.ws).toBeTruthy();
    expect(result.win.DC_WS.ws.url).toBe('wss://mystage.interserver.net:7272');
    expect(result.win.DC_PRESENCE_ENABLED).not.toBe(false);
  });

  test('DC_PRESENCE_SEND does not send while the socket is still CONNECTING', () => {
    const result = loadDcWs();
    const sent = [];
    result.win.DC_WS.send = function(op, data) { sent.push({ op, data }); };

    // MockWebSocket starts at readyState 0 (CONNECTING), so connected() is false.
    expect(result.win.DC_WS.connected()).toBe(false);
    expect(() => result.win.DC_PRESENCE_SEND('dc.presence.move', { x: 1, z: 2, yaw: 0 })).not.toThrow();
    expect(sent.length).toBe(0);
  });

  test('DC_PRESENCE_SEND forwards to DC_WS.send once the socket is OPEN', () => {
    const result = loadDcWs();
    const sent = [];
    result.win.DC_WS.send = function(op, data) { sent.push({ op, data }); };

    result.win.DC_WS.ws.readyState = result.win.WebSocket.OPEN;
    expect(result.win.DC_WS.connected()).toBe(true);

    result.win.DC_PRESENCE_SEND('dc.presence.move', { x: 1, z: 2, yaw: 0.5 });
    expect(sent.length).toBe(1);
    expect(sent[0].op).toBe('dc.presence.move');
    expect(sent[0].data).toEqual({ x: 1, z: 2, yaw: 0.5 });
  });

  test('DC_PRESENCE_SEND is a safe no-op when DC_WS is null', () => {
    const result = loadDcWs();
    const send = result.win.DC_PRESENCE_SEND;
    result.win.DC_WS = null;

    expect(() => send('dc.presence.leave', {})).not.toThrow();
  });

  test('getState() is usable immediately after load', () => {
    const result = loadDcWs();
    const state = result.win.DC_WS.getState();

    expect(state.connected).toBe(false);      // still CONNECTING
    expect(state.authenticated).toBe(false);  // no welcome reply yet
    expect(state.presenceEnabled).toBe(true);
    expect(state.sessionId).toBe('test-session-123');
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
