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
 *
 * Run: node --test tests/js/ws_vmstat.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
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
    assert.strictEqual(typeof WsVmstat, 'function');
});

test('constructor copies url/session/host and defaults command to "vmstat 1"', () => {
    const { WsVmstat } = loadWsVmstat();
    const v = new WsVmstat({ url: 'wss://h:7272', session: 'sess-1', host: 42 });
    assert.strictEqual(v.url, 'wss://h:7272');
    assert.strictEqual(v.session, 'sess-1');
    assert.strictEqual(v.host, 42);
    assert.strictEqual(v.command, 'vmstat 1');
    assert.strictEqual(new WsVmstat({ command: 'vmstat 2' }).command, 'vmstat 2');
});

/* ------------------------------------------------------------------ */
/* Header filtering: only genuine 17-column numeric data lines pass.   */
/* ------------------------------------------------------------------ */

test('parses only the 3 real data lines, both vmstat headers excluded', () => {
    const { captured, buffer } = feedChunks([VMSTAT_SAMPLE]);
    assert.strictEqual(captured.length, 3, 'exactly 3 numeric data lines charted');
    assert.strictEqual(buffer, '', 'trailing newline -> no partial line left buffered');
    // First data row decoded into the documented 17 vmstat fields.
    assert.deepStrictEqual(captured[0], {
        r: '1', b: '0', swpd: '0', free: '1234567', buff: '89012', cache: '345678',
        si: '0', so: '0', bi: '5', bo: '10', in: '100', cs: '200',
        us: '3', sy: '1', id: '95', wa: '1', st: '0'
    });
    assert.strictEqual(captured[1].r, '2');
    assert.strictEqual(captured[2].free, '1233000');
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
    assert.strictEqual(captured.length, 1, 'only the single valid 17-col row survives');
    assert.strictEqual(captured[0].r, '3');
});

/* ------------------------------------------------------------------ */
/* CORE CORRECTNESS PROPERTY: line-buffering is chunk-boundary-agnostic */
/* ------------------------------------------------------------------ */

test('line-buffering yields identical parsed lines regardless of chunk splits', () => {
    // Golden: the whole sample delivered in one chunk.
    const golden = feedChunks([VMSTAT_SAMPLE]).captured;
    assert.strictEqual(golden.length, 3);

    // Every possible single split point (mid-line, mid-word, on newlines).
    for (let i = 1; i < VMSTAT_SAMPLE.length; i++) {
        const a = VMSTAT_SAMPLE.slice(0, i);
        const b = VMSTAT_SAMPLE.slice(i);
        const { captured } = feedChunks([a, b]);
        assert.deepStrictEqual(
            captured, golden,
            'split at offset ' + i + ' must produce the same parsed line set'
        );
    }

    // A pathological byte-at-a-time delivery must also be identical.
    const oneByteAtATime = VMSTAT_SAMPLE.split('');
    assert.deepStrictEqual(feedChunks(oneByteAtATime).captured, golden);

    // Random multi-way splits.
    for (let trial = 0; trial < 25; trial++) {
        const chunks = [];
        let rest = VMSTAT_SAMPLE;
        while (rest.length) {
            const n = 1 + Math.floor(Math.random() * 7);
            chunks.push(rest.slice(0, n));
            rest = rest.slice(n);
        }
        assert.deepStrictEqual(feedChunks(chunks).captured, golden);
    }
});

test('a trailing partial line is held back until its newline arrives', () => {
    const captured = [];
    const { WsVmstat } = loadWsVmstat({ receiveStats: (c) => captured.push(c) });
    const v = new WsVmstat({});
    // Feed a complete data line WITHOUT its terminating newline.
    v.onStdout(' 1  0      0 1234567  89012 345678    0    0     5    10  100  200  3  1 95  1  0');
    assert.strictEqual(captured.length, 0, 'no newline yet -> nothing parsed');
    assert.notStrictEqual(v.lineBuffer, '', 'partial line retained in buffer');
    v.onStdout('\n'); // completing newline arrives in a later event
    assert.strictEqual(captured.length, 1, 'line flushed once newline seen');
    assert.strictEqual(v.lineBuffer, '');
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
    assert.ok(first, 'run_id set');
    v.exec();
    assert.notStrictEqual(v.runId, first, 'second exec must not reuse the run_id');
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
    assert.strictEqual(v.runId, null, 'run_id cleared on exit (collision guard)');
    assert.strictEqual(typeof scheduled, 'function', 'a restart timer was armed');

    scheduled(); // fire the restart
    assert.ok(v.runId, 'restart issued a new run_id');
    assert.notStrictEqual(v.runId, dead, 'restart must NOT reuse the exited run_id');
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
    assert.strictEqual(count, 1, 'overlap guard prevents a duplicate restart timer');
});

test('onExit does nothing once stopped (teardown)', () => {
    let count = 0;
    const spy = () => { count++; return 1; };
    const { WsVmstat } = loadWsVmstat({ setTimeout: spy });
    const v = new WsVmstat({});
    v.stopped = true;
    v.runId = 'live';
    v.onExit();
    assert.strictEqual(count, 0, 'stopped client never reschedules');
});
