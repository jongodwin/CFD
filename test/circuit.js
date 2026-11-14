'use strict';
/*
 * Synthetic grinding + flotation circuit with exactly balanced "true" values.
 *   Ball mill (does not conserve size):  Fresh feed + Cyclone U/F -> Mill discharge
 *   Hydrocyclone (conserves size):       Mill discharge -> Cyclone O/F + Cyclone U/F
 *   Rougher flotation (conserves size):  Cyclone O/F -> Concentrate + Tailings
 */
const bins = ['+300 µm', '-300 +150 µm', '-150 +75 µm', '-75 +38 µm', '-38 µm'];
const comps = [{ name: 'Cu', unit: '%', minAbs: 0.01 }, { name: 'Fe', unit: '%', minAbs: 0.05 }];

function trueCircuit() {
  const nb = bins.length;
  // mass flow by size (t/h) and assay by size (%) for the fresh feed
  const feedM = [38, 27, 17, 10, 8];
  const feedCu = [0.55, 0.70, 0.95, 1.25, 1.45];
  const feedFe = [4.2, 4.8, 5.6, 6.4, 7.0];
  // cyclone: fraction of each size reporting to underflow
  const toUF = [0.97, 0.86, 0.60, 0.33, 0.22];
  // mill discharge size distribution and assay-by-size (liberation shifts metal to fines)
  const mdP = [0.10, 0.20, 0.25, 0.20, 0.25];
  const mdCuShape = [0.50, 0.65, 0.90, 1.20, 1.50];
  const mdFeShape = [4.0, 4.6, 5.4, 6.2, 7.2];
  // Solve the recirculating load: O/F total must equal fresh feed total.
  const F = feedM.reduce((a, b) => a + b, 0);
  const ofFrac = mdP.reduce((a, p, i) => a + p * (1 - toUF[i]), 0);
  const MD = F / ofFrac;
  const mdM = mdP.map((p) => p * MD);
  const ufM = mdM.map((m, i) => m * toUF[i]);
  const ofM = mdM.map((m, i) => m * (1 - toUF[i]));
  // component flows: cyclone splits each size fraction without changing its assay,
  // so mill discharge assay shapes are scaled to close the component balance.
  const scaleFor = (feedA, shape) => {
    const feedC = feedM.reduce((a, m, i) => a + m * feedA[i], 0);
    const ofC = ofM.reduce((a, m, i) => a + m * shape[i], 0);
    return feedC / ofC;
  };
  const kCu = scaleFor(feedCu, mdCuShape), kFe = scaleFor(feedFe, mdFeShape);
  const mdCu = mdCuShape.map((v) => v * kCu), mdFe = mdFeShape.map((v) => v * kFe);
  // flotation: recovery by size for solids, Cu and Fe
  const recM = [0.02, 0.04, 0.07, 0.09, 0.08];
  const recCu = [0.45, 0.78, 0.92, 0.93, 0.80];
  const recFe = [0.05, 0.10, 0.16, 0.19, 0.15];
  const conM = ofM.map((m, i) => m * recM[i]);
  const taM = ofM.map((m, i) => m - conM[i]);
  const conCu = ofM.map((m, i) => (m * mdCu[i] * recCu[i]) / conM[i]);
  const conFe = ofM.map((m, i) => (m * mdFe[i] * recFe[i]) / conM[i]);
  const taCu = ofM.map((m, i) => (m * mdCu[i] * (1 - recCu[i])) / taM[i]);
  const taFe = ofM.map((m, i) => (m * mdFe[i] * (1 - recFe[i])) / taM[i]);

  const mk = (name, from, to, m, cu, fe) => {
    const flow = m.reduce((a, b) => a + b, 0);
    return {
      name, from, to, flow,
      psd: m.map((v) => (100 * v) / flow),
      sizeAssay: m.map((_, i) => [cu[i], fe[i]]),
      assay: [
        m.reduce((a, v, i) => a + v * cu[i], 0) / flow,
        m.reduce((a, v, i) => a + v * fe[i], 0) / flow,
      ],
    };
  };
  return {
    nb,
    nodes: [
      { id: 'n1', name: 'Ball mill', conserveSize: false },
      { id: 'n2', name: 'Hydrocyclone', conserveSize: true },
      { id: 'n3', name: 'Rougher flotation', conserveSize: true },
    ],
    streams: [
      mk('Fresh feed', null, 'n1', feedM, feedCu, feedFe),
      mk('Mill discharge', 'n1', 'n2', mdM, mdCu, mdFe),
      mk('Cyclone U/F', 'n2', 'n1', ufM, mdCu, mdFe),
      mk('Cyclone O/F', 'n2', 'n3', ofM, mdCu, mdFe),
      mk('Concentrate', 'n3', null, conM, conCu, conFe),
      mk('Tailings', 'n3', null, taM, taCu, taFe),
    ],
  };
}

// deterministic pseudo-random normal numbers
function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

const ERR = { errFlow: 2, errSize: 5, errAssay: 3, errSizeAssay: 6 };

/** Build a solver model from the true circuit, optionally with noise. */
function makeModel(options, noise) {
  const truth = trueCircuit();
  const gauss = noise ? rng(noise) : () => 0;
  const pert = (v, relPct, minAbs) => Math.max(v + gauss() * Math.max((relPct / 100) * v, minAbs), 0);
  const streams = truth.streams.map((t, s) => ({
    id: 's' + (s + 1), name: t.name, from: t.from, to: t.to, ...ERR,
    // only the fresh feed and the concentrate are weighed
    flow: s === 0 || s === 4 ? pert(t.flow, ERR.errFlow, 0) : null,
    psd: t.psd.map((v) => pert(v, ERR.errSize, 0.1)),
    assay: t.assay.map((v, k) => pert(v, ERR.errAssay, comps[k].minAbs)),
    sizeAssay: t.sizeAssay.map((row) => row.map((v, k) => pert(v, ERR.errSizeAssay, comps[k].minAbs))),
  }));
  return {
    truth,
    model: {
      options, psdMinAbs: 0.1,
      bins: bins.map((label) => ({ label })), comps,
      nodes: truth.nodes, streams,
    },
  };
}

module.exports = { trueCircuit, makeModel, bins, comps, ERR };
