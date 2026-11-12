/* Canvas rendering: tank cross-section field maps and line charts. */
(function (G) {
  'use strict';
  const CSTR = (G.CSTR = G.CSTR || {});
  const RAMP_LIGHT = ['#f4f8fd', '#cde2fb', '#86b6ef', '#3987e5', '#1c5cab', '#0d366b'];
  const RAMP_DARK = ['#151d27', '#0d366b', '#1c5cab', '#3987e5', '#86b6ef', '#dcebfc'];

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isDark = () => css('--is-dark') === '1';
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  function rampFn() {
    const stops = (isDark() ? RAMP_DARK : RAMP_LIGHT).map(hex), n = stops.length - 1;
    return (t) => {
      t = Math.min(1, Math.max(0, t)) * n;
      const i = Math.min(n - 1, Math.floor(t)), f = t - i, a = stops[i], b = stops[i + 1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    };
  }
  function fmt(x, sig) {
    if (x == null || !isFinite(x)) return '–';
    sig = sig || 3;
    const a = Math.abs(x);
    if (a === 0) return '0';
    if (a >= 1e5 || a < 1e-3) { const [m, e] = x.toExponential(sig - 1).split('e'); return m + '×10' + String(+e).replace('-', '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[d]); }
    if (a >= 1000) return Math.round(x).toLocaleString('en-US');
    return String(+x.toPrecision(sig));
  }
  CSTR.fmt = fmt;

  function setup(canvas, cssH) {
    const dpr = Math.min(G.devicePixelRatio || 1, 2), cssW = Math.max(120, canvas.clientWidth || canvas.parentElement.clientWidth || 300);
    canvas.style.height = cssH(cssW) + 'px';
    const h = cssH(cssW);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, h);
    return { ctx, W: cssW, H: h };
  }

  /**
   * Draw a mirrored tank cross-section.
   * spec: { field, min, max, overlay: 'stream' | 'vectors' | null, res (simulation result or preview) }
   */
  CSTR.drawTank = function (canvas, res, spec) {
    const g = res.g, Nr = g.Nr, Nz = g.Nz;
    const pad = { l: 10, r: 10, t: 18, b: 40 };
    let scale = 1;
    const { ctx, W, H } = setup(canvas, (w) => {
      scale = Math.min((w - pad.l - pad.r) / (2 * g.R), 560 / g.H);
      return Math.round(g.H * scale + pad.t + pad.b);
    });
    const cx = W / 2, X = (r) => cx + r * scale, Y = (z) => pad.t + (g.H - z) * scale;
    const ink = css('--ink'), ink2 = css('--ink-2'), ink3 = css('--ink-3'), plotBg = css('--plot-bg');
    const ramp = rampFn();
    ctx.fillStyle = plotBg;
    ctx.fillRect(X(-g.R), Y(g.H), 2 * g.R * scale, g.H * scale);

    if (spec.field) {
      const off = document.createElement('canvas');
      off.width = Nr; off.height = Nz;
      const octx = off.getContext('2d'), img = octx.createImageData(Nr, Nz), span = spec.max - spec.min || 1;
      for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) {
        const c = ramp((spec.field[j * Nr + i] - spec.min) / span), q = ((Nz - 1 - j) * Nr + i) * 4;
        img.data[q] = c[0]; img.data[q + 1] = c[1]; img.data[q + 2] = c[2]; img.data[q + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.beginPath(); ctx.rect(X(-g.R), Y(g.H), 2 * g.R * scale, g.H * scale); ctx.clip();
      const dw = g.R * scale, dh = g.H * scale;
      ctx.drawImage(off, 0, 0, Nr, Nz, cx, Y(g.H), dw, dh);
      ctx.translate(cx, 0); ctx.scale(-1, 1);
      ctx.drawImage(off, 0, 0, Nr, Nz, 0, Y(g.H), dw, dh);
      ctx.restore();
    }

    const hy = res.hydro;
    if (spec.overlay === 'stream' && hy) drawStreamlines(ctx, res, X, Y, scale, cx, ink);
    if (spec.overlay === 'vectors' && hy) drawVectors(ctx, res, X, Y, scale, cx, ink);

    // ---- hardware
    ctx.lineWidth = 1;
    if (g.nBaf > 0) {
      for (const sgn of [-1, 1]) {
        const x0 = cx + sgn * (g.R - g.bafGap - g.bafW) * scale, x1 = cx + sgn * (g.R - g.bafGap) * scale;
        ctx.fillStyle = ink; ctx.globalAlpha = 0.1;
        ctx.fillRect(Math.min(x0, x1), Y(g.H), Math.abs(x1 - x0), g.H * scale);
        ctx.globalAlpha = 0.45; ctx.strokeStyle = ink; ctx.setLineDash([3, 3]);
        ctx.strokeRect(Math.min(x0, x1) + 0.5, Y(g.H) + 0.5, Math.abs(x1 - x0) - 1, g.H * scale - 1);
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }
    }
    // shaft and impeller
    ctx.strokeStyle = ink; ctx.fillStyle = ink;
    const shaft = Math.max(2, 0.02 * g.T * scale);
    ctx.globalAlpha = 0.85;
    ctx.fillRect(cx - shaft / 2, pad.t - 10, shaft, Y(g.C) - pad.t + 10);
    const zLo = g.C - g.Wproj / 2, zHi = g.C + g.Wproj / 2, rHub = g.imp.hub * g.D;
    for (const sgn of [-1, 1]) {
      const xa = cx + sgn * rHub * scale, xb = cx + sgn * (g.D / 2) * scale;
      ctx.beginPath();
      if (g.beta > 1.5) ctx.rect(Math.min(xa, xb), Y(zHi), Math.abs(xb - xa), Math.max(2, (zHi - zLo) * scale));
      else { ctx.moveTo(xa, Y(zHi)); ctx.lineTo(xb, Y(zHi)); ctx.lineTo(xb, Y(zLo)); ctx.lineTo(xa, Y(zLo)); ctx.closePath(); }
      ctx.globalAlpha = 0.28; ctx.fill(); ctx.globalAlpha = 0.9; ctx.lineWidth = 1.25; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, Y(g.C)); ctx.lineTo(xa, Y(g.C)); ctx.lineWidth = Math.max(2, shaft * 0.8); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // tank walls, liquid surface
    ctx.strokeStyle = ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(-g.R), pad.t - 10); ctx.lineTo(X(-g.R), Y(0)); ctx.lineTo(X(g.R), Y(0)); ctx.lineTo(X(g.R), pad.t - 10); ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = ink2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(X(-g.R), Y(g.H)); ctx.lineTo(X(g.R), Y(g.H)); ctx.stroke(); ctx.setLineDash([]);
    // inlet / outlet markers
    const bc = res.flow && res.flow.bc;
    if (bc && g.Q > 0) {
      ctx.fillStyle = ink; ctx.strokeStyle = ink; ctx.font = '600 10px ' + css('--font-ui'); ctx.textBaseline = 'middle';
      const arrow = (x, y, dx, dy, label, align) => {
        ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - dx * 12, y - dy * 12); ctx.lineTo(x, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dx * 6 - dy * 4, y - dy * 6 - dx * 4); ctx.lineTo(x - dx * 6 + dy * 4, y - dy * 6 + dx * 4); ctx.closePath(); ctx.fill();
        ctx.textAlign = align; ctx.fillText(label, x - dx * 12 + (align === 'left' ? 5 : align === 'right' ? -5 : 0), y - dy * 12 + (dy ? (dx ? 0 : -0) : -9));
      };
      const rin = (0.5 * (bc.inI0 + bc.inI1)) * g.dr;
      arrow(X(rin), Y(g.H) + 2, 0, 1, 'IN', 'left');
      if (bc.type === 'bottom') arrow(cx, Y(0) + 14, 0, 1, 'OUT', 'left');
      else arrow(X(g.R) + 13, Y(0.5 * (bc.outJ0 + bc.outJ1) * g.dz), 1, 0, '', 'left');
      if (bc.type !== 'bottom') { ctx.textAlign = 'right'; ctx.fillText('OUT', X(g.R) - 4, Y(0.5 * (bc.outJ0 + bc.outJ1) * g.dz)); }
    }
    // colour bar
    if (spec.field) {
      const bw = Math.min(170, W * 0.4), bx = cx - bw / 2, by = Y(0) + 20, grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      for (let q = 0; q <= 10; q++) { const c = ramp(q / 10); grad.addColorStop(q / 10, `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`); }
      ctx.fillStyle = grad; ctx.fillRect(bx, by, bw, 8);
      ctx.strokeStyle = ink3; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 7);
      ctx.fillStyle = ink2; ctx.font = '11px ' + css('--font-num'); ctx.textBaseline = 'middle';
      ctx.textAlign = 'right'; ctx.fillText(fmt(spec.min), bx - 6, by + 4);
      ctx.textAlign = 'left'; ctx.fillText(fmt(spec.max) + (spec.unit ? ' ' + spec.unit : ''), bx + bw + 6, by + 4);
    }
    canvas._geo = { cx, scale, padT: pad.t, g };
  };

  function drawStreamlines(ctx, res, X, Y, scale, cx, ink) {
    const g = res.g, hy = res.hydro, Nr = g.Nr, Nz = g.Nz, NU = Nr + 1, psi = hy.psi;
    const big = Math.max(hy.psiMax, -hy.psiMin);
    if (!(big > 0)) return;
    const levels = [];
    const nL = 9;
    for (let k = 1; k <= nL; k++) {
      const fr = (k - 0.5) / nL;
      if (hy.psiMax > 0.03 * big) levels.push(fr * hy.psiMax);
      if (hy.psiMin < -0.03 * big) levels.push(fr * hy.psiMin);
    }
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1;
    for (const sgn of [1, -1]) {
      for (const lv of levels) {
        let acc = 30;
        ctx.globalAlpha = 0.62;
        ctx.beginPath();
        const arrows = [];
        for (let j = 0; j < Nz; j++) for (let i = 0; i < Nr; i++) {
          const a = psi[j * NU + i] - lv, b = psi[j * NU + i + 1] - lv, c = psi[(j + 1) * NU + i + 1] - lv, d = psi[(j + 1) * NU + i] - lv;
          const pts = [];
          if (a * b < 0) pts.push([i + a / (a - b), j]);
          if (b * c < 0) pts.push([i + 1, j + b / (b - c)]);
          if (c * d < 0) pts.push([i + d / (d - c), j + 1]);
          if (d * a < 0) pts.push([i, j + a / (a - d)]);
          for (let q = 0; q + 1 < pts.length; q += 2) {
            const x0 = cx + sgn * pts[q][0] * g.dr * scale, y0 = Y(pts[q][1] * g.dz), x1 = cx + sgn * pts[q + 1][0] * g.dr * scale, y1 = Y(pts[q + 1][1] * g.dz);
            ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
            acc += Math.hypot(x1 - x0, y1 - y0);
            if (acc > 85) { acc = 0; arrows.push([0.5 * (x0 + x1), 0.5 * (y0 + y1), i, j]); }
          }
        }
        ctx.stroke();
        ctx.globalAlpha = 0.85;
        for (const [x, y, i, j] of arrows) {
          const c = j * Nr + i, uu = sgn * hy.uc[c], ww = -hy.wc[c], m = Math.hypot(uu, ww);
          if (m < 0.02 * hy.speedMax) continue;
          const dx = uu / m, dy = ww / m;
          ctx.beginPath(); ctx.moveTo(x + dx * 4, y + dy * 4); ctx.lineTo(x - dx * 3 - dy * 3, y - dy * 3 + dx * 3); ctx.lineTo(x - dx * 3 + dy * 3, y - dy * 3 - dx * 3); ctx.closePath(); ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawVectors(ctx, res, X, Y, scale, cx, ink) {
    const g = res.g, hy = res.hydro, Nr = g.Nr, Nz = g.Nz;
    const stepPx = Math.max(13, (g.R * scale) / 14), si = Math.max(1, Math.round(stepPx / (g.dr * scale))), sj = Math.max(1, Math.round(stepPx / (g.dz * scale)));
    const L = Math.min(si * g.dr, sj * g.dz) * scale * 1.15;
    ctx.strokeStyle = ink; ctx.fillStyle = ink; ctx.lineWidth = 1.1;
    for (const sgn of [1, -1]) for (let j = (sj >> 1); j < Nz; j += sj) for (let i = (si >> 1); i < Nr; i += si) {
      const c = j * Nr + i, m = hy.speed[c];
      if (m < 0.01 * hy.speedMax) continue;
      const len = L * Math.sqrt(m / hy.speedMax), dx = (sgn * hy.uc[c]) / m, dy = -hy.wc[c] / m;
      const x = cx + sgn * (i + 0.5) * g.dr * scale, y = Y((j + 0.5) * g.dz);
      const x0 = x - (dx * len) / 2, y0 = y - (dy * len) / 2, x1 = x + (dx * len) / 2, y1 = y + (dy * len) / 2, hd = Math.min(4, len * 0.45);
      ctx.globalAlpha = 0.35 + 0.65 * Math.sqrt(m / hy.speedMax);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - dx * hd - dy * hd * 0.6, y1 - dy * hd + dx * hd * 0.6); ctx.lineTo(x1 - dx * hd + dy * hd * 0.6, y1 - dy * hd - dx * hd * 0.6); ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Map a pointer position on a tank canvas to (r, z, cell index) or null. */
  CSTR.tankProbe = function (canvas, ev) {
    const geo = canvas._geo;
    if (!geo) return null;
    const rect = canvas.getBoundingClientRect(), g = geo.g;
    const r = Math.abs(ev.clientX - rect.left - geo.cx) / geo.scale, z = g.H - (ev.clientY - rect.top - geo.padT) / geo.scale;
    if (r >= g.R || z < 0 || z >= g.H) return null;
    const i = Math.min(g.Nr - 1, Math.floor(r / g.dr)), j = Math.min(g.Nz - 1, Math.floor(z / g.dz));
    return { r, z, c: j * g.Nr + i };
  };

  function niceTicks(lo, hi, n) {
    const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), nrm = raw / mag;
    const step = (nrm < 1.5 ? 1 : nrm < 3.5 ? 2 : nrm < 7.5 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 * span; v += step) out.push(Math.abs(v) < 1e-12 ? 0 : v);
    return out;
  }

  /**
   * Line chart. opt: { series: [{ x, y, color, dash, width, label }], xLabel, yLabel, xLog, xMin, xMax, yMin, yMax, height, probe: 'x' | 'y' }
   * Stores a hit-test helper on canvas._chart for hover.
   */
  CSTR.drawChart = function (canvas, opt, hover) {
    const pad = { l: 46, r: 14, t: 10, b: 38 };
    const { ctx, W, H } = setup(canvas, () => opt.height || 240);
    const ink2 = css('--ink-2'), ink3 = css('--ink-3'), line = css('--line');
    const tx = (v) => (opt.xLog ? Math.log10(v) : v);
    const x0 = tx(opt.xMin), x1 = tx(opt.xMax), y0 = opt.yMin, y1 = opt.yMax;
    const PX = (v) => pad.l + ((tx(v) - x0) / (x1 - x0)) * (W - pad.l - pad.r), PY = (v) => H - pad.b - ((v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
    ctx.font = '11px ' + css('--font-num'); ctx.lineWidth = 1;
    // grid + ticks
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(y0, y1, 5)) {
      ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(pad.l, Math.round(PY(v)) + 0.5); ctx.lineTo(W - pad.r, Math.round(PY(v)) + 0.5); ctx.stroke();
      ctx.fillStyle = ink3; ctx.fillText(fmt(v), pad.l - 6, PY(v));
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    let xt;
    if (opt.xLog) { xt = []; for (let e = Math.ceil(x0 - 1e-9); e <= x1 + 1e-9; e++) xt.push(Math.pow(10, e)); if (xt.length > 7) xt = xt.filter((_, q) => q % 2 === 0); }
    else xt = niceTicks(opt.xMin, opt.xMax, W < 420 ? 4 : 6);
    for (const v of xt) {
      ctx.strokeStyle = ink3; ctx.beginPath(); ctx.moveTo(Math.round(PX(v)) + 0.5, H - pad.b); ctx.lineTo(Math.round(PX(v)) + 0.5, H - pad.b + 4); ctx.stroke();
      ctx.fillStyle = ink3; ctx.fillText(opt.xFmt ? opt.xFmt(v) : fmt(v), PX(v), H - pad.b + 7);
    }
    ctx.strokeStyle = ink3; ctx.beginPath(); ctx.moveTo(pad.l, H - pad.b + 0.5); ctx.lineTo(W - pad.r, H - pad.b + 0.5); ctx.stroke();
    ctx.fillStyle = ink2; ctx.font = '11px ' + css('--font-ui');
    ctx.fillText(opt.xLabel || '', pad.l + (W - pad.l - pad.r) / 2, H - 15);
    ctx.save(); ctx.translate(11, pad.t + (H - pad.t - pad.b) / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText(opt.yLabel || '', 0, 0); ctx.restore();
    // series
    ctx.save(); ctx.beginPath(); ctx.rect(pad.l, pad.t - 2, W - pad.l - pad.r, H - pad.t - pad.b + 3); ctx.clip();
    for (const s of opt.series) {
      ctx.strokeStyle = css(s.color); ctx.lineWidth = s.width || 2; ctx.setLineDash(s.dash || []); ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (let q = 0; q < s.x.length; q++) {
        if (opt.xLog && !(s.x[q] > 0)) continue;
        const px = PX(s.x[q]), py = PY(s.y[q]);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (hover) {
      ctx.strokeStyle = ink3; ctx.lineWidth = 1;
      ctx.beginPath();
      if (opt.probe === 'y') { ctx.moveTo(pad.l, hover.py + 0.5); ctx.lineTo(W - pad.r, hover.py + 0.5); } else { ctx.moveTo(hover.px + 0.5, pad.t); ctx.lineTo(hover.px + 0.5, H - pad.b); }
      ctx.stroke();
      for (const p of hover.pts) { ctx.fillStyle = css(p.color); ctx.strokeStyle = css('--surface'); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(PX(p.x), PY(p.y), 4.5, 0, 7); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
    // interpolate every series at a pointer position
    canvas._chart = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect(), mx = clientX - rect.left, my = clientY - rect.top;
      if (mx < pad.l || mx > W - pad.r || my < pad.t || my > H - pad.b) return null;
      const fx = x0 + ((mx - pad.l) / (W - pad.l - pad.r)) * (x1 - x0), xv = opt.xLog ? Math.pow(10, fx) : fx;
      const yv = y0 + ((H - pad.b - my) / (H - pad.t - pad.b)) * (y1 - y0);
      const pts = [];
      for (const s of opt.series) {
        const key = opt.probe === 'y' ? s.y : s.x, val = opt.probe === 'y' ? s.x : s.y, target = opt.probe === 'y' ? yv : xv;
        for (let q = 1; q < key.length; q++) if ((key[q - 1] <= target && key[q] >= target) || (key[q - 1] >= target && key[q] <= target)) {
          const f = (target - key[q - 1]) / (key[q] - key[q - 1] || 1), o = val[q - 1] + f * (val[q] - val[q - 1]);
          pts.push(opt.probe === 'y' ? { x: o, y: target, color: s.color, label: s.label } : { x: target, y: o, color: s.color, label: s.label });
          break;
        }
      }
      return pts.length ? { px: mx, py: my, xv, yv, pts } : null;
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
