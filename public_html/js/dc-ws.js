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
 *   dc:auth-success  — auth.welcome received; detail = {uid, clientId, name, session, hub_time}
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
				this.ws = new WebSocket(this.wsUrl);
			} catch (e) {
				console.log('[dc-ws] Connection failed - multiplayer disabled');
				window.DC_PRESENCE_ENABLED = false;
				this._setStatus('error');
				return;
			}
			this.ws.onopen = function () {
				self.reconnectAttempts = 0;
				self.reconnectDelay = 3000;
				self._connectedOnce = true;
				self._setStatus('connected');
				console.log(`[dc-ws] Connected. Session: ${window.DC_SESSION_ID || 'unknown'}`);
				self._dispatchEvent(document, 'dc:connected');
				self._hello();
				// Keepalive: client sends ping to server
				if (self._keepaliveTimer) clearInterval(self._keepaliveTimer);
				self._keepaliveTimer = setInterval(function () {
					if (self.ws && self.ws.readyState === WebSocket.OPEN && self.authed) {
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
			this.ws.onclose = function (e) {
				self.authed = false;
				if (self._keepaliveTimer) {
					clearInterval(self._keepaliveTimer);
					self._keepaliveTimer = null;
				}
				console.log(`[dc-ws] Connection closed. Code: ${e.code}, Reason: ${e.reason || 'none'}`);
				self._setStatus('disconnected');
				self._dispatchEvent(document, 'dc:disconnected');
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
				console.log('[dc-ws] Connection error:', e);
			};
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
				const json = JSON.stringify(envelope);
				// Debug logging for sent messages
				const dataStr = json.length > 100 ? json.slice(0, 100) + '...' : json;
				console.log(`[dc-ws] >>> ${envelope.op} ${dataStr}`);
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
                // Fix #9: setTimeout fallback when tab is backgrounded (RAF doesn't fire)
                const now = Date.now();
                if (this._lastFlush && now - this._lastFlush > 500) {
                    if (this._batchRaf) {
                        cancelAnimationFrame(this._batchRaf);
                        this._batchRaf = null;
                    }
                    console.log(`[dc-ws] Batch throttled, ${this._presenceBatch.length} pending`);
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
				console.log(`[dc-ws] Flushing ${this._presenceBatch.length} presence updates`);
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

			// Handle v1 error reply (server sends this when auth fails via sendV1Error)
			if (envelope.ok === false && envelope.error) {
				this.authed = false;
				window.DC_AUTHED = false;
				this._dispatchEvent(document, 'dc:auth-failure', { error: envelope.error || {} });
				return;
			}

			// Debug logging for received messages
			const dataStr = JSON.stringify(data).length > 100 ? JSON.stringify(data).slice(0, 100) + '...' : JSON.stringify(data);
			console.log(`[dc-ws] <<< ${op} ${dataStr}`);

			// Debug logging for presence updates from others
			if (op === 'dc.presence.move' && data.name) {
				console.log(`[dc-ws] Remote avatar ${data.name} moved to (${data.x}, ${data.z})`);
			}
			if (op === 'dc.presence.join' && data.name) {
				console.log(`[dc-ws] ${data.name} joined (client ${data.clientId || 'unknown'})`);
			}
			if (op === 'dc.presence.leave' && data.name) {
				console.log(`[dc-ws] ${data.name} left`);
			}

			// auth.welcome — authentication succeeded
			if (op === 'auth.welcome') {
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
				this._lastPongTs = Date.now();
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
				console.log('[dc-ws]', status);
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

	// Presence functions that gracefully degrade when WebSocket is not available
	// DC_PRESENCE_JOIN - join the presence session
	window.DC_PRESENCE_JOIN = function(x, z, facing) {
		if (window.DC_PRESENCE_ENABLED === false) {
			console.log('[dc-presence] WS not connected, join skipped');
			return;
		}
		if (window.DC_WS && window.DC_WS.connected()) {
			window.DC_WS.send('dc.presence.join', { x: x, z: z, facing: facing });
		}
	};

	// DC_PRESENCE_MOVE - update presence position
	window.DC_PRESENCE_MOVE = function(x, z, facing) {
		if (window.DC_PRESENCE_ENABLED === false) {
			console.log('[dc-presence] WS not connected, move skipped');
			return;
		}
		if (window.DC_WS && window.DC_WS.connected()) {
			window.DC_WS.send('dc.presence.move', { x: x, z: z, facing: facing, clientId: window.DC_CLIENT_ID });
		}
	};

	// DC_PRESENCE_LEAVE - leave the presence session
	window.DC_PRESENCE_LEAVE = function() {
		if (window.DC_PRESENCE_ENABLED === false) {
			console.log('[dc-presence] WS not connected, leave skipped');
			return;
		}
		if (window.DC_WS && window.DC_WS.connected()) {
			window.DC_WS.send('dc.presence.leave', {});
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
