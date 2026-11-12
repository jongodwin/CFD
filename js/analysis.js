/*
 * Post-processing on the time-averaged flow field:
 *   - impeller power / pumping numbers, circulation, stream function
 *   - residence time distribution (step tracer, implicit SDIRK2 on the frozen flow)
 *   - local mean age
 *   - solids distribution from a drift-flux (settling + turbulent dispersion) model
 *   - settling correlations (Schiller-Naumann, Richardson-Zaki, Zwietering)
 */
(function (G) {
  'use strict';
  const CSTR = (G.CSTR = G.CSTR || {});
  const pause = () => new Promise((r) => setTimeout(r, 0));
  const GRAV = 9.81, SC_T = 0.8, C_MAX = 0.6;

  // ---------- banded matrix helpers (no pivoting: the operators are diagonally dominant M-matrices)
  function bandLU(ab, N, b) {
    const w = 2 * b + 1;
    for (let k = 0; k < N; k++) {
      const piv = ab[k * w + b], iMax = Math.min(N - 1, k + b);
      for (let i = k + 1; i <= iMax; i++) {
        const l = ab[i * w + (k - i + b)] / piv;
        if (l === 0) continue;
        ab[i * w + (k - i + b)] = l;
        const ro = i * w - i + b, ko = k * w - k + b;
        for (let j = k + 1; j <= iMax; j++) ab[ro + j] -= l * ab[ko + j];
      }
    }
  }
  function bandSolve(ab, N, b, x) {
    const w = 2 * b + 1;
    for (let i = 1; i < N; i++) {
      let s = x[i];
      const ro = i * w - i + b;
      for (let j = Math.max(0, i - b); j < i; j++) s -= ab[ro + j] * x[j];
      x[i] = s;
    }
    for (let i = N - 1; i >= 0; i--) {
      let s = x[i];
      const ro = i * w - i + b, jMax = Math.min(N - 1, i + b);
      for (let j = i + 1; j <= jMax; j++) s -= ab[ro + j] * x[j];
      x[i] = s / ab[ro + i];
    }
  }
  function bandMul(ab, N, b, x, y) {
    const w = 2 * b + 1;
    for (let i = 0; i < N; i++) {
      let s = 0;
      const ro = i * w - i + b, j0 = Math.max(0, i - b), j1 = Math.min(N - 1, i + b);
      for (let j = j0; j <= j1; j++) s += ab[ro + j] * x[j];
      y[i] = s;
    }
  }

  /**
   * Finite-volume transport operator (first-order upwind + diffusion), per radian.
   * Returns A (banded), the inlet source vector for unit inlet concentration and the outlet faces.
   * slip: optional downward settling velocity at interior z-faces.
   */
  function buildOperator(f, Dc, slip) {
    const { Nr, Nz, rc, rf, u, w, g } = f, NU = Nr + 1, dr = g.dr, dz = g.dz;
    const N = Nr * Nz, b = Nr, wd = 2 * b + 1;
    const ab = new Float64Array(N * wd), src = new Float64Array(N), outlets = [];
    const add = (r, c, val) => { ab[r * wd + (c - r + b)] += val; };
    for (let j = 0; j < Nz; j++) for (let i = 1; i < Nr; i++) {
      const R = j * Nr + i, L = R - 1;
      const F = u[j * NU + i] * rf[i] * dz, D = (0.5 * (Dc[L] + Dc[R]) * rf[i] * dz) / dr;
      const fp = Math.max(F, 0), fm = Math.max(-F, 0);
      add(L, L, fp + D); add(L, R, -fm - D); add(R, R, fm + D); add(R, L, -fp - D);
    }
    for (let j = 1; j < Nz; j++) for (let i = 0; i < Nr; i++) {
      const Up = j * Nr + i, Lo = Up - Nr;
      const F = (w[Up] - (slip ? slip[Up] : 0)) * rc[i] * dr, D = (0.5 * (Dc[Lo] + Dc[Up]) * rc[i] * dr) / dz;
      const fp = Math.max(F, 0), fm = Math.max(-F, 0);
      add(Lo, Lo, fp + D); add(Lo, Up, -fm - D); add(Up, Up, fm + D); add(Up, Lo, -fp - D);
    }
    for (let i = 0; i < Nr; i++) {
      const wt = w[Nz * Nr + i], wb = w[i], a = rc[i] * dr;
      if (wt < 0) src[(Nz - 1) * Nr + i] += -wt * a;
      if (wb < 0) { add(i, i, -wb * a); outlets.push([i, -wb * a]); }
    }
    for (let j = 0; j < Nz; j++) {
      const uo = u[j * NU + Nr];
      if (uo > 0) { const c = j * Nr + Nr - 1, F = uo * rf[Nr] * dz; add(c, c, F); outlets.push([c, F]); }
    }
    return { ab, src, outlets, N, b };
  }

  function volumes(f) {
    const { Nr, Nz, rc, g } = f, V = new Float64Array(Nr * Nz);
    for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) V[j * Nr + i] = rc[i] * g.dr * g.dz;
    return V;
  }

  // ---------- hydrodynamic summary
  function hydro(f) {
    const { Nr, Nz, rc, rf, u, w, v, g } = f, NU = Nr + 1, dr = g.dr, dz = g.dz;
    const out = {};
    out.power = Math.max(0, f.torque * g.omega * g.rho);
    out.Np = out.power / (g.rho * Math.pow(g.N, 3) * Math.pow(g.D, 5));
    let q = 0;
    for (let j = f.jLo; j < f.jHi; j++) { const x = u[j * NU + f.iTip]; if (x > 0) q += x * rf[f.iTip] * dz; }
    for (let i = 0; i < f.iTip; i++) {
      const a = rc[i] * dr, wt = w[f.jHi * Nr + i], wb = w[f.jLo * Nr + i];
      if (wt > 0) q += wt * a;
      if (wb < 0) q -= wb * a;
    }
    out.Qimp = 2 * Math.PI * q;
    out.Nq = out.Qimp / (g.N * Math.pow(g.D, 3));
    // stream function at grid nodes: psi = integral of r*w dr
    const psi = new Float64Array((Nr + 1) * (Nz + 1));
    let pmin = 0, pmax = 0;
    for (let j = 0; j <= Nz; j++) for (let i = 0; i < Nr; i++) {
      const val = psi[j * NU + i] + w[j * Nr + i] * rc[i] * dr;
      psi[j * NU + i + 1] = val;
      if (val < pmin) pmin = val;
      if (val > pmax) pmax = val;
    }
    out.psi = psi; out.psiMin = pmin; out.psiMax = pmax;
    out.Qcirc = 2 * Math.PI * Math.max(pmax, -pmin); // strongest circulation loop
    out.tCirc = g.V / Math.max(out.Qcirc, 1e-12);
    const speed = new Float64Array(Nr * Nz), ucArr = new Float64Array(Nr * Nz), wcArr = new Float64Array(Nr * Nz);
    let sMax = 0, vMax = 0, sAvg = 0, vAvg = 0, vol = 0, nutAvg = 0;
    for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) {
      const c = j * Nr + i, uc = 0.5 * (u[j * NU + i] + u[j * NU + i + 1]), wc = 0.5 * (w[c] + w[c + Nr]);
      ucArr[c] = uc; wcArr[c] = wc;
      const s = Math.hypot(uc, wc);
      speed[c] = s;
      if (s > sMax) sMax = s;
      if (Math.abs(v[c]) > vMax) vMax = Math.abs(v[c]);
      sAvg += s * rc[i]; vAvg += Math.abs(v[c]) * rc[i]; nutAvg += f.nut[c] * rc[i]; vol += rc[i];
    }
    out.speed = speed; out.uc = ucArr; out.wc = wcArr;
    out.speedMax = sMax; out.swirlMax = vMax; out.speedAvg = sAvg / vol; out.swirlAvg = vAvg / vol;
    out.nutRatio = nutAvg / vol / g.nu;
    out.pv = out.power / g.V;
    out.regime = g.Re < 10 ? 'laminar' : g.Re < 1e4 ? 'transitional' : 'turbulent';
    // Grenville blend-time correlation (turbulent, baffled)
    out.blend95 = (5.2 * Math.pow(g.T, 1.5) * Math.pow(g.H, 0.5)) / (Math.pow(Math.max(out.Np, 1e-6), 1 / 3) * g.N * g.D * g.D);
    out.blendValid = g.Re > 6400 && g.nBaf > 0;
    return out;
  }

  // ---------- residence time distribution
  async function rtd(f, hy, hooks) {
    const g = f.g, N = f.Nr * f.Nz;
    const Dc = new Float64Array(N);
    for (let c = 0; c < N; c++) Dc[c] = f.nut[c] / SC_T + 1e-9;
    const op = buildOperator(f, Dc, null), b = op.b, wd = 2 * b + 1, V = volumes(f);
    let Qp = 0;
    for (const o of op.outlets) Qp += o[1];

    // local mean age: A a = V
    const lu = op.ab.slice();
    bandLU(lu, N, b);
    const age = V.slice();
    bandSolve(lu, N, b, age);
    await pause();

    const tau = g.tau, gam = 1 - Math.SQRT1_2;
    let dt = Math.min(tau / 3000, hy.tCirc / 40), t = 0;
    const y = new Float64Array(N), k1 = new Float64Array(N), k2 = new Float64Array(N), tmp = new Float64Array(N), Ay = new Float64Array(N);
    const ts = [0], Fs = [0];
    const m = new Float64Array(N * wd);
    const factor = () => {
      for (let q = 0; q < m.length; q++) m[q] = gam * dt * op.ab[q];
      for (let c = 0; c < N; c++) m[c * wd + b] += V[c];
      bandLU(m, N, b);
    };
    factor();
    let inStage = 0, guard = 0;
    while (t < 6 * tau && guard++ < 4000) {
      bandMul(op.ab, N, b, y, Ay);
      for (let c = 0; c < N; c++) k1[c] = op.src[c] - Ay[c];
      bandSolve(m, N, b, k1);
      for (let c = 0; c < N; c++) tmp[c] = y[c] + (1 - gam) * dt * k1[c];
      bandMul(op.ab, N, b, tmp, Ay);
      for (let c = 0; c < N; c++) k2[c] = op.src[c] - Ay[c];
      bandSolve(m, N, b, k2);
      for (let c = 0; c < N; c++) y[c] += dt * ((1 - gam) * k1[c] + gam * k2[c]);
      t += dt;
      let Fo = 0;
      for (const o of op.outlets) Fo += o[1] * y[o[0]];
      ts.push(t); Fs.push(Math.min(1, Math.max(0, Fo / Qp)));
      if (++inStage >= 14 && dt < tau / 60) { dt = Math.min(dt * 2, tau / 60); inStage = 0; factor(); }
      if (guard % 40 === 0) {
        if (hooks.cancelled && hooks.cancelled()) throw new Error('cancelled');
        if (hooks.progress) hooks.progress(Math.min(1, t / (6 * tau)), 'Tracing residence time');
        await pause();
      }
    }
    // moments of the washout curve 1 - F, with an exponential tail beyond the simulated window
    const n = ts.length;
    let m0 = 0, m1 = 0;
    for (let q = 1; q < n; q++) {
      const h = ts[q] - ts[q - 1], a = 1 - Fs[q - 1], c = 1 - Fs[q];
      m0 += 0.5 * h * (a + c);
      m1 += 0.5 * h * (a * ts[q - 1] + c * ts[q]);
    }
    // late-time decay constant from a log-linear fit over theta in [1, 4]
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    for (let q = 0; q < n; q++) {
      const th = ts[q] / tau, r = 1 - Fs[q];
      if (th >= 1 && th <= 4 && r > 1e-6) { const ly = Math.log(r); sx += th; sy += ly; sxx += th * th; sxy += th * ly; cnt++; }
    }
    const slope = cnt > 2 ? (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx) : -1;
    const tailTau = -tau / slope, rEnd = 1 - Fs[n - 1], tEnd = ts[n - 1];
    m0 += rEnd * tailTau;
    m1 += rEnd * tailTau * (tEnd + tailTau);
    const tMean = m0, variance = Math.max(0, 2 * m1 - m0 * m0);
    const quant = (level) => {
      for (let q = 1; q < n; q++) if (Fs[q] >= level) return ts[q - 1] + ((level - Fs[q - 1]) / Math.max(Fs[q] - Fs[q - 1], 1e-30)) * (ts[q] - ts[q - 1]);
      return NaN;
    };
    // E(theta) at interval midpoints
    const thE = [], E = [];
    let Epeak = 0, thPeak = 0;
    for (let q = 1; q < n; q++) {
      const e = ((Fs[q] - Fs[q - 1]) / (ts[q] - ts[q - 1])) * tau, th = (0.5 * (ts[q] + ts[q - 1])) / tau;
      thE.push(th); E.push(e);
      if (e > Epeak) { Epeak = e; thPeak = th; }
    }
    let ageAvg = 0, ageMax = 0, vol = 0;
    for (let c = 0; c < N; c++) { ageAvg += age[c] * V[c]; vol += V[c]; if (age[c] > ageMax) ageMax = age[c]; }
    ageAvg /= vol;
    let stag = 0;
    for (let c = 0; c < N; c++) if (age[c] > 1.25 * ageAvg) stag += V[c];
    return {
      t: ts, F: Fs, thE, E, tMean, variance, sigmaTheta2: variance / (tMean * tMean), nTanks: (tMean * tMean) / Math.max(variance, 1e-30),
      tFirst: quant(0.001), t10: quant(0.1), t50: quant(0.5), t90: quant(0.9), Epeak, thPeak, mixedFraction: -1 / slope,
      age, ageAvg, ageMax, stagnantFraction: stag / vol, tau,
    };
  }

  // ---------- particle settling correlations
  function settling(g) {
    const p = g.p, d = p.dp * 1e-6, rhoS = p.rhoS, rhoL = g.rho, x = Math.min(0.7, Math.max(0, p.wt / 100));
    const out = { d, x, active: x > 0 && d > 0 && rhoS !== rhoL };
    out.cv = x / rhoS / (x / rhoS + (1 - x) / rhoL);
    const dRho = rhoS - rhoL;
    out.dRho = dRho;
    let vt = (GRAV * Math.abs(dRho) * d * d) / (18 * g.mu); // Stokes start
    for (let it = 0; it < 60; it++) {
      const re = Math.max((rhoL * vt * d) / g.mu, 1e-12);
      const cd = re < 1000 ? (24 / re) * (1 + 0.15 * Math.pow(re, 0.687)) : 0.44;
      const vNew = Math.sqrt((4 * GRAV * Math.abs(dRho) * d) / (3 * cd * rhoL));
      if (Math.abs(vNew - vt) < 1e-10 * vt) { vt = vNew; break; }
      vt = 0.5 * (vt + vNew);
    }
    out.vt = vt * Math.sign(dRho); // positive = sinks
    out.ReP = (rhoL * vt * d) / g.mu;
    out.nRZ = (2.35 * (2 + 0.175 * Math.pow(out.ReP, 0.75))) / (1 + 0.175 * Math.pow(out.ReP, 0.75));
    out.vHind = out.vt * Math.pow(1 - out.cv, out.nRZ);
    out.settleTime = out.vHind > 0 ? g.H / out.vHind : Infinity;
    // Zwietering just-suspended speed
    const X = (100 * x) / Math.max(1 - x, 1e-9);
    out.S = g.imp.s0 * Math.pow(g.T / g.D / 3, g.imp.sExp) * Math.exp(2.2 * (g.C / g.T - 0.25));
    out.Njs = dRho > 0 && x > 0 ? (out.S * Math.pow(g.nu, 0.1) * Math.pow((GRAV * dRho) / rhoL, 0.45) * Math.pow(X, 0.13) * Math.pow(d, 0.2)) / Math.pow(g.D, 0.85) : 0;
    out.ratio = out.Njs > 0 ? g.N / out.Njs : Infinity;
    out.rhoSlurry = 1 / (x / rhoS + (1 - x) / rhoL);
    return out;
  }

  // ---------- solids distribution: steady drift-flux balance at fixed inventory
  async function solids(f, hy, st, hooks) {
    const g = f.g, { Nr, Nz } = f, N = Nr * Nz;
    if (!st.active || st.vt <= 0) return null;
    const V = volumes(f), Dc = new Float64Array(N);
    for (let c = 0; c < N; c++) Dc[c] = f.nut[c] / SC_T + 1e-9;
    const c0 = st.cv, cv = new Float64Array(N).fill(c0), cRel = new Float64Array(N).fill(c0), slip = new Float64Array(N + Nr), rhs = new Float64Array(N);
    let vol = 0;
    for (let c = 0; c < N; c++) vol += V[c];
    const dtp = 4 * Math.max(hy.tCirc, g.H / st.vt);
    let cOut = c0, iters = 0, change = 1;
    for (let it = 0; it < 80 && change > 5e-4; it++) {
      for (let j = 1; j < Nz; j++) for (let i = 0; i < Nr; i++) {
        const up = j * Nr + i, lo = up - Nr;
        const room = Math.min(1, Math.max(0, (C_MAX - cRel[lo]) / (0.1 * C_MAX)));
        slip[up] = st.vt * Math.pow(Math.max(0, 1 - cRel[up]), st.nRZ) * room;
      }
      const op = buildOperator(f, Dc, slip), b = op.b, wd = 2 * b + 1;
      for (let c = 0; c < N; c++) { op.ab[c * wd + b] += V[c] / dtp; rhs[c] = (V[c] / dtp) * cv[c] + op.src[c] * cOut; }
      bandLU(op.ab, N, b);
      bandSolve(op.ab, N, b, rhs);
      let mean = 0;
      for (let c = 0; c < N; c++) mean += Math.max(rhs[c], 0) * V[c];
      mean /= vol;
      const sc = c0 / Math.max(mean, 1e-30);
      change = 0;
      for (let c = 0; c < N; c++) {
        const nv = Math.max(rhs[c], 0) * sc;
        change = Math.max(change, Math.abs(nv - cv[c]) / c0);
        cv[c] = nv;
        cRel[c] = 0.7 * cRel[c] + 0.3 * nv;
      }
      let fo = 0, qo = 0;
      for (const o of op.outlets) { fo += o[1] * cv[o[0]]; qo += o[1]; }
      cOut = qo > 0 ? fo / qo : c0;
      iters = it + 1;
      if (hooks.cancelled && hooks.cancelled()) throw new Error('cancelled');
      if (hooks.progress) hooks.progress((it + 1) / 80, 'Balancing solids distribution');
      await pause();
    }
    // axial profile, cloud height, uniformity
    const prof = new Float64Array(Nz);
    let var_ = 0, cMaxV = 0, bottomMax = 0, lowMass = 0;
    for (let j = 0; j < Nz; j++) {
      let s = 0, a = 0;
      for (let i = 0; i < Nr; i++) {
        const c = j * Nr + i;
        s += cv[c] * f.rc[i]; a += f.rc[i];
        var_ += (cv[c] - c0) * (cv[c] - c0) * V[c];
        if (cv[c] > cMaxV) cMaxV = cv[c];
        if (j === 0 && cv[c] > bottomMax) bottomMax = cv[c];
        if ((j + 0.5) / Nz <= 0.1) lowMass += cv[c] * V[c];
      }
      prof[j] = s / a / c0;
    }
    let cloud = 0;
    for (let j = Nz - 1; j >= 0; j--) if (prof[j] >= 0.5) {
      cloud = j === Nz - 1 ? 1 : (j + 0.5 + (prof[j] - 0.5) / Math.max(prof[j] - prof[j + 1], 1e-12)) / Nz;
      break;
    }
    return {
      cv, profile: prof, cloudHeight: Math.min(1, cloud), rsd: Math.sqrt(var_ / vol) / c0, cMax: cMaxV, bottomMax, bottomRatio: bottomMax / c0,
      lowMassFraction: lowMass / (c0 * vol), outRatio: cOut / c0, hasOutlet: g.Q > 0, iters, converged: change <= 5e-4, packed: cMaxV > 0.9 * C_MAX,
    };
  }

  function suspensionState(st, sol, hy) {
    if (!st.active) return { level: 'none', label: 'No solids' };
    if (st.vt <= 0) return { level: 'ok', label: 'Buoyant or neutrally buoyant particles: no settling' };
    if (hy && st.settleTime > 150 * hy.tCirc) return { level: 'good', label: 'Slow-settling particles: carried with the liquid' };
    const r = st.ratio;
    if (r < 0.8) return { level: 'critical', label: 'Not suspended: a settled bed is expected' };
    if (r < 1) return { level: 'warning', label: 'Partial suspension: some solids rest on the bottom' };
    if (sol && sol.rsd < 0.15 && sol.cloudHeight > 0.95) return { level: 'good', label: 'Near-uniform suspension' };
    return { level: 'good', label: 'Complete off-bottom suspension' };
  }

  /** Full pipeline: flow -> hydrodynamics -> RTD -> solids. */
  CSTR.simulate = async function (params, hooks) {
    hooks = hooks || {};
    const g = CSTR.derive(params);
    const phase = (lo, hi) => ({
      cancelled: hooks.cancelled,
      progress: hooks.progress ? (x, text, solver) => hooks.progress(lo + (hi - lo) * x, text, solver) : null,
    });
    const t0 = Date.now();
    const f = await CSTR.runFlow(g, phase(0, 0.8));
    const hy = hydro(f);
    const st = settling(g);
    const res = { g, flow: f, hydro: hy, settling: st, rtd: null, solids: null };
    if (g.Q > 0) res.rtd = await rtd(f, hy, phase(0.8, 0.92));
    res.solids = await solids(f, hy, st, phase(0.92, 1));
    res.suspension = suspensionState(st, res.solids, hy);
    res.wallSeconds = (Date.now() - t0) / 1000;
    return res;
  };
  CSTR._internals = { bandLU, bandSolve, bandMul, buildOperator, hydro, settling };
})(typeof globalThis !== 'undefined' ? globalThis : this);
