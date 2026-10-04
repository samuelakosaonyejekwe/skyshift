"""
SkyShift - pre-built "target packs".

For every featured target and featured moving object, cut the same 64x64
SPHEREx images the browser would (identical TAN grid, north up / east left,
bilinear resampling, WCS-WAVE wavelengths) and store them in one small file.
Opening a featured target in the app then costs a single quick download
instead of hundreds of range requests to the archive.

File format (little endian):
    b"SXP2" | u32 json_len | json (utf-8, padded to 4 bytes) | float16[N*N] per image
"""
import concurrent.futures as cf
import json
import math
import os
import re
import struct
import urllib.request

import numpy as np

S3 = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/"
BLOCK = 2880
NPIX = 2040
SIZE = 64
SCALE = 6.15
PER_TARGET = 24
D2R = math.pi / 180


def _get(url, a=None, b=None, suffix=None, tries=4):
    h = {"User-Agent": "SkyShift-packs/1.0"}
    if suffix:
        h["Range"] = f"bytes=-{suffix}"
    elif a is not None:
        h["Range"] = f"bytes={a}-{b}"
    last = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def parse_header(buf, off=0):
    cards = {}
    i = off
    while i + 80 <= len(buf):
        c = buf[i:i + 80].decode("latin1")
        k = c[:8].strip()
        if k == "END":
            return cards, int(math.ceil((i + 80 - off) / BLOCK) * BLOCK)
        if c[8:10] == "= ":
            v = c[10:]
            if v.lstrip().startswith("'"):
                m = re.match(r"\s*'((?:[^']|'')*)'", v)
                cards[k] = m.group(1).replace("''", "'").strip() if m else ""
            else:
                v = v.split("/")[0].strip()
                if v in ("T", "F"):
                    cards[k] = v == "T"
                else:
                    try:
                        cards[k] = float(v.replace("D", "E"))
                    except ValueError:
                        cards[k] = v
        i += 80
    return None, None


def data_size(c):
    if not c.get("NAXIS"):
        return 0
    n = 1
    for a in range(1, int(c["NAXIS"]) + 1):
        n *= int(c[f"NAXIS{a}"])
    return abs(int(c["BITPIX"])) // 8 * (n + int(c.get("PCOUNT", 0))) * int(c.get("GCOUNT", 1))


def pad(n):
    return int(math.ceil(n / BLOCK) * BLOCK)


def image_header(url):
    size = 10 * BLOCK
    while True:
        buf = _get(url, 0, size - 1)
        prim, plen = parse_header(buf, 0)
        if prim is not None:
            off = plen + pad(data_size(prim))
            img, ilen = parse_header(buf, off)
            if img is not None:
                return img, off + ilen
        size *= 2
        if size > 2_000_000:
            raise RuntimeError("header too large")


class WCS:
    def __init__(self, c):
        d1, d2 = c.get("CDELT1", 1.0), c.get("CDELT2", 1.0)
        if "CD1_1" in c:
            self.cd = np.array([[c["CD1_1"], c.get("CD1_2", 0)], [c.get("CD2_1", 0), c["CD2_2"]]])
        else:
            self.cd = np.array([[c.get("PC1_1", 1) * d1, c.get("PC1_2", 0) * d1], [c.get("PC2_1", 0) * d2, c.get("PC2_2", 1) * d2]])
        self.icd = np.linalg.inv(self.cd)
        self.crpix = (c["CRPIX1"] - 1, c["CRPIX2"] - 1)
        self.ra0, self.dec0 = c["CRVAL1"] * D2R, c["CRVAL2"] * D2R

        def sip(p, order):
            if not order:
                return []
            return [(i, j, c[f"{p}_{i}_{j}"]) for i in range(int(order) + 1) for j in range(int(order) + 1 - i) if c.get(f"{p}_{i}_{j}")]
        self.A, self.B = sip("A", c.get("A_ORDER")), sip("B", c.get("B_ORDER"))
        self.AP, self.BP = sip("AP", c.get("AP_ORDER")), sip("BP", c.get("BP_ORDER"))
        self.cards = c

    @staticmethod
    def poly(t, u, v):
        s = np.zeros_like(u)
        for i, j, c in t:
            s = s + c * u ** i * v ** j
        return s

    def sky2pix(self, ra, dec):
        r, d = np.radians(ra), np.radians(dec)
        sd0, cd0 = math.sin(self.dec0), math.cos(self.dec0)
        dr = r - self.ra0
        cosc = sd0 * np.sin(d) + cd0 * np.cos(d) * np.cos(dr)
        xi = np.cos(d) * np.sin(dr) / cosc
        eta = (cd0 * np.sin(d) - sd0 * np.cos(d) * np.cos(dr)) / cosc
        X, Y = np.degrees(xi), np.degrees(eta)
        U = self.icd[0, 0] * X + self.icd[0, 1] * Y
        V = self.icd[1, 0] * X + self.icd[1, 1] * Y
        if self.AP:
            u, v = U + self.poly(self.AP, U, V), V + self.poly(self.BP, U, V)
        elif self.A:
            u, v = U.copy(), V.copy()
            for _ in range(6):
                u, v = U - self.poly(self.A, u, v), V - self.poly(self.B, u, v)
        else:
            u, v = U, V
        x, y = u + self.crpix[0], v + self.crpix[1]
        bad = cosc <= 0
        x = np.where(bad, np.nan, x)
        y = np.where(bad, np.nan, y)
        return x, y


def tan_to_sky(xi, eta, ra0, dec0):
    sd0, cd0 = math.sin(dec0), math.cos(dec0)
    rho = np.hypot(xi, eta)
    c = np.arctan(rho)
    sc, cc = np.sin(c), np.cos(c)
    with np.errstate(invalid="ignore", divide="ignore"):
        dec = np.where(rho == 0, dec0, np.arcsin(cc * sd0 + np.where(rho == 0, 0, eta * sc * cd0 / np.where(rho == 0, 1, rho))))
    ra = ra0 + np.arctan2(xi * sc, rho * cd0 * cc - eta * sd0 * sc)
    return np.degrees(ra) % 360, np.degrees(dec)


_wave_cache = {}


def wave_table(url, key):
    if key in _wave_cache:
        return _wave_cache[key]
    tail = _get(url, suffix=4 * BLOCK)
    at = -1
    for i in range(0, len(tail) - 80, BLOCK):
        if tail[i:i + 19].decode("latin1").startswith("XTENSION= 'BINTABLE"):
            c, _ = parse_header(tail, i)
            if c and c.get("EXTNAME") == "WCS-WAVE":
                at = i
    tab = None
    if at >= 0:
        c, hl = parse_header(tail, at)
        nx, ny = int(str(c["TFORM1"]).rstrip("J")), int(str(c["TFORM2"]).rstrip("J"))
        o = at + hl
        X = struct.unpack(f">{nx}i", tail[o:o + 4 * nx]); o += 4 * nx
        Y = struct.unpack(f">{ny}i", tail[o:o + 4 * ny]); o += 4 * ny
        vals = np.frombuffer(tail[o:o + 8 * nx * ny], dtype=">f4").reshape(ny, nx, 2)
        tab = (np.array(X, float), np.array(Y, float), vals[:, :, 0].astype(float), vals[:, :, 1].astype(float))
    _wave_cache[key] = tab
    return tab


def wave_at(tab, x, y):
    if tab is None:
        return None, None
    X, Y, W, BW = tab
    px, py = x + 1, y + 1

    def seg(arr, v):
        i = 0
        while i < len(arr) - 2 and v > arr[i + 1]:
            i += 1
        f = (v - arr[i]) / (arr[i + 1] - arr[i])
        return i, min(1.0, max(0.0, f))
    i, fx = seg(X, px)
    j, fy = seg(Y, py)

    def bil(A):
        return (A[j, i] * (1 - fx) * (1 - fy) + A[j, i + 1] * fx * (1 - fy) + A[j + 1, i] * (1 - fx) * fy + A[j + 1, i + 1] * fx * fy)
    return float(bil(W)), float(bil(BW))


def frame_key(f):
    return f"{f['qr']}/level2/{f['week']}/{f['ver']}/{f['det']}/level2_{f['week']}_{f['ls']:04d}_{f['ss']}D{f['det']}_spx_{f['ver']}.fits"


def cutout(f, ra, dec):
    url = S3 + frame_key(f)
    cards, data_start = image_header(url)
    w = WCS(cards)
    cx, cy = w.sky2pix(np.array([ra]), np.array([dec]))
    cx, cy = float(cx[0]), float(cy[0])
    if not (4 <= cx <= NPIX - 5 and 4 <= cy <= NPIX - 5):
        return None
    half = SIZE / 2
    s = SCALE / 3600 * D2R
    ii, jj = np.meshgrid(np.arange(SIZE), np.arange(SIZE))
    xi, eta = (half - (ii + 0.5)) * s, (half - (jj + 0.5)) * s
    sra, sdec = tan_to_sky(xi, eta, ra * D2R, dec * D2R)
    px, py = w.sky2pix(sra, sdec)
    if not np.isfinite(px).any():
        return None
    x0 = max(0, int(math.floor(np.nanmin(px))) - 2); x1 = min(NPIX - 1, int(math.ceil(np.nanmax(px))) + 2)
    y0 = max(0, int(math.floor(np.nanmin(py))) - 2); y1 = min(NPIX - 1, int(math.ceil(np.nanmax(py))) + 2)
    row = NPIX * 4
    raw = _get(url, data_start + y0 * row, data_start + (y1 + 1) * row - 1)
    img = np.frombuffer(raw, dtype=">f4").reshape(y1 - y0 + 1, NPIX)[:, x0:x1 + 1].astype(np.float64)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1
    lx, ly = px - x0, py - y0
    ix, iy = np.floor(lx).astype(int), np.floor(ly).astype(int)
    ok = (ix >= 0) & (iy >= 0) & (ix < bw - 1) & (iy < bh - 1) & np.isfinite(lx)
    ix, iy = np.where(ok, ix, 0), np.where(ok, iy, 0)
    ax, ay = lx - ix, ly - iy
    acc = np.zeros_like(lx); ws = np.zeros_like(lx)
    for dy in (0, 1):
        for dx in (0, 1):
            v = img[iy + dy, ix + dx]
            wt = (ax if dx else 1 - ax) * (ay if dy else 1 - ay)
            good = np.isfinite(v) & ok
            acc += np.where(good, v * wt, 0); ws += np.where(good, wt, 0)
    out = np.where(ws > 0.15, acc / np.where(ws > 0, ws, 1), np.nan)
    wv, dwv = wave_at(wave_table(url, (f["qr"], f["det"], f["ver"])), cx, cy)
    bands = [None, (0.75, 1.09), (1.10, 1.62), (1.63, 2.41), (2.42, 3.82), (3.83, 4.41), (4.42, 5.00)]
    wcs_keys = re.compile(r"^(CRPIX[12]|CRVAL[12]|CDELT[12]|PC\d_\d|CD\d_\d|A_|B_|AP_|BP_)")
    meta = {
        "f": f, "tgt": {"ra": ra, "dec": dec},
        "r": {
            "size": SIZE, "scale": SCALE, "x": cx, "y": cy,
            "wave": wv if wv else sum(bands[f["det"]]) / 2, "dwave": dwv,
            "mjd": cards.get("MJD-AVG", f["mjd"]), "dateObs": cards.get("DATE-AVG") or cards.get("DATE-OBS", ""),
            "exptime": cards.get("EXPTIME") or cards.get("TELAPSE"), "psf": cards.get("PSF_FWHM"),
            "badFrac": float(np.mean(~np.isfinite(out))), "bytes": 0,
            "wcs": {k: v for k, v in cards.items() if wcs_keys.match(k)},
            "flagsAt": data_start + pad(data_size(cards)),
        },
    }
    return meta, out.astype("<f2")


def choose(frames, n=PER_TARGET):
    """Spread picks across visits (gap > 20 d or > 30 d long) and detectors."""
    frames = sorted(frames, key=lambda f: f["mjd"])
    visits = []
    for f in frames:
        v = visits[-1] if visits else None
        if v and f["mjd"] - v[-1]["mjd"] < 20 and f["mjd"] - v[0]["mjd"] < 30:
            v.append(f)
        else:
            visits.append([f])
    per = max(2, n // max(1, len(visits)))
    out = []
    for v in visits:
        by = {}
        for f in v:
            by.setdefault(f["det"], []).append(f)
        lists = list(by.values())
        k = 0
        while len([x for x in out if x in v]) < min(per, len(v)) and k < 400:
            arr = lists[k % len(lists)]
            idx = (k // len(lists)) % len(arr)
            cand = arr[(idx * 7 + k) % len(arr)]
            if cand not in out:
                out.append(cand)
            k += 1
    if len(out) > n:
        step = len(out) / n
        out = [out[int(i * step)] for i in range(n)]
    return sorted(out, key=lambda f: f["mjd"])


def write_pack(path, items):
    metas = [m for m, _ in items]
    js = json.dumps({"size": SIZE, "items": metas}, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    with open(path, "wb") as fh:
        fh.write(b"SXP2" + struct.pack("<I", len(js)) + js)
        for _, arr in items:
            fh.write(arr.tobytes())


def build(out_dir, targets, log):
    """targets: list of {key, frames:[f...], pos: f -> (ra, dec)}"""
    os.makedirs(os.path.join(out_dir, "packs"), exist_ok=True)
    built = 0
    with cf.ThreadPoolExecutor(16) as ex:
        for t in targets:
            pick = choose(t["frames"])
            futs = [ex.submit(lambda f=f: cutout(f, *t["pos"](f))) for f in pick]
            items = []
            for fu in futs:
                try:
                    r = fu.result()
                    if r:
                        items.append(r)
                except Exception as e:  # noqa: BLE001
                    log("  pack frame failed", t["key"], e)
            if items:
                items.sort(key=lambda it: it[0]["r"]["mjd"])
                write_pack(os.path.join(out_dir, "packs", t["key"] + ".bin"), items)
                built += 1
                log(f"  pack {t['key']}: {len(items)} images")
    return built
