// SkyShift - data access with redundancy.
// Order of sources for pipeline products: this site -> jsDelivr CDN mirror of
// the repository's `data` branch -> raw GitHub.  The service worker adds an
// offline cache on top, so the app keeps working with no network at all.

export const REPO = 'samuelakosaonyejekwe/skyshift';
const MIRRORS = [
  'data/',
  `https://cdn.jsdelivr.net/gh/${REPO}@data/`,
  `https://raw.githubusercontent.com/${REPO}/data/`,
];
export const S3_LIST = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/?list-type=2';

async function fetchAny(path, as = 'json', { mirrors = true, timeout = 15000 } = {}) {
  const list = mirrors ? MIRRORS : MIRRORS.slice(0, 1);
  let last;
  for (const base of list) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(base + path, { signal: ctl.signal });
      if (!r.ok) throw new Error(`${r.status} ${base}${path}`);
      const v = as === 'json' ? await r.json() : await r.arrayBuffer();
      clearTimeout(t);
      return v;
    } catch (e) { clearTimeout(t); last = e; }
  }
  throw last;
}

const memo = new Map();
export function getJSON(name, opts) {
  if (!memo.has(name)) memo.set(name, fetchAny(name, 'json', opts).catch(e => { memo.delete(name); throw e; }));
  return memo.get(name);
}
export const getMeta = () => getJSON('meta.json');
export function getBin(name, opts) {
  if (!memo.has(name)) memo.set(name, fetchAny(name, 'buffer', opts).catch(e => { memo.delete(name); throw e; }));
  return memo.get(name);
}

// ---------------------------------------------------------------- tiles
// Geometry and epoch come from meta.json (written by tools/build_data.py);
// the defaults below are only used before it has loaded.
let MJD0 = 60780.0;
let TILE_DEG = 3.0;
let TILE_SET = null;     // ids of tiles that exist (meta.tiles), to skip empty sky
const NBANDS = () => Math.round(180 / TILE_DEG);
const bandCount = b => Math.max(1, Math.round(360 * Math.cos((-90 + (b + 0.5) * TILE_DEG) * Math.PI / 180) / TILE_DEG));
export const FRAME_RADIUS = 2.47;

const tileCache = new Map();
function parseTile(buf) {
  const dv = new DataView(buf);
  let o = 4;
  const np = dv.getUint16(o, true); o += 2;
  const paths = [];
  const td = new TextDecoder();
  for (let i = 0; i < np; i++) {
    const n = dv.getUint8(o); o += 1;
    const [qr, week, ver] = td.decode(new Uint8Array(buf, o, n)).split('|');
    paths.push({ qr, week, ver }); o += n;
  }
  const nr = dv.getUint32(o, true); o += 4;
  const rows = new Array(nr);
  for (let i = 0; i < nr; i++, o += 18) {
    const p = paths[dv.getUint16(o, true)];
    rows[i] = {
      qr: p.qr, week: p.week, ver: p.ver,
      ls: dv.getUint16(o + 2, true), ss: dv.getUint8(o + 4), det: dv.getUint8(o + 5),
      ra: dv.getInt32(o + 6, true) / 1e6, dec: dv.getInt32(o + 10, true) / 1e6,
      mjd: MJD0 + dv.getUint32(o + 14, true) / 1e5,
    };
  }
  return rows;
}
function loadTile(id) {
  if (TILE_SET && !TILE_SET.has(id)) return Promise.resolve([]);
  if (!tileCache.has(id)) {
    tileCache.set(id, fetchAny(`tiles/${id}.bin`, 'buffer', { mirrors: true, timeout: 20000 })
      .then(parseTile)
      .catch(e => { tileCache.delete(id); if (String(e).includes('404')) return []; throw e; }));
  }
  return tileCache.get(id);
}

function sepDeg(ra1, de1, ra2, de2) {
  const r = Math.PI / 180;
  const s = Math.sin((de1 - de2) * r / 2) ** 2 + Math.cos(de1 * r) * Math.cos(de2 * r) * Math.sin((ra1 - ra2) * r / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(s))) / r;
}

export function tilesNear(ra, dec, radius) {
  const ids = [];
  const nb = NBANDS();
  for (let b = 0; b < nb; b++) {
    const lo = -90 + b * TILE_DEG, hi = lo + TILE_DEG;
    if (hi < dec - radius || lo > dec + radius) continue;
    const n = bandCount(b);
    const maxAbs = Math.min(89.999, Math.max(Math.abs(lo), Math.abs(hi), Math.abs(dec) + radius));
    if (Math.abs(dec) + radius >= 89.9 || n <= 2) { for (let i = 0; i < n; i++) ids.push(`${b}_${i}`); continue; }
    const dra = radius / Math.cos(maxAbs * Math.PI / 180);
    if (dra >= 180) { for (let i = 0; i < n; i++) ids.push(`${b}_${i}`); continue; }
    const i0 = Math.floor(((ra - dra) % 360 + 360) % 360 / 360 * n);
    const span = Math.ceil(2 * dra / 360 * n) + 1;
    for (let k = 0; k <= span && k < n; k++) ids.push(`${b}_${(i0 + k) % n}`);
  }
  return [...new Set(ids)];
}

// All SPHEREx frames whose centre is within `radius` of (ra, dec).
export async function framesNear(ra, dec, radius = FRAME_RADIUS) {
  try {
    const m = await getMeta();
    if (m.tileDeg) TILE_DEG = m.tileDeg;
    if (m.mjd0) MJD0 = m.mjd0;
    if (m.tiles && !TILE_SET) TILE_SET = new Set(Object.keys(m.tiles));
  } catch { /* offline: defaults */ }
  const ids = tilesNear(ra, dec, radius);
  const all = await Promise.all(ids.map(id => loadTile(id).catch(() => [])));
  const out = [];
  for (const rows of all) for (const f of rows) {
    const d = sepDeg(ra, dec, f.ra, f.dec);
    if (d < radius) { f.sep = d; out.push(f); }
  }
  out.sort((a, b) => a.mjd - b.mjd);
  return out;
}

// ---------------------------------------------------------------- live S3
export async function s3List(prefix, { delimiter = '/', max = 1000, after } = {}) {
  let url = `${S3_LIST}&prefix=${encodeURIComponent(prefix)}&max-keys=${max}`;
  if (delimiter) url += `&delimiter=${encodeURIComponent(delimiter)}`;
  if (after) url += `&start-after=${encodeURIComponent(after)}`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('S3 ' + r.status);
  const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
  const txt = (el, t) => el.getElementsByTagName(t)[0]?.textContent || '';
  return {
    prefixes: [...xml.getElementsByTagName('CommonPrefixes')].map(e => txt(e, 'Prefix')),
    objects: [...xml.getElementsByTagName('Contents')].map(e => ({
      key: txt(e, 'Key'), size: +txt(e, 'Size'), modified: txt(e, 'LastModified'),
    })),
    truncated: txt(xml, 'IsTruncated') === 'true',
  };
}

// Newest planning periods directly from NASA's archive bucket.
export async function latestPeriods(n = 4) {
  const res = [];
  for (const qr of ['qr3', 'qr2']) {
    try { res.push(...(await s3List(`${qr}/level2/`)).prefixes); } catch { /* ignore */ }
  }
  return res.sort((a, b) => a.split('/')[2].localeCompare(b.split('/')[2])).slice(-n).reverse();
}

const KEY_RE = /^(qr\d*)\/level2\/(\d{4}W\d{2}_\w{2})\/(l2b-[^/]+)\/(\d)\/level2_\2_(\d{4})_(\d)D\4_spx_\3\.fits$/;
export function parseKey(key) {
  const m = key.match(KEY_RE);
  if (!m) return null;
  return { qr: m[1], week: m[2], ver: m[3], det: +m[4], ls: +m[5], ss: +m[6] };
}

// ---------------------------------------------------------------- live NASA
export async function liveNews() {
  const r = await fetch('https://www.nasa.gov/missions/spherex/feed/', { cache: 'no-store' });
  if (!r.ok) throw new Error('news ' + r.status);
  const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
  return [...xml.getElementsByTagName('item')].slice(0, 30).map(it => {
    const g = t => it.getElementsByTagName(t)[0]?.textContent?.trim() || '';
    const enc = it.getElementsByTagNameNS('http://purl.org/rss/1.0/modules/content/', 'encoded')[0]?.textContent || '';
    const img = (enc.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))/i) || [])[1] || '';
    const tmp = new DOMParser().parseFromString(g('description'), 'text/html');
    return { title: g('title'), link: g('link'), date: g('pubDate'), summary: (tmp.body.textContent || '').trim().slice(0, 320), image: img };
  });
}

export async function liveImages() {
  const r = await fetch('https://images-api.nasa.gov/search?q=SPHEREx&media_type=image', { cache: 'no-store' });
  if (!r.ok) throw new Error('images ' + r.status);
  const js = await r.json();
  return (js.collection?.items || []).slice(0, 60).map(it => {
    const d = (it.data || [{}])[0];
    return {
      id: d.nasa_id, title: d.title, date: (d.date_created || '').slice(0, 10), center: d.center,
      desc: (d.description || '').slice(0, 400), thumb: (it.links || []).find(l => l.rel === 'preview')?.href || '',
    };
  });
}

// Name resolver: CDS Sesame (SIMBAD, NED, VizieR).
export async function resolveName(q) {
  const r = await fetch(`https://cds.unistra.fr/cgi-bin/nph-sesame/-oJ/SNV?${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('resolver ' + r.status);
  const t = await r.text();
  const m = t.match(/%J\s+([\d.+-]+)\s+([\d.+-]+)/);
  if (!m) return null;
  const typ = (t.match(/%C\.0\s+(.+)/) || [])[1] || '';
  return { ra: +m[1], dec: +m[2], name: q, type: typ.trim() };
}
