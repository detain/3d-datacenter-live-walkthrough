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

	function uuid() {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
			var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
			return v.toString(16);
		});
	}

	/* -------------------------- Client -------------------------- */

	function Client() {
		/** @type {WebSocket|null} */
		this.ws = null;
		this.authed = false;
		this.closedByUs = false;
		this.reconnectAttempts = 0;
		this.reconnectDelay = 3000; // 3 seconds initial
		this.maxReconnectAttempts = 10;
		this.wsUrl = 'wss://mystage.interserver.net:7272';
		this._keepaliveTimer = null;
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
				// Keepalive: client sends ping to server every 30s
				if (self._keepaliveTimer) clearInterval(self._keepaliveTimer);
				self._keepaliveTimer = setInterval(function () {
					if (self.ws && self.ws.readyState === WebSocket.OPEN) {
						self.send({v:1, op: 'ping', id: 'keepalive', ts: Date.now(), data: {}});
					}
				}, 30000);
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
					// exponential backoff: double each attempt, add jitter, cap at 30s
					self.reconnectDelay = Math.min(self.reconnectDelay * 2 + Math.random() * 500, 30000);
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
			this._sendRaw({
				v: 1,
				id: uuid(),
				op: op,
				ts: Math.floor(Date.now() / 1000),
				data: data || {}
			});
		},

		/** Handle an incoming JSON frame. */
		_onFrame: function (raw) {
			var envelope;
			try {
				envelope = JSON.parse(raw);
			} catch (e) {
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

			// ping — server health check, respond with pong
			if (op === 'ping') {
				this.send({v:1, op: 'pong', id: envelope.id, ts: Date.now(), data: data || {}});
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

		/** Close the socket and suppress the reconnect loop. */
		destroy: function () {
			this.closedByUs = true;
			if (this._keepaliveTimer) {
				clearInterval(this._keepaliveTimer);
				this._keepaliveTimer = null;
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
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

}());
