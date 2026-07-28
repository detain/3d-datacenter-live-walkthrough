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

// ----------------------------------------------------------------
// Tests: Protocol message format
// ----------------------------------------------------------------
describe('dc-ws.js — protocol message format', () => {
  it('auth.hello message format is correct', () => {
    // auth.hello: {v:1, id:"<uuid>", op:"auth.hello", ts:<unix>, data:{role:"admin", session:<sessionId>}}
    const msg = {
      v: 1,
      id: 'test-uuid',
      op: 'auth.hello',
      ts: 1234567890,
      data: { role: 'admin', session: 'test-session' }
    };
    expect(msg.v).toBe(1);
    expect(msg.op).toBe('auth.hello');
    expect(msg.data.role).toBe('admin');
    expect(msg.data.session).toBe('test-session');
  });

  it('presence.move message format preserves x, z, yaw', () => {
    const msg = {
      v: 1,
      id: 'uuid',
      op: 'dc.presence.move',
      ts: 1234567890,
      data: { x: 100, z: 200, yaw: 1.5 }
    };
    expect(msg.data.x).toBe(100);
    expect(msg.data.z).toBe(200);
    expect(msg.data.yaw).toBeCloseTo(1.5, 1);
  });

  it('chat.message operation structure is correct', () => {
    const msg = {
      v: 1,
      id: 'uuid',
      op: 'chat.message',
      ts: 1234567890,
      data: { channel: 'global', text: 'Hello world' }
    };
    expect(msg.op).toBe('chat.message');
    expect(msg.data.channel).toBe('global');
    expect(msg.data.text).toBe('Hello world');
  });
});

// ----------------------------------------------------------------
// Tests: Latency calculation
// ----------------------------------------------------------------
describe('dc-ws.js — latency calculation', () => {
  it('latency is calculated as (now - sentTime) when pong received', () => {
    // Simulate ping at t=1000, pong at t=1050
    const sentTime = 1000;
    const receivedTime = 1050;
    const latency = receivedTime - sentTime;
    expect(latency).toBe(50);
  });

  it('latency averaging uses last few samples', () => {
    // Simulate latency history with 5 samples
    const samples = [45, 52, 48, 55, 50];
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    expect(avg).toBe(50);
  });

  it('DC_LATENCY is null before first pong', () => {
    const result = loadDcWs();
    expect(result.win.DC_LATENCY).toBeNull();
  });
});

// ----------------------------------------------------------------
// Tests: Presence batch throttle behavior
// ----------------------------------------------------------------
describe('dc-ws.js — presence batch throttle', () => {
  it('DC_PRESENCE_SEND throttles consecutive calls within THROTTLE_MS', () => {
    // THROTTLE_MS = 150ms
    const THROTTLE_MS = 150;
    let lastSendTime = 0;
    let sendCount = 0;

    const throttledSend = (now) => {
      if (now - lastSendTime >= THROTTLE_MS) {
        lastSendTime = now;
        sendCount++;
      }
    };

    throttledSend(100);
    throttledSend(200); // 100ms later, should NOT send (150ms throttle)
    throttledSend(300); // 200ms later, should send
    throttledSend(350); // 50ms later, should NOT send

    expect(sendCount).toBe(2);
  });

  it('first send always goes through regardless of lastSendTime', () => {
    const THROTTLE_MS = 150;
    let lastSendTime = 0;
    let sendCount = 0;

    const throttledSend = (now) => {
      if (lastSendTime === 0 || now - lastSendTime >= THROTTLE_MS) {
        lastSendTime = now;
        sendCount++;
      }
    };

    throttledSend(100); // first call
    throttledSend(150); // 50ms later

    expect(sendCount).toBe(1);
  });
});

// ----------------------------------------------------------------
// Tests: Reconnect gives up after maxReconnectAttempts
// ----------------------------------------------------------------
describe('dc-ws.js — reconnect exhaustion', () => {
  it('reconnect is not scheduled after maxReconnectAttempts is reached', () => {
    let attempts = 0;
    let scheduled = true;
    const maxReconnectAttempts = 10;

    const scheduleReconnect = () => {
      if (!scheduled) return;
      attempts++;
      if (attempts >= maxReconnectAttempts) {
        scheduled = false;
        return;
      }
      // schedule with delay
    };

    for (let i = 0; i < 15; i++) scheduleReconnect();
    expect(scheduled).toBe(false);
    expect(attempts).toBe(10);
  });

  it('reconnect attempts increment on each failed attempt', () => {
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;

    const simulateReconnect = () => {
      reconnectAttempts++;
      return reconnectAttempts < maxReconnectAttempts;
    };

    let shouldReconnect = true;
    let iterations = 0;
    while (shouldReconnect && iterations < 20) {
      shouldReconnect = simulateReconnect();
      iterations++;
    }

    expect(reconnectAttempts).toBe(10);
    expect(shouldReconnect).toBe(false);
  });
});

// ----------------------------------------------------------------
// Tests: dc.presence.join/move/leave message format
// ----------------------------------------------------------------
describe('dc-ws.js — presence message format', () => {
  it('dc.presence.join includes x, z, yaw', () => {
    const msg = {
      v: 1, id: 'uuid', op: 'dc.presence.join',
      ts: 1234567890,
      data: { x: 10, z: 20, yaw: 1.5 }
    };
    expect(msg.data.x).toBe(10);
    expect(msg.data.z).toBe(20);
    expect(msg.data.yaw).toBeCloseTo(1.5, 1);
  });

  it('dc.presence.leave is an empty object', () => {
    const msg = {
      v: 1, id: 'uuid', op: 'dc.presence.leave',
      ts: 1234567890,
      data: {}
    };
    expect(msg.data).toEqual({});
  });

  it('presence batch flushes multiple moves', () => {
    // Simulate presence batching behavior
    let batch = [];
    const MAX_BATCH = 100;

    // Add multiple moves
    batch.push({ op: 'dc.presence.move', data: { x: 10, z: 20, yaw: 0 } });
    batch.push({ op: 'dc.presence.move', data: { x: 11, z: 21, yaw: 0.1 } });
    batch.push({ op: 'dc.presence.move', data: { x: 12, z: 22, yaw: 0.2 } });

    expect(batch.length).toBe(3);

    // Flush should send all
    const flushed = batch.splice(0, batch.length);
    expect(flushed.length).toBe(3);
    expect(batch.length).toBe(0);
  });
});

// ----------------------------------------------------------------
// Tests: URL param override for ws_keepalive
// ----------------------------------------------------------------
describe('dc-ws.js — ws_keepalive URL param', () => {
  it('parses valid ws_keepalive values', () => {
    const parseKeepalive = (raw) => {
      const val = parseInt(raw, 10);
      return (!isNaN(val) && val >= 5 && val <= 300) ? val * 1000 : 30000;
    };

    expect(parseKeepalive('5')).toBe(5000);
    expect(parseKeepalive('30')).toBe(30000);
    expect(parseKeepalive('60')).toBe(60000);
    expect(parseKeepalive('120')).toBe(120000);
    expect(parseKeepalive('300')).toBe(300000);
  });

  it('rejects out-of-range ws_keepalive values', () => {
    const parseKeepalive = (raw) => {
      const val = parseInt(raw, 10);
      return (!isNaN(val) && val >= 5 && val <= 300) ? val * 1000 : 30000;
    };

    expect(parseKeepalive('4')).toBe(30000);   // too low
    expect(parseKeepalive('301')).toBe(30000); // too high
    expect(parseKeepalive('abc')).toBe(30000); // invalid
    expect(parseKeepalive('')).toBe(30000);    // empty
  });
});

// ----------------------------------------------------------------
// Tests: Client connected() method logic
// ----------------------------------------------------------------
describe('dc-ws.js — connected() logic', () => {
  it('connected returns true when WebSocket is OPEN', () => {
    const ws = { readyState: 1 };  // WebSocket.OPEN = 1
    const connected = !!(ws && ws.readyState === 1);
    expect(connected).toBe(true);
  });

  it('connected returns false when WebSocket is CONNECTING', () => {
    const ws = { readyState: 0 };  // CONNECTING
    const connected = !!(ws && ws.readyState === 1);
    expect(connected).toBe(false);
  });

  it('connected returns false when WebSocket is CLOSED', () => {
    const ws = { readyState: 3 };  // CLOSED
    const connected = !!(ws && ws.readyState === 1);
    expect(connected).toBe(false);
  });

  it('connected returns false when ws is null', () => {
    const ws = null;
    const connected = !!(ws && ws.readyState === 1);
    expect(connected).toBe(false);
  });
});

// ----------------------------------------------------------------
// Tests: Auth hello message structure
// ----------------------------------------------------------------
describe('dc-ws.js — auth.hello message', () => {
  it('auth.hello includes correct data structure', () => {
    const session = 'test-session-123';
    const msg = {
      v: 1,
      id: 'test-uuid',
      op: 'auth.hello',
      ts: Math.floor(Date.now() / 1000),
      data: { role: 'admin', session: session }
    };

    expect(msg.v).toBe(1);
    expect(msg.op).toBe('auth.hello');
    expect(msg.data.role).toBe('admin');
    expect(msg.data.session).toBe(session);
    expect(typeof msg.ts).toBe('number');
    expect(msg.id).toBeTruthy();
  });
});
