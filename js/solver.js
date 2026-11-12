/*
 * Axisymmetric (r, z) incompressible Navier-Stokes solver with swirl for a stirred tank.
 *
 *  - staggered MAC grid, explicit van Leer (TVD) advection, explicit diffusion
 *  - Chorin projection; the pressure Poisson equation is solved directly
 *    (cosine transform in z, tridiagonal solve in r)
 *  - impeller blades and baffles are momentum sources (blade-element drag), applied point-implicitly
 *  - algebraic mixing-length eddy viscosity with a power-law wall function
 *
 * Plain script: attaches to globalThis.CSTR so it runs from file://, a web server or Node.
 */
(function (G) {
  'use strict';
  const CSTR = (G.CSTR = G.CSTR || {});

  const IMPELLERS = {
    rushton: { label: 'Rushton turbine (radial)', blades: 6, wd: 0.2, angle: 90, hub: 0.25, cd: 40, np: 5.0, nq: 0.72, s0: 8.0, sExp: 1.33 },
    pbt: { label: 'Pitched-blade turbine (axial)', blades: 4, wd: 0.2, angle: 45, hub: 0.1, cd: 45, np: 1.3, nq: 0.79, s0: 5.8, sExp: 0.82 },
    hydrofoil: { label: 'Hydrofoil (axial, high efficiency)', blades: 3, wd: 0.15, angle: 25, hub: 0.1, cd: 60, np: 0.3, nq: 0.56, s0: 6.9, sExp: 0.82 },
    paddle: { label: 'Flat paddle (radial)', blades: 2, wd: 0.25, angle: 90, hub: 0.1, cd: 40, np: 1.8, nq: 0.5, s0: 8.5, sExp: 1.3 },
  };
  CSTR.IMPELLERS = IMPELLERS;

  CSTR.DEFAULTS = {
    tankD: 1.0, tankH: 1.0,
    baffleN: 4, baffleW: 10, baffleGap: 1.5,
    impType: 'pbt', impD: 0.4, impC: 0.25, impBlades: 4, impWD: 0.2, impAngle: 45, impDir: 'down', rpm: 150,
    mu: 1.0, rho: 1000,
    flow: 2.0, inletPos: 0.7, outlet: 'bottom',
    dp: 150, rhoS: 2650, wt: 10,
    res: 40,
  };

  /** Convert UI parameters to SI and derive the grid. Throws on impossible geometry. */
  CSTR.derive = function (p) {
    const g = {};
    g.p = p;
    g.R = p.tankD / 2;
    g.H = p.tankH;
    g.T = p.tankD;
    if (!(g.R > 0 && g.H > 0)) throw new Error('Tank diameter and liquid height must be positive.');
    g.D = p.impD;
    if (!(g.D > 0.1 * g.T && g.D <= 0.9 * g.T)) throw new Error('Impeller diameter must be between 10% and 90% of the tank diameter.');
    g.imp = IMPELLERS[p.impType] || IMPELLERS.rushton;
    g.beta = (Math.min(90, Math.max(10, p.impAngle)) * Math.PI) / 180;
    g.nBlades = Math.max(1, Math.round(p.impBlades));
    g.Wblade = p.impWD * g.D;
    g.Wproj = g.Wblade * Math.sin(g.beta);
    g.C = p.impC;
    if (!(g.C - g.Wproj / 2 > 0 && g.C + g.Wproj / 2 < g.H)) throw new Error('Impeller clearance places the blades outside the liquid. Keep it between the tank bottom and the liquid surface.');
    g.N = p.rpm / 60;
    if (!(g.N > 0)) throw new Error('Agitator speed must be greater than zero.');
    g.omega = 2 * Math.PI * g.N;
    g.rho = p.rho;
    g.mu = p.mu * 1e-3;
    if (!(g.rho > 0 && g.mu > 0)) throw new Error('Fluid density and viscosity must be positive.');
    g.nu = g.mu / g.rho;
    g.Q = Math.max(0, p.flow) / 3600;
    g.V = Math.PI * g.R * g.R * g.H;
    g.tau = g.Q > 0 ? g.V / g.Q : Infinity;
    g.Re = (g.N * g.D * g.D) / g.nu;
    g.tip = Math.PI * g.N * g.D;
    g.nBaf = Math.max(0, Math.round(p.baffleN));
    g.bafW = (p.baffleW / 100) * g.T;
    g.bafGap = (p.baffleGap / 100) * g.T;
    if (g.nBaf > 0 && g.bafW + g.bafGap > 0.5 * (g.T - g.D)) throw new Error('Baffles collide with the impeller. Reduce baffle width or impeller diameter.');
    g.dirSign = p.impDir === 'up' ? 1 : -1;

    const Nr = Math.max(16, Math.round(p.res));
    // Nz is a power of two (fast cosine transform); cells stay within ~1.4:1 aspect ratio
    const Nz = Math.max(16, Math.min(256, Math.pow(2, Math.round(Math.log2((Nr * g.H) / g.R)))));
    g.Nr = Nr; g.Nz = Nz; g.dr = g.R / Nr; g.dz = g.H / Nz;
    // a-priori turnover time used to size the run
    g.tTurn = g.V / (0.8 * g.N * Math.pow(g.D, 3));
    return g;
  };

  function vanLeer(a, m1, p0, p1, p2) {
    let U, d1, d2;
    if (a >= 0) { U = p0; d1 = p0 - m1; d2 = p1 - p0; } else { U = p1; d1 = p1 - p2; d2 = p0 - p1; }
    const pr = d1 * d2;
    return pr > 0 ? U + pr / (d1 + d2) : U;
  }

  // Lee's fast DCT-II / DCT-III (unscaled), length a power of two.
  function dctFwd(v, off, len, t, tc) {
    if (len === 1) return;
    const half = len >> 1;
    for (let i = 0; i < half; i++) {
      const x = v[off + i], y = v[off + len - 1 - i];
      t[off + i] = x + y;
      t[off + i + half] = (x - y) * tc[len + i];
    }
    dctFwd(t, off, half, v, tc);
    dctFwd(t, off + half, half, v, tc);
    for (let i = 0; i < half - 1; i++) {
      v[off + 2 * i] = t[off + i];
      v[off + 2 * i + 1] = t[off + i + half] + t[off + i + half + 1];
    }
    v[off + len - 2] = t[off + half - 1];
    v[off + len - 1] = t[off + len - 1];
  }
  function dctInv(v, off, len, t, tc) {
    if (len === 1) return;
    const half = len >> 1;
    t[off] = v[off];
    t[off + half] = v[off + 1];
    for (let i = 1; i < half; i++) {
      t[off + i] = v[off + 2 * i];
      t[off + i + half] = v[off + 2 * i - 1] + v[off + 2 * i + 1];
    }
    dctInv(t, off, half, v, tc);
    dctInv(t, off + half, half, v, tc);
    for (let i = 0; i < half; i++) {
      const x = t[off + i], y = t[off + i + half] * tc[len + i];
      v[off + i] = x + y;
      v[off + len - 1 - i] = x - y;
    }
  }

  function FlowSolver(g) {
    const Nr = g.Nr, Nz = g.Nz, dr = g.dr, dz = g.dz, NU = Nr + 1;
    this.g = g; this.Nr = Nr; this.Nz = Nz;
    const nc = Nr * Nz;
    this.u = new Float64Array(NU * Nz); this.un = new Float64Array(NU * Nz);
    this.w = new Float64Array(Nr * (Nz + 1)); this.wn = new Float64Array(Nr * (Nz + 1));
    this.gam = new Float64Array(nc); this.gn = new Float64Array(nc);
    this.v = new Float64Array(nc);
    this.nu = new Float64Array(nc).fill(g.nu);
    this.nut = new Float64Array(nc);
    this.p = new Float64Array(nc); this.hat = new Float64Array(nc);
    this.rc = new Float64Array(Nr); this.rf = new Float64Array(NU);
    for (let i = 0; i < Nr; i++) this.rc[i] = (i + 0.5) * dr;
    for (let i = 0; i <= Nr; i++) this.rf[i] = i * dr;
    this.nuWB = new Float64Array(Nr).fill(g.nu);
    this.nuWS = new Float64Array(Nz).fill(g.nu);
    this.t = 0; this.steps = 0; this.dt = 0;

    // ---- boundary through-flow
    this.wTop = new Float64Array(Nr); this.wBot = new Float64Array(Nr); this.uWall = new Float64Array(Nz);
    const bc = (this.bc = { inI0: 0, inI1: 0, outI1: 0, outJ0: 0, outJ1: 0, type: g.p.outlet });
    if (g.Q > 0) {
      const wIn = Math.max(2, Math.round(0.06 * Nr));
      let i0 = Math.round(g.p.inletPos * Nr - wIn / 2);
      i0 = Math.max(0, Math.min(Nr - wIn, i0));
      bc.inI0 = i0; bc.inI1 = i0 + wIn;
      const aIn = Math.PI * (this.rf[bc.inI1] ** 2 - this.rf[i0] ** 2);
      for (let i = i0; i < bc.inI1; i++) this.wTop[i] = -g.Q / aIn;
      if (g.p.outlet === 'bottom') {
        bc.outI1 = Math.max(2, Math.round(0.08 * Nr));
        const aOut = Math.PI * this.rf[bc.outI1] ** 2;
        for (let i = 0; i < bc.outI1; i++) this.wBot[i] = -g.Q / aOut;
      } else {
        const hOut = Math.max(2, Math.round(0.05 * Nz));
        let j0 = g.p.outlet === 'side-top' ? Nz - hOut : Math.round(0.1 * Nz - hOut / 2);
        j0 = Math.max(0, Math.min(Nz - hOut, j0));
        bc.outJ0 = j0; bc.outJ1 = j0 + hOut;
        const aOut = 2 * Math.PI * g.R * hOut * dz;
        for (let j = j0; j < bc.outJ1; j++) this.uWall[j] = g.Q / aOut;
      }
    }
    this.applyBC(this.u, this.w);

    // ---- impeller and baffle source masks
    const cover = (lo, hi, a, b) => Math.max(0, Math.min(hi, b) - Math.max(lo, a));
    this.impA = new Float64Array(nc); // blade area per unit volume / C_d-weighted
    const rHub = g.imp.hub * g.D, rTip = g.D / 2;
    const zLo = g.C - g.Wproj / 2, zHi = g.C + g.Wproj / 2;
    this.impCells = [];
    for (let j = 0; j < Nz; j++) {
      const fz = cover(j * dz, (j + 1) * dz, zLo, zHi) / dz;
      if (fz <= 0) continue;
      for (let i = 0; i < Nr; i++) {
        const fr = cover(this.rf[i], this.rf[i + 1], rHub, rTip) / dr;
        if (fr <= 0) continue;
        this.impA[j * Nr + i] = (g.nBlades * fz * fr) / (2 * Math.PI * this.rc[i] * Math.sin(g.beta));
        this.impCells.push(j * Nr + i);
      }
    }
    this.nTh = Math.sin(g.beta);
    this.nZ = g.dirSign * Math.cos(g.beta);
    this.bafK = new Float64Array(Nr);
    if (g.nBaf > 0) {
      for (let i = 0; i < Nr; i++) {
        const fr = cover(this.rf[i], this.rf[i + 1], g.R - g.bafGap - g.bafW, g.R - g.bafGap) / dr;
        this.bafK[i] = (0.5 * 1.6 * g.nBaf * fr) / (2 * Math.PI * this.rc[i]);
      }
    }
    // swept-volume bounds (grid indices) for the pumping number
    this.iTip = Math.max(1, Math.min(Nr - 1, Math.round(rTip / dr)));
    this.jLo = Math.max(0, Math.min(Nz - 1, Math.floor(zLo / dz + 0.5)));
    this.jHi = Math.max(this.jLo + 1, Math.min(Nz, Math.floor(zHi / dz + 0.5)));

    // ---- mixing length
    this.lm2 = new Float64Array(nc);
    const lMax = 0.0154 * g.D + 0.0084 * g.T;
    for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) {
      const d = Math.min(g.R - this.rc[i], (j + 0.5) * dz);
      const l = Math.min(0.41 * d, lMax);
      this.lm2[j * Nr + i] = l * l;
    }

    // ---- Poisson solver tables
    this.dctC = new Float64Array(2 * Nz); // 1 / (2 cos((i + 1/2) pi / len)) stored at [len + i]
    for (let len = 2; len <= Nz; len *= 2) for (let i = 0; i < len / 2; i++) this.dctC[len + i] = 0.5 / Math.cos(((i + 0.5) * Math.PI) / len);
    this.col = new Float64Array(Nz); this.tmp = new Float64Array(Nz);
    this.thCp = new Float64Array(Nz * Nr); this.thM = new Float64Array(Nz * Nr);
    for (let k = 0; k < Nz; k++) {
      const lam = -(2 - 2 * Math.cos((Math.PI * k) / Nz)) / (dz * dz);
      let cpPrev = 0;
      for (let i = 0; i < Nr; i++) {
        const a = i > 0 ? this.rf[i] : 0;
        let c = i < Nr - 1 ? this.rf[i + 1] : 0;
        let b = -(a + c) + this.rc[i] * dr * dr * lam;
        let aa = a;
        if (k === 0 && i === Nr - 1) { b = 1; aa = 0; }
        const m = 1 / (b - aa * cpPrev);
        this.thM[k * Nr + i] = m;
        cpPrev = c * m;
        this.thCp[k * Nr + i] = cpPrev;
      }
    }
    this.torque = 0; // instantaneous impeller torque / rho  [m^5/s^2]
    this.updateNu();
  }

  FlowSolver.prototype.applyBC = function (u, w) {
    const Nr = this.Nr, Nz = this.Nz, NU = Nr + 1;
    for (let j = 0; j < Nz; j++) { u[j * NU] = 0; u[j * NU + Nr] = this.uWall[j]; }
    for (let i = 0; i < Nr; i++) { w[i] = this.wBot[i]; w[Nz * Nr + i] = this.wTop[i]; }
  };

  /** Eddy viscosity, wall-function viscosities and the stable time step. */
  FlowSolver.prototype.updateNu = function () {
    const { Nr, Nz, u, w, v, rc, nu, nut, lm2, g } = this;
    const NU = Nr + 1, dr = g.dr, dz = g.dz, nu0 = g.nu;
    let umax = 1e-12, wmax = 1e-12, numax = nu0;
    for (let j = 0; j < Nz; j++) {
      const jm = j > 0 ? j - 1 : j, jp = j < Nz - 1 ? j + 1 : j, dzz = (jp - jm) * dz;
      for (let i = 0; i < Nr; i++) {
        const c = j * Nr + i, ku = j * NU + i;
        const im = i > 0 ? i - 1 : i, ip = i < Nr - 1 ? i + 1 : i, drr = (ip - im) * dr;
        const uc = 0.5 * (u[ku] + u[ku + 1]);
        const dudr = (u[ku + 1] - u[ku]) / dr, ur = uc / rc[i];
        const dwdz = (w[c + Nr] - w[c]) / dz;
        const dudz = (0.5 * (u[jp * NU + i] + u[jp * NU + i + 1]) - 0.5 * (u[jm * NU + i] + u[jm * NU + i + 1])) / dzz;
        const dwdr = (0.5 * (w[j * Nr + ip] + w[j * Nr + ip + Nr]) - 0.5 * (w[j * Nr + im] + w[j * Nr + im + Nr])) / drr;
        const dvdz = (v[jp * Nr + i] - v[jm * Nr + i]) / dzz;
        const rdom = (rc[i] * (v[j * Nr + ip] / rc[ip] - v[j * Nr + im] / rc[im])) / drr;
        const s1 = dudz + dwdr;
        const S = Math.sqrt(2 * (dudr * dudr + ur * ur + dwdz * dwdz) + s1 * s1 + rdom * rdom + dvdz * dvdz);
        let nt = lm2[c] * S;
        nt *= 1 - Math.exp(-nt / (8 * nu0)); // damp towards laminar flow
        nut[c] = nt;
        const ne = nu0 + nt;
        nu[c] = ne;
        if (ne > numax) numax = ne;
        const au = Math.abs(uc), aw = Math.abs(0.5 * (w[c] + w[c + Nr]));
        if (au > umax) umax = au;
        if (aw > wmax) wmax = aw;
      }
    }
    // power-law (1/7) wall function expressed as an effective wall viscosity
    const wallNu = (U, y) => {
      if (U < 1e-9) return nu0;
      const re = (U * y) / nu0;
      return Math.max(nu0, 0.0225 * U * y * Math.pow(re, -0.25));
    };
    for (let i = 0; i < Nr; i++) {
      const uc = 0.5 * (u[i] + u[i + 1]);
      this.nuWB[i] = wallNu(Math.hypot(uc, v[i]), 0.5 * dz);
      if (this.nuWB[i] > numax) numax = this.nuWB[i];
    }
    for (let j = 0; j < Nz; j++) {
      const c = j * Nr + Nr - 1;
      this.nuWS[j] = wallNu(Math.hypot(0.5 * (w[c] + w[c + Nr]), v[c]), 0.5 * dr);
      if (this.nuWS[j] > numax) numax = this.nuWS[j];
    }
    const h = Math.min(dr, dz);
    const dtAdv = 0.4 / (umax / dr + wmax / dz + 1e-9);
    const dtDif = (0.2 * h * h) / numax;
    // cap the step by the blade passage scale so start-up from rest is resolved
    this.dt = Math.min(dtAdv, dtDif, (1.2 * h) / g.tip);
    this.umax = Math.max(umax, wmax);
  };

  FlowSolver.prototype.step = function () {
    const { Nr, Nz, u, w, un, wn, gam, gn, v, nu, rc, rf, g } = this;
    const NU = Nr + 1, dr = g.dr, dz = g.dz;
    if (this.steps % 4 === 0) this.updateNu();
    const dt = this.dt, idr2 = 1 / (dr * dr), idz2 = 1 / (dz * dz);
    const nuWB = this.nuWB, nuWS = this.nuWS;

    // ---- radial momentum
    for (let j = 0; j < Nz; j++) {
      for (let i = 1; i < Nr; i++) {
        const k = j * NU + i, c = j * Nr + i;
        const uP = u[k], uW = u[k - 1], uE = u[k + 1];
        const ae = 0.5 * (uP + uE), aw = 0.5 * (uW + uP);
        const fe = rc[i] * ae * vanLeer(ae, uW, uP, uE, i + 2 <= Nr ? u[k + 2] : uE);
        const fw = rc[i - 1] * aw * vanLeer(aw, i >= 2 ? u[k - 2] : uW, uW, uP, uE);
        const an = 0.5 * (w[c + Nr - 1] + w[c + Nr]);
        const as = 0.5 * (w[c - 1] + w[c]);
        let phn, phs;
        if (j === Nz - 1) phn = an > 0 ? uP : 0;
        else phn = vanLeer(an, j > 0 ? u[k - NU] : uP, uP, u[k + NU], j + 2 < Nz ? u[k + 2 * NU] : u[k + NU]);
        if (j === 0) phs = as < 0 ? uP : 0;
        else phs = vanLeer(as, j > 1 ? u[k - 2 * NU] : u[k - NU], u[k - NU], uP, j + 1 < Nz ? u[k + NU] : uP);
        const adv = (fe - fw) / (rf[i] * dr) + (an * phn - as * phs) / dz;
        const nuE = nu[c], nuW = nu[c - 1], nuf = 0.5 * (nuE + nuW);
        let dif = ((rc[i] * nuE * (uE - uP) - rc[i - 1] * nuW * (uP - uW)) * idr2) / rf[i] - (nuf * uP) / (rf[i] * rf[i]);
        if (j < Nz - 1) dif += 0.5 * (nuf + 0.5 * (nu[c + Nr] + nu[c + Nr - 1])) * (u[k + NU] - uP) * idz2;
        if (j > 0) dif -= 0.5 * (nuf + 0.5 * (nu[c - Nr] + nu[c - Nr - 1])) * (uP - u[k - NU]) * idz2;
        else dif -= 0.5 * (nuWB[i] + nuWB[i - 1]) * uP * 2 * idz2;
        const cen = 0.5 * ((v[c - 1] * v[c - 1]) / rc[i - 1] + (v[c] * v[c]) / rc[i]);
        un[k] = uP + dt * (-adv + dif + cen);
      }
    }
    // ---- axial momentum
    for (let j = 1; j < Nz; j++) {
      for (let i = 0; i < Nr; i++) {
        const k = j * Nr + i, ku = j * NU + i;
        const wP = w[k], wN = w[k + Nr], wS = w[k - Nr];
        const ae = 0.5 * (u[ku + 1 - NU] + u[ku + 1]);
        let fe, fw = 0;
        if (i === Nr - 1) fe = ae > 0 ? ae * wP : 0;
        else fe = ae * vanLeer(ae, i > 0 ? w[k - 1] : wP, wP, w[k + 1], i + 2 < Nr ? w[k + 2] : w[k + 1]);
        if (i > 0) {
          const aw = 0.5 * (u[ku - NU] + u[ku]);
          fw = aw * vanLeer(aw, i > 1 ? w[k - 2] : w[k - 1], w[k - 1], wP, i + 1 < Nr ? w[k + 1] : wP);
        }
        const an = 0.5 * (wP + wN), as = 0.5 * (wS + wP);
        const phn = vanLeer(an, wS, wP, wN, j + 2 <= Nz ? w[k + 2 * Nr] : wN);
        const phs = vanLeer(as, j >= 2 ? w[k - 2 * Nr] : wS, wS, wP, wN);
        const adv = (rf[i + 1] * fe - rf[i] * fw) / (rc[i] * dr) + (an * phn - as * phs) / dz;
        const nuN = nu[k], nuS = nu[k - Nr], nuf = 0.5 * (nuN + nuS);
        let dif = (nuN * (wN - wP) - nuS * (wP - wS)) * idz2;
        if (i < Nr - 1) dif += (rf[i + 1] * 0.5 * (nuf + 0.5 * (nu[k + 1] + nu[k + 1 - Nr])) * (w[k + 1] - wP) * idr2) / rc[i];
        else dif -= (rf[Nr] * 0.5 * (nuWS[j] + nuWS[j - 1]) * wP * 2 * idr2) / rc[i];
        if (i > 0) dif -= (rf[i] * 0.5 * (nuf + 0.5 * (nu[k - 1] + nu[k - 1 - Nr])) * (wP - w[k - 1]) * idr2) / rc[i];
        wn[k] = wP + dt * (-adv + dif);
      }
    }
    // ---- angular momentum (Gamma = r * u_theta)
    for (let j = 0; j < Nz; j++) {
      for (let i = 0; i < Nr; i++) {
        const k = j * Nr + i, ku = j * NU + i;
        const GP = gam[k];
        const ue = u[ku + 1], uw = u[ku], wnn = w[k + Nr], ws = w[k];
        const Ge = i < Nr - 1 ? vanLeer(ue, i > 0 ? gam[k - 1] : GP, GP, gam[k + 1], i + 2 < Nr ? gam[k + 2] : gam[k + 1]) : GP;
        const Gw = i > 0 ? vanLeer(uw, i > 1 ? gam[k - 2] : gam[k - 1], gam[k - 1], GP, i + 1 < Nr ? gam[k + 1] : GP) : 0;
        const Gn = j < Nz - 1 ? vanLeer(wnn, j > 0 ? gam[k - Nr] : GP, GP, gam[k + Nr], j + 2 < Nz ? gam[k + 2 * Nr] : gam[k + Nr]) : wnn > 0 ? GP : 0;
        const Gs = j > 0 ? vanLeer(ws, j > 1 ? gam[k - 2 * Nr] : gam[k - Nr], gam[k - Nr], GP, j + 1 < Nz ? gam[k + Nr] : GP) : ws < 0 ? GP : 0;
        const adv = (rf[i + 1] * ue * Ge - rf[i] * uw * Gw) / (rc[i] * dr) + (wnn * Gn - ws * Gs) / dz;
        const omP = GP / (rc[i] * rc[i]);
        let dif = 0;
        if (i < Nr - 1) { const r3 = rf[i + 1] * rf[i + 1] * rf[i + 1]; dif += (0.5 * (nu[k] + nu[k + 1]) * r3 * (gam[k + 1] / (rc[i + 1] * rc[i + 1]) - omP) * idr2) / rc[i]; }
        else { const r3 = rf[Nr] * rf[Nr] * rf[Nr]; dif -= (nuWS[j] * r3 * omP * 2 * idr2) / rc[i]; }
        if (i > 0) { const r3 = rf[i] * rf[i] * rf[i]; dif -= (0.5 * (nu[k] + nu[k - 1]) * r3 * (omP - gam[k - 1] / (rc[i - 1] * rc[i - 1])) * idr2) / rc[i]; }
        if (j < Nz - 1) dif += 0.5 * (nu[k] + nu[k + Nr]) * (gam[k + Nr] - GP) * idz2;
        if (j > 0) dif -= 0.5 * (nu[k] + nu[k - Nr]) * (GP - gam[k - Nr]) * idz2;
        else dif -= nuWB[i] * GP * 2 * idz2;
        gn[k] = GP + dt * (-adv + dif);
      }
    }
    this.applyBC(un, wn);

    // ---- impeller blades (normal-force drag, point-implicit)
    const nTh = this.nTh, nZ = this.nZ, om = g.omega, cd = g.imp.cd, impA = this.impA;
    let torque = 0;
    for (let q = 0; q < this.impCells.length; q++) {
      const c = this.impCells[q], i = c % Nr, j = (c / Nr) | 0;
      const vc = gn[c] / rc[i];
      const wc = 0.5 * (wn[c] + wn[c + Nr]);
      const s = (vc - om * rc[i]) * nTh + wc * nZ;
      const K = 0.5 * cd * impA[c] * Math.abs(s);
      const ds = s / (1 + dt * K) - s;
      const dv = ds * nTh, dw = ds * nZ;
      gn[c] += dv * rc[i];
      if (j > 0) wn[c] += 0.5 * dw;
      if (j < Nz - 1) wn[c + Nr] += 0.5 * dw;
      torque += rc[i] * (dv / dt) * rc[i];
    }
    this.torque = torque * 2 * Math.PI * dr * dz;
    // ---- baffles (drag on swirl)
    if (g.nBaf > 0) {
      const bafK = this.bafK;
      for (let i = 0; i < Nr; i++) {
        if (bafK[i] <= 0) continue;
        for (let j = 0; j < Nz; j++) {
          const c = j * Nr + i;
          gn[c] /= 1 + (dt * bafK[i] * Math.abs(gn[c])) / rc[i];
        }
      }
    }

    // ---- projection
    this.project(un, wn, dt);
    this.u = un; this.un = u; this.w = wn; this.wn = w; this.gam = gn; this.gn = gam;
    const G2 = this.gam, vv = this.v;
    for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) vv[j * Nr + i] = G2[j * Nr + i] / rc[i];
    this.t += dt; this.steps++;
  };

  FlowSolver.prototype.project = function (u, w, dt) {
    const { Nr, Nz, rc, rf, p, hat, thCp, thM, g } = this;
    const NU = Nr + 1, dr = g.dr, dz = g.dz;
    // divergence -> p (used as scratch)
    for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) {
      const c = j * Nr + i, ku = j * NU + i;
      p[c] = ((rf[i + 1] * u[ku + 1] - rf[i] * u[ku]) / (rc[i] * dr) + (w[c + Nr] - w[c]) / dz) / dt;
    }
    // forward cosine transform in z, column by column
    const col = this.col, tmp = this.tmp, tc = this.dctC;
    for (let i = 0; i < Nr; i++) {
      for (let j = 0; j < Nz; j++) col[j] = p[j * Nr + i];
      dctFwd(col, 0, Nz, tmp, tc);
      for (let k = 0; k < Nz; k++) hat[k * Nr + i] = col[k];
    }
    // tridiagonal solves in r
    const dr2 = dr * dr;
    for (let k = 0; k < Nz; k++) {
      const ko = k * Nr;
      let prev = 0;
      for (let i = 0; i < Nr; i++) {
        let d = rc[i] * dr2 * hat[ko + i], a = i > 0 ? rf[i] : 0;
        if (k === 0 && i === Nr - 1) { d = 0; a = 0; }
        prev = (d - a * prev) * thM[ko + i];
        hat[ko + i] = prev;
      }
      for (let i = Nr - 2; i >= 0; i--) hat[ko + i] -= thCp[ko + i] * hat[ko + i + 1];
    }
    // inverse transform
    const sc = 2 / Nz;
    for (let i = 0; i < Nr; i++) {
      for (let k = 0; k < Nz; k++) col[k] = hat[k * Nr + i];
      col[0] *= 0.5;
      dctInv(col, 0, Nz, tmp, tc);
      for (let j = 0; j < Nz; j++) p[j * Nr + i] = col[j] * sc;
    }
    for (let j = 0; j < Nz; j++) for (let i = 1; i < Nr; i++) u[j * NU + i] -= (dt * (p[j * Nr + i] - p[j * Nr + i - 1])) / dr;
    for (let j = 1; j < Nz; j++) for (let i = 0; i < Nr; i++) w[j * Nr + i] -= (dt * (p[j * Nr + i] - p[(j - 1) * Nr + i])) / dz;
  };

  FlowSolver.prototype.kinetic = function () {
    const { Nr, Nz, u, w, v, rc } = this, NU = Nr + 1;
    let ke = 0, sw = 0;
    for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) {
      const c = j * Nr + i, uc = 0.5 * (u[j * NU + i] + u[j * NU + i + 1]), wc = 0.5 * (w[c] + w[c + Nr]);
      ke += rc[i] * (uc * uc + wc * wc);
      sw += rc[i] * v[c] * v[c];
    }
    return [ke, sw];
  };

  CSTR.FlowSolver = FlowSolver;

  const pause = () => new Promise((r) => setTimeout(r, 0));
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  /**
   * Run the flow to a statistically steady state and return time-averaged fields.
   * hooks.progress(fraction, text, solver) is called between work slices; hooks.cancelled() aborts.
   */
  CSTR.runFlow = async function (g, hooks) {
    hooks = hooks || {};
    const s = new FlowSolver(g);
    const tMin = Math.min(2.5 * g.tTurn, Math.max(0.3 * g.tTurn, (0.5 * g.R * g.R) / g.nu));
    const tMax = 9 * g.tTurn;
    const tAvg = 1.2 * g.tTurn;
    const maxSteps = 140000;
    const win = 0.25 * g.tTurn;
    let nextCheck = win, last = null, converged = false, slice = now();
    const hist = [];
    while (s.t < tMax && s.steps < maxSteps) {
      s.step();
      if (!isFinite(s.torque)) throw new Error('The flow solution diverged. Try a finer grid or less extreme parameters.');
      if (s.t >= nextCheck) {
        nextCheck += win;
        const [ke, sw] = s.kinetic();
        const cur = [ke, sw, s.torque];
        hist.push(cur);
        if (last && s.t >= tMin) {
          const rel = (a, b) => Math.abs(a - b) / (Math.abs(a) + Math.abs(b) + 1e-30);
          if (rel(cur[0], last[0]) < 0.004 && rel(cur[1], last[1]) < 0.004 && rel(cur[2], last[2]) < 0.004) { converged = true; break; }
        }
        last = cur;
      }
      if (now() - slice > 60) {
        if (hooks.cancelled && hooks.cancelled()) throw new Error('cancelled');
        if (hooks.progress) hooks.progress(Math.min(0.85, (0.85 * s.t) / Math.max(tMin * 1.6, s.t * 1.15)), 'Developing flow field', s);
        await pause();
        slice = now();
      }
    }
    // ---- averaging window
    const nc = g.Nr * g.Nz;
    const U = new Float64Array(s.u.length), W = new Float64Array(s.w.length), Vt = new Float64Array(nc), NUT = new Float64Array(nc);
    let n = 0, tq = 0;
    const t0 = s.t, stepCap = s.steps + 30000;
    while (s.t - t0 < tAvg && s.steps < stepCap) {
      s.step();
      const u = s.u, w = s.w, v = s.v, nut = s.nut;
      for (let k = 0; k < u.length; k++) U[k] += u[k];
      for (let k = 0; k < w.length; k++) W[k] += w[k];
      for (let k = 0; k < nc; k++) { Vt[k] += v[k]; NUT[k] += nut[k]; }
      tq += s.torque; n++;
      if (now() - slice > 60) {
        if (hooks.cancelled && hooks.cancelled()) throw new Error('cancelled');
        if (hooks.progress) hooks.progress(0.85 + (0.15 * (s.t - t0)) / tAvg, 'Averaging flow field', s);
        await pause();
        slice = now();
      }
    }
    if (!isFinite(tq)) throw new Error('The flow solution diverged. Try a finer grid or less extreme parameters.');
    for (let k = 0; k < U.length; k++) U[k] /= n;
    for (let k = 0; k < W.length; k++) W[k] /= n;
    for (let k = 0; k < nc; k++) { Vt[k] /= n; NUT[k] /= n; }
    return { g, Nr: g.Nr, Nz: g.Nz, rc: s.rc, rf: s.rf, u: U, w: W, v: Vt, nut: NUT, torque: tq / n, converged, simTime: s.t, steps: s.steps, bc: s.bc, iTip: s.iTip, jLo: s.jLo, jHi: s.jHi };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
