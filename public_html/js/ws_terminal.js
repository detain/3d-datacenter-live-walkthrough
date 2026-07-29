/**
 * ws_terminal.js — v1 protocol browser terminal client (replaces legacy phptty.js).
 *
 * An xterm.js front-end that opens a real interactive PTY on a VPS host node by
 * talking to the datacentered hub's WSS gateway. It supersedes the dead
 * `phptty.js` widget (Flash-shim `web_socket.js` + the untyped legacy
 * `run`/`running` chat ops); the old file is left in place for rollback and is
 * still reachable via the `phptty_legacy` link (see view_host_server.php).
 *
 * PROTOCOL — frozen WebSocket protocol v1. The authoritative spec is
 * `/home/sites/datacentered/docs/PROTOCOL_V1.md` (FROZEN, read-only, another
 * repo — do not edit it; mirror it here). This client implements exactly:
 *
 *   - The envelope + reply shapes of §1. Every frame this client sends is a
 *     request envelope:
 *         {v:1, id:<uuid v4>, op:"ns.verb", ts:<unix seconds>, data:{}}
 *     The hub answers request/reply ops with a reply correlated by `re`:
 *         {v:1, re:<id>, ok:true,  data:{}}
 *         {v:1, re:<id>, ok:false, error:{code, message}}
 *     Replies are matched to their request via the `pending` map keyed on the
 *     envelope `id`; unsolicited hub→client events arrive as request-shaped
 *     frames (fresh `id`, an `op`, no `re`) and are dispatched by `op`.
 *   - The `pty.*` op family of §2.3: `pty.open` (reply carries the allocated
 *     `pty_id`), full-duplex `pty.data`, `pty.resize`, and `pty.close`.
 *
 * SEQUENCING (§2.1 / §3 ordering rule). `auth.hello` MUST be the first frame on
 * a fresh socket; the hub rejects+closes any other op sent before auth. This
 * client enforces the strict order:
 *     auth.hello{role:"admin", session}  → await ok reply (the auth.welcome
 *                                           payload: {session, uid, name, hub_time})
 *   → pty.open{pty_id, host, scope, command, cols, rows}
 *                                        → await ok reply (data.pty_id allocated)
 *   → duplex pty.data streaming wired to the terminal.
 * pty.open is only sent from inside the auth.hello ok-reply callback, so the
 * ordering can never race. An auth failure is terminal (no reconnect).
 *
 * PTY.DATA ENCODING (§2.3). PTY streams are binary and JSON-unsafe, so
 * `pty.data.data` is ALWAYS base64. Outbound: user keystrokes are UTF-8 encoded
 * then base64'd (`b64EncodeUtf8`). Inbound: base64 is decoded to a raw
 * Uint8Array (`b64ToBytes`) and handed straight to `term.write()`.
 *
 * RECONNECT. A socket drop that was not initiated locally or by a remote
 * pty.close triggers exponential backoff: delay = min(30s, 2^attempt seconds),
 * up to 8 attempts, after which the client gives up and asks the user to reload
 * (`scheduleReconnect`). A successful auth resets the attempt counter. Auth
 * failures and remote/local closes suppress reconnect entirely.
 *
 * DEPENDENCIES. Requires xterm.js (vendored at /lib/xterm/lib/xterm.js, exposes
 * `window.Terminal`). Optionally uses the xterm fit addon (`window.FitAddon`)
 * when present; otherwise falls back to a built-in character-cell measurement
 * fit (`WsTerminal.fit`).
 *
 * CONFIG. Configured entirely from `window.WS_TERMINAL_CONFIG`, emitted PHP-side
 * by the `terminal`/`phptty` case of include/admin/view_host_server.php:
 *   window.WS_TERMINAL_CONFIG = {
 *       url:     "wss://hub-host:7272",   // hub gateway (WSS, :7272)
 *       session: "<mystage admin session id>", // validated against `sessions`
 *       host:    <host id (vps_masters.vps_id)>,
 *       command: "htop",                  // scope=command command line
 *       scope:   "command",               // "command" (default) | "shell"
 *       container: "#ws-terminal",        // mount element or selector
 *       manual:  false                    // truthy = suppress DOMContentLoaded auto-start
 *   };
 * On DOMContentLoaded a config without `manual` auto-starts:
 *   window.wsTerminal = new WsTerminal(window.WS_TERMINAL_CONFIG); wsTerminal.start();
 */
(function (global) {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* helpers                                                            */
    /* ------------------------------------------------------------------ */

    function uuidv4() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            return global.crypto.randomUUID();
        }
        // RFC4122-ish fallback for older browsers
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    /** UTF-8 encode a JS string and base64 it (pty.data is base64 raw bytes). */
    function b64EncodeUtf8(str) {
        var bytes = new TextEncoder().encode(str);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) {
            bin += String.fromCharCode(bytes[i]);
        }
        return global.btoa(bin);
    }

    /** base64 → Uint8Array of raw bytes (fed straight to term.write()). */
    function b64ToBytes(b64) {
        var bin = global.atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        return bytes;
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

    /* ------------------------------------------------------------------ */
    /* WsTerminal                                                         */
    /* ------------------------------------------------------------------ */

    function WsTerminal(config) {
        config = config || {};
        this.url = config.url;
        this.session = config.session;
        this.host = config.host;
        this.command = config.command || '';
        this.scope = config.scope === 'shell' ? 'shell' : 'command';
        this.container = config.container || null;   // element or selector
        this.statusEl = null;
        this.term = null;
        this.fitAddon = null;
        this.ws = null;
        this.ptyId = null;
        this.pending = {};        // envelope id → callback(reply)
        this.ptyOpen = false;
        this.closedByRemote = false;
        this.closedByUser = false;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.resizeTimer = null;
        this.dataDisposable = null;
        this.maxReconnectDelayMs = 30000;
        this.maxReconnectAttempts = 8;
    }

    WsTerminal.prototype.start = function () {
        var self = this;
        var container = this.container;
        if (typeof container === 'string') {
            container = document.querySelector(container);
        }
        if (!container) {
            container = document.getElementById('ws-terminal') || document.body;
        }
        this.container = container;
        this.statusEl = document.getElementById('ws-terminal-status');

        if (typeof global.Terminal === 'undefined') {
            this.setStatus('error', 'xterm.js is not loaded (/lib/xterm/lib/xterm.js)');
            return;
        }
        this.term = new global.Terminal({
            cursorBlink: true,
            fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
            fontSize: 14,
            theme: { background: '#111111' }
        });
        // Fit addon when vendored (window.FitAddon.FitAddon per its UMD bundle).
        var FitCtor = null;
        if (global.FitAddon) {
            FitCtor = typeof global.FitAddon === 'function' ? global.FitAddon : global.FitAddon.FitAddon;
        }
        if (typeof FitCtor === 'function') {
            this.fitAddon = new FitCtor();
            this.term.loadAddon(this.fitAddon);
        }
        this.term.open(container);
        this.fit();

        global.addEventListener('resize', function () {
            if (self.resizeTimer) {
                clearTimeout(self.resizeTimer);
            }
            self.resizeTimer = setTimeout(function () {
                self.fit();
                if (self.ptyOpen) {
                    self.send(envelope('pty.resize', {
                        pty_id: self.ptyId,
                        cols: self.term.cols,
                        rows: self.term.rows
                    }));
                }
            }, 150);
        });
        global.addEventListener('beforeunload', function () {
            self.teardown();
        });

        this.connect();
    };

    /** Fit terminal to its container: fit addon if present, else measure a cell. */
    WsTerminal.prototype.fit = function () {
        if (this.fitAddon) {
            try {
                this.fitAddon.fit();
                return;
            } catch (e) { /* fall through to manual fit */ }
        }
        var el = this.container;
        if (!el || !el.clientWidth) {
            return;
        }
        var probe = document.createElement('span');
        probe.textContent = 'W';
        probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;'
            + 'font-family:' + this.term.options.fontFamily + ';'
            + 'font-size:' + this.term.options.fontSize + 'px;line-height:normal;';
        document.body.appendChild(probe);
        var cw = probe.getBoundingClientRect().width || 9;
        var ch = probe.getBoundingClientRect().height || 17;
        document.body.removeChild(probe);
        var cols = Math.max(20, Math.floor(el.clientWidth / cw) - 1);
        var rows = Math.max(5, Math.floor((el.clientHeight || 600) / (ch + 2)));
        this.term.resize(cols, rows);
    };

    WsTerminal.prototype.setStatus = function (state, text) {
        if (this.statusEl) {
            this.statusEl.textContent = text;
            this.statusEl.className = 'ws-terminal-status ws-terminal-status-' + state;
        }
    };

    WsTerminal.prototype.send = function (env) {
        if (this.ws && this.ws.readyState === global.WebSocket.OPEN) {
            this.ws.send(JSON.stringify(env));
        }
    };

    /** Send a request envelope and register a callback for its {re} reply. */
    WsTerminal.prototype.request = function (op, data, cb) {
        var env = envelope(op, data);
        this.pending[env.id] = cb;
        this.send(env);
        return env.id;
    };

    /**
     * Open the WSS socket and drive the handshake. On open, sends auth.hello as
     * the first frame (§2.1 ordering rule) and only proceeds to openPty() from
     * inside its ok-reply. Wires onmessage (reply correlation by `re`, then
     * pty.data/pty.close dispatch by `op`) and onclose (backoff reconnect).
     */
    WsTerminal.prototype.connect = function () {
        var self = this;
        if (this.closedByRemote || this.closedByUser) {
            return;
        }
        this.setStatus('connecting', 'Connecting to ' + this.url + ' ...');
        var ws;
        try {
            ws = new global.WebSocket(this.url, 'v1');
        } catch (e) {
            this.setStatus('error', 'WebSocket error: ' + e.message);
            this.scheduleReconnect();
            return;
        }
        this.ws = ws;

        ws.onopen = function () {
            self.setStatus('authenticating', 'Authenticating ...');
            // auth.hello MUST be the first message (PROTOCOL_V1.md §2.1/§3);
            // its ok-reply carries the auth.welcome data {session,uid,name,hub_time}.
            self.request('auth.hello', { role: 'admin', session: self.session }, function (reply) {
                if (!reply.ok) {
                    self.setStatus('error', 'Authentication failed: '
                        + (reply.error ? reply.error.message : 'unknown error'));
                    self.closedByUser = true; // auth failure will not fix itself; stop retrying
                    return;
                }
                self.reconnectAttempt = 0;
                self.setStatus('authenticated', 'Authenticated as ' + reply.data.name + ' — opening terminal ...');
                self.openPty();
            });
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
                } else if (msg.ok === false && msg.error) {
                    self.term.write('\r\n\x1b[31m[hub error] ' + msg.error.code + ': '
                        + msg.error.message + '\x1b[0m\r\n');
                }
                return;
            }
            switch (msg.op) {
                case 'pty.data':
                    if (msg.data && msg.data.pty_id === self.ptyId) {
                        self.term.write(b64ToBytes(msg.data.data));
                    }
                    break;
                case 'pty.close':
                    if (msg.data && msg.data.pty_id === self.ptyId) {
                        self.onRemoteClose(msg.data.code);
                    }
                    break;
                default:
                    break; // unrelated broadcast/op — ignore
            }
        };

        ws.onclose = function () {
            self.ptyOpen = false;
            self.pending = {};
            if (self.closedByRemote || self.closedByUser) {
                return;
            }
            self.setStatus('disconnected', 'Disconnected from hub.');
            self.term.write('\r\n\x1b[33m[connection lost]\x1b[0m\r\n');
            self.scheduleReconnect();
        };

        ws.onerror = function () {
            // onclose follows and handles state/reconnect; nothing to do here.
        };
    };

    /**
     * Schedule a reconnect with exponential backoff: delay = min(30s,
     * 2^attempt s), capped at 8 attempts. No-op if the session was closed by the
     * user or remote peer; gives up (prompting a page reload) past the cap.
     */
    WsTerminal.prototype.scheduleReconnect = function () {
        var self = this;
        if (this.closedByRemote || this.closedByUser) {
            return;
        }
        if (this.reconnectAttempt >= this.maxReconnectAttempts) {
            this.setStatus('error', 'Disconnected — gave up after '
                + this.maxReconnectAttempts + ' reconnect attempts. Reload the page to retry.');
            return;
        }
        var delay = Math.min(this.maxReconnectDelayMs, 1000 * Math.pow(2, this.reconnectAttempt));
        this.reconnectAttempt++;
        this.setStatus('disconnected', 'Disconnected — reconnecting in '
            + Math.round(delay / 1000) + 's (attempt ' + this.reconnectAttempt + ') ...');
        this.reconnectTimer = setTimeout(function () {
            self.connect();
        }, delay);
    };

    /**
     * Send pty.open (§2.3) for the configured host/scope/command with the
     * current terminal dimensions, then on the ok-reply mark the pty open and
     * wire xterm onData → outbound pty.data (base64 UTF-8). Called only after a
     * successful auth.hello reply.
     */
    WsTerminal.prototype.openPty = function () {
        var self = this;
        this.fit();
        this.ptyId = uuidv4();
        var data = {
            pty_id: this.ptyId,
            host: this.host,
            scope: this.scope,
            cols: this.term.cols,
            rows: this.term.rows
        };
        if (this.scope === 'command') {
            data.command = this.command;
        }
        this.request('pty.open', data, function (reply) {
            if (!reply.ok) {
                self.setStatus('error', 'pty.open failed: '
                    + (reply.error ? reply.error.code + ': ' + reply.error.message : 'unknown error'));
                self.term.write('\r\n\x1b[31m[pty.open failed] '
                    + (reply.error ? reply.error.message : 'unknown error') + '\x1b[0m\r\n');
                return;
            }
            self.ptyOpen = true;
            self.setStatus('connected', 'Connected — ' + (self.scope === 'shell'
                ? 'shell' : self.command) + ' on host ' + self.host);
            if (!self.dataDisposable) {
                // xterm onData: user keystrokes → pty.data (base64 UTF-8 bytes).
                self.dataDisposable = self.term.onData(function (input) {
                    if (self.ptyOpen) {
                        self.send(envelope('pty.data', {
                            pty_id: self.ptyId,
                            data: b64EncodeUtf8(input)
                        }));
                    }
                });
            }
            self.term.focus();
        });
    };

    /** Remote-initiated pty.close: disable input, show closed state, no reconnect. */
    WsTerminal.prototype.onRemoteClose = function (code) {
        this.closedByRemote = true;
        this.ptyOpen = false;
        var msg = 'Session closed by remote'
            + (typeof code !== 'undefined' && code !== null ? ' (exit code ' + code + ')' : '')
            + '.';
        this.setStatus('closed', msg);
        this.term.write('\r\n\x1b[33m[' + msg + ']\x1b[0m\r\n');
        if (this.term.options) {
            this.term.options.disableStdin = true;
        }
        this.term.blur();
        if (this.ws && this.ws.readyState === global.WebSocket.OPEN) {
            this.ws.close();
        }
    };

    /** Local teardown (tab close / explicit close): tell the hub, then drop. */
    WsTerminal.prototype.teardown = function () {
        this.closedByUser = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        if (this.ptyOpen) {
            this.send(envelope('pty.close', { pty_id: this.ptyId }));
            this.ptyOpen = false;
        }
        if (this.ws && this.ws.readyState === global.WebSocket.OPEN) {
            this.ws.close();
        }
    };

    global.WsTerminal = WsTerminal;

    // Auto-start when the page provided a config (view_host_server.php wiring).
    document.addEventListener('DOMContentLoaded', function () {
        if (global.WS_TERMINAL_CONFIG && !global.WS_TERMINAL_CONFIG.manual) {
            global.wsTerminal = new WsTerminal(global.WS_TERMINAL_CONFIG);
            global.wsTerminal.start();
        }
    });
}(window));
