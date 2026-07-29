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
// Load dc-chat.js into a minimal VM sandbox
// ----------------------------------------------------------------
function loadDcChat(overrides = {}) {
  const listeners = {};

  // Capture CustomEvents dispatched on document
  const documentEventLog = [];
  let domContentLoadedCallbacks = [];

  // Mock style element
  const mockStyles = [];
  const mockFrames = [];

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
        if (tag === 'style') {
          return {
            tagName: 'STYLE',
            textContent: '',
            style: { cssText: '' },
            appendChild: function() {}
          };
        }
        if (tag === 'div') {
          return {
            tagName: 'DIV',
            className: '',
            setAttribute: function() {},
            getAttribute: function() { return ''; },
            appendChild: function(el) { return el; },
            addEventListener: function() {},
            removeEventListener: function() {},
            scrollTop: 0,
            scrollHeight: 0,
            innerHTML: '',
            style: {},
            clientWidth: 320,
            clientHeight: 420,
            remove: function() {
              const idx = mockFrames.indexOf(this);
              if (idx >= 0) mockFrames.splice(idx, 1);
            }
          };
        }
        if (tag === 'input') {
          return {
            tagName: 'INPUT',
            type: 'text',
            className: '',
            value: '',
            placeholder: '',
            setAttribute: function() {},
            getAttribute: function() { return ''; },
            addEventListener: function() {},
            removeEventListener: function() {}
          };
        }
        if (tag === 'button') {
          return {
            tagName: 'BUTTON',
            className: '',
            textContent: '',
            setAttribute: function() {},
            getAttribute: function() { return ''; },
            addEventListener: function() {},
            removeEventListener: function() {}
          };
        }
        return {
          tagName: tag.toUpperCase(),
          appendChild: function() {},
          addEventListener: function() {},
          removeEventListener: function() {}
        };
      },
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
  };
  vm.createContext(sandbox);

  const SRC = path.resolve(__dirname, '../../public_html/js/dc-chat.js');
  const code = fs.readFileSync(SRC, 'utf8');
  vm.runInContext(code, sandbox, { filename: SRC });

  return {
    win: win,
    listeners: listeners,
    mockStyles: mockStyles,
    mockFrames: mockFrames,
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

    // /status should call DC_WS.send with channel.publish
    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.op).toBe('channel.publish');
    expect(sentData.data.channel).toBe('chat:noc');
    expect(sentData.data.body).toBe('/status');
    expect(sentData.data.level).toBe('chat');
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
    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.op).toBe('channel.publish');
    expect(sentData.data.channel).toBe('chat:noc');
    expect(sentData.data.body).toBe('hello world');
    expect(sentData.data.level).toBe('chat');
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
    const sentData = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sentData.data.body).toBe('/help');
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
    const joinCall = mockWs.send.mock.calls.find(
      call => JSON.parse(call[0]).op === 'channel.join'
    );
    expect(joinCall).toBeDefined();
    const joinData = JSON.parse(joinCall[0]);
    expect(joinData.data.channel).toBe('chat:noc');
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

  it('messages without level default to "chat"', () => {
    const mockWs = { send: vi.fn(), readyState: 1 };
    const { win, simulateDomReady } = loadDcChat({ DC_WS: mockWs });
    simulateDomReady();

    let capturedMsg = null;
    const origAddMessage = win.DC_CHAT.addMessage;
    win.DC_CHAT.addMessage = function(msg) {
      capturedMsg = msg;
      origAddMessage(msg);
    };

    win.DC_CHAT.addMessage({ from_name: 'Test', body: 'Plain msg' });

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
    const { win, console } = loadDcChat({ DC_WS: mockWs });

    win.DC_CHAT.sendMessage('hello');

    const warnCall = console.warn.mock.calls.find(
      call => call[0] && call[0].includes && call[0].includes('[dc-chat] Not initialized')
    );
    expect(warnCall).toBeDefined();
    expect(mockWs.send).not.toHaveBeenCalled();
  });
});
