/*
 * Excel import / export for the Mass Balance Reconciler.
 *
 * buildSheets / applySheets work on plain arrays ({ name, rows }) so they can be
 * tested without a spreadsheet library; writeWorkbook / readWorkbook convert
 * those to and from .xlsx with ExcelJS.
 *
 * Workbook layout (one row per stream on every data sheet, matched by name):
 *   Units              Unit | Size behaviour
 *   Components         Component | Unit | Smallest absolute error
 *   Streams            Stream | From unit | To unit | Solids flow | error columns
 *   Size distribution  Stream | one column per size fraction (mass % retained)
 *   Head assays        Stream | one column per component
 *   <Comp> by size     Stream | one column per size fraction
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MassBalanceExcel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEEP = 'Keeps size', BREAK = 'Changes size';
  const norm = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase();
  const sheetName = (name) => String(name).replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31);
  const bySizeName = (comp) => sheetName(sheetName(comp).slice(0, 23) + ' by size');
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  const ERR_COLS = [
    { key: 'errFlow', label: 'Flow error, %', match: 'flow error', when: () => true },
    { key: 'errSize', label: 'Size error, %', match: 'size error', when: (o) => o.sizes },
    { key: 'errAssay', label: 'Assay error, %', match: 'assay error', when: (o) => o.assays },
    { key: 'errSizeAssay', label: 'Size-fraction assay error, %', match: 'size-fraction assay error', when: (o) => o.sizeAssays && o.sizes },
  ];

  // ---------- project -> sheets ----------

  /**
   * opts.template: leave measurements blank (the network, options and error
   * estimates are kept) so data can be pasted in.
   * result: optional reconciliation result to add as output sheets.
   */
  function buildSheets(project, result, opts) {
    const template = !!(opts && opts.template);
    const o = project.options || {};
    const useSizes = !!o.sizes, useSA = !!o.sizeAssays && useSizes, useAssays = !!o.assays;
    const bins = project.bins || [], comps = project.comps || [];
    const unit = project.flowUnit || '';
    const nodeName = new Map(project.nodes.map((n) => [n.id, n.name]));
    const v = (x) => (template || !isNum(x) ? null : x);
    const sheets = [];

    sheets.push({
      name: 'Read me', widths: [110], rows: [
        ['Mass Balance Reconciler workbook'],
        [template ? 'Template: paste your sample data into the sheets, save, then import the file in the app.' : 'Export of the node network, sample data and (if calculated) reconciled results.'],
        [null],
        ['Every data sheet has one row per stream. Rows are matched to streams by name, columns by their heading, so do not rename them.'],
        ['Leave a cell blank if that value was not measured. Enter at least one solids flow.'],
        ['Size distribution: mass % retained in each size fraction (not cumulative).'],
        ['Errors are relative standard deviations in % of the measured value and apply to every measurement of that kind on the stream.'],
        ['Units: "' + KEEP + '" balances every size fraction (classifier, splitter, flotation). "' + BREAK + '" balances totals only (mill, crusher).'],
        ['Streams: a blank "From unit" is a feed from outside the circuit; a blank "To unit" is a product leaving it.'],
        ['When importing you can choose to read sample data only, or to also replace the network with the Units, Components and Streams sheets.'],
        ['Sheets whose names start with "Out" or "Results" are outputs and are ignored on import.'],
      ],
    });

    sheets.push({ name: 'Units', head: 1, widths: [28, 18], rows: [['Unit', 'Size behaviour'], ...project.nodes.map((n) => [n.name, n.conserveSize === false ? BREAK : KEEP])] });
    if (useAssays || useSA) {
      sheets.push({ name: 'Components', head: 1, widths: [16, 10, 26], rows: [['Component', 'Unit', 'Smallest absolute error'], ...comps.map((c) => [c.name, c.unit, isNum(c.minAbs) ? c.minAbs : null])] });
    }
    const errCols = ERR_COLS.filter((c) => c.when(o));
    sheets.push({
      name: 'Streams', head: 1, widths: [24, 22, 22, 16, 14, 14, 14, 26],
      rows: [['Stream', 'From unit', 'To unit', 'Solids flow' + (unit ? ', ' + unit : ''), ...errCols.map((c) => c.label)],
        ...project.streams.map((st) => [st.name, nodeName.get(st.from) || null, nodeName.get(st.to) || null, v(st.flow), ...errCols.map((c) => (isNum(st[c.key]) ? st[c.key] : null))])],
    });
    const wide = (cols) => [24, ...cols.map(() => 14)];
    if (useSizes) {
      sheets.push({ name: 'Size distribution', head: 1, widths: wide(bins), rows: [['Stream', ...bins.map((b) => b.label)], ...project.streams.map((st) => [st.name, ...bins.map((_, i) => v(st.psd && st.psd[i]))])] });
    }
    if (useAssays) {
      sheets.push({ name: 'Head assays', head: 1, widths: wide(comps), rows: [['Stream', ...comps.map((c) => c.name)], ...project.streams.map((st) => [st.name, ...comps.map((_, k) => v(st.assay && st.assay[k]))])] });
    }
    if (useSA) comps.forEach((c, k) => {
      sheets.push({ name: bySizeName(c.name), head: 1, widths: wide(bins), rows: [['Stream', ...bins.map((b) => b.label)], ...project.streams.map((st) => [st.name, ...bins.map((_, i) => v(st.sizeAssay && st.sizeAssay[i] && st.sizeAssay[i][k]))])] });
    });

    if (result && result.ok && !template) addResultSheets(sheets, project, result);
    return sheets;
  }

  function addResultSheets(sheets, project, R) {
    const bins = project.bins || [], comps = project.comps || [];
    const unit = project.flowUnit || '';
    const names = project.streams.map((s) => s.name);
    const val = (c) => (c ? (c.observable ? c.value : 'n.d.') : null);
    const sd = (c) => (c && c.observable && isNum(c.sd) ? c.sd : null);
    const meas = (c) => (c && isNum(c.measured) ? c.measured : null);
    const ratio = R.dof > 0 ? R.chi2 / R.dof : null;

    sheets.push({ name: 'Out Fit summary', head: 1, widths: [40, 16], rows: [
      ['Quantity', 'Value'],
      ['Weighted sum of squares', R.chi2], ['Redundancy (degrees of freedom)', R.dof], ['Sum of squares / redundancy', ratio],
      ['Measurements', R.nMeas], ['Independent unknowns', R.nUnknowns], ['Balance equations', R.nBalances],
      ...R.warnings.map((w) => ['Note', w]),
    ] });

    // long table: one row per reported value
    const long = [['Stream', 'Quantity', 'Size fraction', 'Component', 'Measured', 'Measurement SD', 'Reconciled', 'Reconciled SD', 'Adjustment (SDs)']];
    const push = (s, qty, bin, comp, c) => { if (c) long.push([names[s], qty, bin, comp, meas(c), isNum(c.sigma) ? c.sigma : null, val(c), sd(c), isNum(c.z) ? c.z : null]); };
    R.streams.forEach((rs, s) => {
      push(s, 'Solids flow' + (unit ? ' (' + unit + ')' : ''), null, null, rs.flow);
      rs.psd.forEach((c, i) => push(s, 'Size distribution (mass %)', bins[i].label, null, c));
      rs.assay.forEach((c, k) => push(s, 'Head assay', null, comps[k].name + ' (' + comps[k].unit + ')', c));
      rs.sizeAssay.forEach((row, i) => row.forEach((c, k) => push(s, 'Size-fraction assay', bins[i].label, comps[k].name + ' (' + comps[k].unit + ')', c)));
    });
    sheets.push({ name: 'Results', head: 1, widths: [24, 28, 16, 14, 12, 16, 12, 14, 16], rows: long });

    // wide tables: three rows per stream
    const block = (name, cols, cellAt) => {
      const rows = [['Stream', 'Value', ...cols]];
      names.forEach((nm, s) => {
        rows.push([nm, 'Measured', ...cols.map((_, c) => meas(cellAt(s, c)))]);
        rows.push([nm, 'Reconciled', ...cols.map((_, c) => val(cellAt(s, c)))]);
        rows.push([nm, 'Standard deviation', ...cols.map((_, c) => sd(cellAt(s, c)))]);
      });
      sheets.push({ name: sheetName(name), head: 1, widths: [24, 20, ...cols.map(() => 14)], rows });
    };
    block('Out Flow', ['Solids flow' + (unit ? ', ' + unit : '')], (s) => R.streams[s].flow);
    if (R.useSizes) block('Out Size distribution', bins.map((b) => b.label), (s, c) => R.streams[s].psd[c]);
    if (R.nk) block('Out Head assays', comps.map((c) => c.name + ', ' + c.unit), (s, c) => R.streams[s].assay[c]);
    if (R.useSizeAssays) comps.forEach((comp, k) => block('Out ' + sheetName(comp.name).slice(0, 19) + ' by size', bins.map((b) => b.label), (s, c) => (R.streams[s].sizeAssay[c] || [])[k]));
  }

  // ---------- sheets -> project ----------

  function cellNumber(v) {
    if (v == null || v === '') return { ok: true, value: null };
    if (typeof v === 'number') return isFinite(v) ? { ok: true, value: v } : { ok: false, value: null };
    const t = String(v).trim().replace(',', '.').replace(/%$/, '');
    if (t === '' || t === '-' || /^n\.?[ad]\.?$/i.test(t)) return { ok: true, value: null };
    const n = Number(t);
    return isFinite(n) ? { ok: true, value: n } : { ok: false, value: null };
  }
  const cellText = (v) => (v == null ? '' : String(v).trim());

  /** Trim trailing empty cells/rows and return { header, body }. */
  function table(sheet) {
    const rows = (sheet.rows || []).map((r) => (r || []).slice()).filter((r) => r.some((c) => cellText(c) !== ''));
    return { header: (rows[0] || []).map(cellText), body: rows.slice(1) };
  }

  /**
   * Apply a workbook to a project.
   * opts.network: also replace units, streams, size fractions and components
   * with the ones defined in the workbook.
   * Returns { ok, project, messages, summary } — `project` is a new object.
   */
  function applySheets(sheets, current, opts) {
    const network = !!(opts && opts.network);
    const p = JSON.parse(JSON.stringify(current));
    const messages = [];
    const find = (name) => sheets.find((s) => norm(s.name) === norm(name));
    const isOutput = (s) => /^(out |results$|read me$)/.test(norm(s.name));
    const bySize = sheets.filter((s) => !isOutput(s) && / by size$/.test(norm(s.name)));
    const fail = (msg) => ({ ok: false, project: null, messages: [msg], summary: '' });

    const shStreams = find('Streams'), shUnits = find('Units'), shComps = find('Components');
    const shPsd = find('Size distribution'), shAssay = find('Head assays');
    if (!shStreams && !shPsd && !shAssay && !bySize.length) {
      return fail('No sheets named Streams, Size distribution, Head assays or "<component> by size" were found. Start from the template the app creates.');
    }

    if (network) {
      if (!shUnits || !shStreams) return fail('To import the node network the workbook needs both a Units sheet and a Streams sheet.');
      const tu = table(shUnits);
      const oldNodes = new Map(p.nodes.map((n) => [norm(n.name), n]));
      let anyNew = false;
      const nodes = [];
      tu.body.forEach((r, i) => {
        const name = cellText(r[0]);
        if (!name) return;
        if (nodes.some((n) => norm(n.name) === norm(name))) { messages.push(`Units sheet: "${name}" is listed twice; the second row was ignored.`); return; }
        const old = oldNodes.get(norm(name));
        if (!old) anyNew = true;
        nodes.push({ id: old ? old.id : 'xn' + (i + 1), name, conserveSize: !/^(change|break|no\b|false|0$)/.test(norm(r[1])), x: old ? old.x : null, y: old ? old.y : null });
      });
      if (!nodes.length) return fail('The Units sheet has no units.');
      const used = new Set();
      nodes.forEach((n) => { while (used.has(n.id)) n.id += 'x'; used.add(n.id); });
      const nodeId = new Map(nodes.map((n) => [norm(n.name), n.id]));

      // size fractions and components come from the workbook
      if (shPsd) p.bins = table(shPsd).header.slice(1).filter((l) => l && norm(l) !== 'sum').map((label) => ({ label }));
      else if (bySize.length) p.bins = table(bySize[0]).header.slice(1).filter(Boolean).map((label) => ({ label }));
      const oldComps = new Map((p.comps || []).map((c) => [norm(c.name), c]));
      let comps = null;
      if (shComps) {
        comps = table(shComps).body.filter((r) => cellText(r[0])).map((r) => ({ name: cellText(r[0]), unit: cellText(r[1]) || '%', minAbs: cellNumber(r[2]).value }));
      } else if (shAssay || bySize.length) {
        const namesFound = shAssay ? table(shAssay).header.slice(1).filter(Boolean) : bySize.map((s) => s.name.trim().replace(/ by size$/i, ''));
        comps = namesFound.map((name) => { const old = oldComps.get(norm(name)); return { name, unit: old ? old.unit : '%', minAbs: old ? old.minAbs : null }; });
      }
      if (comps) p.comps = comps;
      p.options = { sizes: !!shPsd || bySize.length > 0, assays: !!shAssay, sizeAssays: bySize.length > 0 };

      const ts = table(shStreams);
      const col = (prefix) => ts.header.findIndex((hd) => norm(hd).startsWith(prefix));
      const cFrom = col('from'), cTo = col('to');
      if (cFrom < 0 || cTo < 0) return fail('The Streams sheet needs "From unit" and "To unit" columns to import the node network.');
      const oldStreams = new Map(p.streams.map((s) => [norm(s.name), s]));
      const streams = [];
      ts.body.forEach((r, i) => {
        const name = cellText(r[0]);
        if (!name) return;
        if (streams.some((s) => norm(s.name) === norm(name))) { messages.push(`Streams sheet: "${name}" is listed twice; the second row was ignored.`); return; }
        const end = (c, what) => {
          const t = cellText(r[c]);
          if (!t) return null;
          if (!nodeId.has(norm(t))) { messages.push(`Stream "${name}": ${what} unit "${t}" is not on the Units sheet, so that end was left open.`); return null; }
          return nodeId.get(norm(t));
        };
        const old = oldStreams.get(norm(name));
        const st = Object.assign({}, old || {}, { id: old ? old.id : 'xs' + (i + 1), name, from: end(cFrom, 'from'), to: end(cTo, 'to') });
        if (!old || anyNew || old.from !== st.from || old.to !== st.to) { st.fx = st.fy = st.tx = st.ty = null; }
        if (!old) { st.flow = null; st.psd = []; st.assay = []; st.sizeAssay = []; }
        streams.push(st);
      });
      if (!streams.length) return fail('The Streams sheet has no streams.');
      const usedS = new Set();
      streams.forEach((s) => { while (usedS.has(s.id)) s.id += 'x'; usedS.add(s.id); });
      if (anyNew) layout(nodes, streams);
      // existing measurements are indexed by the old fractions/components: re-map by label
      remapData(streams, current, p);
      p.nodes = nodes;
      p.streams = streams;
    }

    // ----- sample data -----
    const nb = p.bins.length, nk = p.comps.length;
    p.streams.forEach((st) => {
      st.psd = Array.from({ length: nb }, (_, i) => (st.psd && isNum(st.psd[i]) ? st.psd[i] : null));
      st.assay = Array.from({ length: nk }, (_, k) => (st.assay && isNum(st.assay[k]) ? st.assay[k] : null));
      st.sizeAssay = Array.from({ length: nb }, (_, i) => Array.from({ length: nk }, (__, k) => (st.sizeAssay && st.sizeAssay[i] && isNum(st.sizeAssay[i][k]) ? st.sizeAssay[i][k] : null)));
    });
    const streamByName = new Map(p.streams.map((s) => [norm(s.name), s]));
    let nValues = 0;
    const seenStreams = new Set(), unknownStreams = new Set();
    const bad = [];

    /** Read one sheet: `targets` maps a column label to a setter. */
    const readSheet = (sheet, labels, setter, allowPositional) => {
      const t = table(sheet);
      const heads = t.header.slice(1);
      let map = heads.map((hd) => labels.findIndex((l) => norm(l) === norm(hd)));
      const used = heads.filter((hd) => hd && norm(hd) !== 'sum');
      if (allowPositional && map.every((m) => m < 0) && used.length === labels.length) {
        map = heads.map((_, i) => (i < labels.length ? i : -1));
        messages.push(`Sheet "${sheet.name}": column headings do not match the app, so columns were read in order.`);
      } else {
        const skipped = heads.filter((hd, i) => hd && norm(hd) !== 'sum' && map[i] < 0);
        if (skipped.length) messages.push(`Sheet "${sheet.name}": column(s) ${skipped.map((x) => `"${x}"`).join(', ')} do not match anything in the app and were skipped.`);
      }
      t.body.forEach((r) => {
        const name = cellText(r[0]);
        if (!name) return;
        const st = streamByName.get(norm(name));
        if (!st) { unknownStreams.add(name); return; }
        seenStreams.add(st);
        map.forEach((target, i) => {
          if (target < 0) return;
          const c = cellNumber(r[i + 1]);
          if (!c.ok) bad.push(`${sheet.name} / ${name} / ${heads[i]}: "${cellText(r[i + 1])}"`);
          if (c.value != null) nValues++;
          setter(st, target, c.value);
        });
      });
    };

    if (shStreams) {
      const t = table(shStreams);
      const keys = t.header.map((hd) => {
        const n = norm(hd);
        if (n.startsWith('solids flow') || n === 'flow') return 'flow';
        const e = ERR_COLS.slice().reverse().find((c) => n.startsWith(c.match));
        return e ? e.key : null;
      });
      t.body.forEach((r) => {
        const name = cellText(r[0]);
        if (!name) return;
        const st = streamByName.get(norm(name));
        if (!st) { unknownStreams.add(name); return; }
        seenStreams.add(st);
        keys.forEach((key, i) => {
          if (!key) return;
          const c = cellNumber(r[i]);
          if (!c.ok) bad.push(`Streams / ${name} / ${t.header[i]}: "${cellText(r[i])}"`);
          if (key === 'flow') { st.flow = c.value; if (c.value != null) nValues++; } else if (c.value != null) st[key] = c.value; // a blank error keeps the current estimate
        });
      });
    }
    const binLabels = p.bins.map((b) => b.label), compNames = p.comps.map((c) => c.name);
    if (shPsd) readSheet(shPsd, binLabels, (st, i, v) => { st.psd[i] = v; }, !network);
    if (shAssay) {
      // accept "Cu" as well as "Cu, %" / "Cu (%)"
      const t = table(shAssay);
      shAssay.rows = [t.header.map((hd, i) => { if (!i) return hd; const m = compNames.find((c) => norm(hd) === norm(c) || norm(hd).startsWith(norm(c) + ',') || norm(hd).startsWith(norm(c) + ' (')); return m || hd; }), ...t.body];
      readSheet(shAssay, compNames, (st, k, v) => { st.assay[k] = v; }, !network);
    }
    bySize.forEach((sheet) => {
      const k = p.comps.findIndex((c) => norm(bySizeName(c.name)) === norm(sheet.name));
      if (k < 0) { messages.push(`Sheet "${sheet.name}" does not match any component in the app and was skipped.`); return; }
      readSheet(sheet, binLabels, (st, i, v) => { st.sizeAssay[i][k] = v; }, !network);
    });

    if (unknownStreams.size) messages.push(`Stream name(s) not found in the app and skipped: ${[...unknownStreams].map((x) => `"${x}"`).join(', ')}.`);
    const missing = p.streams.filter((s) => !seenStreams.has(s)).map((s) => `"${s.name}"`);
    if (missing.length) messages.push(`No rows in the workbook for stream(s) ${missing.join(', ')}; their data was left as it was.`);
    if (bad.length) messages.push(`${bad.length} cell(s) are not numbers and were read as blank: ${bad.slice(0, 5).join('; ')}${bad.length > 5 ? '; …' : ''}`);
    if (!seenStreams.size) return fail('None of the stream names in the workbook match the streams in the app. Tick "also import the node network", or use the template the app creates for this network.');

    if (!network && !nValues) return fail('The workbook has no measured values yet (it looks like an empty template), so the data in the app was left as it was.');

    const summary = `${network ? `Imported ${p.nodes.length} units and ${p.streams.length} streams, with ` : 'Imported '}${nValues} measured value${nValues === 1 ? '' : 's'} for ${seenStreams.size} stream${seenStreams.size === 1 ? '' : 's'}.`;
    return { ok: true, project: p, messages, summary };
  }

  /** Re-index kept streams' data when size fractions or components changed. */
  function remapData(streams, before, after) {
    const binMap = after.bins.map((b) => (before.bins || []).findIndex((o) => norm(o.label) === norm(b.label)));
    const compMap = after.comps.map((c) => (before.comps || []).findIndex((o) => norm(o.name) === norm(c.name)));
    streams.forEach((st) => {
      const psd = st.psd || [], assay = st.assay || [], sa = st.sizeAssay || [];
      st.psd = binMap.map((i) => (i >= 0 && isNum(psd[i]) ? psd[i] : null));
      st.assay = compMap.map((k) => (k >= 0 && isNum(assay[k]) ? assay[k] : null));
      st.sizeAssay = binMap.map((i) => compMap.map((k) => (i >= 0 && k >= 0 && sa[i] && isNum(sa[i][k]) ? sa[i][k] : null)));
    });
  }

  /** Simple left-to-right layout: column = distance from the feeds. */
  function layout(nodes, streams) {
    const depth = new Map();
    let frontier = nodes.filter((n) => streams.some((s) => s.to === n.id && !s.from)).map((n) => n.id);
    if (!frontier.length && nodes.length) frontier = [nodes[0].id];
    let d = 0;
    while (frontier.length) {
      frontier.forEach((id) => depth.set(id, d));
      const next = new Set();
      streams.forEach((s) => { if (frontier.includes(s.from) && s.to && !depth.has(s.to)) next.add(s.to); });
      frontier = [...next];
      d++;
    }
    nodes.forEach((n) => { if (!depth.has(n.id)) depth.set(n.id, d); });
    const maxD = Math.max(...depth.values(), 0);
    const W = 1000, H = 420;
    for (let c = 0; c <= maxD; c++) {
      const col = nodes.filter((n) => depth.get(n.id) === c);
      col.forEach((n, i) => {
        n.x = Math.round(maxD ? 200 + (c * (W - 400)) / maxD : W / 2);
        n.y = Math.round((H * (i + 1)) / (col.length + 1));
      });
    }
  }

  // ---------- .xlsx via ExcelJS ----------

  async function writeWorkbook(ExcelJS, sheets) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Mass Balance Reconciler';
    sheets.forEach((sh) => {
      const ws = wb.addWorksheet(sh.name);
      sh.rows.forEach((r) => ws.addRow(r.map((c) => (c === undefined ? null : c))));
      (sh.widths || []).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      if (sh.head) {
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
      } else ws.getRow(1).font = { bold: true, size: 14 };
    });
    return wb.xlsx.writeBuffer();
  }

  function plainCell(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return null;
    if (typeof v === 'object') {
      if ('result' in v) return plainCell(v.result); // formula
      if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
      if ('text' in v) return plainCell(v.text); // hyperlink
      if ('formula' in v || 'sharedFormula' in v) return null; // formula without a cached value
    }
    return null;
  }

  async function readWorkbook(ExcelJS, data) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(data);
    const sheets = [];
    wb.eachSheet((ws) => {
      const rows = [];
      ws.eachRow({ includeEmpty: true }, (row) => {
        const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
        rows.push(Array.from(vals, plainCell));
      });
      sheets.push({ name: ws.name, rows });
    });
    return sheets;
  }

  return { buildSheets, applySheets, writeWorkbook, readWorkbook, bySizeName };
});
