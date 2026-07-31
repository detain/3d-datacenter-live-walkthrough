/**
 * tests/js/helpers/mutate.mjs — mutation-test driver for the dc-* specs.
 *
 * Proves the new tests are not vacuous. For each mutation below it copies
 * public_html/js/dc-ws.js and dc-presence.js into a scratch dir, applies ONE
 * deliberate break to the copy, and runs the named spec files against the copies
 * via the DC_MUTATE_WS / DC_MUTATE_PRESENCE env hooks in dc-stack.js.
 *
 * The real sources are never written to — public_html/ is owned by another agent.
 *
 *   node tests/js/helpers/mutate.mjs            # run every mutation
 *   node tests/js/helpers/mutate.mjs count-self # run one by id substring
 *
 * A mutation PASSES verification when at least one of its `expect` specs fails.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const WS = path.join(ROOT, 'public_html/js/dc-ws.js');
const PRESENCE = path.join(ROOT, 'public_html/js/dc-presence.js');

const SPECS = {
  offline: 'tests/js/dc-offline.test.js',
  count: 'tests/js/dc-presence-count.test.js',
  bot: 'tests/js/dc-bot.test.js',
  bounds: 'tests/js/dc-bounds.test.js',
  reconnect: 'tests/js/dc-reconnect.test.js',
};

/** @type {{id:string, file:'ws'|'presence', find:string, replace:string, specs:string[]}[]} */
const MUTATIONS = [
  {
    id: 'count-self-dropped',
    file: 'presence',
    find: 'const count = state.remote.size + (hasLocalUid() ? 1 : 0)',
    replace: 'const count = state.remote.size',
    specs: ['count'],
  },
  {
    id: 'self-join-echo-not-filtered',
    file: 'presence',
    find: 'if (state.clientId !== null && key === idKey(state.clientId)) return',
    replace: 'if (false) return',
    specs: ['count'],
  },
  {
    id: 'remote-map-not-cleared-on-disconnect',
    file: 'presence',
    find: '    state.remote.clear()\n    state.uid = null',
    replace: '    state.uid = null',
    specs: ['count', 'offline'],
  },
  {
    id: 'idkey-rejects-non-hex-ids (bot filtered out)',
    file: 'presence',
    find: "    if (v === null || v === undefined || v === '') return null\n    return String(v)",
    replace: "    if (v === null || v === undefined || v === '') return null\n    if (!/^[0-9a-f]{20}$/.test(String(v))) return null\n    return String(v)",
    specs: ['bot'],
  },
  {
    id: 'bot-explicitly-special-cased-away',
    file: 'presence',
    find: '  function onJoined (data) {\n    dbg(',
    replace: "  function onJoined (data) {\n    if (String(data.clientId || '').indexOf('bot_') === 0) return\n    dbg(",
    specs: ['bot'],
  },
  {
    id: 'bounds-never-attached-to-move (the original bug)',
    file: 'presence',
    find: "    const bounds = pendingBounds()\n    if (bounds) {\n      data.bounds = bounds\n      reportedBounds = bounds\n    }\n    send('dc.presence.move', data)",
    replace: "    send('dc.presence.move', data)",
    specs: ['bounds'],
  },
  {
    id: 'bounds-latched-by-boolean-instead-of-value (location switch never re-reported)',
    file: 'presence',
    find: '    if (reportedBounds &&\n        reportedBounds.minX === b.minX && reportedBounds.maxX === b.maxX &&\n        reportedBounds.minZ === b.minZ && reportedBounds.maxZ === b.maxZ) return null',
    replace: '    if (reportedBounds) return null',
    specs: ['bounds'],
  },
  {
    id: 'bounds-compared-by-identity-instead-of-value (same room re-reported forever)',
    file: 'presence',
    find: '    if (reportedBounds &&\n        reportedBounds.minX === b.minX && reportedBounds.maxX === b.maxX &&\n        reportedBounds.minZ === b.minZ && reportedBounds.maxZ === b.maxZ) return null',
    replace: '    if (reportedBounds === b) return null',
    specs: ['bounds'],
  },
  {
    id: 'respawn-listener-removed (AFK never reports bounds)',
    file: 'presence',
    find: "    document.addEventListener('dc:respawn', function () { onRespawn() })",
    replace: '    /* listener removed by mutation */',
    specs: ['bounds'],
  },
  {
    id: 'selfBounds-degeneracy-check-removed',
    file: 'presence',
    find: '    if (b.maxX <= b.minX || b.maxZ <= b.minZ) return null\n',
    replace: '',
    specs: ['bounds'],
  },
  {
    id: 'selfBounds-finiteness-check-removed',
    file: 'presence',
    find: '    if (!isNum(b.minX) || !isNum(b.maxX) || !isNum(b.minZ) || !isNum(b.maxZ)) return null\n',
    replace: '',
    specs: ['bounds'],
  },
  {
    id: 'presence-disabled-killswitch-removed',
    file: 'presence',
    find: "    if (window.DC_PRESENCE_ENABLED === false) {\n      dbg('presence disabled — suppressed', op)\n      return\n    }",
    replace: '    /* kill switch removed by mutation */',
    specs: ['offline'],
  },
  {
    id: 'ws-status-badge-reflection-removed',
    file: 'presence',
    find: '    if (!status || !Object.prototype.hasOwnProperty.call(STATUS_UI, status)) return\n    wsStatus = status',
    replace: '    if (!status || !Object.prototype.hasOwnProperty.call(STATUS_UI, status)) return\n    wsStatus = wsStatus',
    specs: ['offline', 'count'],
  },
  {
    id: 'hello-id-correlation-broken',
    file: 'ws',
    find: 'if (this._helloId && envelope.re === this._helloId && envelope.ok === true) {',
    replace: 'if (false) {',
    specs: ['offline', 'count', 'bot', 'bounds'],
  },
  {
    id: 'hello-id-not-cleared-on-close (late reply authenticates)',
    file: 'ws',
    find: '\t\t\t\tself._helloId = null;\n\t\t\t\tself._pingOutstandingSince = null;',
    replace: '\t\t\t\tself._pingOutstandingSince = null;',
    specs: ['offline'],
  },
  {
    id: 'graceful-degradation-removed (constructor throw)',
    file: 'ws',
    find: "\t\t\t\tconsole.log('[dc-ws] Connection failed - multiplayer disabled');\n\t\t\t\twindow.DC_PRESENCE_ENABLED = false;\n\t\t\t\tthis._setStatus('error');",
    replace: "\t\t\t\tconsole.log('[dc-ws] Connection failed - multiplayer disabled');\n\t\t\t\tthis._setStatus('error');",
    specs: ['offline'],
  },
  {
    id: 'keepalive-ping-not-gated-on-auth',
    file: 'ws',
    find: 'if (self.ws && self.ws.readyState === WebSocket.OPEN && self.authed) {',
    replace: 'if (self.ws && self.ws.readyState === WebSocket.OPEN) {',
    specs: ['offline'],
  },
  {
    // Both the onopen re-arm and the onclose teardown are individually sufficient,
    // so a leak only appears when the module stops tracking the handle at all.
    id: 'keepalive-interval-handle-never-tracked (leaks per reconnect)',
    file: 'ws',
    find: '\t\t\t\tif (self._keepaliveTimer) clearInterval(self._keepaliveTimer);\n\t\t\t\tself._keepaliveTimer = setInterval(function () {',
    replace: '\t\t\t\tsetInterval(function () {',
    specs: ['offline'],
  },
  {
    id: 'presence-send-not-gated-on-socket-state',
    file: 'ws',
    find: 'if (window.DC_WS && window.DC_WS.connected()) {',
    replace: 'if (window.DC_WS) {',
    specs: ['offline'],
  },
  {
    // The exact live bug: refill the reconnect budget on `onopen` (which succeeds
    // even when auth will be refused) instead of on successful auth.
    id: 'backoff-reset-moved-back-into-onopen (the 3s storm)',
    file: 'ws',
    find: 'this.ws.onopen = function () {\n',
    replace: 'this.ws.onopen = function () {\n\t\t\t\tself.reconnectAttempts = 0;\n\t\t\t\tself.reconnectDelay = 3000;\n',
    specs: ['reconnect'],
  },
  {
    id: 'terminal-auth-codes-emptied (bad_session retried forever)',
    file: 'ws',
    find: "\tconst TERMINAL_AUTH_CODES = ['bad_session', 'unsupported_credential', 'ip_not_allowed'];",
    replace: '\tconst TERMINAL_AUTH_CODES = [];',
    specs: ['reconnect'],
  },
  {
    id: 'terminal-latch-ignored-in-onclose (still re-arms)',
    file: 'ws',
    find: '\t\t\t\tif (!self.closedByUs && self._authTerminal) {',
    replace: '\t\t\t\tif (false) {',
    specs: ['reconnect'],
  },
  {
    id: 'auth-success-no-longer-refills-the-budget (hub restart cannot recover)',
    file: 'ws',
    find: '\t\t\tthis.reconnectAttempts = 0;\n\t\t\tthis.reconnectDelay = 3000;\n\t\t\tthis._authTerminal = false;',
    replace: '\t\t\tthis._authTerminal = false;',
    specs: ['reconnect'],
  },
  {
    id: 'pong-handler-keyed-on-reply-shape-instead-of-op (keepalive disconnect loop)',
    file: 'ws',
    find: "\t\t\tif (op === 'pong') {",
    replace: "\t\t\tif (envelope.re && envelope.ok === true) {",
    specs: ['reconnect'],
  },
  {
    id: 'watchdog-never-cleared-by-pong',
    file: 'ws',
    find: '\t\t\t\tthis._pingOutstandingSince = null;\n\t\t\t\tif (this._lastPingTs) {',
    replace: '\t\t\t\tif (this._lastPingTs) {',
    specs: ['reconnect'],
  },
  {
    id: 'move-payload-regains-facing-and-clientId',
    file: 'presence',
    find: "    const data = { x, z, yaw }\n",
    replace: "    const data = { x, z, facing: yaw, clientId: state.clientId }\n",
    specs: ['bounds'],
  },
];

const only = process.argv[2];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-mutate-'));
const wsSrc = fs.readFileSync(WS, 'utf8');
const presenceSrc = fs.readFileSync(PRESENCE, 'utf8');

let killed = 0;
let survived = 0;
let unapplied = 0;

for (const m of MUTATIONS) {
  if (only && !m.id.includes(only)) continue;

  const base = m.file === 'ws' ? wsSrc : presenceSrc;
  const occurrences = base.split(m.find).length - 1;
  if (occurrences !== 1) {
    console.log(`SKIP  ${m.id}\n      pattern matched ${occurrences} times (need exactly 1) — anchor is stale`);
    unapplied++;
    continue;
  }

  const wsOut = path.join(scratch, 'dc-ws.js');
  const prOut = path.join(scratch, 'dc-presence.js');
  fs.writeFileSync(wsOut, m.file === 'ws' ? base.replace(m.find, m.replace) : wsSrc);
  fs.writeFileSync(prOut, m.file === 'presence' ? base.replace(m.find, m.replace) : presenceSrc);

  const files = m.specs.map((s) => SPECS[s]);
  let out = '';
  let failed = false;
  try {
    out = execFileSync('npx', ['vitest', 'run', ...files], {
      cwd: ROOT,
      env: { ...process.env, DC_MUTATE_WS: wsOut, DC_MUTATE_PRESENCE: prOut },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }

  const summary = (out.match(/Tests\s+.*$/m) || ['(no summary)'])[0].trim();
  const names = [...out.matchAll(/^\s+×\s+(.+?)\s+\d+ms/gm)].map((x) => x[1]);
  if (failed) {
    killed++;
    console.log(`KILLED  ${m.id}\n        ${summary}`);
    names.slice(0, 6).forEach((n) => console.log(`          × ${n}`));
    if (names.length > 6) console.log(`          … and ${names.length - 6} more`);
  } else {
    survived++;
    console.log(`SURVIVED (BAD)  ${m.id}\n        ${summary}`);
  }
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`\nkilled=${killed} survived=${survived} skipped=${unapplied}`);
process.exit(survived > 0 || unapplied > 0 ? 1 : 0);
