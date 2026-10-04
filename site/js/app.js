// SkyShift - application shell.
import { $, $$, h, toast, fmtInt, fmtDate, fmtShortDate, ago, fmtBytes, parseCoords, debounce, download, waveColor, slug } from './util.js';
import { getJSON, getMeta, latestPeriods, s3List, parseKey, liveNews, liveImages, resolveName } from './data.js';
import { SkyMap } from './sky.js';
import { BANDS, frameKey } from './fits.js';
import { bars } from './charts.js';
import * as store from './store.js';
import * as R from './render.js';
import { initTM, openTarget, openMover, tmKey, stop as tmStop, current as tmCurrent, applyRouteOptions, render as tmRender } from './tm.js';

// ------------------------------------------------------------------ featured
const FEATURED = [
  { name: 'Orion Nebula (M42)', ra: 83.8221, dec: -5.3911, tag: 'Star nursery', info: 'The nearest big star-forming region, 1,350 light-years away. Young stars, dust and ices glow in the infrared.' },
  { name: 'North Ecliptic Pole deep field', ra: 270.0, dec: 66.5607, tag: 'Most-watched spot', info: 'SPHEREx stares here on almost every orbit, building its deepest map. Hundreds of images make it the best place to see changes over time.' },
  { name: 'South Ecliptic Pole deep field', ra: 90.0, dec: -66.5607, tag: 'Most-watched spot', info: 'SPHEREx\'s second deep field, next to the Large Magellanic Cloud. Revisited constantly.' },
  { name: 'Barnard\'s Star', ra: 269.44627, dec: 4.76823, tag: 'Fastest-moving star', info: 'A red dwarf 6 light-years away that crosses the sky faster than any other star: 10.4″ per year. Watch it creep between visits.' },
  { name: 'WISE 0855−0714', ra: 133.7656, dec: -7.2427, tag: 'Coldest brown dwarf', info: 'A "failed star" as cold as the North Pole, found by NASA\'s WISE through its motion. Only 7.4 light-years away, visible only in the infrared.' },
  { name: 'Luhman 16 brown dwarfs', ra: 162.2950, dec: -53.3168, tag: 'Nearest brown dwarfs', info: 'The closest brown dwarf pair to the Sun (6.5 light-years), also discovered by WISE through its motion.' },
  { name: 'Proxima Centauri', ra: 217.3695, dec: -62.6739, tag: 'Nearest star', info: 'The closest star to the Sun, with at least one planet. Moves 3.9″ per year.' },
  { name: 'Galactic Centre (Sgr A*)', ra: 266.41684, dec: -29.00781, tag: 'Heart of the Milky Way', info: 'Dust hides the galactic core in visible light, but infrared cuts through to millions of stars around our supermassive black hole.' },
  { name: 'Cygnus X (DR21)', ra: 309.7521, dec: 42.3303, tag: 'Interstellar ice', info: 'A giant star-forming complex where SPHEREx mapped vast amounts of water ice.' },
  { name: 'Rho Ophiuchi cloud', ra: 246.7875, dec: -24.5389, tag: 'Ices & young stars', info: 'A nearby dark cloud full of newborn stars wrapped in icy dust, a key SPHEREx ice target.' },
  { name: 'Eagle Nebula (Pillars of Creation)', ra: 274.70, dec: -13.807, tag: 'Iconic nebula', info: 'Home of the famous Pillars of Creation.' },
  { name: 'Andromeda Galaxy (M31)', ra: 10.6847, dec: 41.2691, tag: 'Nearest big galaxy', info: 'Our giant neighbour, 2.5 million light-years away.' },
  { name: '30 Doradus (Tarantula)', ra: 84.6765, dec: -69.1009, tag: 'Monster nebula', info: 'The most active star factory in the Local Group, inside the Large Magellanic Cloud.' },
  { name: 'V1647 Ori (McNeil\'s Nebula)', ra: 86.54038, dec: -0.09946, tag: 'Outbursting young star', info: 'A newborn star that flares up by factors of 10 or more as it swallows gas from its disk, lighting up McNeil\'s Nebula. Compare visits to catch it changing.' },
  { name: 'Herbig–Haro 1 & 2', ra: 84.0846, dec: -6.7514, tag: 'Jets from a newborn star', info: 'Glowing knots where jets from a young star slam into surrounding gas. Some knots visibly change over time.' },
  { name: 'Eta Carinae', ra: 161.2650, dec: -59.6845, tag: 'Unstable giant', info: 'A massive, eruptive double star wrapped in its own dust cloud.' },
  { name: 'Crab Nebula (M1)', ra: 83.6331, dec: 22.0145, tag: 'Supernova remnant', info: 'The debris of a star that exploded in 1054 AD, with a pulsar at its heart.' },
  { name: 'Boyajian\'s Star', ra: 301.5644, dec: 44.4569, tag: 'Mysterious dimming', info: 'Famous for unexplained, irregular dips in brightness.' },
  { name: 'Whirlpool Galaxy (M51)', ra: 202.4696, dec: 47.1952, tag: 'Spiral galaxy', info: 'A face-on spiral interacting with a companion galaxy.' },
  { name: 'Pleiades (M45)', ra: 56.75, dec: 24.1167, tag: 'Star cluster', info: 'The Seven Sisters: young hot stars in a dusty veil.' },
];

// ------------------------------------------------------------------ settings
const settings = {
  size: store.pref('size') ?? 64,
  max: store.pref('max2') ?? 24,
  mask: store.pref('mask') ?? false,
  mode: store.pref('mode') ?? 'auto',
  reduceMotion: store.pref('reduceMotion') ?? matchMedia('(prefers-reduced-motion: reduce)').matches,
  autoplay: true,
};
const ctx = { settings, onSaved: () => { if (currentView === 'saved') renderSaved(); } };

let sky = null, currentView = null, movers = [], exo = null;

// ------------------------------------------------------------------ boot
function boot() {
  applyTheme(store.pref('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
  initTM(ctx);
  bindShell();
  route();
  window.addEventListener('hashchange', route);
  loadMetaUI();
  registerSW();
  if (!store.pref('toured')) setTimeout(showTour, 900);
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.pref('theme', t);
}

// ------------------------------------------------------------------ router
const VIEWS = ['explore', 'tm', 'chase', 'live', 'mission', 'saved', 'learn'];
function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, qs] = hash.split('?');
  const view = VIEWS.includes(name) ? name : 'explore';
  const p = new URLSearchParams(qs || '');
  show(view);
  if (view === 'tm') {
    const cur = tmCurrent();
    if (p.get('mover')) {
      if (!cur || cur.target.moverId !== p.get('mover')) withMovers().then(ms => { const m = ms.find(x => x.id === p.get('mover')); if (m) openMover(m).then(() => applyRouteOptions(p)); });
    } else if (p.get('sso')) {
      if (!cur || cur.target.sso?.name !== p.get('sso')) findSSO(p.get('sso')).then(o => o && openMover({ name: shortName(o.name), sso: o }));
    } else if (p.get('ra') && p.get('dec')) {
      const ra = +p.get('ra'), dec = +p.get('dec');
      if (Number.isFinite(ra) && Number.isFinite(dec) && (!cur || Math.abs(cur.target.ra - ra) > 1e-5 || Math.abs(cur.target.dec - dec) > 1e-5)) {
        const f = FEATURED.find(x => Math.abs(x.ra - ra) < 1e-4 && Math.abs(x.dec - dec) < 1e-4);
        openTarget({ ra, dec, name: p.get('name') || f?.name, info: f?.info }).then(() => applyRouteOptions(p));
      }
    }
  }
}
function show(view) {
  if (currentView === view) return;
  if (currentView === 'tm') tmStop();
  currentView = view;
  for (const v of VIEWS) $('#view-' + v).hidden = v !== view;
  $$('.tabs a').forEach(a => { const on = a.dataset.view === view; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const titles = { explore: 'Explore', tm: 'Time Machine', chase: 'Chase', live: 'Live', mission: 'Mission', saved: 'Saved', learn: 'Learn' };
  document.title = `${titles[view]} · SkyShift`;
  window.scrollTo({ top: 0 });
  if (view === 'explore') initExplore();
  if (view === 'chase') initChase();
  if (view === 'live') initLive();
  if (view === 'mission') initMission();
  if (view === 'saved') renderSaved();
}
export function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
function openFixed(t) {
  const p = new URLSearchParams({ ra: (+t.ra).toFixed(5), dec: (+t.dec).toFixed(5), name: t.name || '' });
  go('#/tm?' + p);
}
function openMoverRoute(m) { go('#/tm?mover=' + encodeURIComponent(m.id)); }
function openSSORoute(o) { go('#/tm?sso=' + encodeURIComponent(o.name)); }

// ------------------------------------------------------------------ meta
async function loadMetaUI() {
  try {
    const m = await getMeta();
    const s = m.spherex || {};
    const hs = $('#heroStats');
    hs.textContent = '';
    const st = (b, t) => hs.append(h('span', {}, h('b', { text: b }), ' ' + t));
    st(fmtInt(s.frames || 0), 'SPHEREx images indexed');
    st(`${Math.round((s.skyFraction || 0) * 100)}%`, 'of the sky covered');
    st(s.lastMjd ? fmtShortDate(s.lastMjd) : '—', 'latest observation');
    hs.append(h('span', {}, h('i', { class: 'live-dot' }), `index refreshed ${ago(Date.parse(m.built))}`));
    $('#buildInfo').textContent = `Data index ${fmtDate((Date.parse(m.built) / 864e5) + 40587, true)}`;
  } catch {
    $('#heroStats').textContent = navigator.onLine ? 'Loading mission statistics…' : 'Offline: showing saved data only.';
  }
}

// ------------------------------------------------------------------ explore
async function initExplore() {
  if (!sky) {
    sky = new SkyMap($('#skymap'), {
      onPick: (s, near) => {
        if (near && near.kind === 'target') { openFixed(near.o); return; }
        if (near && near.kind === 'live') { openFixed({ ra: near.o.ra, dec: near.o.dec, name: 'Newest SPHEREx frame' }); return; }
        if (near && near.kind === 'exo') { openFixed({ ra: near.o[1], dec: near.o[2], name: near.o[0] + ' (exoplanet host)' }); return; }
        if (s) openFixed({ ra: s[0], dec: s[1] });
      },
      onHover: (s, near, e) => {
        const tip = $('#mapTip');
        if (!s && !near) { tip.hidden = true; return; }
        const r = $('#skymap').getBoundingClientRect();
        tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px';
        tip.hidden = false;
        if (near) {
          tip.textContent = near.kind === 'target' ? near.o.name : near.kind === 'live' ? `Newest frame · ${near.o.date || ''}` : `${near.o[0]} · ${near.o[4]} planet(s)`;
        } else {
          const cov = sky.cov;
          let n = '';
          if (cov) { const k = Math.min(179, Math.floor(s[1] + 90)) * 360 + Math.floor(s[0]) % 360; n = ` · imaged ~${cov.counts[k]}×`; }
          tip.textContent = `RA ${s[0].toFixed(1)}°, Dec ${s[1].toFixed(1)}°${n}`;
        }
      },
    });
    $('#skymap').addEventListener('pointerleave', () => { $('#mapTip').hidden = true; });
    sky.points.targets = FEATURED.map(f => ({ ...f, label: false }));
    $('#zoomIn').onclick = () => sky.setZoom(sky.zoom * 1.5);
    $('#zoomOut').onclick = () => sky.setZoom(sky.zoom / 1.5);
    const lb = $('#layersBtn'), lm = $('#mapLayers');
    lb.onclick = e => { e.stopPropagation(); lm.hidden = !lm.hidden; lb.setAttribute('aria-expanded', !lm.hidden); };
    document.addEventListener('click', e => { if (!e.target.closest('#mapLayers') && e.target !== lb) { lm.hidden = true; lb.setAttribute('aria-expanded', 'false'); } });
    $$('#mapLayers input').forEach(i => i.addEventListener('change', async () => {
      sky.layers[i.dataset.layer] = i.checked;
      if (i.dataset.layer === 'exo' && i.checked) await loadExo();
      sky.bg = null; sky.draw();
    }));
    $$('[data-mapmode]').forEach(b => b.addEventListener('click', () => {
      sky.mode = b.dataset.mapmode;
      $$('[data-mapmode]').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); });
      sky.bg = null; sky.draw(); legend();
    }));
    renderFeatured();
    try {
      const cov = await getJSON('coverage.json');
      const dec = b64 => new Uint16Array(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer);
      const counts = dec(cov.counts), last = dec(cov.lastDay);
      let mx = 0, mn = 1e9;
      for (const v of last) { if (v > mx) mx = v; if (v && v < mn) mn = v; }
      sky.setCoverage({ w: cov.w, h: cov.h, counts, lastDay: last, nowDay: mx, minDay: mn, mjd0: cov.mjd0 });
      legend();
    } catch { /* offline first visit */ }
    refreshLiveLayer();
  } else sky.draw();
}
function legend() {
  const l = $('#mapLegend');
  l.textContent = '';
  if (!sky.cov) return;
  if (sky.mode === 'counts') l.append('fewer', h('i'), 'more images');
  else l.append(fmtShortDate(sky.cov.mjd0 + sky.cov.minDay), h('i'), fmtShortDate(sky.cov.mjd0 + sky.cov.nowDay));
}
async function loadExo() {
  if (exo) return exo;
  try { exo = await getJSON('exoplanets.json'); sky.points.exo = exo.data; } catch { toast('Exoplanet list unavailable offline', 'err'); }
  return exo;
}
function renderFeatured() {
  const box = $('#featured');
  box.textContent = '';
  for (const f of FEATURED) {
    const card = h('a', { class: 'tcard', href: '#/tm?' + new URLSearchParams({ ra: f.ra, dec: f.dec, name: f.name }) },
      h('div', { class: 'thumb' }), h('span', { class: 'tag', text: f.tag }), h('b', { text: f.name }), h('p', { text: f.info }));
    box.append(card);
  }
  // pre-made thumbnails (NASA/IPAC 2MASS), loaded as cards scroll into view
  const setThumb = (el, f) => { el.firstElementChild.style.backgroundImage = `url("img/thumbs/${slug(f.name)}.webp")`; };
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (!e.isIntersecting) return;
      setThumb(e.target, FEATURED[[...box.children].indexOf(e.target)]);
      io.unobserve(e.target);
    }), { rootMargin: '300px' });
    [...box.children].forEach(c => io.observe(c));
  } else [...box.children].forEach((c, i) => setThumb(c, FEATURED[i]));
  withMovers().then(ms => renderMoverCards($('#featuredMovers'), ms.slice(0, 8)));
}
async function withMovers() {
  if (movers.length) return movers;
  try { movers = (await getJSON('movers.json')).movers; } catch { movers = []; }
  return movers;
}
function renderMoverCards(box, list) {
  box.textContent = '';
  for (const m of list) {
    const last = m.track[m.track.length - 1];
    box.append(h('a', { class: 'tcard', href: '#/tm?mover=' + encodeURIComponent(m.id) },
      h('span', { class: 'tag', text: /Comet|ATLAS/.test(m.name) ? 'Comet' : /Neptune|Uranus/.test(m.name) ? 'Planet' : /Ceres|Vesta|Pallas|Apophis/.test(m.name) ? 'Asteroid' : 'Dwarf planet / KBO' }),
      h('b', { text: m.name }), h('p', { text: m.blurb }),
      h('span', { class: 'meta', text: `${m.frames.length} SPHEREx images${last[5] ? ` · now ${last[5].toFixed(2)} au from Earth` : ''}` })));
  }
}
function refreshLiveLayer() {
  const pts = store.pref('livePts') || [];
  if (sky) { sky.points.live = pts; sky.draw(); }
}

// ------------------------------------------------------------------ search
let ssoNames = null;
async function findSSO(name) {
  const js = await getJSON('sso.json');
  const n = name.toLowerCase();
  const r = js.data.find(d => d[0].toLowerCase() === n) || js.data.find(d => shortName(d[0]).toLowerCase() === n);
  return r ? { name: r[0], kind: r[1], e: r[2], q: r[3], i: r[4], om: r[5], w: r[6], tp: r[7], H: r[8] } : null;
}
const shortName = s => s.replace(/^\s*\d+\s+/, '').replace(/\s*\(.*\)$/, '').trim() || s;
async function ssoSuggest(q, limit = 8) {
  if (!ssoNames) {
    try { const js = await getJSON('sso.json'); ssoNames = js.data.map(d => [d[0], d[0].toLowerCase(), d[1], d[8]]); } catch { return []; }
  }
  const n = q.toLowerCase();
  const res = [];
  for (const s of ssoNames) {
    const i = s[1].indexOf(n);
    if (i < 0) continue;
    res.push({ s, score: (i === 0 ? 0 : s[1][i - 1] === ' ' ? 1 : 3) + s[3] / 100 });
    if (res.length > 400) break;
  }
  return res.sort((a, b) => a.score - b.score).slice(0, limit).map(r => r.s);
}

function bindSearch(form, input, box, { onPick, sso = true, fixed = true }) {
  let items = [], sel = -1;
  const close = () => { box.hidden = true; sel = -1; };
  const renderList = () => {
    box.textContent = '';
    items.forEach((it, i) => box.append(h('button', { type: 'button', role: 'option', 'aria-selected': i === sel ? 'true' : 'false', onclick: () => { close(); input.value = it.label; onPick(it); } }, h('span', { text: it.label }), h('span', { class: 'k', text: it.kind }))));
    box.hidden = !items.length;
  };
  const update = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { items = []; renderList(); return; }
    items = [];
    const c = parseCoords(q);
    if (c && fixed) items.push({ label: `${c.ra.toFixed(4)}°, ${c.dec.toFixed(4)}°`, kind: c.galactic ? 'galactic coords' : 'coordinates', go: () => openFixed({ ra: c.ra, dec: c.dec }) });
    const n = q.toLowerCase();
    if (fixed) FEATURED.filter(f => f.name.toLowerCase().includes(n)).slice(0, 5).forEach(f => items.push({ label: f.name, kind: f.tag, go: () => openFixed(f) }));
    (await withMovers()).filter(m => m.name.toLowerCase().includes(n)).forEach(m => items.push({ label: m.name, kind: 'follow its motion', go: () => openMoverRoute(m) }));
    if (fixed && exo) exo.data.filter(e => e[0].toLowerCase().includes(n)).slice(0, 4).forEach(e => items.push({ label: e[0], kind: `${e[4]} exoplanet(s)`, go: () => openFixed({ ra: e[1], dec: e[2], name: e[0] }) }));
    if (sso && /[a-z]/i.test(q) && q.length >= 3) (await ssoSuggest(q, 6)).forEach(s => items.push({ label: shortName(s[0]), kind: s[2] === 'c' ? 'comet · follow it' : 'asteroid · follow it', go: () => openSSORoute({ name: s[0] }) }));
    if (fixed && !c && q.length >= 2) items.push({ label: `Look up “${q}” in astronomical catalogues`, kind: 'SIMBAD / NED', go: () => resolveAndOpen(q) });
    sel = -1;
    renderList();
  }, 180);
  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (fixed) loadExo(); });
  input.addEventListener('keydown', e => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); renderList(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderList(); e.preventDefault(); }
    if (e.key === 'Escape') close();
  });
  document.addEventListener('click', e => { if (!form.contains(e.target)) close(); });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (sel >= 0 && items[sel]) { close(); items[sel].go(); input.blur(); return; }
    close();
    input.blur();
    const c = parseCoords(q);
    if (c && fixed) { openFixed({ ra: c.ra, dec: c.dec }); return; }
    const exact = items.find(it => it.label.toLowerCase() === q.toLowerCase()) || (items.length && items[0].kind !== 'SIMBAD / NED' && items[0].kind !== 'coordinates' ? items[0] : null);
    if (exact) { exact.go(); return; }
    if (fixed) resolveAndOpen(q);
    else if (items[0]) items[0].go();
  });
  return { onPick };
}
async function resolveAndOpen(q) {
  if (!navigator.onLine) { toast('Name lookup needs internet. Try coordinates like “83.8 -5.4”.', 'err'); return; }
  toast(`Looking up “${q}”…`, '', 1800);
  try {
    const r = await resolveName(q);
    if (r) { openFixed({ ra: r.ra, dec: r.dec, name: q }); return; }
    const o = await findSSO(q);
    if (o) { openSSORoute(o); return; }
    toast(`Couldn't find “${q}”. Try another name or coordinates.`, 'err');
  } catch { toast('Name lookup failed. Try coordinates instead.', 'err'); }
}

// ------------------------------------------------------------------ chase
let chaseReady = false;
async function initChase() {
  const ms = await withMovers();
  renderMoverCards($('#moverCards'), ms);
  if (chaseReady) return;
  chaseReady = true;
  bindSearch($('#chaseForm'), $('#chaseQ'), $('#chaseSuggest'), { onPick: () => {}, fixed: false });
}

// ------------------------------------------------------------------ live
let liveLoaded = 0;
async function initLive(force) {
  if (!force && Date.now() - liveLoaded < 5 * 60e3) return;
  liveLoaded = Date.now();
  const stats = $('#liveStats'), per = $('#livePeriods'), fr = $('#liveFrames');
  const stat = (b, t) => h('div', { class: 'stat' }, h('b', { text: b }), h('span', { text: t }));
  per.textContent = ''; per.append(h('div', { class: 'skeleton' }));
  fr.textContent = '';
  if (!navigator.onLine) { per.textContent = 'You are offline. Live data needs a connection.'; return; }
  try {
    const periods = await latestPeriods(5);
    const meta = await getMeta().catch(() => null);
    per.textContent = '';
    const idx = new Map((meta?.spherex?.periods || []).map(p => [p[0], p]));
    for (const p of periods) {
      const [qr, , week] = p.split('/');
      const m = idx.get(week);
      const yr = week.slice(0, 4), wk = +week.slice(5, 7);
      per.append(h('div', { class: 'item' }, h('span', { class: 'pill change', text: qr.toUpperCase() }),
        h('div', { class: 'grow' }, h('b', { text: `Planning period ${week}` }),
          h('span', { class: 't', text: m ? `${fmtInt(m[1])} images · ${fmtDate(m[2], true)} → ${fmtDate(m[3], true)}` : `Week ${wk} of ${yr} · new in the archive, being indexed` }))));
    }
    // newest frames of the newest period (detector 1 list, last page)
    const newest = periods[0];
    const vers = (await s3List(newest)).prefixes;
    const ver = vers[vers.length - 1];
    let objs = [], after;
    for (let i = 0; i < 4; i++) {
      const page = await s3List(ver + '3/', { delimiter: '', max: 1000, after });
      objs = objs.concat(page.objects);
      if (!page.truncated) break;
      after = page.objects[page.objects.length - 1].key;
    }
    const lastMod = objs.reduce((a, o) => Math.max(a, Date.parse(o.modified)), 0);
    stats.textContent = '';
    stats.append(stat(newest.split('/')[2], 'newest planning period in NASA\'s archive'),
      stat(lastMod ? ago(lastMod) : '—', 'newest files arrived'),
      stat(meta ? fmtInt(meta.spherex.frames) : '—', 'images in the SkyShift index'),
      stat(meta ? ago(Date.parse(meta.built)) : '—', 'index last rebuilt'));
    $('#liveNote').textContent = `${fmtInt(objs.length)} band-3 frames listed in ${newest.split('/')[2]}`;
    const pick = objs.slice(-8).reverse();
    for (const o of pick) liveCard(fr, o);
  } catch (e) {
    per.textContent = 'Could not reach NASA\'s archive right now. Try again shortly.';
    console.warn(e);
  }
}
function liveCard(box, o) {
  const f = parseKey(o.key);
  if (!f) return;
  const cv = h('canvas', { width: 64, height: 64 });
  const pos = h('span', { class: 'muted', text: '' });
  const btn = h('button', { class: 'btn', type: 'button', text: 'Develop' });
  const openBtn = h('button', { class: 'btn', type: 'button', text: 'Open this spot', hidden: true });
  const card = h('div', { class: 'lf' }, cv, h('div', { class: 'lf-b' }, h('b', { text: `${f.week}_${String(f.ls).padStart(4, '0')}_${f.ss} D${f.det}` }),
    h('span', { class: 'muted', text: `arrived ${ago(Date.parse(o.modified))} · ${fmtBytes(o.size)}` }), pos, btn, openBtn));
  box.append(card);
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Developing…';
    try {
      const r = await quicklook(o.key);
      const l = R.levels(r.data, 'sky', [2, 99.7]);
      R.paint(cv.getContext('2d'), r.w, R.scaleTo8(R.fillHoles(r.data, r.w), { lo: l.lo, hi: l.hi, stretch: 'asinh' }), 'inferno');
      pos.textContent = `${r.ra.toFixed(2)}°, ${r.dec.toFixed(2)}° · ${(r.date || '').replace('T', ' ').slice(0, 16)} UTC`;
      btn.hidden = true; openBtn.hidden = false;
      openBtn.onclick = () => openFixed({ ra: r.ra, dec: r.dec, name: `Newest frame ${f.week}` });
      const pts = (store.pref('livePts') || []).filter(p => p.key !== o.key).slice(-30);
      pts.push({ key: o.key, ra: r.ra, dec: r.dec, date: (r.date || '').slice(0, 10) });
      store.pref('livePts', pts);
      refreshLiveLayer();
    } catch (e) { btn.disabled = false; btn.textContent = 'Retry'; toast('Could not read that frame: ' + e.message, 'err'); }
  };
}
let qlWorker = null, qlSeq = 0;
function quicklook(key) {
  return new Promise((res, rej) => {
    try { qlWorker = qlWorker || new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); } catch { qlWorker = null; }
    if (!qlWorker) { import('./fits.js').then(m => m.quicklook(key)).then(r => res({ data: r.data, w: r.w, ra: r.ra, dec: r.dec, date: r.cards['DATE-AVG'] })).catch(rej); return; }
    const job = 'ql' + (++qlSeq);
    const onm = ev => {
      if (ev.data.job !== job) return;
      qlWorker.removeEventListener('message', onm);
      if (ev.data.type === 'quicklook') res(ev.data.r); else rej(new Error(ev.data.error));
    };
    qlWorker.addEventListener('message', onm);
    qlWorker.postMessage({ cmd: 'quicklook', job, key, rows: 256, bin: 4 });
  });
}

// ------------------------------------------------------------------ mission
let missionLoaded = false;
async function initMission() {
  if (missionLoaded) return;
  missionLoaded = true;
  const stats = $('#missionStats');
  const stat = (b, t) => h('div', { class: 'stat' }, h('b', { text: b }), h('span', { text: t }));
  try {
    const m = await getMeta();
    const s = m.spherex;
    stats.append(stat(fmtInt(s.frames), 'spectral images (6 per pointing)'), stat(fmtInt(s.exposures), 'telescope pointings'),
      stat(`${Math.round(s.skyFraction * 100)}%`, 'of the sky imaged'), stat(Math.round(s.lastMjd - s.firstMjd) + ' days', 'of observations indexed'),
      stat(fmtShortDate(s.firstMjd), 'first survey image'), stat(fmtShortDate(s.lastMjd), 'latest image indexed'),
      stat(String((s.periods || []).length), 'planning periods'), stat('102', 'infrared colours (0.75–5 µm)'));
    bars($('#perDay'), { data: s.perDay.map(([d, n]) => [d, n]), xfmt: d => fmtDate(d), yfmt: v => fmtInt(Math.round(v)), label: 'SPHEREx images per day', color: 'var(--accent2)' });
    const bi = $('#bandInfo');
    const mx = Math.max(...s.perBand);
    for (let d = 1; d <= 6; d++) {
      const b = BANDS[d];
      const bar = h('div', { class: 'band-bar', style: { width: `${(100 * s.perBand[d - 1] / mx).toFixed(1)}%`, background: waveColor((b.lo + b.hi) / 2) } });
      bi.append(h('div', { class: 'band-row' }, h('b', { text: `Band ${d}` }), h('div', {}, bar, h('span', { class: 'muted small', text: `${b.lo}–${b.hi} µm · resolving power ${b.R}` })), h('span', { class: 'small', text: fmtInt(s.perBand[d - 1]) })));
    }
    bi.append(h('p', { class: 'muted small', text: 'Bands 1–3 (0.75–2.4 µm) see starlight and hot dust. Bands 4–6 (2.4–5 µm) catch ices of water, CO₂ and CO, and cool brown dwarfs.' }));
    const ds = $('#dataStatus');
    const row = (k, v, cls) => ds.append(h('div', { class: 'status-row' }, h('span', { text: k }), h('span', { class: cls, text: v })));
    row('Index rebuilt', `${ago(Date.parse(m.built))} (${m.built.replace('T', ' ').slice(0, 16)} UTC)`, 'ok');
    const names = { spherex: 'SPHEREx catalogue (IRSA TAP)', sso: 'Asteroid & comet orbits (JPL SBDB)', exoplanets: 'NASA Exoplanet Archive', cad: 'Close approaches (JPL CNEOS)', news: 'NASA SPHEREx news', images: 'NASA Image Library', movers: 'Ephemerides (JPL Horizons)' };
    for (const [k, v] of Object.entries(m.status || {})) row(names[k] || k, v === 'ok' ? 'fresh ✓' : v, v === 'ok' ? 'ok' : 'warn');
    row('SPHEREx pixels', 'read live from NASA\'s archive by your browser', 'ok');
    ds.append(h('p', { class: 'muted small', text: 'An automated job on GitHub\'s servers refreshes everything every 6 hours, so it doesn\'t depend on any personal computer. Images always stream fresh from NASA.' }));
  } catch {
    stats.append(stat('—', 'Mission statistics unavailable offline'));
  }
  // news: live first, fallback to pipeline copy
  const newsBox = $('#news');
  try {
    let items, src = 'live from NASA.gov';
    try { items = await liveNews(); } catch { items = (await getJSON('news.json')).items; src = 'cached copy'; }
    $('#newsSrc').textContent = src;
    for (const n of items.slice(0, 9)) {
      if (!/^https:\/\/(www\.)?nasa\.gov\//.test(n.link)) continue;
      newsBox.append(h('a', { href: n.link, target: '_blank', rel: 'noopener' },
        n.image && /^https:\/\/(www|science)\.nasa\.gov\//.test(n.image) ? h('img', { src: n.image, alt: '', loading: 'lazy' }) : null,
        h('div', { class: 'nb' }, h('b', { text: n.title }), h('span', { text: n.date ? new Date(n.date).toDateString() : '' }), h('p', { text: n.summary }))));
    }
  } catch { newsBox.textContent = 'News unavailable offline.'; }
  const gal = $('#gallery');
  try {
    let items, src = 'live from images.nasa.gov';
    try { items = await liveImages(); } catch { items = (await getJSON('images.json')).items; src = 'cached copy'; }
    $('#imgSrc').textContent = src;
    for (const im of items.slice(0, 24)) {
      if (!/^https:\/\/images-assets\.nasa\.gov\//.test(im.thumb)) continue;
      gal.append(h('a', { href: `https://images.nasa.gov/details/${encodeURIComponent(im.id)}`, target: '_blank', rel: 'noopener', title: im.desc },
        h('figure', {}, h('img', { src: im.thumb, alt: im.title, loading: 'lazy' }), h('figcaption', { text: `${im.title} · ${im.date}` }))));
    }
  } catch { gal.textContent = 'Images unavailable offline.'; }
  try {
    const cad = await getJSON('cad.json');
    const t = h('table', {}, h('thead', {}, h('tr', {}, ...['Object', 'Closest approach (UTC)', 'Distance', 'Speed', 'Size'].map(x => h('th', { text: x })))));
    const tb = h('tbody');
    for (const r of cad.data.slice(0, 25)) {
      const ld = (+r.dist * 389.17).toFixed(1);
      const size = r.diameter ? `${(+r.diameter * 1000).toFixed(0)} m` : r.h ? `~${Math.round(1329 / Math.sqrt(0.14) * 10 ** (-0.2 * r.h) * 1000)} m` : '—';
      tb.append(h('tr', {}, h('td', {}, h('a', { href: `https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=${encodeURIComponent(r.des)}`, target: '_blank', rel: 'noopener', text: (r.fullname || r.des).trim() })),
        h('td', { text: r.cd }), h('td', { text: `${ld} × Moon distance` }), h('td', { text: `${(+r.v_rel).toFixed(1)} km/s` }), h('td', { text: size })));
    }
    t.append(tb);
    $('#cad').append(t);
  } catch { $('#cad').textContent = 'Close-approach list unavailable offline.'; }
}

// ------------------------------------------------------------------ saved
async function renderSaved() {
  const list = $('#savedList'), finds = $('#findsList');
  list.textContent = ''; finds.textContent = '';
  const saved = (await store.all('saved')) || [];
  if (!saved.length) list.append(h('p', { class: 'muted', text: 'Nothing saved yet. Open any target and press “Save offline”.' }));
  for (const s of saved.sort((a, b) => b.savedAt.localeCompare(a.savedAt))) {
    const open = () => {
      if (s.kind === 'mover') { if (s.moverId) go('#/tm?mover=' + encodeURIComponent(s.moverId)); else go('#/tm?sso=' + encodeURIComponent(s.sso.name)); } else openFixed(s);
    };
    list.append(h('div', { class: 'item' }, s.thumb ? h('img', { src: s.thumb, alt: '', width: 48, height: 48, style: { borderRadius: '8px', imageRendering: 'pixelated' } }) : null,
      h('div', { class: 'grow' }, h('b', { text: s.name }), h('span', { class: 't', text: `${s.n} images · saved ${new Date(s.savedAt).toLocaleDateString()}` })),
      h('button', { class: 'btn sm', type: 'button', text: 'Open', onclick: open }),
      h('button', { class: 'btn sm danger', type: 'button', text: 'Remove', onclick: async () => { await store.del('saved', s.key); renderSaved(); } })));
  }
  const fs = (await store.all('finds')) || [];
  if (!fs.length) finds.append(h('p', { class: 'muted', text: 'No finds yet. Use the Hunt tab in the Time Machine and press ★ on a candidate.' }));
  for (const f of fs) {
    finds.append(h('div', { class: 'item' }, h('span', { class: 'pill cand', text: f.kind === 'change' ? 'CHANGE' : 'MOVER' }),
      h('div', { class: 'grow' }, h('b', { text: `${f.target}: ${f.note}` }), h('span', { class: 't', text: `${f.ra.toFixed(5)}°, ${f.dec.toFixed(5)}°${f.date ? ' · ' + f.date : ''} · S/N ${f.snr.toFixed(0)}` })),
      h('button', { class: 'btn sm', type: 'button', text: 'Open', onclick: () => openFixed({ ra: f.ra, dec: f.dec, name: `Find near ${f.target}` }) }),
      h('button', { class: 'btn sm danger', type: 'button', text: '✕', title: 'Delete', onclick: async () => { await store.del('finds', f.id); renderSaved(); } })));
  }
  const est = await store.usage();
  const keys = (await store.keys('cutouts')) || [];
  $('#storageInfo').textContent = `${fmtInt(keys.length)} SPHEREx cutouts cached on this device` + (est ? ` · ${fmtBytes(est.usage || 0)} used of ${fmtBytes(est.quota || 0)} available` : '');
}

// ------------------------------------------------------------------ install / SW
let deferredPrompt = null;
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function browserInfo() {
  const ua = navigator.userAgent, brands = (navigator.userAgentData?.brands || []).map(b => b.brand).join(' ');
  const android = /Android/i.test(ua);
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const other = /SamsungBrowser|OPR|Opera|EdgA|Edg\/|Firefox|FxiOS|Brave|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser|HeyTapBrowser|VivoBrowser|DuckDuckGo|; wv\)/i.test(ua) || /Brave|Opera|Edge/i.test(brands);
  const chrome = /Chrome\//.test(ua) && !other;
  let name = 'this browser';
  if (/SamsungBrowser/.test(ua)) name = 'Samsung Internet';
  else if (/OPR|Opera/.test(ua)) name = 'Opera';
  else if (/EdgA|Edg\//.test(ua)) name = 'Edge';
  else if (/Firefox/.test(ua)) name = 'Firefox';
  else if (/Brave/i.test(brands)) name = 'Brave';
  else if (chrome) name = 'Chrome';
  return { ua, android, ios, chrome, name };
}
function setupInstall() {
  const btn = $('#installBtn');
  if (isStandalone()) btn.hidden = true;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferredPrompt = e; btn.hidden = false;
    // arrived here from "Install with Chrome": offer the one-tap install right away
    if (new URLSearchParams(location.search).has('install') && !isStandalone()) setTimeout(() => showInstall(true), 600);
  });
  window.addEventListener('appinstalled', () => { btn.hidden = true; deferredPrompt = null; toast('SkyShift installed! Find it on your home screen or app list.', 'ok'); });
  btn.onclick = () => showInstall();
}
async function promptInstall() {
  const d = $('#dlgInstall'); if (d.open) d.close();
  if (!deferredPrompt) return false;
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch { /* dismissed */ }
  deferredPrompt = null;
  return true;
}
async function showInstall(fromChrome) {
  const B = browserInfo();
  // Chrome (and desktop browsers) with an install prompt: install in one tap
  if (deferredPrompt && (B.chrome || !B.android) && !fromChrome) { await promptInstall(); return; }
  const steps = $('#installSteps');
  steps.textContent = '';
  const p = (t, cls) => steps.append(h('p', { class: cls, text: t }));
  const big = (label, sub, onclick, href, primary) => {
    const el = h(href ? 'a' : 'button', { class: 'install-opt' + (primary ? ' primary' : ''), type: href ? undefined : 'button', href, onclick }, h('b', { text: label }), h('span', { text: sub }));
    steps.append(el);
    return el;
  };
  if (isStandalone()) { p('SkyShift is already installed and running as an app on this device. ✓'); $('#dlgInstall').showModal(); return; }
  if (B.android) {
    if (deferredPrompt && (B.chrome || fromChrome)) {
      big('Install SkyShift', 'One tap · installs through Chrome, built for the latest Android', () => promptInstall(), null, true);
    } else if (B.chrome) {
      p('Open Chrome\'s menu ⋮ (top right) and tap “Install app” (or “Add to Home screen” → Install).');
    } else if (B.name === 'Firefox') {
      p('In Firefox: open the menu ⋮ and tap “Add to Home screen”, then “Add”. Firefox adds SkyShift as a home-screen app shortcut, with no warnings.');
      const intent = `intent://${location.host}${location.pathname}?install=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(location.href)};end`;
      big('Or install with Chrome', 'Opens SkyShift in Chrome with a one-tap Install', null, intent);
    } else {
      // other browsers build an old-style app wrapper that Android warns about: hand over to Chrome
      const url = new URL(location.href);
      url.hash = ''; url.search = '?install=1';
      const intent = `intent://${url.host}${url.pathname}?install=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(location.href)};end`;
      p(`${B.name} builds installed apps from an old Android template, which is why Android shows a warning. Installing through Chrome avoids it completely.`, 'small muted');
      big('Install with Chrome', 'Recommended · opens SkyShift in Chrome with a one-tap Install, no warnings', null, intent, true);
      p(`No Chrome on this phone? Add SkyShift as a home-screen shortcut instead (also warning-free): ${B.name === 'Samsung Internet' ? 'tap the menu ≡ → “Add page to” → “Home screen”.' : B.name === 'Firefox' ? 'tap the menu ⋮ → “Add to Home screen”.' : 'open the browser menu and choose “Add to Home screen”, and if offered pick “Shortcut” rather than “Install”.'}`);
    }
    // secondary: native app file
    try {
      const r = await fetch('download/skyshift.apk.sha256', { cache: 'no-store' });
      const sha = r.ok ? (await r.text()).trim() : '';
      if (/^[0-9a-f]{64}$/.test(sha)) {
        const more = h('details', { class: 'install-more' }, h('summary', { text: 'Other options' }));
        const a = h('a', { class: 'install-opt', href: 'download/skyshift.apk', download: 'SkyShift.apk' }, h('b', { text: '⬇ Android app file' }), h('span', { text: 'For phones without Chrome · 1.5 MB · built for Android 16, runs on Android 5+' }));
        more.append(a, h('p', { class: 'tiny muted', text: 'SHA-256: ' + sha }));
        steps.append(more);
      }
    } catch { /* offline */ }
  } else if (B.ios) {
    const crios = /CriOS|EdgiOS/.test(B.ua), other = /FxiOS|OPiOS|mercury|GSA/.test(B.ua);
    const m = B.ua.match(/OS (\d+)_(\d+)/), ver = m ? parseFloat(m[1] + '.' + m[2]) : 0;
    if (other || (crios && ver && ver < 16.4)) {
      p('To install on iPhone or iPad, open this page in Safari. iOS installs web apps from Safari, and from Chrome or Edge on iOS 16.4 and newer.');
      big('Copy link to open in Safari', location.href.split('#')[0], async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied. Paste it in Safari.', 'ok'); } catch { /* ignore */ } });
    }
    p('1. Tap the Share button ' + (crios ? '(in the address bar)' : '(the square with an arrow ⬆︎)') + '.');
    p('2. Scroll down and tap “Add to Home Screen”.');
    p('3. Tap “Add”. SkyShift appears on your home screen, opens full-screen and works offline, on every iPhone and iPad from iOS 11.3 onwards.');
  } else {
    if (/Safari/.test(B.ua) && /Mac/.test(B.ua) && !/Chrome|Chromium|Edg/.test(B.ua)) p('In Safari on Mac: choose File → “Add to Dock”.');
    else if (/Firefox/.test(B.ua)) p('Firefox on desktop does not install web apps. Open this page in Chrome, Edge or Safari to install; SkyShift still works offline in Firefox after your first visit.');
    else p('Click the install icon at the right end of the address bar, or open the browser menu and choose “Install SkyShift”.');
  }
  $('#dlgInstall').showModal();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw?.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('A new version of SkyShift is ready.', 'ok', 12000, { label: 'Update', fn: () => { nw.postMessage('skipWaiting'); } });
        }
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60e3);
  }).catch(() => {});
  // reload only when an updated worker replaces an existing one (not on first install)
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    // apply the update right away unless images are still streaming in
    const busy = () => !document.querySelector('#progress')?.hidden;
    const go = () => (busy() ? setTimeout(go, 2000) : location.reload());
    go();
  });
}

// ------------------------------------------------------------------ settings, tour, keys
function setupSettings() {
  const d = $('#dlgSettings');
  $('#settingsBtn').onclick = () => {
    $('#setSize').value = settings.size; $('#setMax').value = settings.max; $('#setMask').checked = settings.mask; $('#setMotion').checked = settings.reduceMotion; $('#setMode').value = settings.mode;
    const est = () => {
      const rows = +$('#setSize').value + 6, mode = $('#setMode').value;
      const saverB = rows * (rows * 4 + 900), fastB = rows * 8160, n = Math.min(+$('#setMax').value, 200);
      const avg = mode === 'saver' ? saverB : mode === 'fast' ? fastB : (Math.min(8, n) * fastB + Math.max(0, n - 8) * saverB) / n;
      const per = 30000 + avg * ($('#setMask').checked ? 1.8 : 1);
      $('#dataUse').textContent = `About ${fmtBytes(per)} per image, so roughly ${fmtBytes(per * Math.min(+$('#setMax').value, 200))} for a full target. Images are cached on this device, so you only download them once.`;
    };
    ['#setSize', '#setMode', '#setMask', '#setMax'].forEach(id => { $(id).onchange = est; });
    est();
    d.showModal();
  };
  d.addEventListener('close', () => {
    const before = JSON.stringify([settings.size, settings.max, settings.mask]);
    settings.size = +$('#setSize').value; settings.max = +$('#setMax').value; settings.mask = $('#setMask').checked; settings.reduceMotion = $('#setMotion').checked; settings.mode = $('#setMode').value;
    for (const k of ['size', 'mask', 'reduceMotion', 'mode']) store.pref(k, settings[k]);
    store.pref('max2', settings.max);
    if (before !== JSON.stringify([settings.size, settings.max, settings.mask]) && tmCurrent()) {
      const t = tmCurrent().target;
      toast('Settings saved. Reloading the current target.', 'ok');
      if (t.kind === 'fixed') openTarget(t); else route();
    }
  });
}
function showTour() {
  const d = $('#dlgTour');
  let i = 0;
  const steps = $$('.tour-step', d);
  const dots = $('#tourDots');
  const upd = () => {
    steps.forEach((s, k) => { s.hidden = k !== i; });
    dots.textContent = '';
    steps.forEach((s, k) => dots.append(h('i', { class: k === i ? 'on' : '' })));
    $('#tourNext').textContent = i === steps.length - 1 ? 'Start exploring' : 'Next';
  };
  $('#tourNext').onclick = () => { if (i < steps.length - 1) { i++; upd(); } else d.close(); };
  d.addEventListener('close', () => store.pref('toured', true), { once: true });
  upd();
  d.showModal();
}
function bindShell() {
  bindSearch($('#searchForm'), $('#q'), $('#suggest'), { onPick: () => {} });
  $('#themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  setupInstall();
  setupSettings();
  $('#replayTour').onclick = showTour;
  $('#liveRefresh').onclick = () => initLive(true);
  $('#persistBtn').onclick = async () => toast((await store.persist()) ? 'This device will keep SkyShift data.' : 'Your browser decides storage automatically.', 'ok');
  $('#clearCache').onclick = async () => {
    const ks = (await store.keys('cutouts')) || [];
    for (const k of ks) await store.del('cutouts', k);
    toast('Cached images cleared', 'ok'); renderSaved();
  };
  $('#findsExport').onclick = async () => {
    const fs = (await store.all('finds')) || [];
    const rows = [['target', 'kind', 'note', 'ra_deg', 'dec_deg', 'date_utc', 'wavelength_um', 'snr', 'frame']];
    for (const f of fs) rows.push([f.target, f.kind, f.note, f.ra.toFixed(6), f.dec.toFixed(6), f.date || '', f.wave ? f.wave.toFixed(4) : '', f.snr.toFixed(1), f.frame || ''].map(v => `"${String(v).replace(/"/g, '""')}"`));
    download(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }), 'skyshift-finds.csv');
  };
  const net = () => { $('#netBadge').hidden = navigator.onLine; };
  window.addEventListener('online', () => { net(); toast('Back online', 'ok', 2000); });
  window.addEventListener('offline', () => { net(); toast('Offline: saved targets and the app still work.', '', 4000); });
  net();
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
    if (currentView === 'tm' && tmKey(e)) e.preventDefault();
  });
  window.addEventListener('resize', debounce(() => { if (currentView === 'tm') tmRender(); }, 200));
}

void frameKey;
boot();
