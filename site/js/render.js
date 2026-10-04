// SkyShift - image scaling, colour maps and pixel analysis helpers.

// 256-entry colour maps generated from compact control points.
const STOPS = {
  inferno: ['000004', '1b0c41', '4a0c6b', '781c6d', 'a52c60', 'cf4446', 'ed6925', 'fb9b06', 'f7d13d', 'fcffa4'],
  viridis: ['440154', '482878', '3e4989', '31688e', '26828e', '1f9e89', '35b779', '6ece58', 'b5de2b', 'fde725'],
  ice: ['000000', '07122b', '0d2a57', '13478a', '1f6bb5', '3b93d1', '6cb7e0', 'a3d6ec', 'd6eef7', 'ffffff'],
  gray: ['000000', 'ffffff'],
  cividis: ['00224e', '123570', '3b496c', '575d6d', '707173', '8a8779', 'a69d75', 'c4b56c', 'e4cf5b', 'fee838'],
  spectral: ['000000', '2b0f54', '1d3fbf', '0d8dbf', '17b37a', '9ad13b', 'f2d23a', 'f28a2e', 'e2412d', 'ffffff'],
};
const LUTS = {};
export function lut(name) {
  if (LUTS[name]) return LUTS[name];
  const s = (STOPS[name] || STOPS.inferno).map(h => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (s.length - 1), k = Math.min(s.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(s[k][c] * (1 - f) + s[k + 1][c] * f);
  }
  return (LUTS[name] = out);
}
export const COLORMAPS = Object.keys(STOPS);

export function percentiles(data, ps) {
  const v = [];
  const step = Math.max(1, Math.floor(data.length / 20000));
  for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i])) v.push(data[i]);
  if (!v.length) return ps.map(() => 0);
  v.sort((a, b) => a - b);
  return ps.map(p => v[Math.min(v.length - 1, Math.max(0, Math.round(p / 100 * (v.length - 1))))]);
}

export function robustStats(data) {
  const [p16, p50, p84] = percentiles(data, [15.87, 50, 84.13]);
  return { med: p50, sig: Math.max(1e-9, (p84 - p16) / 2) };
}

// stretch: linear | asinh | log | sqrt | hist
export function scaleTo8(data, { lo, hi, stretch = 'asinh', soft = 8 }) {
  const n = data.length, out = new Uint8ClampedArray(n);
  const span = hi - lo || 1;
  const fn = {
    linear: t => t,
    sqrt: t => Math.sqrt(t),
    log: t => Math.log10(1 + 1000 * t) / 3,
    asinh: t => Math.asinh(soft * t) / Math.asinh(soft),
  }[stretch] || (t => t);
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) { out[i] = 0; continue; }
    const t = Math.min(1, Math.max(0, (v - lo) / span));
    out[i] = Math.round(fn(t) * 255);
  }
  return out;
}

export function levels(data, mode = 'auto', clip = [1, 99.7]) {
  if (mode === 'diff') {
    const { sig } = robustStats(data);
    return { lo: -5 * sig, hi: 5 * sig };
  }
  if (mode === 'sky') {
    // astronomical display: black just below the sky level, so noise reads as
    // a smooth dark background instead of blotches
    const { med, sig } = robustStats(data);
    const [hi] = percentiles(data, [clip[1]]);
    return { lo: med - 1.5 * sig, hi: Math.max(hi, med + 8 * sig) };
  }
  const [lo, hi] = percentiles(data, clip);
  return { lo, hi: hi > lo ? hi : lo + 1 };
}

export function paint(ctx, size, bytes, cmap, nanRGB = [12, 14, 24]) {
  const L = lut(cmap);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < bytes.length; i++) {
    const k = bytes[i] * 3;
    d[i * 4] = L[k]; d[i * 4 + 1] = L[k + 1]; d[i * 4 + 2] = L[k + 2]; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  void nanRGB;
}

export function paintRGB(ctx, size, r, g, b) {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = r[i]; d[i * 4 + 1] = g[i]; d[i * 4 + 2] = b[i]; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function paintDiverging(ctx, size, data, lim) {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    let r = 10, g = 12, b = 20;
    if (Number.isFinite(v)) {
      // dead zone below ~1/3 of the limit (noise) so only real changes glow
      const t = Math.max(-1, Math.min(1, v / lim));
      const a = Math.max(0, (Math.abs(t) - 0.3) / 0.7) ** 0.8;
      if (t > 0) { r = 20 + 235 * a; g = 20 + 120 * a; b = 20 + 30 * a; } else { r = 20 + 40 * a; g = 20 + 160 * a; b = 20 + 235 * a; }
    }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

// Background-subtract a frame with a coarse median mesh (removes zodiacal
// light gradients so frames from different dates/wavelengths compare well).
export function subtractBackground(data, size, cell = 16) {
  const n = Math.ceil(size / cell);
  const grid = new Float32Array(n * n);
  const tmp = [];
  for (let gy = 0; gy < n; gy++) for (let gx = 0; gx < n; gx++) {
    tmp.length = 0;
    for (let y = gy * cell; y < Math.min(size, (gy + 1) * cell); y++)
      for (let x = gx * cell; x < Math.min(size, (gx + 1) * cell); x++) {
        const v = data[y * size + x];
        if (Number.isFinite(v)) tmp.push(v);
      }
    tmp.sort((a, b) => a - b);
    // 40th percentile resists stars better than the median
    grid[gy * n + gx] = tmp.length ? tmp[Math.floor(tmp.length * 0.4)] : NaN;
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = Math.min(n - 1, Math.max(0, (x + 0.5) / cell - 0.5)), fy = Math.min(n - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(n - 1, x0 + 1), y1 = Math.min(n - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    const g = (i, j) => { const v = grid[j * n + i]; return Number.isFinite(v) ? v : 0; };
    const bg = g(x0, y0) * (1 - ax) * (1 - ay) + g(x1, y0) * ax * (1 - ay) + g(x0, y1) * (1 - ax) * ay + g(x1, y1) * ax * ay;
    out[y * size + x] = data[y * size + x] - bg;
  }
  return out;
}

export function medianStack(arrays, size) {
  const n = size * size, out = new Float32Array(n);
  const v = new Float32Array(arrays.length);
  for (let i = 0; i < n; i++) {
    let k = 0;
    for (const a of arrays) { const x = a[i]; if (Number.isFinite(x)) v[k++] = x; }
    if (!k) { out[i] = NaN; continue; }
    const s = v.subarray(0, k).sort();
    out[i] = k % 2 ? s[k >> 1] : 0.5 * (s[(k >> 1) - 1] + s[k >> 1]);
  }
  return out;
}

// Fill NaN holes with the mean of valid neighbours (display only).
export function fillHoles(data, size, passes = 3) {
  let a = Float32Array.from(data);
  for (let p = 0; p < passes; p++) {
    const b = Float32Array.from(a);
    let left = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (Number.isFinite(a[i])) continue;
      let s = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        const v = a[yy * size + xx];
        if (Number.isFinite(v)) { s += v; k++; }
      }
      if (k) b[i] = s / k; else left++;
    }
    a = b;
    if (!left) break;
  }
  return a;
}

// Aperture photometry on a background-subtracted cutout.
// Returns flux density in micro-Jansky (surface brightness MJy/sr * pixel solid angle).
export function aperture(data, size, cx, cy, scaleArcsec, r = 2.2, rin = 5, rout = 8) {
  let sum = 0, n = 0, nbad = 0;
  const ann = [];
  for (let y = Math.floor(cy - rout - 1); y <= Math.ceil(cy + rout + 1); y++) {
    for (let x = Math.floor(cx - rout - 1); x <= Math.ceil(cx + rout + 1); x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.hypot(x - cx, y - cy), v = data[y * size + x];
      if (d <= r) { if (Number.isFinite(v)) { sum += v; n++; } else nbad++; }
      else if (d >= rin && d <= rout && Number.isFinite(v)) ann.push(v);
    }
  }
  if (!n || ann.length < 8) return null;
  ann.sort((a, b) => a - b);
  const bg = ann[Math.floor(ann.length / 2)];
  const q1 = ann[Math.floor(ann.length * 0.16)], q3 = ann[Math.floor(ann.length * 0.84)];
  const sig = (q3 - q1) / 2;
  const npix = n + nbad;
  const net = (sum / n) * npix - bg * npix;
  const omega = (scaleArcsec / 206264.806) ** 2;     // sr per pixel
  const uJy = net * omega * 1e12;                     // MJy -> uJy
  const err = sig * Math.sqrt(npix) * omega * 1e12 * Math.sqrt(1 + npix / ann.length);
  const ab = uJy > 0 ? 23.9 - 2.5 * Math.log10(uJy) : null;
  return { uJy, err, ab, bg, nbad };
}

// Positive residual peaks above `nsig`.
export function findPeaks(data, size, nsig = 5, maxN = 40, edge = 4) {
  const { med, sig } = robustStats(data);
  const thr = med + nsig * sig;
  const peaks = [];
  for (let y = edge; y < size - edge; y++) for (let x = edge; x < size - edge; x++) {
    const v = data[y * size + x];
    if (!(v > thr)) continue;
    let ok = true;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((dx || dy) && !(data[(y + dy) * size + x + dx] <= v)) { ok = false; break; }
    }
    if (!ok) continue;
    // require some spatial extent (rejects single hot pixels / cosmic rays)
    let nb = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && data[(y + dy) * size + x + dx] > med + 1.5 * sig) nb++;
    if (nb < 3) continue;
    // centroid
    let sx = 0, sy = 0, s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const w = Math.max(0, data[(y + dy) * size + x + dx] - med);
      sx += (x + dx) * w; sy += (y + dy) * w; s += w;
    }
    peaks.push({ x: sx / s, y: sy / s, snr: (v - med) / sig });
  }
  peaks.sort((a, b) => b.snr - a.snr);
  return peaks.slice(0, maxN);
}

// High-quality upscale for display (Catmull-Rom bicubic).  Makes point sources
// look round instead of square without inventing detail.  NaN-safe.
export function upsample(data, n, f = 4) {
  const m = n * f, out = new Float32Array(m * m);
  const at = (x, y) => {
    x = x < 0 ? 0 : x >= n ? n - 1 : x; y = y < 0 ? 0 : y >= n ? n - 1 : y;
    const v = data[y * n + x];
    return Number.isFinite(v) ? v : NaN;
  };
  const w = t => {
    const a = Math.abs(t);
    return a < 1 ? 1.5 * a * a * a - 2.5 * a * a + 1 : a < 2 ? -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2 : 0;
  };
  const wx = new Float32Array(f * 4), ox = new Int32Array(f);
  for (let k = 0; k < f; k++) {
    const sx = (k + 0.5) / f - 0.5, ix = Math.floor(sx), fx = sx - ix;
    ox[k] = ix;
    for (let t = 0; t < 4; t++) wx[k * 4 + t] = w(fx - (t - 1));
  }
  for (let Y = 0; Y < m; Y++) {
    const ky = Y % f, iy = Math.floor(Y / f) + ox[ky];
    for (let X = 0; X < m; X++) {
      const kx = X % f, ix = Math.floor(X / f) + ox[kx];
      let s = 0, ws = 0;
      for (let j = 0; j < 4; j++) {
        const wyv = wx[ky * 4 + j];
        for (let i = 0; i < 4; i++) {
          const v = at(ix + i - 1, iy + j - 1);
          if (Number.isFinite(v)) { const ww = wyv * wx[kx * 4 + i]; s += v * ww; ws += ww; }
        }
      }
      if (!(ws > 0.2)) { out[Y * m + X] = NaN; continue; }
      // clamp to the 2x2 nearest source pixels: no ringing/halos around bright stars
      const bx = Math.floor((X + 0.5) / f - 0.5), by = Math.floor((Y + 0.5) / f - 0.5);
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const v = at(bx + i, by + j); if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      const v = s / ws;
      out[Y * m + X] = lo <= hi ? Math.min(hi, Math.max(lo, v)) : v;
    }
  }
  return out;
}
