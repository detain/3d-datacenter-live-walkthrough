/**
 * tests/js/dc-info-panel.test.js — showInfo() expanded fields and CSS
 *
 * Tests that showInfo() in dc.js correctly displays:
 * - Status with colored dot (green=active, red=off, yellow=warning)
 * - IPv4 address
 * - MAC address
 * - Hardware: make/model
 * - Position: U-start to U-end
 * - Links: asset link, order link
 * - Close button
 * - All values passed through escapeHtml()
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');
const CSS_PATH = path.resolve(__dirname, '../../public_html/css/dc-shared.css');
const CSS_SOURCE = fs.readFileSync(CSS_PATH, 'utf8');

function extractFn(name) {
    const m = DC_SOURCE.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// showInfo source analysis — verify escapeHtml is used on all displayed values
// ---------------------------------------------------------------------------
describe('dc.js — showInfo escapeHtml coverage', () => {

    it('showInfo is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function showInfo\(/m);
    });

    it('escapeHtml is called for hostname', () => {
        const src = extractFn('showInfo');
        // hostname is displayed via dc-info-title
        expect(src).toMatch(/escapeHtml\(a\.hostname/);
    });

    it('escapeHtml is called for status', () => {
        const src = extractFn('showInfo');
        // status is displayed as a title attribute on the dot span
        expect(src).toMatch(/escapeHtml\(a\.status/);
    });

    it('escapeHtml is called for primary_ipv4', () => {
        const src = extractFn('showInfo');
        // IPv4 field shows a.primary_ipv4
        expect(src).toMatch(/escapeHtml\(a\.primary_ipv4/);
    });

    it('escapeHtml is called for MAC address', () => {
        const src = extractFn('showInfo');
        // MAC field shows a.mac
        expect(src).toMatch(/escapeHtml\(a\.mac/);
    });

    it('escapeHtml is called for make and model (hardware)', () => {
        const src = extractFn('showInfo');
        // make and model are joined into hw variable, then hw is escaped
        expect(src).toMatch(/const hw = \[a\.make, a\.model\]\.filter/);
        expect(src).toMatch(/escapeHtml\(hw\)/);
    });

    it('escapeHtml is called for position (uStart)', () => {
        const src = extractFn('showInfo');
        // position string is escaped
        expect(src).toMatch(/escapeHtml\(position\)/);
    });

    it('escapeHtml is called for asset id in link', () => {
        const src = extractFn('showInfo');
        // asset link uses escapeHtml on id
        expect(src).toMatch(/escapeHtml\(String\(a\.id\)\)/);
    });

    it('escapeHtml is called for order id in link', () => {
        const src = extractFn('showInfo');
        // order link uses escapeHtml on order_id
        expect(src).toMatch(/escapeHtml\(String\(a\.order_id\)\)/);
    });

    it('the close button is rendered and wired with a listener', () => {
        // R2.6: the close button carried an inline onclick that re-looked-up #dcInfo by id and
        // set display:none. It happened to work — unlike the Copy Link button beside it, which
        // called a module-scope function from global scope and threw — but it is the same
        // pattern, so it moved to _wireInfoPanel() with the others rather than being left as the
        // one inline handler in the file.
        const src = extractFn('showInfo');
        expect(src).toMatch(/dc-info-close/);
        expect(src).not.toMatch(/onclick=/);
        const wire = extractFn('_wireInfoPanel');
        expect(wire).toMatch(/\.dc-info-close/);
        expect(wire).toMatch(/panel\.style\.display\s*=\s*'none'/);
    });
});

// ---------------------------------------------------------------------------
// Status dot CSS classes exist
// ---------------------------------------------------------------------------
describe('dc-info-panel — status dot CSS', () => {

    it('.dc-status-dot class exists', () => {
        expect(CSS_SOURCE).toMatch(/\.dc-status-dot\s*\{/);
    });

    it('.status-active (green) class exists', () => {
        expect(CSS_SOURCE).toMatch(/\.dc-status-dot\.status-active\s*\{/);
        // Verify green color
        const match = CSS_SOURCE.match(/\.dc-status-dot\.status-active\s*\{[^}]*background:\s*([^;} ]+)/);
        expect(match).toBeTruthy();
    });

    it('.status-off (red) class exists', () => {
        expect(CSS_SOURCE).toMatch(/\.dc-status-dot\.status-off\s*\{/);
        // Verify red color
        const match = CSS_SOURCE.match(/\.dc-status-dot\.status-off\s*\{[^}]*background:\s*([^;} ]+)/);
        expect(match).toBeTruthy();
    });

    it('.status-warning (yellow) class exists', () => {
        expect(CSS_SOURCE).toMatch(/\.dc-status-dot\.status-warning\s*\{/);
        // Verify yellow color
        const match = CSS_SOURCE.match(/\.dc-status-dot\.status-warning\s*\{[^}]*background:\s*([^;} ]+)/);
        expect(match).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// showInfo expanded fields presence in source
// ---------------------------------------------------------------------------
describe('dc.js — showInfo expanded fields', () => {

    it('shows primary_ipv4 field', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/primary_ipv4/);
        expect(src).toMatch(/IPv4:/);
    });

    it('shows MAC field', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/a\.mac/);
        expect(src).toMatch(/MAC:/);
    });

    it('shows hardware make/model', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/a\.make/);
        expect(src).toMatch(/a\.model/);
        expect(src).toMatch(/Hardware:/);
    });

    it('shows position as U-start to U-end', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/U.*to.*U/);
        expect(src).toMatch(/Position:/);
    });

    it('shows order link when order_id is present', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/order_id/);
        expect(src).toMatch(/order_form/);
    });

    it('close button is rendered', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/dc-info-close/);
    });
});

// ---------------------------------------------------------------------------
// escapeHtml function still works correctly
// ---------------------------------------------------------------------------
describe('dc.js — escapeHtml still functional', () => {

    function extractEscapeHtml() {
        const m = DC_SOURCE.match(/^function escapeHtml\([\s\S]*?^^\}/m);
        if (!m) throw new Error('escapeHtml not found');
        return m[0];
    }

    function makeEscapeHtml() {
        const src = extractEscapeHtml();
        return new Function('s', src + '\nreturn escapeHtml;')();
    }

    it('escapes HTML special characters', () => {
        const escapeHtml = makeEscapeHtml();
        expect(escapeHtml('a & b <c> "d" \'e\'')).toBe('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;');
    });

    it('leaves plain text unchanged', () => {
        const escapeHtml = makeEscapeHtml();
        expect(escapeHtml('hello world')).toBe('hello world');
    });

    it('returns String representation of any input', () => {
        const escapeHtml = makeEscapeHtml();
        expect(escapeHtml(123)).toBe('123');
        expect(escapeHtml(null)).toBe('null');
        expect(escapeHtml(undefined)).toBe('undefined');
    });
});
