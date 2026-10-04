// SkyShift - tiny IndexedDB key/value store (works offline, survives reloads).
const DB = 'skyshift', VER = 1, STORES = ['cutouts', 'saved', 'finds'];
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open(DB, VER); } catch (e) { rej(e); return; }
    r.onupgradeneeded = () => { for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  })).catch(() => undefined);
}
export const get = (store, k) => tx(store, 'readonly', s => s.get(k));
export const put = (store, k, v) => tx(store, 'readwrite', s => s.put(v, k));
export const del = (store, k) => tx(store, 'readwrite', s => s.delete(k));
export const keys = store => tx(store, 'readonly', s => s.getAllKeys());
export const all = store => tx(store, 'readonly', s => s.getAll());
export async function usage() {
  try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
}
export async function persist() {
  try { return await navigator.storage.persist(); } catch { return false; }
}
// local settings (synchronous, tiny)
export function pref(k, v) {
  try {
    if (v === undefined) { const s = localStorage.getItem('ss.' + k); return s == null ? undefined : JSON.parse(s); }
    localStorage.setItem('ss.' + k, JSON.stringify(v));
  } catch { /* private mode */ }
  return v;
}
