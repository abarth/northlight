/**
 * Audits every preset's dual-mask train for the geometry that lets it miss
 * the stroke spine.
 *
 * The dual mask gates the primary multiplicatively, so wherever the train
 * leaves the spine uncovered the stroke paints nothing. Three numbers decide
 * how often that happens:
 *
 *   step   = spacing * size * aspect        distance between mask stamps
 *   reach  = scatter * size / 2             how far scatter throws one
 *   reff                                    radius out to which the tip still
 *                                           has ink — measured from the
 *                                           bitmap, since the ragged vignette
 *                                           means it is well inside size/2
 *
 * From those: a stamp misses the spine when its displacement exceeds reff,
 * with probability miss = max(0, 1 - reff/reach) for the uniform radial
 * offset the engine draws; and a spine point is nominally covered by
 * redundancy = 2*reff/step stamps. The chance all of them miss is roughly
 * miss^redundancy, which is the risk reported here.
 *
 * The fix, when risk is high, is to scale spacing and scatter down together:
 * that leaves rho = scatter/spacing (and so the decorrelation that stops the
 * mark repeating) untouched, while raising redundancy and cutting reach.
 *
 *   node tools/dualTrainAudit.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT ?? '4193';
const repoRoot = new URL('..', import.meta.url).pathname;
const viteBin = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname;
const server = spawn(process.execPath, [viteBin, 'preview', '--port', PORT, '--strictPort'],
  { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] });
process.on('exit', () => server.kill());
const APP = `http://localhost:${PORT}/`;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(APP)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(APP);
await page.waitForFunction(() => !!window.__northlight, null, { timeout: 30000 });

const rows = await page.evaluate(() => {
  const NL = window.__northlight;

  /** Radius holding 92% of the tip's ink, as a fraction of half its width. */
  const inkRadius = (shape) => {
    const { size, data } = NL.brush.patterns.getTip(shape);
    const c = (size - 1) / 2;
    const bins = 64;
    const hist = new Float64Array(bins);
    let total = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = data[y * size + x];
        if (!v) continue;
        const d = Math.hypot(x - c, y - c) / (size / 2);
        const b = Math.min(bins - 1, Math.floor(d * bins));
        hist[b] += v;
        total += v;
      }
    }
    let acc = 0;
    for (let b = 0; b < bins; b++) {
      acc += hist[b];
      if (acc >= total * 0.92) return (b + 1) / bins;
    }
    return 1;
  };

  const out = [];
  for (const g of NL.brush.presets.allGroups()) {
    if (!['oil', 'wisp', 'organic'].includes(g.id)) continue;
    for (const pr of g.presets) {
      const d = pr.settings.dual;
      if (!d.enabled) continue;
      const aspect = NL.brush.patterns.getTipAspect(d.shape);
      const step = NL.brush.dynamics.dualSpacingPx(d);
      const reach = d.scatter * d.size / 2;
      const reff = inkRadius(d.shape) * d.size / 2;
      const miss = Math.max(0, 1 - reff / Math.max(reach, 1e-6));
      const redundancy = (2 * reff) / step;
      const risk = Math.pow(miss, redundancy);
      out.push({
        group: g.id, name: pr.name, step, reach, reff, aspect,
        rho: d.scatter / d.spacing, miss, redundancy, risk,
      });
    }
  }
  return out;
});

rows.sort((a, b) => b.risk - a.risk);
console.log(`\n${'brush'.padEnd(20)} ${'grp'.padEnd(8)} step  reach  reff   rho   miss  redun    risk`);
console.log('-'.repeat(80));
for (const r of rows) {
  const flag = r.risk > 0.02 ? '  <--' : '';
  console.log(
    `${r.name.padEnd(20)} ${r.group.padEnd(8)}` +
    `${r.step.toFixed(0).padStart(4)}  ${r.reach.toFixed(0).padStart(5)}  ${r.reff.toFixed(0).padStart(4)}  ` +
    `${r.rho.toFixed(2).padStart(4)}  ${r.miss.toFixed(2)}  ${r.redundancy.toFixed(2).padStart(5)}  ` +
    `${r.risk.toFixed(4).padStart(6)}${flag}`);
}
await browser.close();
server.kill();
process.exit(0);
