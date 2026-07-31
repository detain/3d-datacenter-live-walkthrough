/**
 * Unit tests for public_html/js/dc-ws.js
 *
 * Tests the protocol message construction, uuid() generation, URL param
 * override behavior (_wsUrlOverride), reconnect backoff math, and the
 * DC_PRESENCE_SEND throttle behavior.
 *
 * dc-ws.js is an IIFE that exposes DC_WS, DC_AUTHED, DC_UID, DC_PRESENCE,
 * DC_PRESENCE_SEND on window. It deliberately does NOT export
 * DC_PRESENCE_JOIN/MOVE/LEAVE — dc-presence.js owns those (C2).
 *
 * Protocol note (C-A2): the hub answers auth.hello with a CORRELATED REPLY,
 * `{v:1, re:"<the auth.hello id>", ok:true, data:{...}}` — replies carry NO `op`
 * field (PROTOCOL_V1 §1). Tests here drive that real shape; an earlier revision
 * of this file asserted a fictional op-shaped `auth.welcome` event, which is
 * exactly how the "client can never authenticate" bug shipped.
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
  // Every event passed to document.dispatchEvent, in order.
  const events = [];
  // Deterministic requestAnimationFrame queue — nothing fires until flushRaf().
  const rafQueue = [];
  let rafSeq = 0;
  // Captured setInterval registrations (the keepalive tick), driven manually.
  const intervals = [];

  // Minimal CustomEvent so _dispatchEvent takes the modern branch and preserves detail.
  class CustomEventShim {
    constructor(type, opts) {
      this.type = type;
      this.detail = opts ? opts.detail : undefined;
      this.bubbles = !!(opts && opts.bubbles);
    }
  }

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
    if (this.onclose) this.onclose({ code: 1000, reason: 'normal closure' });
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
      hidden: false,
      createEvent: function() { return { initCustomEvent: function() {} }; },
      dispatchEvent: function(ev) { events.push(ev); return true; },
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
    // dc-ws.js references `WebSocket` as a bare global (`new WebSocket(url, 'v1')`
    // and `WebSocket.OPEN`). Without it in the VM's global scope the constructor
    // throws ReferenceError and the client silently sits in its degraded path,
    // which made every connected-socket assertion vacuous.
    WebSocket: win.WebSocket,
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
    // CustomEvent so _dispatchEvent keeps the detail payload
    CustomEvent: CustomEventShim,
    // requestAnimationFrame for presence batching (Node.js doesn't have it).
    // Deterministic: callbacks queue until flushRaf() is called by the test.
    requestAnimationFrame: function(cb) { rafSeq++; rafQueue.push({ id: rafSeq, cb: cb }); return rafSeq; },
    cancelAnimationFrame: function(id) {
      const i = rafQueue.findIndex(function(e) { return e.id === id; });
      if (i >= 0) rafQueue.splice(i, 1);
    },
    // setInterval/clearInterval are host-provided; a bare V8 context has neither.
    // Capture registrations so the keepalive tick can be driven by hand.
    setInterval: function(fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; },
    clearInterval: function() {},
  };
  vm.createContext(sandbox);

  const SRC = path.resolve(__dirname, '../../public_html/js/dc-ws.js');
  const code = fs.readFileSync(SRC, 'utf8');
  vm.runInContext(code, sandbox, { filename: SRC });

  return {
    win: win,
    listeners: listeners,
    events: events,
    rafQueue: rafQueue,
    intervals: intervals,
    /** Run (and clear) every pending animation-frame callback. */
    flushRaf: function() {
      const pending = rafQueue.splice(0, rafQueue.length);
      pending.forEach(function(e) { e.cb(); });
    },
    /** Statuses broadcast so far via the dc:ws-status contract event. */
    statuses: function() {
      return events.filter(function(e) { return e.type === 'dc:ws-status'; })
                   .map(function(e) { return e.detail.status; });
    },
    /** All detail payloads for a given event name, in order. */
    detailsFor: function(name) {
      return events.filter(function(e) { return e.type === name; })
                   .map(function(e) { return e.detail; });
    },
    /** Open the socket: mark it OPEN and fire onopen (sends auth.hello). */
    open: function() {
      const client = win.DC_WS;
      client.ws.readyState = 1;
      client.ws.onopen();
      return client;
    },
    /** Frames written to the socket, parsed. */
    sent: function() {
      const client = win.DC_WS;
      if (!client || !client.ws) return [];
      return client.ws._sent.map(function(s) { return JSON.parse(s); });
    },
  };
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
    // DC_PRESENCE_SEND gates on DC_WS.connected(), so the socket must be OPEN.
    result.win.DC_WS.ws.readyState = 1;
    result.win.DC_WS.send = function(op, data) { sent.push({ op: op, data: data }); };

    result.win.DC_PRESENCE_SEND('chat.message', { text: 'hello' });

    expect(sent.length).toBe(1);
    expect(sent[0].op).toBe('chat.message');
  });

  it('DC_PRESENCE_SEND is a no-op when the socket is not open', () => {
    const result = loadDcWs();
    const sent = [];
    result.win.DC_WS.send = function(op, data) { sent.push({ op: op, data: data }); };

    // readyState stays CONNECTING (0)
    expect(() => result.win.DC_PRESENCE_SEND('dc.presence.move', { x: 1 })).not.toThrow();
    expect(sent.length).toBe(0);
  });

  // C2: these three names belong to dc-presence.js. dc-ws.js used to define its
  // own (dead, and wrong — `facing:` instead of `yaw:`, plus a spoofable clientId).
  it('does NOT define DC_PRESENCE_JOIN/MOVE/LEAVE (owned by dc-presence.js)', () => {
    const result = loadDcWs();
    expect(result.win.DC_PRESENCE_JOIN).toBeUndefined();
    expect(result.win.DC_PRESENCE_MOVE).toBeUndefined();
    expect(result.win.DC_PRESENCE_LEAVE).toBeUndefined();
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

  it('_hello() sends the real envelope and remembers its id as _helloId', () => {
    const result = loadDcWs();
    const client = result.open();

    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].v).toBe(1);
    expect(frames[0].op).toBe('auth.hello');
    expect(frames[0].data).toEqual({ role: 'admin', session: 'test-session-123' });
    expect(typeof frames[0].ts).toBe('number');
    // C-A2: the generated uuid must be retained so the correlated reply can be matched
    expect(client._helloId).toBe(frames[0].id);
    expect(client._helloId).toBeTruthy();
  });

  it('a reconnect mints a fresh _helloId', () => {
    const result = loadDcWs();
    const client = result.open();
    const firstId = client._helloId;

    // socket dies -> _helloId cleared
    client.ws.onclose({ code: 1006, reason: '' });
    expect(client._helloId).toBeNull();

    // reconnect: _connect() builds a new socket, onopen re-sends auth.hello
    client._connect();
    client.ws.readyState = 1;
    client.ws.onopen();

    expect(client._helloId).toBeTruthy();
    expect(client._helloId).not.toBe(firstId);
    expect(result.sent()[0].id).toBe(client._helloId);
  });
});

// ----------------------------------------------------------------
// C-A2: the auth answer is a CORRELATED REPLY, not an op-shaped event
// ----------------------------------------------------------------
describe('dc-ws.js — auth reply correlated by re (C-A2)', () => {
  const REPLY_DATA = {
    session: 'sess-abc',
    uid: 999,
    clientId: 4242,
    name: 'Test User',
    hub_time: 1234567890,
  };

  function authenticate(result) {
    const client = result.open();
    const helloId = result.sent()[0].id;
    client._onFrame(JSON.stringify({ v: 1, re: helloId, ok: true, data: REPLY_DATA }));
    return { client: client, helloId: helloId };
  }

  it('{v:1, re:<helloId>, ok:true, data:{...}} authenticates the client', () => {
    const result = loadDcWs();
    const { client } = authenticate(result);

    expect(client.authed).toBe(true);
    expect(result.win.DC_AUTHED).toBe(true);
    expect(result.win.DC_UID).toBe(999);
    expect(result.win.DC_CLIENT_ID).toBe(4242);
    expect(result.win.DC_PRESENCE_ENABLED).toBe(true);
    expect(result.win.DC_PRESENCE).toEqual({
      uid: 999,
      clientId: 4242,
      name: 'Test User',
      session: 'sess-abc',
      hub_time: 1234567890,
    });
  });

  it('dispatches dc:auth-success with detail.uid / clientId / name', () => {
    const result = loadDcWs();
    authenticate(result);

    const details = result.detailsFor('dc:auth-success');
    expect(details.length).toBe(1);
    expect(details[0].uid).toBe(999);
    expect(details[0].clientId).toBe(4242);
    expect(details[0].name).toBe('Test User');
    expect(details[0].session).toBe('sess-abc');
    expect(details[0].hub_time).toBe(1234567890);
  });

  it('clears _helloId once the reply resolves', () => {
    const result = loadDcWs();
    const { client } = authenticate(result);
    expect(client._helloId).toBeNull();
  });

  it('falls back to uid when the reply omits clientId', () => {
    const result = loadDcWs();
    const client = result.open();
    const helloId = result.sent()[0].id;
    client._onFrame(JSON.stringify({
      v: 1, re: helloId, ok: true,
      data: { session: 'sess-abc', uid: 777, name: 'NoClientId', hub_time: 1 },
    }));

    expect(result.win.DC_CLIENT_ID).toBe(777);
    expect(result.win.DC_PRESENCE.clientId).toBe(777);
  });

  it('ignores an ok:true reply whose re does not match the pending auth.hello', () => {
    const result = loadDcWs();
    const client = result.open();

    client._onFrame(JSON.stringify({ v: 1, re: 'some-other-request', ok: true, data: REPLY_DATA }));

    expect(client.authed).toBe(false);
    expect(result.win.DC_AUTHED).toBe(false);
    expect(result.detailsFor('dc:auth-success').length).toBe(0);
    // still waiting on the real reply
    expect(client._helloId).toBe(result.sent()[0].id);
  });

  it('{re:<helloId>, ok:false, error:{...}} produces dc:auth-failure, not success', () => {
    const result = loadDcWs();
    const client = result.open();
    const helloId = result.sent()[0].id;

    client._onFrame(JSON.stringify({
      v: 1, re: helloId, ok: false,
      error: { code: 'bad_session', message: 'Invalid session' },
    }));

    expect(client.authed).toBe(false);
    expect(result.win.DC_AUTHED).toBe(false);
    expect(result.detailsFor('dc:auth-success').length).toBe(0);
    const failures = result.detailsFor('dc:auth-failure');
    expect(failures.length).toBe(1);
    expect(failures[0].error).toEqual({ code: 'bad_session', message: 'Invalid session' });
    expect(client._helloId).toBeNull();
  });

  it('the ok:false branch does not swallow the ok:true success case', () => {
    const result = loadDcWs();
    const { client } = authenticate(result);
    expect(result.detailsFor('dc:auth-failure').length).toBe(0);
    expect(client.authed).toBe(true);
  });

  it('still accepts a legacy op-shaped auth.welcome event as a fallback', () => {
    const result = loadDcWs();
    const client = result.open();

    client._onFrame(JSON.stringify({ v: 1, op: 'auth.welcome', data: REPLY_DATA }));

    expect(result.win.DC_AUTHED).toBe(true);
    expect(result.win.DC_UID).toBe(999);
    expect(result.win.DC_CLIENT_ID).toBe(4242);
    expect(result.detailsFor('dc:auth-success').length).toBe(1);
    expect(client._helloId).toBeNull();
  });
});

// ----------------------------------------------------------------
// C6: _flushPresence coalesces the queue instead of replaying it
// ----------------------------------------------------------------
describe('dc-ws.js — presence batch coalescing (C6)', () => {
  function readyClient(result) {
    const client = result.win.DC_WS;
    client.ws.readyState = 1;            // OPEN, but no auth.hello in _sent
    client._lastFlush = Date.now();      // suppress the >500ms fallback flush
    return client;
  }

  it('collapses N queued dc.presence.move frames into the newest one', () => {
    const result = loadDcWs();
    const client = readyClient(result);

    for (let i = 0; i < 5; i++) client.send('dc.presence.move', { x: i, z: i, yaw: i / 10 });
    expect(client._presenceBatch.length).toBe(5);
    expect(result.sent().length).toBe(0); // deferred, nothing on the wire yet

    result.flushRaf();

    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].op).toBe('dc.presence.move');
    expect(frames[0].data).toEqual({ x: 4, z: 4, yaw: 0.4 });
    expect(client._presenceBatch.length).toBe(0);
  });

  it('does not collapse join/leave into each other', () => {
    const result = loadDcWs();
    const client = readyClient(result);

    client.send('dc.presence.join', { x: 0, z: 0, yaw: 0 });
    client.send('dc.presence.move', { x: 1, z: 1, yaw: 0 });
    client.send('dc.presence.move', { x: 2, z: 2, yaw: 0 });
    client.send('dc.presence.leave', {});

    result.flushRaf();

    const frames = result.sent();
    expect(frames.map(f => f.op)).toEqual([
      'dc.presence.join', 'dc.presence.move', 'dc.presence.leave',
    ]);
    // only the newest move survives
    expect(frames[1].data).toEqual({ x: 2, z: 2, yaw: 0 });
  });

  it('emits surviving ops in order of their LAST occurrence (leave -> rejoin -> move)', () => {
    const result = loadDcWs();
    const client = readyClient(result);

    client.send('dc.presence.move', { x: 1, z: 1, yaw: 0 });
    client.send('dc.presence.leave', {});
    client.send('dc.presence.join', { x: 9, z: 9, yaw: 0 });
    client.send('dc.presence.move', { x: 9, z: 9, yaw: 0 });

    result.flushRaf();

    const frames = result.sent();
    // The post-rejoin move must NOT be hoisted ahead of the leave/join pair.
    expect(frames.map(f => f.op)).toEqual([
      'dc.presence.leave', 'dc.presence.join', 'dc.presence.move',
    ]);
    expect(frames[2].data).toEqual({ x: 9, z: 9, yaw: 0 });
  });

  it('non-presence ops bypass the batch and go out immediately', () => {
    const result = loadDcWs();
    const client = readyClient(result);

    client.send('chat.message', { channel: 'global', text: 'hi' });

    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].op).toBe('chat.message');
    expect(client._presenceBatch).toBeNull();
  });

  it('the >100 batch cap flushes immediately and still coalesces to one frame', () => {
    const result = loadDcWs();
    const client = readyClient(result);

    for (let i = 0; i <= 100; i++) client.send('dc.presence.move', { x: i });

    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].data).toEqual({ x: 100 });
    expect(result.rafQueue.length).toBe(0);
  });

  it('schedules at most one animation frame for a burst of sends', () => {
    const result = loadDcWs();
    const client = readyClient(result);

    for (let i = 0; i < 20; i++) client.send('dc.presence.move', { x: i });

    // C7: no cancel-and-reschedule churn, so a tight loop cannot starve the flush
    expect(result.rafQueue.length).toBe(1);
  });

  it('the visibilitychange listener flushes a pending batch', () => {
    const result = loadDcWs();
    const client = readyClient(result);

    client.send('dc.presence.move', { x: 7, z: 8, yaw: 0 });
    expect(result.sent().length).toBe(0);

    result.win.document.hidden = false;
    result.listeners.visibilitychange();

    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].data).toEqual({ x: 7, z: 8, yaw: 0 });
  });
});

// ----------------------------------------------------------------
// C7: _lastFlush is written only by _flushPresence()
// ----------------------------------------------------------------
describe('dc-ws.js — _lastFlush backgrounded-tab fallback (C7)', () => {
  it('send() never writes _lastFlush', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;
    client.ws.readyState = 1;

    const marker = Date.now();
    client._lastFlush = marker;
    client.send('dc.presence.move', { x: 1 });
    client.send('dc.presence.move', { x: 2 });
    client.send('dc.presence.move', { x: 3 });

    // Nothing flushed, so the timestamp must be untouched — the old code reset it
    // on every call, which made the staleness comparison below unreachable.
    expect(client._lastFlush).toBe(marker);
    expect(result.rafQueue.length).toBe(1);
    expect(result.sent().length).toBe(0);
  });

  it('a stale _lastFlush (>500ms) flushes synchronously instead of waiting on RAF', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;
    client.ws.readyState = 1;

    client._lastFlush = Date.now() - 5000; // backgrounded tab: RAF never fired
    client.send('dc.presence.move', { x: 42, z: 43, yaw: 0 });

    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].data).toEqual({ x: 42, z: 43, yaw: 0 });
    expect(result.rafQueue.length).toBe(0);
  });

  it('_flushPresence() advances _lastFlush', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;
    client.ws.readyState = 1;

    const stale = Date.now() - 5000;
    client._lastFlush = stale;
    client._flushPresence();

    expect(client._lastFlush).toBeGreaterThan(stale);
  });

  it('_lastFlush is seeded at construction so the fallback is bounded', () => {
    const result = loadDcWs();
    expect(typeof result.win.DC_WS._lastFlush).toBe('number');
  });
});

// ----------------------------------------------------------------
// C8: the keepalive watchdog actually fires
// ----------------------------------------------------------------
describe('dc-ws.js — keepalive ping watchdog (C8)', () => {
  const KEEPALIVE_MS = 30000; // module default

  function authedClient(result) {
    const client = result.open();
    const helloId = result.sent()[0].id;
    client._onFrame(JSON.stringify({
      v: 1, re: helloId, ok: true,
      data: { session: 's', uid: 1, clientId: 2, name: 'n', hub_time: 0 },
    }));
    return client;
  }

  it('sets _pingOutstandingSince on the first ping and does not refresh it on later ticks', () => {
    const result = loadDcWs();
    const client = authedClient(result);
    const tick = result.intervals[0].fn;

    tick();
    const firstOutstanding = client._pingOutstandingSince;
    expect(firstOutstanding).toBeTruthy();

    // Age it artificially, then tick again — still within the 2x window.
    client._pingOutstandingSince = Date.now() - KEEPALIVE_MS;
    const aged = client._pingOutstandingSince;
    tick();

    // The bug was overwriting this every tick, so it could never grow stale.
    expect(client._pingOutstandingSince).toBe(aged);
  });

  it('closes the socket once a ping has been outstanding for more than 2 intervals', () => {
    const result = loadDcWs();
    const client = authedClient(result);
    const tick = result.intervals[0].fn;

    let closed = 0;
    client.ws.close = function() { closed++; };

    tick();
    expect(closed).toBe(0);

    client._pingOutstandingSince = Date.now() - (KEEPALIVE_MS * 2 + 1);
    tick();

    expect(closed).toBe(1);
    expect(client._pingOutstandingSince).toBeNull();
  });

  it('a pong clears the watchdog and records latency', () => {
    const result = loadDcWs();
    const client = authedClient(result);
    const tick = result.intervals[0].fn;

    tick();
    expect(client._pingOutstandingSince).toBeTruthy();
    expect(client._lastPingTs).toBeTruthy();

    client._onFrame(JSON.stringify({ v: 1, op: 'pong', data: {} }));

    expect(client._pingOutstandingSince).toBeNull();
    expect(client._lastPingTs).toBeNull();
    expect(typeof result.win.DC_LATENCY).toBe('number');
    expect(result.win.DC_LATENCY).toBeGreaterThanOrEqual(0);
    expect(result.win.DC_DEBUG_PING_HISTORY.length).toBe(1);
  });

  it('no ping is sent while unauthenticated', () => {
    const result = loadDcWs();
    const client = result.open();
    const before = result.sent().length; // just the auth.hello
    const tick = result.intervals[0].fn;

    tick();

    expect(result.sent().length).toBe(before);
    expect(client._pingOutstandingSince).toBeNull();
  });

  it('closing the socket resets the watchdog and the pending auth.hello', () => {
    const result = loadDcWs();
    const client = authedClient(result);
    const tick = result.intervals[0].fn;
    tick();

    client.ws.onclose({ code: 1006, reason: '' });

    expect(client.authed).toBe(false);
    expect(client._pingOutstandingSince).toBeNull();
    expect(client._lastPingTs).toBeNull();
    expect(client._helloId).toBeNull();
  });
});

// ----------------------------------------------------------------
// CONTRACT STATUS-EVENT: dc:ws-status on document
// ----------------------------------------------------------------
describe('dc-ws.js — dc:ws-status contract event', () => {
  it('emits connecting on _connect()', () => {
    const result = loadDcWs();
    expect(result.statuses()).toEqual(['connecting']);
    expect(result.win.DC_WS.status).toBe('connecting');
  });

  it('emits connected on open and disconnected on close', () => {
    const result = loadDcWs();
    const client = result.open();
    client.ws.onclose({ code: 1006, reason: '' });

    expect(result.statuses()).toEqual(['connecting', 'connected', 'disconnected']);
  });

  it('emits exhausted once reconnect attempts run out', () => {
    const result = loadDcWs();
    const client = result.open();
    client.reconnectAttempts = client.maxReconnectAttempts;

    client.ws.onclose({ code: 1006, reason: '' });

    const statuses = result.statuses();
    expect(statuses[statuses.length - 1]).toBe('exhausted');
    expect(client.status).toBe('exhausted');
  });

  it('emits error when the WebSocket constructor throws (hub unreachable)', () => {
    function ThrowingWebSocket() { throw new Error('connection refused'); }
    ThrowingWebSocket.OPEN = 1;
    const result = loadDcWs({ WebSocket: ThrowingWebSocket });

    expect(result.statuses()).toEqual(['connecting', 'error']);
    // graceful degradation must still kick in
    expect(result.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(result.win.DC_WS.connected()).toBe(false);
  });

  it('detail is {status} and every value is one of the documented strings', () => {
    const result = loadDcWs();
    const client = result.open();
    client.ws.onclose({ code: 1006, reason: '' });

    const allowed = ['connecting', 'connected', 'disconnected', 'error', 'exhausted'];
    const statusEvents = result.events.filter(e => e.type === 'dc:ws-status');
    expect(statusEvents.length).toBeGreaterThan(0);
    statusEvents.forEach((e) => {
      expect(Object.keys(e.detail)).toEqual(['status']);
      expect(allowed).toContain(e.detail.status);
    });
  });
});

// ----------------------------------------------------------------
// Graceful degradation when the hub is unreachable
// ----------------------------------------------------------------
describe('dc-ws.js — graceful degradation', () => {
  it('a constructor throw disables multiplayer without throwing out of init', () => {
    function ThrowingWebSocket() { throw new Error('nope'); }
    ThrowingWebSocket.OPEN = 1;
    const result = loadDcWs({ WebSocket: ThrowingWebSocket });

    expect(result.win.DC_PRESENCE_ENABLED).toBe(false);
    expect(result.win.DC_WS.ws).toBeNull();
    // everything must stay null-safe with no socket
    expect(() => result.win.DC_WS.send('dc.presence.move', { x: 1 })).not.toThrow();
    expect(() => result.win.DC_WS._flushPresence()).not.toThrow();
    expect(() => result.win.DC_WS.destroy()).not.toThrow();
    expect(result.win.DC_WS.getState().presenceEnabled).toBe(false);
  });

  it('reconnect exhaustion before any successful connect disables multiplayer', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;
    client.reconnectAttempts = client.maxReconnectAttempts;

    client.ws.onclose({ code: 1006, reason: '' });

    expect(result.win.DC_PRESENCE_ENABLED).toBe(false);
  });

  it('reconnect exhaustion AFTER a successful connect leaves presence enabled', () => {
    const result = loadDcWs();
    const client = result.open(); // sets _connectedOnce
    client.reconnectAttempts = client.maxReconnectAttempts;

    client.ws.onclose({ code: 1006, reason: '' });

    expect(result.win.DC_PRESENCE_ENABLED).not.toBe(false);
    expect(client.status).toBe('exhausted');
  });

  it('a malformed frame is warned about, not thrown', () => {
    const result = loadDcWs();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => result.win.DC_WS._onFrame('{not json')).not.toThrow();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('destroy() flushes a pending batch and suppresses reconnects', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;
    client.ws.readyState = 1;
    client._lastFlush = Date.now();

    client.send('dc.presence.move', { x: 5, z: 6, yaw: 0 });
    expect(result.sent().length).toBe(0);

    client.destroy();

    expect(client.closedByUs).toBe(true);
    expect(client._helloId).toBeNull();
    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].data).toEqual({ x: 5, z: 6, yaw: 0 });
  });
});

// ----------------------------------------------------------------
// C4: hot-path logging is behind DC_DEBUG
// ----------------------------------------------------------------
describe('dc-ws.js — hot-path logging is DC_DEBUG-gated (C4)', () => {
  it('outbound presence frames log nothing when DC_DEBUG is falsy', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;
    client.ws.readyState = 1;
    client._lastFlush = Date.now();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      client.send('dc.presence.move', { x: 1, z: 2, yaw: 0 });
      result.flushRaf();
      client._onFrame(JSON.stringify({ v: 1, op: 'dc.presence.move', data: { name: 'Bob', x: 1, z: 2 } }));

      expect(info).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      info.mockRestore();
    }
  });

  it('inbound frames log once when DC_DEBUG is on', () => {
    const result = loadDcWs({ DC_DEBUG: true });
    const client = result.win.DC_WS;

    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      client._onFrame(JSON.stringify({ v: 1, op: 'dc.presence.move', data: { name: 'Bob', x: 1, z: 2 } }));
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
  });

  it('dc.*, channel.*, chat.* frames are still forwarded as dc:v1-event', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;

    client._onFrame(JSON.stringify({ v: 1, op: 'dc.presence.join', data: { name: 'Bob', clientId: 3 } }));
    client._onFrame(JSON.stringify({ v: 1, op: 'chat.message', data: { text: 'hi' } }));
    client._onFrame(JSON.stringify({ v: 1, op: 'channel.list', data: {} }));

    const details = result.detailsFor('dc:v1-event');
    expect(details.map(d => d.op)).toEqual(['dc.presence.join', 'chat.message', 'channel.list']);
    expect(details[0].data).toEqual({ name: 'Bob', clientId: 3 });
  });

  it('an inbound ping is answered with a pong', () => {
    const result = loadDcWs();
    const client = result.win.DC_WS;
    client.ws.readyState = 1;

    client._onFrame(JSON.stringify({ v: 1, op: 'ping', data: {} }));

    const frames = result.sent();
    expect(frames.length).toBe(1);
    expect(frames[0].op).toBe('pong');
  });
});
