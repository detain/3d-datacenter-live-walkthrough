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
 *   auth.hello  C→H  — {role:"admin", session:DC_SESSION_ID}; reply is
 *                       auth.welcome {session, uid, name, hub_time}.
 *
 * Ops this module receives:
 *   auth.welcome  H→C  — auth success; triggers dc:auth-success.
 *   auth.rejected  H→C  — auth failure; triggers dc:auth-failure.
 *   dc.*, channel.*, chat.*  H→C  — forwarded as dc:v1-event.
 *
 * ---------------------------------------------------------------------------
 * Exports (window)
 * ---------------------------------------------------------------------------
 *   DC_WS             — this module (instance with request/destroy)
 *   DC_AUTHED         — boolean, true after auth.welcome received
 *   DC_UID            — numeric uid from auth.welcome
 *   DC_PRESENCE       — presence data object from auth.welcome
 *   DC_PRESENCE_SEND  — fire-and-forget sender for dc.presence.* ops
 *
 * ---------------------------------------------------------------------------
 * DOM Events
 * ---------------------------------------------------------------------------
 *   dc:connected     — socket opened, auth.hello sent
 *   dc:disconnected  — socket closed (after reconnect exhaustion or destroy)
 *   dc:auth-success  — auth.welcome received; detail = {uid, name, session, hub_time}
 *   dc:auth-failure   — auth.rejected received; detail = {error:{code,message}}
 *   dc:v1-event       — any incoming dc.*, channel.*, chat.* op;
 *                       detail = {op, data} (the raw envelope sans v/version)
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
			const allowedHosts = ['mystage.interserver.net', 'localhost', '127.0.0.1'];
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
		// MINOR-5: ping timestamp tracking
		this._lastPingTs = null;
		// IDEA-1: presence batching
		this._presenceBatch = null;
		this._batchRaf = null;
		this._lastFlush = null;  // Fix #9: setTimeout fallback for backgrounded tabs
		// IDEA-7: latency tracking
		this._latencyHistory = [];
		// IDEA-3: viewport update throttle
		this._viewportSendTimer = null;
		this._viewport = null;
	}

	Client.prototype = {

		_connect: function () {
			var self = this;
			this._setStatus('connecting');
			try {
				this.ws = new WebSocket(this.wsUrl);
			} catch (e) {
				this._setStatus('error');
				return;
			}
			this.ws.onopen = function () {
				self.reconnectAttempts = 0;
				self.reconnectDelay = 3000;
				self._dispatchEvent(document, 'dc:connected');
				self._hello();
				// Keepalive: client sends ping to server
				if (self._keepaliveTimer) clearInterval(self._keepaliveTimer);
				self._keepaliveTimer = setInterval(function () {
					if (self.ws && self.ws.readyState === WebSocket.OPEN) {
						// MINOR-5: If we sent a ping > 2x keepalive interval ago without response, reconnect
						if (self._lastPingTs && Date.now() - self._lastPingTs > WS_KEEPALIVE_MS * 2) {
							self.ws.close();
							return;
						}
						self._lastPingTs = Date.now();
						self.send('ping', {});
					}
				}, WS_KEEPALIVE_MS);
			};
			this.ws.onmessage = function (e) { self._onFrame(e.data); };
			this.ws.onclose = function () {
				self.authed = false;
				if (self._keepaliveTimer) {
					clearInterval(self._keepaliveTimer);
					self._keepaliveTimer = null;
				}
				self._setStatus('disconnected');
				self._dispatchEvent(document, 'dc:disconnected');
				if (!self.closedByUs && self.reconnectAttempts < self.maxReconnectAttempts) {
					self.reconnectAttempts++;
					setTimeout(function () { self._connect(); }, self.reconnectDelay);
					// exponential backoff: double each attempt, cap at 30s, then add jitter
					self.reconnectDelay = Math.min(self.reconnectDelay * 2, 30000) + Math.random() * 500;
				} else if (!self.closedByUs) {
					// exhausted reconnect attempts
					self._setStatus('exhausted');
				}
			};
			this.ws.onerror = function () { /* onclose follows */ };
		},

		/** Send auth.hello on every (re)connect. */
		_hello: function () {
			var session = window.DC_SESSION_ID || '';
			this._sendRaw({
				v: 1,
				id: uuid(),
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
				this.ws.send(JSON.stringify(envelope));
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
                // Fix #9: setTimeout fallback when tab is backgrounded (RAF doesn't fire)
                const now = Date.now();
                if (this._lastFlush && now - this._lastFlush > 500) {
                    if (this._batchRaf) {
                        cancelAnimationFrame(this._batchRaf);
                        this._batchRaf = null;
                    }
                    this._flushPresence();
                    return;
                }
				this._lastFlush = now;
			if (this._batchRaf) {
				cancelAnimationFrame(this._batchRaf);
			}
			const self = this;
			this._batchRaf = requestAnimationFrame(function () {
				self._flushPresence();
			});
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

		// IDEA-1: flush batched presence moves
		_flushPresence: function () {
			if (this._presenceBatch && this._presenceBatch.length) {
				for (const { op, data } of this._presenceBatch) {
					this._sendRaw({
						v: 1,
						id: uuid(),
						op: op,
						ts: Math.floor(Date.now() / 1000),
						data: data
					});
				}
				this._presenceBatch = [];
			}
			this._batchRaf = null;
			this._lastFlush = Date.now();  // Fix #9: track last flush for setTimeout fallback
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

			// auth.welcome — authentication succeeded
			if (op === 'auth.welcome') {
				this.authed = true;
				window.DC_AUTHED = true;
				window.DC_UID = data.uid;
				window.DC_PRESENCE = {
					uid: data.uid,
					name: data.name,
					session: data.session,
					hub_time: data.hub_time
				};
				this._dispatchEvent(document, 'dc:auth-success', data);
				return;
			}

			// auth.rejected — authentication failed
			if (op === 'auth.rejected') {
				this.authed = false;
				window.DC_AUTHED = false;
				this._dispatchEvent(document, 'dc:auth-failure', { error: data.error || {} });
				return;
			}

			// pong — server responded to our keepalive ping
			if (op === 'pong') {
				// IDEA-7: track latency
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

		_setStatus: function (status) {
			if (typeof window.DC_DEBUG !== 'undefined' && window.DC_DEBUG) {
				console.debug('[dc-ws]', status);
			}
		},

		// IDEA-7: get average latency from ping history
		getLatency: function () {
			const history = window.DC_DEBUG_PING_HISTORY || [];
			if (history.length === 0) return null;
			const sum = history.reduce((a, b) => a + b, 0);
			return Math.round(sum / history.length);
		},

		// IDEA-2: check if WebSocket is currently connected
		connected: function () {
			return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
		},

		// IDEA-3: send throttled viewport updates (500ms cooldown)
		_updateViewport: function (data) {
			// data: { x, y, z, dirX, dirY, dirZ } — camera position + look direction
			this._viewport = data;
			if (this._viewportSendTimer) return;
			this._viewportSendTimer = setTimeout(() => {
				this._viewportSendTimer = null;
				this._sendRaw({
					v: 1,
					id: uuid(),
					op: 'dc.viewport.update',
					ts: Math.floor(Date.now() / 1000),
					data: data
				});
			}, 500);
		},

		/** Close the socket and suppress the reconnect loop. */
		destroy: function () {
			this.closedByUs = true;
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
		if (window.DC_WS) {
			window.DC_WS.send(op, data);
		}
	};

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
