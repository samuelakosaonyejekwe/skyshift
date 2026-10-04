# SkyShift · SPHEREx Sky Time Machine

**Live app: https://samuelakosaonyejekwe.github.io/skyshift/**  
**Backup (Cloudflare, independent of GitHub): https://skyshift.pages.dev/**

A public web tool for the **2026 NASA Space Apps Challenge – "Planet X and SPHEREx"**.
SkyShift shows real images of the sky from NASA's SPHEREx mission and makes it easy for
anyone to see how the sky **changes over time**: asteroids, comets, dwarf planets,
fast-moving stars, brown dwarfs and variable stars.

It installs like an app on any phone, tablet or computer, and keeps working offline.

## What you can do

| | |
|---|---|
| **Explore** | The real infrared sky (NASA/IPAC 2MASS) with SPHEREx's coverage glowing on top: every SPHEREx image indexed (about 1.5 million so far, growing weekly), the whole sky covered. Tap anywhere to open it. Featured targets, exoplanet hosts, newest frames. |
| **Time Machine** | Every SPHEREx image of a spot, in time order. **Movie**, **Blink** (the method that found Pluto), **Difference** (wavelength-matched), false-**Colour**, and **Then & now** against NASA WISE/NEOWISE and 2MASS at matching wavelengths. |
| **Spectrum & light curve** | Tap any star: SkyShift measures it in every image and plots its 0.75–5 µm spectrum and its brightness over time, with ice and gas features marked. |
| **Hunt** | Scans for new point sources, moving tracklets and changes between visits. Every candidate is verified: a star-shape test, significance against the *local* noise (so nebular structure does not count), SPHEREx's own per-pixel quality flags (cosmic rays, hot pixels, ghosts, persistence), and aperture photometry in two or more bands for brightness changes. Survivors are matched against 55,000+ known asteroids and comets, then checked against 2MASS (1997–2001) and WISE/NEOWISE (2010–2020): a source already there is labelled a variable star, and one in bright nebulosity a possible nebular knot, so only sources with nothing behind them count as unexplained. Save finds and export them. |
| **Chase** | Follow a moving object (3I/ATLAS, Neptune, Pluto, Eris, Sedna, Ceres, comets… or any of the 55,000+ catalogued objects): the view re-centres on its predicted position, corrected for SPHEREx's orbital parallax, in each image. |
| **Live** | Your browser reads NASA's SPHEREx archive directly: newest observing periods and brand-new frames, "developed" on demand. |
| **Mission** | Survey statistics, images per day, bands, data freshness per source, NASA SPHEREx news, NASA Image Library, upcoming asteroid close approaches. |
| **Export & share** | PNG, animated GIF, video, FITS (with WCS), photometry CSV, JSON report, share links that reopen the exact view. |

## How the data stays fresh (without any personal computer)

```
 NASA/IPAC IRSA (TAP) ───────┐                       ┌─► GitHub Pages     (main site)
 NASA/JPL SBDB · Horizons ───┤   GitHub Actions      ├─► Cloudflare Pages (backup site)
 NASA Exoplanet Archive ─────┼─► every 6 hours, on ──┤
 NASA.gov · Images API ──────┘   GitHub's servers    └─► data branch ─► jsDelivr CDN (data fallback)

 NASA SPHEREx archive on AWS (Open Data) ──HTTP range requests──► each visitor's browser
```

* **Pixels** are never copied: each visitor's browser streams only the bytes it needs straight
  from NASA's public `nasa-irsa-spherex` bucket, spread across eight of the bucket's hostnames.
  In the default *Auto* mode the first images of each batch arrive as whole rows (fastest), the rest as
  column-precise reads: about **0.12 MB per image instead of 0.65 MB** (of a 70 MB frame),
  pixel-identical. FITS, TAN-SIP WCS and RICE-compressed quality flags are decoded in a Web Worker.
* **Featured targets** (20 places and 15 moving objects) are pre-cut on GitHub's servers into one
  small file each, refreshed every 6 hours, so they open in about a second.
* **Known objects** are positioned by an N-body integration (Sun + 7 planets, JPL Horizons
  planet states) from JPL SBDB osculating elements, seen from SPHEREx's own orbit (parallax).
  Checked against JPL Horizons as seen from SPHEREx: **0.2–3″ for asteroids** and about 10″ for
  comets (unmodelled outgassing), below one 6.2″ SPHEREx pixel.
* **The catalogue** of all SPHEREx frames is rebuilt from IRSA every 6 hours and packed into small sky tiles.
* **Redundancy:** if a NASA service is down during a rebuild, the last good copy is restored
  automatically (live site → jsDelivr mirror) and the target packs are rebuilt from it. Installed
  apps keep running from their offline cache; every data file except the target packs also falls
  back to jsDelivr's CDN; and the Cloudflare backup site serves the complete app and data when
  GitHub is unavailable. The image streaming and Live page talk to NASA directly.

## Install

* **Android, Chrome:** tap **Install**; Chrome installs it in one tap.
* **Android, other browsers** (Samsung Internet, Opera, Edge, Brave…): tap **Install** → **Install with
  Chrome**. These browsers build installed web apps from an old Android template that recent Android
  warns about; Chrome does not. Without Chrome, add it as a home-screen shortcut, or use the signed
  Android app (Trusted Web Activity, targets the latest Android, runs on Android 5+) under
  *Other options*.
* **iPhone / iPad (iOS 11.3+):** Safari → Share → *Add to Home Screen* (also Chrome/Edge on iOS 16.4+).
* **Windows / macOS / Linux / ChromeOS:** **Install** button or the install icon in the address bar;
  Safari on Mac: File → *Add to Dock*.
* **Offline / airplane mode:** the app, sky map and mission data are cached on first visit. Use
  **Save offline** on a target to keep its images.

## Privacy & security

No accounts, cookies, trackers or ads. A strict Content-Security-Policy allows scripts only from
the app itself and network access only to NASA archives, the CDS services and the named mirrors.
All remote text is rendered as text, never as HTML; exported CSV cells cannot run as formulas.

## Run locally

```bash
pip install -r tools/requirements.txt    # numpy, for the pre-built target packs
python3 tools/build_data.py site/data    # ~10-15 min, pulls everything from NASA
cd site && python3 -m http.server 8000   # open http://localhost:8000
```

The app itself needs no build step: plain HTML, CSS and JavaScript modules (the deploy only
minifies them). `tools/thumbs.py` regenerates the featured-card thumbnails (needs Pillow) and the
featured list lives in one place, `site/js/featured.js`.

### Android app

`.github/workflows/android.yml` builds a signed Trusted Web Activity for `skyshift.pages.dev`
whenever `android/` changes. It needs the repository secrets `ANDROID_KEYSTORE_B64` and
`ANDROID_KEYSTORE_PASSWORD`; keep a private backup of the keystore, because updates must be signed
with the same key. `site/.well-known/assetlinks.json` holds the matching certificate fingerprint.

## Data credits

This publication makes use of data products from the Spectro-Photometer for the History of the
Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet
Propulsion Laboratory and the California Institute of Technology, and is funded by the National
Aeronautics and Space Administration. SPHEREx QR data: DOI [10.26131/IRSA652](https://www.ipac.caltech.edu/doi/irsa/10.26131/IRSA652).
SPHEREx data are provided by NASA/IPAC IRSA under the [IRSA data use terms](https://irsa.ipac.caltech.edu/data_use_terms.html).

Also: NASA/JPL Solar System Dynamics (SBDB, Horizons, CNEOS), NASA Exoplanet Archive, NASA.gov,
NASA Image and Video Library, NASA WISE/NEOWISE (unWISE) and 2MASS imagery via the CDS hips2fits
service, CDS Sesame name resolver. SkyShift is an independent project and is not endorsed by NASA.

## License

Code: MIT, see [LICENSE](LICENSE). Data and imagery remain under their providers' terms (above).
