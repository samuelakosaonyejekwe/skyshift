#!/usr/bin/env python3
"""
Regenerate the featured-target card thumbnails (site/img/thumbs/*.webp) from
NASA/IPAC 2MASS colour imagery via the CDS hips2fits service.

The targets come from site/js/featured.js, the single source of truth, so
adding a featured target and re-running this script keeps everything in step.
Thumbnails are static, so this only needs running when the featured list
changes.  Requires Pillow.  Usage:  python3 tools/thumbs.py
"""
import concurrent.futures as cf
import io
import json
import os
import re
import urllib.parse
import urllib.request

from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site")
WIDE = re.compile(r"Pole|Galaxy \(M31|Cygnus|Ophiuchi|Pleiades")   # extended targets get a wider view


def slug(name):
    # must match util.js slug()
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "target"


def featured():
    src = open(os.path.join(ROOT, "js", "featured.js"), encoding="utf-8").read()
    return json.loads(src[src.index("["):src.rindex("]") + 1])


def make(f):
    q = {"hips": "CDS/P/2MASS/color", "width": 360, "height": 240, "fov": 1.5 if WIDE.search(f["name"]) else 0.4,
         "projection": "TAN", "coordsys": "icrs", "ra": f["ra"], "dec": f["dec"], "format": "jpg"}
    raw = urllib.request.urlopen("https://alasky.cds.unistra.fr/hips-image-services/hips2fits?" + urllib.parse.urlencode(q), timeout=120).read()
    out = os.path.join(ROOT, "img", "thumbs", slug(f["name"]) + ".webp")
    Image.open(io.BytesIO(raw)).convert("RGB").save(out, "WEBP", quality=72, method=6)
    return out


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "img", "thumbs"), exist_ok=True)
    with cf.ThreadPoolExecutor(6) as ex:
        for path in ex.map(make, featured()):
            print(os.path.relpath(path, ROOT))
