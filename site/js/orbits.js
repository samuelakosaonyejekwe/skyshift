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
  return sso.data.map(r => ({ name: r[0], kind: r[1], e: r[2], q: r[3], i: r[4], om: r[5], w: r[6], tp: r[7], H: r[8] }));
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
