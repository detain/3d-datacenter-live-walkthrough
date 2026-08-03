/**
 * dc-gui.js — the settings-panel adapter for the datacenter walkthrough.
 *
 * dc.js builds one settings panel but the page runs on two renderers (see plan_dc.md): the
 * classic WebGLRenderer, where the panel is lil-gui, and the node renderer, where the three.js
 * Inspector docks its own Parameters tab and a lil-gui window would just sit on top of it. Both
 * are driven through the lil-gui-shaped surface below, so displayGui() is written once.
 *
 * The lil-gui backend is a straight pass-through and has to stay one — the default
 * (?renderer absent) page is everyone's page.
 *
 * The Inspector backend closes the gaps against lil-gui. The two that bite hardest:
 *
 *  - There is no onFinishChange(). The Inspector dispatches a change per slider tick, so the
 *    expensive callers — displayDatacenter() on the faultyLights slider — would rebuild the whole
 *    scene on every pixel of a drag. Emulated with a trailing debounce: a burst of changes fires
 *    the finish callbacks exactly once, FINISH_DEBOUNCE_MS after the last one.
 *
 *  - ValueSelect (like ValueColor) never overrides Value.setValue(), and the base implementation
 *    ignores its argument and re-dispatches the CURRENT value. The Inspector's own listen() calls
 *    exactly that, so a programmatic write to a select-backed property leaves the <select> alone,
 *    pushes the stale value back onto the object, and fires onChange on the way past. On the
 *    location dropdown that is a spurious switchLocation(); on dc-multi.js's Character dropdown —
 *    which dc-multi writes every time a GLB finishes loading — it is a spurious loadCharacter()
 *    and a second GLB fetch. listen() here therefore never calls setValue(): it writes the
 *    widget's element directly and dispatches nothing, which is what lil-gui's listen() does too.
 *    That also makes the poll cancellable, where the Inspector's rAF loop runs until the page does.
 *
 * dc-multi.js builds its "Player" folder on whatever DC.gui is, so add() has to keep lil-gui's
 * overloaded signature — positional (min, max, step) for sliders, an options object/array for
 * dropdowns, a function value for a button, a string value for a text field — and name()/step()/
 * enable() have to stay chainable on both backends.
 */
import GUI from 'lil-gui';

// Trailing window for the emulated onFinishChange. Long enough that a drag reads as one gesture,
// short enough that releasing the slider feels like it acted immediately.
const FINISH_DEBOUNCE_MS = 250;

// Wrapped rather than aliased: the bare globals are host methods and calling them unbound throws
// "Illegal invocation" in some browsers. The setTimeout fallback is for non-browser hosts (unit
// tests) — nothing on the page runs without rAF.
const _raf = typeof requestAnimationFrame === 'function' ? (cb) => requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16);
const _caf = typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);

// "name  value" with the value in a coloured span so it stands out; the right-hand number box is
// hidden via css, so this label is where the number actually lives. No parentheses — the colour
// separates the two. Both backends write it as innerHTML because neither name() takes markup.
function valMarkup(name, val) {
    return name + '&nbsp;&nbsp;<span class="dc-val">' + val + '</span>';
}

/* ------------------------------------------------------------------ lil-gui backend */

function lilController(ctrl) {
    const w = {
        name(n) { ctrl.name(n); return w; },
        listen(v) { ctrl.listen(v); return w; },
        onChange(fn) { ctrl.onChange(fn); return w; },
        onFinishChange(fn) { ctrl.onFinishChange(fn); return w; },
        step(v) { ctrl.step(v); return w; },
        enable(v) { ctrl.enable(v); return w; },
        disable() { ctrl.disable(); return w; },
        label(n, val) { ctrl.$name.innerHTML = valMarkup(n, val); return w; },
        // R3.7: re-read the bound object into the widget. Both GUIs cache the value at
        // construction and only refresh on user interaction, so anything that changes an option
        // programmatically — the auto-quality scaler dropping ambient occlusion, for one — leaves
        // the widget showing the opposite of what is actually set.
        updateDisplay() { ctrl.updateDisplay(); return w; },
    };
    return w;
}

function lilPanel(gui, isRoot) {
    const p = {
        add(obj, prop, ...params) { return lilController(gui.add(obj, prop, ...params)); },
        addFolder(name) { return lilPanel(gui.addFolder(name), false); },
        open() { gui.open(); return p; },
        destroy() {
            // Fix #17 / MAJOR-15, carried over verbatim from displayGui(): lil-gui's destroy()
            // drops the DOM element but not necessarily every internal listener, so off() the
            // root controllers first and detach the element explicitly.
            if (isRoot && gui.controllers && gui.controllers.length) {
                for (const c of gui.controllers) {
                    if (typeof c.off === 'function') c.off();
                }
            }
            if (isRoot) gui.domElement.remove();
            gui.destroy();
        },
    };
    return p;
}

/* --------------------------------------------------------------- Inspector backend */

// The <option> value attribute is the KEY of the options map (or the entry itself for an array),
// and ValueSelect.getValue() resolves back through it — so an object map like locationNames
// ({name: index}) round-trips to the index exactly as it does in lil-gui. Loose compare on
// purpose: the Inspector's own constructor matches the initial selection with == too.
function selectKeyFor(options, val) {
    if (!options) return null;
    if (Array.isArray(options)) {
        for (const opt of options) if (opt == val) return String(opt); // eslint-disable-line eqeqeq
        return null;
    }
    for (const key of Object.keys(options)) if (options[key] == val) return key; // eslint-disable-line eqeqeq
    return null;
}

// Push a value into the editor's element WITHOUT dispatching a change — the whole point of the
// listen() workaround. Mirrors each Value subclass's own setValue(), minus the dispatch, plus the
// ValueSelect case that setValue() gets wrong.
function writeWidget(editor, val) {
    if (editor.select) {
        const key = selectKeyFor(editor.options, val);
        if (key !== null) editor.select.value = key;
    } else if (editor.slider) {
        editor.slider.value = val;
        if (editor.numberInput) editor.numberInput.value = val;
    } else if (editor.checkbox) {
        editor.checkbox.checked = val;
    } else if (editor.input) {
        editor.input.value = val;
    }
}

function inspectorController(object, property, editor, subItem, teardowns) {
    const changeCbs = [];
    const finishCbs = [];
    let finishTimer = null;
    let rafId = null;

    // The Inspector's onChange is a single slot (last registration wins) and it fires deferred by
    // one rAF, so register the fan-out once here and keep the callbacks in our own lists.
    if (editor && typeof editor.onChange === 'function') {
        editor.onChange((value) => {
            for (const cb of changeCbs) cb(value);
            if (finishCbs.length) {
                if (finishTimer !== null) clearTimeout(finishTimer);
                finishTimer = setTimeout(() => {
                    finishTimer = null;
                    for (const cb of finishCbs) cb(value);
                }, FINISH_DEBOUNCE_MS);
            }
        });
    }

    // subItem.data[0] is the <span class="value"> holding the property name; buttons get no such
    // cell (their Item wraps the control alone), so label() has to check before writing markup.
    const labelEl = subItem && subItem.data && subItem.data[0] && subItem.data[0].classList
        && subItem.data[0].classList.contains('value') ? subItem.data[0] : null;

    const w = {
        name(n) {
            if (editor && typeof editor.name === 'function') editor.name(n);
            return w;
        },
        listen(v) {
            if (!editor || v === false || rafId !== null) return w;
            const poll = () => {
                rafId = _raf(poll);
                const want = object[property];
                if (editor.getValue() !== want) writeWidget(editor, want);
            };
            rafId = _raf(poll);
            return w;
        },
        onChange(fn) { if (typeof fn === 'function') changeCbs.push(fn); return w; },
        onFinishChange(fn) { if (typeof fn === 'function') finishCbs.push(fn); return w; },
        step(v) {
            // ValueSlider.step() exists and is chainable; ValueNumber has no such method.
            if (editor && typeof editor.step === 'function') editor.step(v);
            else if (editor && editor.input) editor.input.step = v;
            return w;
        },
        enable(v) {
            // No enable/disable anywhere in the Inspector's Value classes — do it on the elements.
            const on = v !== false;
            if (editor && editor.domElement) {
                const els = editor.domElement.querySelectorAll('input, select, button, textarea');
                for (const el of els) el.disabled = !on;
                editor.domElement.classList.toggle('disabled', !on);
            }
            return w;
        },
        disable() { return w.enable(false); },
        label(n, val) {
            if (labelEl) labelEl.innerHTML = valMarkup(n, val);
            return w;
        },
        // R3.7: the Inspector counterpart of lil-gui's updateDisplay(). writeWidget is the same
        // path listen()'s poll uses, so a programmatic option change lands in the widget without
        // having to install a permanent rAF poll on every controller that might change.
        updateDisplay() {
            if (editor) writeWidget(editor, object[property]);
            return w;
        },
    };

    teardowns.push(() => {
        if (rafId !== null) { _caf(rafId); rafId = null; }
        if (finishTimer !== null) { clearTimeout(finishTimer); finishTimer = null; }
        changeCbs.length = 0;
        finishCbs.length = 0;
    });

    return w;
}

function inspectorPanel(inspector, group, isRoot, parentTeardowns) {
    // Each panel owns the teardowns for the controllers added directly to it and registers a runner
    // with its parent, so destroying a FOLDER stops that folder's rAF polls and only those, while
    // destroying the root still cascades through every folder it handed out. One list shared down
    // the whole tree (which is what this was) plus a root-only run meant folder.destroy() stopped
    // nothing: dc.js only ever destroys the root, so the polls survived until the page did.
    const teardowns = [];
    const runTeardowns = () => {
        for (const fn of teardowns) {
            try { fn(); } catch (e) { /* teardown must not throw the panel away */ }
        }
        teardowns.length = 0;
    };
    if (parentTeardowns) parentTeardowns.push(runTeardowns);

    const p = {
        add(obj, prop, ...params) {
            // ParametersGroup.add() returns null for a value type it has no editor for; the wrapper
            // stays chainable either way so one unsupported control can't take the panel with it.
            const editor = group.add(obj, prop, ...params);
            const rec = group.objects[group.objects.length - 1];
            const subItem = (editor && rec && rec.editor === editor) ? rec.subItem : null;
            return inspectorController(obj, prop, editor, subItem, teardowns);
        },
        addFolder(name) { return inspectorPanel(inspector, group.addFolder(name), false, teardowns); },
        // Inspector groups are open by default and expose only close().
        open() { return p; },
        destroy() {
            runTeardowns();
            // Both List (the Parameters tab) and Item (a parent group) implement remove(), and
            // paramList.parent is whichever one adopted it — there is no destroy() to call.
            const parent = group.paramList && group.paramList.parent;
            if (parent && typeof parent.remove === 'function') parent.remove(group.paramList);
            const params = inspector && inspector.parameters;
            if (isRoot && params && Array.isArray(params.groups)) {
                const i = params.groups.indexOf(group);
                if (i !== -1) params.groups.splice(i, 1);
            }
        },
    };
    return p;
}

/* ------------------------------------------------------------------------- factory */

/**
 * Build the settings panel over whichever backend is available.
 *
 * @param {{inspector: object|null}} [opts] - the REAL three.js Inspector, or null/absent for
 *        lil-gui. Do not pass renderer.inspector: the node renderer always has one (an
 *        InspectorBase placeholder), so that value is never falsy and would select this backend
 *        even when the addon failed to load. dc.js tracks the real one separately.
 * @returns {object} lil-gui-shaped panel: add/addFolder/open/destroy.
 */
export function createPanel({ inspector } = {}) {
    if (inspector && typeof inspector.createParameters === 'function') {
        try {
            return inspectorPanel(inspector, inspector.createParameters('Scene settings'), true, null);
        } catch (err) {
            // The adapter reaches into Inspector internals that are still moving upstream; a
            // three.js bump breaking them must cost the panel's looks, not the panel.
            console.warn('[dc] Inspector parameters unavailable, falling back to lil-gui:', err && err.message);
        }
    }
    return lilPanel(new GUI(), true);
}
