// SkyShift - shared helpers.  All DOM is built with textContent / properties,
// never innerHTML with external data, so remote text can't inject markup.
import { galToEq, eqToGal } from './sky.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}

export function toast(msg, kind = '', ms = 4200, action) {
  const box = $('#toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, h('span', { text: msg }));
  if (action) t.append(h('button', { class: 'btn', type: 'button', text: action.label, onclick: () => { action.fn(); t.remove(); } }));
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

export const mjdToDate = m => new Date((m - 40587) * 86400000);
export function fmtDate(m, withTime = false) {
  const d = mjdToDate(m);
  const s = d.toISOString();
  return withTime ? `${s.slice(0, 10)} ${s.slice(11, 16)} UTC` : s.slice(0, 10);
}
export function fmtShortDate(m) {
  return mjdToDate(m).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
export const fmtInt = n => Number(n).toLocaleString();
export function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(0) + ' kB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

export function sexa(v, hours) {
  const sign = v < 0 ? '-' : (hours ? '' : '+');
  let x = Math.abs(hours ? v / 15 : v);
  const d = Math.floor(x); x = (x - d) * 60;
  const m = Math.floor(x); const s = (x - m) * 60;
  const ss = hours ? s.toFixed(1).padStart(4, '0') : s.toFixed(0).padStart(2, '0');
  return `${sign}${String(d).padStart(2, '0')}${hours ? 'h' : '°'}${String(m).padStart(2, '0')}${hours ? 'm' : '′'}${ss}${hours ? 's' : '″'}`;
}
export function fmtCoord(ra, dec) {
  return `RA ${sexa(ra, true)}  Dec ${sexa(dec, false)}  (${ra.toFixed(4)}°, ${dec >= 0 ? '+' : ''}${dec.toFixed(4)}°)`;
}
export function galStr(ra, dec) {
  const [l, b] = eqToGal(ra, dec);
  return `l ${l.toFixed(2)}°, b ${b >= 0 ? '+' : ''}${b.toFixed(2)}°`;
}

// Parse "83.82 -5.39", "05:35:17.3 -05:23:28", "5h35m17s -5d23m28s",
// "l=0 b=0" / "G0.0+0.0" (galactic).  Returns {ra,dec} or null.
export function parseCoords(q) {
  const s = q.trim();
  let m = s.match(/^(?:l\s*=?\s*)?(-?\d+(?:\.\d+)?)\s*[, ]\s*(?:b\s*=?\s*)?([+-]?\d+(?:\.\d+)?)\s*(gal|galactic)?$/i);
  if (m && /^l|gal/i.test(s)) {
    const [ra, dec] = galToEq(+m[1], +m[2]);
    return { ra, dec, galactic: true };
  }
  m = s.match(/^G(\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)$/i);
  if (m) { const [ra, dec] = galToEq(+m[1], +m[2]); return { ra, dec, galactic: true }; }
  m = s.match(/^([+-]?\d+(?:\.\d+)?)\s*[, ]\s*([+-]?\d+(?:\.\d+)?)$/);
  if (m) {
    const ra = +m[1], dec = +m[2];
    if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
    return null;
  }
  m = s.match(/^(\d{1,2})[h: ]\s*(\d{1,2})[m: ]\s*(\d{1,2}(?:\.\d+)?)s?\s*[, ]?\s*([+-−]?)(\d{1,2})[d°: ]\s*(\d{1,2})['′m: ]\s*(\d{1,2}(?:\.\d+)?)["″s]?$/i);
  if (m) {
    const ra = 15 * (+m[1] + m[2] / 60 + m[3] / 3600);
    const dec = (m[4] === '-' || m[4] === '−' ? -1 : 1) * (+m[5] + m[6] / 60 + m[7] / 3600);
    if (ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
  }
  return null;
}

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'target';
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// wavelength (um) -> display colour (perceptual spectral ramp, blue->red)
export function waveColor(w) {
  const t = clamp((w - 0.75) / (5.0 - 0.75), 0, 1);
  const stops = [[90, 120, 255], [60, 200, 255], [80, 230, 150], [230, 230, 80], [255, 150, 60], [255, 70, 90]];
  const x = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
  const c = stops[k].map((v, i) => Math.round(v * (1 - f) + stops[k + 1][i] * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
