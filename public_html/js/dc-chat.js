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
		messagesEl.scrollTop = messagesEl.scrollHeight;

		// Maintain rolling buffer
		_messageBuffer.push(el);
		if (_messageBuffer.length > MAX_MESSAGES) {
			const old = _messageBuffer.shift();
			old.remove();
		}
	}

	/* -------------------------- WebSocket integration -------------------------- */

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
			if (!op || !data) return;

			// channel.message — broadcast from the server to all clients in the channel
			if (op === 'channel.message') {
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
				});

				inputEl.addEventListener('focusout', () => {
					_isHovered = false;
					_resetIdleTimer(frame);
				});

				// Wire up WebSocket toggle button
				const toggleBtn = document.getElementById('dcWsToggle');
				if (toggleBtn) {
					toggleBtn.addEventListener('click', () => {
						wsEnabled = !wsEnabled;
						localStorage.setItem(WS_ENABLED_KEY, String(wsEnabled));
						if (!wsEnabled) {
							// Turn OFF: destroy chat frame and close WebSocket
							this.destroy();
							if (window.DC_WS && typeof window.DC_WS.close === 'function') {
								window.DC_WS.close();
							}
							toggleBtn.textContent = 'Chat: OFF';
							toggleBtn.classList.add('off');
						} else {
							// Turn ON: reinitialize
							this.init();
							if (window.DC_WS) {
								window.DC_WS.closedByUs = false;
								window.DC_WS._connect();
							}
							toggleBtn.textContent = 'Chat: ON';
							toggleBtn.classList.remove('off');
						}
					});
				}

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

				// Dispatch via DC_WS
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

	/**
	 * Boot the module once the DOM is ready.
	 */
	function _boot() {
		// Restore wsEnabled preference from localStorage (default true)
		const stored = localStorage.getItem(WS_ENABLED_KEY);
		if (stored !== null) {
			wsEnabled = stored === 'true';
		}

		_instance = createAPI();
		window.DC_CHAT = _instance;

		// Initialize only if WebSocket is enabled
		if (wsEnabled) {
			_instance.init();
		} else {
			// Mark toggle button as OFF state if ws is disabled
			const toggleBtn = document.getElementById('dcWsToggle');
			if (toggleBtn) {
				toggleBtn.textContent = 'Chat: OFF';
				toggleBtn.classList.add('off');
			}
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', _boot);
	} else {
		_boot();
	}

}());
