/**
 * dc-chat.js — Transparent chat frame overlay for the 3D datacenter walkthrough.
 *
 * Provides a floating chat widget in the bottom-left corner that connects to the
 * NOC chat channel via the DC_WS WebSocket connection.
 *
 * ---------------------------------------------------------------------------
 * Features
 * ---------------------------------------------------------------------------
 *   - Semi-transparent dark chat frame in bottom-left viewport corner
 *   - Rolling 20-message buffer with auto-scroll to newest
 *   - Input area revealed on hover, hidden on mouse-leave
 *   - WebSocket integration via existing DC_WS global (listens for dc:auth-success)
 *   - Auto-joins channel "chat:noc" on authentication
 *   - Sends messages via channel.publish op
 *   - Handles channel.message and chat.message incoming events
 *   - /status command sent to server via channel.publish
 *   - System/info/warn/error messages styled distinctly
 *
	 * ---------------------------------------------------------------------------
	 * Exported API (window.DC_CHAT)
	 * ---------------------------------------------------------------------------
	 *   init()         — boot the module (called automatically on DOMContentLoaded)
	 *   sendMessage(text)  — publish a message to chat:noc
	 *   addMessage(msg)    — insert a synthetic message into the local buffer
	 *   clearMessages()    — wipe the visible message list
	 *   destroy()         — tear down the module and release resources
 *
 * ---------------------------------------------------------------------------
 * v1 Envelope Reference (PROTOCOL_V1.md §1)
 * ---------------------------------------------------------------------------
 *   request  {v:1, id:"<uuid>", op:"<ns.verb>", ts:<unix>, data:{}}
 *   server→client events reuse the request shape (fresh id, an op, no re).
 *
 * Ops this module sends:
 *   channel.join     C→H  — {channel:"chat:noc"}
 *   channel.publish  C→H  — {channel:"chat:noc", body:"<text>", level:"chat"}
 *
 * Ops this module receives (via dc:v1-event):
 *   channel.message  H→C  — {channel, from, from_name, body, level, ts}
 *   chat.message     H→C  — {body, from, from_name, level, ts}
 */

(function () {
	'use strict';

	/* -------------------------- UUID helper -------------------------- */

	/**
	 * Generate a v4 UUID using crypto.randomUUID fallback.
	 * @returns {string}
	 */
	const uuid = () => (
		typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
			})
	);

	/* -------------------------- Module state -------------------------- */

	/** @type {DC_CHAT_API|null} */
	let _instance = null;

	/** Rolling buffer of the last 20 displayed messages. */
	const _messageBuffer = [];

	/** Maximum messages to retain in the buffer. */
	const MAX_MESSAGES = 20;

	/** @type {string} NOC chat channel name. */
	const CHANNEL_NOC = 'chat:noc';

	/** Module-level idle state exposed for use by _renderMessage */
	const _idleState = {
		resetFn: /** @type {((frame: HTMLElement) => void)|null} */ (null)
	};

	/**
	 * WebSocket connection toggle state.
	 * When false, the chat frame is hidden and DC_WS connection is not used.
	 * Persisted to localStorage under 'dc_ws_enabled'.
	 * @type {boolean}
	 */
	let wsEnabled = true;

	/** localStorage key for persisting the wsEnabled preference */
	const WS_ENABLED_KEY = 'dc_ws_enabled';

	/* -------------------------- Safe storage helpers -------------------------- */

	/*
	 * localStorage is not always reachable. In Safari private mode, sandboxed or
	 * third-party iframes, and under strict cookie policies, *touching*
	 * window.localStorage throws (SecurityError) — and in non-browser hosts the
	 * identifier isn't defined at all. An unguarded read in _boot() therefore takes
	 * out the whole module and window.DC_CHAT never gets defined. All access goes
	 * through these helpers, which degrade to the in-memory default (wsEnabled = true).
	 */

	/**
	 * Read a key from localStorage, or null when storage is unavailable.
	 * @param {string} key
	 * @returns {string|null}
	 */
	function _storageGet(key) {
		try {
			if (typeof localStorage === 'undefined' || !localStorage) return null;
			return localStorage.getItem(key);
		} catch (e) {
			return null;
		}
	}

	/**
	 * Persist a key to localStorage. Never throws; returns false when it couldn't.
	 * @param {string} key
	 * @param {string} value
	 * @returns {boolean}
	 */
	function _storageSet(key, value) {
		try {
			if (typeof localStorage === 'undefined' || !localStorage) return false;
			localStorage.setItem(key, value);
			return true;
		} catch (e) {
			return false;
		}
	}

	/* -------------------------- DOM helpers -------------------------- */

	/**
	 * Create and inject the <style> element for .dc-chat-* classes.
	 * @param {string} css
	 * @returns {HTMLStyleElement}
	 */
	function _injectStyle(css) {
		const style = document.createElement('style');
		style.textContent = css;
		document.head.appendChild(style);
		return style;
	}

	/**
	 * Dispatch a CustomEvent on a target.
	 * @param {EventTarget} target
	 * @param {string} eventName
	 * @param {*} [detail]
	 */
	function _dispatchEvent(target, eventName, detail) {
		const event = new CustomEvent(eventName, { detail, bubbles: true });
		target.dispatchEvent(event);
	}

	/* -------------------------- Chat Frame UI -------------------------- */

	/**
	 * Build the complete chat frame DOM subtree and wire up event listeners.
	 * All styles are injected via a <style> tag — no external CSS required.
	 *
	 * @returns {{ frame: HTMLElement, styleEl: HTMLStyleElement, messagesEl: HTMLElement, inputEl: HTMLInputElement }}
	 */
	function _buildChatFrame() {
		// ---- Styles ------------------------------------------------------------
		const styleEl = _injectStyle(`
			.dc-chat-frame {
				position: fixed;
				bottom: 0;
				left: 0;
				width: 320px;
				height: 420px;
				display: flex;
				flex-direction: column;
				font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
				font-size: 13px;
				color: #e8e8f0;
				background: rgba(20, 20, 28, 0.85);
				backdrop-filter: blur(8px);
				-webkit-backdrop-filter: blur(8px);
				border-top-right-radius: 10px;
				border-top: 1px solid rgba(255, 255, 255, 0.08);
				border-right: 1px solid rgba(255, 255, 255, 0.08);
				z-index: 9998;
				overflow: hidden;
				opacity: 0.03;
				transition: opacity 0.3s ease, height 0.25s ease;
			}

			.dc-chat-frame:hover,
			.dc-chat-frame:focus-within {
				opacity: 1;
			}

			.dc-chat-frame.dc-chat-idle {
				pointer-events: none;
			}

			.dc-chat-frame.dc-chat-idle:hover,
			.dc-chat-frame.dc-chat-idle:focus-within {
				pointer-events: auto;
			}

			.dc-chat-header {
				display: flex;
				align-items: center;
				padding: 10px 14px;
				background: rgba(255, 255, 255, 0.04);
				border-bottom: 1px solid rgba(255, 255, 255, 0.06);
				cursor: default;
				user-select: none;
			}

			.dc-chat-header-dot {
				width: 8px;
				height: 8px;
				border-radius: 50%;
				background: #4caf50;
				margin-right: 8px;
				box-shadow: 0 0 6px #4caf50;
			}

			.dc-chat-header-title {
				font-weight: 600;
				font-size: 13px;
				letter-spacing: 0.02em;
				color: #b8b8d0;
				text-transform: uppercase;
			}

			.dc-chat-messages {
				flex: 1;
				overflow-y: auto;
				padding: 10px 12px;
				display: flex;
				flex-direction: column;
				gap: 6px;
				scrollbar-width: thin;
				scrollbar-color: rgba(255,255,255,0.15) transparent;
			}

			.dc-chat-messages::-webkit-scrollbar {
				width: 4px;
			}
			.dc-chat-messages::-webkit-scrollbar-thumb {
				background: rgba(255, 255, 255, 0.15);
				border-radius: 2px;
			}

			.dc-chat-msg {
				line-height: 1.4;
				word-break: break-word;
			}

			.dc-chat-msg-from {
				font-weight: 600;
				color: #a8d8ff;
				margin-right: 4px;
			}

			.dc-chat-msg-body {
				color: #d8d8e8;
			}

			/* System / info / warn / error — italic, dimmer */
			.dc-chat-msg-level-info,
			.dc-chat-msg-level-warn,
			.dc-chat-msg-level-error,
			.dc-chat-msg-system {
				font-style: italic;
				color: rgba(200, 200, 220, 0.6);
			}

			.dc-chat-msg-level-warn {
				color: rgba(255, 200, 80, 0.7);
			}

			.dc-chat-msg-level-error {
				color: rgba(255, 100, 100, 0.7);
			}

			.dc-chat-input-area {
				padding: 10px 12px;
				display: flex;
				gap: 8px;
				background: rgba(255, 255, 255, 0.03);
				border-top: 1px solid rgba(255, 255, 255, 0.06);
				opacity: 0;
				transform: translateY(6px);
				transition: opacity 0.2s ease, transform 0.2s ease;
				pointer-events: none;
			}

			.dc-chat-input-area.visible {
				opacity: 1;
				transform: translateY(0);
				pointer-events: auto;
			}

			.dc-chat-input {
				flex: 1;
				background: rgba(255, 255, 255, 0.07);
				border: 1px solid rgba(255, 255, 255, 0.12);
				border-radius: 6px;
				padding: 7px 10px;
				color: #e8e8f0;
				font-size: 13px;
				font-family: inherit;
				outline: none;
				transition: border-color 0.15s;
			}

			.dc-chat-input::placeholder {
				color: rgba(200, 200, 220, 0.4);
			}

			.dc-chat-input:focus {
				border-color: rgba(100, 180, 255, 0.5);
			}

			.dc-chat-send-btn {
				background: rgba(80, 140, 255, 0.8);
				border: none;
				border-radius: 6px;
				padding: 7px 14px;
				color: #fff;
				font-size: 12px;
				font-weight: 600;
				font-family: inherit;
				cursor: pointer;
				letter-spacing: 0.03em;
				transition: background 0.15s;
				white-space: nowrap;
			}

			.dc-chat-send-btn:hover {
				background: rgba(100, 160, 255, 0.9);
			}

			.dc-chat-send-btn:active {
				background: rgba(60, 120, 240, 0.95);
			}

			.dc-chat-frame.dc-chat-idle .dc-chat-msg {
				opacity: 0.03;
			}
			.dc-chat-frame.dc-chat-idle .dc-chat-msg-recent {
				opacity: 1;
				transition: opacity 0.3s ease;
			}
		`);

		// ---- Frame container ---------------------------------------------------
		const frame = document.createElement('div');
		frame.className = 'dc-chat-frame';
		frame.setAttribute('role', 'log');
		frame.setAttribute('aria-label', 'NOC Chat');

		// ---- Header -----------------------------------------------------------
		const header = document.createElement('div');
		header.className = 'dc-chat-header';

		const dot = document.createElement('div');
		dot.className = 'dc-chat-header-dot';
		dot.title = 'Connected';

		const title = document.createElement('span');
		title.className = 'dc-chat-header-title';
		title.textContent = 'NOC Chat';

		header.appendChild(dot);
		header.appendChild(title);

		// ---- Message list -----------------------------------------------------
		const messagesEl = document.createElement('div');
		messagesEl.className = 'dc-chat-messages';
		messagesEl.setAttribute('aria-live', 'polite');
		messagesEl.setAttribute('aria-atomic', 'false');

		// ---- Input area -------------------------------------------------------
		const inputArea = document.createElement('div');
		inputArea.className = 'dc-chat-input-area';

		const inputEl = document.createElement('input');
		inputEl.className = 'dc-chat-input';
		inputEl.type = 'text';
		inputEl.placeholder = 'Type a message…';
		inputEl.setAttribute('aria-label', 'Chat message');

		const sendBtn = document.createElement('button');
		sendBtn.className = 'dc-chat-send-btn';
		sendBtn.textContent = 'Send';
		sendBtn.setAttribute('aria-label', 'Send message');

		inputArea.appendChild(inputEl);
		inputArea.appendChild(sendBtn);

		// ---- Assemble ---------------------------------------------------------
		frame.appendChild(header);
		frame.appendChild(messagesEl);
		frame.appendChild(inputArea);
		document.body.appendChild(frame);

		// ---- Hover show/hide input area ----------------------------------------
		frame.addEventListener('mouseenter', () => {
			inputArea.classList.add('visible');
		});
		frame.addEventListener('mouseleave', () => {
			inputArea.classList.remove('visible');
		});

		// ---- Send on Enter keypress, blur on Esc/Tab ------------------------------------------
		inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				const text = inputEl.value;
				if (text.trim()) {
					window.DC_CHAT.sendMessage(text);
					inputEl.value = '';
				}
			} else if (e.key === 'Escape' || e.key === 'Tab') {
				// Esc or Tab: blur input and return focus to canvas
				e.preventDefault();
				inputEl.blur();
				const canvas = document.querySelector('canvas');
				if (canvas) canvas.focus();
			}
		});

		// ---- Send on button click --------------------------------------------
		sendBtn.addEventListener('click', () => {
			const text = inputEl.value;
			if (text.trim()) {
				window.DC_CHAT.sendMessage(text);
				inputEl.value = '';
			}
		});

		return { frame, styleEl, messagesEl, inputEl, inputArea };
	}

	/* -------------------------- Message rendering -------------------------- */

	/**
	 * Determine the CSS class for a message based on its level or sender.
	 *
	 * @param {{ level?: string, from?: string, from_name?: string }} msg
	 * @returns {string} CSS class suffix (e.g. 'system', 'level-warn')
	 */
	function _msgClass(msg) {
		if (!msg) return '';
		const from = (msg.from || '').toLowerCase();
		const name = (msg.from_name || '').toLowerCase();
		if (from === 'system' || name === 'system' || from === 'server') return 'system';
		const level = (msg.level || 'chat').toLowerCase();
		if (level === 'info') return 'level-info';
		if (level === 'warn' || level === 'warning') return 'level-warn';
		if (level === 'error') return 'level-error';
		return '';
	}

	/**
	 * Render a single message object into the messagesEl container.
	 * Appends to the DOM, trims buffer to MAX_MESSAGES, and auto-scrolls.
	 *
	 * @param {HTMLElement} messagesEl  — .dc-chat-messages container
	 * @param {{ from_name?: string, body: string, ts?: number, level?: string, from?: string }} msg
	 * @param {string} msgClass  — CSS class suffix from _msgClass()
	 */
	function _renderMessage(messagesEl, msg, msgClass, frame) {
		// Reset idle timer on new message
		if (_idleState.resetFn) _idleState.resetFn(frame);

		const el = document.createElement('div');
		el.className = 'dc-chat-msg' + (msgClass ? ' dc-chat-msg-' + msgClass : '');

		// Mark as recent (visible when idle)
		el.classList.add('dc-chat-msg-recent');
		// Remove 'recent' class after 60 seconds so it fades when idle
		setTimeout(() => {
			el.classList.remove('dc-chat-msg-recent');
		}, 60000);

		if (msg.from_name && msgClass !== 'system' && !['level-info', 'level-warn', 'level-error'].includes(msgClass)) {
			const fromSpan = document.createElement('span');
			fromSpan.className = 'dc-chat-msg-from';
			fromSpan.textContent = msg.from_name + ': ';
			el.appendChild(fromSpan);
		}

		const bodySpan = document.createElement('span');
		bodySpan.className = 'dc-chat-msg-body';
		bodySpan.textContent = msg.body || '';
		el.appendChild(bodySpan);

		messagesEl.appendChild(el);
		// Scroll to bottom after render
		requestAnimationFrame(() => {
			messagesEl.scrollTop = messagesEl.scrollHeight;
		});

		// Maintain rolling buffer
		_messageBuffer.push(el);
		if (_messageBuffer.length > MAX_MESSAGES) {
			const old = _messageBuffer.shift();
			old.remove();
		}
	}

	/* -------------------------- WebSocket integration -------------------------- */

	/**
	 * Tear down the hub connection when chat is switched off.
	 *
	 * dc-ws.js exposes destroy(), not close() — destroy() sets closedByUs (disarming the
	 * reconnect loop), clears the keepalive interval, flushes any batched presence and
	 * closes the socket. Guarded because the hub is optional: DC_WS is null when dc-ws.js
	 * never loaded or the connection was never established.
	 */
	function _teardownWs() {
		if (window.DC_WS && typeof window.DC_WS.destroy === 'function') {
			window.DC_WS.destroy();
			return true;
		}
		return false;
	}

	/**
	 * Bring a destroyed DC_WS instance back up when chat is switched on again.
	 *
	 * destroy() only flips closedByUs and closes the socket — the instance itself stays
	 * usable, so clearing closedByUs (plus reconnectAttempts, which destroy() leaves at
	 * whatever the last failed run reached) and calling _connect() revives it.
	 *
	 * The one sharp edge is that ws.close() is asynchronous: if the user toggles OFF then
	 * ON while the old socket is still CLOSING, clearing closedByUs early makes dc-ws's own
	 * onclose handler schedule a *second* _connect(), leaving two sockets racing over the
	 * single this.ws slot. So while a close is in flight we keep closedByUs set and defer
	 * the revive to that socket's close event.
	 */
	function _reviveWs() {
		const client = window.DC_WS;
		if (!client) return false;
		// If dc-ws ever grows a first-class revive/reconnect entry point, prefer it.
		if (typeof client.revive === 'function') {
			client.revive();
			return true;
		}
		if (typeof client._connect !== 'function') return false;
		const reconnect = () => {
			client.closedByUs = false;
			client.reconnectAttempts = 0;
			client._connect();
		};
		if (typeof client.connected === 'function' && client.connected()) {
			// Socket never actually went away — just re-arm the reconnect loop.
			client.closedByUs = false;
			return true;
		}
		const sock = client.ws;
		// 2 === WebSocket.CLOSING
		if (sock && sock.readyState === 2 && typeof sock.addEventListener === 'function') {
			let done = false;
			const go = () => {
				if (done) return;
				done = true;
				reconnect();
			};
			sock.addEventListener('close', go, { once: true });
			// Fallback in case the close event never lands (server not answering the
			// close frame). setTimeout is fine here — worst case we connect a bit early.
			setTimeout(go, 2000);
			return true;
		}
		reconnect();
		return true;
	}

	/**
	 * Wire up document listeners for dc:auth-success and dc:v1-event.
	 * Returns a cleanup function.
	 *
	 * @param {{ sendMessage: (text: string) => void }} api
	 * @returns {() => void} cleanup
	 */
	function _wireWebSocket(api) {
		/** @param {MessageEvent} e */
		const onAuthSuccess = (e) => {
			console.log('[dc-chat] Auth success, joining ' + CHANNEL_NOC);
			if (window.DC_WS && typeof window.DC_WS.send === 'function') {
				window.DC_WS.send('channel.join', { channel: CHANNEL_NOC });
			}
		};

		/** @param {MessageEvent} e */
		const onV1Event = (e) => {
			const { op, data } = e.detail || {};
			// Debug: log all incoming ops to see what's coming back
			if (op && (op.startsWith('channel.') || op.startsWith('chat.') || op === 'dc.presence.join')) {
				console.log('[dc-chat] incoming event:', { op, data });
			}
			if (!op || !data) return;

			// channel.message — broadcast from the server to all clients in the channel
			if (op === 'channel.message') {
				console.log('[dc-chat] channel.message received:', data);
				api.addMessage({
					from_name: data.from_name || data.from || 'server',
					body: data.body || '',
					level: data.level || 'chat',
					ts: data.ts
				});
				return;
			}

			// chat.message — alternative incoming format
			if (op === 'chat.message') {
				console.log('[dc-chat] chat.message received:', data);
				api.addMessage({
					from_name: data.from_name || data.from || 'server',
					body: data.body || '',
					level: data.level || 'chat',
					ts: data.ts
				});
			}
		};

		document.addEventListener('dc:auth-success', onAuthSuccess);
		document.addEventListener('dc:v1-event', onV1Event);

		return () => {
			document.removeEventListener('dc:auth-success', onAuthSuccess);
			document.removeEventListener('dc:v1-event', onV1Event);
		};
	}

	/* -------------------------- Public API -------------------------- */

	/**
	 * @typedef {Object} ChatMessage
	 * @property {string} [from]
	 * @property {string} [from_name]
	 * @property {string} body
	 * @property {string} [level]
	 * @property {number} [ts]
	 */

	/**
	 * @typedef {Object} DC_CHAT_API
	 * @property {() => void} init
	 * @property {(text: string) => void} sendMessage
	 * @property {(msg: ChatMessage) => void} addMessage
	 * @property {() => void} clearMessages
	 * @property {() => void} destroy
	 * @property {() => boolean} focusInput
	 */

	/**
	 * Create and return the DC_CHAT public API.
	 *
	 * @returns {DC_CHAT_API}
	 */
	function createAPI() {
		/** @type {HTMLElement|null} */
		let frame = null;

		/** @type {HTMLElement|null} */
		let styleEl = null;

		/** @type {HTMLElement|null} */
		let messagesEl = null;

		/** @type {(() => void)|null} */
		let wsCleanup = null;

		/** @type {HTMLElement|null} */
		let inputEl = null;

		/** @type {HTMLElement|null} */
		let inputArea = null;

		/** @type {boolean} */
		let initialized = false;

		/** @type {boolean} */
		let _isHovered = false;

		/** @type {ReturnType<typeof setTimeout>|null} */
		let _idleTimer = null;

		const _IDLE_FADE_MS = 60000;

		/**
		 * Reset the idle timer. When timer fires, frame becomes faded.
		 * @param {HTMLElement} frame
		 */
		function _resetIdleTimer(frame) {
			if (_idleTimer) clearTimeout(_idleTimer);
			frame.classList.remove('dc-chat-idle');
			if (!_isHovered) {
				_idleTimer = setTimeout(() => {
					frame.classList.add('dc-chat-idle');
				}, _IDLE_FADE_MS);
			}
		}

		_idleState.resetFn = _resetIdleTimer;

		return {
			/**
			 * Initialize the chat frame UI and WebSocket listeners.
			 * Safe to call multiple times (idempotent).
			 */
			init() {
				if (initialized) return;
				initialized = true;

				const { frame: f, styleEl: s, messagesEl: msgEl, inputEl: iEl, inputArea: ia } = _buildChatFrame();
				frame = f;
				styleEl = s;
				messagesEl = msgEl;
				inputEl = iEl;
				inputArea = ia;

				wsCleanup = _wireWebSocket(this);

				// The channel.join normally rides on dc:auth-success, but that event may already
				// have fired — the hub connects independently of the chat toggle, so switching
				// chat ON later (or booting with it off) would otherwise leave us unsubscribed
				// forever. joinGroup on the hub is idempotent, so a redundant join is harmless.
				if (window.DC_AUTHED === true && window.DC_WS && typeof window.DC_WS.send === 'function') {
					console.log('[dc-chat] Already authenticated, joining ' + CHANNEL_NOC);
					window.DC_WS.send('channel.join', { channel: CHANNEL_NOC });
				}

				// Wire up hover listeners for idle timer
				frame.addEventListener('mouseenter', () => {
					_isHovered = true;
					if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
					frame.classList.remove('dc-chat-idle');
					inputArea.classList.add('visible');
				});
				frame.addEventListener('mouseleave', () => {
					_isHovered = false;
					inputArea.classList.remove('visible');
					_resetIdleTimer(frame);
				});

				// Wire up focus listener for input (treat focus like hover)
				inputEl.addEventListener('focusin', () => {
					_isHovered = true;
					if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
					frame.classList.remove('dc-chat-idle');
					inputArea.classList.add('visible');
				});

				inputEl.addEventListener('focusout', () => {
					_isHovered = false;
					inputArea.classList.remove('visible');
					_resetIdleTimer(frame);
				});

				// NOTE: the #dcWsToggle button lives in the page markup (dc.html / dc.php), not
				// inside the frame we just built, so it is wired ONCE from _boot() — wiring it
				// here would stack a second click handler on every OFF→ON cycle, and the extra
				// handler immediately undoes the toggle it is reacting to.

				// Start the idle timer initially
				_resetIdleTimer(frame);

				console.log('[dc-chat] Initialized');
			},

			/**
			 * Send a text message to the chat:noc channel via
			 * channel.publish over the DC_WS connection.
			 *
			 * @param {string} text
			 */
			sendMessage(text) {
				if (!initialized) {
					console.warn('[dc-chat] Not initialized');
					return;
				}

				const trimmed = (text || '').trim();
				if (!trimmed) return;

				// Dispatch via DC_WS only - server will echo back to us
				if (window.DC_WS && typeof window.DC_WS.send === 'function') {
					window.DC_WS.send('channel.publish', {
						channel: CHANNEL_NOC,
						body: trimmed,
						level: 'chat'
					});
				} else {
					console.warn('[dc-chat] DC_WS not available');
				}
			},

			/**
			 * Add a message to the visible chat log.
			 *
			 * @param {ChatMessage} msg
			 */
			addMessage(msg) {
				if (!initialized || !messagesEl || !msg) return;
				const msgClass = _msgClass(msg);
				_renderMessage(messagesEl, msg, msgClass, frame);
			},

			/**
			 * Clear all messages from the visible log and the in-memory buffer.
			 */
			clearMessages() {
				if (!messagesEl) return;
				messagesEl.innerHTML = '';
				_messageBuffer.length = 0;
			},

			/**
			 * Tear down the chat module and release all resources.
			 * Removes the frame and injected <style> element from the DOM,
			 * calls the WebSocket cleanup function, and resets state.
			 */
			destroy() {
				if (frame) {
					frame.remove();
					frame = null;
				}
				if (styleEl) {
					styleEl.remove();
					styleEl = null;
				}
				if (wsCleanup) {
					wsCleanup();
					wsCleanup = null;
				}
				if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
				// _messageBuffer is module-level and outlives this instance, so a
				// destroy()/init() cycle (the Chat: OFF → ON toggle) otherwise leaves it
				// holding up to MAX_MESSAGES elements from the frame we just removed —
				// detached nodes kept alive for the rest of the page's life.
				_messageBuffer.length = 0;
				inputEl = null;
				inputArea = null;
				initialized = false;
			},

			/**
			 * Focus the chat input element.
			 * @returns {boolean} true if input was focused, false if not available
			 */
			focusInput() {
				if (inputEl) {
					inputEl.focus();
					return true;
				}
				return false;
			}
		};
	}

	/* -------------------------- Bootstrap -------------------------- */

	/** Guard so the #dcWsToggle click handler is only ever bound once. */
	let _toggleWired = false;

	/**
	 * Wire the page's #dcWsToggle button (markup lives in dc.html / dc.php) and sync its
	 * label with the current wsEnabled state. Bound once per page load: the button outlives
	 * DC_CHAT.destroy(), so re-binding on each init() would stack handlers.
	 */
	function _wireToggleButton() {
		const toggleBtn = document.getElementById('dcWsToggle');
		if (!toggleBtn) return null;
		const paint = () => {
			toggleBtn.textContent = wsEnabled ? 'Chat: ON' : 'Chat: OFF';
			if (toggleBtn.classList) {
				if (wsEnabled) {
					toggleBtn.classList.remove('off');
				} else {
					toggleBtn.classList.add('off');
				}
			}
		};
		paint();
		if (_toggleWired) return toggleBtn;
		_toggleWired = true;
		toggleBtn.addEventListener('click', () => {
			wsEnabled = !wsEnabled;
			// best-effort persistence; storage may be blocked (see _storageSet)
			_storageSet(WS_ENABLED_KEY, String(wsEnabled));
			if (!wsEnabled) {
				// Turn OFF: tear down the chat frame and close the hub socket
				if (_instance) _instance.destroy();
				_teardownWs();
			} else {
				// Turn ON: rebuild the UI and revive the hub connection
				if (_instance) _instance.init();
				_reviveWs();
			}
			paint();
		});
		return toggleBtn;
	}

	/**
	 * Boot the module once the DOM is ready.
	 *
	 * Must never throw: whatever goes wrong here (blocked storage, a missing DOM node,
	 * no hub at all) window.DC_CHAT still has to exist, and the 3D scene must keep
	 * working without chat/multiplayer.
	 */
	function _boot() {
		// Restore wsEnabled preference from storage (default true when unavailable)
		const stored = _storageGet(WS_ENABLED_KEY);
		if (stored !== null) {
			wsEnabled = stored === 'true';
		}

		_instance = createAPI();
		window.DC_CHAT = _instance;

		// Bind the toggle button (also paints the OFF label when chat is disabled)
		try {
			_wireToggleButton();
		} catch (e) {
			console.warn('[dc-chat] toggle button unavailable:', e && e.message);
		}

		// Initialize only if WebSocket is enabled. A failure here must not escape _boot:
		// window.DC_CHAT is already published, and the 3D scene has to keep running.
		if (wsEnabled) {
			try {
				_instance.init();
			} catch (e) {
				console.warn('[dc-chat] init failed, chat disabled:', e && e.message);
			}
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', _boot);
	} else {
		_boot();
	}

}());
