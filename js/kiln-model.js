/*
 * Rotary kiln 1-D steady-state heat and mass balance model.
 *
 * Works in the browser (global `KilnModel`) and in Node (`require`).
 *
 * Discretisation: the kiln is split into N axial cells. Each cell holds a
 * well-mixed slice of the solids bed and of the freeboard gas ("cells in
 * series"). Solids always move from the feed end (z = 0) to the discharge end
 * (z = L). Gas moves either the same way (co-current) or the opposite way
 * (counter-current). Every cell carries 4 + ns + ng unknowns:
 *   Ts, Tg, Tw (inner wall), Tsh (shell), solid species molar flows,
 *   gas species molar flows.
 * Energy is written as sensible-enthalpy fluxes plus reaction heat at 25 C,
 * so the discrete energy balance closes exactly at convergence.
 * The whole block-tridiagonal system is solved at once with Newton's method
 * and pseudo-transient continuation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.KilnModel = factory();
    // source text lets the page start the solver in a Web Worker without a separate file
    root.KilnModel.factorySource = '(' + factory.toString() + ')';
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RU = 8.314462618;          // J/(mol K)
  const SIGMA = 5.670374419e-8;    // W/(m2 K4)
  const TREF = 298.15;             // K, reference temperature for enthalpy
  const P_ATM = 101325;            // Pa
  const GRAV = 9.80665;            // m/s2
  const NM3_MOL = P_ATM / (RU * 273.15); // mol per normal m3 (0 C, 1 atm)

  // ---------------------------------------------------------------------------
  // Chemical formulae
  // ---------------------------------------------------------------------------
  const ATOMIC = {
    H: 1.008, He: 4.0026, Li: 6.94, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998,
    Na: 22.990, Mg: 24.305, Al: 26.982, Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, Ar: 39.948,
    K: 39.098, Ca: 40.078, Ti: 47.867, V: 50.942, Cr: 51.996, Mn: 54.938, Fe: 55.845, Co: 58.933,
    Ni: 58.693, Cu: 63.546, Zn: 65.38, Sr: 87.62, Zr: 91.224, Mo: 95.95, Ba: 137.327, Pb: 207.2,
    U: 238.03, W: 183.84, Sn: 118.71, Ag: 107.87, Au: 196.97, Pt: 195.08, Nb: 92.906, La: 138.91, Ce: 140.12
  };

  function parseGroup(s) {
    const stack = [{}];
    let i = 0;
    const readNum = () => {
      const m = /^\d+(\.\d+)?/.exec(s.slice(i));
      if (!m) return 1;
      i += m[0].length;
      return parseFloat(m[0]);
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '(' || ch === '[') { stack.push({}); i++; continue; }
      if (ch === ')' || ch === ']') {
        i++;
        const n = readNum();
        const top = stack.pop();
        if (!stack.length) return null;
        const t = stack[stack.length - 1];
        for (const e in top) t[e] = (t[e] || 0) + top[e] * n;
        continue;
      }
      const m = /^[A-Z][a-z]?/.exec(s.slice(i));
      if (!m || !(m[0] in ATOMIC)) return null;
      i += m[0].length;
      const n = readNum();
      const t = stack[stack.length - 1];
      t[m[0]] = (t[m[0]] || 0) + n;
    }
    if (stack.length !== 1) return null;
    return stack[0];
  }

  /** Parse a chemical formula such as "CaCO3", "Ca(OH)2", "CaSO4.2H2O", "H2O(l)". */
  function parseFormula(name) {
    let s = String(name || '').trim().replace(/\s*\((s|l|g|aq|c|cr)\)$/i, '').trim();
    if (!s) return null;
    const parts = s.split(/[·*.]/);
    const total = {};
    for (let p of parts) {
      let mult = 1;
      const mm = /^(\d+(?:\.\d+)?)(.+)$/.exec(p);
      if (mm) { mult = parseFloat(mm[1]); p = mm[2]; }
      const el = parseGroup(p);
      if (!el || !Object.keys(el).length) return null;
      for (const e in el) total[e] = (total[e] || 0) + mult * el[e];
    }
    let mw = 0;
    for (const e in total) mw += ATOMIC[e] * total[e];
    return { elements: total, mw };
  }

  /** Parse "CaCO3 -> CaO + CO2" into [{name, coef}] with reactants negative. */
  function parseEquation(eq) {
    const sides = String(eq || '').split(/<=>|->|=>|→|=/);
    if (sides.length !== 2) throw new Error('Equation must contain one "->"');
    const terms = [];
    sides.forEach((side, si) => {
      const sign = si === 0 ? -1 : 1;
      side.split('+').forEach(raw => {
        const t = raw.trim();
        if (!t) throw new Error('Empty term in equation');
        const m = /^(\d*\.?\d+(?:[eE][-+]?\d+)?)?\s*\*?\s*(\S.*)$/.exec(t);
        let coef = 1, name = t;
        if (m && m[1] !== undefined && m[2] && /^[A-Za-z(\[]/.test(m[2])) { coef = parseFloat(m[1]); name = m[2].trim(); }
        if (!(coef > 0)) throw new Error('Bad coefficient in "' + t + '"');
        terms.push({ name, coef: sign * coef });
      });
    });
    return terms;
  }

  // ---------------------------------------------------------------------------
  // Thermodynamic and transport properties
  // ---------------------------------------------------------------------------
  // Heat capacity in Shomate form: cp = A + B t + C t^2 + D t^3 + E / t^2 (J/mol K), t = T/1000.
  const T_LO = 250, T_HI = 3000; // heat capacities are held constant outside this range
  function cpRaw(c, T) { const t = T / 1000; return c[0] + t * (c[1] + t * (c[2] + t * c[3])) + c[4] / (t * t); }
  function hRaw(c, T) { const t = T / 1000; return 1000 * (t * (c[0] + t * (c[1] / 2 + t * (c[2] / 3 + t * c[3] / 4))) - c[4] / t); }
  const H_REF_CACHE = new WeakMap();
  function hRef(c) { let v = H_REF_CACHE.get(c); if (v === undefined) { v = hRaw(c, TREF); H_REF_CACHE.set(c, v); } return v; }
  function cpMol(c, T) {
    if (T < T_LO) T = T_LO; else if (T > T_HI) T = T_HI;
    return cpRaw(c, T);
  }
  /** Sensible enthalpy J/mol relative to 298.15 K (linear extension outside 250-5000 K). */
  function dhMol(c, T) {
    if (T < T_LO) return hRaw(c, T_LO) - hRef(c) + cpRaw(c, T_LO) * (T - T_LO);
    if (T > T_HI) return hRaw(c, T_HI) - hRef(c) + cpRaw(c, T_HI) * (T - T_HI);
    return hRaw(c, T) - hRef(c);
  }
  // Air-like transport properties for the kiln gas.
  function muGas(T) { return 1.716e-5 * Math.pow(T / 273.15, 1.5) * (273.15 + 110.4) / (T + 110.4); }
  function kGas(T) { return 0.0241 * Math.pow(T / 273.15, 0.81); }
  function cpAirMass(T) { return 1000 * (28.11 + 0.1967e-2 * T + 0.4802e-5 * T * T - 1.966e-9 * T * T * T) / 28.965; }

  /** Exterior convection: Churchill-Chu natural + Churchill-Bernstein wind cross-flow. */
  function hExterior(Tsh, Ta, Do, wind) {
    const Tf = 0.5 * (Tsh + Ta);
    const mu = muGas(Tf), k = kGas(Tf), cp = cpAirMass(Tf);
    const rho = P_ATM * 0.028965 / (RU * Tf);
    const nu = mu / rho, alpha = k / (rho * cp), Pr = mu * cp / k;
    const dT = Math.sqrt((Tsh - Ta) * (Tsh - Ta) + 1);
    const Ra = GRAV * dT * Do * Do * Do / (Tf * nu * alpha);
    const a = 0.6 + 0.387 * Math.pow(Ra, 1 / 6) / Math.pow(1 + Math.pow(0.559 / Pr, 9 / 16), 8 / 27);
    const Nun = a * a;
    let Nuf = 0;
    if (wind > 0) {
      const Re = wind * Do / nu;
      Nuf = 0.3 + 0.62 * Math.sqrt(Re) * Math.cbrt(Pr) / Math.pow(1 + Math.pow(0.4 / Pr, 2 / 3), 0.25) *
        Math.pow(1 + Math.pow(Re / 282000, 5 / 8), 4 / 5);
    }
    const Nu = Math.cbrt(Nun * Nun * Nun + Nuf * Nuf * Nuf);
    return Nu * k / Do;
  }

  // ---------------------------------------------------------------------------
  // Bed geometry
  // ---------------------------------------------------------------------------
  function thetaFromFill(eta) {
    eta = Math.min(Math.max(eta, 1e-6), 0.999);
    const target = 2 * Math.PI * eta;
    let lo = 0, hi = 2 * Math.PI;
    let th = Math.min(Math.cbrt(12 * target), 2 * Math.PI - 1e-3);
    for (let it = 0; it < 60; it++) {
      const f = th - Math.sin(th) - target;
      if (f > 0) hi = th; else lo = th;
      const d = 1 - Math.cos(th);
      let nt = d > 1e-12 ? th - f / d : 0.5 * (lo + hi);
      if (!(nt > lo && nt < hi)) nt = 0.5 * (lo + hi);
      if (Math.abs(nt - th) < 1e-14) { th = nt; break; }
      th = nt;
    }
    return th;
  }
  function bedGeometry(R, theta) {
    const Ab = 0.5 * R * R * (theta - Math.sin(theta));
    const chord = 2 * R * Math.sin(theta / 2);
    const arcCov = R * theta;
    const arcExp = R * (2 * Math.PI - theta);
    const Ag = Math.PI * R * R - Ab;
    return {
      theta, Ab, chord, arcCov, arcExp, Ag,
      De: 4 * Ag / (arcExp + chord),
      fill: Ab / (Math.PI * R * R),
      depth: R * (1 - Math.cos(theta / 2))
    };
  }

  /**
   * Kramers & Croockewit (1952) bed depth profile, integrated from the
   * discharge end (h = hEnd) back to the feed end.
   * dh/dx = tan(b) [ tan(a)/sin(b) - 3 Q / (4 pi n R^3) (2h/R - h^2/R^2)^(-3/2) ]
   */
  function kramersDepth(zc, phiAt, L, R, nRps, alpha, beta, hEnd) {
    const tb = Math.tan(beta), ta = Math.tan(alpha), sb = Math.sin(beta);
    const c0 = 3 / (4 * Math.PI * nRps * R * R * R);
    let overload = false;
    const hMax = 0.999 * R, hMin = 1e-5 * R;
    const f = (z, h) => {
      const hr = Math.min(Math.max(h, hMin), hMax) / R;
      const ff = 2 * hr - hr * hr;
      return tb * (ta / sb - c0 * phiAt(z) * Math.pow(ff, -1.5));
    };
    const rk4 = (z, h, dz) => {
      const k1 = f(z, h);
      const k2 = f(z + dz / 2, h + dz / 2 * k1);
      const k3 = f(z + dz / 2, h + dz / 2 * k2);
      const k4 = f(z + dz, h + dz * k3);
      return h + dz / 6 * (k1 + 2 * k2 + 2 * k3 + k4);
    };
    const clampH = h => { if (h > hMax) { overload = true; return hMax; } return Math.max(h, hMin); };
    const out = new Float64Array(zc.length);
    let z = L, h = clampH(Math.max(hEnd, hMin));
    let step = -L / 400;
    const tol = 1e-7 * R;
    for (let j = zc.length - 1; j >= 0; j--) {
      const target = zc[j];
      let guard = 0;
      while (z > target + 1e-12 && guard++ < 200000) {
        const dz = Math.max(step, target - z);
        const hFull = rk4(z, h, dz);
        const hHalf = rk4(z + dz / 2, rk4(z, h, dz / 2), dz / 2);
        const err = Math.abs(hHalf - hFull);
        if (err > tol && Math.abs(dz) > 1e-9 * L) { step = dz / 2; continue; }
        z += dz;
        h = clampH(hHalf + (hHalf - hFull) / 15);
        if (err < tol / 20) step = Math.max(step * 2, -L / 50);
      }
      out[j] = h;
    }
    return { depth: out, overload };
  }

  // ---------------------------------------------------------------------------
  // Model construction from user input
  // ---------------------------------------------------------------------------
  const num = (v, d) => { const x = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(x) ? x : d; };

  function flameCdf(profile, s, Lf) {
    const u = Math.min(Math.max(s / Lf, 0), 1);
    if (profile === 'bell') return 0.5 * (1 - Math.cos(Math.PI * u));
    if (profile === 'front') return (1 - Math.exp(-3 * u)) / (1 - Math.exp(-3));
    return u;
  }

  function buildModel(input) {
    const errors = [], warnings = [];
    const K = input.kiln || {}, W = input.wall || {}, S = input.solids || {}, Gi = input.gas || {};
    const B = input.burner || {}, HT = input.heatTransfer || {};

    // ---- species ----
    const species = (input.species || []).map(s => ({
      name: String(s.name || '').trim(), phase: s.phase === 'gas' ? 'gas' : 'solid',
      mw: num(s.mw, NaN), cp: (s.cp || [0, 0, 0, 0, 0]).slice(0, 5).map(v => num(v, 0))
    }));
    while (species.some(s => s.cp.length < 5)) species.forEach(s => { while (s.cp.length < 5) s.cp.push(0); });
    const names = new Set();
    species.forEach(s => {
      if (!s.name) errors.push('Every species needs a name.');
      else if (names.has(s.name)) errors.push('Species "' + s.name + '" is listed twice.');
      names.add(s.name);
      if (!(s.mw > 0)) errors.push('Species "' + s.name + '" needs a molar mass above zero.');
      const c1000 = cpRaw(s.cp, 1000), c300 = cpRaw(s.cp, 300);
      if (!(c1000 > 0) || !(c300 > 0)) errors.push('Heat capacity of "' + s.name + '" is not positive between 300 and 1000 K.');
    });
    const solidIdx = [], gasIdx = [];
    species.forEach((s, i) => { (s.phase === 'gas' ? gasIdx : solidIdx).push(i); s.local = (s.phase === 'gas' ? gasIdx : solidIdx).length - 1; });
    const ns = solidIdx.length, ng = gasIdx.length;
    if (!ns) errors.push('Define at least one solid species.');
    if (!ng) errors.push('Define at least one gas species.');
    const byName = {};
    species.forEach((s, i) => { byName[s.name] = i; });
    const findSpecies = nm => {
      if (nm in byName) return byName[nm];
      const low = String(nm).toLowerCase();
      for (const k in byName) if (k.toLowerCase() === low) return byName[k];
      return -1;
    };

    // ---- geometry ----
    const L = num(K.length, 0), D = num(K.diameter, 0);
    if (!(L > 0)) errors.push('Kiln length must be above zero.');
    if (!(D > 0)) errors.push('Kiln internal diameter must be above zero.');
    const R = D / 2;
    const N = Math.round(Math.min(Math.max(num(K.cells, 200), 10), 2000));
    const dz = L / N;
    const rpm = num(K.rpm, 1);
    if (!(rpm > 0)) errors.push('Rotation speed must be above zero.');
    const omega = 2 * Math.PI * rpm / 60;
    const slopePct = num(K.slope, 3);
    const alpha = Math.atan(slopePct / 100);
    const beta = num(K.repose, 35) * Math.PI / 180;

    // ---- wall ----
    let r = R, Rcond = 0;
    const layers = (W.layers || []).map(l => ({ name: l.name, t: num(l.thickness, 0), k: num(l.k, 1) }));
    layers.forEach(l => {
      if (!(l.t > 0) || !(l.k > 0)) { errors.push('Wall layer "' + (l.name || '?') + '" needs thickness and conductivity above zero.'); return; }
      Rcond += Math.log((r + l.t) / r) / (2 * Math.PI * l.k);
      r += l.t;
    });
    if (!layers.length) errors.push('Add at least one wall layer.');
    const Ro = r;
    const Ta = num(W.ambientT, 25) + 273.15;
    const epsWall = Math.min(Math.max(num(W.emissivity, 0.85), 0.01), 0.999);
    const epsShell = Math.min(Math.max(num(W.shellEmissivity, 0.8), 0), 1);
    const extMode = W.extMode === 'constant' ? 'constant' : 'correlation';
    const hExtConst = num(W.hExt, 15), wind = Math.max(num(W.wind, 0), 0);

    // ---- solids feed ----
    const msIn = num(S.feedRate, 0) / 3.6;           // t/h -> kg/s
    if (!(msIn > 0)) errors.push('Solids feed rate must be above zero.');
    const TsIn = num(S.feedT, 25) + 273.15;
    const rhoBulk = num(S.bulkDensity, 1500);
    if (!(rhoBulk > 0)) errors.push('Bulk density must be above zero.');
    const epsBed = Math.min(Math.max(num(S.emissivity, 0.9), 0.01), 0.999);
    const kBed = num(S.bedConductivity, 0.3);
    const comp = S.composition || {};
    let wsum = 0;
    const wIn = new Float64Array(ns);
    solidIdx.forEach((gi, j) => { const v = Math.max(num(comp[species[gi].name], 0), 0); wIn[j] = v; wsum += v; });
    if (!(wsum > 0)) errors.push('Feed composition is empty: give at least one solid species a mass fraction.');
    else if (Math.abs(wsum - 100) > 0.05) warnings.push('Feed composition sums to ' + wsum.toFixed(2) + ' %; it was normalised to 100 %.');
    const FsIn = new Float64Array(ns);
    for (let j = 0; j < ns; j++) { wIn[j] = wsum > 0 ? wIn[j] / wsum : 0; FsIn[j] = msIn * wIn[j] / (species[solidIdx[j]].mw / 1000); }

    // ---- gas inlet streams ----
    const P = num(Gi.pressure, 101.325) * 1000;
    const flowDir = Gi.direction === 'co' ? 'co' : 'counter';
    const epsGas = Math.min(Math.max(num(Gi.emissivity, 0.2), 0), 0.999);
    const streams = [];
    const inl = Gi.inlet || {};
    const hotMol = Math.max(num(inl.flow, 0), 0) * NM3_MOL / 3600;
    if (hotMol > 0) {
      const y = new Float64Array(ng); let ysum = 0;
      gasIdx.forEach((gi, j) => { const v = Math.max(num((inl.composition || {})[species[gi].name], 0), 0); y[j] = v; ysum += v; });
      if (!(ysum > 0)) errors.push('Inlet hot gas has a flow but no composition.');
      else if (Math.abs(ysum - 100) > 0.05) warnings.push('Inlet gas composition sums to ' + ysum.toFixed(2) + ' %; it was normalised to 100 %.');
      const G = new Float64Array(ng);
      for (let j = 0; j < ng; j++) G[j] = ysum > 0 ? hotMol * y[j] / ysum : 0;
      streams.push({ name: 'Hot gas inlet', G, T: num(inl.T, 25) + 273.15 });
    }

    // ---- burner ----
    let burner = null;
    if (B.enabled) {
      const fuelIdx = findSpecies(B.fuel);
      const firing = num(B.firing, 0) * 1e6;
      const lhv = num(B.lhv, 50) * 1e6; // J/kg
      const Lf = num(B.flameLength, 10);
      if (fuelIdx < 0 || species[fuelIdx].phase !== 'gas') errors.push('Burner fuel "' + B.fuel + '" must be one of the gas species.');
      else if (!(firing >= 0) || !(lhv > 0)) errors.push('Burner firing rate and fuel heating value must be positive.');
      else if (!(Lf > 0)) errors.push('Flame length must be above zero.');
      else {
        const fuel = species[fuelIdx];
        const fm = parseFormula(fuel.name);
        if (!fm) errors.push('Burner fuel "' + fuel.name + '" must be named by its chemical formula (e.g. CH4) so the combustion air can be worked out.');
        else {
          const el = fm.elements;
          const nC = el.C || 0, nH = el.H || 0, nO = el.O || 0, nN = el.N || 0, nS = el.S || 0;
          const o2Stoich = nC + nH / 4 + nS - nO / 2;
          const need = { O2: o2Stoich > 0, CO2: nC > 0, H2O: nH > 0, SO2: nS > 0, N2: true };
          const loc = {};
          for (const nm in need) {
            const i = findSpecies(nm);
            if (i >= 0 && species[i].phase === 'gas') loc[nm] = species[i].local;
            else if (need[nm]) errors.push('The burner needs a gas species named ' + nm + '.');
          }
          if (o2Stoich <= 0) errors.push('Burner fuel needs oxygen to burn; check its formula.');
          if (!errors.length) {
            const excess = num(B.excessAir, 10) / 100;
            if (excess < 0) warnings.push('Excess air is negative: the flame is fuel-rich and some fuel will leave unburnt.');
            const Ffuel = firing / (lhv * fuel.mw / 1000);
            const airO2 = Math.max(Ffuel * o2Stoich * (1 + excess), 0);
            const nu = new Float64Array(ng);
            nu[fuel.local] -= 1;
            nu[loc.O2] -= o2Stoich;
            if (nC) nu[loc.CO2] += nC;
            if (nH) nu[loc.H2O] += nH / 2;
            if (nS) nu[loc.SO2] += nS;
            if (nN) nu[loc.N2] += nN / 2;
            const Gair = new Float64Array(ng);
            Gair[loc.O2] += airO2; Gair[loc.N2] += airO2 * 79 / 21;
            streams.push({ name: 'Combustion air', G: Gair, T: num(B.airT, 25) + 273.15 });
            const Gf = new Float64Array(ng); Gf[fuel.local] = Ffuel;
            streams.push({ name: 'Fuel', G: Gf, T: num(B.fuelT, 25) + 273.15 });
            const profile = ['uniform', 'bell', 'front'].includes(B.profile) ? B.profile : 'uniform';
            // burned fraction and flame-zone fraction per cell
            const frac = new Float64Array(N), chi = new Float64Array(N);
            for (let k = 0; k < N; k++) {
              const z0 = k * dz, z1 = (k + 1) * dz;
              const s0 = flowDir === 'counter' ? L - z1 : z0, s1 = flowDir === 'counter' ? L - z0 : z1;
              frac[k] = flameCdf(profile, s1, Lf) - flameCdf(profile, s0, Lf);
              chi[k] = Math.max(0, Math.min(s1, Lf) - Math.max(s0, 0)) / dz;
            }
            if (Lf > L) warnings.push('The flame is longer than the kiln; ' + ((1 - flameCdf(profile, L, Lf)) * 100).toFixed(1) + ' % of the fuel leaves unburnt.');
            burner = {
              fuelLocal: fuel.local, fuelName: fuel.name, Ffuel, nu, o2Local: loc.O2,
              dH: -lhv * fuel.mw / 1000, firing, frac, chi, Lf, profile, airO2,
              epsFlame: Math.min(Math.max(num(B.flameEmissivity, 0.5), 0), 0.999), excess
            };
          }
        }
      }
    }

    const GIn = new Float64Array(ng);
    streams.forEach(st => { for (let j = 0; j < ng; j++) GIn[j] += st.G[j]; });
    let gTot = 0; for (let j = 0; j < ng; j++) gTot += GIn[j];
    if (!(gTot > 1e-9) && ng) {
      // A trace purge keeps the gas equations well posed.
      const n2 = findSpecies('N2');
      const j = n2 >= 0 && species[n2].phase === 'gas' ? species[n2].local : 0;
      const G = new Float64Array(ng); G[j] = 1e-6 * Math.max(1, msIn);
      streams.push({ name: 'Trace purge', G, T: TsIn });
      GIn[j] += G[j];
      warnings.push('No gas enters the kiln, so a trace purge of ' + species[gasIdx[j]].name + ' was added to keep the gas balance solvable.');
    }

    // ---- reactions ----
    const reactions = [];
    (input.reactions || []).forEach((rx, ri) => {
      if (rx.enabled === false) return;
      const label = rx.name || ('Reaction ' + (ri + 1));
      let terms;
      try { terms = parseEquation(rx.equation); } catch (e) { errors.push(label + ': ' + e.message); return; }
      const nu = new Float64Array(species.length);
      let bad = false;
      terms.forEach(t => {
        const i = findSpecies(t.name);
        if (i < 0) { errors.push(label + ': species "' + t.name + '" is not defined.'); bad = true; return; }
        nu[i] += t.coef;
      });
      if (bad) return;
      const key = findSpecies(rx.key);
      if (key < 0 || !(nu[key] < 0)) { errors.push(label + ': the key reactant must be one of the reactants.'); return; }
      let mIn = 0, mOut = 0;
      for (let i = 0; i < species.length; i++) { if (nu[i] < 0) mIn -= nu[i] * species[i].mw; else mOut += nu[i] * species[i].mw; }
      if (Math.abs(mIn - mOut) > 0.005 * Math.max(mIn, mOut)) warnings.push(label + ': equation is not mass balanced (' + mIn.toFixed(2) + ' g in, ' + mOut.toFixed(2) + ' g out).');
      const order = num(rx.order, 1) === 0 ? 0 : 1;
      const A = num(rx.A, 0), Ea = num(rx.Ea, 0) * 1000, dH = num(rx.dH, 0) * 1000;
      if (!(A >= 0)) { errors.push(label + ': pre-exponential factor must not be negative.'); return; }
      const reactants = [];
      for (let i = 0; i < species.length; i++) if (nu[i] < 0 && i !== key) reactants.push(i);
      const list = [];
      for (let i = 0; i < species.length; i++) if (nu[i] !== 0) list.push(i);
      reactions.push({
        name: label, equation: rx.equation, nu, key, keyPhase: species[key].phase, nuKey: -nu[key],
        order, A, Ea, dH, reactants, list
      });
    });

    // ---- heat transfer options ----
    const ht = {
      conv: ['tw', 'db', 'const'].includes(HT.convModel) ? HT.convModel : 'tw',
      hgw: num(HT.hgw, 15), hgs: num(HT.hgs, 20), mult: num(HT.convMult, 1),
      ws: HT.wallSolidModel === 'const' ? 'const' : 'penetration',
      hws: num(HT.hws, 150), hContact: num(HT.hContact, 500),
      uaVol: Math.max(num(HT.lifterUa, 0), 0), liftStart: num(HT.lifterStart, 0), liftEnd: num(HT.lifterEnd, 0)
    };
    if (ht.uaVol > 0 && !(ht.liftEnd > ht.liftStart)) warnings.push('The lifter/chain zone ends before it starts, so it has no effect.');

    // ---- bed model ----
    const bedModel = K.bedModel === 'fill' ? 'fill' : 'kramers';
    const fillFrac = num(K.fill, 10) / 100;
    if (bedModel === 'fill' && !(fillFrac > 0 && fillFrac < 0.6)) errors.push('Fill fraction must be between 0 and 60 %.');
    const damHeight = Math.max(num(K.damHeight, 0), 0);
    if (bedModel === 'kramers' && !(beta > alpha)) errors.push('Dynamic angle of repose must exceed the kiln slope angle.');

    const model = {
      errors, warnings, species, solidIdx, gasIdx, ns, ng, N, L, dz, R, D, Ro, Rcond, omega, rpm, alpha, beta,
      Ta, epsWall, epsShell, extMode, hExtConst, wind, msIn, TsIn, rhoBulk, epsBed, kBed, FsIn, wIn,
      P, flowDir, epsGas, streams, burner, GIn, reactions, ht, bedModel, fillFrac, damHeight, layers
    };
    if (errors.length) return model;

    // inlet enthalpy fluxes
    model.HsIn = sensSolidsArr(model, TsIn, FsIn, 0);
    let HgIn = 0;
    streams.forEach(st => { HgIn += sensGasArr(model, st.T, st.G, 0); });
    model.HgIn = HgIn;
    model.TgInMix = gasTemperatureFromH(model, HgIn, GIn);
    model.zc = new Float64Array(N);
    for (let k = 0; k < N; k++) model.zc[k] = (k + 0.5) * dz;
    // fraction of each cell inside the lifter/chain zone
    model.liftFrac = new Float64Array(N);
    if (ht.uaVol > 0) for (let k = 0; k < N; k++) {
      const z0 = k * dz, z1 = z0 + dz;
      model.liftFrac[k] = Math.max(0, Math.min(z1, ht.liftEnd) - Math.max(z0, ht.liftStart)) / dz;
    }
    // flame emissivity per cell
    model.epsG = new Float64Array(N);
    for (let k = 0; k < N; k++) model.epsG[k] = burner ? epsGas + burner.chi[k] * Math.max(burner.epsFlame - epsGas, 0) : epsGas;
    // initial bed geometry
    const msProfile = new Float64Array(N).fill(msIn);
    setGeometry(model, msProfile);
    return model;
  }

  function sensSolidsArr(m, T, F, off) {
    let H = 0;
    for (let j = 0; j < m.ns; j++) H += F[off + j] * dhMol(m.species[m.solidIdx[j]].cp, T);
    return H;
  }
  function sensGasArr(m, T, G, off) {
    let H = 0;
    for (let j = 0; j < m.ng; j++) H += G[off + j] * dhMol(m.species[m.gasIdx[j]].cp, T);
    return H;
  }
  function gasTemperatureFromH(m, H, G) {
    let T = 1000;
    for (let it = 0; it < 100; it++) {
      let h = 0, c = 0;
      for (let j = 0; j < m.ng; j++) { const sp = m.species[m.gasIdx[j]]; h += G[j] * dhMol(sp.cp, T); c += G[j] * cpMol(sp.cp, T); }
      if (!(c > 0)) return T;
      const dT = (H - h) / c;
      T += Math.max(Math.min(dT, 500), -500);
      if (Math.abs(dT) < 1e-9) break;
    }
    return T;
  }

  /** Bed geometry per cell; for the Kramers model it depends on the solids mass-flow profile. */
  function setGeometry(m, msProfile) {
    const N = m.N;
    const geo = new Array(N);
    let overload = false;
    if (m.bedModel === 'fill') {
      const g = bedGeometry(m.R, thetaFromFill(m.fillFrac));
      for (let k = 0; k < N; k++) geo[k] = g;
    } else {
      const phi = new Float64Array(N);
      for (let k = 0; k < N; k++) phi[k] = Math.max(msProfile[k], 1e-9) / m.rhoBulk;
      const zc = m.zc, dz = m.dz;
      const phiAt = z => {
        const u = z / dz - 0.5;
        if (u <= 0) return phi[0];
        if (u >= N - 1) return phi[N - 1];
        const i = Math.floor(u), t = u - i;
        return phi[i] * (1 - t) + phi[i + 1] * t;
      };
      const res = kramersDepth(zc, phiAt, m.L, m.R, m.rpm / 60, m.alpha, m.beta, m.damHeight);
      overload = res.overload;
      for (let k = 0; k < N; k++) {
        const theta = 2 * Math.acos(1 - Math.min(res.depth[k], 2 * m.R * 0.9999) / m.R);
        geo[k] = bedGeometry(m.R, theta);
      }
    }
    m.geo = geo;
    m.overload = overload;
  }

  // ---------------------------------------------------------------------------
  // Cell physics
  // ---------------------------------------------------------------------------
  function makeWork(m) {
    return {
      dF: new Float64Array(m.ns), dG: new Float64Array(m.ng), rates: new Float64Array(m.reactions.length),
      Hs: 0, Hg: 0, Ss: 0, Sg: 0, Rw: 0, Rsh: 0
    };
  }

  /**
   * Evaluate sources in cell k for its state x[o .. o+m-1].
   * det (optional) receives a full breakdown for reporting.
   */
  function evalCell(m, k, x, o, w, det) {
    const ns = m.ns, ng = m.ng, sp = m.species;
    const Ts = x[o], Tg = x[o + 1], Tw = x[o + 2], Tsh = x[o + 3];
    const oF = o + 4, oG = o + 4 + ns;
    const geo = m.geo[k];

    // solids
    let ms = 0, Hs = 0, cpS = 0;
    for (let j = 0; j < ns; j++) {
      const s = sp[m.solidIdx[j]], F = x[oF + j];
      ms += Math.max(F, 0) * s.mw;
      Hs += F * dhMol(s.cp, Ts);
      cpS += Math.max(F, 0) * cpMol(s.cp, Ts);
    }
    ms /= 1000; // kg/s
    const msSafe = Math.max(ms, 1e-12);
    // gas
    let Gt = 0, mg = 0, Hg = 0, cpG = 0;
    for (let j = 0; j < ng; j++) {
      const s = sp[m.gasIdx[j]], G = x[oG + j];
      const Gp = Math.max(G, 0);
      Gt += Gp; mg += Gp * s.mw;
      Hg += G * dhMol(s.cp, Tg);
      cpG += Gp * cpMol(s.cp, Tg);
    }
    mg /= 1000;
    const GtSafe = Math.max(Gt, 1e-15);
    const MWg = mg / GtSafe;                       // kg/mol
    const TgS = Math.max(Tg, 200);
    const rhoG = m.P * MWg / (RU * TgS);
    const Vg = GtSafe * RU * TgS / m.P;            // m3/s
    const uG = Vg / geo.Ag;
    const Ms = m.rhoBulk * geo.Ab;                 // kg solids per metre
    const Mg = rhoG * geo.Ag;                      // kg gas per metre

    const dF = w.dF, dG = w.dG;
    dF.fill(0); dG.fill(0);
    let Ss = 0, Sg = 0;

    // ---- chemical reactions ----
    const nr = m.reactions.length;
    for (let r = 0; r < nr; r++) {
      const rx = m.reactions[r];
      const solidKey = rx.keyPhase === 'solid';
      const T = solidKey ? Ts : Tg;
      const ex = -rx.Ea / (RU * Math.max(T, 200));
      const kr = rx.A * Math.exp(Math.max(ex, -700));
      const ks = sp[rx.key];
      const xk = Math.max(x[(solidKey ? oF : oG) + ks.local], 0);
      let rate; // mol/s per metre of key reactant
      if (solidKey) {
        rate = rx.order === 1 ? kr * Ms * xk / msSafe
          : kr * Ms / (ks.mw / 1000) * lim(xk * ks.mw / 1000 / msSafe);
      } else {
        const mgSafe = Math.max(mg, 1e-15);
        rate = rx.order === 1 ? kr * Mg * xk / mgSafe
          : kr * Mg / (ks.mw / 1000) * lim(xk * ks.mw / 1000 / mgSafe);
      }
      for (let q = 0; q < rx.reactants.length; q++) {
        const s = sp[rx.reactants[q]];
        if (s.phase === 'solid') rate *= lim(Math.max(x[oF + s.local], 0) * s.mw / 1000 / msSafe);
        else rate *= lim(Math.max(x[oG + s.local], 0) / GtSafe);
      }
      const xi = rate / rx.nuKey;
      w.rates[r] = xi;
      const pSolid = solidKey;
      if (pSolid) Ss -= xi * rx.dH; else Sg -= xi * rx.dH;
      for (let q = 0; q < rx.list.length; q++) {
        const i = rx.list[q], s = sp[i], nu = rx.nu[i];
        if (s.phase === 'solid') dF[s.local] += nu * xi; else dG[s.local] += nu * xi;
        const sSolid = s.phase === 'solid';
        if (sSolid !== pSolid) {
          // species crossing between phases carries sensible enthalpy
          const Tc = nu > 0 ? T : (sSolid ? Ts : Tg);
          const flow = nu * xi * dhMol(s.cp, Tc);
          if (pSolid) { Ss -= flow; Sg += flow; } else { Sg -= flow; Ss += flow; }
        }
      }
    }

    // ---- burner ----
    let qBurn = 0;
    const b = m.burner;
    if (b && b.frac[k] > 0) {
      const yO2 = Math.max(x[oG + b.o2Local], 0) / GtSafe;
      const xi = b.Ffuel * b.frac[k] / m.dz * (yO2 / (yO2 + 1e-7));
      for (let j = 0; j < ng; j++) if (b.nu[j] !== 0) dG[j] += b.nu[j] * xi;
      qBurn = -xi * b.dH;
      Sg += qBurn;
    }

    // ---- heat transfer coefficients ----
    const ht = m.ht;
    let hgw, hgs;
    const muG = muGas(TgS), kG = kGas(TgS);
    const Re = rhoG * Math.abs(uG) * geo.De / muG;
    if (ht.conv === 'const') { hgw = ht.hgw; hgs = ht.hgs; }
    else if (ht.conv === 'db') {
      const cpMass = cpG / Math.max(mg, 1e-15);
      const Pr = Math.min(Math.max(cpMass * muG / kG, 0.5), 2);
      const Nu = Math.max(0.023 * Math.pow(Re, 0.8) * Math.pow(Pr, 0.4), 3.66);
      hgw = hgs = Nu * kG / geo.De;
    } else {
      const Rew = Math.max(rhoG * m.omega * geo.De * geo.De / muG, 1);
      hgw = 1.54 * kG / geo.De * Math.pow(Re, 0.575) * Math.pow(Rew, -0.292);
      hgs = 0.46 * kG / geo.De * Math.pow(Re, 0.535) * Math.pow(Rew, 0.104) * Math.pow(geo.fill, -0.341);
    }
    hgw *= ht.mult; hgs *= ht.mult;
    let hws;
    if (ht.ws === 'const') hws = ht.hws;
    else {
      const cpMassS = cpS / Math.max(ms * 1000, 1e-15) * 1000; // J/(kg K)
      const hPen = 2 * Math.sqrt(m.kBed * m.rhoBulk * Math.max(cpMassS, 1) * m.omega / (Math.PI * geo.theta));
      hws = 1 / (1 / ht.hContact + 1 / hPen);
    }

    // ---- radiation: gray gas + exposed wall + bed surface ----
    const eg = m.epsG[k];
    const Aw = geo.arcExp, Ab = geo.chord;
    const Gw = Aw * m.epsWall / (1 - m.epsWall), Gb = Ab * m.epsBed / (1 - m.epsBed);
    const Gwg = Aw * eg, Gbg = Ab * eg, Gwb = Ab * (1 - eg);
    const Ew = SIGMA * Tw * Tw * Tw * Tw, Eb = SIGMA * Ts * Ts * Ts * Ts, Eg = SIGMA * Tg * Tg * Tg * Tg;
    const a11 = Gw + Gwb + Gwg, a22 = Gb + Gwb + Gbg, a12 = -Gwb;
    const b1 = Gw * Ew + Gwg * Eg, b2 = Gb * Eb + Gbg * Eg;
    const det2 = a11 * a22 - a12 * a12;
    const Jw = (b1 * a22 - a12 * b2) / det2, Jb = (a11 * b2 - a12 * b1) / det2;
    const radW = Gw * (Jw - Ew), radB = Gb * (Jb - Eb), radG = -(radW + radB);

    const qGsConv = hgs * Ab * (Tg - Ts);
    const qGwConv = hgw * Aw * (Tg - Tw);
    const qWsCond = hws * geo.arcCov * (Tw - Ts);
    const qCond = (Tw - Tsh) / m.Rcond;
    const hExt = m.extMode === 'constant' ? m.hExtConst : hExterior(Tsh, m.Ta, 2 * m.Ro, m.wind);
    const qExtConv = Math.PI * 2 * m.Ro * hExt * (Tsh - m.Ta);
    const qExtRad = Math.PI * 2 * m.Ro * m.epsShell * SIGMA * (Tsh * Tsh * Tsh * Tsh - m.Ta * m.Ta * m.Ta * m.Ta);

    const qLift = m.liftFrac[k] > 0 ? ht.uaVol * Math.PI * m.R * m.R * m.liftFrac[k] * (Tg - Ts) : 0;
    Ss += qGsConv + radB + qWsCond + qLift;
    Sg += -qGsConv - qGwConv + radG - qLift;
    w.Hs = Hs; w.Hg = Hg; w.Ss = Ss; w.Sg = Sg;
    w.Rw = radW + qGwConv - qWsCond - qCond;
    w.Rsh = qCond - qExtConv - qExtRad;

    if (det) {
      det.ms = ms; det.mg = mg; det.Gt = Gt; det.uG = uG; det.us = ms / Math.max(Ms, 1e-12);
      det.rhoG = rhoG; det.Re = Re; det.hgw = hgw; det.hgs = hgs; det.hws = hws; det.hExt = hExt; det.epsG = eg;
      det.qGsConv = qGsConv; det.qGsRad = Gbg * (Eg - Jb); det.qWsRad = Gwb * (Jw - Jb); det.qWsCond = qWsCond;
      det.qGwConv = qGwConv; det.qGwRad = Gwg * (Eg - Jw); det.qLoss = qExtConv + qExtRad; det.qLossConv = qExtConv;
      det.qLossRad = qExtRad; det.qCond = qCond; det.qBurn = qBurn; det.qLift = qLift; det.qSolids = qGsConv + radB + qWsCond + qLift;
      det.cpS = cpS; det.cpG = cpG;
    }
  }
  function lim(v) { return v / (v + 1e-5); }

  // ---------------------------------------------------------------------------
  // Dense linear algebra for the block-tridiagonal Newton system
  // ---------------------------------------------------------------------------
  function luFactor(A, n, piv) {
    for (let c = 0; c < n; c++) {
      let p = c, mx = Math.abs(A[c * n + c]);
      for (let r = c + 1; r < n; r++) { const v = Math.abs(A[r * n + c]); if (v > mx) { mx = v; p = r; } }
      piv[c] = p;
      if (mx === 0) { A[c * n + c] = 1e-300; continue; }
      if (p !== c) for (let j = 0; j < n; j++) { const t = A[c * n + j]; A[c * n + j] = A[p * n + j]; A[p * n + j] = t; }
      const d = A[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = A[r * n + c] / d;
        if (f === 0) continue;
        A[r * n + c] = f;
        for (let j = c + 1; j < n; j++) A[r * n + j] -= f * A[c * n + j];
      }
    }
  }
  function luSolve(A, n, piv, b, bo) {
    for (let c = 0; c < n; c++) { const p = piv[c]; if (p !== c) { const t = b[bo + c]; b[bo + c] = b[bo + p]; b[bo + p] = t; } }
    for (let r = 1; r < n; r++) { let s = b[bo + r]; for (let j = 0; j < r; j++) s -= A[r * n + j] * b[bo + j]; b[bo + r] = s; }
    for (let r = n - 1; r >= 0; r--) { let s = b[bo + r]; for (let j = r + 1; j < n; j++) s -= A[r * n + j] * b[bo + j]; b[bo + r] = s / A[r * n + r]; }
  }

  // ---------------------------------------------------------------------------
  // Solver
  // ---------------------------------------------------------------------------
  /*
   * Unknowns per cell: [Ts, Tg, Tw, Tsh, solid molar flows..., gas molar flows...].
   * Residuals are scaled: energies in kelvin-equivalents of the larger inlet
   * stream heat capacity, species as fractions of the larger inlet molar flow.
   * Every residual increases with its own unknown, so a positive capacitance
   * term M/dt on the diagonal reproduces a physical start-up transient.
   */
  function createSolver(m) {
    const ns = m.ns, ng = m.ng, N = m.N, nv = 4 + ns + ng, dz = m.dz, nn = nv * nv;
    const oF = 4, oG = 4 + ns;
    const counter = m.flowDir === 'counter';
    let FsTot = 0, GTot = 0, cpSin = 0, cpGin = 0;
    for (let j = 0; j < ns; j++) { FsTot += m.FsIn[j]; cpSin += m.FsIn[j] * cpMol(m.species[m.solidIdx[j]].cp, 600); }
    for (let j = 0; j < ng; j++) { GTot += m.GIn[j]; cpGin += m.GIn[j] * cpMol(m.species[m.gasIdx[j]].cp, 600); }
    const Cref = Math.max(cpSin, cpGin, 1e-6);
    const Fref = Math.max(FsTot, GTot, 1e-9);
    const Wref = Math.PI * m.D * 20;
    const Shref = Math.PI * 2 * m.Ro * 20;
    // half of the lining heat capacity sits on the hot face, half on the shell (J/(m K))
    const wallCap = 0.5 * 2.5e6 * Math.PI * (m.Ro * m.Ro - m.R * m.R);

    const work = makeWork(m), capDet = {};
    const own = new Float64Array(nv), pert = new Float64Array(nv), tmp = new Float64Array(nv);
    const fdStep = (c, v) => c < 4 ? 1e-7 * Math.abs(v) + 1e-5 : 1e-7 * Math.abs(v) + 1e-8 * Fref;

    function ownResidual(k, x, o, out, oo) {
      evalCell(m, k, x, o, work, null);
      out[oo] = (work.Hs - dz * work.Ss) / Cref;
      out[oo + 1] = (work.Hg - dz * work.Sg) / Cref;
      out[oo + 2] = -work.Rw / Wref;     // sign: residual rises with Tw
      out[oo + 3] = -work.Rsh / Shref;   // sign: residual rises with Tsh
      for (let j = 0; j < ns; j++) out[oo + oF + j] = (x[o + oF + j] - dz * work.dF[j]) / Fref;
      for (let j = 0; j < ng; j++) out[oo + oG + j] = (x[o + oG + j] - dz * work.dG[j]) / Fref;
    }
    const gasUp = k => counter ? (k === N - 1 ? -1 : k + 1) : (k === 0 ? -1 : k - 1);
    /** Scaled upstream (inflow) terms of cell k written into up[]. */
    function upstream(k, x, up, uo) {
      if (k === 0) {
        up[uo] = m.HsIn / Cref;
        for (let j = 0; j < ns; j++) up[uo + oF + j] = m.FsIn[j] / Fref;
      } else {
        const o = (k - 1) * nv;
        up[uo] = sensSolidsArr(m, x[o], x, o + oF) / Cref;
        for (let j = 0; j < ns; j++) up[uo + oF + j] = x[o + oF + j] / Fref;
      }
      const ug = gasUp(k);
      if (ug < 0) {
        up[uo + 1] = m.HgIn / Cref;
        for (let j = 0; j < ng; j++) up[uo + oG + j] = m.GIn[j] / Fref;
      } else {
        const u = ug * nv;
        up[uo + 1] = sensGasArr(m, x[u + 1], x, u + oG) / Cref;
        for (let j = 0; j < ng; j++) up[uo + oG + j] = x[u + oG + j] / Fref;
      }
      up[uo + 2] = 0; up[uo + 3] = 0;
    }
    const upTmp = new Float64Array(nv);
    function residual(x, R) {
      for (let k = 0; k < N; k++) {
        const o = k * nv;
        ownResidual(k, x, o, R, o);
        upstream(k, x, upTmp, 0);
        for (let j = 0; j < nv; j++) R[o + j] -= upTmp[j];
      }
    }

    // ---- block-tridiagonal Jacobian, factor once, solve many times ----
    const Dm = new Float64Array(N * nn), Lm = new Float64Array(N * nn), Um = new Float64Array(N * nn);
    const Xm = new Float64Array(N * nn), piv = new Int32Array(N * nv);
    /** Assemble J + diag(shift) at x and compute its block LU factors. */
    function factor(x, shift) {
      Lm.fill(0); Um.fill(0);
      for (let k = 0; k < N; k++) {
        const o = k * nv, bo = k * nn;
        ownResidual(k, x, o, own, 0);
        for (let c = 0; c < nv; c++) {
          const xv = x[o + c], h = fdStep(c, xv);
          x[o + c] = xv + h;
          ownResidual(k, x, o, pert, 0);
          x[o + c] = xv;
          for (let r = 0; r < nv; r++) Dm[bo + r * nv + c] = (pert[r] - own[r]) / h;
        }
        if (shift) for (let c = 0; c < nv; c++) Dm[bo + c * nv + c] += shift[o + c];
        if (k > 0) {                         // solids enter from cell k-1
          const u = (k - 1) * nv, Tu = x[u];
          let cs = 0;
          for (let j = 0; j < ns; j++) {
            const s = m.species[m.solidIdx[j]];
            cs += x[u + oF + j] * cpMol(s.cp, Tu);
            Lm[bo + oF + j] = -dhMol(s.cp, Tu) / Cref;
            Lm[bo + (oF + j) * nv + oF + j] = -1 / Fref;
          }
          Lm[bo] = -cs / Cref;
        }
        const ug = gasUp(k);
        if (ug >= 0) {                       // gas enters from cell k-1 or k+1
          const u = ug * nv, Tu = x[u + 1];
          const B = counter ? Um : Lm;
          let cg = 0;
          for (let j = 0; j < ng; j++) {
            const s = m.species[m.gasIdx[j]];
            cg += x[u + oG + j] * cpMol(s.cp, Tu);
            B[bo + nv + oG + j] = -dhMol(s.cp, Tu) / Cref;
            B[bo + (oG + j) * nv + oG + j] = -1 / Fref;
          }
          B[bo + nv + 1] = -cg / Cref;
        }
      }
      for (let k = 0; k < N; k++) {
        const bo = k * nn;
        if (counter && k > 0) {
          const po = (k - 1) * nn;
          for (let r = 0; r < nv; r++) for (let t = 0; t < nv; t++) {
            const l = Lm[bo + r * nv + t];
            if (l === 0) continue;
            for (let c = 0; c < nv; c++) Dm[bo + r * nv + c] -= l * Xm[po + t * nv + c];
          }
        }
        const pk = piv.subarray(k * nv, k * nv + nv), Dk = Dm.subarray(bo, bo + nn);
        luFactor(Dk, nv, pk);
        if (counter && k < N - 1) {
          for (let c = 0; c < nv; c++) {
            for (let r = 0; r < nv; r++) tmp[r] = Um[bo + r * nv + c];
            luSolve(Dk, nv, pk, tmp, 0);
            for (let r = 0; r < nv; r++) Xm[bo + r * nv + c] = tmp[r];
          }
        }
      }
    }
    /** Solve (J + diag(shift)) d = -R with the stored factors. */
    function subst(R, d) {
      for (let i = 0; i < N * nv; i++) d[i] = -R[i];
      for (let k = 0; k < N; k++) {
        const bo = k * nn, o = k * nv;
        if (k > 0) {
          const pv = (k - 1) * nv;
          for (let r = 0; r < nv; r++) {
            let sb = 0;
            for (let t = 0; t < nv; t++) { const l = Lm[bo + r * nv + t]; if (l !== 0) sb += l * d[pv + t]; }
            d[o + r] -= sb;
          }
        }
        luSolve(Dm.subarray(bo, bo + nn), nv, piv.subarray(k * nv, k * nv + nv), d, o);
      }
      if (counter) {
        for (let k = N - 2; k >= 0; k--) {
          const bo = k * nn, o = k * nv, no = (k + 1) * nv;
          for (let r = 0; r < nv; r++) {
            let s = 0;
            for (let c = 0; c < nv; c++) s += Xm[bo + r * nv + c] * d[no + c];
            d[o + r] -= s;
          }
        }
      }
    }

    /** Physical capacitances (s) of each scaled equation: hold-up time x capacity. */
    function capVector(x, M) {
      for (let k = 0; k < N; k++) {
        const o = k * nv;
        evalCell(m, k, x, o, work, capDet);
        const tauS = m.rhoBulk * m.geo[k].Ab * dz / Math.max(capDet.ms, 1e-12);
        const tauG = dz / Math.max(Math.abs(capDet.uG), 1e-6);
        M[o] = Math.max(capDet.cpS, 1e-9 * Cref) * tauS / Cref;
        M[o + 1] = Math.max(capDet.cpG, 1e-9 * Cref) * tauG / Cref;
        M[o + 2] = wallCap / Wref;
        M[o + 3] = wallCap / Shref;
        for (let j = 0; j < ns; j++) M[o + oF + j] = tauS / Fref;
        for (let j = 0; j < ng; j++) M[o + oG + j] = tauG / Fref;
      }
    }

    // ---- cell-by-cell marching in the solids direction (exact for co-current flow) ----
    const lr = new Float64Array(nv), lr2 = new Float64Array(nv), up = new Float64Array(nv);
    const lJ = new Float64Array(nn), lpiv = new Int32Array(nv), ld = new Float64Array(nv), lx = new Float64Array(nv);
    function cellRes(k, x, o, out) {
      ownResidual(k, x, o, out, 0);
      let s = 0;
      for (let j = 0; j < nv; j++) { out[j] -= up[j]; s = Math.max(s, Math.abs(out[j])); }
      return s;
    }
    function solveCell(k, x, maxIt) {
      const o = k * nv;
      upstream(k, x, up, 0);
      let rn = cellRes(k, x, o, lr);
      let lam = 1e-3;
      for (let it = 0; it < maxIt && rn > 1e-11; it++) {
        for (let c = 0; c < nv; c++) {
          const xv = x[o + c], h = fdStep(c, xv);
          x[o + c] = xv + h;
          ownResidual(k, x, o, lr2, 0);
          x[o + c] = xv;
          for (let r = 0; r < nv; r++) lJ[r * nv + c] = (lr2[r] - up[r] - lr[r]) / h;
        }
        for (let c = 0; c < nv; c++) lJ[c * nv + c] += lam * Math.abs(lJ[c * nv + c]) + 1e-12;
        luFactor(lJ, nv, lpiv);
        for (let r = 0; r < nv; r++) ld[r] = -lr[r];
        luSolve(lJ, nv, lpiv, ld, 0);
        for (let j = 0; j < nv; j++) lx[j] = x[o + j];
        let accepted = false;
        for (let bt = 0; bt < 12 && !accepted; bt++) {
          const f = Math.pow(0.5, bt);
          for (let j = 0; j < nv; j++) {
            let v = lx[j] + f * ld[j];
            if (j < 4) v = Math.min(Math.max(v, lx[j] - 300, 200), lx[j] + 300, 5000);
            else if (v < 0) v = lx[j] > 0 ? 0.05 * lx[j] : 0;
            x[o + j] = v;
          }
          const rn2 = cellRes(k, x, o, lr2);
          if (Number.isFinite(rn2) && rn2 < rn) { rn = rn2; lr.set(lr2); accepted = true; }
        }
        if (!accepted) {
          for (let j = 0; j < nv; j++) x[o + j] = lx[j];
          cellRes(k, x, o, lr);
          lam = lam * 10 + 1e-2;
          if (lam > 1e6) break;
        } else lam = Math.max(lam * 0.1, 1e-6);
      }
      return rn;
    }
    function sweep(x) {
      let worst = 0;
      for (let k = 0; k < N; k++) worst = Math.max(worst, solveCell(k, x, 50));
      return worst;
    }

    function initialGuess() {
      const x = new Float64Array(N * nv);
      const Tg0 = m.TgInMix;
      for (let k = 0; k < N; k++) {
        const o = k * nv;
        x[o] = m.TsIn;
        x[o + 1] = Tg0;
        x[o + 2] = 0.5 * (m.TsIn + Tg0);
        x[o + 3] = m.Ta + 0.2 * (x[o + 2] - m.Ta);
        for (let j = 0; j < ns; j++) x[o + oF + j] = m.FsIn[j];
        for (let j = 0; j < ng; j++) x[o + oG + j] = m.GIn[j];
      }
      return x;
    }

    return { nv, N, oF, oG, counter, Cref, Fref, residual, factor, subst, capVector, sweep, initialGuess };
  }

  function maxAbs(v) {
    let mx = 0;
    for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]); if (!(a <= mx)) mx = a; }
    return mx;
  }

  /**
   * Implicit pseudo-transient continuation. Each step is a backward-Euler step
   * of a kiln start-up with physical hold-ups, solved by Newton-chord
   * iterations; the step size adapts to how hard the step was. Once the steps
   * are large the method is Newton's method on the steady equations, so it
   * converges quadratically at the end.
   */
  function transientSolve(m, S, x0, opts) {
    const nv = S.nv, n = S.N * nv;
    const tol = opts.tol || 1e-8;
    const maxSteps = opts.maxSteps || 400;
    const timeLimit = opts.timeLimitMs || 60000;
    const x = Float64Array.from(x0);
    const xold = new Float64Array(n), M = new Float64Array(n), R = new Float64Array(n), Rt = new Float64Array(n);
    const d = new Float64Array(n), xn = new Float64Array(n), Rn = new Float64Array(n), Rtn = new Float64Array(n);
    const shift = new Float64Array(n);
    let dt = opts.dt0 || 1;
    S.residual(x, R);
    let steady = maxAbs(R);
    let steps = 0, iters = 0, factors = 0, rejects = 0;
    const t0 = Date.now();
    while (steady > tol && steps < maxSteps && Date.now() - t0 < timeLimit) {
      xold.set(x);
      S.capVector(x, M);
      for (let i = 0; i < n; i++) shift[i] = M[i] / dt;
      Rt.set(R);
      let rt = steady;
      const tolStep = Math.max(0.5 * tol, 0.02 * steady);
      S.factor(x, shift); factors++;
      let ok = false, it = 0, fresh = true;
      for (it = 1; it <= 15; it++) {
        S.subst(Rt, d); iters++;
        for (let i = 0; i < n; i++) {
          let v = x[i] + d[i];
          if (i % nv < 4) v = Math.min(Math.max(v, x[i] - 300, 200), x[i] + 300, 5000);
          else if (v < 0) v = x[i] > 0 ? 0.05 * x[i] : 0;
          xn[i] = v;
        }
        S.residual(xn, Rn);
        for (let i = 0; i < n; i++) Rtn[i] = Rn[i] + M[i] * (xn[i] - xold[i]) / dt;
        const rtn = maxAbs(Rtn);
        if (!Number.isFinite(rtn) || rtn > 2 * rt) {
          if (!fresh) { S.factor(x, shift); factors++; fresh = true; continue; }
          break;
        }
        x.set(xn); Rt.set(Rtn); R.set(Rn);
        fresh = false;
        if (rtn <= tolStep) { ok = true; break; }
        if (rtn > 0.3 * rt) { S.factor(x, shift); factors++; fresh = true; }
        rt = rtn;
      }
      if (!ok) {
        x.set(xold); S.residual(x, R);
        dt *= 0.25; rejects++;
        if (dt < 1e-6) break;
        continue;
      }
      steps++;
      steady = maxAbs(R);
      if (opts.onProgress) opts.onProgress({ step: steps, residual: steady, dt });
      dt *= it <= 2 ? 4 : it <= 4 ? 2 : it <= 8 ? 1.3 : 0.7;
      dt = Math.min(dt, 1e15);
    }
    return { x, converged: steady <= tol, steps, iterations: iters, factorizations: factors, rejects, resid: steady };
  }

  // ---------------------------------------------------------------------------
  // Top level solve + post-processing
  // ---------------------------------------------------------------------------
  function solve(input, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const m = buildModel(input);
    if (m.errors.length) return { ok: false, errors: m.errors, warnings: m.warnings };
    let S = createSolver(m);
    let x = S.initialGuess();
    if (opts.sweep !== false) S.sweep(x);
    let res = transientSolve(m, S, x, opts);
    const stats = { steps: res.steps, iterations: res.iterations, factorizations: res.factorizations };
    x = res.x;
    if (m.bedModel === 'kramers' && res.converged) {
      for (let outer = 0; outer < 10; outer++) {
        const msProf = new Float64Array(m.N);
        for (let k = 0; k < m.N; k++) {
          let ms = 0;
          for (let j = 0; j < m.ns; j++) ms += Math.max(x[k * S.nv + S.oF + j], 0) * m.species[m.solidIdx[j]].mw / 1000;
          msProf[k] = ms;
        }
        const old = m.geo.map(g => g.Ab);
        setGeometry(m, msProf);
        let change = 0;
        for (let k = 0; k < m.N; k++) change = Math.max(change, Math.abs(m.geo[k].Ab - old[k]) / old[k]);
        S = createSolver(m);
        res = transientSolve(m, S, x, Object.assign({}, opts, { dt0: 100 }));
        stats.steps += res.steps; stats.iterations += res.iterations; stats.factorizations += res.factorizations;
        x = res.x;
        if (!res.converged || change < 1e-6) break;
      }
    }
    const out = postProcess(m, S, x);
    out.ok = true;
    out.converged = res.converged;
    out.iterations = stats.iterations;
    out.steps = stats.steps;
    out.factorizations = stats.factorizations;
    out.residual = res.resid;
    out.elapsedMs = Date.now() - t0;
    out.errors = [];
    out.warnings = m.warnings.slice();
    if (m.overload) out.warnings.push('The bed depth reached half the kiln diameter: the kiln cannot transport this feed rate at this slope and speed.');
    if (!res.converged) out.warnings.unshift('The solver did not fully converge (largest scaled residual ' + res.resid.toExponential(2) + '). Treat these results with caution and check the inputs for extreme values.');
    return out;
  }

  function postProcess(m, S, x) {
    const N = m.N, nv = S.nv, ns = m.ns, ng = m.ng, dz = m.dz;
    const w = makeWork(m);
    const sp = m.species;
    const cells = [];
    const nr = m.reactions.length;
    let cumSolids = 0, cumLoss = 0, cumBurn = 0, tau = 0;
    const extent = new Float64Array(nr);
    // gas-direction cumulative values need a second pass
    for (let k = 0; k < N; k++) {
      const o = k * nv;
      const det = {};
      evalCell(m, k, x, o, w, det);
      const F = Array.from(x.subarray(o + S.oF, o + S.oF + ns));
      const G = Array.from(x.subarray(o + S.oG, o + S.oG + ng));
      const msK = det.ms;
      const wFrac = F.map((f, j) => Math.max(f, 0) * sp[m.solidIdx[j]].mw / 1000 / Math.max(msK, 1e-15));
      const yFrac = G.map(g => Math.max(g, 0) / Math.max(det.Gt, 1e-15));
      cumSolids += det.qSolids * dz; cumLoss += det.qLoss * dz; cumBurn += det.qBurn * dz;
      for (let r = 0; r < nr; r++) extent[r] += w.rates[r] * dz;
      tau += dz / Math.max(det.us, 1e-12);
      const geo = m.geo[k];
      cells.push({
        z: m.zc[k], Ts: x[o], Tg: x[o + 1], Tw: x[o + 2], Tsh: x[o + 3], F, G, w: wFrac, y: yFrac,
        ms: msK, mg: det.mg, uG: det.uG, us: det.us, Re: det.Re, hgw: det.hgw, hgs: det.hgs, hws: det.hws, hExt: det.hExt,
        epsG: det.epsG, qGsConv: det.qGsConv, qGsRad: det.qGsRad, qWsRad: det.qWsRad, qWsCond: det.qWsCond,
        qLift: det.qLift, qSolids: det.qSolids, qGwConv: det.qGwConv, qGwRad: det.qGwRad, qLoss: det.qLoss, qLossConv: det.qLossConv,
        qLossRad: det.qLossRad, qBurn: det.qBurn, rates: Array.from(w.rates),
        cumSolids, cumLoss, cumBurnFeedEnd: cumBurn, tau, fill: geo.fill, depth: geo.depth, theta: geo.theta
      });
    }

    // ---- boundary values ----
    const last = cells[N - 1];
    const gasOutCell = m.flowDir === 'counter' ? cells[0] : cells[N - 1];
    const FsOut = last.F, GOut = gasOutCell.G;
    const HsOut = sensSolidsArr(m, last.Ts, Float64Array.from(FsOut), 0);
    const HgOut = sensGasArr(m, gasOutCell.Tg, Float64Array.from(GOut), 0);
    let fuelBurned = 0;
    if (m.burner) fuelBurned = m.burner.Ffuel - Math.max(GOut[m.burner.fuelLocal], 0);
    const qFuel = m.burner ? cells.reduce((a, c) => a + c.qBurn * dz, 0) : 0;
    const rxHeat = m.reactions.map((rx, r) => extent[r] * rx.dH);
    const totLoss = cumLoss;

    // energy balance (W), reference 25 C, LHV basis
    const streamsH = m.streams.map(st => ({ name: st.name, H: sensGasArr(m, st.T, st.G, 0), T: st.T }));
    const energyIn = [
      { name: 'Fuel heat release (LHV)', W: qFuel },
      { name: 'Solids feed sensible heat', W: m.HsIn }
    ].concat(streamsH.map(s => ({ name: s.name + ' sensible heat', W: s.H })));
    const energyOut = [
      { name: 'Product solids sensible heat', W: HsOut },
      { name: 'Off-gas sensible heat', W: HgOut },
      { name: 'Shell heat loss', W: totLoss }
    ].concat(m.reactions.map((rx, r) => ({ name: 'Reaction heat: ' + rx.name, W: rxHeat[r] })));
    const sumIn = energyIn.reduce((a, e) => a + e.W, 0), sumOut = energyOut.reduce((a, e) => a + e.W, 0);

    // mass balance (kg/s)
    const mw = i => sp[i].mw / 1000;
    const massSolidsOut = FsOut.reduce((a, f, j) => a + f * mw(m.solidIdx[j]), 0);
    const massGasOut = GOut.reduce((a, g, j) => a + g * mw(m.gasIdx[j]), 0);
    const massIn = [{ name: 'Solids feed', kg: m.msIn }].concat(m.streams.map(st => ({
      name: st.name, kg: Array.from(st.G).reduce((a, g, j) => a + g * mw(m.gasIdx[j]), 0)
    })));
    const massOut = [{ name: 'Product solids', kg: massSolidsOut }, { name: 'Off-gas', kg: massGasOut }];
    const mIn = massIn.reduce((a, e) => a + e.kg, 0), mOut = massOut.reduce((a, e) => a + e.kg, 0);

    // conversions of solid species fed to the kiln
    const conversions = [];
    m.solidIdx.forEach((gi, j) => {
      if (m.FsIn[j] > 1e-12 && m.reactions.some(rx => rx.nu[gi] < 0))
        conversions.push({ name: sp[gi].name, X: 1 - FsOut[j] / m.FsIn[j] });
    });

    // gas inlet boundary for plotting
    const gasInletZ = m.flowDir === 'counter' ? m.L : 0;
    const gasOutletZ = m.flowDir === 'counter' ? 0 : m.L;
    let gInTot = 0; for (let j = 0; j < ng; j++) gInTot += m.GIn[j];
    const productTons = massSolidsOut * 3.6; // t/h
    return {
      input: null,
      meta: {
        L: m.L, D: m.D, Ro: m.Ro, N, dz, flowDir: m.flowDir, bedModel: m.bedModel,
        solids: m.solidIdx.map(i => sp[i].name), gases: m.gasIdx.map(i => sp[i].name),
        reactions: m.reactions.map(r => ({ name: r.name, equation: r.equation, dH: r.dH })),
        burner: m.burner ? { Lf: m.burner.Lf, firing: m.burner.firing, fuel: m.burner.fuelName, Ffuel: m.burner.Ffuel } : null,
        Ta: m.Ta, wallLayers: m.layers
      },
      cells,
      inlet: {
        solids: { z: 0, T: m.TsIn, w: Array.from(m.wIn), F: Array.from(m.FsIn) },
        gas: { z: gasInletZ, T: m.TgInMix, y: Array.from(m.GIn).map(g => g / gInTot), G: Array.from(m.GIn) }
      },
      outlet: {
        solids: { z: m.L, T: last.Ts, w: last.w, F: FsOut, kgps: massSolidsOut },
        gas: { z: gasOutletZ, T: gasOutCell.Tg, y: gasOutCell.y, G: GOut, kgps: massGasOut }
      },
      summary: {
        heatToSolids: cumSolids, heatLoss: totLoss, fuelHeat: qFuel, fuelBurned,
        residenceTime: tau, meanFill: cells.reduce((a, c) => a + c.fill, 0) / N,
        maxShellT: cells.reduce((a, c) => Math.max(a, c.Tsh), 0),
        maxGasT: cells.reduce((a, c) => Math.max(a, c.Tg), 0),
        maxSolidsT: cells.reduce((a, c) => Math.max(a, c.Ts), 0),
        productRate: productTons,
        specificEnergy: productTons > 0 ? (qFuel / 1e6) * 3.6 / productTons : NaN, // GJ/t
        conversions,
        reactionExtent: Array.from(extent), reactionHeat: rxHeat
      },
      energy: { in: energyIn, out: energyOut, sumIn, sumOut, closure: sumIn - sumOut },
      mass: { in: massIn, out: massOut, sumIn: mIn, sumOut: mOut, closure: mIn - mOut }
    };
  }

  return {
    RU, SIGMA, TREF, NM3_MOL,
    parseFormula, parseEquation, cpMol, dhMol, hExterior, thetaFromFill, bedGeometry, kramersDepth,
    buildModel, solve,
    _internal: { createSolver, transientSolve, evalCell, makeWork, setGeometry }
  };
}));
