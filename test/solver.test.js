'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reconcile } = require('../js/solver.js');
const { makeModel } = require('./circuit.js');

const ALL = { sizes: true, assays: true, sizeAssays: true };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

/** Largest node imbalance of the reconciled values, relative to the feed. */
function maxImbalance(model, res) {
  let worst = 0;
  const nb = res.useSizes ? model.bins.length : 1;
  model.nodes.forEach((nd) => {
    const sum = (fn) => model.streams.reduce((a, st, s) => a + ((st.to === nd.id) - (st.from === nd.id)) * fn(res.streams[s]), 0);
    worst = Math.max(worst, Math.abs(sum((r) => r.flow.value)));
    if (res.useSizes && nd.conserveSize) for (let i = 0; i < nb; i++) worst = Math.max(worst, Math.abs(sum((r) => r.flow.value * r.psd[i].value / 100)));
    for (let k = 0; k < res.nk; k++) {
      worst = Math.max(worst, Math.abs(sum((r) => r.flow.value * r.assay[k].value)));
      if (res.useSizeAssays && nd.conserveSize) for (let i = 0; i < nb; i++) {
        worst = Math.max(worst, Math.abs(sum((r) => r.flow.value * r.psd[i].value / 100 * r.sizeAssay[i][k].value)));
      }
    }
  });
  return worst;
}

for (const options of [
  { sizes: false, assays: true, sizeAssays: false },
  { sizes: true, assays: false, sizeAssays: false },
  { sizes: true, assays: true, sizeAssays: false },
  { sizes: true, assays: false, sizeAssays: true },
  ALL,
]) {
  test(`exact data is reproduced: ${JSON.stringify(options)}`, () => {
    const { model, truth } = makeModel(options, 0);
    const res = reconcile(model);
    assert.ok(res.ok, res.errors && res.errors.join('; '));
    assert.ok(res.chi2 < 1e-6, 'chi2 ' + res.chi2);
    truth.streams.forEach((t, s) => {
      close(res.streams[s].flow.value, t.flow, 1e-3 * t.flow, t.name + ' flow');
      if (options.sizes) t.psd.forEach((v, i) => close(res.streams[s].psd[i].value, v, 1e-3, t.name + ' psd'));
      if (res.nk) t.assay.forEach((v, k) => close(res.streams[s].assay[k].value, v, 1e-3 * v + 1e-5, t.name + ' assay'));
    });
    assert.ok(maxImbalance(model, res) < 1e-6);
  });
}

test('noisy data: balances close, adjustments are plausible, sd shrinks', () => {
  const { model } = makeModel(ALL, 7);
  const res = reconcile(model);
  assert.ok(res.ok);
  assert.ok(maxImbalance(model, res) < 1e-6, 'imbalance ' + maxImbalance(model, res));
  assert.ok(res.dof > 0);
  assert.ok(res.chi2 / res.dof < 2, 'chi2/dof ' + res.chi2 / res.dof);
  res.streams.forEach((st) => {
    const cells = [st.flow, ...st.psd, ...st.assay, ...st.sizeAssay.flat()];
    cells.forEach((c) => {
      assert.ok(c.value >= 0);
      assert.ok(c.observable);
      if (c.sigma != null) assert.ok(c.sd <= c.sigma * 1.0001, `sd ${c.sd} > sigma ${c.sigma}`);
    });
  });
});

test('predicted standard deviations match Monte Carlo scatter', () => {
  const options = { sizes: true, assays: true, sizeAssays: false };
  const runs = 300;
  const sums = [], sq = [];
  let pred = null;
  for (let r = 0; r < runs; r++) {
    const { model } = makeModel(options, 1000 + r);
    const res = reconcile(model);
    assert.ok(res.ok);
    const vals = res.streams.flatMap((st) => [st.flow.value, ...st.psd.map((c) => c.value), ...st.assay.map((c) => c.value)]);
    if (!pred) pred = res.streams.flatMap((st) => [st.flow.sd, ...st.psd.map((c) => c.sd), ...st.assay.map((c) => c.sd)]);
    vals.forEach((v, i) => { sums[i] = (sums[i] || 0) + v; sq[i] = (sq[i] || 0) + v * v; });
  }
  let ratioSum = 0;
  pred.forEach((p, i) => {
    const mean = sums[i] / runs;
    const sd = Math.sqrt(Math.max(sq[i] / runs - mean * mean, 0));
    const ratio = sd / p;
    ratioSum += ratio;
    assert.ok(ratio > 0.6 && ratio < 1.5, `quantity ${i}: empirical ${sd} vs predicted ${p}`);
  });
  close(ratioSum / pred.length, 1, 0.12, 'mean sd ratio');
});

test('flows stay non-negative when the assays imply a negative split', () => {
  // Two-product formula gives a negative concentrate flow: feed 1.0, conc 0.8, tail 1.2 would be fine,
  // but here both products assay higher than the feed.
  const model = {
    options: { sizes: false, assays: true, sizeAssays: false },
    bins: [], comps: [{ name: 'Cu', unit: '%', minAbs: 0.001 }],
    nodes: [{ id: 'n', name: 'Separator', conserveSize: true }],
    streams: [
      { id: 'a', name: 'Feed', from: null, to: 'n', flow: 100, errFlow: 1, errAssay: 2, assay: [1.0] },
      { id: 'b', name: 'Conc', from: 'n', to: null, flow: null, errAssay: 2, assay: [1.3] },
      { id: 'c', name: 'Tail', from: 'n', to: null, flow: null, errAssay: 2, assay: [1.1] },
    ],
  };
  const res = reconcile(model);
  assert.ok(res.ok, res.errors && res.errors.join('; '));
  res.streams.forEach((st) => { assert.ok(st.flow.value >= 0); assert.ok(st.assay[0].value >= 0); });
  close(res.streams[1].flow.value + res.streams[2].flow.value, res.streams[0].flow.value, 1e-6);
  // conc is driven to (almost) zero
  assert.ok(res.streams[1].flow.value < 1, 'conc flow ' + res.streams[1].flow.value);
});

test('two-product formula is recovered with no redundancy', () => {
  const model = {
    options: { sizes: false, assays: true, sizeAssays: false },
    bins: [], comps: [{ name: 'Cu', unit: '%', minAbs: 0.001 }],
    nodes: [{ id: 'n', name: 'Separator' }],
    streams: [
      { id: 'a', name: 'Feed', from: null, to: 'n', flow: 100, errFlow: 1, errAssay: 2, assay: [1.0] },
      { id: 'b', name: 'Conc', from: 'n', to: null, flow: null, errAssay: 2, assay: [20] },
      { id: 'c', name: 'Tail', from: 'n', to: null, flow: null, errAssay: 2, assay: [0.1] },
    ],
  };
  const res = reconcile(model);
  assert.ok(res.ok);
  close(res.streams[1].flow.value, 100 * (1.0 - 0.1) / (20 - 0.1), 1e-4);
  assert.strictEqual(res.dof, 0);
});

test('unmeasured component on an isolated stream is flagged, not invented', () => {
  const { model } = makeModel({ sizes: false, assays: true, sizeAssays: false }, 3);
  // add a second, unassayed product pair so Fe on those streams cannot be resolved
  model.nodes.push({ id: 'n4', name: 'Cleaner', conserveSize: true });
  model.streams[4].to = 'n4';
  model.streams.push(
    { id: 's7', name: 'Cleaner conc', from: 'n4', to: null, flow: null, assay: [null, null] },
    { id: 's8', name: 'Cleaner tail', from: 'n4', to: null, flow: null, assay: [null, null] },
  );
  const res = reconcile(model);
  assert.ok(res.ok);
  assert.strictEqual(res.streams[6].flow.observable, false);
  assert.strictEqual(res.streams[6].flow.sd, null);
  assert.strictEqual(res.streams[0].flow.observable, true);
});

test('input problems are reported', () => {
  const { model } = makeModel(ALL, 0);
  model.streams.forEach((s) => { s.flow = null; });
  let res = reconcile(model);
  assert.ok(!res.ok && /flow/.test(res.errors[0]));
  const m2 = makeModel(ALL, 0).model;
  m2.streams = m2.streams.filter((s) => s.name !== 'Tailings' && s.name !== 'Concentrate');
  res = reconcile(m2);
  assert.ok(!res.ok && /no outgoing/.test(res.errors.join(' ')));
});
