// SkyShift - streaming FITS reader for SPHEREx spectral images.
// Reads only the bytes needed (HTTP range requests) straight from NASA's
// public SPHEREx archive on AWS (nasa-irsa-spherex), so a 70 MB frame costs
// well under 1 MB for a cutout.  Works in a Worker or on the main thread.

export const S3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
export const NPIX = 2040;
const BLOCK = 2880;

// Level-2 pixel flags (SPHEREx Explanatory Supplement, Table 16).
// Masked: TRANSIENT, OVERFLOW, SUR_ERROR, NONFUNC, DICHROIC, MISSING_DATA,
// HOT, COLD, PHANMISS, NONLINEAR, PERSIST, OUTLIER, GHOST, GHOST_FPA.
// Kept: FULLSAMPLE(12), CROSSTALK(20, mild), SOURCE(21, marks real sources).
export const BAD_FLAGS = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 6) | (1 << 7) | (1 << 9) |
  (1 << 10) | (1 << 11) | (1 << 14) | (1 << 15) | (1 << 17) | (1 << 19) | (1 << 22) | (1 << 23);

export const BANDS = [
  null,
  { lo: 0.75, hi: 1.09, R: 39 }, { lo: 1.10, hi: 1.62, R: 41 }, { lo: 1.63, hi: 2.41, R: 41 },
  { lo: 2.42, hi: 3.82, R: 35 }, { lo: 3.83, hi: 4.41, R: 112 }, { lo: 4.42, hi: 5.00, R: 128 },
];

export function frameKey(f) {
  return `${f.qr}/level2/${f.week}/${f.ver}/${f.det}/level2_${f.week}_${String(f.ls).padStart(4, '0')}_${f.ss}D${f.det}_spx_${f.ver}.fits`;
}
export const obsId = f => `${f.week}_${String(f.ls).padStart(4, '0')}_${f.ss}`;

async function range(url, start, end, signal) {
  const hdr = end == null ? `bytes=${start}` : `bytes=${start}-${end}`;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { Range: hdr }, signal, cache: 'force-cache', mode: 'cors' });
      if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
      const buf = await r.arrayBuffer();
      if (r.status === 200 && start >= 0) return buf.slice(start, end == null ? undefined : end + 1);
      return buf;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      last = e;
      await new Promise(res => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw last;
}

// ---------------------------------------------------------------- headers
export function parseHeader(bytes, from = 0) {
  const cards = {};
  const u8 = new Uint8Array(bytes);
  let i = from;
  for (; i + 80 <= u8.length; i += 80) {
    const c = String.fromCharCode.apply(null, u8.subarray(i, i + 80));
    const key = c.slice(0, 8).trim();
    if (key === 'END') {
      const len = Math.ceil((i + 80 - from) / BLOCK) * BLOCK;
      return { cards, length: len };
    }
    if (c.slice(8, 10) !== '= ') continue;
    let v = c.slice(10);
    if (v.trimStart().startsWith("'")) {
      const m = v.match(/'((?:[^']|'')*)'/);
      cards[key] = m ? m[1].replace(/''/g, "'").trim() : '';
    } else {
      v = v.split('/')[0].trim();
      if (v === 'T') cards[key] = true;
      else if (v === 'F') cards[key] = false;
      else { const n = Number(v.replace(/D/i, 'E')); cards[key] = Number.isFinite(n) ? n : v; }
    }
  }
  return null; // END not found yet
}

function dataSize(c) {
  if (!c.NAXIS) return 0;
  let n = 1;
  for (let a = 1; a <= c.NAXIS; a++) n *= c['NAXIS' + a];
  return (Math.abs(c.BITPIX) / 8) * (n + (c.PCOUNT || 0)) * (c.GCOUNT || 1);
}
const pad = n => Math.ceil(n / BLOCK) * BLOCK;

// Reads primary + IMAGE header.  Returns {cards, dataStart}.
export async function readImageHeader(url, signal) {
  let size = 12 * BLOCK; // 34.5 kB covers current SPHEREx headers (grows if needed)
  for (;;) {
    const buf = await range(url, 0, size - 1, signal);
    const prim = parseHeader(buf, 0);
    if (!prim) { size *= 2; continue; }
    const off = prim.length + pad(dataSize(prim.cards));
    const img = parseHeader(buf, off);
    if (!img) { if (size > 2e6) throw new Error('header too large'); size *= 2; continue; }
    return { cards: img.cards, dataStart: off + img.length };
  }
}

// ---------------------------------------------------------------- WCS
// TAN-SIP world <-> pixel (0-based pixels).
export class WCS {
  constructor(c) {
    const d1 = c.CDELT1 || 1, d2 = c.CDELT2 || 1;
    if (c.CD1_1 !== undefined) {
      this.cd = [c.CD1_1, c.CD1_2 || 0, c.CD2_1 || 0, c.CD2_2];
    } else {
      this.cd = [(c.PC1_1 ?? 1) * d1, (c.PC1_2 || 0) * d1, (c.PC2_1 || 0) * d2, (c.PC2_2 ?? 1) * d2];
    }
    const [a, b, cc, d] = this.cd;
    const det = a * d - b * cc;
    this.icd = [d / det, -b / det, -cc / det, a / det];
    this.crpix = [c.CRPIX1 - 1, c.CRPIX2 - 1];
    this.ra0 = c.CRVAL1 * Math.PI / 180;
    this.dec0 = c.CRVAL2 * Math.PI / 180;
    this.sd0 = Math.sin(this.dec0); this.cd0 = Math.cos(this.dec0);
    const sip = (p, ord) => {
      if (!ord) return null;
      const t = [];
      for (let i = 0; i <= ord; i++) for (let j = 0; j <= ord - i; j++) {
        const v = c[`${p}_${i}_${j}`];
        if (v) t.push([i, j, v]);
      }
      return t;
    };
    this.A = sip('A', c.A_ORDER); this.B = sip('B', c.B_ORDER);
    this.AP = sip('AP', c.AP_ORDER); this.BP = sip('BP', c.BP_ORDER);
  }
  static poly(t, u, v) {
    let s = 0;
    if (t) for (const [i, j, c] of t) s += c * u ** i * v ** j;
    return s;
  }
  // pixel -> sky (degrees)
  pix2sky(x, y) {
    const u = x - this.crpix[0], v = y - this.crpix[1];
    const U = u + WCS.poly(this.A, u, v), V = v + WCS.poly(this.B, u, v);
    const xi = (this.cd[0] * U + this.cd[1] * V) * Math.PI / 180;
    const eta = (this.cd[2] * U + this.cd[3] * V) * Math.PI / 180;
    return tanToSky(xi, eta, this.ra0, this.sd0, this.cd0);
  }
  // sky (degrees) -> pixel; returns null if behind the tangent plane
  sky2pix(ra, dec) {
    const p = skyToTan(ra, dec, this.ra0, this.sd0, this.cd0);
    if (!p) return null;
    const X = p[0] * 180 / Math.PI, Y = p[1] * 180 / Math.PI;
    const U = this.icd[0] * X + this.icd[1] * Y, V = this.icd[2] * X + this.icd[3] * Y;
    let u, v;
    if (this.AP) {
      u = U + WCS.poly(this.AP, U, V); v = V + WCS.poly(this.BP, U, V);
    } else if (this.A) {
      u = U; v = V; // fixed-point inversion
      for (let k = 0; k < 6; k++) {
        u = U - WCS.poly(this.A, u, v); v = V - WCS.poly(this.B, u, v);
      }
    } else { u = U; v = V; }
    return [u + this.crpix[0], v + this.crpix[1]];
  }
}

export function skyToTan(ra, dec, ra0, sd0, cd0) {
  const r = ra * Math.PI / 180, d = dec * Math.PI / 180;
  const sd = Math.sin(d), cdd = Math.cos(d), dr = r - ra0;
  const cosc = sd0 * sd + cd0 * cdd * Math.cos(dr);
  if (cosc <= 0) return null;
  return [cdd * Math.sin(dr) / cosc, (cd0 * sd - sd0 * cdd * Math.cos(dr)) / cosc];
}
export function tanToSky(xi, eta, ra0, sd0, cd0) {
  const rho = Math.hypot(xi, eta);
  const c = Math.atan(rho);
  const sc = Math.sin(c), cc = Math.cos(c);
  const dec = rho === 0 ? Math.asin(sd0) : Math.asin(cc * sd0 + eta * sc * cd0 / rho);
  const ra = ra0 + Math.atan2(xi * sc, rho * cd0 * cc - eta * sd0 * sc);
  return [((ra * 180 / Math.PI) % 360 + 360) % 360, dec * 180 / Math.PI];
}

// ---------------------------------------------------------------- RICE_1
const NZ = new Uint8Array(256);
for (let b = 1; b < 256; b++) NZ[b] = 32 - Math.clz32(b);

export function riceDecode(src, nx, out, outOff = 0, nblock = 32) {
  // 32-bit pixels (bytepix = 4), cfitsio fits_rdecomp algorithm.  Uses
  // floating arithmetic for the bit buffer so no 32-bit overflow can occur.
  const fsbits = 5, fsmax = 25, bbits = 32;
  let p = 4;
  let lastpix = ((src[0] << 24) | (src[1] << 16) | (src[2] << 8) | src[3]) | 0;
  let b = src[p++], nbits = 8;
  const P2 = n => 2 ** n;
  for (let i = 0; i < nx;) {
    nbits -= fsbits;
    while (nbits < 0) { b = b * 256 + src[p++]; nbits += 8; }
    const fs = Math.floor(b / P2(nbits)) - 1;
    b = b % P2(nbits);
    const imax = Math.min(i + nblock, nx);
    if (fs < 0) {
      for (; i < imax; i++) out[outOff + i] = lastpix;
    } else if (fs === fsmax) {
      for (; i < imax; i++) {
        let k = bbits - nbits;
        let diff = b * P2(k);
        for (k -= 8; k >= 0; k -= 8) { b = src[p++]; diff += b * P2(k); }
        if (nbits > 0) { b = src[p++]; diff += Math.floor(b / P2(-k)); b = b % P2(nbits); } else b = 0;
        diff = diff >>> 0;
        const d = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = (d + lastpix) | 0;
        out[outOff + i] = lastpix;
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) { nbits += 8; b = src[p++]; }
        const nzero = nbits - NZ[b];
        nbits -= nzero + 1;
        b -= P2(nbits);
        nbits -= fs;
        while (nbits < 0) { b = b * 256 + src[p++]; nbits += 8; }
        const diff = ((nzero * P2(fs)) + Math.floor(b / P2(nbits))) >>> 0;
        b = b % P2(nbits);
        const d = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1);
        lastpix = (d + lastpix) | 0;
        out[outOff + i] = lastpix;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- frame IO
// Reads rows [y0, y1] x cols [x0, x1] of the IMAGE (float32 BE).
async function readImageBlock(url, dataStart, x0, x1, y0, y1, signal) {
  const rowBytes = NPIX * 4;
  const buf = await range(url, dataStart + y0 * rowBytes, dataStart + (y1 + 1) * rowBytes - 1, signal);
  const dv = new DataView(buf);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const base = y * rowBytes + x0 * 4;
    for (let x = 0; x < w; x++) out[y * w + x] = dv.getFloat32(base + x * 4, false);
  }
  return out;
}

// Reads the same block from FLAGS (int32 image in QR2, RICE tiles in QR3).
async function readFlagsBlock(url, flagsHdrStart, x0, x1, y0, y1, signal) {
  const hb = await range(url, flagsHdrStart, flagsHdrStart + 12 * BLOCK - 1, signal);
  const h = parseHeader(hb, 0);
  if (!h) throw new Error('flags header');
  const c = h.cards, ds = flagsHdrStart + h.length;
  const w = x1 - x0 + 1, hh = y1 - y0 + 1;
  const out = new Int32Array(w * hh);
  if (c.XTENSION === 'IMAGE') {
    const rowBytes = NPIX * 4;
    const buf = await range(url, ds + y0 * rowBytes, ds + (y1 + 1) * rowBytes - 1, signal);
    const dv = new DataView(buf);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) out[y * w + x] = dv.getInt32(y * rowBytes + (x0 + x) * 4, false);
    return out;
  }
  if (c.ZIMAGE && c.ZCMPTYPE === 'RICE_1' && c.ZTILE2 === 1 && c.ZBITPIX === 32) {
    const tableRow = c.NAXIS1; // bytes per table row (descriptor = 2 x int32)
    const heapStart = ds + (c.THEAP || c.NAXIS1 * c.NAXIS2);
    const db = await range(url, ds + y0 * tableRow, ds + (y1 + 1) * tableRow - 1, signal);
    const dv = new DataView(db);
    const desc = [];
    let lo = Infinity, hi = 0;
    for (let y = 0; y < hh; y++) {
      const n = dv.getInt32(y * tableRow, false), o = dv.getInt32(y * tableRow + 4, false);
      desc.push([n, o]); lo = Math.min(lo, o); hi = Math.max(hi, o + n);
    }
    const heap = new Uint8Array(await range(url, heapStart + lo, heapStart + hi - 1, signal));
    const row = new Int32Array(NPIX);
    const bs = c.ZVAL1 && c.ZNAME1 === 'BLOCKSIZE' ? c.ZVAL1 : 32;
    for (let y = 0; y < hh; y++) {
      const [n, o] = desc[y];
      riceDecode(heap.subarray(o - lo, o - lo + n), NPIX, row, 0, bs);
      out.set(row.subarray(x0, x1 + 1), y * w);
    }
    return out;
  }
  throw new Error('unsupported FLAGS encoding');
}

// WCS-WAVE lookup table (last HDU).  One per detector & release; cached.
const waveCache = new Map();
export async function readWaveTableTail(url, signal) {
  const tail = await rangeSuffix(url, 4 * BLOCK, signal);
  const u8 = new Uint8Array(tail);
  // locate the last XTENSION header in the tail
  let at = -1;
  for (let i = 0; i + 80 <= u8.length; i += BLOCK) {
    const s = String.fromCharCode.apply(null, u8.subarray(i, i + 20));
    if (s.startsWith("XTENSION= 'BINTABLE")) {
      const h = parseHeader(tail, i);
      if (h && h.cards.EXTNAME === 'WCS-WAVE') at = i;
    }
  }
  if (at < 0) return null;
  const h = parseHeader(tail, at);
  const c = h.cards;
  const dv = new DataView(tail, at + h.length);
  // columns X (nJ), Y (nJ), VALUES (2*n*n E)
  const nx = parseInt(c.TFORM1, 10), ny = parseInt(c.TFORM2, 10);
  const X = [], Y = [];
  let o = 0;
  for (let i = 0; i < nx; i++, o += 4) X.push(dv.getInt32(o, false));
  for (let i = 0; i < ny; i++, o += 4) Y.push(dv.getInt32(o, false));
  // TDIM3 '(2,nx,ny)': fastest axis = [wave, band]
  const W = new Float32Array(nx * ny), BW = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    W[j * nx + i] = dv.getFloat32(o, false); o += 4;
    BW[j * nx + i] = dv.getFloat32(o, false); o += 4;
  }
  return { X, Y, W, BW, nx, ny };
}

async function rangeSuffix(url, n, signal) {
  const r = await fetch(url, { headers: { Range: `bytes=-${n}` }, signal, cache: 'force-cache', mode: 'cors' });
  if (r.status !== 206) throw new Error('suffix range ' + r.status);
  return r.arrayBuffer();
}

export function waveAt(t, x, y) {
  // X/Y control points are 1-based pixel coordinates (CRPIX=1 lookup).
  if (!t) return null;
  const px = x + 1, py = y + 1;
  const seg = (arr, v) => {
    let i = 0;
    while (i < arr.length - 2 && v > arr[i + 1]) i++;
    const f = (v - arr[i]) / (arr[i + 1] - arr[i]);
    return [i, Math.max(0, Math.min(1, f))];
  };
  const [i, fx] = seg(t.X, px), [j, fy] = seg(t.Y, py);
  const g = (A, ii, jj) => A[jj * t.nx + ii];
  const bil = A => g(A, i, j) * (1 - fx) * (1 - fy) + g(A, i + 1, j) * fx * (1 - fy) +
    g(A, i, j + 1) * (1 - fx) * fy + g(A, i + 1, j + 1) * fx * fy;
  return { wave: bil(t.W), band: bil(t.BW) };
}

export async function getWaveTable(f, url, signal) {
  const k = `${f.qr}|${f.det}|${f.ver}`;
  if (!waveCache.has(k)) {
    waveCache.set(k, readWaveTableTail(url, signal).catch(e => { waveCache.delete(k); throw e; }));
  }
  return waveCache.get(k);
}

// ---------------------------------------------------------------- cutout
// Build a north-up, east-left cutout of `size` px at `scale` arcsec/px centred
// on (ra, dec) from one SPHEREx frame.  Returns null if outside the frame.
export async function cutout(f, target, opts, signal) {
  const url = S3 + frameKey(f);
  const { size = 96, scale = 6.15, mask = true } = opts;
  const { cards, dataStart } = await readImageHeader(url, signal);
  const wcs = new WCS(cards);
  const c = wcs.sky2pix(target.ra, target.dec);
  if (!c) return null;
  const half = size / 2;
  if (c[0] < 4 || c[1] < 4 || c[0] > NPIX - 5 || c[1] > NPIX - 5) return null;
  // map a coarse grid of output pixels to native pixels first: this gives
  // the exact (rotated) footprint, so we read only the rows we need
  const ra0 = target.ra * Math.PI / 180, de0 = target.dec * Math.PI / 180;
  const sd0 = Math.sin(de0), cd0 = Math.cos(de0);
  const s = scale / 3600 * Math.PI / 180;
  const step = 8, gn = Math.ceil(size / step) + 1;
  const gx = new Float64Array(gn * gn), gy = new Float64Array(gn * gn);
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (let j = 0; j < gn; j++) for (let i = 0; i < gn; i++) {
    const xi = (half - i * step) * s, eta = (half - j * step) * s;
    const [ra, dec] = tanToSky(xi, eta, ra0, sd0, cd0);
    const p = wcs.sky2pix(ra, dec) || [NaN, NaN];
    gx[j * gn + i] = p[0]; gy[j * gn + i] = p[1];
    if (Number.isFinite(p[0])) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mny = Math.min(mny, p[1]); mxy = Math.max(mxy, p[1]); }
  }
  if (!Number.isFinite(mnx)) return null;
  const x0 = Math.max(0, Math.floor(mnx) - 2), x1 = Math.min(NPIX - 1, Math.ceil(mxx) + 2);
  const y0 = Math.max(0, Math.floor(mny) - 2), y1 = Math.min(NPIX - 1, Math.ceil(mxy) + 2);
  if (y1 - y0 < 4 || x1 - x0 < 4) return null;
  const [img, flags, wtab] = await Promise.all([
    readImageBlock(url, dataStart, x0, x1, y0, y1, signal),
    mask ? readFlagsBlock(url, dataStart + pad(dataSize(cards)), x0, x1, y0, y1, signal).catch(() => null) : null,
    getWaveTable(f, url, signal).catch(() => null),
  ]);
  const bw = x1 - x0 + 1;
  // reproject: output grid TAN centred on target, north up / east left
  const out = new Float32Array(size * size);
  let bad = 0;
  for (let j = 0; j < size; j++) {
    const gj = Math.min(gn - 2, Math.floor((j + 0.5) / step)), fj = (j + 0.5) / step - gj;
    for (let i = 0; i < size; i++) {
      const gi = Math.min(gn - 2, Math.floor((i + 0.5) / step)), fi = (i + 0.5) / step - gi;
      const k = gj * gn + gi;
      const px = (gx[k] * (1 - fi) + gx[k + 1] * fi) * (1 - fj) + (gx[k + gn] * (1 - fi) + gx[k + gn + 1] * fi) * fj - x0;
      const py = (gy[k] * (1 - fi) + gy[k + 1] * fi) * (1 - fj) + (gy[k + gn] * (1 - fi) + gy[k + gn + 1] * fi) * fj - y0;
      const ix = Math.floor(px), iy = Math.floor(py);
      if (!(ix >= 0 && iy >= 0 && ix < bw - 1 && iy < (y1 - y0))) { out[j * size + i] = NaN; bad++; continue; }
      const ax = px - ix, ay = py - iy;
      let acc = 0, wsum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const q = (iy + dy) * bw + ix + dx;
        const v = img[q];
        if (!Number.isFinite(v) || (flags && (flags[q] & BAD_FLAGS))) continue;
        const wgt = (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay);
        acc += v * wgt; wsum += wgt;
      }
      if (wsum > 0.15) out[j * size + i] = acc / wsum; else { out[j * size + i] = NaN; bad++; }
    }
  }
  const wv = waveAt(wtab, c[0], c[1]);
  return {
    data: out, size, scale,
    x: c[0], y: c[1],
    wave: wv ? wv.wave : (BANDS[f.det].lo + BANDS[f.det].hi) / 2,
    dwave: wv ? wv.band : null,
    mjd: cards['MJD-AVG'] || f.mjd,
    dateObs: cards['DATE-AVG'] || cards['DATE-OBS'] || '',
    exptime: cards.EXPTIME || cards.TELAPSE || null,
    psf: cards.PSF_FWHM || null,
    badFrac: bad / (size * size),
    bytes: (y1 - y0 + 1) * NPIX * 4 * (mask ? 1.6 : 1),
  };
}

// Quick-look of the middle of a frame for the live feed: reads a central
// band of rows and bins it down.  Returns {data,w,h,cards}.
export async function quicklook(key, rows = 256, bin = 4, signal) {
  const url = S3 + key;
  const { cards, dataStart } = await readImageHeader(url, signal);
  const y0 = (NPIX - rows) >> 1, y1 = y0 + rows - 1;
  const x0 = (NPIX - rows) >> 1, x1 = x0 + rows - 1;
  const img = await readImageBlock(url, dataStart, x0, x1, y0, y1, signal);
  const w = rows / bin;
  const out = new Float32Array(w * w);
  for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) {
    let s = 0, n = 0;
    for (let b = 0; b < bin; b++) for (let a = 0; a < bin; a++) {
      const v = img[(j * bin + b) * rows + i * bin + a];
      if (Number.isFinite(v)) { s += v; n++; }
    }
    out[j * w + i] = n ? s / n : NaN;
  }
  const wcs = new WCS(cards);
  const [ra, dec] = wcs.pix2sky(1019.5, 1019.5);
  return { data: out, w, h: w, cards, ra, dec };
}
