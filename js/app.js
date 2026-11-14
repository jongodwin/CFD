/* Mass Balance Reconciler — user interface. Plain DOM, no dependencies. */
(function () {
  'use strict';

  const STORE_KEY = 'mass-balance-project-v1';
  const VIEW_W = 1000, VIEW_H = 420, NODE_W = 136, NODE_H = 56;
  const $ = (id) => document.getElementById(id);

  // ---------- tiny DOM helper ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat(Infinity).forEach((kid) => { if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
    return el;
  }
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v);
    kids.flat().forEach((kid) => { if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); });
    return el;
  }

  // ---------- state ----------
  let state, result = null, stale = false, runErrors = null;
  let tab = 'flowsheet';
  const ui = { selected: null, mode: 'select', pending: null, drag: null, pointer: null };

  function blankProject() {
    return {
      options: { sizes: true, assays: true, sizeAssays: false }, flowUnit: 't/h', psdMinAbs: 0.1,
      bins: [{ label: '+150 µm' }, { label: '-150 +75 µm' }, { label: '-75 µm' }],
      comps: [{ name: 'Cu', unit: '%', minAbs: 0.01 }],
      nodes: [], streams: [],
    };
  }
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const numOrNull = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

  /** Make every array in the project match the current number of size fractions and components. */
  function normalise(p) {
    p.options = Object.assign({ sizes: false, assays: false, sizeAssays: false }, p.options);
    p.flowUnit = typeof p.flowUnit === 'string' ? p.flowUnit : 't/h';
    p.psdMinAbs = numOrNull(p.psdMinAbs) || 0.1;
    p.bins = (p.bins || []).map((b) => ({ label: String(b.label || '') }));
    p.comps = (p.comps || []).map((c) => ({ name: String(c.name || ''), unit: String(c.unit || ''), minAbs: numOrNull(c.minAbs) }));
    p.nodes = (p.nodes || []).map((n, i) => ({
      id: String(n.id || uid('n')), name: String(n.name || 'Unit ' + (i + 1)), conserveSize: n.conserveSize !== false,
      x: numOrNull(n.x) != null ? n.x : 160 + (i % 4) * 220, y: numOrNull(n.y) != null ? n.y : 110 + Math.floor(i / 4) * 150,
    }));
    const ids = new Set(p.nodes.map((n) => n.id));
    p.streams = (p.streams || []).map((st, i) => {
      const o = {
        id: String(st.id || uid('s')), name: String(st.name || 'Stream ' + (i + 1)),
        from: ids.has(st.from) ? st.from : null, to: ids.has(st.to) ? st.to : null,
        fx: numOrNull(st.fx), fy: numOrNull(st.fy), tx: numOrNull(st.tx), ty: numOrNull(st.ty),
        flow: numOrNull(st.flow),
        errFlow: numOrNull(st.errFlow) != null ? st.errFlow : 2, errSize: numOrNull(st.errSize) != null ? st.errSize : 5,
        errAssay: numOrNull(st.errAssay) != null ? st.errAssay : 5, errSizeAssay: numOrNull(st.errSizeAssay) != null ? st.errSizeAssay : 8,
        psd: p.bins.map((_, b) => numOrNull(st.psd && st.psd[b])),
        assay: p.comps.map((_, k) => numOrNull(st.assay && st.assay[k])),
        sizeAssay: p.bins.map((_, b) => p.comps.map((__, k) => numOrNull(st.sizeAssay && st.sizeAssay[b] && st.sizeAssay[b][k]))),
      };
      return o;
    });
    placeFreeEnds(p);
    return p;
  }
  function placeFreeEnds(p) {
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    p.streams.forEach((st, i) => {
      const a = byId.get(st.from), b = byId.get(st.to);
      if (!a && st.fx == null) { st.fx = b ? Math.max(40, b.x - 190) : 80; st.fy = b ? b.y + ((i % 3) - 1) * 50 : 60 + i * 30; }
      if (!b && st.tx == null) { st.tx = a ? Math.min(VIEW_W - 40, a.x + 190) : 240; st.ty = a ? a.y + ((i % 3) - 1) * 70 : 60 + i * 30; }
    });
  }
  let uidCounter = 0;
  function uid(prefix) {
    const taken = new Set(state ? [...state.nodes, ...state.streams].map((o) => o.id) : []);
    let id;
    do { id = prefix + (++uidCounter); } while (taken.has(id));
    return id;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable: carry on */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return normalise(JSON.parse(raw));
    } catch (e) { /* fall through to the example */ }
    return normalise(clone(window.MB_EXAMPLE));
  }
  /** Call after any edit to the inputs. */
  function changed() {
    if (result) stale = true;
    runErrors = null;
    save();
    renderChrome();
  }

  // ---------- number formatting / parsing ----------
  function parseNum(text) {
    const t = String(text).trim().replace(',', '.');
    if (t === '') return { ok: true, value: null };
    const v = Number(t);
    return isFinite(v) ? { ok: true, value: v } : { ok: false, value: null };
  }
  function fmt(v, sig) {
    if (v == null || !isFinite(v)) return '';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    const d = Math.max(0, Math.min(6, (sig || 4) - 1 - Math.floor(Math.log10(a))));
    return v.toFixed(d);
  }
  /** Format a value to the precision its standard deviation justifies. */
  function fmtPair(v, sd) {
    if (sd == null || !(sd > 0)) return [fmt(v, 4), ''];
    const d = Math.max(0, Math.min(6, 1 - Math.floor(Math.log10(sd))));
    return [v.toFixed(d), sd.toFixed(d)];
  }

  // ---------- generic numeric grid ----------
  function numCell(id, value, onSet, extra) {
    const input = h('input', Object.assign({
      type: 'text', inputmode: 'decimal', id, class: 'num', value: value == null ? '' : String(value), autocomplete: 'off',
      onchange: () => {
        const p = parseNum(input.value);
        input.classList.toggle('invalid', !p.ok);
        if (p.ok) { onSet(p.value); changed(); }
      },
    }, extra || {}));
    return input;
  }
  /**
   * Table of numeric inputs: rows = streams. Supports pasting a block copied
   * from a spreadsheet and moving with Enter / arrow keys.
   */
  function grid(key, cols, rows, get, set, opts) {
    opts = opts || {};
    const table = h('table', { class: 'grid' });
    table.append(h('thead', {}, h('tr', {}, h('th', {}, opts.corner || 'Stream'), cols.map((c) => h('th', { class: 'num' }, c)), opts.sum ? h('th', { class: 'num' }, 'Sum') : null)));
    const body = h('tbody');
    const sumCells = [];
    const refreshSum = (r) => {
      if (!opts.sum) return;
      let t = 0, any = false;
      cols.forEach((_, c) => { const v = get(r, c); if (v != null) { t += v; any = true; } });
      sumCells[r].textContent = any ? t.toFixed(1) : '';
      sumCells[r].classList.toggle('off', any && Math.abs(t - 100) > 2);
    };
    rows.forEach((label, r) => {
      const tr = h('tr', {}, h('th', {}, label));
      cols.forEach((_, c) => {
        const input = numCell(`${key}-${r}-${c}`, get(r, c), (v) => { set(r, c, v); refreshSum(r); }, { 'data-r': r, 'data-c': c, 'aria-label': `${label}, ${cols[c]}` });
        tr.append(h('td', { class: 'num' }, input));
      });
      if (opts.sum) { const td = h('td', { class: 'sum' }); sumCells.push(td); tr.append(td); }
      body.append(tr);
    });
    table.append(body);
    rows.forEach((_, r) => refreshSum(r));
    const cell = (r, c) => table.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
    table.addEventListener('paste', (ev) => {
      const t = ev.target;
      if (!t.matches || !t.matches('input[data-r]')) return;
      const text = (ev.clipboardData || window.clipboardData).getData('text');
      if (!/[\t\n]/.test(text.trim())) return;
      ev.preventDefault();
      const r0 = +t.dataset.r, c0 = +t.dataset.c;
      text.replace(/\r/g, '').replace(/\n+$/, '').split('\n').forEach((line, dr) => {
        line.split('\t').forEach((v, dc) => {
          const input = cell(r0 + dr, c0 + dc);
          if (!input) return;
          const p = parseNum(v);
          input.value = p.ok && p.value != null ? String(p.value) : '';
          input.classList.remove('invalid');
          set(r0 + dr, c0 + dc, p.ok ? p.value : null);
        });
      });
      rows.forEach((_, r) => refreshSum(r));
      changed();
    });
    table.addEventListener('keydown', (ev) => {
      const t = ev.target;
      if (!t.matches || !t.matches('input[data-r]')) return;
      const dr = ev.key === 'ArrowDown' || ev.key === 'Enter' ? 1 : ev.key === 'ArrowUp' ? -1 : 0;
      if (!dr) return;
      const next = cell(+t.dataset.r + dr, +t.dataset.c);
      if (next) { ev.preventDefault(); t.dispatchEvent(new Event('change')); next.focus(); next.select(); }
    });
    return h('div', { class: 'scroll' }, table);
  }

  // ---------- chrome: tabs, banner ----------
  function renderChrome() {
    document.querySelectorAll('.tabs button').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      $('tab-' + b.dataset.tab).hidden = !on;
    });
    const rb = $('tabbtn-results');
    rb.textContent = 'Results';
    if (result && stale) rb.append(h('span', { class: 'dot', title: 'Inputs changed since the last run' }));
    const banner = $('banner');
    banner.replaceChildren();
    banner.className = 'banner';
    if (runErrors && runErrors.length) {
      banner.hidden = false;
      banner.classList.add('error');
      banner.append(h('strong', {}, 'The balance could not be run.'), h('ul', {}, runErrors.map((e) => h('li', {}, e))));
    } else banner.hidden = true;
  }
  function show(name) {
    tab = name;
    try { localStorage.setItem(STORE_KEY + '-tab', name); } catch (e) { /* ignore */ }
    render();
  }
  function render() {
    renderChrome();
    ({ setup: renderSetup, flowsheet: renderFlowsheet, data: renderData, results: renderResults })[tab]();
  }

  // ---------- Setup tab ----------
  function renderSetup() {
    const o = state.options;
    const check = (id, key, title, sub, disabled) => h('label', { class: 'check' + (disabled ? ' disabled' : ''), for: id },
      h('input', { type: 'checkbox', id, checked: !!o[key], disabled, onchange: (e) => { o[key] = e.target.checked; changed(); renderSetup(); } }),
      h('span', {}, title, h('small', {}, sub)));

    const dataPanel = h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Data to reconcile')),
      h('p', { class: 'hint' }, 'Choose any combination. Solids flow is always balanced; each option adds measurements and the balances that go with them.'),
      check('opt-sizes', 'sizes', 'Particle size distribution', 'Mass % retained in each size fraction, per stream.'),
      check('opt-assays', 'assays', 'Chemical assays', 'Head assay of each component, per stream.'),
      check('opt-sizeassays', 'sizeAssays', 'Assays of each size fraction', o.sizes ? 'Assay of each component in every size fraction. Head assays, if also selected, are reconciled against them.' : 'Needs particle size distribution switched on.', !o.sizes),
      h('div', { class: 'row' },
        h('label', { for: 'flow-unit' }, 'Solids flow unit'),
        h('input', { type: 'text', id: 'flow-unit', class: 'short', value: state.flowUnit, onchange: (e) => { state.flowUnit = e.target.value.trim(); changed(); } })));

    const binsBody = h('tbody');
    state.bins.forEach((b, i) => binsBody.append(h('tr', {},
      h('td', { class: 'num' }, i + 1),
      h('td', {}, h('input', { type: 'text', id: 'bin-' + i, class: 'name', value: b.label, 'aria-label': 'Size fraction ' + (i + 1), onchange: (e) => { b.label = e.target.value; changed(); } })),
      h('td', {}, h('button', { type: 'button', class: 'btn small', 'aria-label': 'Remove ' + b.label, onclick: () => {
        state.bins.splice(i, 1);
        state.streams.forEach((st) => { st.psd.splice(i, 1); st.sizeAssay.splice(i, 1); });
        changed(); renderSetup();
      } }, 'Remove')))));
    const binsPanel = h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Size fractions'), h('button', { type: 'button', class: 'btn small', id: 'add-bin', onclick: () => {
        state.bins.push({ label: 'Fraction ' + (state.bins.length + 1) });
        state.streams.forEach((st) => { st.psd.push(null); st.sizeAssay.push(state.comps.map(() => null)); });
        changed(); renderSetup();
      } }, 'Add fraction')),
      h('p', { class: 'hint' }, 'List from coarsest to finest; the last is usually the pan (undersize). Enter size data as mass % retained in each fraction, not cumulative.'),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { class: 'num' }, '#'), h('th', {}, 'Label'), h('th', {}))), binsBody)),
      h('div', { class: 'row' },
        h('label', { for: 'psd-min' }, 'Smallest absolute error on a size fraction, mass %'),
        numCell('psd-min', state.psdMinAbs, (v) => { state.psdMinAbs = v > 0 ? v : 0.1; })));

    const compBody = h('tbody');
    state.comps.forEach((c, k) => compBody.append(h('tr', {},
      h('td', {}, h('input', { type: 'text', id: 'comp-name-' + k, class: 'short', value: c.name, 'aria-label': 'Component name', onchange: (e) => { c.name = e.target.value; changed(); } })),
      h('td', {}, h('input', { type: 'text', id: 'comp-unit-' + k, class: 'short', value: c.unit, 'aria-label': 'Unit', onchange: (e) => { c.unit = e.target.value; changed(); } })),
      h('td', { class: 'num' }, numCell('comp-min-' + k, c.minAbs, (v) => { c.minAbs = v; }, { 'aria-label': 'Smallest absolute error' })),
      h('td', {}, h('button', { type: 'button', class: 'btn small', 'aria-label': 'Remove ' + c.name, onclick: () => {
        state.comps.splice(k, 1);
        state.streams.forEach((st) => { st.assay.splice(k, 1); st.sizeAssay.forEach((row) => row.splice(k, 1)); });
        changed(); renderSetup();
      } }, 'Remove')))));
    const compPanel = h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Assayed components'), h('button', { type: 'button', class: 'btn small', id: 'add-comp', onclick: () => {
        state.comps.push({ name: 'Comp ' + (state.comps.length + 1), unit: '%', minAbs: null });
        state.streams.forEach((st) => { st.assay.push(null); st.sizeAssay.forEach((row) => row.push(null)); });
        changed(); renderSetup();
      } }, 'Add component')),
      h('p', { class: 'hint' }, 'Any unit works (%, g/t, ppm) as long as a component uses the same unit on every stream. The smallest absolute error stops near-zero assays from being treated as exact.'),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Unit'), h('th', { class: 'num' }, 'Smallest abs. error'), h('th', {}))), compBody)));

    const cols = h('div', { class: 'cols' }, dataPanel);
    if (o.sizes) cols.append(binsPanel);
    if (o.assays || (o.sizeAssays && o.sizes)) cols.append(compPanel);
    $('tab-setup').replaceChildren(cols,
      h('div', { class: 'panel' },
        h('h2', {}, 'How the balance is calculated'),
        h('p', { class: 'hint' }, 'The unknowns are mass flows: solids in each size fraction and each component in each stream. Every unit must conserve them, and the solver finds the set of flows that changes your measurements least, weighting each adjustment by the error you assign (sum of squared adjustment ÷ standard deviation).'),
        h('p', { class: 'hint' }, 'No flow can go negative: all mass flows are held above zero with an interior-point (logarithmic barrier) method, so an inconsistent sample pushes a flow toward zero instead of through it.'),
        h('p', { class: 'hint' }, 'The standard deviation reported for each reconciled value is propagated from your error estimates through the balance constraints. It is never larger than the error of the measurement it replaces.')));
  }

  // ---------- Flowsheet tab ----------
  const nodeById = (id) => state.nodes.find((n) => n.id === id) || null;

  function clipToNode(n, toward) {
    const dx = toward.x - n.x, dy = toward.y - n.y;
    if (!dx && !dy) return { x: n.x, y: n.y };
    const t = Math.min(dx ? (NODE_W / 2) / Math.abs(dx) : Infinity, dy ? (NODE_H / 2) / Math.abs(dy) : Infinity);
    return { x: n.x + dx * t, y: n.y + dy * t };
  }
  function streamGeometry(st) {
    const A = nodeById(st.from), B = nodeById(st.to);
    const a = A ? { x: A.x, y: A.y } : { x: st.fx, y: st.fy };
    const b = B ? { x: B.x, y: B.y } : { x: st.tx, y: st.ty };
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const bow = A && B ? Math.min(50, len * 0.22) : 0; // bow so opposite streams between two units separate
    const c = { x: (a.x + b.x) / 2 - (dy / len) * bow, y: (a.y + b.y) / 2 + (dx / len) * bow };
    const p0 = A ? clipToNode(A, c) : a, p1 = B ? clipToNode(B, c) : b;
    return { p0, p1, c, mid: { x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x, y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y }, A, B };
  }

  let svgEl = null;
  function svgPoint(ev) {
    const m = svgEl.getScreenCTM();
    const x = (ev.clientX - m.e) / m.a, y = (ev.clientY - m.f) / m.d;
    return { x: Math.max(20, Math.min(VIEW_W - 20, x)), y: Math.max(20, Math.min(VIEW_H - 20, y)) };
  }
  function nodeAtPoint(p) {
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      const n = state.nodes[i];
      if (Math.abs(p.x - n.x) <= NODE_W / 2 && Math.abs(p.y - n.y) <= NODE_H / 2) return n;
    }
    return null;
  }

  function drawSheet() {
    if (!svgEl) return;
    const showSizes = state.options.sizes;
    const kids = [s('defs', {},
      s('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 9, markerHeight: 9, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, s('path', { d: 'M0 0L10 5L0 10z' })),
      s('marker', { id: 'arrow-sel', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 12, markerHeight: 12, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, s('path', { d: 'M0 0L10 5L0 10z' })))];
    state.streams.forEach((st, si) => {
      const g = streamGeometry(st);
      const sel = ui.selected === st.id;
      const d = `M${g.p0.x} ${g.p0.y}Q${g.c.x} ${g.c.y} ${g.p1.x} ${g.p1.y}`;
      const grp = s('g', { class: 'stream' + (sel ? ' sel' : ''), 'data-stream': st.id },
        s('path', { class: 'line', d, 'marker-end': `url(#${sel ? 'arrow-sel' : 'arrow'})` }),
        s('path', { class: 'hit', d }),
        s('text', { x: g.mid.x, y: g.mid.y - 6 }, st.name));
      const res = result && !stale && result.streams[si];
      if (res && res.flow) grp.append(s('text', { class: 'val', x: g.mid.x, y: g.mid.y + 9 }, `${fmt(res.flow.value, 4)} ${state.flowUnit}`));
      if (!g.A) grp.append(s('circle', { class: 'handle', cx: g.p0.x, cy: g.p0.y, r: 6, 'data-end': 'from' }));
      if (!g.B) grp.append(s('circle', { class: 'handle', cx: g.p1.x, cy: g.p1.y, r: 3.5, 'data-end': 'to', style: 'opacity:0.01;r:9px' }));
      kids.push(grp);
    });
    state.nodes.forEach((n) => {
      const brk = showSizes && !n.conserveSize;
      kids.push(s('g', { class: 'node' + (brk ? ' break' : '') + (ui.selected === n.id ? ' sel' : ''), 'data-node': n.id },
        s('rect', { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2, width: NODE_W, height: NODE_H, rx: 4 }),
        s('text', { x: n.x, y: n.y + (brk ? -1 : 5) }, n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name),
        brk ? s('text', { class: 'tag', x: n.x, y: n.y + 15 }, 'changes size') : null));
    });
    if (ui.mode === 'stream' && ui.pending && ui.pointer) {
      const a = ui.pending.node ? nodeById(ui.pending.node) : ui.pending;
      kids.push(s('line', { class: 'ghost', x1: a.x, y1: a.y, x2: ui.pointer.x, y2: ui.pointer.y }));
    }
    svgEl.replaceChildren(...kids);
  }

  function sheetPointerDown(ev) {
    const p = svgPoint(ev);
    const nodeEl = ev.target.closest('[data-node]'), streamEl = ev.target.closest('[data-stream]');
    if (ui.mode === 'stream') {
      const hit = nodeEl ? nodeById(nodeEl.dataset.node) : nodeAtPoint(p);
      if (!ui.pending) {
        ui.pending = hit ? { node: hit.id } : { x: p.x, y: p.y };
        ui.pointer = p;
        setSheetHint();
      } else {
        const start = ui.pending;
        if (!start.node && !hit) { setSheetHint('A stream must touch at least one unit. Click a unit to finish, or press Esc to cancel.'); return; }
        if (start.node && hit && start.node === hit.id) { setSheetHint('A stream cannot return to the unit it leaves. Click a different unit or empty space.'); return; }
        const st = { id: uid('s'), name: 'Stream ' + (state.streams.length + 1), from: start.node || null, to: hit ? hit.id : null,
          fx: start.node ? null : start.x, fy: start.node ? null : start.y, tx: hit ? null : p.x, ty: hit ? null : p.y };
        state.streams.push(st);
        normalise(state);
        ui.mode = 'select'; ui.pending = null; ui.selected = st.id;
        changed(); renderFlowsheet();
      }
      drawSheet();
      return;
    }
    if (nodeEl) {
      const n = nodeById(nodeEl.dataset.node);
      ui.selected = n.id;
      ui.drag = { kind: 'node', id: n.id, ox: p.x - n.x, oy: p.y - n.y, moved: false };
    } else if (streamEl) {
      const st = state.streams.find((q) => q.id === streamEl.dataset.stream);
      ui.selected = st.id;
      const end = ev.target.dataset && ev.target.dataset.end;
      if (end) ui.drag = { kind: 'end', id: st.id, end, moved: false };
    } else ui.selected = null;
    if (ui.drag) svgEl.setPointerCapture(ev.pointerId);
    drawSheet(); markSelectedRows();
  }
  function sheetPointerMove(ev) {
    const p = svgPoint(ev);
    if (ui.mode === 'stream' && ui.pending) { ui.pointer = p; drawSheet(); return; }
    const d = ui.drag;
    if (!d) return;
    d.moved = true;
    if (d.kind === 'node') {
      const n = nodeById(d.id);
      n.x = Math.round(Math.max(NODE_W / 2 + 4, Math.min(VIEW_W - NODE_W / 2 - 4, p.x - d.ox)));
      n.y = Math.round(Math.max(NODE_H / 2 + 4, Math.min(VIEW_H - NODE_H / 2 - 4, p.y - d.oy)));
    } else {
      const st = state.streams.find((q) => q.id === d.id);
      if (d.end === 'from') { st.fx = Math.round(p.x); st.fy = Math.round(p.y); } else { st.tx = Math.round(p.x); st.ty = Math.round(p.y); }
    }
    drawSheet();
  }
  function sheetPointerUp(ev) {
    const d = ui.drag;
    ui.drag = null;
    if (!d || !d.moved) return;
    if (d.kind === 'end') {
      // dropping a free end on a unit connects it
      const st = state.streams.find((q) => q.id === d.id);
      const hit = nodeAtPoint(svgPoint(ev));
      const other = d.end === 'from' ? st.to : st.from;
      if (hit && hit.id !== other) {
        if (d.end === 'from') { st.from = hit.id; st.fx = st.fy = null; } else { st.to = hit.id; st.tx = st.ty = null; }
        changed(); renderFlowsheet(); return;
      }
    }
    save(); drawSheet();
  }

  function setSheetHint(msg) {
    const el = $('sheet-hint');
    if (!el) return;
    el.textContent = msg || (ui.mode === 'stream'
      ? (ui.pending ? 'Now click where the stream ends: a unit, or empty space for a product leaving the circuit.' : 'Click where the stream starts: a unit, or empty space for a feed entering the circuit.')
      : 'Drag units to arrange them. Click a unit or stream to select it. Drag the open end of a feed or product onto a unit to connect it.');
  }
  function markSelectedRows() {
    document.querySelectorAll('#tab-flowsheet tr[data-id]').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === ui.selected));
    const del = $('sheet-delete');
    if (del) del.disabled = !ui.selected;
  }
  function deleteSelected() {
    const id = ui.selected;
    if (!id) return;
    const n = nodeById(id);
    if (n) {
      state.nodes = state.nodes.filter((q) => q.id !== id);
      state.streams.forEach((st) => {
        if (st.from === id) { st.from = null; st.fx = n.x; st.fy = n.y; }
        if (st.to === id) { st.to = null; st.tx = n.x; st.ty = n.y; }
      });
      state.streams = state.streams.filter((st) => st.from || st.to);
    } else state.streams = state.streams.filter((st) => st.id !== id);
    ui.selected = null;
    changed(); renderFlowsheet();
  }
  function addNode() {
    const k = state.nodes.length;
    // put the new unit in the emptiest spot of the sheet
    let best = { x: VIEW_W / 2, y: VIEW_H / 2 }, bestD = -1;
    for (let x = 100; x <= VIEW_W - 100; x += 100) for (let y = 60; y <= VIEW_H - 60; y += 60) {
      let d = Infinity;
      state.nodes.forEach((q) => { d = Math.min(d, Math.hypot((q.x - x) / 1.6, q.y - y)); });
      state.streams.forEach((st) => { const g = streamGeometry(st); [g.p0, g.p1, g.mid].forEach((q) => { d = Math.min(d, Math.hypot((q.x - x) / 1.6, q.y - y)); }); });
      if (d > bestD) { bestD = d; best = { x, y }; }
    }
    const n = { id: uid('n'), name: 'Unit ' + (k + 1), conserveSize: true, x: best.x, y: best.y };
    state.nodes.push(n);
    ui.selected = n.id;
    changed(); renderFlowsheet();
    const input = $('node-name-' + n.id);
    if (input) { input.focus(); input.select(); }
  }

  function renderFlowsheet() {
    const sizes = state.options.sizes;
    svgEl = s('svg', { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, role: 'img', 'aria-label': 'Flowsheet diagram. The same network can be edited in the tables below.' });
    svgEl.addEventListener('pointerdown', sheetPointerDown);
    svgEl.addEventListener('pointermove', sheetPointerMove);
    svgEl.addEventListener('pointerup', sheetPointerUp);
    svgEl.addEventListener('pointercancel', () => { ui.drag = null; });

    const streamBtn = h('button', { type: 'button', class: 'btn' + (ui.mode === 'stream' ? ' active' : ''), id: 'sheet-stream', 'aria-pressed': ui.mode === 'stream' ? 'true' : 'false', onclick: () => {
      ui.mode = ui.mode === 'stream' ? 'select' : 'stream'; ui.pending = null; renderFlowsheet();
    } }, ui.mode === 'stream' ? 'Drawing a stream… (Esc to cancel)' : 'Draw stream');

    const nodeRows = state.nodes.map((n) => h('tr', { 'data-id': n.id },
      h('td', {}, h('input', { type: 'text', class: 'name', id: 'node-name-' + n.id, value: n.name, 'aria-label': 'Unit name', onfocus: () => { ui.selected = n.id; drawSheet(); markSelectedRows(); }, onchange: (e) => { n.name = e.target.value; changed(); drawSheet(); renderStreamTable(); } })),
      sizes ? h('td', {}, h('select', { id: 'node-size-' + n.id, 'aria-label': 'Size behaviour of ' + n.name, onchange: (e) => { n.conserveSize = e.target.value === 'keep'; changed(); drawSheet(); } },
        h('option', { value: 'keep', selected: n.conserveSize }, 'Keeps size distribution'),
        h('option', { value: 'break', selected: !n.conserveSize }, 'Changes size (mill, crusher)'))) : null,
      h('td', {}, h('button', { type: 'button', class: 'btn small', onclick: () => { ui.selected = n.id; deleteSelected(); } }, 'Remove'))));

    const tab = $('tab-flowsheet');
    tab.replaceChildren(
      h('div', { class: 'panel' },
        h('header', {}, h('h2', {}, 'Flowsheet'),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn', id: 'sheet-add-node', onclick: addNode }, 'Add unit'),
            streamBtn,
            h('button', { type: 'button', class: 'btn danger', id: 'sheet-delete', disabled: !ui.selected, onclick: deleteSelected }, 'Delete selected'))),
        h('p', { class: 'hint', id: 'sheet-hint', role: 'status' }),
        h('div', { class: 'sheet scroll' }, svgEl),
        sizes ? h('div', { class: 'legend' },
          h('span', {}, h('i', { class: 'swatch' }), 'Keeps size distribution: every size fraction is balanced'),
          h('span', {}, h('i', { class: 'swatch break' }), 'Changes size distribution: only totals are balanced')) : null),
      h('div', { class: 'cols' },
        h('div', { class: 'panel' },
          h('header', {}, h('h2', {}, 'Units (nodes)'), h('button', { type: 'button', class: 'btn small', onclick: addNode }, 'Add unit')),
          state.nodes.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), sizes ? h('th', {}, 'Size behaviour') : null, h('th', {}))), h('tbody', {}, nodeRows)))
            : h('p', { class: 'hint' }, 'No units yet. Add one for each place where streams join or split: mills, cyclones, flotation banks, sumps.')),
        h('div', { class: 'panel', id: 'stream-table-panel' })));
    renderStreamTable();
    setSheetHint();
    drawSheet();
  }

  function renderStreamTable() {
    const panel = $('stream-table-panel');
    if (!panel) return;
    const endSelect = (st, key, outside) => h('select', { id: `stream-${key}-${st.id}`, 'aria-label': `${st.name} ${key}`, onchange: (e) => {
      st[key] = e.target.value || null;
      if (key === 'from') { st.fx = st.fy = null; } else { st.tx = st.ty = null; }
      placeFreeEnds(state); changed(); drawSheet();
    } }, h('option', { value: '', selected: !st[key] }, outside), state.nodes.map((n) => h('option', { value: n.id, selected: st[key] === n.id }, n.name)));
    const rows = state.streams.map((st) => h('tr', { 'data-id': st.id },
      h('td', {}, h('input', { type: 'text', class: 'name', id: 'stream-name-' + st.id, value: st.name, 'aria-label': 'Stream name', onfocus: () => { ui.selected = st.id; drawSheet(); markSelectedRows(); }, onchange: (e) => { st.name = e.target.value; changed(); drawSheet(); } })),
      h('td', {}, endSelect(st, 'from', '— feed (outside) —')),
      h('td', {}, endSelect(st, 'to', '— product (outside) —')),
      h('td', {}, h('button', { type: 'button', class: 'btn small', onclick: () => { ui.selected = st.id; deleteSelected(); } }, 'Remove'))));
    panel.replaceChildren(
      h('header', {}, h('h2', {}, 'Streams'), h('button', { type: 'button', class: 'btn small', id: 'add-stream-row', disabled: !state.nodes.length, onclick: () => {
        const st = { id: uid('s'), name: 'Stream ' + (state.streams.length + 1), from: null, to: state.nodes[0].id };
        state.streams.push(st); normalise(state); ui.selected = st.id; changed(); renderFlowsheet();
      } }, 'Add stream')),
      state.streams.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'From'), h('th', {}, 'To'), h('th', {}))), h('tbody', {}, rows)))
        : h('p', { class: 'hint' }, 'No streams yet. Draw them on the flowsheet or add rows here.'));
    markSelectedRows();
  }

  // ---------- Sample data tab ----------
  function renderData() {
    const o = state.options, st = state.streams;
    const names = st.map((q) => q.name);
    const unit = state.flowUnit || 'flow';
    const root = $('tab-data');
    if (!st.length) { root.replaceChildren(h('div', { class: 'panel' }, h('p', { class: 'hint' }, 'Add streams on the Flowsheet tab first.'))); return; }
    const useSA = o.sizeAssays && o.sizes, useComps = o.assays || useSA;

    const cols = [{ key: 'flow', label: `Solids flow, ${unit}` }, { key: 'errFlow', label: 'Flow error, %' }];
    if (o.sizes) cols.push({ key: 'errSize', label: 'Size error, %' });
    if (o.assays) cols.push({ key: 'errAssay', label: 'Assay error, %' });
    if (useSA) cols.push({ key: 'errSizeAssay', label: 'Size-fraction assay error, %' });
    const panels = [h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Flows and estimated relative errors')),
      h('p', { class: 'hint' }, 'Leave a flow blank if it was not measured; at least one is needed to set the scale. Relative errors are one standard deviation, as a percentage of the measured value, and apply to every measurement of that kind on the stream. You can paste blocks of cells from a spreadsheet into any table.'),
      grid('main', cols.map((c) => c.label), names, (r, c) => st[r][cols[c].key], (r, c, v) => { st[r][cols[c].key] = v; }))];

    if (o.sizes) panels.push(h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Particle size distribution'), h('span', { class: 'hint' }, 'mass % retained in each fraction')),
      grid('psd', state.bins.map((b) => b.label), names, (r, c) => st[r].psd[c], (r, c, v) => { st[r].psd[c] = v; }, { sum: true })));
    if (o.assays) panels.push(h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Head assays')),
      grid('assay', state.comps.map((c) => `${c.name}, ${c.unit}`), names, (r, c) => st[r].assay[c], (r, c, v) => { st[r].assay[c] = v; })));
    if (useSA) state.comps.forEach((comp, k) => panels.push(h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, `${comp.name} assay of each size fraction`), h('span', { class: 'hint' }, comp.unit)),
      grid('sa' + k, state.bins.map((b) => b.label), names, (r, c) => st[r].sizeAssay[c][k], (r, c, v) => { st[r].sizeAssay[c][k] = v; }))));
    if (!useComps && !o.sizes) panels.push(h('p', { class: 'hint' }, 'Only solids flows are being balanced. Switch on size or assay data on the Setup tab.'));
    root.replaceChildren(...panels);
  }

  // ---------- Results tab ----------
  function flag(z) { const a = Math.abs(z); return a >= 3 ? 'crit' : a >= 2 ? 'warn' : ''; }
  function resCell(c) {
    if (!c) return h('td', {});
    if (!c.observable) return h('td', { title: 'Not determined by the data entered' }, h('span', { class: 'v' }, 'n.d.'));
    const [v, sd] = fmtPair(c.value, c.sd);
    const td = h('td', { class: c.z != null ? flag(c.z) : '' },
      h('span', { class: 'v' }, v), h('span', { class: 'sd' }, '± ' + sd),
      h('span', { class: 'm' }, c.measured != null ? `meas. ${fmt(c.measured, 4)}` : 'not meas.'));
    if (c.z != null) td.title = `Adjusted by ${c.z >= 0 ? '+' : ''}${c.z.toFixed(2)} standard deviations (measurement error ${fmt(c.sigma, 3)})`;
    return td;
  }
  function resTable(colLabels, cellAt) {
    return h('div', { class: 'scroll' }, h('table', { class: 'res' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Stream'), colLabels.map((c) => h('th', { class: 'num' }, c)))),
      h('tbody', {}, state.streams.map((st, r) => h('tr', {}, h('th', {}, st.name), colLabels.map((_, c) => resCell(cellAt(r, c))))))));
  }
  function resultRows() {
    const rows = [];
    result.streams.forEach((rs, si) => {
      const name = state.streams[si].name;
      const push = (qty, bin, comp, c) => { if (c) rows.push({ stream: name, qty, bin, comp, c }); };
      push(`Solids flow (${state.flowUnit})`, '', '', rs.flow);
      rs.psd.forEach((c, i) => push('Size distribution (mass %)', state.bins[i].label, '', c));
      rs.assay.forEach((c, k) => push('Head assay', '', `${state.comps[k].name} (${state.comps[k].unit})`, c));
      rs.sizeAssay.forEach((row, i) => row.forEach((c, k) => push('Size-fraction assay', state.bins[i].label, `${state.comps[k].name} (${state.comps[k].unit})`, c)));
    });
    return rows;
  }
  function resultsText(sep) {
    const q = (v) => (sep === ',' && /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const n = (v) => (v == null ? '' : String(Number(v.toPrecision(7))));
    const lines = [['Stream', 'Quantity', 'Size fraction', 'Component', 'Measured', 'Measurement SD', 'Reconciled', 'Reconciled SD', 'Adjustment (SDs)']];
    resultRows().forEach((r) => lines.push([r.stream, r.qty, r.bin, r.comp, n(r.c.measured), n(r.c.sigma), r.c.observable ? n(r.c.value) : 'n.d.', n(r.c.sd), r.c.z == null ? '' : r.c.z.toFixed(3)]));
    return lines.map((l) => l.map(q).join(sep)).join('\n');
  }
  function copyText(text, statusEl, okMsg) {
    const fallback = () => {
      const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' });
      ta.value = text; document.body.append(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      statusEl.textContent = ok ? okMsg : 'Copying is blocked here. Use Download, or select the text and copy it by hand.';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => { statusEl.textContent = okMsg; }, fallback);
    else fallback();
  }
  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function renderResults() {
    const root = $('tab-results');
    if (!result) {
      root.replaceChildren(h('div', { class: 'panel' },
        h('h2', {}, 'No results yet'),
        h('p', { class: 'hint' }, 'Press Reconcile to balance the circuit with the current network and sample data.'),
        h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: run }, 'Reconcile'))));
      return;
    }
    const R = result;
    const ratio = R.dof > 0 ? R.chi2 / R.dof : null;
    const fit = ratio == null ? '' : ratio > 3 ? 'crit' : ratio > 1.6 ? 'warn' : 'good';
    const verdict = ratio == null ? 'No redundant measurements, so the fit cannot be judged.'
      : ratio > 3 ? 'Adjustments are much larger than the stated errors. Look for a bad sample among the flagged cells, or raise the error estimates.'
      : ratio > 1.6 ? 'Adjustments are somewhat larger than the stated errors allow. Check the flagged cells.'
      : ratio < 0.4 ? 'Adjustments are well inside the stated errors; the error estimates may be pessimistic.'
      : 'Adjustments are consistent with the stated errors.';
    const stat = (label, value, cls) => h('div', { class: 'stat ' + (cls || '') }, h('b', {}, value), h('span', {}, label));
    const status = h('span', { class: 'hint', role: 'status' });
    const panels = [];
    if (stale) panels.push(h('div', { class: 'banner' }, 'Inputs have changed since these results were calculated. ', h('button', { type: 'button', class: 'btn small primary', onclick: run }, 'Reconcile again')));
    panels.push(h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Fit summary'),
        h('div', { class: 'row' }, status,
          h('button', { type: 'button', class: 'btn small', id: 'res-copy', onclick: () => copyText(resultsText('\t'), status, 'Copied. Paste into a spreadsheet.') }, 'Copy table'),
          h('button', { type: 'button', class: 'btn small', id: 'res-csv', onclick: () => download('mass-balance-results.csv', resultsText(','), 'text/csv') }, 'Download CSV'))),
      h('div', { class: 'stats' },
        stat('Weighted sum of squares', fmt(R.chi2, 4)),
        stat('Redundancy (degrees of freedom)', String(R.dof)),
        stat('Sum of squares ÷ redundancy', ratio == null ? '–' : ratio.toFixed(2), fit),
        stat('Measurements', String(R.nMeas)),
        stat('Independent unknowns', String(R.nUnknowns)),
        stat('Balance equations', String(R.nBalances))),
      h('p', { class: 'hint' }, verdict),
      R.warnings.length ? h('ul', { class: 'notes' }, R.warnings.map((w) => h('li', {}, w))) : null,
      h('p', { class: 'legend' }, 'Each cell: reconciled value, ± its standard deviation, and the measurement.',
        h('span', {}, h('span', { class: 'chip warn' }, '2–3 SD'), ' adjusted by 2 to 3 measurement standard deviations'),
        h('span', {}, h('span', { class: 'chip crit' }, '> 3 SD'), ' adjusted by more than 3'))));

    const worst = resultRows().filter((r) => r.c.z != null).sort((a, b) => Math.abs(b.c.z) - Math.abs(a.c.z)).slice(0, 6).filter((r) => Math.abs(r.c.z) >= 1.5);
    if (worst.length) panels.push(h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, 'Largest adjustments')),
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Stream', 'Quantity', 'Size fraction', 'Component'].map((t) => h('th', {}, t)), ['Measured', 'Reconciled', 'Adjustment'].map((t) => h('th', { class: 'num' }, t)))),
        h('tbody', {}, worst.map((r) => h('tr', {}, h('th', {}, r.stream), h('td', {}, r.qty), h('td', {}, r.bin), h('td', {}, r.comp),
          h('td', { class: 'num' }, fmt(r.c.measured, 4)), h('td', { class: 'num' }, fmt(r.c.value, 4)),
          h('td', { class: 'num ' + flag(r.c.z) }, `${r.c.z >= 0 ? '+' : ''}${r.c.z.toFixed(2)} SD`))))))));

    const sameShape = R.streams.length === state.streams.length && (!R.useSizes || R.nb === state.bins.length) && (!R.nk || R.nk === state.comps.length);
    if (!sameShape) {
      panels.push(h('div', { class: 'panel' }, h('p', { class: 'hint' }, 'The network or setup has changed shape since this run. Reconcile again to see the tables.')));
      root.replaceChildren(...panels);
      return;
    }
    panels.push(h('div', { class: 'panel' }, h('header', {}, h('h2', {}, 'Solids flow'), h('span', { class: 'hint' }, state.flowUnit)),
      resTable(['Flow'], (r) => R.streams[r].flow)));
    if (R.useSizes) panels.push(h('div', { class: 'panel' }, h('header', {}, h('h2', {}, 'Particle size distribution'), h('span', { class: 'hint' }, 'mass % retained')),
      resTable(state.bins.map((b) => b.label), (r, c) => R.streams[r].psd[c])));
    if (R.nk) panels.push(h('div', { class: 'panel' }, h('header', {}, h('h2', {}, R.useAssays ? 'Head assays' : 'Head assays (calculated from size fractions)')),
      resTable(state.comps.map((c) => `${c.name}, ${c.unit}`), (r, c) => R.streams[r].assay[c])));
    if (R.useSizeAssays) state.comps.forEach((comp, k) => panels.push(h('div', { class: 'panel' },
      h('header', {}, h('h2', {}, `${comp.name} assay of each size fraction`), h('span', { class: 'hint' }, comp.unit)),
      resTable(state.bins.map((b) => b.label), (r, c) => (R.streams[r].sizeAssay[c] || [])[k]))));
    root.replaceChildren(...panels);
  }

  function run() {
    const btn = $('btn-run');
    btn.disabled = true; btn.textContent = 'Reconciling…';
    setTimeout(() => {
      let res;
      try { res = window.MassBalance.reconcile(state); } catch (e) { res = { ok: false, errors: ['Unexpected error: ' + e.message], warnings: [] }; }
      btn.disabled = false; btn.textContent = 'Reconcile';
      if (res.ok) { result = res; stale = false; runErrors = null; show('results'); }
      else { runErrors = res.errors; renderChrome(); $('banner').scrollIntoView({ block: 'nearest' }); }
    }, 30);
  }

  // ---------- project dialog ----------
  function openDialog() {
    $('project-text').value = JSON.stringify(state, null, 1);
    $('dialog-msg').textContent = '';
    $('dialog').hidden = false;
    $('project-text').focus();
  }
  function replaceProject(p, msg) {
    state = normalise(p);
    result = null; stale = false; runErrors = null; ui.selected = null; ui.mode = 'select'; ui.pending = null;
    save();
    $('project-text').value = JSON.stringify(state, null, 1);
    $('dialog-msg').textContent = msg;
    render();
  }
  function loadText(text) {
    let p;
    try { p = JSON.parse(text); } catch (e) { $('dialog-msg').textContent = 'That text is not valid JSON: ' + e.message; return; }
    if (!p || typeof p !== 'object' || !Array.isArray(p.nodes) || !Array.isArray(p.streams)) { $('dialog-msg').textContent = 'That JSON is not a mass balance project (it needs "nodes" and "streams").'; return; }
    replaceProject(p, 'Project loaded.');
  }

  // ---------- wiring ----------
  function init() {
    state = load();
    try { const t = localStorage.getItem(STORE_KEY + '-tab'); if (t && $('tab-' + t)) tab = t; } catch (e) { /* ignore */ }
    if (tab === 'results') tab = 'flowsheet';
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('btn-run').addEventListener('click', run);
    $('btn-project').addEventListener('click', openDialog);
    $('dialog-close').addEventListener('click', () => { $('dialog').hidden = true; });
    $('dialog').addEventListener('pointerdown', (e) => { if (e.target === $('dialog')) $('dialog').hidden = true; });
    $('project-copy').addEventListener('click', () => copyText($('project-text').value, $('dialog-msg'), 'Project copied.'));
    $('project-download').addEventListener('click', () => download('mass-balance-project.json', $('project-text').value, 'application/json'));
    $('project-apply').addEventListener('click', () => loadText($('project-text').value));
    $('project-file').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => loadText(String(rd.result));
      rd.readAsText(f);
      e.target.value = '';
    });
    $('project-example').addEventListener('click', () => replaceProject(clone(window.MB_EXAMPLE), 'Example circuit loaded.'));
    $('project-blank').addEventListener('click', () => replaceProject(blankProject(), 'Blank project started.'));
    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape') {
        if (!$('dialog').hidden) $('dialog').hidden = true;
        else if (ui.mode === 'stream') { ui.mode = 'select'; ui.pending = null; if (tab === 'flowsheet') renderFlowsheet(); }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && tab === 'flowsheet' && ui.selected) { e.preventDefault(); deleteSelected(); }
    });
    render();
  }
  init();
})();
