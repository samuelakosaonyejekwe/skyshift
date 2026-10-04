// SkyShift - all-sky Mollweide map (equatorial, RA increasing to the left).
const D2R = Math.PI / 180;

export function mollweide(ra, dec) {
  // returns x in [-2, 2], y in [-1, 1]
  // callers pass ra-180 so that RA 180 sits in the centre of the map
  let lon = ((ra + 180) % 360 + 360) % 360 - 180;
  lon = -lon;                                       // east (increasing RA) to the left
  const phi = dec * D2R;
  let t = phi;
  for (let i = 0; i < 20; i++) {
    const d = (2 * t + Math.sin(2 * t) - Math.PI * Math.sin(phi)) / (2 + 2 * Math.cos(2 * t));
    t -= d;
    if (Math.abs(d) < 1e-9) break;
  }
  return [2 / Math.PI * (lon * D2R) * Math.cos(t), Math.sin(t)];
}

export function inverse(x, y) {
  // x in [-2,2], y in [-1,1]
  if (Math.abs(y) > 1) return null;
  const t = Math.asin(y);
  const lon = -Math.PI * x / (2 * Math.cos(t));
  if (Math.abs(lon) > Math.PI) return null;
  const phi = Math.asin((2 * t + Math.sin(2 * t)) / Math.PI);
  const ra = ((lon / D2R + 180) % 360 + 360) % 360;
  return [ra, phi / D2R];
}

// Galactic <-> equatorial (J2000)
const GP = { ra: 192.85948 * D2R, dec: 27.12825 * D2R, l: 122.93192 * D2R };
export function galToEq(l, b) {
  l *= D2R; b *= D2R;
  const sd = Math.sin(b) * Math.sin(GP.dec) + Math.cos(b) * Math.cos(GP.dec) * Math.cos(GP.l - l);
  const dec = Math.asin(sd);
  const y = Math.cos(b) * Math.sin(GP.l - l);
  const x = Math.sin(b) * Math.cos(GP.dec) - Math.cos(b) * Math.sin(GP.dec) * Math.cos(GP.l - l);
  return [((GP.ra + Math.atan2(y, x)) / D2R + 360) % 360, dec / D2R];
}
export function eqToGal(ra, dec) {
  ra *= D2R; dec *= D2R;
  const sb = Math.sin(dec) * Math.sin(GP.dec) + Math.cos(dec) * Math.cos(GP.dec) * Math.cos(ra - GP.ra);
  const b = Math.asin(sb);
  const y = Math.cos(dec) * Math.sin(ra - GP.ra);
  const x = Math.sin(dec) * Math.cos(GP.dec) - Math.cos(dec) * Math.sin(GP.dec) * Math.cos(ra - GP.ra);
  return [((GP.l - Math.atan2(y, x)) / D2R + 720) % 360, b / D2R];
}
export function eclToEq(lam, beta) {
  const e = 23.4392911 * D2R; lam *= D2R; beta *= D2R;
  const sd = Math.sin(beta) * Math.cos(e) + Math.cos(beta) * Math.sin(e) * Math.sin(lam);
  const ra = Math.atan2(Math.sin(lam) * Math.cos(e) - Math.tan(beta) * Math.sin(e), Math.cos(lam));
  return [(ra / D2R + 360) % 360, Math.asin(sd) / D2R];
}

const RAMP = [[8, 10, 30], [32, 22, 90], [70, 40, 150], [40, 110, 200], [60, 190, 190], [170, 230, 120], [255, 240, 140], [255, 255, 255]];
function ramp(t) {
  t = Math.max(0, Math.min(1, t)) * (RAMP.length - 1);
  const k = Math.min(RAMP.length - 2, Math.floor(t)), f = t - k;
  return RAMP[k].map((c, i) => Math.round(c * (1 - f) + RAMP[k + 1][i] * f));
}

export class SkyMap {
  constructor(canvas, { onPick, onHover } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.onPick = onPick; this.onHover = onHover;
    this.layers = { sky: true, coverage: true, grid: true, galactic: false, ecliptic: true, targets: true, exo: false, live: true };
    this.skyImg = new Image();
    this.skyImg.onload = () => { this.bg = null; this.draw(); };
    this.skyImg.src = new URL(window.innerWidth < 900 ? '../img/allsky-1000.webp' : '../img/allsky.webp', import.meta.url).href;
    this.mode = 'counts';
    this.points = { targets: [], exo: [], live: [] };
    this.zoom = 1; this.cx = 0; this.cy = 0;
    this.bg = null;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
    this.bindPointer();
  }
  setCoverage(cov) {
    // smooth the 1-degree grid (5x5, RA wraps) so scan-strip binning doesn't alias
    const blur = (src, W, H) => {
      const k = [1, 3, 4, 3, 1], tmp = new Float32Array(W * H), out = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let i = -2; i <= 2; i++) { const v = src[y * W + (x + i + W) % W]; if (v) { s += v * k[i + 2]; n += k[i + 2]; } }
        tmp[y * W + x] = n ? s / n : 0;
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let i = -2; i <= 2; i++) { const yy = y + i; if (yy < 0 || yy >= H) continue; const v = tmp[yy * W + x]; if (v) { s += v * k[i + 2]; n += k[i + 2]; } }
        out[y * W + x] = n ? s / n : 0;
      }
      return out;
    };
    cov.counts = blur(blur(cov.counts, cov.w, cov.h), cov.w, cov.h);
    this.cov = cov; this.bg = null; this.draw();
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.c.width = Math.max(200, Math.round(r.width * dpr));
    this.c.height = Math.max(100, Math.round(r.width / 2 * dpr));
    this.c.style.height = (r.width / 2) + 'px';
    this.bg = null;
    this.draw();
  }
  // map projection coords -> canvas px
  toPx(x, y) {
    const W = this.c.width, H = this.c.height;
    const s = (W / 4.1) * this.zoom;
    return [W / 2 + (x - this.cx) * s, H / 2 - (y - this.cy) * s];
  }
  fromPx(px, py) {
    const W = this.c.width, H = this.c.height;
    const s = (W / 4.1) * this.zoom;
    return [(px - W / 2) / s + this.cx, -(py - H / 2) / s + this.cy];
  }
  sky(ra, dec) { const [x, y] = mollweide(ra - 180, dec); return this.toPx(x, y); }
  pick(px, py) {
    const [x, y] = this.fromPx(px, py);
    const r = inverse(x, y);
    if (!r) return null;
    return r;
  }
  // Coverage glow (translucent) rendered once per view into an offscreen canvas
  renderBackground() {
    const W = this.c.width, H = this.c.height;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');
    const img = octx.createImageData(W, H);
    const d = img.data;
    const cov = this.cov;
    if (cov && this.layers.coverage) {
      if (!cov.range) {
        const v = [];
        for (let i = 0; i < cov.counts.length; i += 7) if (cov.counts[i]) v.push(cov.counts[i]);
        v.sort((a, b) => a - b);
        cov.range = [Math.max(1, v[Math.floor(v.length * 0.03)] || 1), v[Math.floor(v.length * 0.97)] || 2];
      }
      const [lo, hi] = cov.range;
      const llo = Math.log(lo), lspan = Math.log(hi) - llo || 1;
      const sample = (arr, ra, dec) => {
        const x = ra - 0.5, y = dec + 90 - 0.5;
        const x0 = Math.floor(x), y0 = Math.max(0, Math.min(cov.h - 1, Math.floor(y)));
        const y1 = Math.min(cov.h - 1, y0 + 1), fx = x - x0, fy = Math.max(0, Math.min(1, y - y0));
        const a = (xx, yy) => arr[yy * cov.w + ((xx % 360) + 360) % 360];
        return (a(x0, y0) * (1 - fx) + a(x0 + 1, y0) * fx) * (1 - fy) + (a(x0, y1) * (1 - fx) + a(x0 + 1, y1) * fx) * fy;
      };
      const solid = !this.layers.sky;            // without the sky photo, draw it opaque
      const step = 2;   // the glow is smooth anyway: half resolution renders 4x faster
      for (let py = 0; py < H; py += step) for (let px = 0; px < W; px += step) {
        const s = this.pick(px, py);
        if (!s) continue;
        let t;
        if (this.mode === 'counts') {
          const v = sample(cov.counts, s[0], s[1]);
          t = v > 0.5 ? Math.max(0, Math.min(1, (Math.log(v) - llo) / lspan)) : 0;
        } else {
          const v = sample(cov.lastDay, s[0], s[1]);
          t = v ? 1 - Math.min(1, Math.max(0, (cov.nowDay - v) / (cov.nowDay - cov.minDay || 1))) : 0;
        }
        const rgb = ramp(solid ? 0.1 + 0.9 * t : 0.12 + 0.72 * t);   // overlay tops out at gold, not white
        const alpha = solid ? 255 : Math.round(18 + 150 * Math.min(t, 0.72) ** 2);   // deep fields glow softly, sky stays visible
        for (let yy = 0; yy < step; yy++) for (let xx = 0; xx < step; xx++) {
          const i = ((py + yy) * W + px + xx) * 4;
          d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = alpha;
        }
      }
    }
    octx.putImageData(img, 0, 0);
    this.bg = off;
  }
  ellipsePath() {
    const ctx = this.ctx;
    const [cx, cy] = this.toPx(0, 0);
    const s = (this.c.width / 4.1) * this.zoom;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 2 * s, s, 0, 0, Math.PI * 2);
  }
  line(pts, style, width = 1, dash = []) {
    const ctx = this.ctx;
    ctx.strokeStyle = style; ctx.lineWidth = width * (devicePixelRatio || 1); ctx.setLineDash(dash);
    ctx.beginPath();
    let prev = null;
    for (const [ra, dec] of pts) {
      const p = this.sky(ra, dec);
      if (prev && Math.abs(p[0] - prev[0]) < this.c.width / 3) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]);
      prev = p;
    }
    ctx.stroke(); ctx.setLineDash([]);
  }
  draw() {
    if (!this.ctx) return;
    const ctx = this.ctx, W = this.c.width, H = this.c.height, dpr = devicePixelRatio || 1;
    if (!this.bg) this.renderBackground();
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    this.ellipsePath();
    ctx.fillStyle = '#05060f';
    ctx.fill();
    ctx.clip();
    if (this.layers.sky && this.skyImg.complete && this.skyImg.naturalWidth) {
      const [x0, y0] = this.toPx(-2, 1), [x1, y1] = this.toPx(2, -1);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.skyImg, x0, y0, x1 - x0, y1 - y0);
    }
    // screen blend keeps the photo's detail visible through the coverage glow
    if (this.layers.sky) ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.bg, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    // soft rim
    ctx.save();
    this.ellipsePath();
    ctx.strokeStyle = 'rgba(140,170,255,0.35)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.shadowColor = 'rgba(102,217,255,0.45)';
    ctx.shadowBlur = 14 * dpr;
    ctx.stroke();
    ctx.restore();
    if (this.layers.grid) {
      for (let dec = -60; dec <= 60; dec += 30) {
        const pts = []; for (let ra = 0; ra <= 360; ra += 2) pts.push([ra, dec]);
        this.line(pts, 'rgba(170,190,255,0.09)');
      }
      for (let ra = 0; ra < 360; ra += 30) {
        const pts = []; for (let dec = -90; dec <= 90; dec += 2) pts.push([ra + 1e-6, dec]);
        this.line(pts, 'rgba(170,190,255,0.09)');
      }
      ctx.fillStyle = 'rgba(200,215,255,0.45)';
      ctx.font = `600 ${9.5 * dpr}px system-ui, sans-serif`;
      for (let h = 0; h < 24; h += 4) {
        const p = this.sky(h * 15 + 0.01, 0);
        ctx.fillText(h + 'h', p[0] + 3 * dpr, p[1] - 3 * dpr);
      }
    }
    if (this.layers.galactic) {
      const pts = []; for (let l = 0; l <= 360; l += 1) pts.push(galToEq(l, 0));
      this.line(pts, 'rgba(255,170,90,0.7)', 1.2, [6, 4]);
      const gc = this.sky(266.4, -28.94);
      ctx.fillStyle = 'rgba(255,170,90,0.9)'; ctx.fillText('Galactic centre', gc[0] + 4 * dpr, gc[1] + 12 * dpr);
    }
    if (this.layers.ecliptic) {
      const pts = []; for (let l = 0; l <= 360; l += 1) pts.push(eclToEq(l, 0));
      this.line(pts, 'rgba(120,220,255,0.55)', 1.1, [1.5, 5]);
    }
    const dot = (ra, dec, r, fill, stroke) => {
      const p = this.sky(ra, dec);
      ctx.beginPath(); ctx.arc(p[0], p[1], r * dpr, 0, 2 * Math.PI);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
      return p;
    };
    if (this.layers.exo) for (const e of this.points.exo) dot(e[1], e[2], 1.4, 'rgba(140,255,170,0.75)');
    const sparkle = (ra, dec, r, core, glow) => {
      const p = this.sky(ra, dec);
      ctx.save();
      ctx.shadowColor = glow; ctx.shadowBlur = 10 * dpr;
      ctx.fillStyle = core;
      ctx.beginPath();
      const R = r * dpr, q = R * 0.28;
      ctx.moveTo(p[0], p[1] - R); ctx.quadraticCurveTo(p[0] + q, p[1] - q, p[0] + R, p[1]);
      ctx.quadraticCurveTo(p[0] + q, p[1] + q, p[0], p[1] + R); ctx.quadraticCurveTo(p[0] - q, p[1] + q, p[0] - R, p[1]);
      ctx.quadraticCurveTo(p[0] - q, p[1] - q, p[0], p[1] - R);
      ctx.fill();
      ctx.beginPath(); ctx.arc(p[0], p[1], 1.6 * dpr, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.restore();
      return p;
    };
    if (this.layers.live) for (const e of this.points.live) {
      const p = this.sky(e.ra, e.dec);
      ctx.save(); ctx.shadowColor = 'rgba(255,90,140,.9)'; ctx.shadowBlur = 10 * dpr;
      ctx.strokeStyle = 'rgba(255,120,160,.95)'; ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath(); ctx.arc(p[0], p[1], 4.5 * dpr, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(p[0], p[1], 1.6 * dpr, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.restore();
    }
    if (this.layers.targets) {
      ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      for (const t of this.points.targets) {
        const p = sparkle(t.ra, t.dec, 6.5, '#ffd34d', 'rgba(255,190,80,.95)');
        if (this.zoom > 1.6 || t.label) { ctx.fillStyle = '#ffe9a3'; ctx.shadowColor = '#000'; ctx.shadowBlur = 4 * dpr; ctx.fillText(t.name, p[0] + 9 * dpr, p[1] + 4 * dpr); ctx.shadowBlur = 0; }
      }
    }
  }
  setZoom(z, ax, ay) {
    const before = ax != null ? this.fromPx(ax, ay) : null;
    this.zoom = Math.max(1, Math.min(12, z));
    if (before) {
      const after = this.fromPx(ax, ay);
      this.cx += before[0] - after[0]; this.cy += before[1] - after[1];
    }
    if (this.zoom === 1) { this.cx = 0; this.cy = 0; }
    // page scrolls over the map unless zoomed in (then drag pans the map)
    this.c.style.touchAction = this.zoom > 1 ? 'none' : 'pan-y';
    this.bg = null; this.draw();
  }
  nearestPoint(px, py) {
    let best = null, bd = 14 * (devicePixelRatio || 1);
    const consider = (o, kind) => {
      const p = this.sky(o.ra ?? o[1], o.dec ?? o[2]);
      const d = Math.hypot(p[0] - px, p[1] - py);
      if (d < bd) { bd = d; best = { kind, o }; }
    };
    if (this.layers.targets) this.points.targets.forEach(t => consider(t, 'target'));
    if (this.layers.live) this.points.live.forEach(t => consider(t, 'live'));
    if (this.layers.exo && !best) this.points.exo.forEach(t => consider(t, 'exo'));
    return best;
  }
  bindPointer() {
    const c = this.c;
    const ptrs = new Map();
    let moved = false, start = null, pinch0 = null;
    const pos = e => { const r = c.getBoundingClientRect(); const k = c.width / r.width; return [(e.clientX - r.left) * k, (e.clientY - r.top) * k]; };
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pos(e)); moved = false; start = pos(e);
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: this.zoom }; }
    });
    c.addEventListener('pointermove', e => {
      const p = pos(e);
      if (!ptrs.has(e.pointerId)) {
        if (this.onHover) this.onHover(this.pick(...p), this.nearestPoint(...p), e);
        return;
      }
      const prev = ptrs.get(e.pointerId);
      ptrs.set(e.pointerId, p);
      if (ptrs.size === 2 && pinch0) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this.setZoom(pinch0.z * d / pinch0.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        moved = true; return;
      }
      if (Math.hypot(p[0] - start[0], p[1] - start[1]) > 6) moved = true;
      if (moved && this.zoom > 1) {
        const s = (c.width / 4.1) * this.zoom;
        this.cx -= (p[0] - prev[0]) / s; this.cy += (p[1] - prev[1]) / s;
        this.draw();
      }
    });
    const up = e => {
      const p = pos(e);
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch0 = null;
      if (!moved && this.onPick) {
        const near = this.nearestPoint(...p);
        const s = this.pick(...p);
        if (s || near) this.onPick(s, near);
      }
      if (moved) { this.bg = null; this.draw(); }
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch0 = null; });
    c.style.touchAction = 'pan-y';
    // wheel zooms only with Ctrl/Cmd (or a trackpad pinch) or once zoomed in
    c.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey || this.zoom > 1)) return;
      e.preventDefault();
      const p = pos(e);
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.25 : 0.8), p[0], p[1]);
    }, { passive: false });
  }
}
