/**
 * ws_vmstat.js — v1 protocol live vmstat stats client.
 *
 * Replaces the old vmstat-via-run hack (inline JS in
 * include/admin/view_host_server.php that used the Flash-shim web_socket.js and
 * the untyped legacy `login`/`run`/`running` chat ops) with the frozen
 * WebSocket protocol v1 `cmd.*` streamed-command family.
 *
 * PROTOCOL — /home/sites/datacentered/docs/PROTOCOL_V1.md (FROZEN):
 *   - §1 envelope: every frame sent is {v:1, id:<uuid>, op, ts, data}; replies
 *     are correlated by `re` via the `pending` map; unsolicited hub→client
 *     events (cmd.output / cmd.exit) arrive request-shaped and dispatch by op.
 *   - §2.1 auth.hello{role:"admin", session} MUST be the first frame; cmd.exec
 *     is only sent from inside its ok-reply so ordering can never race.
 *   - §2.2 cmd.exec{run_id, host, command, interact:false, rows:24, cols:80,
 *     update_after:false} starts the long-lived `vmstat 1` stream on the host;
 *     cmd.output{run_id, stream, data} chunks are line-buffered, each complete
 *     stdout line is whitespace-split into the 17 vmstat columns and handed to
 *     the existing receiveStats() renderer (public_html/js/vmstat.js smoothie
 *     charts — display layer unchanged); cmd.exit{run_id} means the stream
 *     died, so a fresh cmd.exec (new run_id, v1 requires uniqueness) is
 *     re-issued after a short delay.
 *
 * WHY LINE-BUFFER (onStdout): unlike the legacy `running` transport — which
 * delivered one whole vmstat line per chat message — v1 cmd.output chunks are
 * raw stdout slices whose boundaries are NOT line-aligned: a single `vmstat 1`
 * row can arrive split across two cmd.output frames, or several rows can arrive
 * coalesced in one. We therefore accumulate chunks in `lineBuffer`, split on
 * "\n", parse only the complete lines, and carry the trailing partial line
 * forward to the next chunk. Feeding un-buffered chunks straight to parseLine()
 * would corrupt or drop rows at every chunk boundary.
 *
 * HEADER-FILTERING HEURISTIC (parseLine): `vmstat 1` prints two header lines up
 * front ("procs -----------memory----------..." and "r  b   swpd   free ...").
 * A real data row has exactly the 17 numeric columns in FIELDS with a numeric
 * leading value, so we skip any line that does not have >=17 whitespace-split
 * columns OR whose first column is not a parseable number. This 17-numeric-
 * column check is what distinguishes chartable data rows from headers without
 * needing vmstat's `-n` flag or line counting.
 *
 * FRESH run_id PER RESTART (exec/onExit): v1 forbids run_id reuse (PROTOCOL_V1
 * §2.2 — the legacy `md5($cmd)` scheme collided for identical commands), so
 * every (re)start mints a brand-new uuid run_id; onExit never re-issues the old
 * one.
 *
 * KNOWN LIMITATION — restart uses a FIXED 1s delay with NO backoff. If the host
 * keeps killing the stream (command missing, permission error, host churning),
 * onExit() will re-exec once per second indefinitely rather than backing off
 * exponentially the way ws_terminal.js / ws_channels.js reconnect loops do.
 * This is a documented minor limitation carried forward from step 4.7, not a
 * bug to silently hide; a bounded/backed-off restart is a later refinement.
 *
 * Display parity with the legacy hack: #charts is shown once the socket is up
 * and hidden on close; header lines (leading field not numeric, e.g. "procs"
 * / "r") are skipped instead of charted.
 *
 * CONFIG. window.WS_VMSTAT_CONFIG, emitted PHP-side by the info case of
 * include/admin/view_host_server.php (same hub/session convention as
 * WS_TERMINAL_CONFIG in ws_terminal.js):
 *   window.WS_VMSTAT_CONFIG = {
 *       url:     "wss://hub-host:7272",          // hub gateway (WSS, :7272)
 *       session: "<mystage admin session id>",   // validated against `sessions`
 *       host:    <host id (vps_masters.vps_id)>,
 *       command: "vmstat 1"                      // stats stream command
 *   };
 * Auto-starts on DOMContentLoaded when the config is present (after
 * initCharts(), which vmstat.js page wiring runs first).
 */
(function (global) {
    'use strict';

    var FIELDS = ['r', 'b', 'swpd', 'free', 'buff', 'cache', 'si', 'so',
        'bi', 'bo', 'in', 'cs', 'us', 'sy', 'id', 'wa', 'st'];

    function uuidv4() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    function envelope(op, data) {
        return {
            v: 1,
            id: uuidv4(),
            op: op,
            ts: Math.floor(Date.now() / 1000),
            data: data || {}
        };
    }

    function WsVmstat(config) {
        config = config || {};
        this.url = config.url;
        this.session = config.session;
        this.host = config.host;
        this.command = config.command || 'vmstat 1';
        this.ws = null;
        this.runId = null;
        this.pending = {};       // envelope id → callback(reply)
        this.lineBuffer = '';    // cmd.output chunks are not line-aligned
        this.restartTimer = null;
        this.stopped = false;
    }

    WsVmstat.prototype.start = function () {
        var self = this;
        global.addEventListener('beforeunload', function () {
            self.teardown();
        });
        this.connect();
    };

    WsVmstat.prototype.send = function (env) {
        if (this.ws && this.ws.readyState === global.WebSocket.OPEN) {
            this.ws.send(JSON.stringify(env));
        }
    };

    /** Send a request envelope and register a callback for its {re} reply. */
    WsVmstat.prototype.request = function (op, data, cb) {
        var env = envelope(op, data);
        this.pending[env.id] = cb;
        this.send(env);
        return env.id;
    };

    WsVmstat.prototype.showCharts = function (show) {
        var el = document.getElementById('charts');
        if (el) {
            el.style.display = show ? 'block' : 'none';
        }
    };

    WsVmstat.prototype.connect = function () {
        var self = this;
        var ws;
        try {
            ws = new global.WebSocket(this.url, 'v1');
        } catch (e) {
            console.log('ws_vmstat: WebSocket error: ' + e.message);
            return;
        }
        this.ws = ws;

        ws.onopen = function () {
            console.log('ws_vmstat: connect');
            // auth.hello MUST be the first frame (PROTOCOL_V1.md §2.1/§3).
            self.request('auth.hello', { role: 'admin', session: self.session }, function (reply) {
                if (!reply.ok) {
                    console.log('ws_vmstat: auth failed: '
                        + (reply.error ? reply.error.message : 'unknown error'));
                    return;
                }
                self.showCharts(true);
                self.exec();
            });
        };

        ws.onclose = function () {
            self.pending = {};
            self.runId = null;
            self.lineBuffer = '';
            self.showCharts(false);
            console.log('ws_vmstat: disconnect');
        };

        ws.onmessage = function (evt) {
            var msg;
            try {
                msg = JSON.parse(evt.data);
            } catch (e) {
                return; // ignore non-JSON frames
            }
            // Reply correlation by re (PROTOCOL_V1.md §1 reply shape).
            if (typeof msg.re !== 'undefined') {
                var cb = self.pending[msg.re];
                if (cb) {
                    delete self.pending[msg.re];
                    cb(msg);
                }
                return;
            }
            switch (msg.op) {
                case 'cmd.output':
                    if (msg.data && msg.data.run_id === self.runId
                            && msg.data.stream === 'stdout') {
                        self.onStdout(msg.data.data);
                    }
                    break;
                case 'cmd.exit':
                    if (msg.data && msg.data.run_id === self.runId) {
                        self.onExit();
                    }
                    break;
                default:
                    break; // unrelated broadcast/op — ignore
            }
        };
    };

    /** Issue cmd.exec (§2.2) for the vmstat stream with a fresh unique run_id. */
    WsVmstat.prototype.exec = function () {
        var self = this;
        this.runId = uuidv4();
        this.lineBuffer = '';
        this.request('cmd.exec', {
            run_id: this.runId,
            host: this.host,
            command: this.command,
            interact: false,
            rows: 24,
            cols: 80,
            update_after: false
        }, function (reply) {
            if (!reply.ok) {
                console.log('ws_vmstat: cmd.exec failed: '
                    + (reply.error ? reply.error.code + ': ' + reply.error.message : 'unknown error'));
                self.runId = null;
            }
        });
    };

    /**
     * Buffer stdout chunks, parse each complete line into the vmstat columns.
     * v1 cmd.output chunks are not line-aligned (see header WHY LINE-BUFFER), so
     * the trailing partial line is retained in lineBuffer for the next chunk.
     */
    WsVmstat.prototype.onStdout = function (chunk) {
        this.lineBuffer += chunk;
        var lines = this.lineBuffer.split('\n');
        this.lineBuffer = lines.pop(); // keep any trailing partial line
        for (var i = 0; i < lines.length; i++) {
            this.parseLine(lines[i]);
        }
    };

    /**
     * Parse one stdout line into a vmstat column map and feed receiveStats().
     * Header-filtering heuristic: a data row has all 17 numeric FIELDS columns
     * with a numeric leading value, so lines with fewer columns or a non-numeric
     * first column (the two "procs ..." / "r b swpd ..." headers) are skipped.
     */
    WsVmstat.prototype.parseLine = function (line) {
        var parts = line.trim().split(/ +/);
        // Skip the vmstat header lines ("procs ..." / "r b swpd ...").
        if (parts.length < FIELDS.length || isNaN(parseFloat(parts[0]))) {
            return;
        }
        var content = {};
        for (var i = 0; i < FIELDS.length; i++) {
            content[FIELDS[i]] = parts[i];
        }
        if (typeof global.receiveStats === 'function') {
            global.receiveStats(content);
        }
    };

    /**
     * vmstat 1 should stream forever; if it exits, restart it shortly.
     * KNOWN LIMITATION: fixed 1s delay, no exponential backoff (see header) — a
     * host that keeps killing the stream is re-exec'd once per second.
     */
    WsVmstat.prototype.onExit = function () {
        var self = this;
        this.runId = null;
        if (this.stopped || this.restartTimer) {
            return;
        }
        this.restartTimer = setTimeout(function () {
            self.restartTimer = null;
            if (!self.stopped && self.ws && self.ws.readyState === global.WebSocket.OPEN) {
                self.exec();
            }
        }, 1000);
    };

    /** Tab close: kill the remote run (§2.2 cmd.kill) and drop the socket. */
    WsVmstat.prototype.teardown = function () {
        this.stopped = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
        }
        if (this.runId) {
            this.send(envelope('cmd.kill', { run_id: this.runId }));
            this.runId = null;
        }
        if (this.ws && this.ws.readyState === global.WebSocket.OPEN) {
            this.ws.close();
        }
    };

    global.WsVmstat = WsVmstat;

    // Auto-start when the page provided a config (view_host_server.php wiring).
    document.addEventListener('DOMContentLoaded', function () {
        if (global.WS_VMSTAT_CONFIG) {
            global.wsVmstat = new WsVmstat(global.WS_VMSTAT_CONFIG);
            global.wsVmstat.start();
        }
    });
}(window));
