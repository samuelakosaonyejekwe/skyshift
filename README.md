# SkyShift · SPHEREx Sky Time Machine

**Live app: https://samuelakosaonyejekwe.github.io/skyshift/**

A public web tool for the **2026 NASA Space Apps Challenge – "Planet X and SPHEREx"**.
SkyShift shows real images of the sky from NASA's SPHEREx mission and makes it easy for
anyone to see how the sky **changes over time**: asteroids, comets, dwarf planets,
fast-moving stars, brown dwarfs and variable stars.

It installs like an app on any phone, tablet or computer, and keeps working offline.

## What you can do

| | |
|---|---|
| **Explore** | All-sky map of SPHEREx coverage (1.47 million images, 100 % of the sky). Tap anywhere to open it. Featured targets, exoplanet hosts, newest frames. |
| **Time Machine** | Every SPHEREx image of a spot, in time order. **Movie**, **Blink** (the method that found Pluto), **Difference** (wavelength-matched), false-**Colour**, and **Then & now** against NASA WISE/NEOWISE and 2MASS. |
| **Spectrum & light curve** | Tap any star: SkyShift measures it in every image and plots its 0.75–5 µm spectrum and its brightness over time, with ice and gas features marked. |
| **Hunt** | Scans for new point sources, moving tracklets and changes between visits, then checks them against 55,000+ known asteroids and comets (NASA/JPL orbits, computed offline). Save candidates as "finds" and export them. |
| **Chase** | Follow a moving object (3I/ATLAS, Neptune, Pluto, Eris, Sedna, Ceres, comets… or any of 55,000 SBDB objects): the view re-centres on its predicted position in each image. |
| **Live** | Your browser reads NASA's SPHEREx archive directly: newest observing periods and brand-new frames, "developed" on demand. |
| **Mission** | Survey statistics, images per day, bands, data freshness, NASA SPHEREx news, NASA Image Library, upcoming asteroid close approaches. |
| **Export & share** | PNG, animated GIF, video, FITS (with WCS), photometry CSV, JSON report, share links that reopen the exact view. |

## How the data stays fresh (without any personal computer)

```
 NASA/IPAC IRSA ──TAP──┐                         ┌── GitHub Pages (app + index)
 NASA/JPL SBDB/Horizons├─► GitHub Actions ───────┤
 NASA Exoplanet Archive│   every 6 h, on GitHub's├── data branch ─► jsDelivr CDN mirror
 NASA.gov / Images API ┘   servers               └── keep-alive (no commits)

 NASA SPHEREx S3 archive (AWS Open Data) ──HTTP range requests──► each user's browser
```

* **Pixels** are never copied: each visitor's browser streams only the bytes it needs
  (a cutout of a 70 MB frame costs well under 1 MB) straight from NASA's public
  `nasa-irsa-spherex` bucket, decoding FITS, TAN-SIP WCS and RICE-compressed quality flags in a Web Worker.
* **The catalogue** of all SPHEREx frames is rebuilt from IRSA every 6 hours by a scheduled
  GitHub Actions job and packed into small sky tiles.
* **Redundancy:** if any NASA service is down during a rebuild, the last good copy is restored
  automatically (live site → CDN mirror). If GitHub Pages itself is unreachable, installed apps keep
  running from the offline cache, and the data files fall back to the jsDelivr / raw mirrors.
  The live archive features talk to NASA directly, so they keep working too.

## Install

* **Android / Chrome / Edge / Samsung Internet:** tap **Install** in the app (or browser menu → *Install app*).
* **iPhone / iPad:** Safari → Share → *Add to Home Screen*.
* **Windows / macOS / Linux / ChromeOS:** **Install** button or the install icon in the address bar; Safari on Mac: File → *Add to Dock*.
* **Offline / airplane mode:** the app shell, maps and mission data are cached on first visit. Use **Save offline** on a target to keep its images.

## Privacy & security

No accounts, cookies, trackers or ads. A strict Content-Security-Policy allows scripts only from
the app itself and network access only to NASA archives and the named mirrors. All remote text is
rendered as text, never as HTML.

## Run locally

```bash
python3 tools/build_data.py site/data   # ~10 min, pulls everything from NASA
cd site && python3 -m http.server 8000  # open http://localhost:8000
```

No build step and no dependencies: plain HTML, CSS and JavaScript modules; the pipeline uses only
the Python standard library.

## Data credits

This publication makes use of data products from the Spectro-Photometer for the History of the
Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet
Propulsion Laboratory and the California Institute of Technology, and is funded by the National
Aeronautics and Space Administration. SPHEREx QR data: DOI [10.26131/IRSA652](https://www.ipac.caltech.edu/doi/irsa/10.26131/IRSA652).

Also: NASA/JPL Solar System Dynamics (SBDB, Horizons, CNEOS), NASA Exoplanet Archive, NASA.gov,
NASA Image and Video Library, NASA WISE/NEOWISE (unWISE) and 2MASS imagery via CDS hips2fits,
CDS Sesame name resolver. SkyShift is an independent project and is not endorsed by NASA.

## License

MIT. See [LICENSE](LICENSE).
