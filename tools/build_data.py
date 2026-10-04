#!/usr/bin/env python3
"""
SkyShift data pipeline.

Pulls fresh NASA data and writes compact static files the web app reads:

  * NASA/IPAC IRSA  - every SPHEREx spectral image (QR2 + QR3, wide + deep survey)
                      via the IRSA TAP service -> sky-tiled binary frame index
  * NASA/JPL SSD    - SBDB orbital elements (asteroids + comets) for known-object
                      overlays, Horizons ephemerides for featured moving targets,
                      CNEOS close approaches
  * NASA Exoplanet Archive - exoplanet host stars
  * NASA.gov        - SPHEREx mission news feed
  * NASA Image and Video Library - SPHEREx imagery

Every source is optional: if one fails, the last good copy is restored from
the published site (or its CDN mirror), so the site never loses data because an
upstream service had a bad day.

Requirements: Python 3.10+; numpy for the pre-built target packs
(tools/requirements.txt).  Usage:  python3 tools/build_data.py site/data
"""
import concurrent.futures as cf
import csv
import datetime as dt
import io
import json
import math
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request
import bisect
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT = sys.argv[1] if len(sys.argv) > 1 else "site/data"
TAP = os.environ.get("SKYSHIFT_TAP", "https://irsa.ipac.caltech.edu/TAP/sync")
UA = "SkyShift-data-pipeline/1.0 (+https://github.com/samuelakosaonyejekwe/skyshift)"
MJD0 = 60780.0          # 2025-04-22, just before the first SPHEREx survey image (2025-04-24)
TILE_DEG = 3.0          # declination band height for frame tiles
FRAME_RADIUS = 2.47     # half-diagonal of a 3.485 deg SPHEREx frame


def utcnow():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def http(url, data=None, timeout=300, tries=4, headers=None):
    h = {"User-Agent": UA}
    if headers:
        h.update(headers)
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            log("  retry", i + 1, url[:90], e)
            time.sleep(5 * (i + 1))
    raise last


def tap(query, timeout=900, tries=4):
    body = urllib.parse.urlencode({"QUERY": query, "FORMAT": "csv", "LANG": "ADQL"}).encode()
    raw = http(TAP, data=body, timeout=timeout, tries=tries)
    text = raw.decode("utf-8", "replace")
    if text.lstrip().startswith("<"):
        raise RuntimeError("TAP error: " + text[:400])
    return list(csv.reader(io.StringIO(text)))


def write_json(name, obj):
    path = os.path.join(OUT, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)


def read_json(name, default=None):
    try:
        with open(os.path.join(OUT, name), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return default


def now_mjd():
    return time.time() / 86400.0 + 40587.0


def mjd_to_iso(m):
    return (dt.datetime(1858, 11, 17) + dt.timedelta(days=m)).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Tiling (must match site/js/data.js)
# --------------------------------------------------------------------------
NBANDS = int(round(180 / TILE_DEG))


def band_count(b):
    dec_c = -90 + (b + 0.5) * TILE_DEG
    return max(1, int(round(360 * math.cos(math.radians(dec_c)) / TILE_DEG)))


def tile_of(ra, dec):
    b = min(NBANDS - 1, max(0, int((dec + 90) / TILE_DEG)))
    n = band_count(b)
    i = int((ra % 360) / 360 * n) % n
    return b, i


# --------------------------------------------------------------------------
# 1. SPHEREx frame index from IRSA
# --------------------------------------------------------------------------
URI_RE = re.compile(
    r"spherex/(qr\d*)/level2/(\d{4}W\d{2}_\w{2})/(l2b-[^/]+)/(\d)/level2_\2_(\d{4})_(\d)D\4_spx_\3\.fits$")


def fetch_frames():
    end = now_mjd() + 2
    windows = []
    t = MJD0
    while t < end:
        windows.append((t, min(t + 12, end)))
        t += 12
    log(f"SPHEREx: querying {len(windows)} time windows from IRSA TAP")
    # fail fast when IRSA is down instead of retrying every window
    tap("select top 1 obs_id from spherex.obscore", timeout=120, tries=3)

    def run(w):
        q = ("select p.time_bounds_lower, coord1(p.pt), coord2(p.pt), a.uri "
             "from spherex.plane p join spherex.artifact a on a.planeid = p.planeid "
             f"where a.producttype = 'science' and p.time_bounds_lower >= {w[0]:.6f} "
             f"and p.time_bounds_lower < {w[1]:.6f}")
        rows = tap(q)
        return rows[1:]

    frames = {}
    ex = cf.ThreadPoolExecutor(4)
    try:
        for k, rows in enumerate(ex.map(run, windows)):
            for r in rows:
                try:
                    t, ra, dec, uri = float(r[0]), float(r[1]), float(r[2]), r[3]
                except (ValueError, IndexError):
                    continue
                m = URI_RE.search(uri)
                if not m:
                    continue
                qr, week, ver, det, ls, ss = m.groups()
                key = (week, ls, ss, det)
                prev = frames.get(key)
                # prefer the newest quick release (qr3 > qr2) when duplicated
                if prev is None or qr > prev[0]:
                    frames[key] = (qr, week, ver, int(det), int(ls), int(ss), ra, dec, t)
            if k % 10 == 0:
                log(f"  window {k + 1}/{len(windows)} -> {len(frames)} frames")
    finally:
        # on any failure, drop the queued windows instead of waiting for them
        ex.shutdown(wait=True, cancel_futures=True)
    log(f"SPHEREx: {len(frames)} unique frames")
    return list(frames.values())


def write_tiles(frames):
    """Binary tile format (little endian):
         u32 magic 'SXT1' | u16 nPaths | nPaths * (u8 len, utf8 'qr|week|ver')
         | u32 nRows | rows * (u16 path, u16 largeSlew, u8 smallSlew, u8 det,
                               i32 ra*1e6, i32 dec*1e6, u32 (mjd-MJD0)*1e5)
    """
    tiles = {}
    for f in frames:
        tiles.setdefault(tile_of(f[6], f[7]), []).append(f)
    tdir = os.path.join(OUT, "tiles")
    os.makedirs(tdir, exist_ok=True)
    # clear stale tiles
    for name in os.listdir(tdir):
        if name.endswith(".bin"):
            os.remove(os.path.join(tdir, name))
    manifest = {}
    for (b, i), rows in tiles.items():
        rows.sort(key=lambda r: r[8])
        paths, pidx = [], {}
        for r in rows:
            p = f"{r[0]}|{r[1]}|{r[2]}"
            if p not in pidx:
                pidx[p] = len(paths)
                paths.append(p)
        buf = bytearray(b"SXT1")
        buf += struct.pack("<H", len(paths))
        for p in paths:
            e = p.encode()
            buf += struct.pack("<B", len(e)) + e
        buf += struct.pack("<I", len(rows))
        for r in rows:
            buf += struct.pack("<HHBBiiI", pidx[f"{r[0]}|{r[1]}|{r[2]}"], r[4], r[5], r[3],
                               int(round(r[6] * 1e6)), int(round(r[7] * 1e6)),
                               max(0, int(round((r[8] - MJD0) * 1e5))))
        with open(os.path.join(tdir, f"{b}_{i}.bin"), "wb") as fh:
            fh.write(buf)
        manifest[f"{b}_{i}"] = len(rows)
    log(f"tiles: wrote {len(tiles)} files")
    return manifest


def coverage_and_stats(frames):
    # 1-degree coverage grid: number of frames whose footprint covers the cell
    W, H = 360, 180
    cov = [0] * (W * H)
    last = [0] * (W * H)    # most recent day (mjd - MJD0) a cell was observed
    r = FRAME_RADIUS * 0.72  # inscribed-ish radius of the square footprint
    for f in frames:
        ra, dec, t = f[6], f[7], f[8]
        d0, d1 = max(-90, dec - r), min(90, dec + r)
        for dd in range(int(math.floor(d0)), int(math.ceil(d1))):
            dc = dd + 0.5
            cosd = max(0.02, math.cos(math.radians(dc)))
            span = min(180, r / cosd)
            row = dd + 90
            if not 0 <= row < H:
                continue
            for rr in range(int(math.floor(ra - span)), int(math.ceil(ra + span))):
                k = row * W + (rr % 360)
                if cov[k] < 65535:
                    cov[k] += 1
                td = int(t - MJD0)
                if td > last[k]:
                    last[k] = td
    covered = sum(1 for c in cov if c)
    # area-weighted sky fraction
    tot = sum(math.cos(math.radians(-89.5 + (k // W))) for k in range(W * H))
    area = sum(math.cos(math.radians(-89.5 + (k // W))) for k in range(W * H) if cov[k])
    import base64
    cov_b = base64.b64encode(struct.pack(f"<{W * H}H", *cov)).decode()
    last_b = base64.b64encode(struct.pack(f"<{W * H}H", *[min(65535, x) for x in last])).decode()
    write_json("coverage.json", {"w": W, "h": H, "mjd0": MJD0, "counts": cov_b, "lastDay": last_b})

    days, bands, periods = {}, [0] * 7, {}
    for f in frames:
        d = int(f[8])
        days[d] = days.get(d, 0) + 1
        bands[f[3]] += 1
        p = periods.setdefault(f[1], [0, f[8], f[8], f[0]])
        p[0] += 1
        p[1] = min(p[1], f[8])
        p[2] = max(p[2], f[8])
    tmin = min(f[8] for f in frames)
    tmax = max(f[8] for f in frames)
    return {
        "frames": len(frames),
        "exposures": len({(f[1], f[4], f[5]) for f in frames}),
        "firstMjd": tmin, "lastMjd": tmax,
        "firstIso": mjd_to_iso(tmin), "lastIso": mjd_to_iso(tmax),
        "skyFraction": round(area / tot, 4), "cells": covered,
        "perDay": sorted([[d, n] for d, n in days.items()]),
        "perBand": bands[1:],
        "periods": sorted([[k, v[0], round(v[1], 4), round(v[2], 4), v[3]] for k, v in periods.items()]),
    }


# --------------------------------------------------------------------------
# 2. Known solar-system objects (JPL SBDB)
# --------------------------------------------------------------------------
def fetch_sso():
    fields = "full_name,e,q,i,om,w,tp,H,M1,K1,epoch"
    out = []
    for kind, cond in (("a", '{"AND":["H|LT|14.5"]}'), ("c", '{"AND":["q|LT|8"]}')):
        url = ("https://ssd-api.jpl.nasa.gov/sbdb_query.api?" + urllib.parse.urlencode(
            {"fields": fields, "sb-kind": kind, "sb-cdata": cond, "full-prec": "true"}))
        js = json.loads(http(url, timeout=300))
        f = js["fields"]
        ix = {k: f.index(k) for k in f}
        for r in js["data"]:
            try:
                e, q, inc, om, w, tp = (float(r[ix[k]]) for k in ("e", "q", "i", "om", "w", "tp"))
            except (TypeError, ValueError):
                continue
            name = re.sub(r"\s+", " ", (r[ix["full_name"]] or "").strip())
            if kind == "a":
                mag = r[ix["H"]]
                mag = float(mag) if mag not in (None, "") else 18.0
            else:
                m1 = r[ix["M1"]]
                mag = float(m1) if m1 not in (None, "") else 12.0
            # tp is a Julian date (TDB) -> store as MJD
            try:
                epoch = float(r[ix["epoch"]]) - 2400000.5
            except (TypeError, ValueError):
                epoch = tp - 2400000.5
            out.append([name, kind, round(e, 8), round(q, 8), round(inc, 6), round(om, 6),
                        round(w, 6), round(tp - 2400000.5, 5), round(mag, 2), round(epoch, 1)])
        log(f"SBDB {kind}: {len(js['data'])} objects")
    write_json("sso.json", {"fields": ["name", "kind", "e", "q", "i", "om", "w", "tpMjd", "H", "epochMjd"],
                            "epoch": "J2000 ecliptic", "data": out,
                            "built": utcnow().isoformat() + "Z"})
    return len(out)


# --------------------------------------------------------------------------
# 3. Featured moving targets via JPL Horizons
# --------------------------------------------------------------------------
MOVERS = [
    ("3i-atlas", "3I/ATLAS", "DES=C/2025 N1;", "Interstellar comet - only the third visitor from another star system ever found. SPHEREx observed it in 2025."),
    ("neptune", "Neptune", "899", "The outermost planet creeps across the infrared sky."),
    ("uranus", "Uranus", "799", "An ice giant drifting among the stars."),
    ("pluto", "Pluto", "999", "The most famous 'Planet X' - found in 1930 by blinking photographs, exactly what this tool does."),
    ("eris", "Eris", "136199", "Dwarf planet discovered by its slow motion between images in 2005."),
    ("sedna", "Sedna", "90377", "A distant world whose odd orbit hints at an undiscovered planet."),
    ("makemake", "Makemake", "136472", "Bright Kuiper Belt dwarf planet."),
    ("haumea", "Haumea", "136108", "Fast-spinning, egg-shaped dwarf planet."),
    ("gonggong", "Gonggong", "225088", "One of the largest distant dwarf planets."),
    ("quaoar", "Quaoar", "50000", "Kuiper Belt object with a ring."),
    ("ceres", "Ceres", "1;", "Largest object in the asteroid belt."),
    ("vesta", "Vesta", "4;", "Bright, rocky giant asteroid."),
    ("pallas", "Pallas", "2;", "Large asteroid on a steeply tilted orbit."),
    ("lemmon", "Comet Lemmon", "DES=C/2025 A6;CAP;NOFRAG;", "Bright long-period comet of late 2025."),
    ("swan", "Comet SWAN", "DES=C/2025 R2;CAP;NOFRAG;", "Comet discovered in 2025 by the SWAN instrument on SOHO."),
    ("apophis", "Apophis", "99942", "Near-Earth asteroid heading for a close Earth flyby in 2029."),
]


SLOW = {"neptune", "uranus", "pluto", "eris", "sedna", "makemake", "haumea", "gonggong", "quaoar"}


def horizons(cmd, start, stop, step):
    q = {
        "format": "json", "COMMAND": f"'{cmd}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER", "CENTER": "'500@399'", "START_TIME": f"'{start}'",
        "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{step}'", "QUANTITIES": "'1,9,19,20'",
        "ANG_FORMAT": "DEG", "CSV_FORMAT": "YES", "TIME_DIGITS": "FRACSEC", "CAL_FORMAT": "JD",
    }
    js = json.loads(http("https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(q), timeout=180))
    res = js.get("result", "")
    if "$$SOE" not in res:
        raise RuntimeError(res[:300])
    body = res.split("$$SOE")[1].split("$$EOE")[0]
    pts = []
    for line in body.strip().splitlines():
        c = [x.strip() for x in line.split(",")]
        try:
            jd, ra, dec = float(c[0]), float(c[3]), float(c[4])
        except (ValueError, IndexError):
            continue
        mag = None
        for v in c[5:7]:
            try:
                mag = float(v)
                break
            except ValueError:
                pass
        # columns: JD, sun, moon, RA, DEC, mag, mag2/s-brt, r, rdot, delta, deldot
        r = delta = None
        try:
            r, delta = float(c[7]), float(c[9])
        except (ValueError, IndexError):
            pass
        pts.append([round(jd - 2400000.5, 4), round(ra, 6), round(dec, 6),
                    None if mag is None else round(mag, 2),
                    None if r is None else round(r, 4), None if delta is None else round(delta, 5)])
    return pts


def horizons_vectors(cmd, center, start, stop, step, plane, units):
    q = {
        "format": "json", "COMMAND": f"'{cmd}'", "OBJ_DATA": "NO", "MAKE_EPHEM": "YES", "EPHEM_TYPE": "VECTORS",
        "CENTER": f"'{center}'", "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{step}'",
        "VEC_TABLE": "'2'", "REF_PLANE": f"'{plane}'", "OUT_UNITS": f"'{units}'", "CSV_FORMAT": "YES",
        "VEC_LABELS": "NO", "TIME_DIGITS": "FRACSEC",
    }
    js = json.loads(http("https://ssd.jpl.nasa.gov/api/horizons.api?" + urllib.parse.urlencode(q), timeout=300))
    res = js.get("result", "")
    if "$$SOE" not in res:
        raise RuntimeError(res[-300:])
    rows = []
    for line in res.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        c = [x.strip() for x in line.split(",")]
        try:
            rows.append([float(c[0]) - 2400000.5] + [float(v) for v in c[2:8]])
        except (ValueError, IndexError):
            continue
    return rows


def fetch_ephem():
    """Heliocentric ecliptic J2000 state vectors (au, au/day) of the Earth and
    the perturbing planets, daily, plus SPHEREx's own geocentric orbit."""
    start = mjd_to_iso(MJD0 - 5)[:10]
    stop = (utcnow() + dt.timedelta(days=40)).strftime("%Y-%m-%d")
    bodies = {"earth": "399", "venus": "299", "mars": "4", "jupiter": "5", "saturn": "6", "uranus": "7", "neptune": "8"}
    out = {"t0": None, "step": 1.0, "bodies": {}}
    for name, cmd in bodies.items():
        rows = horizons_vectors(cmd, "500@10", start, stop, "1d", "ECLIPTIC", "AU-D")
        out["t0"] = rows[0][0]
        out["bodies"][name] = [round(v, 11) for r in rows for v in r[1:]]
        log(f"Horizons vectors {name}: {len(rows)}")
    write_json("ephem.json", out)
    # SPHEREx position relative to Earth's centre (equatorial ICRF, km), 20-min
    # steps, so the app can correct for the telescope's orbital parallax
    t = dt.datetime(2025, 4, 20)
    end = utcnow() + dt.timedelta(days=2)
    recs = []
    while t < end:
        t2 = min(end, t + dt.timedelta(days=60))
        rows = horizons_vectors("-163182", "500@399", t.strftime("%Y-%m-%d %H:%M"), t2.strftime("%Y-%m-%d %H:%M"), "20m", "FRAME", "KM-S")
        if recs and rows and rows[0][0] <= recs[-1][0] + 1e-6:
            rows = rows[1:]
        recs += rows
        t = t2
    buf = bytearray(b"SXO1") + struct.pack("<dI", recs[0][0], len(recs)) + struct.pack("<d", 20 / 1440)
    for r in recs:
        buf += struct.pack("<6f", *r[1:])
    with open(os.path.join(OUT, "spherex_orbit.bin"), "wb") as fh:
        fh.write(buf)
    log(f"SPHEREx orbit: {len(recs)} states")


def angdist(ra1, de1, ra2, de2):
    r = math.radians
    s = (math.sin(r(de1 - de2) / 2) ** 2 + math.cos(r(de1)) * math.cos(r(de2)) * math.sin(r(ra1 - ra2) / 2) ** 2)
    return math.degrees(2 * math.asin(min(1, math.sqrt(s))))


def fetch_movers(frames):
    start = mjd_to_iso(MJD0)[:10]
    stop = (utcnow() + dt.timedelta(days=3)).strftime("%Y-%m-%d")
    # build a coarse spatial hash of frames for the frame/track match
    grid = {}
    for f in frames:
        grid.setdefault(tile_of(f[6], f[7]), []).append(f)
    out = []
    prev = {m["id"]: m for m in (read_json("movers.json", {}) or {}).get("movers", [])}
    for mid, name, cmd, blurb in MOVERS:
        step = "6 h" if cmd.startswith("DES=C/") else ("1 d" if mid in SLOW else "12 h")
        try:
            pts = horizons(cmd, start, stop, step)
        except Exception as e:  # noqa: BLE001
            log("Horizons failed", name, e)
            if mid in prev:
                out.append(prev[mid])
            continue
        # find SPHEREx frames that contain the object at the exposure time
        hits = []
        tms = [p[0] for p in pts]
        cand = set()
        for p in pts[::2]:
            b, _ = tile_of(p[1], p[2])
            for bb in (b - 1, b, b + 1):
                if 0 <= bb < NBANDS:
                    n = band_count(bb)
                    i0 = int((p[1] % 360) / 360 * n)
                    for di in (-1, 0, 1):
                        cand.add((bb, (i0 + di) % n))
        for key in cand:
            for f in grid.get(key, []):
                t = f[8]
                k = bisect.bisect_left(tms, t)
                if k <= 0 or k >= len(pts):
                    continue
                a, c = pts[k - 1], pts[k]
                u = (t - a[0]) / (c[0] - a[0])
                ra = a[1] + ((c[1] - a[1] + 540) % 360 - 180) * u
                dec = a[2] + (c[2] - a[2]) * u
                if angdist(ra, dec, f[6], f[7]) < 1.70:
                    hits.append(f"{f[0]}|{f[1]}|{f[2]}|{f[3]}|{f[4]}|{f[5]}|{round(t, 5)}")
        hits.sort(key=lambda s: float(s.rsplit("|", 1)[1]))
        if not hits:
            log(f"Horizons {name}: not in any SPHEREx frame yet")
            continue
        out.append({"id": mid, "name": name, "blurb": blurb, "track": pts, "frames": hits})
        log(f"Horizons {name}: {len(pts)} pts, {len(hits)} SPHEREx frames")
    write_json("movers.json", {"movers": out, "built": utcnow().isoformat() + "Z"})


# --------------------------------------------------------------------------
# 4. Other NASA sources
# --------------------------------------------------------------------------
def fetch_exoplanets():
    q = ("select hostname, ra, dec, sy_pmra, sy_pmdec, sy_dist, sy_pnum, sy_kmag, st_spectype, disc_facility, pl_name "
         "from pscomppars")
    url = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync?" + urllib.parse.urlencode({"query": q, "format": "csv"})
    rows = list(csv.reader(io.StringIO(http(url, timeout=300).decode("utf-8", "replace"))))
    hdr, rows = rows[0], rows[1:]
    hosts = {}
    for r in rows:
        d = dict(zip(hdr, r))
        h = hosts.get(d["hostname"])
        if not h:
            def num(x, nd=3):
                try:
                    return round(float(x), nd)
                except ValueError:
                    return None
            ra, dec = num(d["ra"], 7), num(d["dec"], 7)
            # move to the current epoch using the archive's proper motions
            # (positions are Gaia-based, epoch ~J2016.0)
            pmra, pmdec = num(d.get("sy_pmra", "")), num(d.get("sy_pmdec", ""))
            if ra is not None and dec is not None and pmra is not None and pmdec is not None:
                yrs = (now_mjd() - 57388.5) / 365.25
                dec_new = dec + pmdec * yrs / 3.6e6
                ra = (ra + pmra * yrs / 3.6e6 / max(0.01, math.cos(math.radians(dec)))) % 360
                dec = dec_new
                ra, dec = round(ra, 6), round(dec, 6)
            h = hosts[d["hostname"]] = [d["hostname"], ra, dec, num(d["sy_dist"]),
                                        int(float(d["sy_pnum"] or 0)), num(d["sy_kmag"]), d["st_spectype"], []]
        h[7].append(d["pl_name"])
    data = [h for h in hosts.values() if h[1] is not None and h[2] is not None]
    write_json("exoplanets.json", {"fields": ["host", "ra", "dec", "distPc", "nPlanets", "kmag", "spType", "planets"],
                                   "data": data, "built": utcnow().isoformat() + "Z"})
    log(f"Exoplanet Archive: {len(data)} host stars, {len(rows)} planets")
    return len(rows)


def fetch_cad():
    url = ("https://ssd-api.jpl.nasa.gov/cad.api?date-min=now&date-max=%2B90&dist-max=0.05"
           "&sort=date&fullname=true&diameter=true")
    js = json.loads(http(url))
    f = js.get("fields", [])
    data = [dict(zip(f, r)) for r in js.get("data", [])]
    write_json("cad.json", {"data": data, "built": utcnow().isoformat() + "Z"})
    log(f"CNEOS close approaches: {len(data)}")


def fetch_news():
    raw = http("https://www.nasa.gov/missions/spherex/feed/", timeout=60)
    root = ET.fromstring(raw)
    items = []
    for it in root.iter("item"):
        def g(tag):
            el = it.find(tag)
            return (el.text or "").strip() if el is not None else ""
        desc = re.sub(r"<[^>]+>", "", g("description"))
        desc = re.sub(r"\s+", " ", desc)[:320]
        img = ""
        enc = it.find("{http://purl.org/rss/1.0/modules/content/}encoded")
        if enc is not None and enc.text:
            m = re.search(r'src="(https://[^"]+\.(?:jpg|jpeg|png|webp))', enc.text)
            if m:
                img = m.group(1)
        items.append({"title": g("title"), "link": g("link"), "date": g("pubDate"), "summary": desc, "image": img})
    write_json("news.json", {"items": items[:30], "built": utcnow().isoformat() + "Z"})
    log(f"NASA news: {len(items)} items")


def fetch_images():
    url = "https://images-api.nasa.gov/search?" + urllib.parse.urlencode({"q": "SPHEREx", "media_type": "image"})
    js = json.loads(http(url))
    out = []
    for it in js.get("collection", {}).get("items", [])[:60]:
        d = (it.get("data") or [{}])[0]
        thumb = next((l["href"] for l in it.get("links", []) if l.get("rel") == "preview"), "")
        out.append({"id": d.get("nasa_id"), "title": d.get("title"), "date": d.get("date_created", "")[:10],
                    "center": d.get("center"), "desc": (d.get("description") or "")[:400], "thumb": thumb})
    write_json("images.json", {"items": out, "built": utcnow().isoformat() + "Z"})
    log(f"NASA images: {len(out)}")


def latest_s3():
    """Newest planning periods actually present in the public S3 bucket."""
    base = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/?list-type=2&delimiter=/&prefix="
    out = []
    for qr in ("qr3", "qr2"):
        xml = http(base + f"{qr}/level2/", timeout=60).decode()
        out += re.findall(r"<Prefix>(%s/level2/[^<]+/)</Prefix>" % qr, xml)
    return sorted(out, key=lambda p: p.split("/")[2])[-6:]


# --------------------------------------------------------------------------
# Pre-built packs for featured targets (instant loading in the app)
def spacecraft_offset_fn():
    """SPHEREx geocentric position (au, equatorial) at an MJD, from the orbit file."""
    try:
        buf = open(os.path.join(OUT, "spherex_orbit.bin"), "rb").read()
    except OSError:
        return lambda m: None
    t0, n = struct.unpack("<dI", buf[4:16])
    step = struct.unpack("<d", buf[16:24])[0]
    v = struct.unpack(f"<{n * 6}f", buf[24:24 + n * 24])
    AU = 149597870.7

    def at(mjd):
        x = (mjd + 69.184 / 86400 - t0) / step
        if x < 0 or x > n - 1:
            return None
        i = min(n - 2, int(x)); s_ = x - i; h = step * 86400
        h00, h10, h01, h11 = 2*s_**3 - 3*s_**2 + 1, s_**3 - 2*s_**2 + s_, -2*s_**3 + 3*s_**2, s_**3 - s_**2
        a, c = i * 6, i * 6 + 6
        return [(h00*v[a+k] + h10*h*v[a+3+k] + h01*v[c+k] + h11*h*v[c+3+k]) / AU for k in range(3)]
    return at


def to_spacecraft(ra, dec, delta, sc):
    if not sc or not delta or delta <= 0.0005:
        return ra, dec
    r, d = math.radians(ra), math.radians(dec)
    g = [delta*math.cos(d)*math.cos(r) - sc[0], delta*math.cos(d)*math.sin(r) - sc[1], delta*math.sin(d) - sc[2]]
    n = math.sqrt(sum(x*x for x in g))
    return (math.degrees(math.atan2(g[1], g[0])) + 360) % 360, math.degrees(math.asin(g[2] / n))


def featured():
    """Featured targets from site/js/featured.js (strict JSON after the '=')."""
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "js", "featured.js"), encoding="utf-8").read()
    return json.loads(src[src.index("["):src.rindex("]") + 1])


def build_packs(frames):
    import packs
    feats = [(f["name"], f["ra"], f["dec"]) for f in featured()]
    as_dict = lambda t: {"qr": t[0], "week": t[1], "ver": t[2], "det": t[3], "ls": t[4], "ss": t[5], "mjd": t[8]}
    grid = {}
    for f in frames:
        grid.setdefault(tile_of(f[6], f[7]), []).append(f)
    targets = []
    for name, ra, dec in feats:
        ra, dec = float(ra), float(dec)
        near = []
        b, _ = tile_of(ra, dec)
        for bb in range(max(0, b - 1), min(NBANDS, b + 2)):
            for i in range(band_count(bb)):
                for f in grid.get((bb, i), []):
                    if angdist(ra, dec, f[6], f[7]) < 1.70:
                        near.append(as_dict(f))
        if near:
            targets.append({"key": f"f_{ra:.4f}_{dec:.4f}", "frames": near, "pos": (lambda f, ra=ra, dec=dec: (ra, dec))})
    sc_at = spacecraft_offset_fn()
    for m in (read_json("movers.json", {}) or {}).get("movers", []):
        tr = m["track"]
        tms = [p[0] for p in tr]
        fr = []
        for h in m["frames"]:
            qr, week, ver, det, ls, ss, t = h.split("|")
            fr.append({"qr": qr, "week": week, "ver": ver, "det": int(det), "ls": int(ls), "ss": int(ss), "mjd": float(t)})

        def pos(f, tr=tr, tms=tms):
            k = min(len(tr) - 1, max(1, bisect.bisect_left(tms, f["mjd"])))
            a, c = tr[k - 1], tr[k]
            u = min(1, max(0, (f["mjd"] - a[0]) / ((c[0] - a[0]) or 1)))
            ra = (a[1] + ((c[1] - a[1] + 540) % 360 - 180) * u) % 360
            dec = a[2] + (c[2] - a[2]) * u
            delta = (a[5] + (c[5] - a[5]) * u) if a[5] is not None and c[5] is not None else None
            return to_spacecraft(ra, dec, delta, sc_at(f["mjd"]))
        if fr:
            targets.append({"key": f"m_{m['id']}", "frames": fr, "pos": pos})
    log(f"packs: building {len(targets)} target packs")
    packs.build(OUT, targets, log)
    return sorted(t["key"] for t in targets if os.path.exists(os.path.join(OUT, "packs", t["key"] + ".bin")))


# --------------------------------------------------------------------------
# Redundancy: restore the last good copy of anything that failed upstream,
# from the live site first, then from the CDN mirror of the `data` branch.
PREV_BASES = [b for b in os.environ.get("SKYSHIFT_PREVIOUS", "").split() if b]


def restore(name, binary=False):
    for base in PREV_BASES:
        try:
            raw = http(base.rstrip("/") + "/" + name, timeout=60, tries=2)
            path = os.path.join(OUT, name)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(raw)
            return True
        except Exception:  # noqa: BLE001
            continue
    return os.path.exists(os.path.join(OUT, name))


def restore_index(meta):
    """Bring back the previous frame index (meta + coverage + all tiles)."""
    if not restore("meta.json"):
        return False
    prev = read_json("meta.json", {}) or {}
    tiles = prev.get("tiles") or {}
    restore("coverage.json")
    with cf.ThreadPoolExecutor(16) as ex:
        ok = sum(ex.map(lambda k: restore(f"tiles/{k}.bin", True), tiles))
    log(f"restored previous index: {ok}/{len(tiles)} tiles")
    for k in ("tiles", "spherex", "tileDeg", "mjd0"):
        if k in prev:
            meta[k] = prev[k]
    return ok > 0.95 * max(1, len(tiles))


def previous_meta():
    for base in PREV_BASES:
        try:
            return json.loads(http(base.rstrip("/") + "/meta.json", timeout=60, tries=2))
        except Exception:  # noqa: BLE001
            continue
    return {}


def restore_packs():
    """Bring back the previously published target packs; returns their keys."""
    keys = previous_meta().get("packs") or []
    return [k for k in keys if restore(f"packs/{k}.bin", True)]


def frames_from_tiles():
    """Rebuild the frame list from the (restored) binary tiles."""
    frames = []
    tdir = os.path.join(OUT, "tiles")
    for name in os.listdir(tdir) if os.path.isdir(tdir) else []:
        if not name.endswith(".bin"):
            continue
        buf = open(os.path.join(tdir, name), "rb").read()
        o = 4
        npth = struct.unpack_from("<H", buf, o)[0]; o += 2
        paths = []
        for _ in range(npth):
            n = buf[o]; o += 1
            paths.append(buf[o:o + n].decode().split("|")); o += n
        nr = struct.unpack_from("<I", buf, o)[0]; o += 4
        for _ in range(nr):
            pi, ls, ss, det, ra, dec, t = struct.unpack_from("<HHBBiiI", buf, o); o += 18
            qr, wk, ver = paths[pi]
            frames.append((qr, wk, ver, det, ls, ss, ra / 1e6, dec / 1e6, MJD0 + t / 1e5))
    return frames


def reuse_previous():
    """Code-only deploys: reuse the latest published data instead of a full
    NASA refresh (the scheduled runs keep the data fresh)."""
    meta = {}
    if not restore_index(meta):
        return False
    for name in ("sso.json", "exoplanets.json", "cad.json", "news.json", "images.json", "ephem.json", "movers.json"):
        if not restore(name):
            return False
    restore("spherex_orbit.bin", True)
    prev = read_json("meta.json", {}) or {}
    for k in prev.get("packs") or []:
        restore(f"packs/{k}.bin", True)
    log("reused previous data (meta, index, catalogues, packs)")
    return True


def main():
    os.makedirs(OUT, exist_ok=True)
    if os.environ.get("SKYSHIFT_REUSE") == "1" and PREV_BASES and reuse_previous():
        return
    meta = read_json("meta.json", {}) or {}
    status = {}
    frames = []

    try:
        frames = fetch_frames()
        if len(frames) < 1000:
            raise RuntimeError(f"suspiciously few frames ({len(frames)})")
        meta["tiles"] = write_tiles(frames)
        meta["spherex"] = coverage_and_stats(frames)
        status["spherex"] = "ok"
    except Exception as e:  # noqa: BLE001
        log("SPHEREx index FAILED - restoring previous index:", e)
        restored = restore_index(meta)
        status["spherex"] = f"kept previous ({e.__class__.__name__})" if restored else "unavailable"
        if restored:
            # keep moving objects and target packs working from the restored index
            frames = frames_from_tiles()
            log(f"rebuilt {len(frames)} frames from the restored index")

    for key, fn in (("sso", fetch_sso), ("exoplanets", fetch_exoplanets), ("cad", fetch_cad),
                    ("news", fetch_news), ("images", fetch_images), ("ephem", fetch_ephem)):
        try:
            fn()
            status[key] = "ok"
        except Exception as e:  # noqa: BLE001
            log(f"{key} FAILED - keeping previous:", e)
            restore(f"{key}.json")
            if key == "ephem":
                restore("spherex_orbit.bin", True)
            status[key] = f"kept previous ({e.__class__.__name__})"

    if frames:
        try:
            fetch_movers(frames)
            status["movers"] = "ok"
        except Exception as e:  # noqa: BLE001
            log("movers FAILED:", e)
            restore("movers.json")
            status["movers"] = f"kept previous ({e.__class__.__name__})"
    else:
        restore("movers.json")

    if frames:
        try:
            meta["packs"] = build_packs(frames)
            status["packs"] = "ok"
        except Exception as e:  # noqa: BLE001
            log("packs FAILED:", e)
            meta["packs"] = restore_packs()
            status["packs"] = f"kept previous ({e.__class__.__name__})"
    else:
        meta["packs"] = restore_packs()

    try:
        meta["s3Latest"] = latest_s3()
    except Exception as e:  # noqa: BLE001
        log("S3 listing failed", e)

    meta["built"] = utcnow().replace(microsecond=0).isoformat() + "Z"
    meta["status"] = status
    meta["tileDeg"] = TILE_DEG
    meta["mjd0"] = MJD0
    write_json("meta.json", meta)
    log("done", status)
    # fail the job only if we have no index at all
    if "tiles" not in meta:
        sys.exit(1)


if __name__ == "__main__":
    main()
