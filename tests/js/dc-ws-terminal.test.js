/**
 * Unit tests for public_html/js/ws_terminal.js
 *
 * The browser client is an IIFE that attaches only `WsTerminal` to `window`, so
 * its private helpers (b64*, envelope, uuidv4) are not directly reachable and
 * are NOT tested here (see the closure note at the bottom). What IS reachable as
 * a real, un-refactored public surface:
 *
 *   - the constructor's config normalization (scope/command/host/url + defaults)
 *   - WsTerminal.prototype.scheduleReconnect() exponential-backoff math and its
 *     give-up-after-maxReconnectAttempts behaviour
 *   - WsTerminal.prototype.send() readyState gating
 *
 * We load the real, unmodified source into a `vm` sandbox with a minimal fake
 * `window`/`document`, so these assertions exercise the shipped code as-is.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.resolve(__dirname, '../../public_html/js/ws_terminal.js');

/** Build a fresh sandbox `window` and evaluate ws_terminal.js into it. */
function loadWsTerminal(overrides) {
    const listeners = {};
    const win = {
        // WsTerminal reads global.WebSocket only when connecting; give it the
        // shape the code checks (readyState OPEN constant) so send()/state
        // logic can be exercised without a real socket.
        WebSocket: { OPEN: 1 },
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        addEventListener: () => {},
        setTimeout: () => 0,
        clearTimeout: () => {}
    };
    // The source references `document.addEventListener` at load time (auto-start
    // hook). Provide a stub so evaluation does not throw.
    const doc = { addEventListener: (evt, cb) => { listeners[evt] = cb; } };
    win.document = doc;
    Object.assign(win, overrides || {});
    win.window = win;
    win.self = win;
    // Bare `setTimeout`/`clearTimeout` inside the IIFE resolve to the vm context
    // globals (not window.*), so expose them at the sandbox top level too. An
    // override's setTimeout spy must therefore land here.
    const sandbox = {
        window: win,
        document: doc,
        console,
        setTimeout: win.setTimeout,
        clearTimeout: win.clearTimeout
    };
    vm.createContext(sandbox);
    const code = fs.readFileSync(SRC, 'utf8');
    vm.runInContext(code, sandbox, { filename: SRC });
    return { win, WsTerminal: win.WsTerminal, listeners };
}

test('exposes WsTerminal constructor on window', () => {
    const { WsTerminal } = loadWsTerminal();
    expect(typeof WsTerminal).toBe('function');
});

test('constructor copies url/session/host and defaults command to empty string', () => {
    const { WsTerminal } = loadWsTerminal();
    const t = new WsTerminal({ url: 'wss://h:7272', session: 'sess-1', host: 42 });
    expect(t.url).toBe('wss://h:7272');
    expect(t.session).toBe('sess-1');
    expect(t.host).toBe(42);
    expect(t.command).toBe('');
});

test('scope normalizes: only "shell" stays shell, everything else is command', () => {
    const { WsTerminal } = loadWsTerminal();
    expect(new WsTerminal({ scope: 'shell' }).scope).toBe('shell');
    expect(new WsTerminal({ scope: 'command' }).scope).toBe('command');
    expect(new WsTerminal({ scope: 'bogus' }).scope).toBe('command');
    expect(new WsTerminal({}).scope).toBe('command');       // default
    expect(new WsTerminal({ scope: 'SHELL' }).scope).toBe('command'); // case-sensitive
});

test('constructor sets the documented reconnect limits', () => {
    const { WsTerminal } = loadWsTerminal();
    const t = new WsTerminal({});
    expect(t.maxReconnectDelayMs).toBe(30000);
    expect(t.maxReconnectAttempts).toBe(8);
    expect(t.reconnectAttempt).toBe(0);
});

test('scheduleReconnect produces capped exponential backoff and increments the attempt', () => {
    // Inject a setTimeout spy that captures the delay but never fires, so we can
    // step attempts deterministically through the real scheduleReconnect().
    const captured = [];
    const spy = (fn, delay) => { captured.push(delay); return captured.length; };
    const { WsTerminal } = loadWsTerminal({ setTimeout: spy });
    const t = new WsTerminal({});

    // 1000 * 2^attempt, capped at 30000. attempt increments each call.
    const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    for (let i = 0; i < 8; i++) {
        t.scheduleReconnect();
    }
    expect(captured).toEqual(expected);
    expect(t.reconnectAttempt).toBe(8);
});

test('scheduleReconnect gives up once maxReconnectAttempts is reached (no further timers)', () => {
    const captured = [];
    const spy = (fn, delay) => { captured.push(delay); return captured.length; };
    const { WsTerminal } = loadWsTerminal({ setTimeout: spy });
    const t = new WsTerminal({});
    t.reconnectAttempt = t.maxReconnectAttempts; // already exhausted
    t.scheduleReconnect();
    expect(captured.length).toBe(0); // gave up: scheduled nothing
});

test('scheduleReconnect is a no-op after user/remote close', () => {
    const captured = [];
    const spy = (fn, delay) => { captured.push(delay); return 1; };
    const { WsTerminal } = loadWsTerminal({ setTimeout: spy });
    const t = new WsTerminal({});
    t.closedByUser = true;
    t.scheduleReconnect();
    t.closedByUser = false;
    t.closedByRemote = true;
    t.scheduleReconnect();
    expect(captured.length).toBe(0);
    expect(t.reconnectAttempt).toBe(0); // untouched
});

test('send() only writes when the socket is OPEN', () => {
    const { WsTerminal } = loadWsTerminal();
    const t = new WsTerminal({});
    const sent = [];
    // Not open yet -> dropped.
    t.ws = { readyState: 0, send: (s) => sent.push(s) };
    t.send({ v: 1, op: 'pty.data' });
    expect(sent.length).toBe(0);
    // OPEN (matches window.WebSocket.OPEN === 1) -> serialized and sent.
    t.ws = { readyState: 1, send: (s) => sent.push(s) };
    t.send({ v: 1, op: 'pty.data' });
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0])).toEqual({ v: 1, op: 'pty.data' });
});
