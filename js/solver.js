/*
 * Mass balance data reconciliation for mineral processing circuits.
 *
 * Unknowns are mass flows, never ratios:
 *   m[s][i]     solids mass flow of stream s in size fraction i
 *   c[s][i][k]  mass flow of component k in stream s (per size fraction when
 *               assay-by-size is enabled, otherwise one value per stream)
 * Node balances are then exactly linear (A x = 0) and "no negative flows"
 * is the simple bound x > 0, enforced with a logarithmic barrier
 * (interior-point method). Measurements (flow, size distribution, assays)
 * are ratios of sums of unknowns; the weighted sum of squared adjustments is
 * minimised with a damped Gauss-Newton iteration on the null space of A, so
 * every iterate conserves mass exactly.
 *
 * Works in the browser (window.MassBalance) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MassBalance = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isNum = (v) => typeof v === 'number' && isFinite(v);

  // ---------- dense linear algebra helpers (row-major Float64Array) ----------

  /** In-place Cholesky (lower). Returns false if the matrix is not positive definite. */
  function cholesky(M, n) {
    for (let j = 0; j < n; j++) {
      let d = M[j * n + j];
      for (let k = 0; k < j; k++) d -= M[j * n + k] * M[j * n + k];
      if (!(d > 0)) return false;
      d = Math.sqrt(d);
      M[j * n + j] = d;
      for (let i = j + 1; i < n; i++) {
        let s = M[i * n + j];
        const ri = i * n, rj = j * n;
        for (let k = 0; k < j; k++) s -= M[ri + k] * M[rj + k];
        M[ri + j] = s / d;
      }
    }
    return true;
  }

  function cholSolve(L, n, b) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = b[i];
      const ri = i * n;
      for (let k = 0; k < i; k++) s -= L[ri + k] * y[k];
      y[i] = s / L[ri + i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let k = i + 1; k < n; k++) s -= L[k * n + i] * y[k];
      y[i] = s / L[i * n + i];
    }
    return y;
  }

  /**
   * Solve the symmetric positive (semi)definite system M x = b.
   * Jacobi-scales the matrix first and adds jitter if the factorisation fails.
   * Returns { solve(b) } so the factor can be reused.
   */
  function spdFactor(M, n) {
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = M[i * n + i] > 0 ? 1 / Math.sqrt(M[i * n + i]) : 1;
    const base = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) base[i * n + j] = M[i * n + j] * d[i] * d[j];
    let L = null, jitter = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      L = Float64Array.from(base);
      if (jitter > 0) for (let i = 0; i < n; i++) L[i * n + i] += jitter;
      if (cholesky(L, n)) break;
      jitter = jitter === 0 ? 1e-12 : jitter * 100;
      L = null;
    }
    if (!L) throw new Error('Linear system could not be factorised.');
    return {
      solve(b) {
        const bs = new Float64Array(n);
        for (let i = 0; i < n; i++) bs[i] = b[i] * d[i];
        const y = cholSolve(L, n, bs);
        for (let i = 0; i < n; i++) y[i] *= d[i];
        return y;
      },
    };
  }

  /**
   * Reduced row echelon form of the balance matrix (rows given sparsely).
   * Returns the independent rows and a sparse null-space basis Z with
   * x = Z f, where f are the "free" variables.
   */
  function nullSpace(rows, n) {
    const m = rows.length;
    const A = new Float64Array(m * n);
    rows.forEach((r, i) => r.idx.forEach((j, q) => { A[i * n + j] += r.val[q]; }));
    const pivCol = [];
    const isPivot = new Uint8Array(n);
    let rank = 0;
    for (let col = 0; col < n && rank < m; col++) {
      let best = -1, bestAbs = 1e-9;
      for (let i = rank; i < m; i++) {
        const a = Math.abs(A[i * n + col]);
        if (a > bestAbs) { bestAbs = a; best = i; }
      }
      if (best < 0) continue;
      if (best !== rank) {
        for (let j = 0; j < n; j++) {
          const t = A[rank * n + j]; A[rank * n + j] = A[best * n + j]; A[best * n + j] = t;
        }
      }
      const p = A[rank * n + col];
      for (let j = 0; j < n; j++) A[rank * n + j] /= p;
      for (let i = 0; i < m; i++) {
        if (i === rank) continue;
        const f = A[i * n + col];
        if (f === 0) continue;
        for (let j = 0; j < n; j++) A[i * n + j] -= f * A[rank * n + j];
      }
      pivCol.push(col);
      isPivot[col] = 1;
      rank++;
    }
    const freeCols = [];
    for (let j = 0; j < n; j++) if (!isPivot[j]) freeCols.push(j);
    const nf = freeCols.length;
    const zc = Array.from({ length: n }, () => []);
    const zv = Array.from({ length: n }, () => []);
    freeCols.forEach((j, q) => { zc[j].push(q); zv[j].push(1); });
    for (let r = 0; r < rank; r++) {
      const pc = pivCol[r];
      freeCols.forEach((j, q) => {
        const v = A[r * n + j];
        if (Math.abs(v) > 1e-12) { zc[pc].push(q); zv[pc].push(-v); }
      });
    }
    // independent rows (sparse) for the phase-1 feasibility solve
    const indep = [];
    for (let r = 0; r < rank; r++) {
      const idx = [], val = [];
      for (let j = 0; j < n; j++) {
        const v = A[r * n + j];
        if (Math.abs(v) > 1e-12) { idx.push(j); val.push(v); }
      }
      indep.push({ idx, val });
    }
    return { rank, nf, freeCols, pivCol, zc, zv, indep };
  }

  // ---------- problem assembly ----------

  function buildProblem(model) {
    const errors = [], warnings = [];
    const opt = model.options || {};
    const useSizes = !!opt.sizes;
    const useSizeAssays = !!opt.sizeAssays && useSizes;
    const useAssays = !!opt.assays;
    const bins = useSizes ? (model.bins || []) : [];
    const comps = (useAssays || useSizeAssays) ? (model.comps || []) : [];
    const nodes = model.nodes || [];
    const streams = model.streams || [];
    const nb = useSizes ? bins.length : 1;
    const nk = comps.length;
    const cb = useSizeAssays ? nb : 1;

    if (opt.sizeAssays && !opt.sizes) warnings.push('Assay-by-size data is ignored because particle size distribution is switched off.');
    if (useSizes && nb < 2) errors.push('Define at least two size fractions, or switch particle size distribution off.');
    if ((useAssays || useSizeAssays) && nk < 1) errors.push('Define at least one assayed component, or switch assays off.');
    if (!nodes.length) errors.push('Add at least one node (process unit).');
    if (!streams.length) errors.push('Add at least one stream.');

    const nodeIndex = new Map(nodes.map((nd, i) => [nd.id, i]));
    const nIn = nodes.map(() => 0), nOut = nodes.map(() => 0);
    streams.forEach((st) => {
      const f = st.from != null && nodeIndex.has(st.from) ? nodeIndex.get(st.from) : -1;
      const t = st.to != null && nodeIndex.has(st.to) ? nodeIndex.get(st.to) : -1;
      if (f < 0 && t < 0) errors.push(`Stream "${st.name}" is not connected to any node.`);
      if (f >= 0 && f === t) errors.push(`Stream "${st.name}" leaves and enters the same node.`);
      if (f >= 0) nOut[f]++;
      if (t >= 0) nIn[t]++;
    });
    nodes.forEach((nd, i) => {
      if (!nIn[i]) errors.push(`Node "${nd.name}" has no incoming stream.`);
      if (!nOut[i]) errors.push(`Node "${nd.name}" has no outgoing stream.`);
    });
    const flowsMeasured = streams.filter((s) => isNum(s.flow) && s.flow > 0);
    if (streams.length && !flowsMeasured.length) {
      errors.push('Enter a measured (or assumed) solids flow for at least one stream, for example feed = 100, so the balance has a scale.');
    }
    streams.forEach((s) => { if (isNum(s.flow) && s.flow <= 0) errors.push(`Stream "${s.name}": the measured flow must be greater than zero (leave it blank if unknown).`); });
    if (errors.length) return { errors, warnings };

    const S = streams.length;
    const per = nb + cb * nk;
    const n = S * per;
    const mi = (s, i) => s * per + i;
    const ci = (s, i, k) => s * per + nb + i * nk + k;

    const pct = (v, dflt) => (isNum(v) && v > 0 ? v : dflt) / 100;
    const val = (arr, i) => (arr && isNum(arr[i]) ? arr[i] : null);
    const sa = (st, i, k) => (st.sizeAssay && st.sizeAssay[i] && isNum(st.sizeAssay[i][k]) ? st.sizeAssay[i][k] : null);

    // typical magnitudes
    const Fref = flowsMeasured.reduce((a, s) => a + s.flow, 0) / flowsMeasured.length;
    const avgPsd = [];
    for (let i = 0; i < nb; i++) {
      let sum = 0, cnt = 0;
      if (useSizes) streams.forEach((s) => { const v = val(s.psd, i); if (v != null) { sum += Math.max(v, 0); cnt++; } });
      avgPsd.push(cnt ? sum / cnt : 100 / nb);
    }
    const avgAssay = [];
    for (let k = 0; k < nk; k++) {
      let sum = 0, cnt = 0;
      streams.forEach((s) => {
        if (useAssays) { const v = val(s.assay, k); if (v != null) { sum += Math.abs(v); cnt++; } }
        if (useSizeAssays) for (let i = 0; i < nb; i++) { const v = sa(s, i, k); if (v != null) { sum += Math.abs(v); cnt++; } }
      });
      avgAssay.push(cnt && sum > 0 ? sum / cnt : 1);
    }

    // starting point and scales
    const x0 = new Float64Array(n), w0 = new Float64Array(n), scale = new Float64Array(n);
    streams.forEach((st, s) => {
      const fMeas = isNum(st.flow) && st.flow > 0;
      const F = fMeas ? st.flow : Fref;
      const p = [];
      let anyPsd = false;
      for (let i = 0; i < nb; i++) {
        const v = useSizes ? val(st.psd, i) : null;
        if (v != null) anyPsd = true;
        p.push(Math.max(v != null ? v : avgPsd[i], 0));
      }
      let ps = p.reduce((a, b) => a + b, 0) || 1;
      for (let i = 0; i < nb; i++) p[i] = Math.max(p[i] / ps, 1e-4);
      ps = p.reduce((a, b) => a + b, 0);
      for (let i = 0; i < nb; i++) {
        p[i] /= ps;
        x0[mi(s, i)] = F * p[i];
        w0[mi(s, i)] = fMeas && (anyPsd || !useSizes) ? 1 : 0.1;
        scale[mi(s, i)] = Fref / nb;
      }
      for (let i = 0; i < cb; i++) for (let k = 0; k < nk; k++) {
        let a = useSizeAssays ? sa(st, i, k) : null;
        let known = a != null;
        if (a == null && useAssays) { a = val(st.assay, k); known = a != null; }
        if (a == null) a = avgAssay[k];
        a = Math.max(a, 1e-3 * avgAssay[k]);
        const mass = useSizeAssays ? x0[mi(s, i)] : F;
        x0[ci(s, i, k)] = mass * a;
        w0[ci(s, i, k)] = fMeas && known ? 1 : 0.1;
        scale[ci(s, i, k)] = (Fref / cb) * avgAssay[k];
      }
    });

    // balance rows
    const rows = [];
    nodes.forEach((nd, ni) => {
      const conserve = useSizes && nd.conserveSize !== false;
      const add = (pick) => {
        const idx = [], v = [];
        streams.forEach((st, s) => {
          const sign = (nodeIndex.get(st.to) === ni ? 1 : 0) - (nodeIndex.get(st.from) === ni ? 1 : 0);
          if (!sign) return;
          pick(s).forEach((j) => { idx.push(j); v.push(sign); });
        });
        rows.push({ idx, val: v, node: ni });
      };
      const allBins = [...Array(nb).keys()];
      if (conserve) for (let i = 0; i < nb; i++) add((s) => [mi(s, i)]);
      else add((s) => allBins.map((i) => mi(s, i)));
      for (let k = 0; k < nk; k++) {
        if (useSizeAssays && conserve) for (let i = 0; i < nb; i++) add((s) => [ci(s, i, k)]);
        else add((s) => [...Array(cb).keys()].map((i) => ci(s, i, k)));
      }
    });

    // measurements and reported quantities: value = factor * sum(x[num]) / sum(x[den])
    const meas = [], outs = [];
    const psdMinAbs = isNum(model.psdMinAbs) && model.psdMinAbs > 0 ? model.psdMinAbs : 0.1;
    streams.forEach((st, s) => {
      const allM = [...Array(nb).keys()].map((i) => mi(s, i));
      const q = (kind, i, k, num, den, factor, y, sigma) => {
        const o = { kind, s, i, k, num, den, factor, y: null, sigma: null };
        outs.push(o);
        if (y != null) { o.y = y; o.sigma = sigma; meas.push(o); }
      };
      const eF = pct(st.errFlow, 5), eS = pct(st.errSize, 5), eA = pct(st.errAssay, 5), eSA = pct(st.errSizeAssay, 10);
      const fy = isNum(st.flow) && st.flow > 0 ? st.flow : null;
      q('flow', -1, -1, allM, null, 1, fy, fy != null ? eF * fy : null);
      if (useSizes) for (let i = 0; i < nb; i++) {
        const y = val(st.psd, i);
        q('psd', i, -1, [mi(s, i)], allM, 100, y, y != null ? Math.max(eS * Math.abs(y), psdMinAbs) : null);
      }
      for (let k = 0; k < nk; k++) {
        const minAbs = isNum(comps[k].minAbs) && comps[k].minAbs > 0 ? comps[k].minAbs : 1e-3 * avgAssay[k];
        const y = useAssays ? val(st.assay, k) : null;
        q('assay', -1, k, [...Array(cb).keys()].map((i) => ci(s, i, k)), allM, 1, y, y != null ? Math.max(eA * Math.abs(y), minAbs) : null);
        if (useSizeAssays) for (let i = 0; i < nb; i++) {
          const ys = sa(st, i, k);
          q('sizeAssay', i, k, [ci(s, i, k)], [mi(s, i)], 1, ys, ys != null ? Math.max(eSA * Math.abs(ys), minAbs) : null);
        }
      }
    });

    return { errors, warnings, n, nb, nk, cb, per, S, x0, w0, scale, rows, meas, outs, useSizes, useAssays, useSizeAssays, Fref };
  }

  // value and sparse gradient of one ratio quantity
  function evalQ(q, x) {
    let N = 0, D = 1;
    for (let a = 0; a < q.num.length; a++) N += x[q.num[a]];
    if (q.den) { D = 0; for (let a = 0; a < q.den.length; a++) D += x[q.den[a]]; }
    return q.factor * N / D;
  }
  function gradQ(q, x, g, touched) {
    let N = 0, D = 1;
    for (let a = 0; a < q.num.length; a++) N += x[q.num[a]];
    if (q.den) { D = 0; for (let a = 0; a < q.den.length; a++) D += x[q.den[a]]; }
    const h = q.factor * N / D;
    for (let a = 0; a < q.num.length; a++) {
      const j = q.num[a];
      if (g[j] === 0) touched.push(j);
      g[j] += q.factor / D;
    }
    if (q.den) for (let a = 0; a < q.den.length; a++) {
      const j = q.den[a];
      if (g[j] === 0) touched.push(j);
      g[j] -= h / D;
      if (g[j] === 0) g[j] = 1e-300; // keep it marked as touched
    }
    return h;
  }

  // ---------- phase 1: strictly positive point that satisfies every balance ----------

  function feasiblePoint(P, ns) {
    const { n, x0, w0 } = P;
    const m = ns.rank;
    const mu = 0.01;
    // work in u = x / x0, constraint rows scaled accordingly
    const rows = ns.indep.map((r) => {
      const v = r.val.map((a, q) => a * x0[r.idx[q]]);
      const mx = Math.max(...v.map(Math.abs)) || 1;
      return { idx: r.idx, val: v.map((a) => a / mx) };
    });
    const u = new Float64Array(n).fill(1);
    let nu = new Float64Array(m);
    const resid = (uu, nn) => {
      const rd = new Float64Array(n);
      for (let j = 0; j < n; j++) rd[j] = w0[j] * w0[j] * (uu[j] - 1) - mu / uu[j];
      const rp = new Float64Array(m);
      rows.forEach((r, i) => {
        let s = 0;
        for (let q = 0; q < r.idx.length; q++) { s += r.val[q] * uu[r.idx[q]]; rd[r.idx[q]] += r.val[q] * nn[i]; }
        rp[i] = s;
      });
      let nrm = 0, np = 0;
      for (let j = 0; j < n; j++) nrm += rd[j] * rd[j];
      for (let i = 0; i < m; i++) { nrm += rp[i] * rp[i]; np = Math.max(np, Math.abs(rp[i])); }
      return { rd, rp, norm: Math.sqrt(nrm), np };
    };
    let R = resid(u, nu);
    for (let it = 0; it < 200; it++) {
      if (R.np < 1e-10 && R.norm < 1e-7) break;
      const kinv = new Float64Array(n);
      for (let j = 0; j < n; j++) kinv[j] = 1 / (w0[j] * w0[j] + mu / (u[j] * u[j]));
      // gradient without the multiplier term
      const g = new Float64Array(n);
      for (let j = 0; j < n; j++) g[j] = w0[j] * w0[j] * (u[j] - 1) - mu / u[j];
      // Schur complement  S = A K^-1 A'
      const Sm = new Float64Array(m * m);
      const dense = new Float64Array(n);
      rows.forEach((ri, i) => {
        for (let q = 0; q < ri.idx.length; q++) dense[ri.idx[q]] = ri.val[q] * kinv[ri.idx[q]];
        for (let k = i; k < m; k++) {
          const rk = rows[k];
          let s = 0;
          for (let q = 0; q < rk.idx.length; q++) s += rk.val[q] * dense[rk.idx[q]];
          Sm[i * m + k] = s; Sm[k * m + i] = s;
        }
        for (let q = 0; q < ri.idx.length; q++) dense[ri.idx[q]] = 0;
      });
      const rhs = new Float64Array(m);
      rows.forEach((r, i) => {
        let s = R.rp[i];
        for (let q = 0; q < r.idx.length; q++) s -= r.val[q] * kinv[r.idx[q]] * g[r.idx[q]];
        rhs[i] = s;
      });
      const wNew = m ? spdFactor(Sm, m).solve(rhs) : new Float64Array(0);
      const du = new Float64Array(n);
      for (let j = 0; j < n; j++) du[j] = -g[j];
      rows.forEach((r, i) => { for (let q = 0; q < r.idx.length; q++) du[r.idx[q]] -= r.val[q] * wNew[i]; });
      for (let j = 0; j < n; j++) du[j] *= kinv[j];
      let t = 1;
      for (let j = 0; j < n; j++) if (du[j] < 0) t = Math.min(t, -0.99 * u[j] / du[j]);
      let accepted = false;
      for (let ls = 0; ls < 40; ls++) {
        const un = new Float64Array(n), nn = new Float64Array(m);
        for (let j = 0; j < n; j++) un[j] = u[j] + t * du[j];
        for (let i = 0; i < m; i++) nn[i] = nu[i] + t * (wNew[i] - nu[i]);
        const Rn = resid(un, nn);
        if (Rn.norm <= (1 - 0.01 * t) * R.norm) { u.set(un); nu = nn; R = Rn; accepted = true; break; }
        t *= 0.5;
      }
      if (!accepted) break;
    }
    if (R.np > 1e-7) return null;
    const x = new Float64Array(n);
    for (let j = 0; j < n; j++) x[j] = u[j] * x0[j];
    // remove round-off: recompute dependent variables from the free ones
    const f = ns.freeCols.map((j) => x[j]);
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let q = 0; q < ns.zc[j].length; q++) s += ns.zv[j][q] * f[ns.zc[j][q]];
      if (!(s > 0)) return null;
      x[j] = s;
    }
    return x;
  }

  // ---------- phase 2: barrier Gauss-Newton on the null space ----------

  const RHO = 1e-6; // tiny pull toward the starting point; keeps unobservable variables bounded

  function objective(P, x, xref, mu) {
    let f = 0;
    for (let q = 0; q < P.meas.length; q++) {
      const r = (evalQ(P.meas[q], x) - P.meas[q].y) / P.meas[q].sigma;
      f += 0.5 * r * r;
    }
    const chi2 = 2 * f;
    for (let j = 0; j < P.n; j++) {
      const d = (x[j] - xref[j]) / P.scale[j];
      f += 0.5 * RHO * d * d - mu * Math.log(x[j] / P.scale[j]);
    }
    return { f, chi2 };
  }

  /** Reduced Gauss-Newton matrix Z'(J'J)Z, plus the full-space gradient J'r. */
  function reducedNormal(P, ns, x) {
    const { n } = P, nf = ns.nf;
    const M = new Float64Array(nf * nf);
    const grad = new Float64Array(n);
    const g = new Float64Array(n), touched = [];
    const red = new Float64Array(nf), rt = [];
    for (let q = 0; q < P.meas.length; q++) {
      const ms = P.meas[q];
      touched.length = 0;
      const h = gradQ(ms, x, g, touched);
      const r = (h - ms.y) / ms.sigma;
      rt.length = 0;
      for (let a = 0; a < touched.length; a++) {
        const j = touched[a];
        const gj = g[j] / ms.sigma;
        g[j] = 0;
        grad[j] += gj * r;
        const zc = ns.zc[j], zv = ns.zv[j];
        for (let b = 0; b < zc.length; b++) {
          if (red[zc[b]] === 0) rt.push(zc[b]);
          red[zc[b]] += gj * zv[b];
          if (red[zc[b]] === 0) red[zc[b]] = 1e-300;
        }
      }
      for (let a = 0; a < rt.length; a++) {
        const ia = rt[a], va = red[ia];
        for (let b = 0; b < rt.length; b++) M[ia * nf + rt[b]] += va * red[rt[b]];
      }
      for (let a = 0; a < rt.length; a++) red[rt[a]] = 0;
    }
    return { M, grad };
  }

  function addDiag(ns, M, d) {
    const nf = ns.nf;
    for (let j = 0; j < d.length; j++) {
      const zc = ns.zc[j], zv = ns.zv[j], dj = d[j];
      for (let a = 0; a < zc.length; a++) for (let b = 0; b < zc.length; b++) M[zc[a] * nf + zc[b]] += dj * zv[a] * zv[b];
    }
  }
  function zT(ns, v) {
    const out = new Float64Array(ns.nf);
    for (let j = 0; j < v.length; j++) {
      const zc = ns.zc[j], zv = ns.zv[j];
      for (let a = 0; a < zc.length; a++) out[zc[a]] += zv[a] * v[j];
    }
    return out;
  }
  function zMul(ns, f, n) {
    const out = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      const zc = ns.zc[j], zv = ns.zv[j];
      let s = 0;
      for (let a = 0; a < zc.length; a++) s += zv[a] * f[zc[a]];
      out[j] = s;
    }
    return out;
  }

  function minimise(P, ns, xStart) {
    const { n } = P, nf = ns.nf;
    let x = Float64Array.from(xStart);
    const xref = Float64Array.from(xStart);
    let lambda = 1e-3, iterations = 0, converged = true;
    const mus = [1e-1, 1e-2, 1e-3, 1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9, 1e-10];
    for (const mu of mus) {
      let cur = objective(P, x, xref, mu);
      let done = false;
      for (let it = 0; it < 60 && !done; it++) {
        iterations++;
        const { M, grad } = reducedNormal(P, ns, x);
        const d = new Float64Array(n);
        for (let j = 0; j < n; j++) {
          grad[j] += RHO * (x[j] - xref[j]) / (P.scale[j] * P.scale[j]) - mu / x[j];
          d[j] = RHO / (P.scale[j] * P.scale[j]) + mu / (x[j] * x[j]);
        }
        const gz = zT(ns, grad);
        let stepped = false;
        for (let tries = 0; tries < 25 && !stepped; tries++) {
          const K = Float64Array.from(M);
          for (let i = 0; i < nf; i++) K[i * nf + i] *= 1 + lambda;
          addDiag(ns, K, d);
          const rhs = new Float64Array(nf);
          for (let i = 0; i < nf; i++) rhs[i] = -gz[i];
          const df = spdFactor(K, nf).solve(rhs);
          const dx = zMul(ns, df, n);
          let slope = 0;
          for (let i = 0; i < nf; i++) slope += gz[i] * df[i];
          if (-slope < 1e-10 * (1 + Math.abs(cur.f))) { done = true; break; }
          let t = 1;
          for (let j = 0; j < n; j++) if (dx[j] < 0) t = Math.min(t, -0.995 * x[j] / dx[j]);
          for (let ls = 0; ls < 8; ls++) {
            const xn = new Float64Array(n);
            for (let j = 0; j < n; j++) xn[j] = x[j] + t * dx[j];
            const nxt = objective(P, xn, xref, mu);
            if (isFinite(nxt.f) && nxt.f <= cur.f + 1e-4 * t * slope) {
              x = xn; cur = nxt; stepped = true;
              if (ls === 0) lambda = Math.max(lambda / 3, 1e-9);
              break;
            }
            t *= 0.5;
          }
          if (!stepped) lambda = Math.min(lambda * 10, 1e12);
        }
        if (!stepped && !done) { done = true; }
      }
      if (!done) converged = false;
    }
    return { x, xref, iterations, converged, chi2: objective(P, x, xref, 0).chi2 };
  }

  // ---------- standard deviations of the reconciled values ----------

  function uncertainties(P, ns, x) {
    const { n } = P, nf = ns.nf;
    const { M } = reducedNormal(P, ns, x);
    const factorFor = (rho) => {
      const K = Float64Array.from(M);
      const d = new Float64Array(n);
      for (let j = 0; j < n; j++) d[j] = rho / (P.scale[j] * P.scale[j]);
      addDiag(ns, K, d);
      return spdFactor(K, nf);
    };
    const F1 = factorFor(RHO), F2 = factorFor(RHO * 100);
    const g = new Float64Array(n), touched = [];
    return P.outs.map((o) => {
      touched.length = 0;
      const value = gradQ(o, x, g, touched);
      const full = new Float64Array(n);
      for (let a = 0; a < touched.length; a++) { full[touched[a]] = g[touched[a]]; g[touched[a]] = 0; }
      const gz = zT(ns, full);
      const dot = (F) => { const y = F.solve(gz); let s = 0; for (let i = 0; i < nf; i++) s += gz[i] * y[i]; return Math.max(s, 0); };
      const v1 = dot(F1), v2 = dot(F2);
      // if the variance is set by the artificial prior, the quantity is not fixed by the data
      const observable = !(v1 > 5 * v2 && v1 > 0);
      return { value, sd: Math.sqrt(v1), observable };
    });
  }

  // ---------- public entry point ----------

  function reconcile(model) {
    const P = buildProblem(model);
    if (P.errors.length) return { ok: false, errors: P.errors, warnings: P.warnings };
    const warnings = P.warnings.slice();
    let ns, xFeas, sol, unc;
    try {
      ns = nullSpace(P.rows, P.n);
      xFeas = feasiblePoint(P, ns);
      if (!xFeas) {
        return { ok: false, warnings, errors: ['No set of strictly positive flows satisfies the node network. Check stream directions and connections: every unit must be able to pass on what it receives.'] };
      }
      sol = minimise(P, ns, xFeas);
      unc = uncertainties(P, ns, sol.x);
    } catch (e) {
      return { ok: false, warnings, errors: ['The solver failed: ' + e.message] };
    }
    if (!sol.converged) warnings.push('The solver stopped at its iteration limit. Results may not be fully converged.');

    const streams = (model.streams || []).map(() => ({ flow: null, psd: [], assay: [], sizeAssay: [] }));
    let nUnobs = 0;
    P.outs.forEach((o, q) => {
      const u = unc[q];
      const cell = {
        value: u.value, sd: u.observable ? u.sd : null, observable: u.observable,
        measured: o.y, sigma: o.sigma,
        z: o.y != null ? (u.value - o.y) / o.sigma : null,
      };
      if (!u.observable) nUnobs++;
      const st = streams[o.s];
      if (o.kind === 'flow') st.flow = cell;
      else if (o.kind === 'psd') st.psd[o.i] = cell;
      else if (o.kind === 'assay') st.assay[o.k] = cell;
      else { (st.sizeAssay[o.i] = st.sizeAssay[o.i] || [])[o.k] = cell; }
    });
    if (nUnobs) warnings.push(`${nUnobs} reported value(s) cannot be determined from the data entered (shown as "n.d."). Add measurements on those streams to fix them.`);
    const nMeas = P.meas.length;
    const dof = nMeas - ns.nf;
    if (dof <= 0) warnings.push('There is no redundancy: the number of measurements does not exceed the number of unknowns, so the data cannot be checked or improved by reconciliation.');
    return {
      ok: true, errors: [], warnings, streams,
      chi2: sol.chi2, nMeas, nUnknowns: ns.nf, nBalances: ns.rank, dof: Math.max(dof, 0),
      iterations: sol.iterations, converged: sol.converged,
      nb: P.nb, nk: P.nk, useSizes: P.useSizes, useAssays: P.useAssays, useSizeAssays: P.useSizeAssays,
    };
  }

  return { reconcile };
});
