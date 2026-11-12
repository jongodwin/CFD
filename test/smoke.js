// Smoke test / CLI: node test/smoke.js '{"rpm":200,"impType":"pbt"}'
require('../js/solver.js');
require('../js/analysis.js');
const C = globalThis.CSTR;
(async () => {
  const over = JSON.parse(process.argv[2] || '{}');
  const r = await C.simulate(Object.assign({}, C.DEFAULTS, over));
  const { g, hydro: h, rtd, settling: s, solids: so } = r;
  const f = (x, n = 3) => (typeof x === 'number' ? Number(x.toPrecision(n)) : x);
  const out = {
    grid: `${g.Nr}x${g.Nz}`, wall_s: r.wallSeconds, converged: r.flow.converged, Re: f(g.Re), Np: f(h.Np), Nq: f(h.Nq), power_W: f(h.power),
    tCirc_s: f(h.tCirc), blend95_s: f(h.blend95), nutRatio: f(h.nutRatio),
    rtd: rtd && { tau_s: f(rtd.tau), tMean_over_tau: f(rtd.tMean / rtd.tau, 4), sigmaTheta2: f(rtd.sigmaTheta2), nTanks: f(rtd.nTanks), tFirst_s: f(rtd.tFirst), t10: f(rtd.t10 / rtd.tau), t50: f(rtd.t50 / rtd.tau), t90: f(rtd.t90 / rtd.tau), Epeak: f(rtd.Epeak), thPeak: f(rtd.thPeak), mixedFraction: f(rtd.mixedFraction), ageAvg_over_tau: f(rtd.ageAvg / rtd.tau, 4), ageMax_over_tau: f(rtd.ageMax / rtd.tau, 4), stagnant: f(rtd.stagnantFraction), steps: rtd.t.length },
    settling: { vt_mm_s: f(s.vt * 1000), ReP: f(s.ReP), nRZ: f(s.nRZ), cv: f(s.cv), Njs_rpm: f(s.Njs * 60), ratio: f(s.ratio), S: f(s.S) },
    solids: so && { cloud: f(so.cloudHeight), rsd: f(so.rsd), bottomRatio: f(so.bottomRatio), outRatio: f(so.outRatio), lowMass: f(so.lowMassFraction), iters: so.iters, conv: so.converged, cMax: f(so.cMax) },
    state: r.suspension.label,
  };
  console.log(JSON.stringify(out, null, 1));
  let ok = isFinite(h.Np) && h.Np > 0 && (!rtd || Math.abs(rtd.tMean / rtd.tau - 1) < 0.05);
  if (!ok) { console.error('SMOKE TEST FAILED'); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
