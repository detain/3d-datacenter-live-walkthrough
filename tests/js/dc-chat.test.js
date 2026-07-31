/**
 * Unit tests for public_html/js/dc-chat.js
 *
 * Tests the /status command handling, message sending, message rendering,
 * and the DC_CHAT public API (init, sendMessage, addMessage, clearMessages, destroy).
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// ----------------------------------------------------------------
// Minimal element stub — enough of the DOM surface for dc-chat.js
// (className/classList/textContent/appendChild/remove/addEventListener).
// ----------------------------------------------------------------
function makeEl(tag, mockFrames) {
  const classes = new Set();
  const handlers = {};
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    type: '',
    value: '',
    placeholder: '',
    style: { cssText: '' },
    scrollTop: 0,
    scrollHeight: 0,
    clientWidth: 320,
    clientHeight: 420,
    children: [],
    handlers: handlers,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
      get length() { return classes.size; }
    },
    setAttribute: function () {},
    getAttribute: function () { return ''; },
    appendChild: function (child) { el.children.push(child); return child; },
    removeChild: function (child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    addEventListener: function (evt, cb) {
      if (!handlers[evt]) handlers[evt] = [];
      handlers[evt].push(cb);
    },
    removeEventListener: function (evt, cb) {
      if (!handlers[evt]) return;
      const i = handlers[evt].indexOf(cb);
      if (i >= 0) handlers[evt].splice(i, 1);
    },
    dispatch: function (evt, arg) {
      (handlers[evt] || []).slice().forEach((cb) => cb(arg || { type: evt, preventDefault() {} }));
    },
    focus: function () {},
    blur: function () {},
    remove: function () {
      if (mockFrames) {
        const idx = mockFrames.indexOf(el);
        if (idx >= 0) mockFrames.splice(idx, 1);
      }
    }
  };
  return el;
}

// ----------------------------------------------------------------
// Load dc-chat.js into a minimal VM sandbox
//
// options.localStorage:
//   undefined       — no localStorage global at all (storage-less host)
//   'throwing'      — accessing the global throws (Safari private / sandboxed iframe)
//   'setThrows'     — readable, but setItem() throws (quota / partitioned storage)
//   { key: value }  — a working store seeded with these entries
// options.noToggleButton — document.getElementById returns null for #dcWsToggle
// ----------------------------------------------------------------
function loadDcChat(overrides = {}, options = {}) {
  const listeners = {};

  let domContentLoadedCallbacks = [];

  // Mock style element
  const mockStyles = [];
  const mockFrames = [];

  // #dcWsToggle lives in the page markup (dc.html), not in the chat frame
  const toggleBtn = makeEl('button');
  toggleBtn.textContent = 'Chat: ON';

  const win = {
    DC_WS: null,
    DC_PRESENCE: null,
    DC_SESSION_ID: 'test-session-123',

    // CustomEvent capture
    CustomEvent: class CustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
        this.bubbles = options?.bubbles ?? false;
      }
    },

    // document simulation
    document: {
      readyState: 'complete',
      head: {
        appendChild: function(el) {
          if (el.tagName === 'STYLE') {
            mockStyles.push(el);
          }
          return el;
        }
      },
      body: {
        appendChild: function(el) {
          if (el.className === 'dc-chat-frame') {
            mockFrames.push(el);
          }
          return el;
        }
      },
      createElement: function(tag) {
        if (options.brokenCreateElement) throw new Error('DOM unavailable');
        return makeEl(tag, mockFrames);
      },
      getElementById: function(id) {
        if (id === 'dcWsToggle' && !options.noToggleButton) return toggleBtn;
        return null;
      },
      querySelector: function() { return null; },
      addEventListener: function(evt, cb) {
        if (evt === 'dc:auth-success' || evt === 'dc:v1-event') {
          if (!listeners[evt]) listeners[evt] = [];
          listeners[evt].push(cb);
        }
        if (evt === 'DOMContentLoaded') {
          domContentLoadedCallbacks.push(cb);
        }
      },
      removeEventListener: function(evt, cb) {
        if (listeners[evt]) {
          const idx = listeners[evt].indexOf(cb);
          if (idx >= 0) listeners[evt].splice(idx, 1);
        }
      },
      dispatchEvent: function(evt) {
        return true;
      },
      createEvent: function() {
        return {
          initCustomEvent: function() {}
        };
      }
    },

    // console capture
    console: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    },

    // crypto for UUID
    crypto: {
      randomUUID: function() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
      }
    },

    // Workerman Timer stub
    setTimeout: function(fn, delay) { return 0; },
    clearTimeout: function() {},

    // scroll-to-bottom hook used by _renderMessage
    requestAnimationFrame: function(cb) { cb(0); return 1; },

    // location
    location: { search: '' },

    // URLSearchParams
    URLSearchParams: class URLSearchParams {
      constructor(search) {
        this._search = search;
      }
      get(key) { return null; }
    },
  };

  // Apply overrides
  Object.keys(overrides).forEach(function(key) {
    win[key] = overrides[key];
  });
  win.window = win;
  win.self = win;

  const sandbox = {
    window: win,
    document: win.document,
    console: win.console,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    crypto: win.crypto,
    URLSearchParams: win.URLSearchParams,
    location: win.location,
    requestAnimationFrame: win.requestAnimationFrame,
  };

  // localStorage: absent by default. dc-chat.js must survive every one of these.
  const storageLog = { gets: 0, sets: [], reads: 0 };
  if (options.localStorage === 'throwing') {
    Object.defineProperty(sandbox, 'localStorage', {
      configurable: true,
      get() { storageLog.reads++; throw new Error('SecurityError: storage is disabled'); }
    });
  } else if (options.localStorage === 'setThrows') {
    sandbox.localStorage = {
      getItem: function() { storageLog.gets++; return null; },
      setItem: function() { throw new Error('QuotaExceededError'); }
    };
  } else if (options.localStorage && typeof options.localStorage === 'object') {
    const store = Object.assign({}, options.localStorage);
    sandbox.localStorage = {
      getItem: function(k) { storageLog.gets++; return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function(k, v) { storageLog.sets.push([k, v]); store[k] = String(v); },
      _store: store
    };
  }
  // mirror onto window too (reading it back must not trip the throwing variant)
  if (options.localStorage === 'throwing') {
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get() { throw new Error('SecurityError: storage is disabled'); }
    });
  } else if (options.localStorage) {
    win.localStorage = sandbox.localStorage;
  }

  vm.createContext(sandbox);

  const SRC = path.resolve(__dirname, '../../public_html/js/dc-chat.js');
  const code = fs.readFileSync(SRC, 'utf8');
  vm.runInContext(code, sandbox, { filename: SRC });

  return {
    win: win,
    listeners: listeners,
    mockStyles: mockStyles,
    mockFrames: mockFrames,
    // sandbox console (vi.fn spies) — tests destructure this as `console`
    console: win.console,
    toggleBtn: toggleBtn,
    storageLog: storageLog,
    // Click the #dcWsToggle button
    clickToggle: function() {
      toggleBtn.dispatch('click', { type: 'click', preventDefault() {} });
    },
    // Simulate DOMContentLoaded having already fired
    simulateDomReady: function() {
      // Trigger any DOMContentLoaded callbacks
      domContentLoadedCallbacks.forEach(function(cb) {
        cb({ target: win.document });
      });
    },
    // Fire a custom event on document
    fireDocumentEvent: function(eventName, detail) {
      const cbs = listeners[eventName] || [];
      const evt = new win.CustomEvent(eventName, { detail: detail, bubbles: true });
      cbs.forEach(function(cb) { cb(evt); });
    }
  };
}

// DC_WS.send(op, data) takes TWO positional args — collect them as {op, data} pairs.
function sentFrames(mockWs) {
  return mockWs.send.mock.calls.map((call) => ({ op: call[0], data: call[1] }));
}

// ----------------------------------------------------------------
// Tests: DC_CHAT public API exists and has required methods
// ----------------------------------------------------------------
describe('dc-chat.js — DC_CHAT public API', () => {
  it('DC_CHAT exists after DOMContentLoaded', () => {
    const { win, simulateDomReady } = loadDcChat();
    simulateDomReady();
    expect(win.DC_CHAT).toBeDefined();
    expect(typeof win.DC_CHAT).toBe('object');
  });

  it('DC_CHAT has required methods: init, sendMessage, addMessage, clearMessages, destroy', () => {
    const { win, simulateDomReady } = loadDcChat();
    simulateDomReady();
    expect(typeof win.DC_CHAT.init).toBe('function');
    expect(typeof win.DC_CHAT.sendMessage).toBe('function');
    expect(typeof win.DC_CHAT.addMessage).toBe('function');
    expect(typeof win.DC_CHAT.clearMessages).toBe('function');
    expect(typeof win.DC_CHAT.destroy).toBe('function');
  });
});

// ----------------------------------------------------------------
// Tests: /status command handling (now sent to server)
// ----------------------------------------------------------------
describe('dc-chat.js — /status command (server-side)', () => {
  it('/status is sent via DC_WS.send with channel.publish op', () => {
    const mockWs = {
      send: vi.fn(),
      readyState: 1 // OPEN
    };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    win.DC_CHAT.sendMessage('/status');

    // /status should call DC_WS.send('channel.publish', {...})
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = sentFrames(mockWs)[0];
    expect(sent.op).toBe('channel.publish');
    expect(sent.data.channel).toBe('chat:noc');
    expect(sent.data.body).toBe('/status');
    expect(sent.data.level).toBe('chat');
  });

  it('renders Status Bot channel.message response correctly', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady, fireDocumentEvent } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    let capturedMsg = null;
    const origAddMessage = win.DC_CHAT.addMessage;
    win.DC_CHAT.addMessage = function(msg) {
      capturedMsg = msg;
      origAddMessage(msg);
    };

    // Simulate server response: Status Bot sending status info
    fireDocumentEvent('dc:v1-event', {
      op: 'channel.message',
      data: {
        channel: 'chat:noc',
        from: 'status-bot',
        from_name: 'Status Bot',
        body: 'Status: OK | Clients: 5 | Channels: 3',
        level: 'chat',
        ts: 1719700000
      }
    });

    expect(capturedMsg).not.toBeNull();
    expect(capturedMsg.from_name).toBe('Status Bot');
    expect(capturedMsg.body).toBe('Status: OK | Clients: 5 | Channels: 3');
    expect(capturedMsg.level).toBe('chat');
  });
});

// ----------------------------------------------------------------
// Tests: Regular messages sent via DC_WS
// ----------------------------------------------------------------
describe('dc-chat.js — regular message sending', () => {
  it('Regular message is sent via DC_WS.send with channel.publish op', () => {
    const mockWs = {
      send: vi.fn(),
      readyState: 1
    };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    win.DC_CHAT.sendMessage('hello world');

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = sentFrames(mockWs)[0];
    expect(sent.op).toBe('channel.publish');
    expect(sent.data.channel).toBe('chat:noc');
    expect(sent.data.body).toBe('hello world');
    expect(sent.data.level).toBe('chat');
  });

  it('Message is not sent when DC_WS is unavailable', () => {
    const { win, simulateDomReady, console } = loadDcChat({ DC_WS: null });
    simulateDomReady();

    win.DC_CHAT.sendMessage('hello world');

    expect(console.warn).toHaveBeenCalled();
    const warnCall = console.warn.mock.calls.find(
      call => call[0] && call[0].includes && call[0].includes('[dc-chat] DC_WS not available')
    );
    expect(warnCall).toBeDefined();
  });

  it('Empty message is not sent', () => {
    const mockWs = {
      send: vi.fn(),
      readyState: 1
    };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    win.DC_CHAT.sendMessage('');
    expect(mockWs.send).not.toHaveBeenCalled();

    win.DC_CHAT.sendMessage('   ');
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('Non-/status commands starting with / are sent as regular messages', () => {
    const mockWs = {
      send: vi.fn(),
      readyState: 1
    };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    win.DC_CHAT.sendMessage('/help');

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    expect(sentFrames(mockWs)[0].data.body).toBe('/help');
  });
});

// ----------------------------------------------------------------
// Tests: addMessage function
// ----------------------------------------------------------------
describe('dc-chat.js — addMessage', () => {
  it('addMessage renders a message without crashing when not initialized', () => {
    const { win } = loadDcChat();
    // Should not throw even if not initialized
    expect(() => {
      win.DC_CHAT.addMessage({ from_name: 'Test', body: 'Hello', level: 'chat' });
    }).not.toThrow();
  });

  it('addMessage handles various message levels without crashing', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    const levels = ['chat', 'info', 'warn', 'error', 'system'];
    levels.forEach(level => {
      expect(() => {
        win.DC_CHAT.addMessage({ from_name: 'Test', body: 'Test', level: level });
      }).not.toThrow();
    });
  });

  it('addMessage handles null/undefined msg gracefully', () => {
    const { win, simulateDomReady } = loadDcChat();
    simulateDomReady();

    expect(() => {
      win.DC_CHAT.addMessage(null);
    }).not.toThrow();

    expect(() => {
      win.DC_CHAT.addMessage(undefined);
    }).not.toThrow();
  });
});

// ----------------------------------------------------------------
// Tests: clearMessages function
// ----------------------------------------------------------------
describe('dc-chat.js — clearMessages', () => {
  it('clearMessages does not crash when not initialized', () => {
    const { win } = loadDcChat();
    expect(() => {
      win.DC_CHAT.clearMessages();
    }).not.toThrow();
  });
});

// ----------------------------------------------------------------
// Tests: destroy function
// ----------------------------------------------------------------
describe('dc-chat.js — destroy', () => {
  it('destroy does not crash when not initialized', () => {
    const { win } = loadDcChat();
    expect(() => {
      win.DC_CHAT.destroy();
    }).not.toThrow();
  });

  it('destroy removes the chat frame from DOM', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady, mockFrames } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    expect(mockFrames.length).toBe(1); // Frame was created on init
    win.DC_CHAT.destroy();
    expect(mockFrames.length).toBe(0); // Frame should be removed
  });

  it('destroy can be called multiple times safely', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    expect(() => {
      win.DC_CHAT.destroy();
      win.DC_CHAT.destroy();
      win.DC_CHAT.destroy();
    }).not.toThrow();
  });
});

// ----------------------------------------------------------------
// Tests: WebSocket event handlers
// ----------------------------------------------------------------
describe('dc-chat.js — WebSocket event handlers', () => {
  it('handles dc:auth-success event', () => {
    const mockWs = {
      send: vi.fn(),
      readyState: 1
    };
    const { win, simulateDomReady, fireDocumentEvent } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    fireDocumentEvent('dc:auth-success', {});

    // After auth success, should join the NOC channel
    expect(mockWs.send).toHaveBeenCalled();
    const joinCall = sentFrames(mockWs).find((f) => f.op === 'channel.join');
    expect(joinCall).toBeDefined();
    expect(joinCall.data.channel).toBe('chat:noc');
  });

  it('joins chat:noc on init when auth already happened (missed dc:auth-success)', () => {
    // hub connects independently of the chat toggle, so a chat that boots disabled and is
    // switched on later never sees dc:auth-success — it must still subscribe.
    const mockWs = makeWsStub({ connected: true, ws: makeSock(1) });
    const { mockFrames, clickToggle } = loadDcChat(
      { DC_WS: mockWs, DC_AUTHED: true },
      { localStorage: { dc_ws_enabled: 'false' } }
    );

    expect(mockFrames.length).toBe(0);
    expect(mockWs.send).not.toHaveBeenCalled();

    clickToggle();   // Chat: ON

    expect(mockFrames.length).toBe(1);
    const joinCall = sentFrames(mockWs).find((f) => f.op === 'channel.join');
    expect(joinCall).toBeDefined();
    expect(joinCall.data.channel).toBe('chat:noc');
  });

  it('does not join on init when not yet authenticated', () => {
    const mockWs = makeWsStub({ connected: true, ws: makeSock(1) });
    loadDcChat({ DC_WS: mockWs });   // DC_AUTHED undefined

    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('handles dc:v1-event with channel.message op', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady, fireDocumentEvent } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    let capturedMsg = null;
    const origAddMessage = win.DC_CHAT.addMessage;
    win.DC_CHAT.addMessage = function(msg) {
      capturedMsg = msg;
      origAddMessage(msg);
    };

    fireDocumentEvent('dc:v1-event', {
      op: 'channel.message',
      data: {
        channel: 'chat:noc',
        from: 'admin-1',
        from_name: 'TestAdmin',
        body: 'Hello from server',
        level: 'chat',
        ts: 1719700000
      }
    });

    expect(capturedMsg).not.toBeNull();
    expect(capturedMsg.from_name).toBe('TestAdmin');
    expect(capturedMsg.body).toBe('Hello from server');
    expect(capturedMsg.level).toBe('chat');
  });

  it('handles dc:v1-event with chat.message op', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady, fireDocumentEvent } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    let capturedMsg = null;
    const origAddMessage = win.DC_CHAT.addMessage;
    win.DC_CHAT.addMessage = function(msg) {
      capturedMsg = msg;
      origAddMessage(msg);
    };

    fireDocumentEvent('dc:v1-event', {
      op: 'chat.message',
      data: {
        from: 'host-5',
        from_name: 'HostFive',
        body: 'DM message',
        level: 'chat',
        ts: 1719700001
      }
    });

    expect(capturedMsg).not.toBeNull();
    expect(capturedMsg.from_name).toBe('HostFive');
    expect(capturedMsg.body).toBe('DM message');
  });

  it('ignores dc:v1-event with missing op', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady, fireDocumentEvent, console } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    fireDocumentEvent('dc:v1-event', { data: {} });

    // Should not warn about missing op (it's a silent no-op)
    expect(console.warn).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// Tests: _msgClass helper (message CSS class determination)
// ----------------------------------------------------------------
describe('dc-chat.js — _msgClass helper (via addMessage)', () => {
  it('system messages get correct class', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    // System messages are added directly via addMessage
    let capturedMsg = null;
    const origAddMessage = win.DC_CHAT.addMessage;
    win.DC_CHAT.addMessage = function(msg) {
      capturedMsg = msg;
    };

    win.DC_CHAT.addMessage({ from_name: 'system', body: 'System message', level: 'info' });

    expect(capturedMsg.level).toBe('info');
    expect(capturedMsg.from_name).toBe('system');
  });
});

// ----------------------------------------------------------------
// Tests: message level styling
// ----------------------------------------------------------------
describe('dc-chat.js — message level handling', () => {
  it('messages with level "info" are accepted', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    expect(() => {
      win.DC_CHAT.addMessage({ from_name: 'Test', body: 'Info msg', level: 'info' });
    }).not.toThrow();
  });

  it('messages with level "warn" are accepted', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    expect(() => {
      win.DC_CHAT.addMessage({ from_name: 'Test', body: 'Warn msg', level: 'warn' });
    }).not.toThrow();
  });

  it('messages with level "error" are accepted', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    expect(() => {
      win.DC_CHAT.addMessage({ from_name: 'Test', body: 'Error msg', level: 'error' });
    }).not.toThrow();
  });

  it('incoming messages without a level default to "chat"', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady, fireDocumentEvent } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    let capturedMsg = null;
    const origAddMessage = win.DC_CHAT.addMessage;
    win.DC_CHAT.addMessage = function(msg) {
      capturedMsg = msg;
      origAddMessage(msg);
    };

    // the level default is applied when normalising server events, not in addMessage()
    fireDocumentEvent('dc:v1-event', {
      op: 'channel.message',
      data: { channel: 'chat:noc', from: 'admin-1', from_name: 'Test', body: 'Plain msg' }
    });

    expect(capturedMsg).not.toBeNull();
    expect(capturedMsg.level).toBe('chat');
  });
});

// ----------------------------------------------------------------
// Tests: init is idempotent
// ----------------------------------------------------------------
describe('dc-chat.js — init idempotency', () => {
  it('init can be called multiple times without error', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });

    expect(() => {
      win.DC_CHAT.init();
      win.DC_CHAT.init();
      win.DC_CHAT.init();
    }).not.toThrow();
  });

  it('sendMessage before init logs a warning', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    // chat disabled in storage => _boot() creates the API but never calls init()
    const { win, console } = loadDcChat({ DC_WS: mockWs }, { localStorage: { dc_ws_enabled: 'false' } });

    win.DC_CHAT.sendMessage('hello');

    const warnCall = console.warn.mock.calls.find(
      call => call[0] && call[0].includes && call[0].includes('[dc-chat] Not initialized')
    );
    expect(warnCall).toBeDefined();
    expect(mockWs.send).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// Helpers for the storage / toggle tests
// ----------------------------------------------------------------

/** Fake WebSocket with just the bits _reviveWs() inspects. */
function makeSock(readyState) {
  const handlers = {};
  return {
    readyState: readyState,
    addEventListener: function (evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); },
    removeEventListener: function () {},
    fire: function (evt) { (handlers[evt] || []).slice().forEach((cb) => cb({ type: evt })); },
    listenerCount: function (evt) { return (handlers[evt] || []).length; }
  };
}

/**
 * Stub of the dc-ws.js Client surface dc-chat.js is allowed to touch:
 * send(op, data) / connected() / destroy() / _connect() / closedByUs / ws.
 * NOTE: dc-ws has NO close() method — a stub that grew one would hide bug C9.
 */
function makeWsStub(opts = {}) {
  const stub = {
    closedByUs: false,
    reconnectAttempts: opts.reconnectAttempts ?? 0,
    maxReconnectAttempts: 10,
    ws: opts.ws || null,
    send: vi.fn(),
    connected: vi.fn(function () { return !!opts.connected; }),
    _connect: vi.fn(function () { stub.closedByUs = false; }),
    destroy: vi.fn(function () {
      stub.closedByUs = true;
      // 2 === CLOSING (close handshake still in flight), 3 === CLOSED
      if (stub.ws) stub.ws.readyState = opts.closingOnDestroy ? 2 : 3;
      opts.connected = false;
    })
  };
  return stub;
}

// ----------------------------------------------------------------
// Tests: C10 — _boot must survive an unusable localStorage
// ----------------------------------------------------------------
describe('dc-chat.js — localStorage is optional (C10)', () => {
  it('_boot survives a completely absent localStorage', () => {
    // default sandbox has no localStorage global at all
    const mockWs = makeWsStub();
    const { win, mockFrames } = loadDcChat({ DC_WS: mockWs });

    expect(win.DC_CHAT).toBeDefined();
    expect(typeof win.DC_CHAT.init).toBe('function');
    // falls back to the in-memory default (enabled) and still builds the UI
    expect(mockFrames.length).toBe(1);
  });

  it('_boot survives a localStorage global whose getter throws', () => {
    const mockWs = makeWsStub();
    const { win, mockFrames, storageLog } = loadDcChat(
      { DC_WS: mockWs },
      { localStorage: 'throwing' }
    );

    expect(storageLog.reads).toBeGreaterThan(0);   // we really did touch it
    expect(win.DC_CHAT).toBeDefined();
    expect(mockFrames.length).toBe(1);             // default = chat enabled
  });

  it('a throwing localStorage does not break the toggle button either', () => {
    const mockWs = makeWsStub();
    const { win, mockFrames, clickToggle, toggleBtn } = loadDcChat(
      { DC_WS: mockWs },
      { localStorage: 'throwing' }
    );

    expect(() => clickToggle()).not.toThrow();
    expect(toggleBtn.textContent).toBe('Chat: OFF');
    expect(mockFrames.length).toBe(0);
    expect(mockWs.destroy).toHaveBeenCalledTimes(1);
  });

  it('a localStorage whose setItem throws does not break the toggle', () => {
    const mockWs = makeWsStub();
    const { clickToggle, toggleBtn, mockFrames } = loadDcChat(
      { DC_WS: mockWs },
      { localStorage: 'setThrows' }
    );

    expect(() => clickToggle()).not.toThrow();
    expect(toggleBtn.textContent).toBe('Chat: OFF');
    expect(mockFrames.length).toBe(0);
  });

  it('honours a stored dc_ws_enabled=false (chat stays down, button reads OFF)', () => {
    const mockWs = makeWsStub();
    const { win, mockFrames, toggleBtn } = loadDcChat(
      { DC_WS: mockWs },
      { localStorage: { dc_ws_enabled: 'false' } }
    );

    expect(win.DC_CHAT).toBeDefined();
    expect(mockFrames.length).toBe(0);
    expect(toggleBtn.textContent).toBe('Chat: OFF');
    expect(toggleBtn.classList.contains('off')).toBe(true);
  });

  it('honours a stored dc_ws_enabled=true and persists toggle changes', () => {
    const mockWs = makeWsStub();
    const { mockFrames, clickToggle, storageLog } = loadDcChat(
      { DC_WS: mockWs },
      { localStorage: { dc_ws_enabled: 'true' } }
    );

    expect(mockFrames.length).toBe(1);
    clickToggle();
    expect(storageLog.sets).toEqual([['dc_ws_enabled', 'false']]);
  });

  it('_boot never throws even when building the frame fails', () => {
    const mockWs = makeWsStub();
    let result;
    expect(() => {
      result = loadDcChat({ DC_WS: mockWs }, { brokenCreateElement: true });
    }).not.toThrow();

    expect(result.win.DC_CHAT).toBeDefined();
    const warned = result.console.warn.mock.calls.find(
      (call) => call[0] && call[0].includes && call[0].includes('[dc-chat] init failed')
    );
    expect(warned).toBeDefined();
  });

  it('_boot still defines DC_CHAT when #dcWsToggle is missing', () => {
    const mockWs = makeWsStub();
    const { win, mockFrames } = loadDcChat({ DC_WS: mockWs }, { noToggleButton: true });

    expect(win.DC_CHAT).toBeDefined();
    expect(mockFrames.length).toBe(1);
  });
});

// ----------------------------------------------------------------
// Tests: C9 — "Chat: OFF" must actually close the hub socket
// ----------------------------------------------------------------
describe('dc-chat.js — chat toggle tears down the socket (C9)', () => {
  it('toggling OFF calls DC_WS.destroy() (dc-ws has no close())', () => {
    const mockWs = makeWsStub({ connected: true, ws: makeSock(1) });
    const { clickToggle, mockFrames, toggleBtn } = loadDcChat({ DC_WS: mockWs });

    expect(mockFrames.length).toBe(1);
    clickToggle();

    expect(mockWs.destroy).toHaveBeenCalledTimes(1);
    expect(mockWs.closedByUs).toBe(true);
    expect(mockFrames.length).toBe(0);
    expect(toggleBtn.textContent).toBe('Chat: OFF');
    expect(toggleBtn.classList.contains('off')).toBe(true);
  });

  it('toggling OFF does not throw when DC_WS is absent (no hub / offline)', () => {
    const { win, clickToggle, toggleBtn, mockFrames } = loadDcChat({ DC_WS: null });

    expect(() => clickToggle()).not.toThrow();
    expect(toggleBtn.textContent).toBe('Chat: OFF');
    expect(mockFrames.length).toBe(0);

    // ...and back on, still without a socket
    expect(() => clickToggle()).not.toThrow();
    expect(toggleBtn.textContent).toBe('Chat: ON');
    expect(mockFrames.length).toBe(1);
    expect(win.DC_CHAT).toBeDefined();
  });

  it('toggling OFF ignores a legacy stub that only exposes close()', () => {
    const legacy = { send: vi.fn(), close: vi.fn(), closedByUs: false };
    const { clickToggle, toggleBtn } = loadDcChat({ DC_WS: legacy });

    expect(() => clickToggle()).not.toThrow();
    expect(toggleBtn.textContent).toBe('Chat: OFF');
    // no destroy() to call — but the UI still goes down instead of throwing
    expect(legacy.close).not.toHaveBeenCalled();
  });

  it('toggling back ON revives the destroyed client via _connect()', () => {
    const sock = makeSock(1);
    const mockWs = makeWsStub({ connected: true, ws: sock });
    const { clickToggle, mockFrames } = loadDcChat({ DC_WS: mockWs });

    clickToggle();                       // OFF
    expect(mockWs.closedByUs).toBe(true);

    clickToggle();                       // ON
    expect(mockWs._connect).toHaveBeenCalledTimes(1);
    expect(mockWs.closedByUs).toBe(false);
    expect(mockWs.reconnectAttempts).toBe(0);
    expect(mockFrames.length).toBe(1);
  });

  it('defers the revive while the previous socket is still CLOSING', () => {
    const sock = makeSock(1);
    const mockWs = makeWsStub({ connected: true, ws: sock, closingOnDestroy: true });
    const { clickToggle } = loadDcChat({ DC_WS: mockWs });

    clickToggle();                       // OFF -> socket stuck in CLOSING
    expect(sock.readyState).toBe(2);

    clickToggle();                       // ON while still closing
    // must NOT connect yet, and must keep closedByUs set so dc-ws's own onclose
    // handler doesn't schedule a competing reconnect
    expect(mockWs._connect).not.toHaveBeenCalled();
    expect(mockWs.closedByUs).toBe(true);
    expect(sock.listenerCount('close')).toBe(1);

    sock.readyState = 3;
    sock.fire('close');                  // handshake finishes
    expect(mockWs._connect).toHaveBeenCalledTimes(1);
    expect(mockWs.closedByUs).toBe(false);
  });

  it('reviving a still-open socket only re-arms the reconnect loop', () => {
    const sock = makeSock(1);
    const mockWs = makeWsStub({ connected: true, ws: sock });
    const { clickToggle } = loadDcChat({ DC_WS: mockWs });

    clickToggle();                       // OFF
    mockWs.closedByUs = true;
    mockWs.connected.mockReturnValue(true);   // pretend the close never landed

    clickToggle();                       // ON
    expect(mockWs._connect).not.toHaveBeenCalled();
    expect(mockWs.closedByUs).toBe(false);
  });

  it('the toggle handler is bound once, so OFF/ON/OFF ends up OFF', () => {
    const mockWs = makeWsStub({ connected: true, ws: makeSock(1) });
    const { clickToggle, toggleBtn, mockFrames } = loadDcChat({ DC_WS: mockWs });

    clickToggle();                       // OFF
    clickToggle();                       // ON  (re-init must not stack a 2nd handler)
    clickToggle();                       // OFF

    expect(toggleBtn.textContent).toBe('Chat: OFF');
    expect(mockFrames.length).toBe(0);
    expect(mockWs.destroy).toHaveBeenCalledTimes(2);
  });
});
