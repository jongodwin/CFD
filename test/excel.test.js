'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reconcile } = require('../js/solver.js');
const X = require('../js/excel.js');
const ExcelJS = require('../js/vendor/exceljs.min.js');
const { makeModel } = require('./circuit.js');

const ALL = { sizes: true, assays: true, sizeAssays: true };
function project(options) {
  const { model } = makeModel(options || ALL, 5);
  model.flowUnit = 't/h';
  model.nodes.forEach((n, i) => { n.x = 200 + i * 250; n.y = 200; });
  // round so values survive any text formatting
  model.streams.forEach((s) => {
    s.flow = s.flow == null ? null : +s.flow.toFixed(2);
    s.psd = s.psd.map((v) => +v.toFixed(2));
    s.assay = s.assay.map((v) => +v.toFixed(3));
    s.sizeAssay = s.sizeAssay.map((r) => r.map((v) => +v.toFixed(3)));
  });
  return model;
}
const data = (p) => p.streams.map((s) => ({ name: s.name, flow: s.flow, psd: s.psd, assay: s.assay, sizeAssay: s.sizeAssay, errFlow: s.errFlow, errSize: s.errSize, errAssay: s.errAssay, errSizeAssay: s.errSizeAssay }));
const blank = () => ({ options: { sizes: false, assays: false, sizeAssays: false }, flowUnit: 't/h', bins: [], comps: [], nodes: [], streams: [] });
const xlsxRoundTrip = async (sheets) => X.readWorkbook(ExcelJS, await X.writeWorkbook(ExcelJS, sheets));

test('export then import with network rebuilds the whole project from a blank app', async () => {
  const p = project();
  const sheets = await xlsxRoundTrip(X.buildSheets(p, null));
  const res = X.applySheets(sheets, blank(), { network: true });
  assert.ok(res.ok, res.messages.join('; '));
  assert.deepStrictEqual(res.messages, []);
  const q = res.project;
  assert.deepStrictEqual(q.options, ALL);
  assert.deepStrictEqual(q.bins, p.bins);
  assert.deepStrictEqual(q.comps, p.comps);
  assert.deepStrictEqual(q.nodes.map((n) => [n.name, n.conserveSize]), p.nodes.map((n) => [n.name, n.conserveSize]));
  const name = (proj, id) => (proj.nodes.find((n) => n.id === id) || {}).name || null;
  assert.deepStrictEqual(q.streams.map((s) => [name(q, s.from), name(q, s.to)]), p.streams.map((s) => [name(p, s.from), name(p, s.to)]));
  assert.deepStrictEqual(data(q), data(p));
  q.nodes.forEach((n) => assert.ok(n.x > 0 && n.y > 0));
  // and it reconciles to the same answer
  const a = reconcile(p), b = reconcile(q);
  assert.ok(a.ok && b.ok);
  assert.ok(Math.abs(a.chi2 - b.chi2) < 1e-6);
});

test('template has the network but no measurements, and filling it imports data only', async () => {
  const p = project();
  const tpl = X.buildSheets(p, null, { template: true });
  const sheet = (n) => tpl.find((s) => s.name === n);
  assert.deepStrictEqual(sheet('Size distribution').rows[0], ['Stream', ...p.bins.map((b) => b.label)]);
  sheet('Size distribution').rows.slice(1).forEach((r) => assert.ok(r.slice(1).every((v) => v == null)));
  sheet('Streams').rows.slice(1).forEach((r) => { assert.strictEqual(r[3], null); assert.strictEqual(r[4], 2); });
  assert.ok(sheet(X.bySizeName('Cu')) && sheet('Head assays') && sheet('Units'));

  // "paste" data into the template: fill from the full export, shuffle rows, drop one stream
  const full = X.buildSheets(p, null);
  tpl.forEach((s) => { const f = full.find((q) => q.name === s.name); s.rows = [f.rows[0], ...f.rows.slice(1).reverse()]; });
  sheet('Head assays').rows = sheet('Head assays').rows.filter((r) => r[0] !== 'Tailings');
  sheet('Head assays').rows.push(['Mystery stream', 1, 2]);
  sheet('Head assays').rows[1][1] = 'abc';

  const empty = JSON.parse(JSON.stringify(p));
  empty.streams.forEach((s) => { s.flow = null; s.psd = s.psd.map(() => null); s.assay = s.assay.map(() => 9); s.sizeAssay = s.sizeAssay.map((r) => r.map(() => null)); });
  const res = X.applySheets(await xlsxRoundTrip(tpl), empty, { network: false });
  assert.ok(res.ok, res.messages.join('; '));
  const q = res.project;
  assert.deepStrictEqual(q.nodes, p.nodes);
  assert.deepStrictEqual(q.streams.map((s) => s.id), p.streams.map((s) => s.id));
  assert.deepStrictEqual(q.streams.map((s) => s.psd), p.streams.map((s) => s.psd));
  assert.deepStrictEqual(q.streams.map((s) => s.sizeAssay), p.streams.map((s) => s.sizeAssay));
  assert.deepStrictEqual(q.streams[5].assay, [9, 9], 'stream missing from the sheet keeps its data');
  assert.strictEqual(q.streams[4].assay[0], null, 'non-numeric cell becomes blank');
  assert.strictEqual(q.streams[4].assay[1], p.streams[4].assay[1]);
  assert.ok(res.messages.some((m) => /Mystery stream/.test(m)));
  assert.ok(res.messages.some((m) => /not numbers/.test(m)));
});

test('results are written to output sheets and ignored on import', async () => {
  const p = project();
  const R = reconcile(p);
  const sheets = X.buildSheets(p, R);
  const names = sheets.map((s) => s.name);
  ['Out Fit summary', 'Results', 'Out Flow', 'Out Size distribution', 'Out Head assays', 'Out Cu by size', 'Out Fe by size'].forEach((n) => assert.ok(names.includes(n), n));
  const flow = sheets.find((s) => s.name === 'Out Flow').rows;
  assert.deepStrictEqual(flow[2].slice(0, 2), ['Fresh feed', 'Reconciled']);
  assert.ok(Math.abs(flow[2][2] - R.streams[0].flow.value) < 1e-12);
  assert.ok(Math.abs(flow[3][2] - R.streams[0].flow.sd) < 1e-12);
  const res = X.applySheets(await xlsxRoundTrip(sheets), blank(), { network: true });
  assert.ok(res.ok);
  assert.deepStrictEqual(res.messages, []);
  assert.deepStrictEqual(data(res.project), data(p));
});

test('only the selected data types are in the workbook', () => {
  const p = project({ sizes: false, assays: true, sizeAssays: false });
  const names = X.buildSheets(p, null, { template: true }).map((s) => s.name);
  assert.deepStrictEqual(names, ['Read me', 'Units', 'Components', 'Streams', 'Head assays']);
  const res = X.applySheets(X.buildSheets(p, null), blank(), { network: true });
  assert.deepStrictEqual(res.project.options, { sizes: false, assays: true, sizeAssays: false });
});

test('helpful failures', () => {
  const p = project();
  assert.ok(!X.applySheets([{ name: 'Sheet1', rows: [['a']] }], p, {}).ok);
  const other = X.buildSheets(p, null);
  other.forEach((s) => s.rows.slice(1).forEach((r) => { if (s.name !== 'Units' && s.name !== 'Components') r[0] = 'X ' + r[0]; }));
  const res = X.applySheets(other, p, { network: false });
  assert.ok(!res.ok && /stream names/.test(res.messages[0]));
  assert.ok(!X.applySheets(other.filter((s) => s.name !== 'Units'), p, { network: true }).ok);
});
