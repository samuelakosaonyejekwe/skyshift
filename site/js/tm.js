// SkyShift - Time Machine: stream, display, compare, measure and hunt.
import { $, $$, h, toast, fmtDate, fmtShortDate, fmtCoord, galStr, fmtBytes, fmtInt, download, slug, clamp, waveColor, mjdToDate } from './util.js';
import { framesNear, getJSON, getBin } from './data.js';
import { S3, BANDS, frameKey, obsId, skyToTan, tanToSky, cutout as cutoutMain, WCS, flagsNear, parseHeader } from './fits.js';
import * as R from './render.js';
import { chart } from './charts.js';
import { encodeGIF } from './gif.js';
import * as store from './store.js';
import { unpack, objectsInFieldPrecise, precise, toSpacecraft, setEphem, hasEphem, sep } from './orbits.js';

const D2R = Math.PI / 180;
const VISIT_GAP = 20;           // days between survey visits
const LINES = [
  { x: 1.282, label: 'Paβ' }, { x: 1.875, label: 'Paα' }, { x: 3.05, label: 'H₂O ice' },
  { x: 3.3, label: 'PAH' }, { x: 4.05, label: 'Brα' }, { x: 4.27, label: 'CO₂ ice' }, { x: 4.67, label: 'CO' },
];
const VISIT_COLORS = ['#ffb347', '#66d9ff', '#b78cff', '#5ee6a0', '#ff6b7d', '#ffd166', '#7fa8ff', '#ff9ad5'];
const REF_SURVEYS = [
  { id: 'CDS/P/unWISE/W1', label: 'NASA WISE + NEOWISE 3.4 µm (unWISE, 2010–2020)', short: 'WISE/NEOWISE 3.4 µm', years: '2010–20', dets: [4] },
  { id: 'CDS/P/unWISE/W2', label: 'NASA WISE + NEOWISE 4.6 µm (unWISE, 2010–2020)', short: 'WISE/NEOWISE 4.6 µm', years: '2010–20', dets: [6, 5] },
  { id: 'CDS/P/allWISE/W1', label: 'NASA WISE 3.4 µm (AllWISE, 2010)', short: 'WISE 3.4 µm', years: '2010', dets: [4] },
  { id: 'CDS/P/2MASS/K', label: '2MASS Ks 2.2 µm (NASA/IPAC, 1997–2001)', short: '2MASS 2.2 µm', years: '1997–2001', dets: [3] },
  { id: 'CDS/P/2MASS/H', label: '2MASS H 1.65 µm (1997–2001)', short: '2MASS 1.65 µm', years: '1997–2001', dets: [3, 2] },
  { id: 'CDS/P/2MASS/J', label: '2MASS J 1.25 µm (1997–2001)', short: '2MASS 1.25 µm', years: '1997–2001', dets: [2] },
];

let ctx;                       // app context: {settings, onSaved}
let worker = null, workerOK = null, jobSeq = 0;
let S = null;                  // current session state
let ssoCache = null;

export function initTM(appCtx) {
  ctx = appCtx;
  bindUI();
}

// ------------------------------------------------------------------ worker
function getWorker() {
  if (workerOK === false) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    workerOK = true;
    worker.onerror = () => { workerOK = false; worker = null; };
  } catch { workerOK = false; worker = null; }
  return worker;
}

function effectiveMode() {
  const m = ctx.settings.mode || 'auto';
  const c = navigator.connection;
  if (m === 'auto' && c && (c.saveData || /(^|-)2g|3g/.test(c.effectiveType || ''))) return 'saver';
  return m;
}

// Reference sky (WISE/NEOWISE, 2MASS) as raw FITS on exactly our pixel grid,
// so it gets the same stretch and colours as SPHEREx
const refCache = new Map();
function refImage(sv, tg, N) {
  const key = `${sv.id}|${tg.ra.toFixed(5)}|${tg.dec.toFixed(5)}|${N}`;
  if (!refCache.has(key)) {
    const url = `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=${encodeURIComponent(sv.id)}&width=${N}&height=${N}&fov=${(N * 6.15 / 3600).toFixed(6)}&projection=TAN&coordsys=icrs&ra=${tg.ra.toFixed(6)}&dec=${tg.dec.toFixed(6)}&format=fits`;
    refCache.set(key, fetch(url).then(r => { if (!r.ok) throw new Error('ref ' + r.status); return r.arrayBuffer(); }).then(buf => {
      const hd = parseHeader(buf, 0);
      const c = hd.cards, w = c.NAXIS1, hh = c.NAXIS2, dv = new DataView(buf, hd.length);
      const out = new Float32Array(N * N);
      const flipX = (c.CDELT1 ?? c.CD1_1 ?? -1) > 0;      // we want east on the left
      for (let y = 0; y < Math.min(N, hh); y++) for (let x = 0; x < Math.min(N, w); x++) {
        const v = c.BITPIX === -32 ? dv.getFloat32((y * w + x) * 4, false) : dv.getFloat64((y * w + x) * 8, false);
        out[(N - 1 - y) * N + (flipX ? N - 1 - x : x)] = v * (c.BSCALE || 1) + (c.BZERO || 0);
      }
      return out;
    }).catch(e => { refCache.delete(key); throw e; }));
  }
  return refCache.get(key);
}

// JPL Horizons planet states + SPHEREx orbit for arcsecond-level positions
let ephemP = null;
function loadEphem() {
  if (!ephemP) ephemP = Promise.all([getJSON('ephem.json'), getBin('spherex_orbit.bin').catch(() => null)])
    .then(([e, o]) => setEphem(e, o)).catch(() => { ephemP = null; return false; });
  return ephemP;
}

// ------------------------------------------------------------------ open
export async function openTarget(t) {
  const target = { ra: +t.ra, dec: +t.dec, name: t.name || `${(+t.ra).toFixed(3)} ${(+t.dec).toFixed(3)}`, kind: 'fixed', info: t.info, type: t.type };
  newSession(target);
  setMsg('Finding every SPHEREx image of this spot…');
  try {
    const frames = await framesNear(target.ra, target.dec, 2.47);
    if (S.target !== target) return;
    // frames whose centre is within the inscribed radius are certainly usable
    frames.forEach(f => { f.pri = f.sep < 1.70 ? 0 : 1; });
    S.frames = frames;
    afterFrames();
  } catch (e) {
    setMsg('Could not load the SPHEREx index. ' + (navigator.onLine ? 'Please try again.' : 'You are offline. Saved targets still work.'));
    restoreFromCache();
    console.error(e);
  }
}

export async function openMover(m) {
  // m: {id,name,blurb,track,frames} (Horizons, from movers.json) or {sso: obj}
  const target = { name: m.name, kind: 'mover', moverId: m.id || null, sso: m.sso || null, blurb: m.blurb, ra: 0, dec: 0 };
  newSession(target);
  setMsg(`Computing where ${m.name} was during each SPHEREx exposure…`);
  try {
    let frames = [];
    if (m.track) {
      target.track = m.track;
      frames = m.frames.map(s => {
        const [qr, week, ver, det, ls, ss, t] = s.split('|');
        return { qr, week, ver, det: +det, ls: +ls, ss: +ss, mjd: +t };
      });
      await loadEphem();
      frames.forEach(f => {
        const p = trackPos(m.track, f.mjd);
        // Horizons tracks are geocentric; shift to SPHEREx's own viewpoint (orbital parallax)
        const [ra, dec] = toSpacecraft(p[0], p[1], p[3], f.mjd);
        f.tra = ra; f.tdec = dec; f.tmag = p[2]; f.pri = 0;
      });
    } else {
      frames = await ssoFrames(m.sso);
    }
    if (S.target !== target) return;
    if (!frames.length) { setMsg(`${m.name} has not crossed any SPHEREx image yet, or it is too faint. Try another object.`); return; }
    const mid = frames[Math.floor(frames.length / 2)];
    target.ra = mid.tra; target.dec = mid.tdec;
    S.frames = frames;
    afterFrames();
  } catch (e) {
    console.error(e);
    setMsg('Could not compute this object\'s path: ' + e.message);
  }
}

function trackPos(track, mjd) {
  let lo = 0, hi = track.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (track[mid][0] <= mjd) lo = mid; else hi = mid; }
  const a = track[lo], b = track[hi];
  const u = clamp((mjd - a[0]) / ((b[0] - a[0]) || 1), 0, 1);
  const dra = ((b[1] - a[1] + 540) % 360) - 180;
  const delta = a[5] != null && b[5] != null ? a[5] + (b[5] - a[5]) * u : null;
  return [(a[1] + dra * u + 360) % 360, a[2] + (b[2] - a[2]) * u, a[3], delta];
}

async function ssoFrames(o) {
  const meta = await getJSON('meta.json').catch(() => null);
  const t0 = meta?.spherex?.firstMjd ?? 60790, t1 = meta?.spherex?.lastMjd ?? (Date.now() / 864e5 + 40587);
  const pos = [];
  for (let t = t0; t <= t1 + 1; t += 1) pos.push([t, precise(o, t, [t0, t1])]);
  // tiles along the path, then exact containment per frame
  const seen = new Map();
  const step = Math.max(1, Math.floor(pos.length / 160));
  const tasks = [];
  for (let k = 0; k < pos.length; k += step) {
    const g = pos[k][1];
    tasks.push(framesNear(g.ra, g.dec, 2.6).then(fr => { for (const f of fr) seen.set(frameKey(f), f); }));
  }
  await Promise.all(tasks);
  const out = [];
  await loadEphem();
  const span = [t0, t1];
  for (const f of seen.values()) {
    const g = precise(o, f.mjd, span);
    if (sep(g.ra, g.dec, f.ra, f.dec) < 1.70 && g.mag < 22.5) { f.tra = g.ra; f.tdec = g.dec; f.tmag = g.mag; f.pri = 0; out.push(f); }
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}

function newSession(target) {
  if (S && S.job) cancelJob(S.job);
  stop();
  S = {
    target, frames: [], chosen: [], items: [], bands: new Set(), mode: S?.mode && S.mode !== 'then' ? S.mode : 'movie',
    cur: 0, playing: false, timer: null, job: null, known: [], ap: null, cache: new Map(), comp: new Map(),
    bytes: 0, errors: 0, skipped: 0, hunt: null, zoom: { k: 1, x: 0, y: 0 }, blinkPhase: 0, visits: [], visitsAll: [], phot: [],
  };
  $('#tmEmpty').hidden = true;
  $('#tm').hidden = false;
  $('#tmName').textContent = target.name;
  $('#tmCoords').textContent = target.kind === 'mover' ? (target.blurb || 'Moving target: the view follows it.') : fmtCoord(target.ra, target.dec);
  $('#tmBadges').textContent = '';
  $('#frameGrid').textContent = '';
  $('#huntOut').textContent = '';
  $('#knownList').textContent = '';
  $('#specChart').textContent = ''; $('#lcChart').textContent = '';
  $('#targetInfo').textContent = '';
  $('#frameInfo').textContent = '';
  $('#loadMore').hidden = true;
  setMode(S.mode, true);
  clearCanvas();
  updateSaveBtn();
}

function visitsOf(list) {
  const visits = [];
  for (const f of list) {
    const v = visits[visits.length - 1];
    // deep fields are watched continuously: cut those into ~monthly epochs
    if (v && f.mjd - v.t1 < VISIT_GAP && f.mjd - v.t0 < 30) { v.t1 = f.mjd; v.n++; } else visits.push({ t0: f.mjd, t1: f.mjd, n: 1 });
  }
  return visits;
}

// choose which frames to load: spread across visits and detectors
function chooseFrames(frames, max) {
  const usable = frames.filter(f => f.pri === 0);
  const pool = usable.length >= Math.min(max, 12) ? usable : frames;
  if (pool.length <= max) return pool.slice();
  const visits = visitsOf(pool);
  const byVisit = visits.map(v => pool.filter(f => f.mjd >= v.t0 && f.mjd <= v.t1));
  const per = Math.max(2, Math.floor(max / visits.length));
  let out = [];
  for (const vf of byVisit) {
    const dets = [1, 2, 3, 4, 5, 6].map(d => vf.filter(f => f.det === d)).filter(a => a.length);
    const take = Math.min(vf.length, per);
    const picked = [];
    let k = 0;
    while (picked.length < take) {
      const arr = dets[k % dets.length];
      const round = Math.floor(k / dets.length);
      const n = Math.ceil(take / dets.length);
      const idx = Math.floor((round + 0.5) * arr.length / n);
      if (idx < arr.length && !picked.includes(arr[idx])) picked.push(arr[idx]);
      k++;
      if (k > take * 12) break;
    }
    out.push(...picked);
  }
  if (out.length < max) {
    const rest = pool.filter(f => !out.includes(f));
    const stepN = rest.length / (max - out.length);
    for (let i = 0; out.length < max && i < rest.length; i += Math.max(1, stepN)) out.push(rest[Math.floor(i)]);
  }
  out.sort((a, b) => a.mjd - b.mjd);
  if (out.length > max) {
    const k = out.length / max;
    out = Array.from({ length: max }, (_, i) => out[Math.floor(i * k)]);
  }
  return out;
}

function afterFrames() {
  const all = S.frames;
  if (!all.length) {
    setMsg('SPHEREx has not imaged this exact spot yet (or the index is still catching up). Try a nearby position.');
    return;
  }
  const max = ctx.settings.max;
  S.chosen = chooseFrames(all, max);
  S.visitsAll = visitsOf(all);
  renderBadges();
  renderTargetInfo();
  drawTimeline();
  $('#loadMore').hidden = S.chosen.length >= all.length;
  $('#loadMore').textContent = `Load more images (${fmtInt(all.length - S.chosen.length)} more available)`;
  setMsg(null);
  loadFrames(S.chosen);
}

function renderBadges() {
  const b = $('#tmBadges');
  b.textContent = '';
  const v = S.visitsAll || [];
  const span = S.frames.length ? S.frames[S.frames.length - 1].mjd - S.frames[0].mjd : 0;
  const add = (k, v2) => b.append(h('span', { class: 'badge' }, h('b', { text: v2 }), ' ' + k));
  add('SPHEREx images', fmtInt(S.frames.length));
  add(v.length === 1 ? 'visit' : 'visits', v.length);
  add('days of coverage', Math.round(span));
  if (S.chosen.length < S.frames.length) add('selected to view', fmtInt(S.chosen.length));
}

// ------------------------------------------------------------------ loading
function cacheKey(f, tgt, o) {
  return `${frameKey(f)}|${tgt.ra.toFixed(5)}|${tgt.dec.toFixed(5)}|${o.size}|${o.mask ? 1 : 0}|v2`;
}

async function loadFrames(list) {
  const o = { size: ctx.settings.size, scale: 6.15, mask: ctx.settings.mask, mode: effectiveMode() };
  const sess = S;
  const targets = list.map(f => f.tra != null ? { ra: f.tra, dec: f.tdec } : { ra: sess.target.ra, dec: sess.target.dec });
  sess.pending = list.length;
  sess.total = (sess.total || 0) + list.length;
  progress();
  // 1) offline cache
  const todo = [], todoT = [];
  await Promise.all(list.map(async (f, i) => {
    const c = await store.get('cutouts', cacheKey(f, targets[i], o));
    if (sess !== S) return;
    if (c && c.data) { addItem(f, c, targets[i], true); sess.pending--; } else { todo.push(f); todoT.push(targets[i]); }
  }));
  if (sess !== S) return;
  progress();
  sess.finished = false;
  if (!todo.length) { finishLoading(); return; }
  if (!navigator.onLine) {
    sess.pending = 0; progress();
    toast(`${todo.length} images aren't saved on this device. Connect to the internet to load them.`, 'err');
    finishLoading();
    return;
  }
  // 2) stream from NASA's archive, interleaved across visits so that the
  //    first few images already span the whole timeline
  {
    const vs = visitsOf(todo.map((f, i) => ({ mjd: f.mjd, i })).sort((a, b) => a.mjd - b.mjd));
    const groups = vs.map(v => todo.map((f, i) => i).filter(i => todo[i].mjd >= v.t0 - 1e-6 && todo[i].mjd <= v.t1 + 1e-6));
    const order = [];
    for (let k = 0; order.length < todo.length && k < todo.length; k++) for (const g of groups) if (g[k] != null) order.push(g[k]);
    for (let i = 0; i < todo.length; i++) if (!order.includes(i)) order.push(i);
    const t2 = order.map(i => todo[i]), tt2 = order.map(i => todoT[i]);
    todo.splice(0, todo.length, ...t2); todoT.splice(0, todoT.length, ...tt2);
  }
  const w = getWorker();
  const job = ++jobSeq;
  sess.job = job;
  const seen = new Set();
  const settle = () => { if (sess === S && sess.pending <= 0 && !sess.finished) { sess.finished = true; finishLoading(); } };
  const onFrame = (i, r) => {
    if (sess !== S || seen.has(i)) return;
    seen.add(i);
    sess.pending--;
    if (r) {
      sess.bytes += r.bytes || 0;
      addItem(todo[i], r, todoT[i], false);
      store.put('cutouts', cacheKey(todo[i], todoT[i], o), r);
    } else sess.skipped++;
    progress(); settle();
  };
  const onErr = i => { if (sess !== S || seen.has(i)) return; seen.add(i); sess.pending--; sess.errors++; progress(); settle(); };
  if (w) {
    const handler = ev => {
      const m = ev.data;
      if (m.job !== job) return;
      if (m.type === 'frame') onFrame(m.i, m.r);
      else if (m.type === 'skip') onFrame(m.i, null);
      else if (m.type === 'error') onErr(m.i, m.error);
      else if (m.type === 'end') { w.removeEventListener('message', handler); sess.pending = Math.min(sess.pending, 0); settle(); }
    };
    w.addEventListener('message', handler);
    w.postMessage({ cmd: 'cutouts', job, frames: todo, targets: todoT, opts: o, concurrency: 14 });
  } else {
    // main-thread fallback for browsers without module workers
    const ctl = new AbortController();
    sess.abort = ctl;
    const q = todo.map((f, i) => i);
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (q.length && !ctl.signal.aborted) {
        const i = q.shift();
        try { onFrame(i, await cutoutMain(todo[i], todoT[i], { ...o, mode: o.mode === 'auto' ? (i < 8 ? 'fast' : 'saver') : o.mode }, ctl.signal)); } catch { onErr(i); }
      }
    }));
    settle();
  }
}

function cancelJob(job) {
  if (worker) worker.postMessage({ cmd: 'cancel', job });
  if (S && S.abort) S.abort.abort();
}

function addItem(f, r, tgt, fromCache) {
  const item = { f, r, tgt, cached: fromCache, visit: 0 };
  // insert sorted by time
  const arr = S.items;
  let i = arr.length;
  while (i > 0 && arr[i - 1].r.mjd > r.mjd) i--;
  arr.splice(i, 0, item);
  assignVisits();
  const vis = visible();
  if (vis.length === 1 || (vis.length && !S.shownOnce)) { S.shownOnce = true; S.cur = 0; render(); }
  scheduleUI();
}

let uiTimer = null;
function scheduleUI() {
  if (uiTimer) return;
  uiTimer = setTimeout(() => {
    uiTimer = null;
    if (!S) return;
    updateScrub(); drawTimeline(); renderBandChips(); renderFrameGrid(); populateSelectors();
    if (S.mode !== 'movie' || !S.playing) render();
  }, 250);
}

function assignVisits() {
  S.visits = visitsOf(S.items.map(it => ({ mjd: it.r.mjd })));
  for (const it of S.items) it.visit = S.visits.findIndex(v => it.r.mjd >= v.t0 - 1e-6 && it.r.mjd <= v.t1 + 1e-6);
  S.comp.clear();
}

function finishLoading() {
  if (!S) return;
  S.pending = 0;
  progress();
  scheduleUI();
  if (!S.items.length) {
    setMsg(S.errors ? 'Could not reach NASA\'s SPHEREx archive. Check your connection and try again.' : 'This position falls in gaps between SPHEREx detectors in the loaded images. Try nearby coordinates or load more images.');
  }
  updateSaveBtn();
  if ($('#optKnown').checked) computeKnown();
  measureAll();
  if (ctx.settings.autoplay && S.mode === 'movie' && visible().length > 2 && !S.playing && !ctx.settings.reduceMotion) play();
}

function progress() {
  const p = $('#progress');
  const total = S.total || 0, left = S.pending || 0;
  if (!left) { p.hidden = true; } else {
    p.hidden = false;
    const done = total - left;
    p.firstElementChild.style.width = `${(100 * done / Math.max(1, total)).toFixed(1)}%`;
    p.lastElementChild.textContent = `Loading SPHEREx images ${done}/${total} · ${fmtBytes(S.bytes)}`;
  }
  renderLoadNote();
}

function renderLoadNote() {
  const n = $('#loadNote');
  n.textContent = `${S.items.length} images loaded` + (S.skipped ? ` · ${S.skipped} skipped (the target fell just outside those images' edges)` : '') +
    (S.errors ? ` · ${S.errors} failed` : '') + ` · ${fmtBytes(S.bytes)} downloaded from NASA's archive`;
}

async function restoreFromCache() {
  const saved = await store.get('saved', savedKey());
  if (saved && saved.frames) { S.frames = saved.frames; afterFrames(); }
}

// ------------------------------------------------------------------ views
const visible = () => S ? S.items.filter(it => !S.bands.size || S.bands.has(it.f.det)) : [];

function derived(it) {
  let d = S.cache.get(it);
  const bg = $('#optBg').checked;
  if (!d || d.bg !== bg) {
    const base = bg ? R.subtractBackground(it.r.data, it.r.size, Math.max(20, it.r.size / 3)) : it.r.data;
    d = { bg, base, fill: R.fillHoles(base, it.r.size, 24) };
    S.cache.set(it, d);
  }
  return d;
}

function composite(key, items) {
  if (S.comp.has(key)) return S.comp.get(key);
  if (!items.length) return null;
  const size = items[0].r.size;
  // normalise each frame by its robust noise so different wavelengths mix fairly
  const arrs = items.map(it => {
    const d = derived(it).base;
    const { sig } = R.robustStats(d);
    const a = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) a[i] = d[i] / sig;
    return a;
  });
  const c = R.fillHoles(R.medianStack(arrs, size), size);
  S.comp.set(key, c);
  return c;
}

function visitItems(v) { return visible().filter(it => it.visit === v); }
function visitLabel(v) {
  const vv = S.visits[v];
  if (!vv) return '';
  const a = fmtShortDate(vv.t0), b = fmtShortDate(vv.t1);
  return `Visit ${v + 1}: ${a === b ? a : a + ' – ' + b} (${visitItems(v).length} img)`;
}

function populateSelectors() {
  const A = $('#selA'), B = $('#selB');
  const keepA = A.value, keepB = B.value;
  A.textContent = ''; B.textContent = '';
  const vis = visible();
  if (S.mode === 'then') {
    for (const s of REF_SURVEYS) A.append(h('option', { value: s.id, text: s.label }));
    B.append(h('option', { value: 'match', text: 'SPHEREx at the matching wavelength (stacked)' }));
    B.append(h('option', { value: 'all', text: 'SPHEREx: all images stacked' }));
    S.visits.forEach((v, i) => { if (visitItems(i).length) B.append(h('option', { value: 'v' + i, text: 'SPHEREx ' + visitLabel(i) })); });
  } else if (S.mode === 'color') {
    S.visits.forEach((v, i) => A.append(h('option', { value: 'v' + i, text: visitLabel(i).replace(/\(\d+ img\)/, '') })));
    A.append(h('option', { value: 'all', text: 'All visits combined' }));
  } else {
    S.visits.forEach((v, i) => { if (visitItems(i).length) { A.append(h('option', { value: 'v' + i, text: visitLabel(i) })); B.append(h('option', { value: 'v' + i, text: visitLabel(i) })); } });
    if (vis.length <= 60) vis.forEach((it, i) => {
      const lab = `${fmtDate(it.r.mjd, true)} · ${it.r.wave.toFixed(2)} µm`;
      A.append(h('option', { value: 'f' + i, text: lab })); B.append(h('option', { value: 'f' + i, text: lab }));
    });
  }
  const opts = s => [...s.options].map(o => o.value);
  if (opts(A).includes(keepA) && S.selTouched) A.value = keepA;
  if (opts(B).includes(keepB) && S.selTouched) B.value = keepB;
  else if (S.mode !== 'then' && S.mode !== 'color' && B.options.length) {
    // default B = last visit
    const vs = opts(B).filter(v => v[0] === 'v');
    B.value = vs[vs.length - 1] || B.options[B.options.length - 1].value;
  }
  $('#blinkPick').hidden = !['blink', 'diff', 'color', 'then'].includes(S.mode);
  B.parentElement.hidden = S.mode === 'color';
  $('#swipeMode').parentElement.hidden = !['blink'].includes(S.mode);
}

function selImage(val) {
  if (!val) return null;
  if (val === 'all') return { data: composite('all|' + [...S.bands].join(), visible()), label: 'All images stacked', mjd: null };
  if (val[0] === 'v') {
    const v = +val.slice(1);
    return { data: composite('v' + v + '|' + [...S.bands].join(), visitItems(v)), label: visitLabel(v), mjd: (S.visits[v].t0 + S.visits[v].t1) / 2 };
  }
  const it = visible()[+val.slice(1)];
  if (!it) return null;
  const d = derived(it).fill;
  const { sig } = R.robustStats(d);
  return { data: d.map(x => x / sig), label: `${fmtDate(it.r.mjd, true)} · ${it.r.wave.toFixed(2)} µm`, mjd: it.r.mjd, item: it };
}

function size() { return S.items[0]?.r.size || ctx.settings.size; }

function clearCanvas() {
  const cv = $('#cv');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  ['#hudTL', '#hudTR', '#hudBL', '#hudBR'].forEach(s => { $(s).textContent = ''; });
  drawOverlay(null);
}

function setMsg(m) {
  const el = $('#stageMsg');
  if (!m) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = m;
}

let lastRenderToken = 0;
export function render() {
  if (!S) return;
  const token = ++lastRenderToken;
  void token;
  const vis = visible();
  const N = size();
  const cv = $('#cv'), cv2 = $('#cv2'), ref = $('#refImg');
  const smooth = $('#optSmooth').checked, F = smooth ? 4 : 1, M = N * F;
  cv.width = cv.height = M; cv2.width = cv2.height = M;
  const c = cv.getContext('2d'), c2 = cv2.getContext('2d');
  const up = d => (F > 1 ? R.upsample(d, N, F) : d);
  const stretch = $('#optStretch').value, cmap = $('#optCmap').value;
  const swipe = $('#swipe');
  cv2.hidden = true; ref.hidden = true; swipe.hidden = true;
  $('#stage').classList.toggle('smooth', smooth);
  if (!vis.length) {
    if (S.items.length) setMsg('No images in the selected bands yet. Choose another band.');
    clearCanvas();
    return;
  }
  setMsg(null);
  const hud = (tl, tr, bl, br) => { $('#hudTL').textContent = tl || ''; $('#hudTR').textContent = tr || ''; $('#hudBL').textContent = bl || ''; $('#hudBR').textContent = br || ''; };
  const drawMono = (ctx2, data, lv) => {
    const l = lv || R.levels(data, 'sky', [1.5, 99.8]);
    R.paint(ctx2, M, R.scaleTo8(up(data), { lo: l.lo, hi: l.hi, stretch }), cmap);
  };
  const scaleBar = `${(N * 6.15 / 60).toFixed(1)}′ across`;

  if (S.mode === 'movie') {
    S.cur = clamp(S.cur, 0, vis.length - 1);
    const it = vis[S.cur];
    drawMono(c, derived(it).fill);
    const b = BANDS[it.f.det];
    hud(`${fmtShortDate(it.r.mjd)}`, `${it.r.wave.toFixed(3)} µm · band ${it.f.det}`, `${S.cur + 1} / ${vis.length} · ${S.visits.length > 1 ? 'visit ' + (it.visit + 1) : ''}`, scaleBar);
    $('#hudTL').classList.add('big');
    void b;
    renderFrameInfo(it);
    drawOverlay(it);
    $('#pScrub').value = S.cur;
    highlightFrameGrid();
    drawTimelineCursor(it.r.mjd);
    return;
  }
  const A = selImage($('#selA').value), B = selImage($('#selB').value);
  if (S.mode === 'blink') {
    if (!A || !B) return;
    const swipeOn = $('#swipeMode').checked;
    if (swipeOn) {
      drawMono(c, A.data); drawMono(c2, B.data);
      cv2.hidden = false; swipe.hidden = false;
      hud('A: ' + A.label, 'B: ' + B.label, 'Drag the slider to compare', scaleBar);
    } else {
      const show = S.blinkPhase ? B : A;
      drawMono(c, show.data);
      hud((S.blinkPhase ? 'B: ' : 'A: ') + show.label, 'Blink comparator', 'Moving things jump between A and B', scaleBar);
    }
    drawOverlay(null, { mjd: (S.blinkPhase ? B : A).mjd });
  } else if (S.mode === 'diff') {
    if (!A || !B) return;
    let d = new Float32Array(N * N);
    const va = $('#selA').value, vb = $('#selB').value;
    if (va[0] === 'v' && vb[0] === 'v') {
      // wavelength-matched: difference each detector band separately, then
      // take the median across bands so colour differences cancel out
      const ia = +va.slice(1), ib = +vb.slice(1);
      const diffs = [];
      for (let det = 1; det <= 6; det++) {
        if (S.bands.size && !S.bands.has(det)) continue;
        const a0 = S.items.filter(it => it.visit === ia && it.f.det === det), b0 = S.items.filter(it => it.visit === ib && it.f.det === det);
        if (!a0.length || !b0.length) continue;
        const ca = composite(`cv${ia}|d${det}`, a0), cb = composite(`cv${ib}|d${det}`, b0);
        const dd = new Float32Array(N * N);
        for (let i = 0; i < dd.length; i++) dd[i] = cb[i] - ca[i];
        diffs.push(dd);
      }
      if (diffs.length) d = diffs.length === 1 ? diffs[0] : R.medianStack(diffs, N);
      else for (let i = 0; i < d.length; i++) d[i] = B.data[i] - A.data[i];
    } else for (let i = 0; i < d.length; i++) d[i] = B.data[i] - A.data[i];
    const { sig } = R.robustStats(d);
    R.paintDiverging(c, M, up(d), 7 * sig);
    S.diff = d;
    hud('B − A difference', 'orange = brighter in B · blue = brighter in A', `A: ${A.label}`, `B: ${B.label}`);
    drawOverlay(null, { diff: true });
  } else if (S.mode === 'color') {
    const v = $('#selA').value;
    const items = v === 'all' ? S.items : S.items.filter(it => it.visit === +v.slice(1));
    const ch = dets => composite(`rgb${v}|${dets}`, items.filter(it => dets.includes(it.f.det)));
    const bl = ch([1, 2]) || ch([1, 2, 3]), gr = ch([3, 4]) || ch([2, 3, 4]), rd = ch([5, 6]) || ch([4, 5, 6]);
    const chans = [rd, gr, bl].map(x => x || bl || gr || rd);
    if (!chans[0]) return;
    const to8 = d => { const l = R.levels(d, 'sky', [2, 99.7]); return R.scaleTo8(up(d), { lo: l.lo, hi: l.hi, stretch }); };
    R.paintRGB(c, M, to8(chans[0]), to8(chans[1]), to8(chans[2]));
    hud('False colour infrared', 'blue 0.75–1.6 µm · green 1.6–3.8 µm · red 3.8–5 µm', v === 'all' ? 'All visits' : visitLabel(+v.slice(1)), scaleBar);
    drawOverlay(null, {});
  } else if (S.mode === 'then') {
    const sv = REF_SURVEYS.find(x => x.id === $('#selA').value) || REF_SURVEYS[0];
    const bv = $('#selB').value || 'match';
    let Bv, label;
    if (bv === 'match') {
      const its = S.items.filter(it => sv.dets.includes(it.f.det));
      const use = its.length ? its : S.items;
      const ws = use.map(it => it.r.wave).sort((a, b) => a - b);
      Bv = { data: composite('match|' + sv.id, use) };
      label = `SPHEREx ${ws[0].toFixed(1)}–${ws[ws.length - 1].toFixed(1)} µm`;
    } else { Bv = selImage(bv); label = 'SPHEREx ' + (Bv ? Bv.label.replace(/\s*\(\d+ img\)/, '') : ''); }
    if (Bv) drawMono(c, Bv.data, R.levels(Bv.data, 'sky', [25, 99.6]));
    const tg = S.target.kind === 'mover' ? S.items[0].tgt : S.target;
    const first = S.items.reduce((a, it) => Math.min(a, it.r.mjd), 1e9), last = S.items.reduce((a, it) => Math.max(a, it.r.mjd), 0);
    hud(`◀ ${label} (${mjdToDate(first).getUTCFullYear()}${mjdToDate(last).getUTCFullYear() !== mjdToDate(first).getUTCFullYear() ? '–' + String(mjdToDate(last).getUTCFullYear()).slice(2) : ''})`, `${sv.short} (${sv.years}) ▶`, 'Drag the slider to compare then and now', scaleBar);
    swipe.hidden = false;
    const token = (S.refToken = (S.refToken || 0) + 1);
    refImage(sv, tg, N).then(ref => {
      if (!S || S.mode !== 'then' || S.refToken !== token) return;
      let d = $('#optBg').checked ? R.subtractBackground(ref, N, Math.max(20, N / 3)) : ref;
      d = R.fillHoles(d, N);
      drawMono(cv2.getContext('2d'), d, R.levels(d, 'sky', [25, 99.6]));
      cv2.hidden = false;
    }).catch(() => { if (S && S.mode === 'then') toast('Reference survey image unavailable right now (needs internet).', 'err'); });
    drawOverlay(null, {});
  }
  renderFrameInfo(null);
}

function renderFrameInfo(it) {
  const box = $('#frameInfo');
  box.textContent = '';
  if (!it) return;
  const f = it.f, r = it.r;
  const row = (k, v, link) => box.append(h('span', { class: 'k', text: k }), link ? h('a', { class: 'v', href: link, target: '_blank', rel: 'noopener', text: v }) : h('span', { class: 'v', text: v }));
  row('Observed', fmtDate(r.mjd, true));
  row('Wavelength', `${r.wave.toFixed(3)} µm${r.dwave ? ` (±${(r.dwave / 2).toFixed(3)})` : ''}`);
  row('Detector band', `${f.det} · ${BANDS[f.det].lo}–${BANDS[f.det].hi} µm · R≈${BANDS[f.det].R}`);
  row('Observation ID', `${obsId(f)} D${f.det}`);
  row('Data release', `${f.qr.toUpperCase()} · ${f.ver}`);
  if (r.exptime) row('Exposure', `${(+r.exptime).toFixed(0)} s`);
  if (r.psf) row('Sharpness (PSF)', `${(+r.psf).toFixed(1)}″ FWHM`);
  row('Pixel in frame', `x ${r.x.toFixed(1)}, y ${r.y.toFixed(1)}`);
  if (it.tgt && S.target.kind === 'mover') row('Object position', `${it.tgt.ra.toFixed(4)}°, ${it.tgt.dec.toFixed(4)}°`);
  row('Full image', 'Download FITS (≈70 MB) from NASA', S3 + frameKey(f));
  row('Source', it.cached ? 'This device (offline copy)' : 'NASA IRSA archive (live)');
}

async function renderTargetInfo() {
  const box = $('#targetInfo');
  box.textContent = '';
  const t = S.target;
  const add = el => box.append(el);
  if (t.kind === 'fixed') {
    add(h('h3', { text: 'About this spot' }));
    add(h('p', { class: 'small' }, fmtCoord(t.ra, t.dec), h('br'), 'Galactic: ' + galStr(t.ra, t.dec)));
    if (t.info) add(h('p', { class: 'small', text: t.info }));
    if (t.type) add(h('p', { class: 'small muted', text: 'Type (SIMBAD): ' + t.type }));
    try {
      const ex = await getJSON('exoplanets.json');
      const near = ex.data.filter(e => sep(e[1], e[2], t.ra, t.dec) < size() * 6.15 / 3600 * 0.7)
        .sort((a, b) => sep(a[1], a[2], t.ra, t.dec) - sep(b[1], b[2], t.ra, t.dec)).slice(0, 5);
      if (near.length && S.target === t) {
        add(h('h3', { text: 'Known exoplanet systems in view' }));
        for (const e of near) {
          add(h('div', { class: 'item' }, h('div', { class: 'grow' }, h('b', { text: `${e[0]} · ${e[4]} planet${e[4] > 1 ? 's' : ''}` }),
            h('span', { class: 't', text: `${e[3] ? (e[3] * 3.2616).toFixed(0) + ' light-years · ' : ''}${e[6] || ''} ${e[7].slice(0, 4).join(', ')}` })),
          h('a', { class: 'btn sm', href: `https://exoplanetarchive.ipac.caltech.edu/overview/${encodeURIComponent(e[0])}`, target: '_blank', rel: 'noopener', text: 'NASA archive' })));
        }
        S.exoNear = near;
        drawOverlay(currentItem());
      }
    } catch { /* offline */ }
  } else {
    add(h('h3', { text: 'About this object' }));
    if (t.blurb) add(h('p', { class: 'small', text: t.blurb }));
    const name = t.sso ? t.sso.name : t.name;
    add(h('p', {}, h('a', { class: 'btn sm', href: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(name.replace(/\s*\(.*\)$/, '').trim())}`, target: '_blank', rel: 'noopener', text: 'Orbit & facts at NASA/JPL' })));
    add(h('p', { class: 'small muted', text: 'The images are re-centred on the object\'s predicted position (NASA/JPL ' + (t.track ? 'Horizons ephemeris' : 'orbit') + '), so the object stays put while the stars stream past.' }));
  }
}

const currentItem = () => (S && S.mode === 'movie') ? visible()[S.cur] : null;

// ------------------------------------------------------------------ overlay
function drawOverlay(it, extra = {}) {
  const ov = $('#ov');
  const rect = ov.getBoundingClientRect();
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  ov.width = Math.max(1, Math.round(rect.width * dpr)); ov.height = Math.max(1, Math.round(rect.height * dpr));
  const g = ov.getContext('2d');
  g.clearRect(0, 0, ov.width, ov.height);
  if (!S || !S.items.length) return;
  const N = size(), k = ov.width / N;
  const P = (x, y) => [(x + 0.5) * k, (y + 0.5) * k];
  g.lineWidth = 1.5 * dpr;
  g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
  // aperture / crosshair
  const ap = S.ap || { x: (N - 1) / 2, y: (N - 1) / 2 };
  const [ax, ay] = P(ap.x, ap.y);
  g.strokeStyle = 'rgba(102,217,255,.95)';
  g.beginPath(); g.arc(ax, ay, 2.2 * k, 0, 7); g.stroke();
  if ($('#optGrid').checked) {
    g.setLineDash([4 * dpr, 4 * dpr]);
    g.beginPath(); g.arc(ax, ay, 5 * k, 0, 7); g.arc(ax, ay, 8 * k, 0, 7); g.stroke();
    g.setLineDash([]);
    g.strokeStyle = 'rgba(255,255,255,.45)';
    g.beginPath(); g.moveTo(ax, 0); g.lineTo(ax, ay - 4 * k); g.moveTo(ax, ay + 4 * k); g.lineTo(ax, ov.height);
    g.moveTo(0, ay); g.lineTo(ax - 4 * k, ay); g.moveTo(ax + 4 * k, ay); g.lineTo(ov.width, ay); g.stroke();
    // 1 arcmin scale bar + compass
    const L = 60 / 6.15 * k;
    g.strokeStyle = '#fff'; g.fillStyle = '#fff';
    g.beginPath(); g.moveTo(ov.width - L - 14 * dpr, ov.height - 34 * dpr); g.lineTo(ov.width - 14 * dpr, ov.height - 34 * dpr); g.stroke();
    g.fillText('1′', ov.width - L / 2 - 18 * dpr, ov.height - 40 * dpr);
    const cx = 34 * dpr, cy = ov.height - 60 * dpr, cl = 22 * dpr;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy - cl); g.moveTo(cx, cy); g.lineTo(cx - cl, cy); g.stroke();
    g.fillText('N', cx - 4 * dpr, cy - cl - 4 * dpr); g.fillText('E', cx - cl - 12 * dpr, cy + 4 * dpr);
  }
  const tgt = it ? it.tgt : (S.items[0] && S.target.kind === 'fixed' ? S.target : null);
  const project = (ra, dec, center) => {
    const c = center || tgt;
    if (!c) return null;
    const p = skyToTan(ra, dec, c.ra * D2R, Math.sin(c.dec * D2R), Math.cos(c.dec * D2R));
    if (!p) return null;
    const s = 6.15 / 3600 * D2R, half = N / 2;
    return [half - p[0] / s - 0.5, half - p[1] / s - 0.5];
  };
  // known solar system objects at this epoch
  if ($('#optKnown').checked && S.known.length && it) {
    for (const kobj of S.known) {
      const pt = kobj.pts.find(p => Math.abs(p.mjd - it.r.mjd) < 1e-4);
      if (!pt) continue;
      const q = project(pt.ra, pt.dec);
      if (!q || q[0] < -2 || q[1] < -2 || q[0] > N + 2 || q[1] > N + 2) continue;
      const [x, y] = P(q[0], q[1]);
      g.strokeStyle = 'rgba(94,230,160,.95)'; g.fillStyle = 'rgba(94,230,160,.95)';
      g.beginPath(); g.arc(x, y, Math.max(7 * dpr, kobj.unc * k), 0, 7); g.stroke();
      g.fillText(kobj.short, x + 8 * dpr, y - 8 * dpr);
    }
  }
  // exoplanet hosts
  if (S.exoNear && tgt && S.target.kind === 'fixed') {
    g.strokeStyle = 'rgba(255,211,77,.85)'; g.fillStyle = 'rgba(255,211,77,.9)';
    for (const e of S.exoNear) {
      const q = project(e[1], e[2]);
      if (!q) continue;
      const [x, y] = P(q[0], q[1]);
      g.beginPath(); g.rect(x - 6 * dpr, y - 6 * dpr, 12 * dpr, 12 * dpr); g.stroke();
      g.fillText('🪐 ' + e[0], x + 9 * dpr, y + 14 * dpr);
    }
  }
  // hunt results
  if (S.hunt) {
    for (const d of S.hunt.list) {
      if (d.conf === 'low' && !S.hunt.showLow) continue;
      if (it && d.mjd != null && Math.abs(d.mjd - it.r.mjd) > 1e-4 && d.kind !== 'change') continue;
      if (!it && !extra.diff && d.kind !== 'change') continue;
      const [x, y] = P(d.x, d.y);
      g.strokeStyle = d.known ? 'rgba(94,230,160,.95)' : d.kind === 'change' ? 'rgba(102,217,255,.95)' : 'rgba(255,179,71,1)';
      g.lineWidth = (d === S.hunt.sel ? 3 : 1.6) * dpr;
      g.beginPath(); g.rect(x - 7 * dpr, y - 7 * dpr, 14 * dpr, 14 * dpr); g.stroke();
    }
    g.lineWidth = 1.5 * dpr;
  }
  // moving target track (mover mode)
  if (S.target.kind === 'mover' && it) {
    g.fillStyle = 'rgba(255,179,71,.9)';
    g.fillText(S.target.name, ax + 2.6 * k + 4, ay - 2.6 * k);
  }
}

// ------------------------------------------------------------------ known objects
async function computeKnown() {
  if (!S || !S.items.length) return;
  const sess = S;
  const list = $('#knownList');
  list.textContent = '';
  list.append(h('div', { class: 'skeleton' }));
  try {
    if (!ssoCache) ssoCache = unpack(await getJSON('sso.json'));
    await loadEphem();
    let movers = [];
    try { movers = (await getJSON('movers.json')).movers; } catch { /* optional */ }
    if (sess !== S) return;
    const N = size();
    const rad = N * 6.15 / 3600 * 0.75;
    const out = [];
    // fixed field: one centre; mover mode: per-frame centre, so evaluate per item
    const groups = S.target.kind === 'fixed' ? [{ c: S.target, items: S.items }] : S.items.map(it => ({ c: it.tgt, items: [it] }));
    const merged = new Map();
    for (const gp of groups) {
      const mjds = gp.items.map(it => it.r.mjd);
      for (const k of objectsInFieldPrecise(ssoCache, gp.c.ra, gp.c.dec, rad, mjds, 21)) {
        const key = k.obj.name;
        if (S.target.sso && key === S.target.sso.name) continue;
        const e = merged.get(key) || { obj: k.obj, pts: [] };
        e.pts.push(...k.pts);
        merged.set(key, e);
      }
      // Horizons movers (planets & featured objects)
      for (const m of movers) {
        if (S.target.moverId === m.id) continue;
        for (const t of mjds) {
          if (t < m.track[0][0] || t > m.track[m.track.length - 1][0]) continue;
          const p = trackPos(m.track, t);
          const [pra, pdec] = toSpacecraft(p[0], p[1], p[3], t);
          if (sep(pra, pdec, gp.c.ra, gp.c.dec) < rad) {
            const e = merged.get(m.name) || { obj: { name: m.name, kind: 'h' }, pts: [], exact: true };
            e.pts.push({ mjd: t, ra: pra, dec: pdec, mag: p[2] });
            merged.set(m.name, e);
          }
        }
      }
    }
    // keep only epochs where the object actually falls inside the square image
    const byMjd = new Map(S.items.map(it => [it.r.mjd.toFixed(5), it]));
    for (const e of merged.values()) {
      e.pts = e.pts.filter(pt => {
        const it = byMjd.get(pt.mjd.toFixed(5));
        const c = it ? it.tgt : S.target;
        const pr = skyToTan(pt.ra, pt.dec, c.ra * D2R, Math.sin(c.dec * D2R), Math.cos(c.dec * D2R));
        if (!pr) return false;
        const s2 = 6.15 / 3600 * D2R, x = N / 2 - pr[0] / s2, y = N / 2 - pr[1] / s2;
        return x >= -1 && y >= -1 && x <= N + 1 && y <= N + 1;
      });
    }
    for (const [k, e] of merged) if (!e.pts.length) merged.delete(k);
    const exactNames = new Set([...merged.values()].filter(e => e.exact).map(e => e.obj.name.toLowerCase()));
    for (const [k, e] of merged) {
      const short = e.obj.name.replace(/^\s*\d+\s+/, '').replace(/\s*\(.*\)$/, '').toLowerCase();
      if (!e.exact && exactNames.has(short)) merged.delete(k);
    }
    const self = S.target.kind === 'mover' ? S.target.name.toLowerCase() : null;
    for (const e of merged.values()) {
      const short = e.obj.name.replace(/^\s*\d+\s+/, '').replace(/\s*\(.*\)$/, '') || e.obj.name;
      if (self && (short.toLowerCase() === self || e.obj.name.toLowerCase().includes(self))) continue;
      if (self) {
        // same object under another designation (e.g. 3I/ATLAS = C/2025 N1): it sits at the tracked centre
        const offs = e.pts.map(pt => { const it = S.items.find(x => Math.abs(x.r.mjd - pt.mjd) < 1e-4); return it ? sep(pt.ra, pt.dec, it.tgt.ra, it.tgt.dec) * 60 : 99; });
        offs.sort((a, b) => a - b);
        if (offs.length && offs[Math.floor(offs.length / 2)] < 3) continue;
      }
      // uncertainty radius in pixels: Horizons ~1", N-body asteroids ~3", comets ~10"
      const unc = e.exact ? 0.5 : (e.precise || e.pts[0]?.precise) ? (e.obj.kind === 'c' ? 2.5 : 0.8) : 12;
      out.push({ ...e, short, unc });
    }
    out.sort((a, b) => Math.min(...a.pts.map(p => p.mag ?? 30)) - Math.min(...b.pts.map(p => p.mag ?? 30)));
    S.known = out;
    list.textContent = '';
    if (!out.length) list.append(h('p', { class: 'muted small', text: 'No catalogued asteroids or comets brighter than magnitude 21 crossed this view in the loaded images.' }));
    for (const k of out.slice(0, 60)) {
      const best = k.pts.reduce((a, b) => ((a.mag ?? 99) < (b.mag ?? 99) ? a : b));
      list.append(h('div', { class: 'item' },
        h('div', { class: 'grow' }, h('b', { text: k.short }),
          h('span', { class: 't', text: `${k.obj.kind === 'c' ? 'Comet' : k.obj.kind === 'h' ? 'Solar-system body' : 'Asteroid'} · in ${k.pts.length} image${k.pts.length > 1 ? 's' : ''}${best.mag != null ? ` · mag ≈${best.mag.toFixed(1)}` : ''}` })),
        h('button', { class: 'btn sm', type: 'button', text: 'Show', onclick: () => jumpToMjd(best.mjd) })));
    }
    drawOverlay(currentItem());
  } catch (e) {
    list.textContent = '';
    list.append(h('p', { class: 'muted small', text: 'Known-object catalogue unavailable offline until it has been loaded once.' }));
    console.warn(e);
  }
}

function jumpToMjd(mjd) {
  setMode('movie');
  const vis = visible();
  let best = 0;
  vis.forEach((it, i) => { if (Math.abs(it.r.mjd - mjd) < Math.abs(vis[best].r.mjd - mjd)) best = i; });
  S.cur = best; stop(); render();
}

// ------------------------------------------------------------------ measure
function measureAll() {
  if (!S || !S.items.length) return;
  const N = size();
  const ap = S.ap || { x: (N - 1) / 2, y: (N - 1) / 2 };
  const vis = visible();
  S.phot = vis.map(it => ({ it, m: R.aperture(it.r.data, N, ap.x, ap.y, 6.15) })).filter(p => p.m);
  const vc = v => VISIT_COLORS[v % VISIT_COLORS.length];
  const visitsSeen = [...new Set(S.phot.map(p => p.it.visit))];
  const series = visitsSeen.map(v => ({
    name: 'Visit ' + (v + 1), color: vc(v),
    points: S.phot.filter(p => p.it.visit === v).map(p => ({ x: p.it.r.wave, y: p.m.uJy / 1000, err: p.m.err / 1000, it: p.it, label: `${p.it.r.wave.toFixed(3)} µm · ${(p.m.uJy / 1000).toFixed(3)} mJy · ${fmtDate(p.it.r.mjd)}` })),
  }));
  const jump = p => { const i = visible().indexOf(p.it); if (i >= 0) { setMode('movie'); S.cur = i; stop(); render(); } };
  chart($('#specChart'), {
    series, xlabel: 'Wavelength (µm)', ylabel: 'Brightness (mJy)', xfmt: v => (+v).toFixed(1), yfmt: v => fmtNum(v),
    markers: LINES, onPoint: jump,
    bands: [1, 2, 3, 4, 5, 6].map(d => ({ x0: BANDS[d].lo, x1: BANDS[d].hi, color: d % 2 ? '#66d9ff' : '#ffb347' })),
  });
  chart($('#lcChart'), {
    series: [{ name: 'flux', color: '#fff', points: S.phot.map(p => ({ x: p.it.r.mjd, y: p.m.uJy / 1000, err: p.m.err / 1000, c: waveColor(p.it.r.wave), it: p.it, label: `${fmtDate(p.it.r.mjd, true)} · ${p.it.r.wave.toFixed(2)} µm · ${(p.m.uJy / 1000).toFixed(3)} mJy` })) }],
    xlabel: 'Date', ylabel: 'Brightness (mJy)', xTime: true, xfmt: v => mjdToDate(v).toISOString().slice(0, 7), yfmt: v => fmtNum(v), onPoint: jump,
  });
  // variability: compare visits at matching wavelengths
  const st = $('#measureStats');
  st.textContent = '';
  if (!S.phot.length && vis.length) {
    st.append(h('b', { class: 'warn', text: 'No clean measurement at the crosshair. ' }), 'The source there is either too bright for SPHEREx (its detector saturates on the brightest stars) or falls on masked pixels. Tap a fainter star in the image to measure it instead.');
  }
  if (S.phot.length) {
    const best = S.phot.reduce((a, b) => (b.m.uJy > a.m.uJy ? b : a));
    st.append(`${S.phot.length} measurements. Brightest: ${(best.m.uJy / 1000).toFixed(3)} mJy (AB ${best.m.ab ? best.m.ab.toFixed(2) : '—'}) at ${best.it.r.wave.toFixed(2)} µm. `);
    const vchk = variability();
    if (vchk) st.append(h('b', { class: vchk.sig > 4 ? 'warn' : '', text: vchk.text }));
    st.append(h('br'), 'Colour of dots in the light curve = wavelength (blue → red). Approximate photometry for exploration; not a substitute for a science pipeline.');
  }
}
const fmtNum = v => Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(2);

function variability() {
  // pair measurements from different visits within 0.03 um
  if (!S.phot || S.visits.length < 2) return null;
  const diffs = [];
  for (const a of S.phot) for (const b of S.phot) {
    if (b.it.visit <= a.it.visit || Math.abs(a.it.r.wave - b.it.r.wave) > 0.03) continue;
    const e = Math.hypot(a.m.err, b.m.err) || 1;
    diffs.push((b.m.uJy - a.m.uJy) / e);
  }
  if (diffs.length < 2) return null;
  diffs.sort((x, y) => x - y);
  const med = diffs[diffs.length >> 1];
  const sig = Math.abs(med);
  return { sig, text: sig > 4 ? `Brightness changed between visits (≈${sig.toFixed(1)}σ). Possible variable source!` : `No significant change between visits (${sig.toFixed(1)}σ).` };
}

// ------------------------------------------------------------------ hunt
async function hunt() {
  if (!S || S.items.length < 3) { toast('Load at least 3 images first.'); return; }
  const btn = $('#huntBtn');
  btn.disabled = true; btn.lastChild.textContent = ' Scanning…';
  await new Promise(r => setTimeout(r, 30));
  const N = size();
  const vis = visible();
  const list = [];
  const norm = it => { const d = derived(it).base; const { med, sig } = R.robustStats(d); return d.map(x => (x - med) / sig); };
  const normed = new Map(vis.map(it => [it, norm(it)]));
  // 1) "new source" search: compare each image with the median of the SAME
  //    detector band (similar wavelength) from other times.  A real mover is a
  //    point source where the reference shows only sky.
  const byDet = new Map();
  vis.forEach(it => { if (!byDet.has(it.f.det)) byDet.set(it.f.det, []); byDet.get(it.f.det).push(it); });
  const allMed = vis.length >= 3 ? R.medianStack(vis.map(it => normed.get(it)), N) : null;
  for (const [, items] of byDet) {
    for (const it of items) {
      const others = items.filter(o => o !== it && Math.abs(o.r.mjd - it.r.mjd) > 0.05);
      const refArr = others.length >= 2 ? R.medianStack(others.map(o => normed.get(o)), N) : allMed;
      if (!refArr) continue;
      const a = normed.get(it), res = new Float32Array(N * N);
      for (let i = 0; i < res.length; i++) res[i] = a[i] - refArr[i];
      const { sig: rs } = R.robustStats(res);
      for (const p of R.findPeaks(res, N, 8, 10, 5)) {
        const k = Math.round(p.y) * N + Math.round(p.x);
        const v = a[k], ref = refArr[k];
        // must be a clear point source here, essentially absent in the reference
        if (!(v > 8) || !(ref < 0.25 * v) || !(res[k] > 8 * rs)) continue;
        // reject the halos, ghosts and saturation of bright stars
        let refMax = 0;
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const q = refArr[k + dy * N + dx]; if (q > refMax) refMax = q; }
        if (refMax > 40 || p.snr > 400) continue;
        // no masked/blank pixels nearby (detector edges, bad pixels)
        let holes = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!Number.isFinite(it.r.data[k + dy * N + dx])) holes++;
        if (holes) continue;
        // compactness: a real (point-like) source puts most residual light in the
        // central 3x3 pixels; nebular structure and smeared artefacts do not
        let c3 = 0, c7 = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const q = res[k + dy * N + dx];
          if (!(q > 0)) continue;
          c7 += q; if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) c3 += q;
        }
        const comp = c7 > 0 ? c3 / c7 : 0;
        if (comp < 0.45) continue;
        list.push({ kind: 'mover', x: p.x, y: p.y, snr: p.snr, mjd: it.r.mjd, it, wave: it.r.wave, comp });
      }
    }
  }
  // 2) link detections into straight-line tracklets (same visit, distinct times)
  const tracks = [];
  const det = list.filter(d => d.comp >= 0.55 && d.snr >= 9).sort((a, b) => a.mjd - b.mjd);
  const used = new Set();
  for (let i = 0; i < det.length && tracks.length < 25; i++) for (let j = i + 1; j < det.length; j++) {
    const a = det[i], b = det[j], dt = b.mjd - a.mjd;
    if (dt < 0.02 || dt > 3 || a.it.visit !== b.it.visit || used.has(a) || used.has(b)) continue;
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist < 2 || Math.hypot(vx, vy) > 120) continue;
    for (let k = j + 1; k < det.length; k++) {
      const c = det[k], dt2 = c.mjd - a.mjd;
      if (c.mjd - b.mjd < 0.02 || dt2 > 3 || c.it.visit !== a.it.visit || used.has(c)) continue;
      if (Math.hypot(a.x + vx * dt2 - c.x, a.y + vy * dt2 - c.y) < 1.5) {
        tracks.push({ a, b, c, rate: Math.hypot(vx, vy) * 6.15 / 24 });
        used.add(a); used.add(b); used.add(c);
        break;
      }
    }
  }
  // 3) changes between first and last visit, per band.  Candidates from the
  //    per-band difference images are then confirmed with aperture photometry,
  //    which integrates the whole star so PSF/orientation "dipoles" cancel and
  //    only a genuine change in brightness survives.
  const changes = [];
  const visIds = [...new Set(vis.map(it => it.visit))].sort((a, b) => a - b);
  if (visIds.length >= 2) {
    const v0 = visIds[0], v1 = visIds[visIds.length - 1];
    const bandPairs = [];
    for (const [d, items] of byDet) {
      const A0 = items.filter(it => it.visit === v0), B0 = items.filter(it => it.visit === v1);
      if (!A0.length || !B0.length) continue;
      bandPairs.push({ d, A: composite(`cv${v0}|d${d}`, A0), B: composite(`cv${v1}|d${d}`, B0) });
    }
    const cands = [];
    for (const bp of bandPairs) {
      const dd = new Float32Array(N * N), nd = new Float32Array(N * N);
      for (let i = 0; i < dd.length; i++) { dd[i] = bp.B[i] - bp.A[i]; nd[i] = -dd[i]; }
      for (const p of R.findPeaks(dd, N, 7, 15, 6)) cands.push({ ...p, sign: 1 });
      for (const p of R.findPeaks(nd, N, 7, 15, 6)) cands.push({ ...p, sign: -1 });
    }
    const phot = (img, x, y) => {
      let sum = 0, n = 0; const ann = [];
      for (let yy = Math.floor(y - 8); yy <= Math.ceil(y + 8); yy++) for (let xx = Math.floor(x - 8); xx <= Math.ceil(x + 8); xx++) {
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const r = Math.hypot(xx - x, yy - y), v = img[yy * N + xx];
        if (!Number.isFinite(v)) continue;
        if (r <= 2.8) { sum += v; n++; } else if (r >= 5 && r <= 8) ann.push(v);
      }
      if (n < 15 || ann.length < 20) return null;
      ann.sort((a, b) => a - b);
      const bg = ann[ann.length >> 1], sd = (ann[Math.floor(ann.length * 0.84)] - ann[Math.floor(ann.length * 0.16)]) / 2;
      return { f: sum - bg * n, e: sd * Math.sqrt(n), peak: Math.max(...ann.slice(-1)) };
    };
    const need = bandPairs.length >= 2 ? 2 : 1;
    const seen = [];
    for (const c of cands) {
      if (seen.some(q => Math.hypot(q.x - c.x, q.y - c.y) < 3)) continue;
      let agree = 0, sat = false, dsum = 0;
      for (const bp of bandPairs) {
        const a = phot(bp.A, c.x, c.y), b = phot(bp.B, c.x, c.y);
        if (!a || !b) continue;
        const k = Math.round(c.y) * N + Math.round(c.x);
        if (bp.A[k] > 150 || bp.B[k] > 150) sat = true;          // near-saturated star core
        const df = b.f - a.f, err = Math.hypot(a.e, b.e) || 1, rel = Math.abs(df) / Math.max(Math.abs(a.f), Math.abs(b.f), 1e-9);
        if (Math.sign(df) === c.sign && Math.abs(df) / err > 6 && rel > 0.2) { agree++; dsum += df / err; }
      }
      if (sat || agree < need) continue;
      seen.push(c);
      changes.push({ kind: 'change', x: c.x, y: c.y, snr: Math.abs(dsum / agree), sign: c.sign, votes: agree, conf: 'high' });
    }
  }
  // 4) cross-match with known objects
  if (!S.known.length && $('#optKnown').checked) await computeKnown();
  const s = 6.15 / 3600 * D2R;
  for (const d of list) {
    const c = d.it.tgt;
    for (const k of S.known) {
      const pt = k.pts.find(p => Math.abs(p.mjd - d.mjd) < 1e-4);
      if (!pt) continue;
      const pr = skyToTan(pt.ra, pt.dec, c.ra * D2R, Math.sin(c.dec * D2R), Math.cos(c.dec * D2R));
      if (!pr) continue;
      const x = N / 2 - pr[0] / s - 0.5, y = N / 2 - pr[1] / s - 0.5;
      if (Math.hypot(x - d.x, y - d.y) < Math.max(3, k.unc * 1.3)) { d.known = k.short; break; }
    }
    const sky = pixToSky(d.it.tgt, d.x, d.y, N);
    d.ra = sky[0]; d.dec = sky[1];
  }
  // 5) verify unexplained candidates against SPHEREx's own pixel-quality flags
  //    (cosmic rays, hot/bad pixels, ghosts, persistence, outliers)
  const toCheck = list.filter(d => !d.known).slice(0, 40);
  if (toCheck.length && navigator.onLine) {
    btn.lastChild.textContent = ` Verifying ${toCheck.length} candidates…`;
    const byFrame = new Map();
    for (const d of toCheck) {
      if (!d.it.r.wcs || !d.it.r.flagsAt) continue;
      const p = new WCS(d.it.r.wcs).sky2pix(d.ra, d.dec);
      if (!p) continue;
      const k = frameKey(d.it.f);
      if (!byFrame.has(k)) byFrame.set(k, { f: d.it.f, at: d.it.r.flagsAt, ds: [], pts: [] });
      const g = byFrame.get(k); g.ds.push(d); g.pts.push({ x: p[0], y: p[1] });
    }
    await Promise.all([...byFrame.values()].map(async g => {
      const bits = await flagsNear(g.f, g.pts, g.at).catch(() => g.pts.map(() => -1));
      g.ds.forEach((d, i) => { d.flagBits = bits[i]; d.verified = bits[i] === 0 ? true : bits[i] > 0 ? false : null; });
    }));
  }
  for (const d of list) d.conf = d.known ? 'known' : (d.verified === true && d.comp >= 0.55 && d.snr >= 9) ? 'high' : 'low';
  // a tracklet only counts if every detection in it is verified or a known object
  for (let i = tracks.length - 1; i >= 0; i--) if ([tracks[i].a, tracks[i].b, tracks[i].c].some(d => d.conf === 'low')) tracks.splice(i, 1);
  for (const c of changes) { const sky = pixToSky(S.target.kind === 'fixed' ? S.target : S.items[0].tgt, c.x, c.y, N); c.ra = sky[0]; c.dec = sky[1]; }
  const all = [...list.sort((a, b) => (a.known ? 1 : 0) - (b.known ? 1 : 0) || b.snr - a.snr), ...changes];
  S.hunt = { list: all, tracks, sel: null };
  renderHunt();
  btn.disabled = false; btn.lastChild.textContent = ' Scan again';
  render();
}

function pixToSky(c, x, y, N) {
  const s = 6.15 / 3600 * D2R;
  return tanToSky((N / 2 - x - 0.5) * s, (N / 2 - y - 0.5) * s, c.ra * D2R, Math.sin(c.dec * D2R), Math.cos(c.dec * D2R));
}

function renderHunt() {
  const out = $('#huntOut');
  out.textContent = '';
  const H = S.hunt;
  const nk = H.list.filter(d => d.known).length, nc = H.list.filter(d => d.conf === 'high').length, nch = H.list.filter(d => d.kind === 'change').length;
  out.append(h('p', { class: 'small' }, h('b', { text: `${nk} known objects · ${nc} verified unexplained source${nc === 1 ? '' : 's'} · ${nch} changes between visits · ${H.tracks.length} moving tracklet${H.tracks.length === 1 ? '' : 's'}` })));
  if (H.tracks.length) {
    out.append(h('h3', { text: 'Moving tracklets (3+ detections in a line)' }));
    for (const t of H.tracks.slice(0, 10)) {
      out.append(h('div', { class: 'item' }, h('span', { class: 'pill cand', text: 'TRACK' }),
        h('div', { class: 'grow' }, h('b', { text: `${t.rate.toFixed(1)}″/hour` }), h('span', { class: 't', text: `${fmtDate(t.a.mjd, true)} → ${fmtDate(t.c.mjd, true)}` })),
        h('button', { class: 'btn sm', type: 'button', text: 'Show', onclick: () => { S.hunt.sel = t.a; jumpToMjd(t.a.mjd); } })));
    }
  }
  const lows = H.list.filter(d => d.conf === 'low');
  const shown = H.showLow ? H.list : H.list.filter(d => d.conf !== 'low');
  if (lows.length) {
    out.append(h('p', { class: 'small muted' }, `${lows.length} low-confidence detection${lows.length > 1 ? 's' : ''} (flagged by SPHEREx quality bits as cosmic rays, hot pixels or ghosts, or not star-shaped) ${H.showLow ? 'shown' : 'hidden'}. `,
      h('button', { class: 'btn sm', type: 'button', text: H.showLow ? 'Hide them' : 'Show them', onclick: () => { H.showLow = !H.showLow; renderHunt(); drawOverlay(currentItem()); } })));
  }
  for (const d of shown.slice(0, 80)) {
    const pill = d.known ? h('span', { class: 'pill known', text: 'KNOWN' }) : d.kind === 'change' ? h('span', { class: 'pill change', text: d.pm ? 'MOVED' : d.sign > 0 ? 'BRIGHTER' : 'FAINTER' })
      : d.conf === 'high' ? h('span', { class: 'pill cand', title: 'Star-shaped, clean pixels in SPHEREx quality flags, high S/N', text: 'VERIFIED ✓' }) : h('span', { class: 'pill', title: d.flagBits > 0 ? 'SPHEREx quality flags mark these pixels' : 'Weak or not verified', text: d.flagBits > 0 ? 'FLAGGED' : 'LOW' });
    const title = d.known ? d.known : d.kind === 'change' ? (d.pm ? `Shifted ≈${d.pm.toFixed(0)}″ between visits` : `${d.sign > 0 ? 'Brightened' : 'Faded'} between visits`) : `Single-image source at ${d.wave.toFixed(2)} µm`;
    out.append(h('div', { class: 'item' }, pill,
      h('div', { class: 'grow' }, h('b', { text: title }), h('span', { class: 't', text: `${d.ra.toFixed(5)}°, ${d.dec.toFixed(5)}° · S/N ${d.snr.toFixed(0)}${d.mjd ? ' · ' + fmtDate(d.mjd, true) : ''}` })),
      h('button', { class: 'btn sm', type: 'button', text: 'Show', onclick: () => { S.hunt.sel = d; if (d.mjd) jumpToMjd(d.mjd); else { setMode('diff'); } } }),
      d.known ? null : h('button', { class: 'btn sm', type: 'button', title: 'Save to My finds', text: '★', onclick: () => saveFind(d) })));
  }
  if (!H.list.length) out.append(h('p', { class: 'muted small', text: 'Nothing stood out above the noise. Try another band, load more images, or a busier part of the ecliptic.' }));
  out.append(h('p', { class: 'muted small', text: 'Candidates can be artefacts (cosmic rays, ghosts of bright stars, detector edges). Confirm by checking the image before and after, and in Difference mode.' }));
}

async function saveFind(d) {
  const id = `${S.target.name}|${d.ra.toFixed(5)}|${d.dec.toFixed(5)}|${d.mjd || ''}`;
  await store.put('finds', id, {
    id, target: S.target.name, kind: d.kind, ra: d.ra, dec: d.dec, mjd: d.mjd || null, date: d.mjd ? fmtDate(d.mjd, true) : null,
    wave: d.wave || null, snr: d.snr, note: d.pm ? `moved ${d.pm.toFixed(0)}"` : d.sign ? (d.sign > 0 ? 'brightened' : 'faded') : 'single-image source',
    frame: d.it ? frameKey(d.it.f) : null, saved: new Date().toISOString(),
  });
  toast('Saved to My finds ★', 'ok');
}

// ------------------------------------------------------------------ timeline
function drawTimeline() {
  const host = $('#timeline');
  if (!S || !S.frames.length) { host.textContent = ''; return; }
  const W = host.clientWidth || 600, H = 54;
  const t0 = S.frames[0].mjd - 3, t1 = S.frames[S.frames.length - 1].mjd + 3;
  const x = t => 8 + (t - t0) / (t1 - t0 || 1) * (W - 16);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const mk = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); svg.append(e); return e; };
  for (const v of S.visitsAll || []) {
    mk('rect', { x: x(v.t0) - 3, y: 4, width: Math.max(6, x(v.t1) - x(v.t0) + 6), height: H - 22, rx: 4, fill: 'rgba(102,217,255,.10)' });
    const tx = mk('text', { x: x(v.t0), y: H - 5 }); tx.textContent = mjdToDate(v.t0).toISOString().slice(0, 7);
  }
  const loaded = new Set(S.items.map(it => frameKey(it.f)));
  for (const f of S.frames) {
    const on = loaded.has(frameKey(f));
    const yy = 8 + (f.det - 1) * 4.6;
    mk('circle', { cx: x(f.mjd), cy: yy, r: on ? 2.6 : 1.4, fill: on ? waveColor((BANDS[f.det].lo + BANDS[f.det].hi) / 2) : 'rgba(150,160,200,.35)' });
  }
  const cur = mk('line', { x1: -10, x2: -10, y1: 2, y2: H - 18, class: 'now' });
  host.textContent = '';
  host.append(svg);
  S.tl = { x, cur, t0, t1, W };
  const it = currentItem();
  if (it) drawTimelineCursor(it.r.mjd);
}
function drawTimelineCursor(mjd) {
  if (!S || !S.tl) return;
  const X = S.tl.x(mjd);
  S.tl.cur.setAttribute('x1', X); S.tl.cur.setAttribute('x2', X);
}

function renderBandChips() {
  const box = $('#tmBands');
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const it of S.items) counts[it.f.det]++;
  box.textContent = '';
  const chip = (label, on, fn, title, color) => box.append(h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), title, onclick: fn, 'aria-pressed': on ? 'true' : 'false' }, color ? h('span', { class: 'sw', style: { background: color } }) : null, label));
  chip(`All (${S.items.length})`, !S.bands.size, () => setBands([]), 'Show every wavelength');
  for (let d = 1; d <= 6; d++) {
    if (!counts[d]) continue;
    chip(`${BANDS[d].lo}–${BANDS[d].hi} µm (${counts[d]})`, S.bands.has(d), ev => {
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) { S.bands.has(d) ? S.bands.delete(d) : S.bands.add(d); setBands([...S.bands]); } else setBands([d]);
    }, `Band ${d}. Shift-click to combine bands`, waveColor((BANDS[d].lo + BANDS[d].hi) / 2));
  }
}
function setBands(arr) {
  S.bands = new Set(arr);
  S.comp.clear();
  S.cur = 0;
  renderBandChips(); updateScrub(); renderFrameGrid(); populateSelectors(); render(); measureAll();
}

function updateScrub() {
  const n = visible().length;
  const sc = $('#pScrub');
  sc.max = Math.max(0, n - 1);
  sc.value = Math.min(S.cur, n - 1);
}

function renderFrameGrid() {
  const g = $('#frameGrid');
  if (g.closest('[hidden]')) { g.dataset.dirty = '1'; return; }
  g.dataset.dirty = '';
  const vis = visible();
  g.textContent = '';
  vis.slice(0, 400).forEach((it, i) => {
    const N = it.r.size;
    const c = h('canvas', { width: N, height: N });
    const d = derived(it).fill;
    const l = R.levels(d, 'sky', [1.5, 99.8]);
    R.paint(c.getContext('2d'), N, R.scaleTo8(d, { lo: l.lo, hi: l.hi, stretch: $('#optStretch').value }), $('#optCmap').value);
    g.append(h('button', { type: 'button', class: i === S.cur ? 'on' : '', title: `${fmtDate(it.r.mjd, true)} · ${it.r.wave.toFixed(3)} µm`, onclick: () => { setMode('movie'); S.cur = i; stop(); render(); } },
      c, h('span', { text: `${fmtDate(it.r.mjd).slice(2)} ${it.r.wave.toFixed(2)}µ` })));
  });
}
function highlightFrameGrid() {
  $$('#frameGrid button').forEach((b, i) => b.classList.toggle('on', i === S.cur));
}

// ------------------------------------------------------------------ player
function play() {
  if (!S || S.playing) return;
  S.playing = true;
  $('#pPlay').firstElementChild.firstElementChild.setAttribute('href', '#i-pause');
  $('#pPlay').setAttribute('aria-label', 'Pause');
  tick();
}
function tick() {
  if (!S || !S.playing) return;
  const fps = +$('#pSpeed').value;
  if (S.mode === 'movie') {
    const n = visible().length;
    if (n) { S.cur = (S.cur + 1) % n; render(); }
  } else if (S.mode === 'blink') { S.blinkPhase ^= 1; render(); }
  S.timer = setTimeout(tick, S.mode === 'blink' ? Math.max(180, 1400 / fps) : 1000 / fps);
}
export function stop() {
  if (!S) return;
  S.playing = false;
  clearTimeout(S.timer);
  const b = $('#pPlay');
  if (b) { b.firstElementChild.firstElementChild.setAttribute('href', '#i-play'); b.setAttribute('aria-label', 'Play'); }
}
function step(d) {
  if (!S) return;
  stop();
  if (S.mode === 'blink') { S.blinkPhase ^= 1; render(); return; }
  if (S.mode !== 'movie') setMode('movie');
  const n = visible().length;
  if (!n) return;
  S.cur = (S.cur + d + n) % n;
  render();
}

function setMode(m, silent) {
  if (!S) return;
  S.mode = m;
  S.selTouched = false;
  $$('#tmModes button').forEach(b => { const on = b.dataset.mode === m; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
  if (m !== 'movie' && m !== 'blink') stop();
  $('#player').hidden = !(m === 'movie' || m === 'blink');
  populateSelectors();
  if (!silent) render();
}

// ------------------------------------------------------------------ export / share / save
function savedKey() {
  const t = S.target;
  return t.kind === 'mover' ? `mover:${t.moverId || t.sso?.name}` : `fixed:${t.ra.toFixed(4)},${t.dec.toFixed(4)}`;
}
async function updateSaveBtn() {
  if (!S) return;
  const s = await store.get('saved', savedKey());
  const b = $('#tmSave');
  b.lastElementChild.textContent = s ? 'Saved ✓' : 'Save offline';
  b.classList.toggle('primary', !!s);
}
async function toggleSave() {
  const key = savedKey();
  const s = await store.get('saved', key);
  if (s) { await store.del('saved', key); toast('Removed from saved targets'); updateSaveBtn(); ctx.onSaved?.(); return; }
  const thumb = $('#cv').toDataURL('image/png');
  const t = S.target;
  await store.put('saved', key, {
    key, name: t.name, kind: t.kind, ra: t.ra, dec: t.dec, moverId: t.moverId || null, sso: t.sso || null, track: t.track || null,
    frames: S.chosen, n: S.items.length, savedAt: new Date().toISOString(), thumb, size: ctx.settings.size, mask: ctx.settings.mask, info: t.info || null,
  });
  await store.persist();
  toast(`Saved “${t.name}” with ${S.items.length} images. It now works offline.`, 'ok');
  updateSaveBtn(); ctx.onSaved?.();
}

export function shareLink() {
  const t = S.target;
  const p = new URLSearchParams();
  if (t.kind === 'mover') { if (t.moverId) p.set('mover', t.moverId); else p.set('sso', t.sso.name); }
  else { p.set('ra', t.ra.toFixed(5)); p.set('dec', t.dec.toFixed(5)); p.set('name', t.name); }
  if (S.mode !== 'movie') p.set('mode', S.mode);
  if (S.bands.size) p.set('bands', [...S.bands].join(''));
  return `${location.origin}${location.pathname}#/tm?${p}`;
}
async function share() {
  const url = shareLink();
  const data = { title: `SkyShift · ${S.target.name}`, text: `Watch ${S.target.name} change in NASA SPHEREx infrared images`, url };
  try {
    if (navigator.share) { await navigator.share(data); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied to clipboard', 'ok'); } catch { prompt('Copy this link:', url); }
}

function exportPNG() {
  const N = 4 * size();
  const out = h('canvas', { width: N, height: N });
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = $('#optSmooth').checked;
  g.drawImage($('#cv'), 0, 0, N, N);
  g.drawImage($('#ov'), 0, 0, N, N);
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, N - 26, N, 26);
  g.fillStyle = '#fff'; g.font = '600 13px system-ui, sans-serif';
  g.fillText(`${S.target.name} · ${$('#hudTL').textContent} · ${$('#hudTR').textContent} · NASA SPHEREx / SkyShift`, 8, N - 9);
  out.toBlob(b => download(b, `skyshift-${slug(S.target.name)}.png`), 'image/png');
}
function exportGIF() {
  const vis = visible();
  if (!vis.length) return;
  const N = size(), k = N < 100 ? 3 : 2, M = N * k;
  const stretch = $('#optStretch').value;
  const frames = vis.map(it => {
    const d = derived(it).fill;
    const l = R.levels(d, 'sky', [1.5, 99.8]);
    const b = R.scaleTo8(d, { lo: l.lo, hi: l.hi, stretch });
    const up = new Uint8Array(M * M);
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) up[y * M + x] = b[Math.floor(y / k) * N + Math.floor(x / k)];
    return up;
  });
  const blob = encodeGIF(frames, M, M, R.lut($('#optCmap').value), Math.round(100 / +$('#pSpeed').value));
  download(blob, `skyshift-${slug(S.target.name)}.gif`);
  toast(`GIF with ${frames.length} frames saved`, 'ok');
}
async function exportVideo() {
  const cv = $('#cv');
  if (!cv.captureStream || typeof MediaRecorder === 'undefined') { toast('Video recording is not supported in this browser. Use GIF instead.', 'err'); return; }
  const types = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'];
  const type = types.find(t => MediaRecorder.isTypeSupported(t));
  if (!type) { toast('No supported video format. Use GIF instead.', 'err'); return; }
  const N = 512;
  const rec = h('canvas', { width: N, height: N });
  const g = rec.getContext('2d');
  g.imageSmoothingEnabled = false;
  const stream = rec.captureStream(30);
  const mr = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4e6 });
  const chunks = [];
  mr.ondataavailable = e => chunks.push(e.data);
  mr.onstop = () => download(new Blob(chunks, { type }), `skyshift-${slug(S.target.name)}.${type.includes('mp4') ? 'mp4' : 'webm'}`);
  setMode('movie'); stop();
  mr.start();
  const vis = visible(), fps = +$('#pSpeed').value;
  toast('Recording video…');
  for (let i = 0; i < vis.length; i++) {
    S.cur = i; render();
    g.drawImage($('#cv'), 0, 0, N, N); g.drawImage($('#ov'), 0, 0, N, N);
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 0, N, 24);
    g.fillStyle = '#fff'; g.font = '600 13px system-ui'; g.fillText(`${S.target.name} · ${$('#hudTL').textContent} · ${$('#hudTR').textContent}`, 8, 16);
    await new Promise(r => setTimeout(r, 1000 / fps));
  }
  mr.stop();
}
function exportFITS() {
  const it = currentItem() || visible()[0];
  if (!it) return;
  const N = it.r.size, c = it.tgt;
  const card = (k, v, cmt = '') => {
    let val = typeof v === 'string' ? `'${v.replace(/'/g, "''").padEnd(8)}'`.padEnd(20) : typeof v === 'boolean' ? (v ? 'T' : 'F').padStart(20) : String(v).padStart(20);
    return (k.padEnd(8) + '= ' + val + (cmt ? ' / ' + cmt : '')).slice(0, 80).padEnd(80);
  };
  const cards = [
    card('SIMPLE', true), card('BITPIX', -32), card('NAXIS', 2), card('NAXIS1', N), card('NAXIS2', N),
    card('CTYPE1', 'RA---TAN'), card('CTYPE2', 'DEC--TAN'), card('CRVAL1', +c.ra.toFixed(8)), card('CRVAL2', +c.dec.toFixed(8)),
    card('CRPIX1', (N + 1) / 2), card('CRPIX2', (N + 1) / 2), card('CDELT1', -(6.15 / 3600).toFixed(10)), card('CDELT2', +(6.15 / 3600).toFixed(10)),
    card('BUNIT', 'MJy/sr'), card('MJD-OBS', +it.r.mjd.toFixed(6)), card('DATE-OBS', it.r.dateObs || fmtDate(it.r.mjd, true)),
    card('WAVELEN', +it.r.wave.toFixed(5), 'central wavelength [um]'), card('OBSID', obsId(it.f)), card('DETECTOR', it.f.det),
    card('ORIGIN', 'SkyShift reprojection of NASA SPHEREx'), card('SOURCE', frameKey(it.f).slice(0, 68)), 'END'.padEnd(80),
  ].join('');
  const hdr = cards.padEnd(Math.ceil(cards.length / 2880) * 2880, ' ');
  const nb = N * N * 4, buf = new ArrayBuffer(Math.ceil(nb / 2880) * 2880);
  const dv = new DataView(buf);
  // FITS rows run bottom-to-top; our image is north-up / east-left, so flip rows only
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) dv.setFloat32(((N - 1 - y) * N + x) * 4, it.r.data[y * N + x], false);
  download(new Blob([new TextEncoder().encode(hdr), buf], { type: 'application/fits' }), `skyshift-${slug(S.target.name)}-${obsId(it.f)}D${it.f.det}.fits`);
}
function exportCSV() {
  if (!S.phot) measureAll();
  const rows = [['date_utc', 'mjd', 'wavelength_um', 'band', 'flux_mJy', 'flux_err_mJy', 'ab_mag', 'visit', 'obsid', 'release', 'ra_deg', 'dec_deg']];
  for (const p of S.phot) rows.push([fmtDate(p.it.r.mjd, true), p.it.r.mjd.toFixed(6), p.it.r.wave.toFixed(4), p.it.f.det, (p.m.uJy / 1000).toFixed(5), (p.m.err / 1000).toFixed(5), p.m.ab ? p.m.ab.toFixed(3) : '', p.it.visit + 1, obsId(p.it.f), p.it.f.qr, p.it.tgt.ra.toFixed(6), p.it.tgt.dec.toFixed(6)]);
  download(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }), `skyshift-${slug(S.target.name)}-photometry.csv`);
}
function exportJSON() {
  const rep = {
    generator: 'SkyShift (NASA SPHEREx Sky Time Machine)', created: new Date().toISOString(), target: { ...S.target, track: undefined },
    images: S.items.map(it => ({ obsid: obsId(it.f), detector: it.f.det, release: it.f.qr, file: S3 + frameKey(it.f), mjd: it.r.mjd, wavelength_um: it.r.wave })),
    photometry: (S.phot || []).map(p => ({ mjd: p.it.r.mjd, wavelength_um: p.it.r.wave, flux_mJy: p.m.uJy / 1000, err_mJy: p.m.err / 1000 })),
    hunt: S.hunt ? S.hunt.list.map(d => ({ kind: d.kind, ra: d.ra, dec: d.dec, mjd: d.mjd || null, snr: d.snr, known: d.known || null })) : null,
    knownObjects: S.known.map(k => ({ name: k.obj.name, appearances: k.pts.length })),
    acknowledgement: 'This publication makes use of data products from SPHEREx, a joint project of JPL and Caltech funded by NASA. DOI 10.26131/IRSA652',
  };
  download(new Blob([JSON.stringify(rep, null, 1)], { type: 'application/json' }), `skyshift-${slug(S.target.name)}-report.json`);
}

// ------------------------------------------------------------------ UI binding
function bindUI() {
  $('#cv').width = 96;
  R.COLORMAPS.forEach(c => $('#optCmap').append(h('option', { value: c, text: c })));
  $('#optCmap').value = store.pref('cmap') || 'inferno';
  $('#optStretch').value = store.pref('stretch') || 'asinh';
  $('#optSmooth').checked = store.pref('smooth') ?? true;
  $('#tmModes').addEventListener('click', e => { const b = e.target.closest('button[data-mode]'); if (b) { setMode(b.dataset.mode); if (b.dataset.mode === 'blink' && !$('#swipeMode').checked) play(); } });
  $('#pPlay').onclick = () => (S && S.playing ? stop() : play());
  $('#pPrev').onclick = () => step(-1);
  $('#pNext').onclick = () => step(1);
  $('#pScrub').oninput = e => { if (!S) return; stop(); if (S.mode !== 'movie') setMode('movie'); S.cur = +e.target.value; render(); };
  for (const id of ['#optStretch', '#optCmap', '#optBg', '#optSmooth', '#optGrid']) {
    $(id).addEventListener('change', () => {
      store.pref('cmap', $('#optCmap').value); store.pref('stretch', $('#optStretch').value); store.pref('smooth', $('#optSmooth').checked);
      if (!S) return;
      if (id === '#optBg') { S.cache.clear(); S.comp.clear(); }
      render(); renderFrameGrid();
    });
  }
  $('#optKnown').addEventListener('change', () => { if (S) { if ($('#optKnown').checked) computeKnown(); else drawOverlay(currentItem()); } });
  for (const id of ['#selA', '#selB', '#swipeMode']) $(id).addEventListener('change', () => { if (S) { if (id !== '#swipeMode') S.selTouched = true; else stop(); render(); } });
  $('#swipe').addEventListener('input', e => { $('#stage').style.setProperty('--clip', e.target.value + '%'); });
  $('#stage').style.setProperty('--clip', '50%');
  $('#sideTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-side]');
    if (!b) return;
    $$('#sideTabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.side-pane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.side; });
    if (b.dataset.side === 'frames' && S) renderFrameGrid();
    if (b.dataset.side === 'measure' && S) measureAll();
  });
  $('#huntBtn').onclick = hunt;
  $('#tmSave').onclick = () => S && toggleSave();
  $('#tmShare').onclick = () => S && share();
  $('#loadMore').onclick = () => {
    if (!S) return;
    const have = new Set(S.chosen.map(frameKey));
    const more = chooseFrames(S.frames.filter(f => !have.has(frameKey(f))), ctx.settings.max);
    S.chosen.push(...more);
    $('#loadMore').hidden = S.chosen.length >= S.frames.length;
    $('#loadMore').textContent = `Load more images (${fmtInt(S.frames.length - S.chosen.length)} more available)`;
    renderBadges();
    loadFrames(more);
  };
  const exp = $('#tmExport'), expBtn = $('#tmExportBtn');
  expBtn.onclick = () => { exp.hidden = !exp.hidden; expBtn.setAttribute('aria-expanded', !exp.hidden); };
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) { exp.hidden = true; expBtn.setAttribute('aria-expanded', 'false'); } });
  exp.addEventListener('click', e => {
    const b = e.target.closest('button[data-export]');
    if (!b || !S || !S.items.length) return;
    exp.hidden = true;
    ({ png: exportPNG, gif: exportGIF, webm: exportVideo, fits: exportFITS, csv: exportCSV, json: exportJSON })[b.dataset.export]();
  });
  // tap image to place the photometry aperture; wheel/pinch to zoom
  const stage = $('#stage');
  const zoomEls = () => ['#cv', '#cv2', '#ov', '#refImg'].map(s => $(s));
  const applyZoom = () => { const z = S.zoom; zoomEls().forEach(el => { el.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.k})`; el.style.transformOrigin = '0 0'; }); };
  const ptrs = new Map();
  let start = null, moved = false, pinch = null;
  stage.addEventListener('pointerdown', e => {
    if (e.target.id === 'swipe' || !S) return;
    stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    start = [e.clientX, e.clientY]; moved = false;
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), k: S.zoom.k }; }
  });
  stage.addEventListener('pointermove', e => {
    if (!ptrs.has(e.pointerId) || !S) return;
    const prev = ptrs.get(e.pointerId);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 6) moved = true;
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      zoomAt(pinch.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    } else if (moved && S.zoom.k > 1) { S.zoom.x += e.clientX - prev[0]; S.zoom.y += e.clientY - prev[1]; clampZoom(); applyZoom(); }
  });
  const zoomAt = (k, cx, cy) => {
    const r = stage.getBoundingClientRect();
    const z = S.zoom, nk = clamp(k, 1, 8);
    const px = cx - r.left, py = cy - r.top;
    z.x = px - (px - z.x) * nk / z.k; z.y = py - (py - z.y) * nk / z.k; z.k = nk;
    clampZoom(); applyZoom();
  };
  const clampZoom = () => { const r = stage.getBoundingClientRect(), z = S.zoom; z.x = clamp(z.x, r.width * (1 - z.k), 0); z.y = clamp(z.y, r.height * (1 - z.k), 0); if (z.k === 1) { z.x = z.y = 0; } };
  stage.addEventListener('pointerup', e => {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!S || moved || e.target.id === 'swipe') return;
    const r = $('#cv').getBoundingClientRect();
    const N = size();
    const x = (e.clientX - r.left) / r.width * N - 0.5, y = (e.clientY - r.top) / r.height * N - 0.5;
    if (x < 0 || y < 0 || x > N - 1 || y > N - 1) return;
    S.ap = { x, y };
    render(); measureAll();
    const c = S.target.kind === 'fixed' ? S.target : (currentItem() || S.items[0]).tgt;
    const sky = pixToSky(c, x, y, N);
    toast(`Measuring at ${sky[0].toFixed(5)}°, ${sky[1].toFixed(5)}°. See “Spectrum & light curve”`, '', 2600);
  });
  stage.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch = null; });
  stage.addEventListener('wheel', e => { if (!S) return; e.preventDefault(); zoomAt(S.zoom.k * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  stage.addEventListener('dblclick', () => { if (S) { S.zoom = { k: 1, x: 0, y: 0 }; applyZoom(); } });
  new ResizeObserver(() => { if (S) { drawOverlay(currentItem()); drawTimeline(); } }).observe(stage);
  $('#timeline').addEventListener('pointerdown', e => {
    if (!S || !S.tl) return;
    const r = $('#timeline').getBoundingClientRect();
    const X = (e.clientX - r.left) / r.width * S.tl.W;
    const t = S.tl.t0 + (X - 8) / (S.tl.W - 16) * (S.tl.t1 - S.tl.t0);
    const vis = visible();
    if (!vis.length) return;
    jumpToMjd(t);
  });
}

export function tmKey(e) {
  if (!S || !S.items.length) return false;
  const k = e.key;
  if (k === ' ') { S.playing ? stop() : play(); return true; }
  if (k === 'ArrowRight') { step(1); return true; }
  if (k === 'ArrowLeft') { step(-1); return true; }
  const modes = { m: 'movie', b: 'blink', d: 'diff', c: 'color', t: 'then' };
  if (modes[k.toLowerCase()]) { setMode(modes[k.toLowerCase()]); if (k.toLowerCase() === 'b') play(); return true; }
  if (/^[0-6]$/.test(k)) { setBands(k === '0' ? [] : [+k]); return true; }
  return false;
}

export function applyRouteOptions(p) {
  if (!S) return;
  if (p.get('bands')) { S.bands = new Set(p.get('bands').split('').map(Number).filter(n => n >= 1 && n <= 6)); }
  if (p.get('mode')) setMode(p.get('mode'));
}

export const current = () => S;
export { setMode };
