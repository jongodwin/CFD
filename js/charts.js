/*
 * Small dependency-free SVG line chart for axial kiln profiles.
 * Colours come from CSS custom properties, so charts follow the page theme.
 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  function svg(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceStep(range, count) {
    const raw = range / Math.max(count, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }
  function niceTicks(min, max, count) {
    if (!(max > min)) { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
    const step = niceStep(max - min, count);
    const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return { min: lo, max: hi, step, ticks };
  }
  function tickLabel(v, step) {
    const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    const s = Math.abs(v) >= 10000 && dec === 0 ? (v / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'k'
      : v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return s.replace('-', '−');
  }
  function interp(xs, ys, x) {
    const n = xs.length;
    if (!n) return NaN;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
    return ys[lo] + t * (ys[hi] - ys[lo]);
  }

  let uid = 0;
  class LineChart {
    constructor(container, opts) {
      this.opts = Object.assign({ height: 240, unit: '', digits: 1, xLabel: 'Distance from feed end, m' }, opts);
      this.id = 'lc' + (++uid);
      this.hidden = new Set();
      const fig = h('figure', 'chart', container);
      this.fig = fig;
      const cap = h('figcaption', 'chart-head', fig);
      this.titleEl = h('h3', 'chart-title', cap, this.opts.title);
      this.subEl = h('p', 'chart-sub', cap, this.opts.subtitle || '');
      this.legend = h('div', 'legend', fig);
      this.legend.setAttribute('role', 'group');
      this.legend.setAttribute('aria-label', this.opts.title + ' series');
      this.plot = h('div', 'plot', fig);
      this.plot.tabIndex = 0;
      this.plot.setAttribute('role', 'img');
      this.svg = svg('svg', { class: 'plot-svg', 'aria-hidden': 'true' }, this.plot);
      this.tip = h('div', 'tip', this.plot);
      this.tip.hidden = true;
      this.cursorX = null;
      this.plot.addEventListener('pointermove', e => this._hover(e));
      this.plot.addEventListener('pointerdown', e => this._hover(e));
      this.plot.addEventListener('pointerleave', () => this._clearHover());
      this.plot.addEventListener('blur', () => this._clearHover());
      this.plot.addEventListener('keydown', e => this._key(e));
      if (typeof ResizeObserver !== 'undefined') {
        let raf = 0, lastW = 0;
        this.ro = new ResizeObserver(() => {
          const w = this.plot.clientWidth;
          if (w === lastW) return;
          lastW = w;
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => this.render());
        });
        this.ro.observe(this.plot);
      }
    }
    setData(data) {
      this.data = data;
      if (data.subtitle !== undefined) this.subEl.textContent = data.subtitle;
      // drop hidden flags for series that no longer exist
      const ids = new Set(data.series.map(s => s.id));
      for (const id of Array.from(this.hidden)) if (!ids.has(id)) this.hidden.delete(id);
      this._legend();
      this.render();
    }
    _legend() {
      this.legend.textContent = '';
      const multi = this.data.series.length > 1;
      this.legend.hidden = !multi;
      if (!multi) return;
      this.data.series.forEach(s => {
        const b = h('button', 'legend-item', this.legend);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(!this.hidden.has(s.id)));
        const sw = h('span', 'swatch' + (s.dash ? ' dashed' : ''), b);
        sw.style.setProperty('--c', s.color);
        h('span', '', b, s.name);
        b.addEventListener('click', () => {
          if (this.hidden.has(s.id)) this.hidden.delete(s.id);
          else if (this.data.series.length - this.hidden.size > 1) this.hidden.add(s.id);
          b.setAttribute('aria-pressed', String(!this.hidden.has(s.id)));
          this.render();
        });
      });
    }
    render() {
      if (!this.data) return;
      const W = Math.max(this.plot.clientWidth, 260), H = this.opts.height;
      const narrow = W < 420;
      const M = { l: narrow ? 44 : 52, r: 12, t: 18, b: 40 };
      this.dim = { W, H, M };
      const s = this.svg;
      s.setAttribute('viewBox', `0 0 ${W} ${H}`);
      s.setAttribute('width', W);
      s.setAttribute('height', H);
      s.textContent = '';
      const vis = this.data.series.filter(x => !this.hidden.has(x.id));
      let ymin = Infinity, ymax = -Infinity;
      vis.forEach(x => x.y.forEach(v => { if (Number.isFinite(v)) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; } }));
      if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
      if (this.data.includeZero) { ymin = Math.min(ymin, 0); ymax = Math.max(ymax, 0); }
      if (this.data.yMin !== undefined) ymin = Math.min(ymin, this.data.yMin);
      if (this.data.yMax !== undefined) ymax = Math.max(ymax, this.data.yMax);
      const pad = (ymax - ymin) * 0.04;
      // never pad a non-negative series below zero
      const lower = ymin >= 0 && ymin - pad < 0 ? 0 : ymin - pad;
      const yt = niceTicks(lower, ymax + pad, H < 220 ? 4 : 5);
      const xmax = this.data.xMax;
      const xt = niceTicks(0, xmax, narrow ? 4 : 8);
      const px = x => M.l + (x / xmax) * (W - M.l - M.r);
      const py = y => M.t + (1 - (y - yt.min) / (yt.max - yt.min)) * (H - M.t - M.b);
      this.px = px; this.py = py; this.xmax = xmax;

      // bands (flame, chains)
      const placed = [];
      (this.data.bands || []).forEach(b => {
        const x0 = px(Math.max(0, b.x0)), x1 = px(Math.min(xmax, b.x1));
        if (x1 - x0 < 1) return;
        svg('rect', { x: x0, y: M.t, width: x1 - x0, height: H - M.t - M.b, class: 'band band-' + b.kind }, s);
        // drop the label one row when it would sit on top of an earlier band's label
        const row = placed.filter(p => p[0] < x1 && p[1] > x0).length;
        placed.push([x0, x1]);
        const t = svg('text', { x: (x0 + x1) / 2, y: M.t + 12 + 13 * row, class: 'band-label', 'text-anchor': 'middle' }, s);
        t.textContent = x1 - x0 > 60 ? b.label : '';
      });
      // grid + y ticks
      yt.ticks.forEach(v => {
        const y = py(v);
        svg('line', { x1: M.l, x2: W - M.r, y1: y, y2: y, class: v === 0 ? 'axis' : 'grid' }, s);
        const t = svg('text', { x: M.l - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, s);
        t.textContent = tickLabel(v, yt.step);
      });
      const yu = svg('text', { x: M.l - 6, y: 11, class: 'unit', 'text-anchor': 'end' }, s);
      yu.textContent = this.opts.unit;
      // x axis
      svg('line', { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, class: 'axis' }, s);
      xt.ticks.forEach(v => {
        if (v > xmax + 1e-9) return;
        const x = px(v);
        svg('line', { x1: x, x2: x, y1: H - M.b, y2: H - M.b + 4, class: 'axis' }, s);
        const t = svg('text', { x, y: H - M.b + 16, class: 'tick', 'text-anchor': 'middle' }, s);
        t.textContent = tickLabel(v, xt.step);
      });
      const lab = svg('text', { x: (M.l + W - M.r) / 2, y: H - 6, class: 'axis-label', 'text-anchor': 'middle' }, s);
      lab.textContent = narrow ? 'Distance from feed end, m' : this.opts.xLabel;
      if (!narrow) {
        const fe = svg('text', { x: M.l, y: H - 6, class: 'end-label', 'text-anchor': 'start' }, s);
        fe.textContent = 'Feed end';
        const de = svg('text', { x: W - M.r, y: H - 6, class: 'end-label', 'text-anchor': 'end' }, s);
        de.textContent = 'Discharge end';
      }
      // lines
      vis.forEach(x => {
        let d = '';
        for (let i = 0; i < x.x.length; i++) {
          if (!Number.isFinite(x.y[i])) continue;
          d += (d ? 'L' : 'M') + px(x.x[i]).toFixed(1) + ' ' + py(x.y[i]).toFixed(1);
        }
        const p = svg('path', { d, class: 'line' + (x.dash ? ' dashed' : '') + (x.emph ? ' emph' : '') }, s);
        p.style.stroke = x.color;
      });
      this.hoverG = svg('g', { class: 'hover' }, s);
      this.plot.setAttribute('aria-label', this._summary(vis));
      if (this.cursorX !== null) this._drawHover(this.cursorX);
    }
    _summary(vis) {
      const u = this.opts.unit;
      return this.opts.title + ': ' + vis.map(x => {
        const f = x.y.filter(Number.isFinite);
        return x.name + ' from ' + Math.min(...f).toFixed(this.opts.digits) + ' to ' + Math.max(...f).toFixed(this.opts.digits) + ' ' + u;
      }).join('; ');
    }
    _hover(e) {
      if (!this.dim) return;
      const r = this.plot.getBoundingClientRect();
      const x = (e.clientX - r.left - this.dim.M.l) / (this.dim.W - this.dim.M.l - this.dim.M.r) * this.xmax;
      if (x < 0 || x > this.xmax) { this._clearHover(); return; }
      this.cursorX = x;
      this._drawHover(x);
    }
    _key(e) {
      if (!this.data) return;
      const step = this.xmax / 60;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const x0 = this.cursorX === null ? 0 : this.cursorX;
        this.cursorX = Math.min(Math.max(x0 + (e.key === 'ArrowRight' ? step : -step), 0), this.xmax);
        this._drawHover(this.cursorX);
      } else if (e.key === 'Escape') this._clearHover();
    }
    _clearHover() {
      this.cursorX = null;
      if (this.hoverG) this.hoverG.textContent = '';
      this.tip.hidden = true;
    }
    _drawHover(x) {
      const g = this.hoverG, M = this.dim.M, H = this.dim.H, W = this.dim.W;
      g.textContent = '';
      const X = this.px(x);
      svg('line', { x1: X, x2: X, y1: M.t, y2: H - M.b, class: 'crosshair' }, g);
      const vis = this.data.series.filter(s => !this.hidden.has(s.id));
      const rows = [];
      vis.forEach(s => {
        const v = interp(s.x, s.y, x);
        if (!Number.isFinite(v)) return;
        const c = svg('circle', { cx: X, cy: this.py(v), r: 4, class: 'dot' }, g);
        c.style.fill = s.color;
        rows.push({ s, v });
      });
      const fmt = this.data.format || (v => v.toLocaleString('en-US', { maximumFractionDigits: this.opts.digits, minimumFractionDigits: this.opts.digits }));
      this.tip.textContent = '';
      h('div', 'tip-head', this.tip, 'z = ' + x.toFixed(1) + ' m');
      rows.sort((a, b) => b.v - a.v).forEach(({ s, v }) => {
        const row = h('div', 'tip-row', this.tip);
        const sw = h('span', 'swatch' + (s.dash ? ' dashed' : ''), row);
        sw.style.setProperty('--c', s.color);
        h('span', 'tip-name', row, s.name);
        h('span', 'tip-val', row, fmt(v).replace('-', '−') + (this.opts.unit ? ' ' + this.opts.unit : ''));
      });
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth;
      let left = X + 14;
      if (left + tw > W - 4) left = X - 14 - tw;
      this.tip.style.left = Math.max(4, left) + 'px';
      this.tip.style.top = M.t + 'px';
    }
  }

  root.KilnCharts = { LineChart, niceTicks };
}(typeof self !== 'undefined' ? self : this));
