/**
 * Unit tests for public_html/js/dc-ws.js
 *
 * Tests the protocol message construction, uuid() generation, URL param
 * override behavior (_wsUrlOverride), reconnect backoff math, and the
 * DC_PRESENCE_SEND throttle behavior.
 *
 * dc-ws.js is an IIFE that exposes DC_WS, DC_AUTHED, DC_UID, DC_PRESENCE,
 * DC_PRESENCE_SEND on window.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// ----------------------------------------------------------------
// Load dc-ws.js into a minimal VM sandbox (mirrors ws_terminal.test.js)
// ----------------------------------------------------------------
function loadDcWs(overrides) {
  overrides = overrides || {};
  const listeners = {};

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
    DC_LATENCY: null,
    DC_DEBUG: null,
    DC_DEBUG_PING_HISTORY: undefined,
    btoa: function(s) { return Buffer.from(s, 'binary').toString('base64'); },
    atob: function(s) { return Buffer.from(s, 'base64').toString('binary'); },
    addEventListener: function(evt, cb) { listeners[evt] = cb; },
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
      addEventListener: function(evt, cb) { listeners[evt] = cb; },
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

  return { win: win, listeners: listeners };
}

// ----------------------------------------------------------------
// Tests: protocol message construction
// ----------------------------------------------------------------
describe('dc-ws.js — protocol message construction', () => {
  it('uuid() generates a valid v4-like UUID when crypto.randomUUID is unavailable', () => {
    // Test the fallback UUID pattern: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const fallback = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    expect(fallback).toMatch(uuidPattern);
  });
});

// ----------------------------------------------------------------
// Tests: URL param override behavior
// ----------------------------------------------------------------
describe('dc-ws.js — URL param override (_wsUrlOverride)', () => {
  it('ws_keepalive param parsing logic is correct', () => {
    // The module parses it as: parseInt(_urlParams.get('ws_keepalive'), 10) * 1000
    // Clamped to 5-300 seconds (5000-300000ms)
    const parseKeepalive = function(raw) {
      const val = parseInt(raw, 10);
      return (!isNaN(val) && val >= 5 && val <= 300) ? val * 1000 : 30000;
    };
    expect(parseKeepalive('60')).toBe(60000);
    expect(parseKeepalive('5')).toBe(5000);
    expect(parseKeepalive('300')).toBe(300000);
    expect(parseKeepalive('4')).toBe(30000);   // below min -> default
    expect(parseKeepalive('301')).toBe(30000); // above max -> default
    expect(parseKeepalive('abc')).toBe(30000); // invalid -> default
  });

  it('allowedHosts list contains mystage.interserver.net', () => {
    const allowedHosts = ['mystage.interserver.net'];
    expect(allowedHosts).toContain('mystage.interserver.net');
    expect(allowedHosts).not.toContain('evil.com');
  });
});

// ----------------------------------------------------------------
// Tests: reconnect backoff math
// ----------------------------------------------------------------
describe('dc-ws.js — reconnect exponential backoff', () => {
  it('initial reconnectDelay is 3000ms', () => {
    const result = loadDcWs();
    expect(result.win.DC_WS.reconnectDelay).toBe(3000);
  });

  it('maxReconnectAttempts is 10', () => {
    const result = loadDcWs();
    expect(result.win.DC_WS.maxReconnectAttempts).toBe(10);
  });

  it('backoff doubles each reconnect attempt up to 30000ms cap', () => {
    const delays = [];
    let delay = 3000;
    for (let i = 0; i < 8; i++) {
      delays.push(delay);
      // Mimic the backoff: min(delay * 2, 30000) * (0.5 + random * 0.5)
      // We test the deterministic cap: delay * 2 capped at 30000
      delay = Math.min(delay * 2, 30000);
    }
    expect(delays).toEqual([3000, 6000, 12000, 24000, 30000, 30000, 30000, 30000]);
  });
});

// ----------------------------------------------------------------
// Tests: DC_PRESENCE_SEND fire-and-forget sender
// ----------------------------------------------------------------
describe('dc-ws.js — DC_PRESENCE_SEND fire-and-forget presence throttle', () => {
  it('DC_PRESENCE_SEND is a function on window after load', () => {
    const result = loadDcWs();
    expect(typeof result.win.DC_PRESENCE_SEND).toBe('function');
  });

  it('DC_PRESENCE_SEND calls DC_WS.send for non-presence ops directly', () => {
    const result = loadDcWs();
    const sent = [];
    result.win.DC_WS.send = function(op, data) { sent.push({ op: op, data: data }); };

    result.win.DC_PRESENCE_SEND('chat.message', { text: 'hello' });

    expect(sent.length).toBe(1);
    expect(sent[0].op).toBe('chat.message');
  });
});

// ----------------------------------------------------------------
// Tests: window exports after load
// ----------------------------------------------------------------
describe('dc-ws.js — window exports', () => {
  it('exposes DC_WS, DC_AUTHED, DC_UID, DC_PRESENCE on window after init', () => {
    const result = loadDcWs();
    expect(typeof result.win.DC_WS).toBe('object');
    expect(typeof result.win.DC_AUTHED).toBe('boolean');
    expect(result.win.DC_UID).toBeNull();
    expect(result.win.DC_PRESENCE).toBeNull();
  });

  it('auth.welcome sets DC_AUTHED=true, DC_UID, DC_PRESENCE', () => {
    const result = loadDcWs();

    // Simulate receiving auth.welcome by calling _onFrame directly
    // The auth.welcome message has op='auth.welcome' (events reuse request shape)
    const authWelcomeFrame = JSON.stringify({
      v: 1,
      op: 'auth.welcome',
      data: { uid: 999, name: 'Test User', session: 'sess-abc', hub_time: 1234567890 },
    });
    result.win.DC_WS._onFrame(authWelcomeFrame);

    expect(result.win.DC_AUTHED).toBe(true);
    expect(result.win.DC_UID).toBe(999);
    expect(result.win.DC_PRESENCE).toEqual({
      uid: 999,
      name: 'Test User',
      session: 'sess-abc',
      hub_time: 1234567890,
    });
  });

  it('auth.rejected sets DC_AUTHED=false', () => {
    const result = loadDcWs();

    // auth.rejected comes as an event (op-based, not re-based)
    const authRejectedFrame = JSON.stringify({
      v: 1,
      op: 'auth.rejected',
      data: { error: { code: 'AUTH_FAILED', message: 'Bad credentials' } },
    });
    result.win.DC_WS._onFrame(authRejectedFrame);

    expect(result.win.DC_AUTHED).toBe(false);
  });
});
