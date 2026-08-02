/**
 * Unit tests for public_html/js/ws_vmstat.js
 *
 * The browser client is an IIFE that attaches only `WsVmstat` to `window`. Its
 * private helpers (uuidv4, envelope) are not directly reachable, but the class
 * exposes the load-bearing logic as real, un-refactored prototype methods:
 *
 *   - WsVmstat.prototype.onStdout()  — line-buffering of chunked cmd.output data
 *   - WsVmstat.prototype.parseLine() — vmstat header filtering + 17-col split
 *   - WsVmstat.prototype.exec()      — fresh run_id per (re)start
 *   - WsVmstat.prototype.onExit()    — cmd.exit -> restart loop w/ overlap guard
 *
 * We load the real, unmodified source into a `vm` sandbox with a minimal fake
 * `window`/`document`, so these assertions exercise the shipped code as-is.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.resolve(__dirname, '../../public_html/js/ws_vmstat.js');

/** Build a fresh sandbox `window` and evaluate ws_vmstat.js into it. */
function loadWsVmstat(overrides) {
    const listeners = {};
    const win = {
        WebSocket: { OPEN: 1 },
        crypto: { randomUUID: null }, // force the Math.random uuid path unless overridden
        addEventListener: () => {},
        setTimeout: () => 0,
        clearTimeout: () => {},
        // parseLine only calls window.receiveStats; default no-op, tests override.
        receiveStats: () => {}
    };
    const doc = {
        addEventListener: (evt, cb) => { listeners[evt] = cb; },
        // showCharts() reaches for #charts; no element -> harmless no-op.
        getElementById: () => null
    };
    win.document = doc;
    Object.assign(win, overrides || {});
    win.window = win;
    win.self = win;
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
    return { win, WsVmstat: win.WsVmstat, listeners };
}

/* A realistic `vmstat 1` capture: 2 header lines + 3 real data lines.
 * Note the trailing newline: line-buffering only flushes complete lines. */
const VMSTAT_SAMPLE =
    'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n' +
    ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st\n' +
    ' 1  0      0 1234567  89012 345678    0    0     5    10  100  200  3  1 95  1  0\n' +
    ' 2  0      0 1234000  89012 345678    0    0     0     0  150  300  5  2 92  0  0\n' +
    ' 0  0      0 1233000  89012 345678    0    0     8    20  120  250  1  0 98  1  0\n';

/** Capture every receiveStats() call by feeding chunks through a real instance. */
function feedChunks(chunks) {
    const captured = [];
    // receiveStats() hands us plain objects built INSIDE the vm realm; copy each
    // into a this-realm object so deepStrictEqual compares values, not [[Prototype]].
    const { WsVmstat } = loadWsVmstat({ receiveStats: (c) => captured.push(Object.assign({}, c)) });
    const v = new WsVmstat({});
    for (const chunk of chunks) {
        v.onStdout(chunk);
    }
    return { captured, buffer: v.lineBuffer };
}

test('exposes WsVmstat constructor on window', () => {
    const { WsVmstat } = loadWsVmstat();
    expect(typeof WsVmstat).toBe('function');
});

test('constructor copies url/session/host and defaults command to "vmstat 1"', () => {
    const { WsVmstat } = loadWsVmstat();
    const v = new WsVmstat({ url: 'wss://h:7272', session: 'sess-1', host: 42 });
    expect(v.url).toBe('wss://h:7272');
    expect(v.session).toBe('sess-1');
    expect(v.host).toBe(42);
    expect(v.command).toBe('vmstat 1');
    expect(new WsVmstat({ command: 'vmstat 2' }).command).toBe('vmstat 2');
});

/* ------------------------------------------------------------------ */
/* Header filtering: only genuine 17-column numeric data lines pass.   */
/* ------------------------------------------------------------------ */

test('parses only the 3 real data lines, both vmstat headers excluded', () => {
    const { captured, buffer } = feedChunks([VMSTAT_SAMPLE]);
    expect(captured.length).toBe(3);
    expect(buffer).toBe('');
    // First data row decoded into the documented 17 vmstat fields.
    expect(captured[0]).toEqual({
        r: '1', b: '0', swpd: '0', free: '1234567', buff: '89012', cache: '345678',
        si: '0', so: '0', bi: '5', bo: '10', in: '100', cs: '200',
        us: '3', sy: '1', id: '95', wa: '1', st: '0'
    });
    expect(captured[1].r).toBe('2');
    expect(captured[2].free).toBe('1233000');
});

test('malformed / short / non-numeric-header lines are excluded gracefully', () => {
    const { captured } = feedChunks([
        'procs -----------memory----------\n' + // header word first field
        ' r  b   swpd   free\n' +                // short header
        'garbage line without numbers here\n' +  // non-numeric first col
        ' 1  0  0  1  2\n' +                      // numeric but < 17 cols
        '\n' +                                    // empty line
        '   \n' +                                 // whitespace only
        ' 3  0      0 1000000  89012 345678    0    0     1     2  100  200  3  1 95  1  0\n' // 1 valid
    ]);
    expect(captured.length).toBe(1);
    expect(captured[0].r).toBe('3');
});

/* ------------------------------------------------------------------ */
/* CORE CORRECTNESS PROPERTY: line-buffering is chunk-boundary-agnostic */
/* ------------------------------------------------------------------ */

test('line-buffering yields identical parsed lines regardless of chunk splits', () => {
    // Golden: the whole sample delivered in one chunk.
    const golden = feedChunks([VMSTAT_SAMPLE]).captured;
    expect(golden.length).toBe(3);

    // Every possible single split point (mid-line, mid-word, on newlines).
    for (let i = 1; i < VMSTAT_SAMPLE.length; i++) {
        const a = VMSTAT_SAMPLE.slice(0, i);
        const b = VMSTAT_SAMPLE.slice(i);
        const { captured } = feedChunks([a, b]);
        expect(captured).toEqual(golden);
    }

    // A pathological byte-at-a-time delivery must also be identical.
    const oneByteAtATime = VMSTAT_SAMPLE.split('');
    expect(feedChunks(oneByteAtATime).captured).toEqual(golden);

    // Random multi-way splits.
    for (let trial = 0; trial < 25; trial++) {
        const chunks = [];
        let rest = VMSTAT_SAMPLE;
        while (rest.length) {
            const n = 1 + Math.floor(Math.random() * 7);
            chunks.push(rest.slice(0, n));
            rest = rest.slice(n);
        }
        expect(feedChunks(chunks).captured).toEqual(golden);
    }
});

test('a trailing partial line is held back until its newline arrives', () => {
    const captured = [];
    const { WsVmstat } = loadWsVmstat({ receiveStats: (c) => captured.push(c) });
    const v = new WsVmstat({});
    // Feed a complete data line WITHOUT its terminating newline.
    v.onStdout(' 1  0      0 1234567  89012 345678    0    0     5    10  100  200  3  1 95  1  0');
    expect(captured.length).toBe(0);
    expect(v.lineBuffer).not.toBe('');
    v.onStdout('\n'); // completing newline arrives in a later event
    expect(captured.length).toBe(1);
    expect(v.lineBuffer).toBe('');
});

/* ------------------------------------------------------------------ */
/* cmd.exit -> restart uses a FRESH run_id (v1 rejects run_id reuse).   */
/* ------------------------------------------------------------------ */

test('exec() assigns a fresh unique run_id each call', () => {
    const { WsVmstat } = loadWsVmstat();
    const v = new WsVmstat({});
    v.ws = { readyState: 1, send: () => {} };
    v.exec();
    const first = v.runId;
    expect(first).toBeTruthy();
    v.exec();
    expect(v.runId).not.toBe(first);
});

test('onExit schedules a restart that issues a NEW run_id, not the dead one', () => {
    let scheduled = null;
    const spy = (fn) => { scheduled = fn; return 1; };
    const { WsVmstat } = loadWsVmstat({ setTimeout: spy });
    const v = new WsVmstat({});
    v.ws = { readyState: 1, send: () => {} };
    v.exec();
    const dead = v.runId;

    v.onExit();
    expect(v.runId).toBe(null);
    expect(typeof scheduled).toBe('function');

    scheduled(); // fire the restart
    expect(v.runId).toBeTruthy();
    expect(v.runId).not.toBe(dead);
});

test('onExit restart is guarded against overlap (no second timer while one is pending)', () => {
    let count = 0;
    const spy = () => { count++; return 42; };
    const { WsVmstat } = loadWsVmstat({ setTimeout: spy });
    const v = new WsVmstat({});
    v.ws = { readyState: 1, send: () => {} };
    v.runId = 'live';
    v.onExit();
    v.onExit(); // second exit while restartTimer still pending
    expect(count).toBe(1);
});

test('onExit does nothing once stopped (teardown)', () => {
    let count = 0;
    const spy = () => { count++; return 1; };
    const { WsVmstat } = loadWsVmstat({ setTimeout: spy });
    const v = new WsVmstat({});
    v.stopped = true;
    v.runId = 'live';
    v.onExit();
    expect(count).toBe(0);
});
