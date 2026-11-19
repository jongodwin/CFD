#!/usr/bin/env node
/* Regression and verification tests for the rotary kiln model. Run: node tests/run-tests.js */
'use strict';
const KM = require('../js/kiln-model.js');
const KP = require('../js/presets.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok    ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const preset = id => KP.clone(KP.PRESETS.find(p => p.id === id).data);
const C = T => T - 273.15;

function balanceChecks(label, r) {
  check(label + ': converged', r.ok && r.converged, r.ok ? 'residual ' + r.residual : r.errors.join('; '));
  if (!r.ok) return;
  const eRel = Math.abs(r.energy.closure) / r.energy.sumIn;
  const mRel = Math.abs(r.mass.closure) / r.mass.sumIn;
  check(label + ': energy balance closes (' + eRel.toExponential(1) + ')', eRel < 1e-6);
  check(label + ': mass balance closes (' + mRel.toExponential(1) + ')', mRel < 1e-9);
  const finite = r.cells.every(c => [c.Ts, c.Tg, c.Tw, c.Tsh].every(Number.isFinite));
  check(label + ': temperatures finite', finite);
  const nonneg = r.cells.every(c => c.F.every(f => f > -1e-9) && c.G.every(g => g > -1e-9));
  check(label + ': species flows non-negative', nonneg);
}

console.log('Formula and equation parsing');
check('CaCO3 molar mass', near(KM.parseFormula('CaCO3').mw, 100.086, 0.01));
check('Ca(OH)2 molar mass', near(KM.parseFormula('Ca(OH)2').mw, 74.09, 0.01));
check('CaSO4.2H2O molar mass', near(KM.parseFormula('CaSO4.2H2O').mw, 172.17, 0.02));
check('H2O(l) phase suffix ignored', near(KM.parseFormula('H2O(l)').mw, 18.015, 0.002));
check('unknown symbol rejected', KM.parseFormula('Xx2') === null);
const eq = KM.parseEquation('2 CO + O2 -> 2CO2');
check('equation coefficients', eq.length === 3 && eq[0].coef === -2 && eq[1].coef === -1 && eq[2].coef === 2 && eq[2].name === 'CO2');

console.log('Geometry');
for (const f of [0.03, 0.1, 0.25, 0.5]) {
  const g = KM.bedGeometry(1, KM.thetaFromFill(f));
  check('fill fraction round trip ' + f, near(g.fill, f, 1e-10));
}
{
  // Kramers: far from the dam the depth approaches the normal depth
  const R = 1.5, n = 1 / 60, a = Math.atan(0.025), b = 35 * Math.PI / 180, Q = 0.003;
  const fN = Math.pow(3 * Q * Math.sin(b) / (4 * Math.PI * n * R * R * R * Math.tan(a)), 2 / 3);
  const hN = R * (1 - Math.sqrt(1 - fN));
  const zc = Float64Array.from({ length: 50 }, (_, i) => (i + 0.5) * 2);
  const res = KM.kramersDepth(zc, () => Q, 100, R, n, a, b, 0.02);
  check('Kramers normal depth (' + res.depth[0].toFixed(4) + ' vs ' + hN.toFixed(4) + ' m)', near(res.depth[0], hN, 1e-4));
  check('Kramers depth falls toward a low dam', res.depth[49] < res.depth[0]);
}

console.log('Example cases');
for (const p of KP.PRESETS) {
  const r = KM.solve(KP.clone(p.data));
  balanceChecks(p.id, r);
  if (r.ok) console.log('        solids out ' + C(r.outlet.solids.T).toFixed(0) + ' C, gas out ' + C(r.outlet.gas.T).toFixed(0) + ' C, ' + r.elapsedMs + ' ms');
}
{
  const r = KM.solve(preset('lime'));
  const x = r.summary.conversions.find(c => c.name === 'CaCO3');
  check('lime: calcination complete', x && x.X > 0.99);
  check('lime: off-gas cooler than 400 C', C(r.outlet.gas.T) < 400);
  check('lime: shell below 350 C', C(r.summary.maxShellT) < 350);
}

console.log('Flow configurations and options');
{
  const inp = preset('lime'); inp.gas.direction = 'co';
  balanceChecks('lime co-current', KM.solve(inp));
}
{
  const inp = preset('lime'); inp.burner.enabled = false;
  inp.gas.inlet = { flow: 25000, T: 1300, composition: { N2: 72, O2: 8, CO2: 8, H2O: 12 } };
  balanceChecks('lime hot gas only', KM.solve(inp));
}
{
  const inp = preset('lime'); inp.kiln.bedModel = 'fill'; inp.heatTransfer.convModel = 'db';
  inp.heatTransfer.wallSolidModel = 'const'; inp.wall.extMode = 'constant'; inp.burner.profile = 'front';
  balanceChecks('lime alternative correlations', KM.solve(inp));
}
{
  const inp = preset('dryer'); inp.gas.direction = 'counter';
  balanceChecks('dryer counter-current', KM.solve(inp));
}
{
  const inp = preset('dryer'); inp.reactions[0].order = 0; inp.reactions[0].A = 2e9;
  balanceChecks('dryer zero-order drying', KM.solve(inp));
}
{
  // gas-phase reaction plus a gas-solid reaction with a gas reactant
  const inp = preset('dryer');
  inp.species.push({ name: 'CO', phase: 'gas', mw: 28.010, cp: [21.89419, 16.92337, -6.9387, 1.02082, 0.26013] });
  inp.species.push({ name: 'C', phase: 'solid', mw: 12.011, cp: [17.15, 4.27, 0, 0, -0.879] });
  inp.solids.composition = { SiO2: 90, 'H2O(l)': 8, C: 2 };
  inp.gas.inlet.composition = { N2: 74, O2: 12, CO2: 4, H2O: 9, CO: 1 };
  inp.reactions.push({ name: 'CO burnout', equation: 'CO + 0.5 O2 -> CO2', key: 'CO', order: 1, A: 1e9, Ea: 125, dH: -283, enabled: true });
  inp.reactions.push({ name: 'Carbon burnout', equation: 'C + O2 -> CO2', key: 'C', order: 1, A: 5e4, Ea: 110, dH: -393.5, enabled: true });
  balanceChecks('gas-phase and gas-solid reactions', KM.solve(inp));
}
{
  const inp = preset('lime'); inp.burner.flameLength = 80;
  const r = KM.solve(inp);
  check('flame longer than kiln warns', r.ok && r.warnings.some(w => /longer than the kiln/.test(w)));
}
{
  const inp = preset('dryer'); inp.gas.inlet.flow = 0;
  const r = KM.solve(inp);
  check('no gas inlet adds a trace purge', r.ok && r.warnings.some(w => /trace purge/.test(w)));
}
{
  const inp = preset('lime'); inp.reactions[0].equation = 'H2O(l) -> Steam';
  const r = KM.solve(inp);
  check('undefined species reported', !r.ok && r.errors.some(e => /Steam/.test(e)));
}

console.log('Verification against closed-form results');
{
  // Isothermal kiln: everything at 600 C, ambient at 600 C, and a reaction whose
  // heat of reaction is zero at every temperature (reactant and product share cp).
  // The cell-in-series conversion must match the exact recursion.
  for (const order of [1, 0]) {
    const T = 600;
    const inp = preset('dryer');
    inp.solids.feedT = T; inp.gas.inlet.T = T; inp.wall.ambientT = T;
    inp.solids.composition = { SiO2: 80, 'H2O(l)': 20 };
    inp.kiln.cells = 60;
    inp.heatTransfer.lifterUa = 0;
    inp.species.find(sp => sp.name === 'H2O(l)').cp = inp.species.find(sp => sp.name === 'H2O').cp.slice();
    const k = order === 1 ? 3e-3 : 6e-5;
    const Ea = 0;
    inp.reactions = [{ name: 'R', equation: 'H2O(l) -> H2O', key: 'H2O(l)', order, A: k, Ea, dH: 0, enabled: true }];
    const r = KM.solve(inp);
    const m = KM.buildModel(inp);
    // independent recursion
    const Ms = m.rhoBulk * m.geo[0].Ab, dz = m.dz;
    const mwW = 18.015e-3, mwS = 60.083e-3;
    const Fsi = m.FsIn[0];
    let Fw = m.FsIn[1];
    const rateOf = F => {
      const ms = Fsi * mwS + F * mwW, w = F * mwW / ms;
      return order === 1 ? k * Ms * F / ms : k * Ms / mwW * (w / (w + 1e-5));
    };
    for (let c = 0; c < m.N; c++) {
      // g(F) = F - Fw + dz*rate(F) is increasing in F: bisection on [0, Fw]
      let lo = 0, hi = Fw;
      for (let it = 0; it < 200; it++) {
        const mid = 0.5 * (lo + hi);
        if (mid - Fw + dz * rateOf(mid) > 0) hi = mid; else lo = mid;
      }
      Fw = 0.5 * (lo + hi);
    }
    const got = r.outlet.solids.F[1];
    const isoT = r.cells.every(c => Math.abs(c.Ts - (T + 273.15)) < 1e-6 && Math.abs(c.Tg - (T + 273.15)) < 1e-6);
    check('isothermal kiln stays isothermal (order ' + order + ')', isoT);
    check('order ' + order + ' conversion matches recursion (' + got.toExponential(4) + ' vs ' + Fw.toExponential(4) + ')',
      near(got, Fw, 1e-7 * m.FsIn[1]));
  }
}
{
  // Grid convergence of outlet temperatures
  const a = preset('dryer'); a.kiln.cells = 75;
  const b = preset('dryer'); b.kiln.cells = 600;
  const ra = KM.solve(a), rb = KM.solve(b);
  const dTs = Math.abs(ra.outlet.solids.T - rb.outlet.solids.T), dTg = Math.abs(ra.outlet.gas.T - rb.outlet.gas.T);
  check('dryer grid sensitivity under 3 K (solids ' + dTs.toFixed(2) + ' K, gas ' + dTg.toFixed(2) + ' K)', dTs < 3 && dTg < 3);
}
{
  // Second law in co-current flow: gas leaves hotter than or equal to the solids it heats
  const r = KM.solve(preset('dryer'));
  check('co-current gas leaves at or above solids temperature', r.outlet.gas.T >= r.outlet.solids.T - 1e-6);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
