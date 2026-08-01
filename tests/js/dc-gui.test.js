/**
 * tests/js/dc-gui.test.js — the settings-panel adapter (plan_dc.md phase 8)
 *
 * public_html/js/dc-gui.js is the one piece of the renderer split that changes behaviour in BOTH
 * modes: displayGui() (dc.js) and the "Player" folder (dc-multi.js) are written once against this
 * surface, so a regression here breaks the default WebGL page too, not just ?renderer=webgpu.
 *
 * Neither backend is exercised for real here. lil-gui is mocked so the pass-through can be checked
 * call for call, and the Inspector backend runs against a hand-rolled fake modelled on the r184
 * internals the adapter reaches into — group.objects[].subItem, editor.select/slider/checkbox/input,
 * parameters.paramList. The fake's setValue() deliberately reproduces the upstream ValueSelect
 * defect (ignores its argument, re-dispatches the CURRENT value) so any call to it shows up as both
 * a setValue count and a spurious onChange.
 *
 * vitest.config.ts is environment:'node' and jsdom is not a dependency, so every element here is a
 * stub. requestAnimationFrame is installed on globalThis BEFORE the module is imported: dc-gui.js
 * picks its rAF branch at module-evaluation time, and the browser branch is the one worth testing.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// lil-gui stand-in. Hoisted above the imports by vitest, so it cannot close over anything in this
// file — instances are handed back through globalThis, as dc-multi.test.js does for its GLTF stub.
// ---------------------------------------------------------------------------
vi.mock('lil-gui', () => {
  class FakeController {
    constructor(object, property, params) {
      this.object = object;
      this.property = property;
      this.params = params;
      this.calls = [];
      this.offCount = 0;
      this.$name = { innerHTML: '' };
    }
    name(n) { this.calls.push(['name', n]); return this; }
    listen(v) { this.calls.push(['listen', v]); return this; }
    onChange(fn) { this.calls.push(['onChange', fn]); return this; }
    onFinishChange(fn) { this.calls.push(['onFinishChange', fn]); return this; }
    step(v) { this.calls.push(['step', v]); return this; }
    enable(v) { this.calls.push(['enable', v]); return this; }
    disable() { this.calls.push(['disable']); return this; }
    off() { this.offCount++; }
  }
  class FakeGUI {
    constructor(isFolder = false) {
      this.controllers = [];
      this.folders = [];
      this.isFolder = isFolder;
      this.openCount = 0;
      this.destroyCount = 0;
      this.domElement = { removed: 0, remove() { this.removed++; } };
      if (!isFolder) globalThis.__DC_GUIS__.push(this);
    }
    add(object, property, ...params) {
      const c = new FakeController(object, property, params);
      this.controllers.push(c);
      return c;
    }
    addFolder(name) {
      const f = new FakeGUI(true);
      f.title = name;
      this.folders.push(f);
      return f;
    }
    open() { this.openCount++; return this; }
    destroy() { this.destroyCount++; }
  }
  globalThis.__DC_GUIS__ = [];
  return { default: FakeGUI, GUI: FakeGUI };
});

// ---------------------------------------------------------------------------
// Controllable rAF. Installed before the dynamic import below so dc-gui.js takes its
// requestAnimationFrame branch — the one the page actually runs — and so the poll can be stepped
// one frame at a time instead of by wall clock.
// ---------------------------------------------------------------------------
let _rafSeq = 0;
const _rafCbs = new Map();
globalThis.requestAnimationFrame = (cb) => { _rafCbs.set(++_rafSeq, cb); return _rafSeq; };
globalThis.cancelAnimationFrame = (id) => { _rafCbs.delete(id); };

function flushRaf(frames = 1) {
  for (let i = 0; i < frames; i++) {
    const batch = [..._rafCbs];
    for (const [id] of batch) _rafCbs.delete(id);
    for (const [, cb] of batch) cb();
  }
}
function pendingRaf() { return _rafCbs.size; }

const { createPanel } = await import('../../public_html/js/dc-gui.js');

// The debounce window dc-gui.js uses for its emulated onFinishChange.
const FINISH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Element stubs (no jsdom in this project — see the header)
// ---------------------------------------------------------------------------
function el(tag = 'div', classes = []) {
  const set = new Set(classes);
  return {
    tag,
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    step: undefined,
    disabled: false,
    children: [],
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, on) => { if (on) set.add(c); else set.delete(c); },
    },
    querySelectorAll() { return this.children; },
  };
}

// ---------------------------------------------------------------------------
// Fake three.js Inspector — only the surface dc-gui.js touches.
// ---------------------------------------------------------------------------
class FakeEditor {
  constructor(label) {
    this._name = label;
    this._change = null;      // single slot, exactly like the real one: last registration wins
    this.domElement = el();
    this.setValueCalls = 0;
  }
  name(n) { this._name = n; return this; }
  onChange(cb) { this._change = cb; return this; }
  /** The upstream Value.setValue(): ignores its argument, re-dispatches the CURRENT value. */
  setValue() {
    this.setValueCalls++;
    if (this._change) this._change(this.getValue());
    return this;
  }
  /** Simulate the user driving the widget. */
  emit(value) { if (this._change) this._change(value); }
  getValue() { return undefined; }
}

class FakeSelect extends FakeEditor {
  constructor(label, options, value) {
    super(label);
    this.options = options;
    this.select = el('select');
    this.select.value = FakeSelect.keyFor(options, value);
    this.domElement.children = [this.select];
  }
  static keyFor(options, value) {
    if (Array.isArray(options)) {
      const hit = options.find((o) => String(o) === String(value));
      return hit === undefined ? '' : String(hit);
    }
    const key = Object.keys(options).find((k) => options[k] === value);
    return key === undefined ? '' : key;
  }
  // ValueSelect resolves the <option> value (the KEY) back through the options map.
  getValue() {
    if (Array.isArray(this.options)) return this.options.find((o) => String(o) === this.select.value);
    return this.options[this.select.value];
  }
}

class FakeSlider extends FakeEditor {
  constructor(label, value, min, max, step) {
    super(label);
    this.min = min; this.max = max; this._step = step;
    this.slider = el('input');
    this.numberInput = el('input');
    this.slider.value = value;
    this.numberInput.value = value;
    this.domElement.children = [this.slider, this.numberInput];
    this.stepCalls = [];
  }
  step(v) { this.stepCalls.push(v); this._step = v; return this; }
  getValue() { return Number(this.slider.value); }
}

/** ValueNumber: has an input, but no step() method — the adapter's fallback path. */
class FakeNumber extends FakeEditor {
  constructor(label, value) {
    super(label);
    this.input = el('input');
    this.input.value = value;
    this.domElement.children = [this.input];
  }
  getValue() { return Number(this.input.value); }
}

class FakeCheckbox extends FakeEditor {
  constructor(label, value) {
    super(label);
    this.checkbox = el('input');
    this.checkbox.checked = value;
    this.domElement.children = [this.checkbox];
  }
  getValue() { return this.checkbox.checked; }
}

class FakeString extends FakeEditor {
  constructor(label, value) {
    super(label);
    this.input = el('input');
    this.input.value = value;
    this.domElement.children = [this.input];
  }
  getValue() { return this.input.value; }
}

/** A button Item wraps its control alone — there is no <span class="value"> name cell. */
class FakeButton extends FakeEditor {
  constructor(label) {
    super(label);
    this.button = el('button');
    this.domElement.children = [this.button];
  }
  getValue() { return undefined; }
}

class FakeGroup {
  constructor(name, parentList) {
    this.name = name;
    this.objects = [];
    this.calls = [];
    this.folders = [];
    this.closeCount = 0;
    // Groups are adopted by a List (the Parameters tab) or by an Item (a parent group); both
    // expose remove(), and that is the only teardown the Inspector offers.
    this.item = { removed: [], remove(x) { this.removed.push(x); } };
    this.paramList = { parent: parentList };
  }
  add(object, property, ...params) {
    this.calls.push({ object, property, params });
    const value = object[property];
    const editor = FakeGroup.makeEditor(property, value, params);
    // A name cell only exists for real value rows.
    const subItem = editor instanceof FakeButton
      ? { data: [editor.button] }
      : (editor ? { data: [el('span', ['value'])] } : null);
    this.objects.push({ editor, subItem });
    return editor;
  }
  static makeEditor(property, value, params) {
    if (typeof value === 'function') return new FakeButton(property);
    if (params.length && (Array.isArray(params[0]) || (params[0] !== null && typeof params[0] === 'object'))) {
      return new FakeSelect(property, params[0], value);
    }
    if (typeof value === 'number') {
      return params.length >= 2
        ? new FakeSlider(property, value, params[0], params[1], params[2])
        : new FakeNumber(property, value);
    }
    if (typeof value === 'boolean') return new FakeCheckbox(property, value);
    if (typeof value === 'string') return new FakeString(property, value);
    return null;   // ParametersGroup.add() returns null for a type it has no editor for
  }
  addFolder(name) {
    const f = new FakeGroup(name, this.item);
    this.folders.push(f);
    return f;
  }
  close() { this.closeCount++; }
}

function makeInspector() {
  const paramList = { removed: [], remove(x) { this.removed.push(x); } };
  const inspector = {
    createdWith: [],
    parameters: { paramList, groups: [] },
    createParameters(name) {
      inspector.createdWith.push(name);
      const g = new FakeGroup(name, paramList);
      inspector.parameters.groups.push(g);
      return g;
    },
  };
  return inspector;
}

/** The group createPanel() built, i.e. the root Parameters group. */
function rootGroup(inspector) {
  return inspector.parameters.groups[0];
}
/** The editor produced by the Nth add() on a group. */
function editorAt(group, i) {
  return group.objects[i].editor;
}

beforeEach(() => {
  globalThis.__DC_GUIS__.length = 0;
  _rafCbs.clear();
});

// ===========================================================================
// Backend selection
// ===========================================================================
describe('createPanel() — backend selection', () => {
  it('uses lil-gui when no inspector is supplied — the default page must not change', () => {
    const panel = createPanel();
    expect(globalThis.__DC_GUIS__).toHaveLength(1);
    expect(typeof panel.add).toBe('function');
  });

  it('uses lil-gui when called with no options object at all', () => {
    createPanel(undefined);
    expect(globalThis.__DC_GUIS__).toHaveLength(1);
  });

  it('uses the Inspector when one that can createParameters is supplied', () => {
    const inspector = makeInspector();
    createPanel({ inspector });
    expect(inspector.createdWith).toEqual(['Scene settings']);
    expect(globalThis.__DC_GUIS__).toHaveLength(0);
  });

  it('falls back to lil-gui for an inspector without createParameters (the InspectorBase placeholder)', () => {
    createPanel({ inspector: {} });
    expect(globalThis.__DC_GUIS__).toHaveLength(1);
  });

  it('falls back to lil-gui, loudly but without throwing, if createParameters blows up', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const panel = createPanel({
      inspector: { createParameters() { throw new Error('upstream moved'); } },
    });
    expect(globalThis.__DC_GUIS__).toHaveLength(1);
    expect(typeof panel.add).toBe('function');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('falling back to lil-gui');
    warn.mockRestore();
  });
});

// ===========================================================================
// lil-gui backend — pass-through
// ===========================================================================
describe('lil-gui backend — stays a pass-through', () => {
  it('forwards add() arguments positionally, exactly as displayGui() writes them', () => {
    const panel = createPanel();
    const gui = globalThis.__DC_GUIS__[0];
    const opts = { faultyLights: 0 };
    panel.add(opts, 'faultyLights', 0, 100, 1);
    expect(gui.controllers).toHaveLength(1);
    expect(gui.controllers[0].object).toBe(opts);
    expect(gui.controllers[0].property).toBe('faultyLights');
    expect(gui.controllers[0].params).toEqual([0, 100, 1]);
  });

  it('delegates every controller method and stays chainable', () => {
    const panel = createPanel();
    const gui = globalThis.__DC_GUIS__[0];
    const onChange = () => {};
    const onFinish = () => {};
    const c = panel.add({ a: 1 }, 'a');
    expect(c.name('A')).toBe(c);
    expect(c.listen()).toBe(c);
    expect(c.onChange(onChange)).toBe(c);
    expect(c.onFinishChange(onFinish)).toBe(c);
    expect(c.step(0.1)).toBe(c);
    expect(c.enable(false)).toBe(c);
    expect(c.disable()).toBe(c);
    expect(gui.controllers[0].calls).toEqual([
      ['name', 'A'],
      ['listen', undefined],
      ['onChange', onChange],
      ['onFinishChange', onFinish],
      ['step', 0.1],
      ['enable', false],
      ['disable'],
    ]);
  });

  it('label() writes the colourised value markup into $name', () => {
    const panel = createPanel();
    const gui = globalThis.__DC_GUIS__[0];
    panel.add({ faultyLights: 12 }, 'faultyLights').label('faulty lights', '12%');
    expect(gui.controllers[0].$name.innerHTML)
      .toBe('faulty lights&nbsp;&nbsp;<span class="dc-val">12%</span>');
  });

  it('addFolder() returns a panel of the same shape and open() reaches lil-gui', () => {
    const panel = createPanel();
    const gui = globalThis.__DC_GUIS__[0];
    const folder = panel.addFolder('Movement');
    folder.add({ x: 0 }, 'x', -250, 250).listen();
    expect(gui.folders).toHaveLength(1);
    expect(gui.folders[0].title).toBe('Movement');
    expect(gui.folders[0].controllers).toHaveLength(1);
    expect(folder.open()).toBe(folder);
    expect(gui.folders[0].openCount).toBe(1);
  });

  it('root destroy() off()s the root controllers, detaches the element, then destroys (fix #17 / MAJOR-15)', () => {
    const panel = createPanel();
    const gui = globalThis.__DC_GUIS__[0];
    panel.add({ a: 1 }, 'a');
    panel.add({ b: 2 }, 'b');
    panel.destroy();
    expect(gui.controllers.map((c) => c.offCount)).toEqual([1, 1]);
    expect(gui.domElement.removed).toBe(1);
    expect(gui.destroyCount).toBe(1);
  });

  it('folder destroy() only destroys the folder — no element detach, no controller sweep', () => {
    const panel = createPanel();
    const gui = globalThis.__DC_GUIS__[0];
    const folder = panel.addFolder('LOD');
    folder.add({ d: 1 }, 'd');
    folder.destroy();
    const f = gui.folders[0];
    expect(f.destroyCount).toBe(1);
    expect(f.domElement.removed).toBe(0);
    expect(f.controllers[0].offCount).toBe(0);
    expect(gui.destroyCount).toBe(0);
  });
});

// ===========================================================================
// Inspector backend — construction and forwarding
// ===========================================================================
describe('Inspector backend — construction and forwarding', () => {
  it('forwards add() arguments positionally to the Parameters group', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const opts = { faultyLights: 0 };
    panel.add(opts, 'faultyLights', 0, 100, 1);
    const g = rootGroup(inspector);
    expect(g.calls).toEqual([{ object: opts, property: 'faultyLights', params: [0, 100, 1] }]);
  });

  it('addFolder() nests a real group and keeps the panel shape', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const folder = panel.addFolder('Display');
    folder.add({ showLabels: true }, 'showLabels');
    const g = rootGroup(inspector);
    expect(g.folders).toHaveLength(1);
    expect(g.folders[0].name).toBe('Display');
    expect(g.folders[0].objects).toHaveLength(1);
  });

  it('open() is a no-op that still chains — Inspector groups are open already', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const folder = panel.addFolder('Movement');
    expect(folder.open()).toBe(folder);
    expect(rootGroup(inspector).folders[0].closeCount).toBe(0);
  });

  it('name() reaches the editor and label() writes markup into the name cell', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const c = panel.add({ gravityMs2: 9.8 }, 'gravityMs2', 1.6, 14, 0.1);
    c.name('Gravity').label('Gravity', '9.8 m/s²');
    const g = rootGroup(inspector);
    expect(editorAt(g, 0)._name).toBe('Gravity');
    expect(g.objects[0].subItem.data[0].innerHTML)
      .toBe('Gravity&nbsp;&nbsp;<span class="dc-val">9.8 m/s²</span>');
  });

  it('step() uses ValueSlider.step() when it exists and the input attribute when it does not', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const slider = panel.add({ v: 1 }, 'v', 0.5, 2.0);
    expect(slider.step(0.1)).toBe(slider);
    expect(editorAt(rootGroup(inspector), 0).stepCalls).toEqual([0.1]);

    const number = panel.add({ n: 5 }, 'n');
    number.step(0.25);
    expect(editorAt(rootGroup(inspector), 1).input.step).toBe(0.25);
  });

  it('enable(false)/disable() disable the widgets and mark the row, since the Inspector has neither', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const c = panel.add({ mode: 'max 2.0' }, 'mode');
    const editor = editorAt(rootGroup(inspector), 0);

    expect(c.enable(false)).toBe(c);
    expect(editor.input.disabled).toBe(true);
    expect(editor.domElement.classList.contains('disabled')).toBe(true);

    c.enable(true);
    expect(editor.input.disabled).toBe(false);
    expect(editor.domElement.classList.contains('disabled')).toBe(false);

    c.disable();
    expect(editor.input.disabled).toBe(true);
  });

  it('stays chainable when the group has no editor for the value type', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const c = panel.add({ weird: Symbol('nope') }, 'weird');
    expect(editorAt(rootGroup(inspector), 0)).toBeNull();
    expect(() => c.name('x').listen().onChange(() => {}).step(1).enable(false).label('x', 1))
      .not.toThrow();
    expect(pendingRaf()).toBe(0);   // no editor, no poll
  });

  it('label() on a button row writes nothing rather than clobbering the control', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const c = panel.add({ toggle: () => {} }, 'toggle');
    const editor = editorAt(rootGroup(inspector), 0);
    expect(() => c.name('Toggle Perspective (1st/3rd)').label('Toggle', 'x')).not.toThrow();
    expect(editor.button.innerHTML).toBe('');
    expect(editor._name).toBe('Toggle Perspective (1st/3rd)');
  });
});

// ===========================================================================
// onChange fan-out + the emulated onFinishChange debounce
// ===========================================================================
describe('Inspector backend — onChange fan-out and the onFinishChange debounce', () => {
  beforeEach(() => {
    // Only the debounce is timer-driven; rAF stays under flushRaf()'s control.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fans a single Inspector change slot out to every registered onChange', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const a = vi.fn();
    const b = vi.fn();
    panel.add({ v: 0 }, 'v', 0, 100, 1).onChange(a).onChange(b);
    editorAt(rootGroup(inspector), 0).emit(7);
    expect(a).toHaveBeenCalledWith(7);
    expect(b).toHaveBeenCalledWith(7);
  });

  it('fires onFinishChange exactly once for a burst of changes — the faultyLights rebuild guard', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const onChange = vi.fn();
    const onFinish = vi.fn();
    panel.add({ faultyLights: 0 }, 'faultyLights', 0, 100, 1)
      .onChange(onChange)
      .onFinishChange(onFinish);

    const editor = editorAt(rootGroup(inspector), 0);
    for (let i = 1; i <= 25; i++) editor.emit(i);

    expect(onChange).toHaveBeenCalledTimes(25);
    expect(onFinish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS - 1);
    expect(onFinish).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith(25);   // the value the drag ended on
  });

  it('restarts the window on every change, so a slow drag still rebuilds once', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const onFinish = vi.fn();
    panel.add({ v: 0 }, 'v', 0, 100, 1).onFinishChange(onFinish);
    const editor = editorAt(rootGroup(inspector), 0);

    for (let i = 0; i < 5; i++) {
      editor.emit(i);
      vi.advanceTimersByTime(FINISH_DEBOUNCE_MS - 50);
    }
    expect(onFinish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it('fires again on a second, separate gesture', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const onFinish = vi.fn();
    panel.add({ v: 0 }, 'v', 0, 100, 1).onFinishChange(onFinish);
    const editor = editorAt(rootGroup(inspector), 0);

    editor.emit(1);
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS);
    editor.emit(2);
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS);
    expect(onFinish).toHaveBeenCalledTimes(2);
  });

  it('arms no timer at all when nothing registered onFinishChange', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    panel.add({ v: 0 }, 'v', 0, 100, 1).onChange(() => {});
    editorAt(rootGroup(inspector), 0).emit(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('root destroy() drops a pending finish callback instead of rebuilding a torn-down scene', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const onFinish = vi.fn();
    panel.add({ v: 0 }, 'v', 0, 100, 1).onFinishChange(onFinish);
    editorAt(rootGroup(inspector), 0).emit(9);
    panel.destroy();
    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS * 4);
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('folder destroy() drops the folder\'s pending finish callback and nothing else', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const rootFinish = vi.fn();
    const folderFinish = vi.fn();
    panel.add({ v: 0 }, 'v', 0, 100, 1).onFinishChange(rootFinish);
    const folder = panel.addFolder('Movement');
    folder.add({ x: 0 }, 'x', 0, 100, 1).onFinishChange(folderFinish);
    editorAt(rootGroup(inspector), 0).emit(9);
    editorAt(rootGroup(inspector).folders[0], 0).emit(7);

    folder.destroy();

    vi.advanceTimersByTime(FINISH_DEBOUNCE_MS * 4);
    expect(folderFinish).not.toHaveBeenCalled();
    expect(rootFinish).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// listen() — the ValueSelect gap-6 guard
// ===========================================================================
describe('Inspector backend — listen() writes the widget and never echoes a change', () => {
  const LOCATIONS = { 'Secaucus NJ': 0, 'Los Angeles CA': 1, 'Amsterdam NL': 2 };

  function selectPanel() {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const options = { location: 0 };
    const onChange = vi.fn();
    const ctrl = panel.add(options, 'location', LOCATIONS).listen().onChange(onChange);
    return { inspector, panel, options, onChange, ctrl, editor: editorAt(rootGroup(inspector), 0) };
  }

  it('pushes a programmatic change into the <select> without setValue() or an onChange echo', () => {
    const { options, onChange, editor } = selectPanel();
    expect(editor.select.value).toBe('Secaucus NJ');

    // What flyToServer()/switchLocation() do: write the property, let listen() catch up.
    options.location = 2;
    flushRaf();

    expect(editor.select.value).toBe('Amsterdam NL');
    expect(options.location).toBe(2);          // NOT reverted to the stale value
    expect(editor.setValueCalls).toBe(0);      // the broken upstream path was never taken
    expect(onChange).not.toHaveBeenCalled();   // and no spurious switchLocation()
  });

  it('leaves the widget alone while the property and the selection already agree', () => {
    const { onChange, editor } = selectPanel();
    flushRaf(3);
    expect(editor.select.value).toBe('Secaucus NJ');
    expect(editor.setValueCalls).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a value that is not in the options map rather than blanking the selection', () => {
    const { options, editor } = selectPanel();
    options.location = 99;
    flushRaf();
    expect(editor.select.value).toBe('Secaucus NJ');
    expect(editor.setValueCalls).toBe(0);
  });

  it('resolves array-style options too — dc-multi builds its character map either way', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const proxy = { character: 'ninja' };
    panel.add(proxy, 'character', ['ninja', 'robot', 'xbot']).listen();
    const editor = editorAt(rootGroup(inspector), 0);
    proxy.character = 'xbot';
    flushRaf();
    expect(editor.select.value).toBe('xbot');
    expect(editor.setValueCalls).toBe(0);
  });

  it('writes both halves of a slider row so the hidden number box cannot drift', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const pos = { x: 0 };
    panel.add(pos, 'x', -250, 250).listen();
    const editor = editorAt(rootGroup(inspector), 0);
    pos.x = -42;
    flushRaf();
    expect(editor.slider.value).toBe(-42);
    expect(editor.numberInput.value).toBe(-42);
    expect(editor.setValueCalls).toBe(0);
  });

  it('writes checkbox and text widgets from their own properties', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const opts = { showNetwork: false, label: 'a' };
    panel.add(opts, 'showNetwork').listen();
    panel.add(opts, 'label').listen();
    const g = rootGroup(inspector);
    opts.showNetwork = true;
    opts.label = 'b';
    flushRaf();
    expect(editorAt(g, 0).checkbox.checked).toBe(true);
    expect(editorAt(g, 1).input.value).toBe('b');
  });

  it('polls once per frame and does not stack a second loop on a repeated listen()', () => {
    const { ctrl } = selectPanel();
    expect(pendingRaf()).toBe(1);
    ctrl.listen();
    ctrl.listen();
    expect(pendingRaf()).toBe(1);
    flushRaf();
    expect(pendingRaf()).toBe(1);
  });

  it('listen(false) starts no poll, matching lil-gui', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    panel.add({ v: 0 }, 'v', 0, 10).listen(false);
    expect(pendingRaf()).toBe(0);
  });

  it('root destroy() cancels the poll — the Inspector\'s own listen() runs until the page dies', () => {
    const { panel, options, editor } = selectPanel();
    expect(pendingRaf()).toBe(1);
    panel.destroy();
    expect(pendingRaf()).toBe(0);
    options.location = 1;
    flushRaf(3);
    expect(editor.select.value).toBe('Secaucus NJ');
  });
});

// ===========================================================================
// destroy() — Inspector teardown
// ===========================================================================
describe('Inspector backend — destroy()', () => {
  it('removes the root group from its List and from parameters.groups', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const group = rootGroup(inspector);
    expect(inspector.parameters.groups).toContain(group);

    panel.destroy();

    expect(inspector.parameters.paramList.removed).toEqual([group.paramList]);
    expect(inspector.parameters.groups).not.toContain(group);
  });

  it('removes a folder from its parent Item and leaves parameters.groups alone', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const folder = panel.addFolder('LOD');
    const root = rootGroup(inspector);
    const sub = root.folders[0];

    folder.destroy();

    expect(root.item.removed).toEqual([sub.paramList]);
    expect(inspector.parameters.groups).toContain(root);
    expect(inspector.parameters.paramList.removed).toEqual([]);
  });

  it('folder destroy() cancels that folder\'s polls and leaves the rest of the panel running', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    panel.add({ v: 0 }, 'v', 0, 10).listen();
    const folder = panel.addFolder('Movement');
    folder.add({ x: 0 }, 'x', -250, 250).listen();
    expect(pendingRaf()).toBe(2);

    folder.destroy();

    expect(pendingRaf()).toBe(1);   // only the folder's poll stopped
    panel.destroy();
    expect(pendingRaf()).toBe(0);
  });

  it('destroying the root also tears down controllers built on its folders', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const folder = panel.addFolder('Movement');
    folder.add({ x: 0 }, 'x', -250, 250).listen();
    expect(pendingRaf()).toBe(1);
    panel.destroy();
    expect(pendingRaf()).toBe(0);
  });

  it('survives a teardown that throws — one bad controller must not keep the panel alive', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    panel.add({ v: 0 }, 'v', 0, 10).listen();
    globalThis.cancelAnimationFrame = () => { throw new Error('boom'); };
    try {
      expect(() => panel.destroy()).not.toThrow();
    } finally {
      globalThis.cancelAnimationFrame = (id) => { _rafCbs.delete(id); };
    }
    expect(inspector.parameters.groups).not.toContain(rootGroup(inspector));
  });
});

// ===========================================================================
// The dc-multi.js "Player" folder — the contract that breaks in BOTH modes
// ===========================================================================
describe('the dc-multi.js Player folder builds on either backend', () => {
  /** Replays populateCharacterPicker()'s folder verbatim (dc-multi.js:862-883). */
  function buildPlayerFolder(panel) {
    // S.DC is window.DC; the GPU Mode row reads its powerPreference rather than keeping a copy.
    const S = { pixelScale: 1, fov: 75, loadedCharId: 'ninja', DC: { powerPreference: 'browser default' } };
    let WALK = 14;
    let RUN = 34;
    const opts = { 'Ninja': 'ninja', 'Robot (system)': 'robot' };
    const charProxy = { character: S.loadedCharId };
    const f = panel.addFolder('Player');
    f.add(charProxy, 'character', opts).name('Character').listen().onChange(() => {});
    f.add({ toggle: () => {} }, 'toggle').name('Toggle Perspective (1st/3rd)');
    f.add(S, 'pixelScale', 0.5, 1.0).name('Quality').step(0.1).onChange(() => {});
    f.add({ 'DPR Cap': 'max 2.0' }, 'DPR Cap').name('DPR Cap').enable(false);
    f.add(S, 'fov', 30, 120).name('FOV').step(1).onChange(() => {});
    f.add({ 'GPU Mode': (S.DC && S.DC.powerPreference) || 'unknown' }, 'GPU Mode').name('GPU Mode').enable(false);
    f.add({ get walk() { return WALK; }, set walk(v) { WALK = v; } }, 'walk', 1, 30)
      .name('Walk Speed').step(0.5).onChange((v) => { WALK = v; });
    f.add({ get run() { return RUN; }, set run(v) { RUN = v; } }, 'run', 5, 60)
      .name('Run Speed').step(0.5).onChange((v) => { RUN = v; });
    f.open();
    return f;
  }

  it('builds against lil-gui with eight controls', () => {
    const panel = createPanel();
    expect(() => buildPlayerFolder(panel)).not.toThrow();
    const gui = globalThis.__DC_GUIS__[0];
    expect(gui.folders[0].title).toBe('Player');
    expect(gui.folders[0].controllers).toHaveLength(8);
    expect(gui.folders[0].openCount).toBe(1);
  });

  it('builds against the Inspector with the same eight controls', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    expect(() => buildPlayerFolder(panel)).not.toThrow();
    const folder = rootGroup(inspector).folders[0];
    expect(folder.name).toBe('Player');
    expect(folder.objects).toHaveLength(8);
    expect(folder.calls.map((c) => c.property)).toEqual([
      'character', 'toggle', 'pixelScale', 'DPR Cap', 'fov', 'GPU Mode', 'walk', 'run',
    ]);
  });

  it('keeps the Character dropdown quiet when dc-multi rewrites it after a GLB load', () => {
    const inspector = makeInspector();
    const panel = createPanel({ inspector });
    const opts = { 'Ninja': 'ninja', 'Robot (system)': 'robot' };
    const charProxy = { character: 'ninja' };
    const onChange = vi.fn();
    panel.add(charProxy, 'character', opts).name('Character').listen().onChange(onChange);
    const editor = editorAt(rootGroup(inspector), 0);

    charProxy.character = 'robot';   // loadCharacter() writes this on every successful load
    flushRaf();

    expect(editor.select.value).toBe('Robot (system)');
    expect(onChange).not.toHaveBeenCalled();   // a second GLB fetch would start here
    expect(editor.setValueCalls).toBe(0);
  });
});
