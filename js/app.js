/* UI wiring: parameter form, run loop, result panels. */
(function () {
  'use strict';
  const C = window.CSTR, fmt = C.fmt, $ = (id) => document.getElementById(id);

  const GROUPS = [
    ['Tank', [
      ['tankD', 'Diameter T', 'm', 0.1, 20, 0.05],
      ['tankH', 'Liquid height H', 'm', 0.1, 40, 0.05],
    ]],
    ['Baffles', [
      ['baffleN', 'Count', '', 0, 8, 1],
      ['baffleW', 'Width', '% T', 2, 20, 0.5],
      ['baffleGap', 'Wall gap', '% T', 0, 5, 0.5],
    ]],
    ['Agitator', [
      ['impType', 'Impeller', 'select', Object.entries(C.IMPELLERS).map(([k, v]) => [k, v.label])],
      ['impD', 'Diameter D', 'm', 0.02, 18, 0.01],
      ['impC', 'Off-bottom clearance', 'm', 0.01, 40, 0.01],
      ['impBlades', 'Blades', '', 1, 12, 1],
      ['impWD', 'Blade width', '× D', 0.05, 0.5, 0.01],
      ['impAngle', 'Blade angle', '°', 10, 90, 1],
      ['impDir', 'Pumping', 'select', [['down', 'Down'], ['up', 'Up']]],
      ['rpm', 'Speed', 'rpm', 1, 3000, 1],
    ]],
    ['Fluid', [
      ['mu', 'Viscosity', 'mPa·s', 0.1, 1e6, 0.1],
      ['rho', 'Density', 'kg/m³', 500, 3000, 10],
    ]],
    ['Through-flow', [
      ['flow', 'Flow rate', 'm³/h', 0, 1e5, 0.1],
      ['inletPos', 'Feed radius', '× R', 0, 1, 0.05],
      ['outlet', 'Outlet', 'select', [['bottom', 'Bottom centre'], ['side-low', 'Side wall, low'], ['side-top', 'Side wall, overflow']]],
    ]],
    ['Solids (inferred settling)', [
      ['dp', 'Particle size', 'µm', 1, 20000, 1],
      ['rhoS', 'Particle density', 'kg/m³', 500, 20000, 10],
      ['wt', 'Loading', 'wt %', 0, 60, 0.5],
    ]],
    ['Numerics', [
      ['res', 'Grid', 'select', [[28, 'Fast (28 radial cells)'], [40, 'Standard (40)'], [56, 'Fine (56, slow)']]],
    ]],
  ];
  const FIELDS = [];

  function buildForm() {
    const host = $('fields');
    for (const [title, fields] of GROUPS) {
      const fs = document.createElement('fieldset');
      fs.innerHTML = `<legend>${title}</legend>`;
      for (const f of fields) {
        const [id, label, unit] = f, isSel = unit === 'select';
        const d = document.createElement('div');
        d.className = 'fld' + (isSel ? ' wide' : '');
        d.innerHTML = `<label for="p_${id}">${label}</label><div class="ctl">` + (isSel
          ? `<select id="p_${id}">${f[3].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`
          : `<input id="p_${id}" type="number" inputmode="decimal" min="${f[3]}" max="${f[4]}" step="${f[5]}">${unit ? `<span class="unit">${unit}</span>` : ''}`) + '</div>';
        fs.appendChild(d);
        FIELDS.push({ id, isSel, min: f[3], max: f[4], label });
      }
      host.appendChild(fs);
    }
  }
  function setForm(p) { for (const f of FIELDS) $('p_' + f.id).value = p[f.id]; syncAngle(); }
  function readForm() {
    const p = {};
    let bad = null;
    for (const f of FIELDS) {
      const el = $('p_' + f.id), wrap = el.closest('.fld');
      wrap.classList.remove('bad');
      if (f.isSel) { p[f.id] = f.id === 'res' ? +el.value : el.value; continue; }
      const v = parseFloat(el.value);
      if (!isFinite(v) || v < f.min || v > f.max) { wrap.classList.add('bad'); bad = bad || `${f.label} must be between ${f.min} and ${f.max}.`; }
      p[f.id] = v;
    }
    if (bad) throw new Error(bad);
    return p;
  }
  function syncAngle() {
    const radial = C.IMPELLERS[$('p_impType').value].angle === 90;
    $('p_impDir').closest('.fld').hidden = radial && +$('p_impAngle').value >= 90;
  }

  // ---------- state
  let result = null, running = false, cancel = false, lastParams = null, rerun = false;
  const tip = $('tip');
  function showTip(ev, text) {
    tip.textContent = text; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, ev.clientX + 14)) + 'px';
    tip.style.top = Math.max(4, ev.clientY - h - 12) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };
  const fmtTime = (s) => (!isFinite(s) ? '–' : s < 120 ? fmt(s) + ' s' : s < 7200 ? fmt(s / 60) + ' min' : fmt(s / 3600) + ' h');

  // ---------- field maps
  const MAPS = [
    { id: 'speed', title: 'Flow paths and in-plane speed', unit: 'm/s', overlay: 'stream', note: 'Streamlines of the radial–axial flow over speed √(u<sub>r</sub>² + u<sub>z</sub>²).', get: (r) => r.hydro.speed, zero: true },
    { id: 'vec', title: 'Velocity vectors', unit: '', overlay: 'vectors', note: 'Direction of the in-plane flow; arrow length scales with the square root of speed.', get: () => null },
    { id: 'swirl', title: 'Tangential (swirl) velocity', unit: 'm/s', note: 'Rotation about the shaft. Baffles convert it into vertical circulation.', get: (r) => r.flow.v, zero: true, abs: true },
    { id: 'age', title: 'Local mean age', unit: '× τ', note: 'Average time since fluid at each point entered the tank. High values mark slow-exchanging zones.', get: (r) => r.rtd && r.ageRel },
    { id: 'solids', title: 'Solids concentration', unit: '× mean', note: 'Volume fraction relative to the tank average from the drift-flux balance.', get: (r) => r.solids && r.solRel, zero: true },
  ];
  function buildFigs() {
    const host = $('figs');
    for (const m of MAPS) {
      const fig = document.createElement('figure');
      fig.id = 'fig_' + m.id;
      fig.innerHTML = `<canvas id="cv_${m.id}" role="img" aria-label="${m.title}"></canvas><figcaption><b>${m.title}</b>${m.note}</figcaption>`;
      host.appendChild(fig);
      const cv = fig.querySelector('canvas');
      cv.addEventListener('mousemove', (ev) => {
        if (!result) return;
        const pr = C.tankProbe(cv, ev);
        if (!pr) return hideTip();
        const r = result, c = pr.c;
        let t = `r ${fmt(pr.r)} m   z ${fmt(pr.z)} m\nradial ${fmt(r.hydro.uc[c], 2)}  axial ${fmt(r.hydro.wc[c], 2)}  swirl ${fmt(r.flow.v[c], 2)} m/s`;
        if (m.id === 'age' && r.rtd) t += `\nmean age ${fmtTime(r.rtd.age[c])} (${fmt(r.ageRel[c], 4)} τ)`;
        if (m.id === 'solids' && r.solids) t += `\nsolids ${fmt(r.solids.cv[c] * 100)} vol %  (${fmt(r.solRel[c])} × mean)`;
        showTip(ev, t);
      });
      cv.addEventListener('mouseleave', hideTip);
    }
  }
  function range(arr, zero, abs) {
    let lo = Infinity, hi = -Infinity;
    for (let q = 0; q < arr.length; q++) { const v = abs ? Math.abs(arr[q]) : arr[q]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (zero) lo = 0;
    if (!(hi > lo)) hi = lo + (Math.abs(lo) || 1) * 1e-3;
    return [lo, hi];
  }
  function drawMaps() {
    if (!result) return;
    for (const m of MAPS) {
      const fig = $('fig_' + m.id), field = m.get(result);
      const show = m.id === 'vec' || !!field;
      fig.hidden = !show;
      if (!show) continue;
      const spec = { overlay: m.overlay, unit: m.unit };
      if (field) { const [lo, hi] = range(field, m.zero, m.abs); spec.field = field; spec.min = lo; spec.max = m.id === 'solids' ? Math.min(hi, 5) : hi; }
      C.drawTank($('cv_' + m.id), result, spec);
    }
  }
  function drawPreview(solver) {
    const g = solver.g, Nr = g.Nr, Nz = g.Nz, sp = new Float64Array(Nr * Nz);
    let mx = 1e-9;
    for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) {
      const c = j * Nr + i, s = Math.hypot(0.5 * (solver.u[j * (Nr + 1) + i] + solver.u[j * (Nr + 1) + i + 1]), 0.5 * (solver.w[c] + solver.w[c + Nr]));
      sp[c] = s; if (s > mx) mx = s;
    }
    for (const m of MAPS) $('fig_' + m.id).hidden = m.id !== 'speed';
    C.drawTank($('cv_speed'), { g, flow: { bc: solver.bc } }, { field: sp, min: 0, max: mx, unit: 'm/s' });
  }

  // ---------- charts
  const charts = {};
  function chart(id, opt, tipFn) {
    const cv = $(id);
    charts[id] = { opt, tipFn };
    C.drawChart(cv, opt);
    if (!cv._wired) {
      cv._wired = true;
      cv.addEventListener('mousemove', (ev) => {
        const ch = charts[id], h = cv._chart && cv._chart(ev.clientX, ev.clientY);
        C.drawChart(cv, ch.opt, h || undefined);
        if (h) showTip(ev, ch.tipFn(h)); else hideTip();
      });
      cv.addEventListener('mouseleave', () => { C.drawChart(cv, charts[id].opt); hideTip(); });
    }
  }
  const S1 = '--series-1', REF = '--series-ref';

  function renderRtd(r) {
    const sec = $('secRtd'), rt = r.rtd;
    sec.hidden = !rt;
    if (!rt) return;
    const tau = rt.tau, hy = r.hydro;
    // E(theta)
    const xi = [], ei = [];
    for (let q = 0; q <= 200; q++) { const th = (4 * q) / 200; xi.push(th); ei.push(Math.exp(-th)); }
    const eMax = Math.min(Math.max(1.05, rt.Epeak * 1.05), 3);
    chart('chE', { series: [{ x: xi, y: ei, color: REF, dash: [5, 4], width: 1.5, label: 'Ideal' }, { x: rt.thE, y: rt.E, color: S1, label: 'Simulated' }], xMin: 0, xMax: 4, yMin: 0, yMax: eMax, xLabel: 'θ = t / τ', yLabel: 'E(θ)', height: 250 },
      (h) => `θ ${fmt(h.xv)}  (${fmtTime(h.xv * tau)})\n` + h.pts.map((p) => `${p.label.padEnd(10)}E ${fmt(p.y)}`).join('\n'));
    // F(t) log time
    const tLo = Math.max(rt.tFirst * 0.3, tau * 1e-4, rt.t[1]), tHi = 6 * tau, xf = [], ff = [];
    for (let q = 0; q <= 160; q++) { const t = tLo * Math.pow(tHi / tLo, q / 160); xf.push(t); ff.push(1 - Math.exp(-t / tau)); }
    chart('chF', { series: [{ x: xf, y: ff, color: REF, dash: [5, 4], width: 1.5, label: 'Ideal' }, { x: rt.t, y: rt.F, color: S1, label: 'Simulated' }], xLog: true, xMin: tLo, xMax: tHi, yMin: 0, yMax: 1, xLabel: 'time since step (s)', yLabel: 'F(t)', height: 250, xFmt: (v) => fmt(v, 1) },
      (h) => `t ${fmtTime(h.xv)}  (θ ${fmt(h.xv / tau)})\n` + h.pts.map((p) => `${p.label.padEnd(10)}F ${fmt(p.y)}`).join('\n'));
    // early bypass: feed leaving within one circulation time
    const Fat = (t) => { for (let q = 1; q < rt.t.length; q++) if (rt.t[q] >= t) return rt.F[q - 1] + ((t - rt.t[q - 1]) / (rt.t[q] - rt.t[q - 1])) * (rt.F[q] - rt.F[q - 1]); return 1; };
    const fEarly = Fat(hy.tCirc), fIdeal = 1 - Math.exp(-hy.tCirc / tau);
    r.bypass = Math.max(0, fEarly - fIdeal);
    let verdict;
    const turnovers = tau / hy.tCirc;
    if (rt.Epeak > 1.5 && r.bypass > 0.01) verdict = `Short-circuiting: ${fmt(fEarly * 100, 2)}% of the feed leaves within one circulation time (${fmtTime(hy.tCirc)}), against ${fmt(fIdeal * 100, 2)}% for an ideal CSTR. Move the feed or outlet apart, or raise agitation.`;
    else if (rt.mixedFraction < 0.9) verdict = `The tail decays faster than an ideal CSTR: about ${fmt((1 - rt.mixedFraction) * 100, 2)}% of the volume exchanges slowly with the main flow.`;
    else verdict = `Close to an ideal CSTR. The contents turn over about ${fmt(turnovers, 2)} times per residence time, so feed is blended long before it leaves.`;
    $('rtdVerdict').textContent = verdict;
    const rows = [
      ['Mean residence time', fmtTime(rt.tMean), fmtTime(tau) + ' (V/Q)'],
      ['Dimensionless variance σ<sub>θ</sub>²', fmt(rt.sigmaTheta2), '1'],
      ['Equivalent tanks in series', fmt(rt.nTanks), '1'],
      ['First tracer at outlet (0.1%)', fmtTime(rt.tFirst), fmtTime(0.001 * tau)],
      ['t<sub>10</sub> / τ', fmt(rt.t10 / tau), '0.105'],
      ['t<sub>50</sub> / τ', fmt(rt.t50 / tau), '0.693'],
      ['t<sub>90</sub> / τ', fmt(rt.t90 / tau), '2.30'],
      ['Peak E(θ)', `${fmt(rt.Epeak)} at θ = ${fmt(rt.thPeak, 2)}`, '1 at θ = 0'],
      ['Feed leaving within one circulation time', fmt(fEarly * 100, 2) + ' %', fmt(fIdeal * 100, 2) + ' %'],
      ['Well-mixed volume fraction (tail fit)', fmt(rt.mixedFraction), '1'],
      ['Local mean age, highest / average', `${fmt(rt.ageMax / tau, 4)} τ / ${fmt(rt.ageAvg / tau, 4)} τ`, '1 τ / 1 τ'],
    ];
    $('tblRtd').innerHTML = '<thead><tr><th>Metric</th><th class="n">Simulated</th><th class="n">Ideal CSTR</th></tr></thead><tbody>' + rows.map((x) => `<tr><td>${x[0]}</td><td class="n">${x[1]}</td><td class="n">${x[2]}</td></tr>`).join('') + '</tbody>';
  }

  function renderSolids(r) {
    const st = r.settling, so = r.solids, g = r.g, sec = $('secSolids');
    sec.hidden = !st.active;
    if (!st.active) return;
    const sus = r.suspension;
    let v = `<span class="pill ${sus.level}">${sus.label}.</span> `;
    if (st.Njs > 0) v += `The agitator runs at ${fmt(st.ratio * 100, 3)}% of the Zwietering just-suspended speed (${fmt(st.Njs * 60)} rpm). `;
    if (so) {
      v += `The suspended cloud reaches ${fmt(so.cloudHeight * 100, 3)}% of the liquid height`;
      if (so.hasOutlet) v += `, and the outlet draws slurry at ${fmt(so.outRatio)} × the tank-average concentration` + (so.outRatio < 0.9 ? ', so solids will accumulate in the tank' : so.outRatio > 1.1 ? ', so the tank will run leaner than the feed' : '');
      v += '.';
      if (so.packed) v += ' Part of the bottom is at packing density: a bed is forming.';
    }
    $('solVerdict').innerHTML = v;
    $('chS').closest('figure').hidden = !so;
    if (so) {
      const zs = [], cs = [];
      for (let j = 0; j < g.Nz; j++) { zs.push((j + 0.5) / g.Nz); cs.push(so.profile[j]); }
      const xMax = Math.max(1.5, Math.min(6, Math.max(...cs) * 1.08));
      chart('chS', { series: [{ x: [1, 1], y: [0, 1], color: REF, dash: [5, 4], width: 1.5, label: 'Uniform' }, { x: cs, y: zs, color: S1, label: 'Solids' }], xMin: 0, xMax, yMin: 0, yMax: 1, xLabel: 'concentration / tank average', yLabel: 'height z / H', height: 300, probe: 'y' },
        (h) => `z/H ${fmt(h.yv, 2)}  (${fmt(h.yv * g.H)} m)\n` + h.pts.filter((p) => p.label === 'Solids').map((p) => `${fmt(p.x)} × mean  (${fmt(p.x * st.cv * 100)} vol %)`).join('\n'));
    }
    const rows = [
      ['Terminal settling velocity (single particle)', fmt(st.vt * 1000) + ' mm/s'],
      ['Particle Reynolds number', fmt(st.ReP)],
      ['Hindered settling velocity at loading', fmt(st.vHind * 1000) + ' mm/s'],
      ['Richardson–Zaki exponent', fmt(st.nRZ)],
      ['Solids volume fraction', fmt(st.cv * 100) + ' vol %'],
      ['Slurry density', fmt(st.rhoSlurry) + ' kg/m³'],
      ['Zwietering constant S (estimated)', fmt(st.S)],
      ['Just-suspended speed N<sub>js</sub>', st.Njs > 0 ? fmt(st.Njs * 60) + ' rpm' : '–'],
      ['N / N<sub>js</sub>', st.Njs > 0 ? fmt(st.ratio) : '–'],
      ['Time to settle if the agitator stops', fmtTime(st.settleTime)],
    ];
    if (so) rows.push(
      ['Cloud height (50% of mean)', fmt(so.cloudHeight * 100, 3) + ' % H'],
      ['Concentration spread (RSD)', fmt(so.rsd * 100, 3) + ' %'],
      ['Peak bottom concentration', `${fmt(so.bottomRatio)} × mean (${fmt(so.bottomMax * 100)} vol %)`],
      ['Solids held in the lowest 10% of height', fmt(so.lowMassFraction * 100, 3) + ' %'],
    );
    if (so && so.hasOutlet) rows.push(['Outlet / tank-average concentration', fmt(so.outRatio)]);
    $('tblSol').innerHTML = '<thead><tr><th>Settling metric</th><th class="n">Value</th></tr></thead><tbody>' + rows.map((x) => `<tr><td>${x[0]}</td><td class="n">${x[1]}</td></tr>`).join('') + '</tbody>';
  }

  function renderKpis(r) {
    const g = r.g, hy = r.hydro, imp = g.imp, sus = r.suspension;
    const tiles = [
      ['Reynolds number', fmt(g.Re), hy.regime + ', tip speed ' + fmt(g.tip) + ' m/s'],
      ['Shaft power', hy.power >= 1000 ? fmt(hy.power / 1000) + ' <small>kW</small>' : fmt(hy.power) + ' <small>W</small>', `N<sub>p</sub> ${fmt(hy.Np)} (typical ${imp.np}) · ${fmt(hy.pv)} W/m³`],
      ['Impeller pumping', fmt(hy.Qimp * 3600) + ' <small>m³/h</small>', `N<sub>q</sub> ${fmt(hy.Nq)} (typical ${imp.nq})`],
      ['Circulation time', fmtTime(hy.tCirc), hy.blendValid ? `95% blend ≈ ${fmtTime(hy.blend95)} (Grenville)` : `peak speed ${fmt(hy.speedMax)} m/s`],
      ['Residence time τ', g.Q > 0 ? fmtTime(g.tau) : 'Batch', g.Q > 0 ? `V ${fmt(g.V)} m³ · ${fmt(g.tau / hy.tCirc, 2)} turnovers` : `V ${fmt(g.V)} m³`],
      ['Solids', `<span class="pill ${sus.level}">${r.settling.Njs > 0 ? 'N/N<sub>js</sub> ' + fmt(r.settling.ratio) : sus.level === 'none' ? 'None' : 'OK'}</span>`, sus.label],
    ];
    $('kpis').innerHTML = tiles.map((t) => `<div class="kpi"><span class="k">${t[0]}</span><span class="v">${t[1]}</span><span class="s">${t[2]}</span></div>`).join('');
  }

  function renderAll() {
    if (!result) return;
    renderKpis(result); drawMaps(); renderRtd(result); renderSolids(result);
  }

  // ---------- run
  function setBusy(b) {
    running = b;
    $('run').textContent = b ? 'Cancel' : 'Run simulation';
    $('run').classList.toggle('primary', !b);
    for (const id of ['kpis', 'secRtd', 'secSolids']) $(id).classList.toggle('dim', b);
    $('bar').hidden = !b;
  }
  async function run() {
    if (running) { cancel = true; return; }
    let p;
    try { p = readForm(); C.derive(p); } catch (e) { $('statusText').innerHTML = `<span class="err">${e.message}</span>`; return; }
    cancel = false; setBusy(true); $('stale').hidden = true;
    const bar = $('bar').firstElementChild;
    let lastPrev = 0;
    try {
      const r = await C.simulate(p, {
        cancelled: () => cancel,
        progress: (x, text, solver) => {
          bar.style.width = (x * 100).toFixed(1) + '%';
          $('statusText').textContent = `${text}… ${Math.round(x * 100)}%`;
          if (solver && Date.now() - lastPrev > 400) { lastPrev = Date.now(); drawPreview(solver); }
        },
      });
      if (r.rtd) { r.ageRel = Float64Array.from(r.rtd.age, (a) => a / r.rtd.tau); }
      if (r.solids) { r.solRel = Float64Array.from(r.solids.cv, (c) => c / r.settling.cv); }
      result = r; lastParams = JSON.stringify(p);
      setBusy(false);
      renderAll();
      const g = r.g;
      $('statusText').innerHTML = `Solved in ${fmt(r.wallSeconds, 2)} s · grid ${g.Nr} × ${g.Nz} · ${r.flow.steps.toLocaleString('en-US')} time steps · ` + (r.flow.converged ? 'flow converged' : '<span class="err">flow still drifting at the time limit; results are a time average</span>');
    } catch (e) {
      setBusy(false);
      if (e.message === 'cancelled') { $('statusText').textContent = 'Run cancelled.'; if (result) drawMaps(); }
      else { $('statusText').innerHTML = `<span class="err">${e.message}</span>`; console.error(e); }
    }
    if (rerun) { rerun = false; run(); }
  }

  // ---------- boot
  buildForm(); buildFigs(); setForm(C.DEFAULTS);
  $('form').addEventListener('submit', (ev) => { ev.preventDefault(); run(); });
  $('reset').addEventListener('click', () => { setForm(C.DEFAULTS); markStale(); });
  function markStale() { let s = null; try { s = JSON.stringify(readForm()); } catch (e) { s = ''; } $('stale').hidden = running || s === lastParams; }
  $('form').addEventListener('input', markStale);
  $('p_impType').addEventListener('change', () => {
    const im = C.IMPELLERS[$('p_impType').value];
    $('p_impBlades').value = im.blades; $('p_impWD').value = im.wd; $('p_impAngle').value = im.angle;
    syncAngle(); markStale();
  });
  $('p_impAngle').addEventListener('input', syncAngle);
  let rz = 0;
  const redraw = () => { clearTimeout(rz); rz = setTimeout(() => { if (result && !running) renderAll(); }, 120); };
  window.addEventListener('resize', redraw);
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('scroll', hideTip, { passive: true });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);
  run();
})();
