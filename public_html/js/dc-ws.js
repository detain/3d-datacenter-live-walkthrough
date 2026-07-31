/**
 * dc-ws.js — WebSocket client module for dc.html 3D datacenter multi-user presence.
 *
 * Connects to the datacentered hub gateway (wss://mystage.interserver.net:7272)
 * using the frozen v1 WebSocket protocol. Handles admin authentication via
 * PHP session, exposes presence state, and fires DOM events for upstream
 * modules (e.g. dc-presence.js).
 *
 * ---------------------------------------------------------------------------
 * Protocol (PROTOCOL_V1.md §1)
 * ---------------------------------------------------------------------------
 *   request  {v:1, id:"<uuid>", op:"<ns.verb>", ts:<unix>, data:{}}
 *   reply    {v:1, re:"<id>", ok:true,  data:{}}
 *            {v:1, re:"<id>", ok:false, error:{code:"<str>", message:"<str>"}}
 *   server→client events reuse the request shape (fresh id, an op, no re).
 *
 * Ops this module sends:
 *   auth.hello  C→H  — {role:"admin", session:DC_SESSION_ID}. The hub answers
 *                      with a CORRELATED REPLY, not an event:
 *                        {v:1, re:"<the auth.hello id>", ok:true,
 *                         data:{session, uid, clientId, name, hub_time}}
 *                      There is no `op` on a reply — replies correlate purely by
 *                      `re` + `ok` (PROTOCOL_V1 §1). We therefore remember the
 *                      uuid we generated for auth.hello (`_helloId`) and match
 *                      the reply against it. A hypothetical op-shaped
 *                      `auth.welcome` event is still accepted as a fallback.
 *
 * Ops this module receives:
 *   <reply re=_helloId ok=true>  H→C  — auth success; triggers dc:auth-success.
 *   <reply re=_helloId ok=false> H→C  — auth failure; dc:auth-failure. A failed reply to
 *                      any OTHER request is logged (DC_DEBUG) and otherwise ignored — it
 *                      must not tear presence down.
 *   auth.rejected                H→C  — auth failure event; dc:auth-failure.
 *   dc.*, channel.*, chat.*      H→C  — forwarded as dc:v1-event.
 *
 * ---------------------------------------------------------------------------
 * Exports (window)
 * ---------------------------------------------------------------------------
 *   DC_WS             — this module (instance with request/destroy)
 *   DC_AUTHED         — boolean, true after the auth.hello reply arrives
 *   DC_UID            — numeric uid from the auth reply
 *   DC_PRESENCE       — presence data object from the auth reply
 *   DC_PRESENCE_SEND  — fire-and-forget sender for dc.presence.* ops
 *
 * Note: DC_PRESENCE_JOIN / DC_PRESENCE_MOVE / DC_PRESENCE_LEAVE are owned by
 * dc-presence.js — this module deliberately does NOT define them.
 *
 * ---------------------------------------------------------------------------
 * DOM Events
 * ---------------------------------------------------------------------------
 *   dc:connected     — socket opened, auth.hello sent
 *   dc:disconnected  — socket closed (after reconnect exhaustion or destroy)
 *   dc:auth-success  — auth reply received; detail = {uid, clientId, name, session, hub_time}
 *   dc:auth-failure   — auth rejected/failed; detail = {error:{code,message}}
 *   dc:v1-event       — any incoming dc.*, channel.*, chat.* op;
 *                       detail = {op, data} (the raw envelope sans v/version)
 *   dc:ws-status      — transport status changed; detail = {status} where status
 *                       is one of connecting|connected|disconnected|error|exhausted
 *                       (CONTRACT STATUS-EVENT — dc-presence.js reflects this on
 *                       the #dcPresence badge)
 */

(function () {
	'use strict';

	/* -------------------------- helpers -------------------------- */

	const uuid = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
		const r = Math.random() * 16 | 0;
		return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
	}));

	/* -------------------------- URL param helpers -------------------------- */

	// Allow override via ?ws_url=<wss://url:port> in page URL (restricted to known hosts)
	const _urlParams = new URLSearchParams(window.location.search);
	let _wsUrlOverride = _urlParams.get('ws_url');
	if (_wsUrlOverride) {
		// Only allow if it's the same host as the default or an allowed test host
		try {
			const parsed = new URL(_wsUrlOverride);
			const _defaultHosts = ['mystage.interserver.net'];
			const allowedHosts = window.DC_WS_ALLOWED_HOSTS || _defaultHosts;
			if (parsed.protocol !== 'wss:') {
				console.warn('DC_WS: ws_url must use wss:// protocol, using default');
				_wsUrlOverride = null;
			} else if (!allowedHosts.includes(parsed.hostname)) {
				console.warn('DC_WS: Invalid ws_url host, using default');
				_wsUrlOverride = null;
			}
		} catch (e) {
			console.warn('DC_WS: Invalid ws_url format, using default');
			_wsUrlOverride = null;
		}
	}
	const wsUrl = _wsUrlOverride || 'wss://mystage.interserver.net:7272';

	/**
	 * Auth failures that retrying cannot possibly fix. The hub ACCEPTS the WebSocket
	 * handshake and only rejects auth.hello afterwards, so a bad credential produces an
	 * endless connect/close cycle unless it is recognised as terminal (see
	 * _giveUpOnAuth). Compared lower-cased, so BAD_SESSION matches too.
	 */
	const TERMINAL_AUTH_CODES = ['bad_session', 'unsupported_credential', 'ip_not_allowed'];

	// Default 30s. URL param ?ws_keepalive=<seconds> overrides (clamped 5-300s). // Example: ?ws_keepalive=60 → 60s interval
	const _wsKeepaliveRaw = parseInt(_urlParams.get('ws_keepalive'), 10);
	const WS_KEEPALIVE_MS = (!isNaN(_wsKeepaliveRaw) && _wsKeepaliveRaw >= 5 && _wsKeepaliveRaw <= 300)
	    ? _wsKeepaliveRaw * 1000
	    : 30000;

	/* -------------------------- Client -------------------------- */

	function Client() {
		/** @type {WebSocket|null} */
		this.ws = null;
		this.authed = false;
		this.closedByUs = false;
		this.reconnectAttempts = 0;
		this.reconnectDelay = 3000; // 3 seconds initial
		this.maxReconnectAttempts = 10;
		this.wsUrl = wsUrl;
		this._keepaliveTimer = null;
		// MINOR-5: ping timestamp tracking (timestamp of the most recent ping, used
		// only for latency measurement — cleared by the pong handler).
		this._lastPingTs = null;
		// C8: watchdog clock. Set when a ping goes out with none already
		// outstanding, cleared on pong. Unlike _lastPingTs it is NOT refreshed on
		// every keepalive tick, so it genuinely ages while the hub is silent.
		this._pingOutstandingSince = null;
		// C-A2: uuid of the in-flight auth.hello, so the correlated reply
		// ({re:<that id>, ok:true}) can be recognised. Regenerated per reconnect.
		this._helloId = null;
		// Set once auth has failed for a reason retrying cannot fix. Without this the
		// reconnect loop is unbounded: the socket OPENS fine and only auth is refused, so
		// reconnectAttempts used to be reset every cycle and maxReconnectAttempts was never
		// reached — a rejected session reconnected every 3s forever, one TLS handshake and
		// one sessions-table lookup per cycle, for the life of the tab.
		this._authTerminal = false;
		// Last status passed to _setStatus() (also broadcast as dc:ws-status).
		this.status = null;
		// IDEA-1: presence batching
		this._presenceBatch = null;
		this._batchRaf = null;
		// C7: timestamp of the last ACTUAL flush. Written only by _flushPresence()
		// so the >500ms backgrounded-tab fallback in send() can really fire.
		// Seeded at construction so a backgrounded tab that has never flushed still
		// gets a bounded (~500ms) fallback instead of waiting on a RAF that never runs.
		this._lastFlush = Date.now();
		// IDEA-7: latency tracking
		this._latencyHistory = [];
		// IDEA-3: viewport update throttle
		this._viewportSendTimer = null;
		this._viewport = null;
		// Graceful degradation: whether connection has succeeded at least once
		this._connectedOnce = false;
		// Track last pong received timestamp for getState()
		this._lastPongTs = null;
		// MAJOR-2: visibilitychange handler — flush batch immediately when tab becomes visible
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden && this._presenceBatch && this._presenceBatch.length > 0) {
				this._flushPresence();
			}
		});
	}

	Client.prototype = {

		_connect: function () {
			var self = this;
			this._setStatus('connecting');
			console.log(`[dc-ws] Connecting to ${this.wsUrl} (attempt ${this.reconnectAttempts + 1})`);
			try {
				this.ws = new WebSocket(this.wsUrl, 'v1');
			} catch (e) {
				console.log('[dc-ws] Connection failed - multiplayer disabled');
				window.DC_PRESENCE_ENABLED = false;
				this._setStatus('error');
				return;
			}
			this.ws.onopen = function () {
				// NOTE: reconnectAttempts / reconnectDelay are deliberately NOT reset here.
				// An open socket is not yet a USABLE one — the hub answers auth.hello only
				// after the handshake, and rejects it for a bad session. Clearing the backoff
				// on open made every rejected cycle look like a fresh start, so the attempt
				// counter never climbed to maxReconnectAttempts and the delay never grew:
				// a flat 3s reconnect storm. They are reset in _onWelcome() instead, the
				// first moment the connection is genuinely usable.
				self._connectedOnce = true;
				self._setStatus('connected');
				console.log(`[dc-ws] Connected. Session: ${window.DC_SESSION_ID || 'unknown'}`);
				self._dispatchEvent(document, 'dc:connected');
				self._hello();
				// Keepalive: client sends ping to server
				if (self._keepaliveTimer) clearInterval(self._keepaliveTimer);
				self._keepaliveTimer = setInterval(function () {
					if (self.ws && self.ws.readyState === WebSocket.OPEN && self.authed) {
						// C8/MINOR-5: if a ping has been outstanding for > 2x the keepalive
						// interval with no pong, the hub is gone — force a reconnect.
						// _pingOutstandingSince (unlike _lastPingTs) is not rewritten every
						// tick, so this check can actually become true.
						if (self._pingOutstandingSince && Date.now() - self._pingOutstandingSince > WS_KEEPALIVE_MS * 2) {
							console.warn('[dc-ws] Keepalive timeout - no pong, reconnecting');
							self._pingOutstandingSince = null;
							self._lastPingTs = null;
							try { self.ws.close(); } catch (e) { /* noop */ }
							return;
						}
						var pingTs = Date.now();
						if (!self._pingOutstandingSince) self._pingOutstandingSince = pingTs;
						self._lastPingTs = pingTs;
						self.send('ping', {});
					}
				}, WS_KEEPALIVE_MS);
			};
			this.ws.onmessage = function (e) { self._onFrame(e.data); };
			this.ws.onclose = function (e) {
				self.authed = false;
				// Keep the window mirror in step. It used to be left stale-TRUE here, so
				// after a drop dc-chat.js, dc-multi.js and dc.js all still believed we
				// were authenticated and acted on it. _onWelcome() sets it back to true.
				window.DC_AUTHED = false;
				// C-A2/C8: the in-flight auth.hello and any outstanding ping die with
				// the socket. _hello() mints a fresh _helloId on the next reconnect.
				self._helloId = null;
				self._pingOutstandingSince = null;
				self._lastPingTs = null;
				if (self._keepaliveTimer) {
					clearInterval(self._keepaliveTimer);
					self._keepaliveTimer = null;
				}
				console.log(`[dc-ws] Connection closed. Code: ${e.code}, Reason: ${e.reason || 'none'}`);
				self._setStatus('disconnected');
				self._dispatchEvent(document, 'dc:disconnected');
				// A close with the handshake still in flight is NOT assumed terminal: a hub
				// that is mid-restart drops sockets exactly like that and must still be
				// retried. Terminality is decided by the hub's error code alone
				// (_onAuthFailure); an unanswered handshake just burns one attempt from the
				// bounded budget, which is enough to stop any storm.
				if (!self.closedByUs && self._authTerminal) {
					// Auth is refused for good — do not re-arm. Requirement: the page keeps
					// working, just single-player, and says so on the badge.
					self._setStatus('exhausted');
					return;
				}
				if (!self.closedByUs && self.reconnectAttempts < self.maxReconnectAttempts) {
					self.reconnectAttempts++;
					setTimeout(function () { self._connect(); }, self.reconnectDelay);
					// exponential backoff: double each attempt, cap at 30s, then add jitter (cap AFTER jitter to stay within 30s ceiling)
					const baseDelay = Math.min(self.reconnectDelay * 2, 30000);
					self.reconnectDelay = baseDelay * (0.5 + Math.random() * 0.5);
				} else if (!self.closedByUs) {
					// exhausted reconnect attempts - enable graceful degradation
					if (!self._connectedOnce) {
						console.log('[dc-ws] Connection failed - multiplayer disabled');
						window.DC_PRESENCE_ENABLED = false;
					}
					self._setStatus('exhausted');
				}
			};
			this.ws.onerror = function (e) {
				// Genuine error — always logged (see C4).
				console.warn('[dc-ws] Connection error:', e);
			};
		},

		/**
		 * Send auth.hello on every (re)connect.
		 *
		 * C-A2: the hub answers with a correlated REPLY carrying no `op`, so the
		 * generated uuid is stashed on `_helloId` and _onFrame() matches
		 * `envelope.re === this._helloId && envelope.ok === true`. A fresh uuid is
		 * minted here on every reconnect.
		 */
		_hello: function () {
			var session = window.DC_SESSION_ID || '';
			var helloId = uuid();
			this._helloId = helloId;
			this._sendRaw({
				v: 1,
				id: helloId,
				op: 'auth.hello',
				ts: Math.floor(Date.now() / 1000),
				data: { role: 'admin', session: session }
			});
		},

		/**
		 * Send a raw envelope without waiting for a reply (fire-and-forget).
		 * @param {Object} envelope */
		_sendRaw: function (envelope) {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				const json = JSON.stringify(envelope);
				// C4: this is the hot path (every presence frame). Only build the
				// truncated preview and log when DC_DEBUG is on.
				if (window.DC_DEBUG) {
					if (envelope.op === 'auth.hello') {
						console.log(`[dc-ws] >>> auth.hello role=${envelope.data.role} session=${envelope.data.session}`);
					} else {
						console.log(`[dc-ws] >>> ${envelope.op} ${json.length > 100 ? json.slice(0, 100) + '...' : json}`);
					}
				}
				this.ws.send(json);
			}
		},

		/**
		 * Fire-and-forget v1 envelope.
		 * @param {string} op   Op name, e.g. 'dc.presence.join'.
		 * @param {Object} [data] */
		send: function (op, data) {
			// IDEA-1: batch dc.presence.* ops and flush on next animation frame
			if (op.startsWith('dc.presence.')) {
				if (!this._presenceBatch) this._presenceBatch = [];
				this._presenceBatch.push({ op: op, data: data || {} });
				// Fix #9: batch size cap - flush immediately if too many pending
				if (this._presenceBatch.length > 100) {
					if (this._batchRaf) {
						cancelAnimationFrame(this._batchRaf);
						this._batchRaf = null;
					}
					this._flushPresence();
					return;
				}
				// C7/Fix #9: fallback for backgrounded tabs, where requestAnimationFrame
				// never fires. _lastFlush is written ONLY by _flushPresence(), so this
				// comparison measures real staleness (the old code reset it on every
				// call, making the branch unreachable).
				const now = Date.now();
				if (now - this._lastFlush > 500) {
					if (this._batchRaf) {
						cancelAnimationFrame(this._batchRaf);
						this._batchRaf = null;
					}
					if (window.DC_DEBUG) {
						console.log(`[dc-ws] Batch throttled, ${this._presenceBatch.length} pending`);
					}
					this._flushPresence();
					return;
				}
				// C7: schedule at most one RAF and never cancel/reschedule it — the old
				// cancel-and-reschedule pattern could be pushed back indefinitely by a
				// tight send() loop. Coalescing now happens in _flushPresence() instead,
				// so there is nothing to gain from deferring an already-pending flush.
				if (!this._batchRaf) {
					const self = this;
					this._batchRaf = requestAnimationFrame(function () {
						self._flushPresence();
					});
				}
				return;
			}
			this._sendRaw({
				v: 1,
				id: uuid(),
				op: op,
				ts: Math.floor(Date.now() / 1000),
				data: data || {}
			});
		},

		/**
		 * IDEA-1 / C6: flush the batched presence queue, coalescing it first.
		 *
		 * The old implementation sent every queued entry, so a 100-deep queue became
		 * 100 frames — the batch only deferred work, it never reduced it. Semantics
		 * now: last-write-wins per op key (only the newest dc.presence.move payload
		 * matters), and the surviving entries are emitted in order of their LAST
		 * occurrence in the queue. Distinct ops are never merged together, so a
		 * queued join+leave still produces both frames, and a leave followed by a
		 * re-join followed by a move still emits leave → join → move rather than
		 * hoisting the post-join move ahead of the leave.
		 */
		_flushPresence: function () {
			if (this._presenceBatch && this._presenceBatch.length) {
				// Map preserves insertion order; delete-then-set moves a repeated op to
				// the end so ordering follows the last occurrence.
				const coalesced = new Map();
				for (const entry of this._presenceBatch) {
					if (coalesced.has(entry.op)) coalesced.delete(entry.op);
					coalesced.set(entry.op, entry.data);
				}
				if (window.DC_DEBUG) {
					console.log(`[dc-ws] Flushing ${coalesced.size} presence updates (${this._presenceBatch.length} queued)`);
				}
				this._presenceBatch = [];
				const ts = Math.floor(Date.now() / 1000);
				for (const [op, data] of coalesced) {
					this._sendRaw({
						v: 1,
						id: uuid(),
						op: op,
						ts: ts,
						data: data
					});
				}
			}
			this._batchRaf = null;
			// C7: the ONLY place _lastFlush is written.
			this._lastFlush = Date.now();
		},

		/**
		 * Apply a successful auth payload and announce it.
		 *
		 * Shared by the correlated-reply path (`re` === _helloId, ok true) and the
		 * legacy op-shaped `auth.welcome` fallback so both produce identical state
		 * and an identical dc:auth-success detail shape — downstream modules read
		 * detail.uid / detail.clientId / detail.name.
		 *
		 * @param {Object} data  {session, uid, clientId, name, hub_time}
		 */
		_onWelcome: function (data) {
			data = data || {};
			// This — not ws.onopen — is where the connection becomes usable, so this is where
			// the reconnect budget is refilled. A hub restart mid-session therefore still
			// recovers with a full 10 attempts, while an open-then-rejected cycle keeps
			// burning down the budget until the loop stops.
			this.reconnectAttempts = 0;
			this.reconnectDelay = 3000;
			this._authTerminal = false;
			this.authed = true;
			window.DC_AUTHED = true;
			window.DC_UID = data.uid;
			/**
			 * Unique identifier for this WebSocket connection (this browser tab).
			 * Used to distinguish multiple tabs sharing the same session (same uid).
			 * Stored per-connection, not per-user, enabling multi-tab presence awareness.
			 * Falls back to uid if server does not assign a separate clientId.
			 * @type {number|string}
			 */
			window.DC_CLIENT_ID = data.clientId || data.uid;
			window.DC_PRESENCE = {
				uid: data.uid,
				clientId: window.DC_CLIENT_ID,
				name: data.name,
				session: data.session,
				hub_time: data.hub_time
			};
			window.DC_PRESENCE_ENABLED = true;
			this._dispatchEvent(document, 'dc:auth-success', data);
		},

		/** Handle an incoming JSON frame. */
		_onFrame: function (raw) {
			var envelope;
			try {
				envelope = JSON.parse(raw);
			} catch (e) {
				console.warn('DC_WS: Failed to parse message:', raw?.substring?.(0, 100));
				return;
			}
			var op = envelope.op;
			var data = envelope.data || {};

			// Handle v1 error reply (server sends this when auth fails via sendV1Error).
			// Only ok === false lands here, so the ok === true success reply below is
			// never swallowed by this branch, and EVENTS carry no `ok` at all so a
			// legitimate dc.*/channel.*/chat.* event can never be mistaken for a failure.
			//
			// It must also not treat EVERY failed reply as an auth failure: replies
			// correlate by `re`, and a rejected channel.publish / unknown op answers
			// {ok:false} too. Tearing down presence on one of those wiped every avatar
			// and latched DC_PRESENCE_ENABLED=false until the next reconnect — a chat
			// error killed multiplayer. Only the reply to our own in-flight auth.hello
			// (or, while still unauthenticated, the only request that can be outstanding)
			// says anything about our auth state.
			if (envelope.ok === false && envelope.error) {
				var isAuthReply = (envelope.re && envelope.re === this._helloId)
					|| (!this.authed && !!this._helloId);
				if (!isAuthReply) {
					if (window.DC_DEBUG) {
						console.warn('[dc-ws] request failed', envelope.re, envelope.error);
					}
					return;
				}
				this._onAuthFailure(envelope.error);
				return;
			}

			// C4: logging on the hot path is DC_DEBUG-only and stringifies at most once.
			if (window.DC_DEBUG) {
				const dataJson = JSON.stringify(data);
				console.info('[dc-ws] <<', { op: op, re: envelope.re, ok: envelope.ok, data: dataJson.length > 100 ? dataJson.slice(0, 100) + '...' : dataJson });
			}

			// C-A2: the auth.hello answer is a CORRELATED REPLY — {v:1, re:<hello id>,
			// ok:true, data:{...}} with NO op field. This, not an `auth.welcome` event,
			// is what the hub actually sends (PROTOCOL_V1 §1).
			if (this._helloId && envelope.re === this._helloId && envelope.ok === true) {
				this._helloId = null;
				this._onWelcome(data);
				return;
			}

			// Fallback: harmlessly accept an op-shaped auth.welcome event too.
			if (op === 'auth.welcome') {
				this._helloId = null;
				this._onWelcome(data);
				return;
			}

			// auth.rejected — authentication failed
			if (op === 'auth.rejected') {
				this._onAuthFailure(data.error);
				return;
			}

			// pong — server responded to our keepalive ping
			if (op === 'pong') {
				// IDEA-7: track latency
				this._lastPongTs = Date.now();
				// C8: the hub answered — no ping is outstanding any more, so the
				// watchdog clock stops.
				this._pingOutstandingSince = null;
				if (this._lastPingTs) {
					const latency = Date.now() - this._lastPingTs;
					window.DC_LATENCY = latency;
					if (!window.DC_DEBUG_PING_HISTORY) window.DC_DEBUG_PING_HISTORY = [];
					window.DC_DEBUG_PING_HISTORY.push(latency);
					if (window.DC_DEBUG_PING_HISTORY.length > 10) {
						window.DC_DEBUG_PING_HISTORY.shift();
					}
					this._lastPingTs = null;
				}
				return;
			}

			// ping — server health check, respond with pong
			if (op === 'ping') {
				this.send('pong', data || {});
				return;
			}

			// Forward dc.*, channel.*, chat.* as dc:v1-event
			if (op && (op.startsWith('dc.') || op.startsWith('channel.') || op.startsWith('chat.'))) {
				this._dispatchEvent(document, 'dc:v1-event', { op: op, data: data });
			}
		},

		/**
		 * Auth was refused. Shared by the correlated `{re:_helloId, ok:false}` reply and the
		 * op-shaped `auth.rejected` event so both produce the same state and the same
		 * dc:auth-failure detail.
		 *
		 * Terminal causes stop the reconnect loop outright — see _giveUpOnAuth. Everything
		 * else stays on the bounded exponential backoff, because a hub that is mid-restart
		 * can legitimately refuse one handshake and accept the next.
		 * @param {{code?:string, message?:string}} [error]
		 */
		_onAuthFailure: function (error) {
			var err = error || {};
			this.authed = false;
			window.DC_AUTHED = false;
			this._helloId = null;
			this._dispatchEvent(document, 'dc:auth-failure', { error: err });
			// Terminality is a property of the hub's error CODE, not of our own session
			// string: an empty DC_SESSION_ID is answered with bad_session, which is already
			// in the terminal list, while a transient server_error on a mid-restart hub must
			// stay retryable even when the session happens to be empty.
			var code = String(err.code || '').toLowerCase();
			if (TERMINAL_AUTH_CODES.indexOf(code) !== -1) {
				this._giveUpOnAuth(code);
			}
		},

		/**
		 * Stop trying to authenticate for the rest of this page load.
		 *
		 * The socket layer is healthy — it is the credential that is wrong — so nothing in
		 * the transport's own retry logic would ever stop. Latch it here, disable presence
		 * so every send short-circuits, and drop the useless socket: onclose sees
		 * _authTerminal, skips the re-arm and reports the 'exhausted' status that
		 * dc-presence renders as "Offline" on the #dcPresence badge.
		 *
		 * An explicit _connect() (dc-chat's "Chat: ON") may still try again, and a
		 * successful _onWelcome() clears the latch.
		 * @param {string} why
		 */
		_giveUpOnAuth: function (why) {
			// Log/latch once, but always re-assert the degraded state and always drop the
			// socket: dc-chat's "Chat: ON" can call _connect() again on an already-terminal
			// client, and that attempt still has to end with no socket left open.
			if (!this._authTerminal) {
				this._authTerminal = true;
				console.log(`[dc-ws] Authentication refused (${why}) - multiplayer disabled, not retrying`);
			}
			window.DC_PRESENCE_ENABLED = false;
			// 3 === WebSocket.CLOSED. When the socket is still up, close() drives onclose,
			// which emits 'exhausted'; when it is already gone, say so here instead.
			if (this.ws && this.ws.readyState !== 3) {
				try { this.ws.close(); } catch (e) { /* noop */ }
			} else {
				this._setStatus('exhausted');
			}
		},

		/**
		 * Dispatch a custom DOM event on a target element.
		 * @param {EventTarget} target
		 * @param {string} eventName
		 * @param {*} [detail] */
		_dispatchEvent: function (target, eventName, detail) {
			var event;
			if (typeof CustomEvent === 'function') {
				event = new CustomEvent(eventName, { detail: detail, bubbles: true });
			} else {
				// IE fallback
				event = document.createEvent('CustomEvent');
				event.initCustomEvent(eventName, true, true, detail);
			}
			target.dispatchEvent(event);
		},

		/**
		 * Record and broadcast the transport status.
		 *
		 * CONTRACT STATUS-EVENT: also dispatches `dc:ws-status` on document with
		 * detail = {status}, where status is one of 'connecting', 'connected',
		 * 'disconnected', 'error', 'exhausted'. dc-presence.js listens for this and
		 * reflects it on the #dcPresence badge, so a dead hub is visible in the UI.
		 *
		 * @param {string} status
		 */
		_setStatus: function (status) {
			this.status = status;
			if (typeof window.DC_DEBUG !== 'undefined' && window.DC_DEBUG) {
				console.log('[dc-ws]', status);
			}
			try {
				this._dispatchEvent(document, 'dc:ws-status', { status: status });
			} catch (e) {
				// Never let a listener (or a missing CustomEvent shim) break the transport.
			}
		},

		// IDEA-7: get average latency from ping history
		getLatency: function () {
			const history = window.DC_DEBUG_PING_HISTORY || [];
			if (history.length === 0) return null;
			const sum = history.reduce((a, b) => a + b, 0);
			return Math.round(sum / history.length);
		},

		// Debug: get comprehensive connection state
		getState: function () {
			return {
				connected: this.connected(),
				authenticated: this.authed,
				clientId: window.DC_UID || null,
				sessionId: window.DC_SESSION_ID || null,
				latency: window.DC_LATENCY || null,
				lastPing: this._lastPingTs || null,
				lastPong: this._lastPongTs || null,
				// C8: non-null while a keepalive ping is awaiting its pong
				pingOutstandingSince: this._pingOutstandingSince || null,
				// CONTRACT STATUS-EVENT: last status broadcast via dc:ws-status
				status: this.status || null,
				// true once auth was refused for a reason retrying cannot fix
				authTerminal: this._authTerminal,
				// Note: This is the NEXT attempt number (pre-increment), not completed attempts
				reconnectAttempts: this.reconnectAttempts,
				presenceEnabled: window.DC_PRESENCE_ENABLED !== false
			};
		},

		// IDEA-2: check if WebSocket is currently connected
		connected: function () {
			return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
		},

		// IDEA-3: send throttled viewport updates (500ms cooldown)
		_updateViewport: function (data) {
			// data: { x, y, z, dirX, dirY, dirZ } — camera position + look direction
			this._viewport = data;
			// MAJOR-7: 100ms throttle before the existing 500ms cooldown
			if (this._viewportSendTimer) return;
			if (!this._lastViewportUpdate) this._lastViewportUpdate = 0;
			const now = Date.now();
			if (now - this._lastViewportUpdate < 100) return;
			this._lastViewportUpdate = now;
			this._viewportSendTimer = setTimeout(() => {
				this._viewportSendTimer = null;
				this._sendRaw({
					v: 1,
					id: uuid(),
					op: 'dc.viewport.update',
					ts: Math.floor(Date.now() / 1000),
					data: this._viewport
				});
			}, 500);
		},

		/** Close the socket and suppress the reconnect loop. */
		destroy: function () {
			this.closedByUs = true;
			this._helloId = null;
			this._pingOutstandingSince = null;
			if (this._keepaliveTimer) {
				clearInterval(this._keepaliveTimer);
				this._keepaliveTimer = null;
			}
			// IDEA-1: flush any pending presence batch before destroy
			if (this._batchRaf) {
				cancelAnimationFrame(this._batchRaf);
				this._batchRaf = null;
			}
			if (this._presenceBatch && this._presenceBatch.length) {
				this._flushPresence();
			}
			this._presenceBatch = null;
			// IDEA-3: cancel any pending viewport throttle timer
			if (this._viewportSendTimer) {
				clearTimeout(this._viewportSendTimer);
				this._viewportSendTimer = null;
			}
			if (this.ws) {
				try { this.ws.close(); } catch (e) { /* noop */ }
			}
		}
	};

	/* -------------------------- bootstrap -------------------------- */

	// Expose module state on window
	window.DC_WS = null;       // set after instantiation
	window.DC_AUTHED = false;
	window.DC_UID = null;
	window.DC_PRESENCE = null;

	/**
	 * Fire-and-forget sender for presence ops. Use instead of DC_WS.send()
	 * when you don't need a reply and want to decouple from the DC_WS instance.
	 * @param {string} op   Op name, e.g. 'dc.presence.join'.
	 * @param {Object} [data] */
	window.DC_PRESENCE_SEND = function (op, data) {
		if (window.DC_WS && window.DC_WS.connected()) {
			window.DC_WS.send(op, data);
		}
	};

	// C2: DC_PRESENCE_JOIN / DC_PRESENCE_MOVE / DC_PRESENCE_LEAVE are deliberately
	// NOT defined here. dc-presence.js owns them (it loads later and overwrote these
	// copies anyway, so they were dead code), and the copies that used to live here
	// were wrong: they sent `facing:` where the hub reads `yaw:`, and the move sender
	// attached a caller-supplied `clientId` the hub mis-parses — an authorization
	// hole. The DC_PRESENCE_ENABLED === false short-circuit they provided now lives
	// in dc-presence.js's own send() helper (CONTRACT with the dc-presence agent).
	// Use window.DC_PRESENCE_SEND above for raw fire-and-forget presence ops.

	// Auto-connect when the DOM is ready
	function init() {
		var client = new Client();
		window.DC_WS = client;
		client._connect();

		// IDEA-2: Handle GPU context loss - notify hub and pause
		document.addEventListener('dc:context-lost', function () {
			console.warn('[dc-ws] GPU context lost, will restore when available');
		});
		document.addEventListener('dc:context-restored', function () {
			console.warn('[dc-ws] GPU context restored');
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

}());
