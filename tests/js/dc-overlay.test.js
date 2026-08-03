/**
 * tests/js/dc-overlay.test.js — Step 9.7 free-U capacity overlay (rewritten by R3.11)
 *
 * WHAT WAS WRONG WITH THE OLD VERSION
 * All eighteen `it()` blocks were substring matches over dc.js, dc-shared.css and dc.html. Not one
 * of them called `computeFreeU()` or `applyOverlay()`.
 *
 * One of them was actively wrong in a way only execution could catch:
 *
 *     it('handles servers and switches in occupiedU calculation', () => {
 *         expect(fnSrc).toContain('rack.servers');
 *         expect(fnSrc).toContain('rack.switches');   // <-- still passes
 *     });
 *
 * R3.6 deliberately REMOVED the switches loop, because a switch is a row in `assets` and already
 * arrives inside `rack.servers`; the switchmanager query emits the same asset a second time under
 * `rack.switches`, so counting both charged every switch's U twice and the overlay showed racks as
 * fuller than they are. The test kept passing after the fix, because `rack.switches` still appears
 * — in the COMMENT explaining why the loop was removed. A substring match cannot tell code from
 * prose, and here it asserted the presence of a bug in a file that no longer had it.
 *
 * WHAT THIS VERSION DOES
 * Runs `computeFreeU()` and `applyOverlay()` against real inputs. The double-count case has its
 * own test, in the only form that can detect it: a rack holding one switch must report the same
 * free capacity whether or not `rack.switches` is populated.
 *
 * The CSS and HTML assertions are kept as text matching — they are markup contracts between three
 * files with nothing to execute — but they now check that the legend's colours agree with the
 * ramp the code computes, rather than that three hex strings exist somewhere in a stylesheet.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const DC_SOURCE = fs.readFileSync(path.join(REPO, 'public_html/js/dc.js'), 'utf8');
const CSS_SOURCE = fs.readFileSync(path.join(REPO, 'public_html/css/dc-shared.css'), 'utf8');
const HTML_SOURCE = fs.readFileSync(path.join(REPO, 'public_html/admin/dc.html'), 'utf8');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---------------------------------------------------------------------------
// Extraction — throws rather than returning empty, so a rename fails loudly.
// ---------------------------------------------------------------------------

function extractFn(name) {
    const m = DC_SOURCE.match(new RegExp('^function ' + name + '[\\s\\S]*?^}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}

function extractConst(name) {
    const m = DC_SOURCE.match(new RegExp('^const ' + name + ' = [\\s\\S]*?^};', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name} at top level — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------

/** Run the real computeFreeU() over an injected locations map. */
function runComputeFreeU(racks, locationId = 4) {
    const locations = { [locationId]: { racks } };
    const options = { location: locationId };
    // eslint-disable-next-line no-new-func
    return new Function('locations', 'options', `${extractFn('computeFreeU')}; return computeFreeU();`)(
        locations, options);
}

/** A minimal InstancedMesh stand-in that records what setColorAt() writes. */
function fakeRackMesh(assetData) {
    const colors = [];
    return {
        count: assetData.length,
        userData: { kind: 'rack', assetData },
        instanceMatrix: { needsUpdate: false },
        instanceColor: null,
        setColorAt(i, c) {
            // three.js allocates instanceColor white-filled on first use. Reproduce that, because
            // the bug this replaced was a hand-rolled zero-filled Float32Array rendering BLACK.
            if (!this.instanceColor) {
                this.instanceColor = { array: new Float32Array(this.count * 3).fill(1), needsUpdate: false };
            }
            colors[i] = { r: c.r, g: c.g, b: c.b };
        },
        colors,
    };
}

/** Run the real applyOverlay() over injected meshes and overlay data. */
function runApplyOverlay({ overlay = 'freeU', meshes = [], freeU = new Map(), legend = null } = {}) {
    const options = { overlay, location: 4 };
    const objects = { instanced: meshes };
    const classes = { visible: false };
    const legendEl = legend === null ? {
        classList: { toggle: (name, on) => { classes[name] = on; } },
    } : legend;
    const document = { getElementById: (id) => (id === 'dcOverlayLegend' ? legendEl : null) };
    const THREE = { Color: class { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } } };
    const OVERLAY_SOURCES = { none: null, freeU: () => freeU };
    const src = [extractFn('applyOverlay'), extractFn('_resetInstanceColors'),
        'return applyOverlay;'].join('\n');
    // eslint-disable-next-line no-new-func
    const fn = new Function('options', 'objects', 'document', 'THREE', 'OVERLAY_SOURCES', src)(
        options, objects, document, THREE, OVERLAY_SOURCES);
    fn();
    return { classes, meshes };
}

const rack = (u, servers = {}, switches = {}) => ({ u, servers, switches });
const srv = (size) => ({ size });

// ---------------------------------------------------------------------------
describe('computeFreeU() — executed', () => {

    it('returns a Map of rackId to a 0..1 ratio', () => {
        const m = runComputeFreeU({ 101: rack(42, { a: srv(1) }) });
        expect(m).toBeInstanceOf(Map);
        expect(m.get('101')).toBeCloseTo(41 / 42, 12);
    });

    it('an empty rack is 1 and a full rack is 0', () => {
        const full = {};
        for (let i = 0; i < 42; i++) full[`s${i}`] = srv(1);
        const m = runComputeFreeU({ 101: rack(42), 102: rack(42, full) });
        expect(m.get('101')).toBe(1);
        expect(m.get('102')).toBe(0);
    });

    it('sums server sizes rather than counting servers', () => {
        // A 4U server occupies four slots. Counting rows instead would report 41/42 here.
        const m = runComputeFreeU({ 101: rack(42, { a: srv(4) }) });
        expect(m.get('101')).toBeCloseTo(38 / 42, 12);
    });

    it('treats a server with no size as 1U', () => {
        const m = runComputeFreeU({ 101: rack(42, { a: {} }) });
        expect(m.get('101')).toBeCloseTo(41 / 42, 12);
    });

    it('never goes negative when a rack is over-filled', () => {
        // Real data does contain racks whose assets sum past their stated size.
        const m = runComputeFreeU({ 101: rack(2, { a: srv(10) }) });
        expect(m.get('101')).toBe(0);
    });

    it('defaults a rack with no stated size to 42U', () => {
        const m = runComputeFreeU({ 101: { servers: { a: srv(2) } } });
        expect(m.get('101')).toBeCloseTo(40 / 42, 12);
    });

    it('returns an empty Map when the location has no racks', () => {
        // eslint-disable-next-line no-new-func
        const empty = new Function('locations', 'options',
            `${extractFn('computeFreeU')}; return computeFreeU();`)({}, { location: 4 });
        expect(empty).toBeInstanceOf(Map);
        expect(empty.size).toBe(0);
    });

    it('THE DOUBLE-COUNT: a switch is not charged twice (R3.6)', () => {
        // This is the test the old file could not have. A switch is a row in `assets`, so it is
        // ALREADY in rack.servers; datacenter.php's switchmanager query then emits the same asset
        // again under rack.switches so the port topology has somewhere to live. Adding both
        // inflated occupiedU and understated free capacity.
        //
        // Same physical rack, expressed with and without the second copy — identical answers.
        const withoutSwitchCopy = runComputeFreeU({ 101: rack(42, { sw1: srv(1), a: srv(1) }) });
        const withSwitchCopy = runComputeFreeU({
            101: rack(42, { sw1: srv(1), a: srv(1) }, { sw1: { start: 20, size: 1 } }),
        });
        expect(withSwitchCopy.get('101')).toBe(withoutSwitchCopy.get('101'));
        expect(withSwitchCopy.get('101')).toBeCloseTo(40 / 42, 12);
    });

    it('a rack of nothing but switches still reads as nearly empty', () => {
        // The visible symptom: a switch-only rack showed as ~half full instead of ~empty.
        const switches = {};
        const servers = {};
        for (let i = 0; i < 4; i++) { servers[`sw${i}`] = srv(1); switches[`sw${i}`] = { start: i, size: 1 }; }
        const m = runComputeFreeU({ 101: rack(42, servers, switches) });
        expect(m.get('101')).toBeCloseTo(38 / 42, 12);
        expect(m.get('101')).toBeGreaterThan(0.9);
    });

    it('the switches loop is genuinely gone from the code, not just from the comment', () => {
        // Belt and braces for the specific regression: the old test passed on the word
        // "rack.switches" appearing in the comment that explains its removal.
        const code = stripComments(extractFn('computeFreeU'));
        expect(code).toContain('rack.servers');
        expect(code).not.toContain('rack.switches');
    });

});

// ---------------------------------------------------------------------------
describe('applyOverlay() — executed', () => {

    it('tints racks along a red → amber → green ramp', () => {
        const mesh = fakeRackMesh([{ id: '1' }, { id: '2' }, { id: '3' }]);
        runApplyOverlay({ meshes: [mesh], freeU: new Map([['1', 0], ['2', 0.5], ['3', 1]]) });
        expect(mesh.colors[0]).toEqual({ r: 1, g: 0, b: 0 });          // full → red
        expect(mesh.colors[1]).toEqual({ r: 1, g: 0.67, b: 0 });       // half → amber
        expect(mesh.colors[2]).toEqual({ r: 0, g: 1, b: 0 });          // empty → green
    });

    it('the ramp is monotonic — greener as a rack empties', () => {
        const data = [];
        for (let i = 0; i <= 10; i++) data.push({ id: String(i) });
        const freeU = new Map(data.map((d, i) => [d.id, i / 10]));
        const mesh = fakeRackMesh(data);
        runApplyOverlay({ meshes: [mesh], freeU });
        for (let i = 1; i < mesh.colors.length; i++) {
            expect(mesh.colors[i].g, `step ${i}`).toBeGreaterThanOrEqual(mesh.colors[i - 1].g);
            expect(mesh.colors[i].r, `step ${i}`).toBeLessThanOrEqual(mesh.colors[i - 1].r);
        }
    });

    it('blue stays at zero across the whole ramp', () => {
        const data = [{ id: '1' }, { id: '2' }, { id: '3' }];
        const mesh = fakeRackMesh(data);
        runApplyOverlay({ meshes: [mesh], freeU: new Map([['1', 0.2], ['2', 0.5], ['3', 0.8]]) });
        for (const c of mesh.colors) expect(c.b).toBe(0);
    });

    it('a rack with no data reads as amber, not as full', () => {
        // Unknown must not look like "no space left" — that is a capacity decision made on noise.
        const mesh = fakeRackMesh([{ id: 'unknown' }]);
        runApplyOverlay({ meshes: [mesh], freeU: new Map() });
        expect(mesh.colors[0]).toEqual({ r: 1, g: 0.67, b: 0 });
    });

    it('NEVER leaves an instance black', () => {
        // The bug: instanceColor was hand-allocated as a zero-filled Float32Array, so any
        // instance not written on a pass rendered BLACK rather than untinted. setColorAt()
        // allocates it white-filled, which is the correct neutral.
        const mesh = fakeRackMesh([{ id: '1' }, { id: '2' }]);
        runApplyOverlay({ meshes: [mesh], freeU: new Map([['1', 1]]) });
        expect(mesh.instanceColor).toBeTruthy();
        expect([...mesh.instanceColor.array].every((v) => v > 0)).toBe(true);
        for (const c of mesh.colors) expect(c.r + c.g + c.b).toBeGreaterThan(0);
    });

    it('resets every instance to white when the overlay is switched off', () => {
        const mesh = fakeRackMesh([{ id: '1' }, { id: '2' }]);
        runApplyOverlay({ meshes: [mesh], freeU: new Map([['1', 0], ['2', 1]]) });
        runApplyOverlay({ overlay: 'none', meshes: [mesh] });
        for (const c of mesh.colors) expect(c).toEqual({ r: 1, g: 1, b: 1 });
    });

    it('only touches rack meshes, not servers or cables', () => {
        const racks = fakeRackMesh([{ id: '1' }]);
        const servers = fakeRackMesh([{ id: '1' }]);
        servers.userData.kind = 'server';
        runApplyOverlay({ meshes: [racks, servers], freeU: new Map([['1', 0]]) });
        expect(racks.colors[0]).toBeTruthy();
        expect(servers.colors).toEqual([]);
    });

    it('flags instanceColor for upload, or the tint never reaches the GPU', () => {
        const mesh = fakeRackMesh([{ id: '1' }]);
        runApplyOverlay({ meshes: [mesh], freeU: new Map([['1', 0]]) });
        expect(mesh.instanceColor.needsUpdate).toBe(true);
    });

    it('shows the legend only when an overlay is on AND there is something to tint', () => {
        const mesh = fakeRackMesh([{ id: '1' }]);
        expect(runApplyOverlay({ meshes: [mesh], freeU: new Map([['1', 1]]) }).classes.visible).toBe(true);
        expect(runApplyOverlay({ overlay: 'none', meshes: [mesh] }).classes.visible).toBe(false);
        // Selecting an overlay before the room has built must not show a legend for nothing.
        expect(runApplyOverlay({ meshes: [] }).classes.visible).toBe(false);
    });

    it('survives a page with no legend element', () => {
        const mesh = fakeRackMesh([{ id: '1' }]);
        expect(() => runApplyOverlay({ meshes: [mesh], freeU: new Map([['1', 1]]), legend: undefined }))
            .not.toThrow();
    });

    it('degrades to no tint when the overlay source is unknown or returns a non-Map', () => {
        // A half-finished overlay must leave the scene alone rather than break it.
        const mesh = fakeRackMesh([{ id: '1' }]);
        expect(() => runApplyOverlay({ overlay: 'notARealOverlay', meshes: [mesh] })).not.toThrow();
        expect(mesh.colors).toEqual([]);

        const mesh2 = fakeRackMesh([{ id: '1' }]);
        expect(() => runApplyOverlay({ meshes: [mesh2], freeU: /** not a Map */ {} })).not.toThrow();
        expect(mesh2.colors).toEqual([]);
    });

});

// ---------------------------------------------------------------------------
describe('OVERLAY_SOURCES registry', () => {

    // A registry of names to functions. There is nothing to execute that would not amount to
    // reading the object, so this stays textual — deliberately, and it is three lines of source.

    it('maps none to null and freeU to computeFreeU', () => {
        const src = extractConst('OVERLAY_SOURCES');
        expect(src).toMatch(/none\s*:\s*null/);
        expect(src).toMatch(/freeU\s*:\s*computeFreeU/);
    });

    it('every key it declares is offered by the GUI dropdown, and vice versa', () => {
        // A source with no dropdown entry is unreachable; a dropdown entry with no source makes
        // applyOverlay() bail silently and the user sees a control that does nothing.
        const keys = (extractConst('OVERLAY_SOURCES').match(/^\s*(\w+)\s*:/gm) || [])
            .map((k) => k.trim().replace(/:$/, ''));
        expect(keys).toContain('none');
        expect(keys).toContain('freeU');
        const dropdown = stripComments(extractFn('displayGui')).match(/\{([^}]*)\}\)\.name\('capacity overlay'\)/);
        expect(dropdown, "the GUI's capacity-overlay dropdown was not found").not.toBeNull();
        // The dropdown literal is { 'Label': 'value', … } — take the VALUE of each pair.
        const offered = [...dropdown[1].matchAll(/'[^']+'\s*:\s*'([^']+)'/g)].map((m) => m[1]);
        expect(offered.length, 'no label:value pairs parsed out of the dropdown').toBeGreaterThan(0);
        for (const k of keys) expect(offered, `${k} has no dropdown entry`).toContain(k);
        for (const v of offered) expect(keys, `dropdown offers ${v}, which has no source`).toContain(v);
    });

    it('the option defaults to none', () => {
        expect(extractConst('options')).toMatch(/overlay\s*:\s*'none'/);
    });

});

// ---------------------------------------------------------------------------
describe('The legend markup and styling', () => {

    // Markup contracts across three files. Nothing to execute — kept as text matching on purpose,
    // but tied to the ramp the code computes rather than to three loose hex strings.

    it('the legend element exists in dc.html with its three rows', () => {
        expect(HTML_SOURCE).toContain('id="dcOverlayLegend"');
        expect(HTML_SOURCE).toContain('Free U Capacity');
        for (const label of ['Full', 'Half', 'Empty']) expect(HTML_SOURCE).toContain(label);
    });

    it('the CSS has the visibility class applyOverlay() toggles', () => {
        // applyOverlay() calls legend.classList.toggle('visible', …). A stylesheet without the
        // rule means the toggle works and the legend still never appears.
        expect(stripComments(extractFn('applyOverlay'))).toMatch(/classList\.toggle\('visible'/);
        expect(CSS_SOURCE).toContain('#dcOverlayLegend');
        expect(CSS_SOURCE).toContain('#dcOverlayLegend.visible');
    });

    it('every swatch class in the markup has a rule in the stylesheet', () => {
        const used = [...HTML_SOURCE.matchAll(/legend-swatch\s+(\w+)/g)].map((m) => m[1]);
        expect(used.length, 'no legend-swatch classes found in dc.html').toBeGreaterThan(0);
        for (const c of used) expect(CSS_SOURCE, `.legend-swatch.${c}`).toContain(`.legend-swatch.${c}`);
    });

    it('the swatch colours match the ends and middle of the computed ramp', () => {
        // The legend is a key to the tint. If the two drift, it is worse than having no legend.
        const swatch = (cls) => {
            const m = CSS_SOURCE.match(new RegExp(`\\.legend-swatch\\.${cls}\\s*\\{[^}]*background[^:]*:\\s*(#[0-9a-f]{6})`, 'i'));
            expect(m, `.legend-swatch.${cls} has no background colour`).not.toBeNull();
            const h = m[1];
            return [0, 1, 2].map((i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16) / 255);
        };
        const mesh = fakeRackMesh([{ id: 'f' }, { id: 'h' }, { id: 'e' }]);
        runApplyOverlay({ meshes: [mesh], freeU: new Map([['f', 0], ['h', 0.5], ['e', 1]]) });
        const pairs = [['full', mesh.colors[0]], ['half', mesh.colors[1]], ['empty', mesh.colors[2]]];
        for (const [cls, computed] of pairs) {
            const [r, g, b] = swatch(cls);
            // Within one 8-bit step: 0.67 amber cannot be written exactly in hex.
            expect(r, `${cls} red`).toBeCloseTo(computed.r, 1);
            expect(g, `${cls} green`).toBeCloseTo(computed.g, 1);
            expect(b, `${cls} blue`).toBeCloseTo(computed.b, 1);
        }
    });

});
