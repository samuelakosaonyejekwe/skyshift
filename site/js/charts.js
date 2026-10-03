// SkyShift - tiny dependency-free SVG charts (scatter / line / bars).
const NS = 'http://www.w3.org/2000/svg';
const el = (t, a = {}, parent) => {
  const e = document.createElementNS(NS, t);
  for (const k in a) e.setAttribute(k, a[k]);
  if (parent) parent.appendChild(e);
  return e;
};

function ticks(lo, hi, n = 5) {
  const span = hi - lo || 1;
  const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || mag * 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// series: [{name, color, points:[{x,y,err?,c?,label?,id?}], line?:bool}]
export function chart(host, { series, xlabel, ylabel, xfmt = v => v, yfmt = v => v, invertY = false, xTime = false, height = 260, markers = [], onPoint, bands = [] }) {
  host.textContent = '';
  const W = Math.max(280, host.clientWidth || 560), H = height;
  const m = { l: 58, r: 14, t: 12, b: 42 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': `${ylabel} versus ${xlabel}`, class: 'chart' }, host);
  const pts = series.flatMap(s => s.points);
  if (!pts.length) {
    const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, svg);
    t.textContent = 'No measurements yet';
    return svg;
  }
  let x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
  let y0 = Math.min(...pts.map(p => p.y - (p.err || 0))), y1 = Math.max(...pts.map(p => p.y + (p.err || 0)));
  for (const mk of markers) { if (mk.x < x0 && mk.x > x0 - (x1 - x0) * 0.05) x0 = mk.x; }
  const px = (x1 - x0) * 0.04 || 1, py = (y1 - y0) * 0.08 || Math.abs(y0) * 0.1 || 1;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const sx = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r);
  const sy = v => invertY ? m.t + (v - y0) / (y1 - y0) * (H - m.t - m.b) : H - m.b - (v - y0) / (y1 - y0) * (H - m.t - m.b);
  const g = el('g', { class: 'axes' }, svg);
  for (const b of bands) {
    if (b.x1 < x0 || b.x0 > x1) continue;
    const r = el('rect', { x: sx(Math.max(x0, b.x0)), y: m.t, width: Math.max(1, sx(Math.min(x1, b.x1)) - sx(Math.max(x0, b.x0))), height: H - m.t - m.b, fill: b.color, opacity: 0.08 }, g);
    void r;
  }
  for (const v of ticks(y0, y1)) {
    el('line', { x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v), class: 'grid' }, g);
    const t = el('text', { x: m.l - 6, y: sy(v) + 4, 'text-anchor': 'end' }, g); t.textContent = yfmt(v);
  }
  const xt = xTime ? timeTicks(x0, x1) : ticks(x0, x1, Math.max(3, Math.floor(W / 110)));
  for (const v of xt) {
    el('line', { x1: sx(v), x2: sx(v), y1: m.t, y2: H - m.b, class: 'grid' }, g);
    const t = el('text', { x: sx(v), y: H - m.b + 16, 'text-anchor': 'middle' }, g); t.textContent = xfmt(v);
  }
  const xl = el('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'label' }, g); xl.textContent = xlabel;
  const yl = el('text', { x: 14, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', class: 'label', transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})` }, g); yl.textContent = ylabel;
  for (const mk of markers) {
    if (mk.x < x0 || mk.x > x1) continue;
    el('line', { x1: sx(mk.x), x2: sx(mk.x), y1: m.t, y2: H - m.b, class: 'marker' }, svg);
    const t = el('text', { x: sx(mk.x) + 3, y: m.t + 10, class: 'marker-label' }, svg); t.textContent = mk.label;
  }
  const tip = el('text', { x: m.l + 6, y: m.t + 12, class: 'tip' }, svg);
  for (const s of series) {
    if (s.line && s.points.length > 1) {
      const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
      el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 1.5, opacity: 0.8 }, svg);
    }
    for (const p of s.points) {
      if (p.err) el('line', { x1: sx(p.x), x2: sx(p.x), y1: sy(p.y - p.err), y2: sy(p.y + p.err), stroke: p.c || s.color, opacity: 0.5 }, svg);
      const c = el('circle', { cx: sx(p.x), cy: sy(p.y), r: p.r || 3.6, fill: p.c || s.color, stroke: 'rgba(0,0,0,.5)', 'stroke-width': 0.6, tabindex: 0, class: 'pt' }, svg);
      const lab = p.label || `${xfmt(p.x)}, ${yfmt(p.y)}`;
      const ttl = el('title', {}, c); ttl.textContent = lab;
      const show = () => { tip.textContent = lab; };
      c.addEventListener('pointerenter', show); c.addEventListener('focus', show);
      if (onPoint) c.addEventListener('click', () => onPoint(p));
    }
  }
  return svg;
}

function timeTicks(x0, x1) {
  // x in MJD -> month boundaries
  const out = [];
  const d0 = mjdToDate(x0), d1 = mjdToDate(x1);
  const months = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d1.getUTCMonth() - d0.getUTCMonth();
  const step = months > 24 ? 6 : months > 10 ? 3 : months > 4 ? 1 : 0;
  if (!step) return ticks(x0, x1, 4);
  const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1));
  while (d <= d1) {
    if (d.getUTCMonth() % step === 0) out.push(dateToMjd(d));
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
export const mjdToDate = m => new Date((m - 40587) * 86400000);
export const dateToMjd = d => d.getTime() / 86400000 + 40587;

export function bars(host, { data, xfmt, yfmt = v => v, color = 'var(--accent)', height = 160, label }) {
  host.textContent = '';
  const W = Math.max(280, host.clientWidth || 560), H = height, m = { l: 46, r: 8, t: 8, b: 26 };
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': label || 'bar chart', class: 'chart' }, host);
  if (!data.length) return svg;
  const ymax = Math.max(...data.map(d => d[1])) || 1;
  const bw = (W - m.l - m.r) / data.length;
  const g = el('g', { class: 'axes' }, svg);
  for (const v of ticks(0, ymax, 3)) {
    const y = H - m.b - v / ymax * (H - m.t - m.b);
    el('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid' }, g);
    const t = el('text', { x: m.l - 5, y: y + 4, 'text-anchor': 'end' }, g); t.textContent = yfmt(v);
  }
  const tip = el('text', { x: m.l + 4, y: m.t + 10, class: 'tip' }, svg);
  data.forEach((d, i) => {
    const h = d[1] / ymax * (H - m.t - m.b);
    const r = el('rect', { x: m.l + i * bw, y: H - m.b - h, width: Math.max(0.6, bw - (bw > 4 ? 1 : 0)), height: h, fill: d[2] || color, class: 'bar' }, svg);
    const t = el('title', {}, r); t.textContent = `${xfmt(d[0])}: ${yfmt(d[1])}`;
    r.addEventListener('pointerenter', () => { tip.textContent = `${xfmt(d[0])}: ${yfmt(d[1])}`; });
  });
  const n = Math.max(2, Math.floor(W / 120));
  for (let k = 0; k < n; k++) {
    const i = Math.round(k / (n - 1) * (data.length - 1));
    const t = el('text', { x: m.l + (i + 0.5) * bw, y: H - 8, 'text-anchor': 'middle' }, g); t.textContent = xfmt(data[i][0]);
  }
  return svg;
}
