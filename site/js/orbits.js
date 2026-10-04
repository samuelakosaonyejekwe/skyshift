// SkyShift - offline solar-system positions.
// Two-body propagation of JPL SBDB osculating elements (elliptic, parabolic
// and hyperbolic orbits) plus a JPL "approximate positions" Earth model.
// Accuracy is tens of arcseconds - ample to label objects in 6"-pixel
// SPHEREx images without any network connection.

const D2R = Math.PI / 180;
const K = 0.01720209895;          // Gaussian gravitational constant
const EPS = 23.4392911 * D2R;     // J2000 obliquity
const C_AU_D = 173.1446327;       // speed of light, au/day

function solveKepler(M, e) {
  M = ((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let k = 0; k < 30; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}
function solveHyper(M, e) {
  let H = Math.asinh(M / e);
  for (let k = 0; k < 50; k++) {
    const d = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return H;
}

// Heliocentric ecliptic J2000 position (au) from perihelion elements.
export function helio(el, mjd) {
  const { e, q, i, om, w, tp } = el;
  const dt = mjd - tp;
  let x, y;
  if (Math.abs(1 - e) < 1e-4) {            // (near-)parabolic: Barker
    const W = 3 * K * dt / Math.sqrt(2 * q * q * q);
    const Y = Math.cbrt(W / 2 + Math.sqrt(W * W / 4 + 1));
    const s = Y - 1 / Y;                      // tan(nu/2)
    const nu = 2 * Math.atan(s);
    const r = q * (1 + s * s);
    x = r * Math.cos(nu); y = r * Math.sin(nu);
  } else if (e < 1) {
    const a = q / (1 - e);
    const n = K / Math.sqrt(a * a * a);
    const E = solveKepler(n * dt, e);
    x = a * (Math.cos(E) - e); y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  } else {
    const a = q / (e - 1);
    const n = K / Math.sqrt(a * a * a);
    const H = solveHyper(n * dt, e);
    x = a * (e - Math.cosh(H)); y = a * Math.sqrt(e * e - 1) * Math.sinh(H);
  }
  const cO = Math.cos(om * D2R), sO = Math.sin(om * D2R);
  const cw = Math.cos(w * D2R), sw = Math.sin(w * D2R);
  const ci = Math.cos(i * D2R), si = Math.sin(i * D2R);
  return [
    (cO * cw - sO * sw * ci) * x + (-cO * sw - sO * cw * ci) * y,
    (sO * cw + cO * sw * ci) * x + (-sO * sw + cO * cw * ci) * y,
    (sw * si) * x + (cw * si) * y,
  ];
}

// Earth-Moon barycentre (JPL approximate elements, 1800-2050).
export function earth(mjd) {
  const T = (mjd + 2400000.5 - 2451545.0) / 36525;
  const a = 1.00000261 + 0.00000562 * T;
  const e = 0.01671123 - 0.00004392 * T;
  const I = (-0.00001531 - 0.01294668 * T) * D2R;
  const L = (100.46457166 + 35999.37244981 * T) * D2R;
  const vp = (102.93768193 + 0.32327364 * T) * D2R;
  const O = 0;
  const w = vp - O, M = L - vp;
  const E = solveKepler(M, e);
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    (sw * sI) * xp + (cw * sI) * yp,
  ];
}

function eclToEq([x, y, z]) {
  return [x, y * Math.cos(EPS) - z * Math.sin(EPS), y * Math.sin(EPS) + z * Math.cos(EPS)];
}

// Geocentric astrometric RA/Dec (deg), distances (au) and rough magnitude.
export function geocentric(el, mjd, E = earth(mjd)) {
  let p = helio(el, mjd);
  let d = Math.hypot(p[0] - E[0], p[1] - E[1], p[2] - E[2]);
  p = helio(el, mjd - d / C_AU_D);           // light-time
  const g = eclToEq([p[0] - E[0], p[1] - E[1], p[2] - E[2]]);
  d = Math.hypot(...g);
  const r = Math.hypot(...p);
  const ra = ((Math.atan2(g[1], g[0]) / D2R) + 360) % 360;
  const dec = Math.asin(g[2] / d) / D2R;
  let mag;
  if (el.kind === 'c') {
    mag = el.H + 5 * Math.log10(d) + 10 * Math.log10(r);
  } else {
    const es = Math.hypot(...E);
    const cosb = Math.max(-1, Math.min(1, (r * r + d * d - es * es) / (2 * r * d)));
    const beta = Math.acos(cosb), t = Math.tan(beta / 2);
    const G = 0.15;
    const phi1 = Math.exp(-3.33 * t ** 0.63), phi2 = Math.exp(-1.87 * t ** 1.22);
    mag = el.H + 5 * Math.log10(r * d) - 2.5 * Math.log10((1 - G) * phi1 + G * phi2);
  }
  return { ra, dec, delta: d, r, mag };
}

export function unpack(sso) {
  return sso.data.map(r => ({ name: r[0], kind: r[1], e: r[2], q: r[3], i: r[4], om: r[5], w: r[6], tp: r[7], H: r[8], epoch: r[9] }));
}

export function sep(ra1, de1, ra2, de2) {
  const s = Math.sin((de1 - de2) * D2R / 2) ** 2 +
    Math.cos(de1 * D2R) * Math.cos(de2 * D2R) * Math.sin((ra1 - ra2) * D2R / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / D2R;
}

// Known objects inside a circle at a set of epochs.  First a cheap prefilter
// at the mid epoch, then exact positions per epoch.
export function objectsInField(objs, ra, dec, radiusDeg, mjds, magLimit = 21) {
  if (!mjds.length) return [];
  const mid = mjds[Math.floor(mjds.length / 2)];
  const span = Math.max(...mjds) - Math.min(...mjds);
  const Em = earth(mid);
  const pre = [];
  for (const o of objs) {
    const g = geocentric(o, mid, Em);
    // generous window: fast NEOs can move several degrees a day
    const slack = radiusDeg + Math.min(60, 1.2 * span * (0.6 / Math.max(0.05, g.delta)));
    if (sep(g.ra, g.dec, ra, dec) < slack && g.mag < magLimit + 2) pre.push(o);
  }
  const out = [];
  for (const o of pre) {
    const pts = [];
    for (const t of mjds) {
      const g = geocentric(o, t);
      if (sep(g.ra, g.dec, ra, dec) < radiusDeg && g.mag < magLimit) pts.push({ mjd: t, ...g });
    }
    if (pts.length) out.push({ obj: o, pts });
  }
  return out;
}

// =====================================================================
// High-accuracy mode: N-body integration (Sun + 7 planets) from the SBDB
// osculating epoch, planet states from JPL Horizons (data/ephem.json), and
// the SPHEREx spacecraft's own orbit for parallax (data/spherex_orbit.bin).
// Typical agreement with JPL Horizons: a few arcseconds.
// =====================================================================
const K2 = K * K;
const MASS = { venus: 1 / 408523.71, earth: 1 / 328900.56, mars: 1 / 3098703.59, jupiter: 1 / 1047.348644, saturn: 1 / 3497.9018, uranus: 1 / 22902.94, neptune: 1 / 19412.26 };
const TDB = 69.184 / 86400;          // UTC -> TDB (days), valid 2017+
let EPH = null, ORB = null;

export function setEphem(eph, orbitBuf) {
  if (eph && eph.bodies) {
    const b = {};
    for (const [k, arr] of Object.entries(eph.bodies)) b[k] = Float64Array.from(arr);
    EPH = { t0: eph.t0, step: eph.step, n: b.earth.length / 6, b };
  }
  if (orbitBuf) {
    const dv = new DataView(orbitBuf);
    if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) === 'SXO1') {
      const t0 = dv.getFloat64(4, true), n = dv.getUint32(12, true), step = dv.getFloat64(16, true);
      ORB = { t0, n, step, v: new Float32Array(orbitBuf.slice(24, 24 + n * 24)) };
    }
  }
  return !!EPH;
}
export const hasEphem = () => !!EPH;

function hermite(arr, i, s, h, out) {
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const a = i * 6, c = a + 6;
  for (let k = 0; k < 3; k++) out[k] = h00 * arr[a + k] + h10 * h * arr[a + 3 + k] + h01 * arr[c + k] + h11 * h * arr[c + 3 + k];
  return out;
}
function bodyAt(name, tdb, out = [0, 0, 0]) {
  const x = (tdb - EPH.t0) / EPH.step;
  const i = Math.max(0, Math.min(EPH.n - 2, Math.floor(x)));
  return hermite(EPH.b[name], i, x - i, EPH.step, out);
}
const inEph = tdb => EPH && tdb >= EPH.t0 && tdb <= EPH.t0 + (EPH.n - 1) * EPH.step;

// SPHEREx offset from the geocentre, equatorial, in au
function spacecraft(mjd) {
  if (!ORB) return null;
  const x = (mjd + TDB - ORB.t0) / ORB.step;
  if (x < 0 || x > ORB.n - 1) return null;
  const i = Math.min(ORB.n - 2, Math.floor(x));
  const v = ORB.v, a = i * 6, c = a + 6, s = x - i, h = ORB.step * 86400; // velocities are km/s
  const s2 = s * s, s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
  const AU = 149597870.7;
  return [0, 1, 2].map(k => (h00 * v[a + k] + h10 * h * v[a + 3 + k] + h01 * v[c + k] + h11 * h * v[c + 3 + k]) / AU);
}

const PLANETS = Object.keys(MASS);
const tmp = [0, 0, 0];
function accel(t, r, out) {
  const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2], r3 = r2 * Math.sqrt(r2);
  out[0] = -K2 * r[0] / r3; out[1] = -K2 * r[1] / r3; out[2] = -K2 * r[2] / r3;
  for (const p of PLANETS) {
    const q = bodyAt(p, t, tmp);
    const dx = q[0] - r[0], dy = q[1] - r[1], dz = q[2] - r[2];
    const d2 = dx * dx + dy * dy + dz * dz, d3 = d2 * Math.sqrt(d2);
    const q2 = q[0] * q[0] + q[1] * q[1] + q[2] * q[2], q3 = q2 * Math.sqrt(q2);
    const gm = K2 * MASS[p];
    out[0] += gm * (dx / d3 - q[0] / q3); out[1] += gm * (dy / d3 - q[1] / q3); out[2] += gm * (dz / d3 - q[2] / q3);
  }
  return out;
}

// integrate state y=[x,y,z,vx,vy,vz] from t to t+h (RK4)
function rk4(t, y, h) {
  const f = (tt, yy) => { const a = accel(tt, yy, [0, 0, 0]); return [yy[3], yy[4], yy[5], a[0], a[1], a[2]]; };
  const k1 = f(t, y);
  const y2 = y.map((v, i) => v + h / 2 * k1[i]); const k2 = f(t + h / 2, y2);
  const y3 = y.map((v, i) => v + h / 2 * k2[i]); const k3 = f(t + h / 2, y3);
  const y4 = y.map((v, i) => v + h * k3[i]); const k4 = f(t + h, y4);
  return y.map((v, i) => v + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
}

const TRACKS = new Map();
// Dense heliocentric track (Hermite samples) covering [t0, t1] (TDB)
function track(el, t0, t1) {
  const key = el.name;
  let tr = TRACKS.get(key);
  if (tr && tr.t0 <= t0 && tr.t1 >= t1) return tr;
  const ep = el.epoch;
  const h = el.q < 1.3 ? 0.25 : 0.5;
  // initial state at epoch from the osculating two-body orbit
  const p0 = helio(el, ep), pa = helio(el, ep - 0.005), pb = helio(el, ep + 0.005);
  const y0 = [...p0, (pb[0] - pa[0]) / 0.01, (pb[1] - pa[1]) / 0.01, (pb[2] - pa[2]) / 0.01];
  // the time grid must pass exactly through the epoch: the initial state is
  // only valid there (an offset of up to h/2 would shift every position)
  const before = Math.ceil((ep - (Math.min(t0, ep) - 1)) / h), after = Math.ceil((Math.max(t1, ep) + 1 - ep) / h);
  const lo = ep - before * h;
  const n = before + after + 1;
  const S = new Float64Array(n * 6);
  const iEp = before;
  const put = (i, y) => { for (let k = 0; k < 6; k++) S[i * 6 + k] = y[k]; };
  put(iEp, y0);
  let y = y0;
  for (let i = iEp; i < n - 1; i++) { y = rk4(lo + i * h, y, h); put(i + 1, y); }
  y = y0;
  for (let i = iEp; i > 0; i--) { y = rk4(lo + i * h, y, -h); put(i - 1, y); }
  tr = { t0: lo, t1: lo + (n - 1) * h, h, n, S, ep: lo };
  TRACKS.set(key, tr);
  if (TRACKS.size > 400) TRACKS.delete(TRACKS.keys().next().value);
  return tr;
}
function trackAt(tr, t) {
  const x = (t - tr.ep) / tr.h;
  const i = Math.max(0, Math.min(tr.n - 2, Math.floor(x)));
  return hermite(tr.S, i, x - i, tr.h, [0, 0, 0]);
}

// Apparent position as seen by SPHEREx (falls back to two-body/geocentric).
export function precise(el, mjd, span) {
  const t = mjd + TDB;
  // the N-body run starts from the osculating epoch; without one, use two-body
  if (!inEph(t) || el.epoch == null) return geocentric(el, mjd);
  const tr = track(el, span ? span[0] + TDB - 2 : t - 2, span ? span[1] + TDB + 2 : t + 2);
  const E = bodyAt('earth', t, [0, 0, 0]);
  let p = trackAt(tr, t);
  let d = Math.hypot(p[0] - E[0], p[1] - E[1], p[2] - E[2]);
  p = trackAt(tr, t - d / C_AU_D);
  let g = eclToEq([p[0] - E[0], p[1] - E[1], p[2] - E[2]]);
  const sc = spacecraft(mjd);
  if (sc) g = [g[0] - sc[0], g[1] - sc[1], g[2] - sc[2]];
  d = Math.hypot(...g);
  const r = Math.hypot(...p);
  const ra = ((Math.atan2(g[1], g[0]) / D2R) + 360) % 360, dec = Math.asin(g[2] / d) / D2R;
  const two = geocentric(el, mjd);   // reuse its magnitude model
  return { ra, dec, delta: d, r, mag: two.mag, precise: true };
}

// Shift a geocentric RA/Dec (e.g. from a Horizons track) to SPHEREx's viewpoint.
export function toSpacecraft(ra, dec, delta, mjd) {
  const sc = spacecraft(mjd);
  if (!sc || !(delta > 0.0005)) return [ra, dec];
  const cr = Math.cos(ra * D2R), sr = Math.sin(ra * D2R), cd = Math.cos(dec * D2R), sd = Math.sin(dec * D2R);
  const g = [delta * cd * cr - sc[0], delta * cd * sr - sc[1], delta * sd - sc[2]];
  const d = Math.hypot(...g);
  return [((Math.atan2(g[1], g[0]) / D2R) + 360) % 360, Math.asin(g[2] / d) / D2R];
}

export function objectsInFieldPrecise(objs, ra, dec, radiusDeg, mjds, magLimit = 21) {
  if (!EPH) return objectsInField(objs, ra, dec, radiusDeg, mjds, magLimit);
  // two-body prefilter with extra margin, then N-body for the survivors
  const rough = objectsInField(objs, ra, dec, radiusDeg + 0.15, mjds, magLimit + 0.5);
  const span = [Math.min(...mjds), Math.max(...mjds)];
  const out = [];
  for (const k of rough) {
    const pts = [];
    for (const t of mjds) {
      const g = precise(k.obj, t, span);
      if (sep(g.ra, g.dec, ra, dec) < radiusDeg && g.mag < magLimit) pts.push({ mjd: t, ...g });
    }
    if (pts.length) out.push({ obj: k.obj, pts, precise: true });
  }
  return out;
}
