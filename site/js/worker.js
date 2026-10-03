// SkyShift worker: streams SPHEREx cutouts off the UI thread.
import { cutout, quicklook } from './fits.js';

const jobs = new Map();

self.onmessage = async ev => {
  const m = ev.data;
  if (m.cmd === 'cancel') { jobs.get(m.job)?.abort(); jobs.delete(m.job); return; }
  if (m.cmd === 'cutouts') {
    const ctl = new AbortController();
    jobs.set(m.job, ctl);
    const queue = m.frames.map((f, i) => [f, i]);
    const conc = m.concurrency || 4;
    let done = 0;
    const run = async () => {
      while (queue.length && !ctl.signal.aborted) {
        const [f, i] = queue.shift();
        try {
          const target = m.targets ? m.targets[i] : m.target;
          const r = await cutout(f, target, m.opts, ctl.signal);
          done++;
          if (r) self.postMessage({ job: m.job, type: 'frame', i, r, done }, [r.data.buffer]);
          else self.postMessage({ job: m.job, type: 'skip', i, done });
        } catch (e) {
          done++;
          if (ctl.signal.aborted) return;
          self.postMessage({ job: m.job, type: 'error', i, done, error: String(e && e.message || e) });
        }
      }
    };
    await Promise.all(Array.from({ length: conc }, run));
    if (!ctl.signal.aborted) self.postMessage({ job: m.job, type: 'end' });
    jobs.delete(m.job);
  }
  if (m.cmd === 'quicklook') {
    try {
      const r = await quicklook(m.key, m.rows, m.bin);
      self.postMessage({ job: m.job, type: 'quicklook', r: { data: r.data, w: r.w, h: r.h, ra: r.ra, dec: r.dec, date: r.cards['DATE-AVG'] || r.cards['DATE-OBS'], mjd: r.cards['MJD-AVG'] } }, [r.data.buffer]);
    } catch (e) {
      self.postMessage({ job: m.job, type: 'error', error: String(e && e.message || e) });
    }
  }
};
