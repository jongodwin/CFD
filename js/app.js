/* Rotary Kiln Simulator - user interface. */
(function () {
  'use strict';
  const KM = window.KilnModel, KP = window.KilnPresets, LineChart = window.KilnCharts.LineChart;
  const $ = id => document.getElementById(id);
  const STORE_KEY = 'rotary-kiln-simulator-case-v1';
  const RU = 8.314462618;
  const embedded = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const DEFAULTS = KP.clone(KP.PRESETS[0].data);
  function fillDefaults(target, def) {
    for (const k in def) {
      if (target[k] === undefined || target[k] === null) target[k] = KP.clone(def[k]);
      else if (typeof def[k] === 'object' && !Array.isArray(def[k]) && typeof target[k] === 'object') fillDefaults(target[k], def[k]);
    }
    return target;
  }
  function normalise(c) {
    c = fillDefaults(c || {}, DEFAULTS);
    c.species = (c.species || []).map(s => ({ name: String(s.name || ''), phase: s.phase === 'gas' ? 'gas' : 'solid', mw: +s.mw || 0, cp: (s.cp || [0, 0, 0, 0, 0]).concat([0, 0, 0, 0, 0]).slice(0, 5).map(Number) }));
    c.reactions = (c.reactions || []).map(r => Object.assign({ name: '', equation: '', key: '', order: 1, A: 0, Ea: 0, dH: 0, enabled: true }, r));
    c.solids.composition = c.solids.composition || {};
    c.gas.inlet.composition = c.gas.inlet.composition || {};
    return c;
  }
  function loadStored() {
    try { const s = localStorage.getItem(STORE_KEY); return s ? normalise(JSON.parse(s)) : null; } catch (e) { return null; }
  }
  let saveTimer = 0;
  function store() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ } }, 300);
  }
  let state = loadStored() || normalise(KP.clone(KP.PRESETS[0].data));
  let edited = !!state._edited;

  const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
  function set(path, v) {
    const ks = path.split('.');
    let o = state;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null) o[ks[i]] = {}; o = o[ks[i]]; }
    o[ks[ks.length - 1]] = v;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => { if (c != null && c !== false) e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); });
    return e;
  }
  let idSeq = 0;
  const nid = p => p + '-' + (++idSeq);
  const fmt = (v, d) => {
    if (!Number.isFinite(v)) return '–';
    if (Math.abs(v) < 0.5 * Math.pow(10, -d)) v = 0;   // no "−0.000"
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }).replace('-', '−');
  };
  const C = K => K - 273.15;
  const sci = v => {
    if (!Number.isFinite(v)) return '–';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 0.01 && a < 1e5) return fmt(v, a < 1 ? 3 : a < 100 ? 2 : 0);
    const e = Math.floor(Math.log10(a)), m = v / Math.pow(10, e);
    return m.toFixed(2) + '×10' + String(e).replace('-', '⁻').replace(/\d/g, d => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]);
  };

  // ---------------------------------------------------------------------------
  // Change handling and running
  // ---------------------------------------------------------------------------
  let runTimer = 0;
  function changed(opts) {
    edited = true;
    state._edited = true;
    store();
    updateCaseName();
    if (opts && opts.rebuild) rebuildPane(opts.rebuild);
    drawSchematic(lastResult && !lastStale ? lastResult : null);
    lastStale = true;
    if ($('autoRun').checked) {
      setStatus('busy', 'Waiting for edits to finish…');
      clearTimeout(runTimer);
      runTimer = setTimeout(run, 650);
    } else setStatus('stale', 'Inputs changed — press Run');
  }
  function setStatus(kind, text) {
    $('status').dataset.state = kind;
    $('statusText').textContent = text;
  }
  function updateCaseName() {
    $('caseName').textContent = (state.name || 'Custom case') + (edited ? ' (edited)' : '');
  }

  let worker = null, workerBroken = false, runSeq = 0, lastResult = null, lastStale = true;
  function makeWorker() {
    if (workerBroken || typeof Worker === 'undefined' || !KM.factorySource) return null;
    try {
      const code = 'self.KilnModel=' + KM.factorySource + '();' +
        'self.onmessage=function(e){var id=e.data.id;try{var last=0;var r=self.KilnModel.solve(e.data.input,{onProgress:function(p){var t=Date.now();if(t-last>120){last=t;self.postMessage({id:id,type:"progress",p:p});}}});' +
        'self.postMessage({id:id,type:"result",r:r});}catch(err){self.postMessage({id:id,type:"error",message:String(err&&err.message||err)});}};';
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const w = new Worker(url);
      w.onerror = () => { workerBroken = true; try { w.terminate(); } catch (e) { /* ignore */ } worker = null; run(); };
      return w;
    } catch (e) { workerBroken = true; return null; }
  }
  function run() {
    clearTimeout(runTimer);
    const id = ++runSeq;
    const input = JSON.parse(JSON.stringify(state));
    setStatus('busy', 'Solving…');
    $('runBtn').disabled = true;
    if (worker) { worker.terminate(); worker = null; }
    worker = makeWorker();
    if (worker) {
      worker.onmessage = e => {
        if (e.data.id !== runSeq) return;
        if (e.data.type === 'progress') setStatus('busy', 'Solving… step ' + e.data.p.step + ', residual ' + e.data.p.residual.toExponential(1));
        else if (e.data.type === 'result') finish(e.data.r);
        else finish({ ok: false, errors: ['The solver stopped unexpectedly: ' + e.data.message], warnings: [] });
      };
      worker.postMessage({ id, input });
    } else {
      setTimeout(() => {
        if (id !== runSeq) return;
        let r;
        try { r = KM.solve(input); } catch (err) { r = { ok: false, errors: ['The solver stopped unexpectedly: ' + err.message], warnings: [] }; }
        finish(r);
      }, 30);
    }
  }
  function finish(r) {
    $('runBtn').disabled = false;
    if (!r.ok) {
      setStatus('error', 'Check the inputs');
      showMessages(r);
      return;
    }
    lastResult = r; lastStale = false;
    const t = r.elapsedMs < 1000 ? Math.max(r.elapsedMs, 1) + ' ms' : (r.elapsedMs / 1000).toFixed(1) + ' s';
    if (r.converged) setStatus(r.warnings.length ? 'warn' : 'ok', 'Solved in ' + t + (r.warnings.length ? ' · see notes' : ''));
    else setStatus('warn', 'Not fully converged (' + t + ')');
    renderResults(r);
  }

  // ---------------------------------------------------------------------------
  // Input fields
  // ---------------------------------------------------------------------------
  function numField(path, label, unit, o) {
    o = o || {};
    const id = nid('f');
    const inp = h('input', { id, type: 'number', inputmode: 'decimal', step: o.step || 'any', min: o.min, max: o.max, value: get(path) });
    const box = h('div', { class: 'inp' }, inp, unit ? h('span', { class: 'u', text: unit }) : null);
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      const bad = !Number.isFinite(v) || (o.min !== undefined && v < o.min) || (o.max !== undefined && v > o.max);
      box.classList.toggle('invalid', bad);
      if (bad) return;
      set(path, v);
      changed(o.rebuild ? { rebuild: o.rebuild } : null);
    });
    return h('div', { class: 'field' }, h('label', { for: id }, label, o.hint ? h('small', { text: o.hint }) : null), box);
  }
  function selectField(path, label, options, o) {
    o = o || {};
    const id = nid('f');
    const sel = h('select', { id }, options.map(([v, t]) => h('option', { value: v, selected: String(get(path)) === String(v) }, t)));
    sel.addEventListener('change', () => {
      const v = o.numeric ? Number(sel.value) : sel.value;
      set(path, v);
      changed(o.rebuild ? { rebuild: o.rebuild } : null);
    });
    return h('div', { class: 'field' + (o.wide ? ' wide' : '') }, h('label', { for: id }, label, o.hint ? h('small', { text: o.hint }) : null), h('div', { class: 'inp' }, sel));
  }
  function segField(path, label, options, o) {
    o = o || {};
    const lid = nid('l');
    const seg = h('div', { class: 'seg', role: 'group', 'aria-labelledby': lid });
    options.forEach(([v, t]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(get(path) === v), text: t });
      b.addEventListener('click', () => {
        if (get(path) === v) return;
        set(path, v);
        seg.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        changed(o.rebuild ? { rebuild: o.rebuild } : null);
      });
      seg.appendChild(b);
    });
    return h('div', { class: 'field' + (o.wide ? ' wide' : '') }, h('label', { id: lid, text: label }), seg);
  }
  function checkField(path, label, o) {
    o = o || {};
    const id = nid('f');
    const cb = h('input', { id, type: 'checkbox', checked: !!get(path) });
    cb.addEventListener('change', () => { set(path, cb.checked); changed(o.rebuild ? { rebuild: o.rebuild } : null); });
    return h('div', { class: 'field wide' }, h('label', { for: id, class: 'toggle', style: { color: 'var(--ink)', fontSize: '13px' } }, cb, label));
  }
  const fs = (title, ...kids) => h('fieldset', null, h('legend', { text: title }), ...kids);
  const hint = t => h('p', { class: 'hint', text: t });

  // ---------------------------------------------------------------------------
  // Panes
  // ---------------------------------------------------------------------------
  const TABS = [
    { id: 'kiln', label: 'Kiln', build: paneKiln },
    { id: 'feed', label: 'Feed', build: paneFeed },
    { id: 'gas', label: 'Gas', build: paneGas },
    { id: 'burner', label: 'Burner', build: paneBurner },
    { id: 'heat', label: 'Heat transfer', build: paneHeat },
    { id: 'rx', label: 'Reactions', build: paneReactions }
  ];
  let activeTab = 'kiln';
  try { activeTab = localStorage.getItem(STORE_KEY + '-tab') || 'kiln'; } catch (e) { /* ignore */ }
  if (!TABS.some(t => t.id === activeTab)) activeTab = 'kiln';

  function buildTabs() {
    const tabs = $('tabs'), panes = $('panes');
    tabs.textContent = ''; panes.textContent = '';
    TABS.forEach(t => {
      const b = h('button', { type: 'button', class: 'tab', role: 'tab', id: 'tab-' + t.id, 'aria-controls': 'pane-' + t.id, 'aria-selected': String(t.id === activeTab), text: t.label });
      b.addEventListener('click', () => selectTab(t.id));
      b.addEventListener('keydown', e => {
        const i = TABS.findIndex(x => x.id === t.id);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const n = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
          selectTab(n.id); $('tab-' + n.id).focus();
        }
      });
      tabs.appendChild(b);
      const p = h('div', { class: 'pane', role: 'tabpanel', id: 'pane-' + t.id, 'aria-labelledby': 'tab-' + t.id, hidden: t.id !== activeTab });
      panes.appendChild(p);
      t.build(p);
    });
  }
  function selectTab(id) {
    activeTab = id;
    try { localStorage.setItem(STORE_KEY + '-tab', id); } catch (e) { /* ignore */ }
    TABS.forEach(t => {
      $('tab-' + t.id).setAttribute('aria-selected', String(t.id === id));
      $('pane-' + t.id).hidden = t.id !== id;
    });
  }
  function rebuildPane(id) {
    const ids = id === 'all' ? TABS.map(t => t.id) : [].concat(id);
    ids.forEach(pid => {
      const t = TABS.find(x => x.id === pid);
      const p = $('pane-' + pid);
      if (!t || !p) return;
      const scroll = $('panes').scrollTop;
      p.textContent = '';
      t.build(p);
      $('panes').scrollTop = scroll;
    });
  }

  function paneKiln(p) {
    const kr = get('kiln.bedModel') === 'kramers';
    p.append(
      fs('Geometry and drive',
        numField('kiln.length', 'Length', 'm', { min: 0.1 }),
        numField('kiln.diameter', 'Internal diameter', 'm', { min: 0.05, hint: 'Inside the lining' }),
        numField('kiln.slope', 'Slope', '%', { min: 0 }),
        numField('kiln.rpm', 'Rotation speed', 'rpm', { min: 0.01 })),
      fs('Bed depth',
        segField('kiln.bedModel', 'Bed depth model', [['kramers', 'Kramers equation'], ['fill', 'Fixed fill']], { rebuild: 'kiln', wide: true }),
        kr ? numField('kiln.repose', 'Dynamic angle of repose', '°', { min: 1, max: 80 }) : null,
        kr ? numField('kiln.damHeight', 'Discharge dam height', 'm', { min: 0, hint: '0 for an open discharge' }) : null,
        kr ? null : numField('kiln.fill', 'Fill fraction', '%', { min: 0.1, max: 60 }),
        numField('kiln.cells', 'Axial cells', '', { min: 10, max: 2000, step: 10, hint: 'More cells: finer profiles, slower solve' })),
      fs('Wall lining', hint('Layers from the hot face outward. Conduction is radial and steady.'), layersTable()),
      fs('Shell and surroundings',
        numField('wall.shellEmissivity', 'Shell emissivity', '', { min: 0, max: 1 }),
        numField('wall.ambientT', 'Ambient temperature', '°C'),
        segField('wall.extMode', 'Shell convection', [['correlation', 'Natural + wind'], ['constant', 'Fixed coefficient']], { rebuild: 'kiln', wide: true }),
        get('wall.extMode') === 'constant' ? numField('wall.hExt', 'Convection coefficient', 'W/(m²·K)', { min: 0 })
          : numField('wall.wind', 'Wind speed across the shell', 'm/s', { min: 0 }))
    );
  }
  function layersTable() {
    const layers = state.wall.layers;
    const tb = h('tbody');
    layers.forEach((l, i) => {
      const nameIn = h('input', { class: 'name', value: l.name, 'aria-label': 'Layer name' });
      nameIn.addEventListener('input', () => { l.name = nameIn.value; store(); });
      const tIn = h('input', { type: 'number', step: 'any', min: 0, value: +(l.thickness * 1000).toFixed(3), 'aria-label': 'Thickness in mm' });
      tIn.addEventListener('input', () => { const v = parseFloat(tIn.value); if (v > 0) { l.thickness = v / 1000; changed(); } });
      const kIn = h('input', { type: 'number', step: 'any', min: 0, value: l.k, 'aria-label': 'Thermal conductivity' });
      kIn.addEventListener('input', () => { const v = parseFloat(kIn.value); if (v > 0) { l.k = v; changed(); } });
      const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove layer ' + l.name, text: '✕' });
      del.addEventListener('click', () => { layers.splice(i, 1); changed({ rebuild: 'kiln' }); });
      tb.appendChild(h('tr', null, h('td', null, nameIn), h('td', null, tIn), h('td', null, kIn), h('td', null, layers.length > 1 ? del : null)));
    });
    const total = layers.reduce((a, l) => a + l.thickness, 0);
    const add = h('button', { type: 'button', class: 'btn small', text: 'Add layer' });
    add.addEventListener('click', () => { layers.push({ name: 'New layer', thickness: 0.05, k: 1 }); changed({ rebuild: 'kiln' }); });
    return h('div', null,
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'edit' },
        h('thead', null, h('tr', null, h('th', { text: 'Layer' }), h('th', { text: 'Thickness, mm' }), h('th', { text: 'k, W/(m·K)' }), h('th', { text: '' }))),
        tb,
        h('tfoot', null, h('tr', null, h('td', { colspan: 4, text: 'Total ' + fmt(total * 1000, 0) + ' mm · shell outer diameter ' + fmt((get('kiln.diameter') || 0) + 2 * total, 2) + ' m' }))))),
      h('div', { class: 'row-actions' }, add));
  }

  function paneFeed(p) {
    p.append(
      fs('Solids feed',
        numField('solids.feedRate', 'Feed rate', 't/h', { min: 0 }),
        numField('solids.feedT', 'Feed temperature', '°C'),
        numField('solids.bulkDensity', 'Bulk density', 'kg/m³', { min: 1 })),
      fs('Solid species and feed composition',
        hint('Heat capacity: cp = A + B·t + C·t² + D·t³ + E/t² in J/(mol·K), with t = T/1000 K. Set B to E to zero for a constant cp.'),
        speciesTable('solid'))
    );
  }
  function paneGas(p) {
    const counter = get('gas.direction') !== 'co';
    p.append(
      fs('Gas flow',
        segField('gas.direction', 'Gas direction relative to solids', [['counter', 'Counter-current'], ['co', 'Co-current']], { rebuild: ['gas', 'burner'], wide: true }),
        hint(counter ? 'Gas enters at the discharge end and leaves at the feed end.' : 'Gas enters at the feed end and leaves with the product at the discharge end.'),
        numField('gas.pressure', 'Kiln pressure', 'kPa', { min: 1 })),
      fs('Hot gas inlet',
        hint('A hot gas stream entering at the ' + (counter ? 'discharge' : 'feed') + ' end, for example flue gas from an external furnace. Set the flow to 0 if the burner supplies all the gas.'),
        numField('gas.inlet.flow', 'Flow', 'Nm³/h', { min: 0 }),
        numField('gas.inlet.T', 'Temperature', '°C')),
      fs('Gas species and inlet composition', speciesTable('gas'))
    );
  }
  function paneBurner(p) {
    const on = !!get('burner.enabled');
    const counter = get('gas.direction') !== 'co';
    const gasNames = state.species.filter(s => s.phase === 'gas').map(s => s.name);
    const kids = [checkField('burner.enabled', 'Burner fitted at the ' + (counter ? 'discharge' : 'feed') + ' end', { rebuild: 'burner' })];
    if (on) {
      kids.push(
        fs('Fuel',
          selectField('burner.fuel', 'Fuel species', gasNames.map(n => [n, n]), { hint: 'Named by formula, e.g. CH4' }),
          numField('burner.lhv', 'Lower heating value', 'MJ/kg', { min: 0.1 }),
          numField('burner.firing', 'Firing rate (LHV)', 'MW', { min: 0 }),
          numField('burner.fuelT', 'Fuel temperature', '°C')),
        fs('Combustion air',
          numField('burner.excessAir', 'Excess air', '%'),
          numField('burner.airT', 'Air temperature', '°C', { hint: 'Secondary air is often preheated in the cooler' }),
          h('p', { class: 'hint', id: 'burnerInfo', text: burnerInfo() })),
        fs('Flame',
          numField('burner.flameLength', 'Flame length', 'm', { min: 0.1 }),
          numField('burner.flameEmissivity', 'Flame emissivity', '', { min: 0, max: 1, hint: 'Luminous flame, used inside the flame zone' }),
          selectField('burner.profile', 'Heat release along the flame', [['uniform', 'Uniform'], ['bell', 'Bell, peaks mid-flame'], ['front', 'Front-loaded, near the burner']]))
      );
    } else kids.push(hint('With no burner, heat comes from the hot gas inlet (Gas tab) and any exothermic reactions.'));
    p.append(...kids);
  }
  function burnerInfo() {
    const f = KM.parseFormula(get('burner.fuel'));
    if (!f) return 'The fuel species name must be a chemical formula so the combustion air can be calculated.';
    const el = f.elements;
    const o2 = (el.C || 0) + (el.H || 0) / 4 + (el.S || 0) - (el.O || 0) / 2;
    const mol = get('burner.firing') * 1e6 / (get('burner.lhv') * 1e6 * f.mw / 1000);
    const air = mol * o2 * (1 + get('burner.excessAir') / 100) / 0.21;
    return 'Fuel ' + fmt(mol * f.mw / 1000 * 3600, 0) + ' kg/h · combustion air ' + fmt(air / KM.NM3_MOL * 3600, 0) + ' Nm³/h';
  }
  function paneHeat(p) {
    const conv = get('heatTransfer.convModel'), ws = get('heatTransfer.wallSolidModel');
    p.append(
      fs('Radiation',
        numField('gas.emissivity', 'Gas emissivity', '', { min: 0, max: 0.999, hint: 'Non-luminous gas outside the flame' }),
        numField('wall.emissivity', 'Inner wall emissivity', '', { min: 0.01, max: 1 }),
        numField('solids.emissivity', 'Bed surface emissivity', '', { min: 0.01, max: 1 })),
      fs('Convection from the gas',
        selectField('heatTransfer.convModel', 'Coefficients', [['tw', 'Tscheng & Watkinson (rotary kiln)'], ['db', 'Pipe flow (Dittus–Boelter)'], ['const', 'Fixed values']], { rebuild: 'heat', wide: true }),
        conv === 'const' ? numField('heatTransfer.hgw', 'Gas to wall', 'W/(m²·K)', { min: 0 }) : null,
        conv === 'const' ? numField('heatTransfer.hgs', 'Gas to bed', 'W/(m²·K)', { min: 0 }) : null,
        numField('heatTransfer.convMult', 'Multiplier', '×', { min: 0 })),
      fs('Covered wall to bed',
        segField('heatTransfer.wallSolidModel', 'Contact model', [['penetration', 'Penetration theory'], ['const', 'Fixed value']], { rebuild: 'heat', wide: true }),
        ws === 'const' ? numField('heatTransfer.hws', 'Wall to bed coefficient', 'W/(m²·K)', { min: 0 })
          : numField('solids.bedConductivity', 'Bed thermal conductivity', 'W/(m·K)', { min: 0.001 }),
        ws === 'const' ? null : numField('heatTransfer.hContact', 'Wall contact coefficient', 'W/(m²·K)', { min: 1, hint: 'Gas-film resistance at the wall, in series' })),
      fs('Chains or lifters',
        hint('Extra gas–solids heat transfer where chains or flights shower the bed through the gas. Set to 0 for a plain kiln.'),
        numField('heatTransfer.lifterUa', 'Volumetric coefficient', 'W/(m³·K)', { min: 0 }),
        numField('heatTransfer.lifterStart', 'Zone starts at', 'm', { min: 0, hint: 'Distance from the feed end' }),
        numField('heatTransfer.lifterEnd', 'Zone ends at', 'm', { min: 0 }))
    );
  }

  // ---- species tables ----
  function speciesTable(phase) {
    const list = state.species.filter(s => s.phase === phase);
    const compPath = phase === 'solid' ? 'solids.composition' : 'gas.inlet.composition';
    const comp = get(compPath);
    const tb = h('tbody');
    const sumCell = h('td', { colspan: 11 });
    const updateSum = () => {
      const sum = list.reduce((a, s) => a + (+comp[s.name] || 0), 0);
      sumCell.textContent = '';
      sumCell.append('Total ' + fmt(sum, 2) + ' ' + (phase === 'solid' ? 'wt %' : 'mol %') + ' ');
      if (Math.abs(sum - 100) > 0.005 && sum > 0) {
        sumCell.append(h('span', { class: 'sum-bad', text: '(normalised when solved) ' }));
        const nb = h('button', { type: 'button', class: 'btn small', text: 'Scale to 100 %' });
        nb.addEventListener('click', () => {
          list.forEach(s => { comp[s.name] = +((+comp[s.name] || 0) * 100 / sum).toFixed(4); });
          changed({ rebuild: phase === 'solid' ? 'feed' : 'gas' });
        });
        sumCell.append(nb);
      } else if (sum > 0) sumCell.append(h('span', { class: 'sum-ok', text: '✓' }));
    };
    list.forEach(s => {
      const nameIn = h('input', { class: 'name', value: s.name, 'aria-label': 'Species name' });
      nameIn.addEventListener('change', () => {
        const nv = nameIn.value.trim();
        if (!nv || nv === s.name) { nameIn.value = s.name; return; }
        if (state.species.some(x => x !== s && x.name === nv)) { nameIn.value = s.name; return; }
        renameSpecies(s, nv);
        changed({ rebuild: 'all' });
      });
      const mwIn = h('input', { type: 'number', step: 'any', min: 0, value: s.mw, 'aria-label': 'Molar mass of ' + s.name });
      mwIn.addEventListener('input', () => { const v = parseFloat(mwIn.value); if (v > 0) { s.mw = v; changed(); } });
      const cIn = h('input', { type: 'number', step: 'any', min: 0, value: comp[s.name] || 0, 'aria-label': (phase === 'solid' ? 'Feed mass percent of ' : 'Inlet mole percent of ') + s.name });
      cIn.addEventListener('input', () => { const v = parseFloat(cIn.value); if (v >= 0) { comp[s.name] = v; updateSum(); changed(); } });
      const cpCells = s.cp.map((c, i) => {
        const ci = h('input', { type: 'number', step: 'any', value: c, 'aria-label': 'cp coefficient ' + 'ABCDE'[i] + ' of ' + s.name });
        ci.addEventListener('input', () => { const v = parseFloat(ci.value); if (Number.isFinite(v)) { s.cp[i] = v; upd(); changed(); } });
        return h('td', null, ci);
      });
      const cp25 = h('td', { class: 'ro' }), cp1000 = h('td', { class: 'ro' });
      const upd = () => { cp25.textContent = fmt(KM.cpMol(s.cp, 298.15), 1); cp1000.textContent = fmt(KM.cpMol(s.cp, 1273.15), 1); };
      upd();
      const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + s.name, text: '✕' });
      del.addEventListener('click', () => {
        state.species.splice(state.species.indexOf(s), 1);
        delete comp[s.name];
        changed({ rebuild: 'all' });
      });
      tb.appendChild(h('tr', null, h('td', null, nameIn), h('td', null, mwIn), h('td', null, cIn), cpCells, cp25, cp1000, h('td', null, del)));
    });
    updateSum();
    // add species
    const lib = KP.SPECIES_LIBRARY.filter(s => s.phase === phase && !state.species.some(x => x.name === s.name));
    const sel = h('select', { 'aria-label': 'Species to add' },
      lib.map(s => h('option', { value: s.name, text: s.name })),
      h('option', { value: '__custom', text: 'Custom species…' }));
    const add = h('button', { type: 'button', class: 'btn small', text: 'Add species' });
    add.addEventListener('click', () => {
      let sp;
      if (sel.value === '__custom') {
        let i = 1; while (state.species.some(x => x.name === 'Species' + i)) i++;
        sp = { name: 'Species' + i, phase, mw: 100, cp: [phase === 'gas' ? 30 : 100, 0, 0, 0, 0] };
      } else sp = KP.clone(KP.SPECIES_LIBRARY.find(x => x.name === sel.value));
      state.species.push(sp);
      changed({ rebuild: 'all' });
    });
    return h('div', null,
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'edit' },
        h('thead', null, h('tr', null,
          h('th', { text: 'Species' }), h('th', { text: 'M, g/mol' }), h('th', { text: phase === 'solid' ? 'Feed, wt %' : 'Inlet, mol %' }),
          h('th', { text: 'A' }), h('th', { text: 'B' }), h('th', { text: 'C' }), h('th', { text: 'D' }), h('th', { text: 'E' }),
          h('th', { text: 'cp 25 °C' }), h('th', { text: 'cp 1000 °C' }), h('th', { text: '' }))),
        tb, h('tfoot', null, h('tr', null, sumCell)))),
      h('div', { class: 'row-actions' }, sel, add));
  }
  function renameSpecies(s, nv) {
    const old = s.name;
    const f = KM.parseFormula(nv);
    s.name = nv;
    if (f) s.mw = +f.mw.toFixed(3);
    const comp = s.phase === 'solid' ? state.solids.composition : state.gas.inlet.composition;
    if (old in comp) { comp[nv] = comp[old]; delete comp[old]; }
    if (state.burner.fuel === old) state.burner.fuel = nv;
    state.reactions.forEach(r => {
      if (r.key === old) r.key = nv;
      try {
        const terms = KM.parseEquation(r.equation);
        if (terms.some(t => t.name === old)) {
          const side = sg => terms.filter(t => Math.sign(t.coef) === sg).map(t => (Math.abs(t.coef) === 1 ? '' : Math.abs(t.coef) + ' ') + (t.name === old ? nv : t.name)).join(' + ');
          r.equation = side(-1) + ' -> ' + side(1);
        }
      } catch (e) { /* leave unparsable equations alone */ }
    });
  }

  // ---- reactions ----
  function paneReactions(p) {
    p.append(hint('Rate of the key reactant: dw/dt = −k·wⁿ (w = its mass fraction in its own phase, n = 0 or 1), with k = A·exp(−Ea/RT) at that phase’s temperature. ΔH is per mole of reaction as written at 25 °C; positive is endothermic.'));
    state.reactions.forEach((r, i) => p.appendChild(reactionCard(r, i)));
    const add = h('button', { type: 'button', class: 'btn small', text: 'Add reaction' });
    add.addEventListener('click', () => {
      const s0 = state.species.find(s => s.phase === 'solid');
      state.reactions.push({ name: 'New reaction', equation: s0 ? s0.name + ' -> ' + s0.name : '', key: s0 ? s0.name : '', order: 1, A: 1e5, Ea: 100, dH: 0, enabled: true });
      changed({ rebuild: 'rx' });
    });
    p.appendChild(h('div', { class: 'row-actions' }, add));
  }
  function reactionCard(r, i) {
    const card = h('div', { class: 'rx' + (r.enabled === false ? ' off' : '') });
    const en = h('input', { type: 'checkbox', checked: r.enabled !== false, 'aria-label': 'Include ' + r.name });
    en.addEventListener('change', () => { r.enabled = en.checked; card.classList.toggle('off', !en.checked); changed(); });
    const nameIn = h('input', { class: 'rx-name', value: r.name, 'aria-label': 'Reaction name' });
    nameIn.addEventListener('input', () => { r.name = nameIn.value; store(); });
    const del = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + r.name, text: '✕' });
    del.addEventListener('click', () => { state.reactions.splice(i, 1); changed({ rebuild: 'rx' }); });
    const eqId = nid('eq');
    const eqIn = h('input', { id: eqId, class: 'eqn', value: r.equation, spellcheck: 'false', autocomplete: 'off' });
    const keySel = h('select', { 'aria-label': 'Key reactant' });
    const msg = h('p', { class: 'rx-msg' });
    const refreshKey = () => {
      let names = [];
      try { names = KM.parseEquation(r.equation).filter(t => t.coef < 0).map(t => t.name); } catch (e) { /* shown in msg */ }
      if (!names.length && r.key) names = [r.key];
      if (!names.includes(r.key)) r.key = names[0] || '';
      keySel.textContent = '';
      names.forEach(n => keySel.appendChild(h('option', { value: n, selected: n === r.key, text: n })));
    };
    const refreshMsg = () => {
      msg.className = 'rx-msg'; msg.textContent = '';
      let terms;
      try { terms = KM.parseEquation(r.equation); } catch (e) { msg.className = 'rx-msg err'; msg.textContent = e.message; return; }
      const missing = terms.filter(t => !state.species.some(s => s.name === t.name)).map(t => t.name);
      if (missing.length) { msg.className = 'rx-msg err'; msg.textContent = 'Not in the species lists: ' + missing.join(', '); return; }
      let mIn = 0, mOut = 0;
      terms.forEach(t => { const s = state.species.find(x => x.name === t.name); if (t.coef < 0) mIn -= t.coef * s.mw; else mOut += t.coef * s.mw; });
      const parts = [];
      if (Math.abs(mIn - mOut) > 0.005 * Math.max(mIn, mOut)) { msg.className = 'rx-msg warn'; parts.push('Not mass balanced: ' + fmt(mIn, 2) + ' g in, ' + fmt(mOut, 2) + ' g out.'); }
      if (r.A > 0) {
        const Tk = r.Ea > 0 ? r.Ea * 1000 / (RU * Math.log(r.A / 0.01)) : NaN;
        if (Number.isFinite(Tk) && Tk > 0) parts.push('k reaches 0.01 s⁻¹ at ' + fmt(C(Tk), 0) + ' °C (time constant 100 s).');
        else if (r.Ea <= 0) parts.push('k = ' + sci(r.A) + ' s⁻¹ at all temperatures.');
      }
      msg.textContent = parts.join(' ');
    };
    eqIn.addEventListener('input', () => { r.equation = eqIn.value; refreshKey(); refreshMsg(); changed(); });
    keySel.addEventListener('change', () => { r.key = keySel.value; changed(); });
    refreshKey(); refreshMsg();
    const num = (key, label, unit, o) => {
      const id = nid('r');
      const inp = h('input', { id, type: 'number', step: 'any', value: r[key] });
      const box = h('div', { class: 'inp' }, inp, h('span', { class: 'u', text: unit }));
      inp.addEventListener('input', () => {
        const v = parseFloat(inp.value);
        const bad = !Number.isFinite(v) || (o && o.min !== undefined && v < o.min);
        box.classList.toggle('invalid', bad);
        if (bad) return;
        r[key] = v; refreshMsg(); changed();
      });
      return h('div', { class: 'field' }, h('label', { for: id, text: label }), box);
    };
    const ordId = nid('o');
    const ordSel = h('select', { id: ordId }, h('option', { value: '1', selected: +r.order === 1, text: 'First order' }), h('option', { value: '0', selected: +r.order === 0, text: 'Zero order' }));
    ordSel.addEventListener('change', () => { r.order = +ordSel.value; changed(); });
    card.append(
      h('div', { class: 'rx-head' }, en, nameIn, del),
      h('div', { class: 'field wide' }, h('label', { for: eqId, class: 'sr', text: 'Equation' }), h('div', { class: 'inp' }, eqIn)),
      h('div', { class: 'rx-grid' },
        h('div', { class: 'field' }, h('label', { text: 'Key reactant' }), h('div', { class: 'inp' }, keySel)),
        h('div', { class: 'field' }, h('label', { for: ordId, text: 'Kinetics' }), h('div', { class: 'inp' }, ordSel)),
        num('A', 'Pre-exponential A', 's⁻¹', { min: 0 }),
        num('Ea', 'Activation energy', 'kJ/mol', { min: 0 }),
        num('dH', 'Heat of reaction ΔH', 'kJ/mol')),
      msg);
    return card;
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------
  const S = i => 'var(--series-' + (i % 8 + 1) + ')';
  const charts = {};
  function buildCharts() {
    const host = $('charts');
    host.textContent = '';
    charts.temp = new LineChart(host, { title: 'Temperature profiles', unit: '°C', digits: 0, height: 260 });
    charts.shell = new LineChart(host, { title: 'Shell surface temperature', unit: '°C', digits: 0 });
    charts.solids = new LineChart(host, { title: 'Solids composition', unit: 'wt %', digits: 2 });
    charts.gas = new LineChart(host, { title: 'Gas composition', unit: 'mol %', digits: 2 });
    charts.flux = new LineChart(host, { title: 'Heat flux into the bed', unit: 'kW/m', digits: 1 });
    charts.cum = new LineChart(host, { title: 'Cumulative heat from the feed end', unit: 'MW', digits: 2 });
    charts.loss = new LineChart(host, { title: 'Heat loss to surroundings', unit: 'kW/m', digits: 2 });
    charts.rates = new LineChart(host, { title: 'Reaction rates', unit: 'mol/(s·m)', digits: 4 });
    charts.bed = new LineChart(host, { title: 'Bed fill', unit: '%', digits: 2 });
    charts.htc = new LineChart(host, { title: 'Heat transfer coefficients', unit: 'W/(m\u00b2\u00b7K)', digits: 1 });
  }

  function renderResults(r) {
    showMessages(r);
    drawSchematic(r);
    renderKpis(r);
    renderCharts(r);
    renderBalances(r);
    renderProfileTable(r);
  }
  function showMessages(r) {
    const box = $('messages');
    box.textContent = '';
    if (r.errors && r.errors.length) {
      box.appendChild(h('div', { class: 'msg error', role: 'alert' }, h('span', { class: 'tag', text: 'Fix before solving' }), h('ul', null, r.errors.map(e => h('li', { text: e })))));
    }
    if (r.warnings && r.warnings.length) {
      box.appendChild(h('div', { class: 'msg warn' }, h('span', { class: 'tag', text: 'Note' }), h('ul', null, r.warnings.map(e => h('li', { text: e })))));
    }
  }

  function renderKpis(r) {
    const s = r.summary, cells = r.cells, box = $('kpis');
    box.textContent = '';
    const tile = (label, value, unit, note) => box.appendChild(h('div', { class: 'kpi' },
      h('div', { class: 'k-label', text: label }),
      h('div', { class: 'k-value' }, value, unit ? h('small', { text: unit }) : null),
      note ? h('div', { class: 'k-note', text: note }) : null));
    const peak = (key) => cells.reduce((b, c) => (c[key] > b[key] ? c : b), cells[0]);
    const pg = peak('Tg'), ps = peak('Ts');
    const gasEnd = r.meta.flowDir === 'counter' ? 'feed' : 'discharge';
    tile('Product temperature', fmt(C(r.outlet.solids.T), 0), '°C', fmt(r.summary.productRate, 2) + ' t/h of product');
    tile('Off-gas temperature', fmt(C(r.outlet.gas.T), 0), '°C', 'leaving at the ' + gasEnd + ' end');
    tile('Peak gas temperature', fmt(C(pg.Tg), 0), '°C', 'at ' + fmt(pg.z, 1) + ' m');
    tile('Peak bed temperature', fmt(C(ps.Ts), 0), '°C', 'at ' + fmt(ps.z, 1) + ' m');
    const conv = s.conversions.slice().sort((a, b) => {
      const fa = r.inlet.solids.F[r.meta.solids.indexOf(a.name)] || 0, fb = r.inlet.solids.F[r.meta.solids.indexOf(b.name)] || 0;
      return fb - fa;
    });
    if (conv.length) tile(conv[0].name + ' converted', fmt(conv[0].X * 100, 1), '%', conv.slice(1, 3).map(c => c.name + ' ' + fmt(c.X * 100, 1) + ' %').join(' · ') || 'of the feed');
    tile('Solids residence time', fmt(s.residenceTime / 60, 0), 'min', 'mean bed fill ' + fmt(s.meanFill * 100, 1) + ' %');
    tile('Shell heat loss', fmt(s.heatLoss / 1e6, 2), 'MW', fmt(s.heatLoss / r.energy.sumIn * 100, 1) + ' % of heat input');
    if (r.meta.burner) tile('Specific fuel use', fmt(s.specificEnergy, 2), 'GJ/t', 'LHV per tonne of product');
    else tile('Heat into the bed', fmt(s.heatToSolids / 1e6, 2), 'MW', 'net, over the whole kiln');
    if (!conv.length) tile('Heat into the bed', fmt(s.heatToSolids / 1e6, 2), 'MW', 'net, over the whole kiln');
  }

  function bands(r) {
    const out = [];
    const L = r.meta.L;
    if (r.meta.burner) {
      const Lf = Math.min(r.meta.burner.Lf, L);
      out.push(r.meta.flowDir === 'counter' ? { x0: L - Lf, x1: L, kind: 'flame', label: 'Flame' } : { x0: 0, x1: Lf, kind: 'flame', label: 'Flame' });
    }
    const ht = state.heatTransfer;
    if (+ht.lifterUa > 0 && +ht.lifterEnd > +ht.lifterStart) out.push({ x0: +ht.lifterStart, x1: Math.min(+ht.lifterEnd, L), kind: 'chain', label: 'Chains / lifters' });
    return out;
  }
  function renderCharts(r) {
    const cells = r.cells, L = r.meta.L, zc = cells.map(c => c.z);
    const counter = r.meta.flowDir === 'counter';
    const b = bands(r);
    const sx = [0].concat(zc, [L]);
    const gx = sx;
    const gasY = f => counter ? [f(cells[0])].concat(cells.map(f), [null]) : [null].concat(cells.map(f), [f(cells[cells.length - 1])]);
    const tgIn = C(r.inlet.gas.T);
    const tg = gasY(c => C(c.Tg)); if (counter) tg[tg.length - 1] = tgIn; else tg[0] = tgIn;
    charts.temp.setData({
      xMax: L, bands: b,
      subtitle: 'Gas, bed, hot face of the lining and steel shell',
      series: [
        { id: 'gas', name: 'Gas', color: S(1), x: gx, y: tg },
        { id: 'solids', name: 'Solids', color: S(0), x: sx, y: [C(r.inlet.solids.T)].concat(cells.map(c => C(c.Ts)), [C(r.outlet.solids.T)]) },
        { id: 'wall', name: 'Inner wall', color: S(2), x: zc, y: cells.map(c => C(c.Tw)) },
        { id: 'shell', name: 'Shell', color: S(3), x: zc, y: cells.map(c => C(c.Tsh)) }
      ]
    });
    charts.shell.setData({
      xMax: L, bands: b,
      subtitle: 'Outer steel surface; ambient ' + fmt(C(r.meta.Ta), 0) + ' °C',
      series: [{ id: 'shell', name: 'Shell', color: S(3), x: zc, y: cells.map(c => C(c.Tsh)) }]
    });
    charts.solids.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: 'Mass fraction of each solid species in the bed',
      series: r.meta.solids.map((n, j) => ({ id: 's' + n, name: n, color: S(j), x: sx, y: [r.inlet.solids.w[j] * 100].concat(cells.map(c => c.w[j] * 100), [r.outlet.solids.w[j] * 100]) }))
        .filter(se => se.y.some(v => v > 1e-6))
    });
    const gyIn = r.inlet.gas.y;
    charts.gas.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: 'Mole fraction, wet basis',
      series: r.meta.gases.map((n, j) => {
        const y = gasY(c => c.y[j] * 100);
        if (counter) y[y.length - 1] = gyIn[j] * 100; else y[0] = gyIn[j] * 100;
        return { id: 'g' + n, name: n, color: S(j), x: gx, y };
      }).filter(se => se.y.some(v => v > 1e-6))
    });
    const flux = [
      { id: 'total', name: 'Total', key: 'qSolids', color: 'var(--ink)', emph: true },
      { id: 'grad', name: 'Gas radiation', key: 'qGsRad', color: S(1) },
      { id: 'gconv', name: 'Gas convection', key: 'qGsConv', color: S(0) },
      { id: 'wrad', name: 'Wall radiation', key: 'qWsRad', color: S(2) },
      { id: 'wcond', name: 'Wall contact', key: 'qWsCond', color: S(4) },
      { id: 'lift', name: 'Chains / lifters', key: 'qLift', color: S(6) }
    ].filter(f => cells.some(c => Math.abs(c[f.key]) > 1e-3));
    charts.flux.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: 'Net heat received by the bed per metre, by path; negative means the bed is giving heat back',
      series: flux.map(f => ({ id: f.id, name: f.name, color: f.color, emph: f.emph, x: zc, y: cells.map(c => c[f.key] / 1e3) }))
    });
    const faces = [0].concat(cells.map(c => c.z + r.meta.dz / 2));
    let cb = 0;
    const cumBurn = [0].concat(cells.map(c => (cb += c.qBurn * r.meta.dz) / 1e6));
    const cumSeries = [
      { id: 'cs', name: 'Into the bed', color: S(0), x: faces, y: [0].concat(cells.map(c => c.cumSolids / 1e6)) },
      { id: 'cl', name: 'Lost through the shell', color: S(3), x: faces, y: [0].concat(cells.map(c => c.cumLoss / 1e6)) }
    ];
    if (r.meta.burner) cumSeries.push({ id: 'cb', name: 'Released by the burner', color: S(1), x: faces, y: cumBurn });
    charts.cum.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: 'Totals at the discharge end: bed ' + fmt(r.summary.heatToSolids / 1e6, 2) + ' MW, shell loss ' + fmt(r.summary.heatLoss / 1e6, 2) + ' MW',
      series: cumSeries
    });
    charts.loss.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: 'From the shell per metre of kiln; total ' + fmt(r.summary.heatLoss / 1e6, 2) + ' MW',
      series: [
        { id: 'lt', name: 'Total', color: 'var(--ink)', emph: true, x: zc, y: cells.map(c => c.qLoss / 1e3) },
        { id: 'lr', name: 'Radiation', color: S(1), x: zc, y: cells.map(c => c.qLossRad / 1e3) },
        { id: 'lc', name: 'Convection', color: S(0), x: zc, y: cells.map(c => c.qLossConv / 1e3) }
      ]
    });
    const rx = r.meta.reactions;
    charts.rates.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: rx.length ? 'Moles of reaction (as written) per second per metre of kiln' : 'No reactions defined',
      series: rx.length ? rx.map((x, j) => ({ id: 'r' + j, name: x.name, color: S(j), x: zc, y: cells.map(c => c.rates[j]) }))
        : [{ id: 'none', name: 'None', color: S(0), x: [0, L], y: [0, 0] }]
    });
    charts.bed.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: (r.meta.bedModel === 'kramers' ? 'Kramers bed profile' : 'Fixed fill') + '; residence time ' + fmt(r.summary.residenceTime / 60, 0) + ' min',
      series: [{ id: 'fill', name: 'Fill', color: S(5), x: zc, y: cells.map(c => c.fill * 100) }]
    });
    charts.htc.setData({
      xMax: L, bands: b, includeZero: true,
      subtitle: 'Convective and contact coefficients; radiation is calculated separately',
      series: [
        { id: 'hws', name: 'Covered wall to bed', color: S(4), x: zc, y: cells.map(c => c.hws) },
        { id: 'hgs', name: 'Gas to bed', color: S(0), x: zc, y: cells.map(c => c.hgs) },
        { id: 'hgw', name: 'Gas to wall', color: S(2), x: zc, y: cells.map(c => c.hgw) },
        { id: 'hext', name: 'Shell to air', color: S(3), x: zc, y: cells.map(c => c.hExt) }
      ]
    });
  }

  function renderBalances(r) {
    const box = $('balances');
    box.textContent = '';
    const MW = w => fmt(w / 1e6, 3);
    const pct = (w, tot) => fmt(w / tot * 100, 1);
    // energy
    const e = r.energy;
    const et = h('tbody');
    et.appendChild(h('tr', { class: 'group' }, h('td', { colspan: 3, text: 'In' })));
    e.in.forEach(x => et.appendChild(h('tr', null, h('td', { text: x.name }), h('td', { text: MW(x.W) }), h('td', { text: pct(x.W, e.sumIn) }))));
    et.appendChild(h('tr', { class: 'total' }, h('td', { text: 'Total in' }), h('td', { text: MW(e.sumIn) }), h('td', { text: '100.0' })));
    et.appendChild(h('tr', { class: 'group' }, h('td', { colspan: 3, text: 'Out' })));
    e.out.forEach(x => et.appendChild(h('tr', null, h('td', { text: x.name }), h('td', { text: MW(x.W) }), h('td', { text: pct(x.W, e.sumIn) }))));
    et.appendChild(h('tr', { class: 'total' }, h('td', { text: 'Total out' }), h('td', { text: MW(e.sumOut) }), h('td', { text: pct(e.sumOut, e.sumIn) })));
    et.appendChild(h('tr', { class: 'closure' }, h('td', { text: 'Closure (in − out)' }), h('td', { text: fmt(e.closure / 1e3, 3) + ' kW' }), h('td', { text: '' })));
    box.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Energy balance' }),
      h('p', { class: 'hint', text: 'Sensible heat relative to 25 °C; fuel on its lower heating value.' }),
      h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { text: 'Stream' }), h('th', { text: 'MW' }), h('th', { text: '% of in' }))), et)));
    // mass
    const m = r.mass;
    const mt = h('tbody');
    const th = kg => fmt(kg * 3.6, 3);
    mt.appendChild(h('tr', { class: 'group' }, h('td', { colspan: 2, text: 'In' })));
    m.in.forEach(x => mt.appendChild(h('tr', null, h('td', { text: x.name }), h('td', { text: th(x.kg) }))));
    mt.appendChild(h('tr', { class: 'total' }, h('td', { text: 'Total in' }), h('td', { text: th(m.sumIn) })));
    mt.appendChild(h('tr', { class: 'group' }, h('td', { colspan: 2, text: 'Out' })));
    m.out.forEach(x => mt.appendChild(h('tr', null, h('td', { text: x.name }), h('td', { text: th(x.kg) }))));
    mt.appendChild(h('tr', { class: 'total' }, h('td', { text: 'Total out' }), h('td', { text: th(m.sumOut) })));
    mt.appendChild(h('tr', { class: 'closure' }, h('td', { text: 'Closure (in − out)' }), h('td', { text: fmt(m.closure * 3600, 4) + ' kg/h' })));
    box.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Mass balance' }),
      h('p', { class: 'hint', text: 'Mass flows in t/h.' }),
      h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { text: 'Stream' }), h('th', { text: 't/h' }))), mt)));
    // streams
    const st = h('tbody');
    st.appendChild(h('tr', { class: 'group' }, h('td', { colspan: 3, text: 'Solids, wt %' })));
    r.meta.solids.forEach((n, j) => st.appendChild(h('tr', null, h('td', { text: n }), h('td', { text: fmt(r.inlet.solids.w[j] * 100, 2) }), h('td', { text: fmt(r.outlet.solids.w[j] * 100, 2) }))));
    st.appendChild(h('tr', { class: 'total' }, h('td', { text: 'Temperature, °C' }), h('td', { text: fmt(C(r.inlet.solids.T), 0) }), h('td', { text: fmt(C(r.outlet.solids.T), 0) })));
    st.appendChild(h('tr', { class: 'group' }, h('td', { colspan: 3, text: 'Gas, mol %' })));
    r.meta.gases.forEach((n, j) => st.appendChild(h('tr', null, h('td', { text: n }), h('td', { text: fmt(r.inlet.gas.y[j] * 100, 2) }), h('td', { text: fmt(r.outlet.gas.y[j] * 100, 2) }))));
    const nm3 = G => G.reduce((a, g) => a + Math.max(g, 0), 0) / KM.NM3_MOL * 3600;
    st.appendChild(h('tr', { class: 'total' }, h('td', { text: 'Flow, Nm³/h' }), h('td', { text: fmt(nm3(r.inlet.gas.G), 0) }), h('td', { text: fmt(nm3(r.outlet.gas.G), 0) })));
    st.appendChild(h('tr', null, h('td', { text: 'Temperature, °C' }), h('td', { text: fmt(C(r.inlet.gas.T), 0) }), h('td', { text: fmt(C(r.outlet.gas.T), 0) })));
    box.appendChild(h('div', { class: 'card' }, h('h2', { text: 'Inlet and outlet streams' }),
      h('p', { class: 'hint', text: 'Gas inlet is the mixed burner and hot-gas stream before combustion.' }),
      h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', { text: 'Component' }), h('th', { text: 'In' }), h('th', { text: 'Out' }))), st)));
  }

  function profileColumns(r) {
    const cols = [
      ['z, m', c => c.z, 2], ['Ts, °C', c => C(c.Ts), 1], ['Tg, °C', c => C(c.Tg), 1], ['Tw, °C', c => C(c.Tw), 1], ['Tshell, °C', c => C(c.Tsh), 1],
      ['q bed, kW/m', c => c.qSolids / 1e3, 2], ['q loss, kW/m', c => c.qLoss / 1e3, 3], ['q burner, kW/m', c => c.qBurn / 1e3, 2],
      ['fill, %', c => c.fill * 100, 2], ['gas velocity, m/s', c => c.uG, 2], ['gas emissivity', c => c.epsG, 3],
      ['h gas-wall, W/m²K', c => c.hgw, 2], ['h gas-bed, W/m²K', c => c.hgs, 2], ['h wall-bed, W/m²K', c => c.hws, 1]
    ];
    r.meta.solids.forEach((n, j) => cols.push([n + ', wt %', c => c.w[j] * 100, 3]));
    r.meta.gases.forEach((n, j) => cols.push([n + ', mol %', c => c.y[j] * 100, 3]));
    r.meta.reactions.forEach((x, j) => cols.push(['rate ' + x.name + ', mol/(s·m)', c => c.rates[j], 6]));
    return cols;
  }
  function renderProfileTable(r) {
    const host = $('profileTable');
    host.textContent = '';
    if (!$('profileCard').open) { host.dataset.pending = '1'; return; }
    delete host.dataset.pending;
    const cols = profileColumns(r);
    const step = Math.max(1, Math.round(r.cells.length / 200));
    const tb = h('tbody');
    r.cells.forEach((c, i) => {
      if (i % step && i !== r.cells.length - 1) return;
      tb.appendChild(h('tr', null, cols.map(([, f, d]) => h('td', { text: fmt(f(c), d) }))));
    });
    host.appendChild(h('table', { class: 'data' }, h('thead', null, h('tr', null, cols.map(([n]) => h('th', { text: n })))), tb));
    $('csvNote').textContent = step > 1 ? 'Table shows every ' + step + 'th cell; the CSV has all ' + r.cells.length + '.' : r.cells.length + ' cells.';
  }
  function csvText(r) {
    const cols = profileColumns(r);
    const lines = [cols.map(c => '"' + c[0] + '"').join(',')];
    r.cells.forEach(c => lines.push(cols.map(([, f]) => { const v = f(c); return Number.isFinite(v) ? +v.toPrecision(8) : ''; }).join(',')));
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Kiln schematic
  // ---------------------------------------------------------------------------
  function drawSchematic(r) {
    const svgEl = $('schematic');
    const W = Math.max(svgEl.clientWidth || 600, 300);
    const narrow = W < 560;
    const H = narrow ? 150 : 160;
    svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svgEl.setAttribute('height', H);
    svgEl.textContent = '';
    const NS = 'http://www.w3.org/2000/svg';
    const s = (tag, a, parent) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); (parent || svgEl).appendChild(e); return e; };
    const txt = (x, y, t, a) => { const e = s('text', Object.assign({ x, y, 'font-size': narrow ? 10.5 : 11.5, fill: 'var(--ink-2)' }, a || {})); e.textContent = t; return e; };
    const L = +state.kiln.length || 1, D = +state.kiln.diameter || 1;
    const counter = state.gas.direction !== 'co';
    const padL = narrow ? 60 : 92, padR = narrow ? 60 : 92;
    const x0 = padL, x1 = W - padR, top = 44, bh = narrow ? 50 : 56, bot = top + bh;
    const X = z => x0 + (z / L) * (x1 - x0);
    const lin = 6;
    // defs
    const defs = s('defs', {});
    const grad = s('linearGradient', { id: 'flameGrad', x1: counter ? '1' : '0', x2: counter ? '0' : '1', y1: '0', y2: '0' }, defs);
    s('stop', { offset: '0', 'stop-color': 'var(--accent)', 'stop-opacity': '0.95' }, grad);
    s('stop', { offset: '1', 'stop-color': 'var(--series-4)', 'stop-opacity': '0.15' }, grad);
    const pat = s('pattern', { id: 'chainPat', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--series-7)', 'stroke-width': 1.2, 'stroke-opacity': 0.55 }, pat);
    // shell + lining
    s('rect', { x: x0, y: top, width: x1 - x0, height: bh, rx: 4, fill: 'var(--kiln-lining)', stroke: 'var(--kiln-shell)', 'stroke-width': 2 });
    s('rect', { x: x0 + 1, y: top + lin, width: x1 - x0 - 2, height: bh - 2 * lin, fill: 'var(--surface)' });
    const inner = bh - 2 * lin, iy = top + lin;
    // chains / lifters
    const ht = state.heatTransfer;
    if (+ht.lifterUa > 0 && +ht.lifterEnd > +ht.lifterStart) {
      const a = X(Math.max(0, +ht.lifterStart)), b = X(Math.min(L, +ht.lifterEnd));
      s('rect', { x: a, y: iy, width: Math.max(b - a, 0), height: inner, fill: 'url(#chainPat)' });
    }
    // bed
    let pts = [];
    if (r && r.cells) {
      pts.push([X(0), iy + inner - (r.cells[0].depth / D) * inner]);
      r.cells.forEach(c => pts.push([X(c.z), iy + inner - (c.depth / D) * inner]));
      pts.push([X(L), iy + inner - (r.cells[r.cells.length - 1].depth / D) * inner]);
    } else {
      const f = state.kiln.bedModel === 'fill' ? (+state.kiln.fill || 8) / 100 : 0.08;
      const g = KM.bedGeometry(D / 2, KM.thetaFromFill(f));
      const y = iy + inner - (g.depth / D) * inner;
      pts = [[X(0), y], [X(L), y]];
    }
    const bedPath = 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'L' + X(L) + ' ' + (iy + inner) + 'L' + X(0) + ' ' + (iy + inner) + 'Z';
    s('path', { d: bedPath, fill: 'var(--kiln-bed)', opacity: 0.9 });
    // flame
    if (state.burner.enabled) {
      const Lf = Math.min(+state.burner.flameLength || 0, L);
      const fy = iy + inner * 0.38, fh = inner * 0.34;
      const bx = counter ? X(L) : X(0), tx = counter ? X(L - Lf) : X(Lf);
      s('path', { d: 'M' + bx + ' ' + (fy - fh * 0.25) + ' Q' + ((bx + tx) / 2) + ' ' + (fy - fh) + ' ' + tx + ' ' + fy + ' Q' + ((bx + tx) / 2) + ' ' + (fy + fh) + ' ' + bx + ' ' + (fy + fh * 0.25) + 'Z', fill: 'url(#flameGrad)' });
      const nx = counter ? X(L) : X(0);
      s('rect', { x: counter ? nx : nx - 22, y: fy - 3, width: 22, height: 6, fill: 'var(--ink-2)', rx: 1 });
      if (!narrow) txt(counter ? nx + 26 : nx - 26, fy + 4, 'Burner', { 'text-anchor': counter ? 'start' : 'end', fill: 'var(--ink-2)' });
    }
    // solids arrow (below)
    const ay = bot + 18;
    s('line', { x1: X(0) + 4, y1: ay, x2: X(L) - 8, y2: ay, stroke: 'var(--series-1)', 'stroke-width': 2 });
    s('path', { d: 'M' + (X(L) - 2) + ' ' + ay + ' l-8 -4 v8 Z', fill: 'var(--series-1)' });
    txt((X(0) + X(L)) / 2, ay + 15, 'Solids, ' + fmt(+state.solids.feedRate, 1) + ' t/h', { 'text-anchor': 'middle' });
    // gas arrow (above)
    const gy = top - 14;
    if (counter) {
      s('line', { x1: X(L) - 4, y1: gy, x2: X(0) + 8, y2: gy, stroke: 'var(--series-2)', 'stroke-width': 2 });
      s('path', { d: 'M' + (X(0) + 2) + ' ' + gy + ' l8 -4 v8 Z', fill: 'var(--series-2)' });
    } else {
      s('line', { x1: X(0) + 4, y1: gy, x2: X(L) - 8, y2: gy, stroke: 'var(--series-2)', 'stroke-width': 2 });
      s('path', { d: 'M' + (X(L) - 2) + ' ' + gy + ' l-8 -4 v8 Z', fill: 'var(--series-2)' });
    }
    txt((X(0) + X(L)) / 2, gy - 7, (counter ? 'Gas, counter-current' : 'Gas, co-current'), { 'text-anchor': 'middle' });
    // end labels: gas streams on the top row, solids on the bottom row
    const live = r && r.ok !== false && r.cells;
    const t = v => fmt(C(v), 0) + ' \u00b0C';
    const leftX = x0 - 8, rightX = x1 + 8;
    txt(leftX, ay - 2, 'Feed', { 'text-anchor': 'end', fill: 'var(--ink)', 'font-weight': 600 });
    txt(leftX, ay + 12, live ? t(r.inlet.solids.T) : fmt(+state.solids.feedT, 0) + ' \u00b0C', { 'text-anchor': 'end' });
    txt(rightX, ay - 2, 'Product', { 'text-anchor': 'start', fill: 'var(--ink)', 'font-weight': 600 });
    txt(rightX, ay + 12, live ? t(r.outlet.solids.T) : '\u2013', { 'text-anchor': 'start' });
    const gasOutX = counter ? leftX : rightX, gasInX = counter ? rightX : leftX;
    const anchorOut = counter ? 'end' : 'start', anchorIn = counter ? 'start' : 'end';
    txt(gasOutX, gy - 6, 'Off-gas', { 'text-anchor': anchorOut, fill: 'var(--ink)', 'font-weight': 600 });
    txt(gasOutX, gy + 8, live ? t(r.outlet.gas.T) : '\u2013', { 'text-anchor': anchorOut });
    const inName = state.burner.enabled ? (narrow ? 'Air' : (+state.gas.inlet.flow > 0 ? 'Air + gas' : 'Air + fuel')) : 'Hot gas';
    const inT = state.burner.enabled ? +state.burner.airT : +state.gas.inlet.T;
    txt(gasInX, gy - 6, inName, { 'text-anchor': anchorIn, fill: 'var(--ink)', 'font-weight': 600 });
    txt(gasInX, gy + 8, fmt(inT, 0) + ' \u00b0C', { 'text-anchor': anchorIn });
    // scale
    txt(X(0), H - 4, '0 m', { 'text-anchor': 'start', fill: 'var(--muted)', 'font-size': 10.5 });
    txt(X(L), H - 4, fmt(L, 0) + ' m', { 'text-anchor': 'end', fill: 'var(--muted)', 'font-size': 10.5 });
    $('schematicNote').textContent = fmt(L, 0) + ' m × ' + fmt(D, 2) + ' m internal diameter · length to scale, diameter exaggerated' + (live ? '' : ' · run to see results');
    svgEl.setAttribute('aria-label', 'Kiln ' + fmt(L, 0) + ' m long, ' + (counter ? 'counter-current' : 'co-current') + ' gas flow' + (state.burner.enabled ? ', burner at the ' + (counter ? 'discharge' : 'feed') + ' end' : ''));
  }

  // ---------------------------------------------------------------------------
  // Case file dialog, CSV, presets
  // ---------------------------------------------------------------------------
  function caseDialog() {
    const ta = h('textarea', { spellcheck: 'false', 'aria-label': 'Case file JSON' });
    const clean = KP.clone(state); delete clean._edited;
    ta.value = JSON.stringify(clean, null, 2);
    const note = h('p', { class: 'hint', text: 'Copy this text to keep the case, or paste a saved case and load it.' });
    const close = () => { back.remove(); $('caseBtn').focus(); };
    const copy = h('button', { type: 'button', class: 'btn small', text: 'Copy' });
    copy.addEventListener('click', () => copyText(ta.value, ta, note, 'Case copied to the clipboard.'));
    const dl = h('button', { type: 'button', class: 'btn small', text: 'Download .json', hidden: embedded });
    dl.addEventListener('click', () => download((state.name || 'kiln-case').replace(/[^\w-]+/g, '-') + '.json', ta.value, 'application/json'));
    const file = h('input', { type: 'file', accept: '.json,application/json', class: 'sr', id: 'caseFile' });
    const open = h('label', { class: 'btn small', for: 'caseFile', text: 'Open file…' });
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { ta.value = String(rd.result); };
      rd.readAsText(f);
    });
    const load = h('button', { type: 'button', class: 'btn small primary', text: 'Load this case' });
    load.addEventListener('click', () => {
      try {
        const c = normalise(JSON.parse(ta.value));
        state = c; edited = true; state._edited = true;
        store(); updateCaseName(); rebuildPane('all'); close(); run();
      } catch (e) { note.textContent = 'This text is not a valid case file: ' + e.message; note.style.color = 'var(--bad)'; }
    });
    const cancel = h('button', { type: 'button', class: 'btn small', text: 'Close' });
    cancel.addEventListener('click', close);
    const dlg = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Case file' },
      h('h2', { text: 'Case file', style: { fontSize: '16px' } }), note, ta,
      h('div', { class: 'row-actions' }, file, open, copy, dl, cancel, load));
    const back = h('div', { class: 'dialog-backdrop' }, dlg);
    back.addEventListener('click', e => { if (e.target === back) close(); });
    back.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    document.body.appendChild(back);
    ta.focus();
  }
  function copyText(text, fallbackEl, noteEl, okMsg) {
    const done = () => { if (noteEl) noteEl.textContent = okMsg; };
    const fail = () => {
      if (fallbackEl && fallbackEl.select) { fallbackEl.focus(); fallbackEl.select(); }
      if (noteEl) noteEl.textContent = 'Copying is blocked here. The text is selected: press Ctrl+C (⌘C on a Mac).';
    };
    try { navigator.clipboard.writeText(text).then(done, fail); } catch (e) { fail(); }
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function setupPresets() {
    const sel = $('presetSelect');
    sel.appendChild(h('option', { value: '', text: 'Load an example…', selected: true, disabled: true }));
    KP.PRESETS.forEach(p => sel.appendChild(h('option', { value: p.id, text: p.label })));
    sel.addEventListener('change', () => {
      const p = KP.PRESETS.find(x => x.id === sel.value);
      if (!p) return;
      state = normalise(KP.clone(p.data)); edited = false;
      store(); updateCaseName(); rebuildPane('all');
      sel.value = '';
      run();
    });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------
  function init() {
    updateCaseName();
    buildTabs();
    buildCharts();
    setupPresets();
    drawSchematic(null);
    $('runBtn').addEventListener('click', run);
    $('caseBtn').addEventListener('click', caseDialog);
    $('autoRun').addEventListener('change', () => { if ($('autoRun').checked && lastStale) run(); });
    $('copyCsv').addEventListener('click', () => { if (lastResult) copyText(csvText(lastResult), null, $('csvNote'), 'Profile data copied as CSV.'); });
    $('downloadCsv').hidden = embedded;
    $('downloadCsv').addEventListener('click', () => { if (lastResult) download('kiln-profile.csv', csvText(lastResult), 'text/csv'); });
    $('profileCard').addEventListener('toggle', () => { if ($('profileCard').open && lastResult) renderProfileTable(lastResult); });
    document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
    let rw = 0;
    window.addEventListener('resize', () => { cancelAnimationFrame(rw); rw = requestAnimationFrame(() => drawSchematic(lastStale ? null : lastResult)); });
    run();
  }
  init();
}());
