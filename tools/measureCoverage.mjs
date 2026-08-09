/**
 * Measures how much of a brush mark is actually inked.
 *
 * Strokes are painted onto a transparent layer, so the composite's alpha
 * channel is the coverage directly. Three numbers are reported, because
 * "light" is ambiguous between two very different things:
 *
 *   coverage  fraction of the mark's own band carrying meaningful ink.
 *             Low coverage = bare paper inside the mark: fuzzy, wispy, holey.
 *   density   mean alpha where there IS ink. Low density = thin, glazed.
 *   ink       mean alpha over the whole band (coverage * density).
 *   dropout   longest run of columns carrying under 40% of the stroke's
 *             median column ink. The dual mask is multiplicative, so a
 *             stretch of spine its train happens to miss goes very thin or
 *             bare — a visible break. Measuring it RELATIVE to the stroke's
 *             own median matters: on a soft tip the break still carries a
 *             little ink, so a test for completely empty columns misses
 *             exactly the breaks the eye picks out. Breaks are a chance
 *             event, so this is the worst over several seeds.
 *
 * A veil and a wisp can lay down the same ink and look nothing alike: the
 * veil is uniformly thin (high coverage, low density), the wisp is scattered
 * strands of solid paint (low coverage, high density).
 *
 *   node tools/measureCoverage.mjs --group oil
 *
 * Env: CHROMIUM_PATH.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const GROUP = flag('--group') ?? 'oil';
const SEEDS = Number(flag('--seeds') ?? 6);
const PORT = process.env.PORT ?? '4191';

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
  args: ['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan',
         '--use-vulkan=swiftshader', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(APP);
await page.waitForFunction(() => !!window.__northlight, null, { timeout: 30000 });

const rows = await page.evaluate(async ({ GROUP, SEEDS }) => {
  const NL = window.__northlight;
  const group = NL.brush.presets.allGroups().find((g) => g.id === GROUP);
  if (!group) throw new Error('group not found: ' + GROUP);

  const W = 1400, H = 620;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const eng = await NL.PaintEngine.create(canvas, W, H);
  const state = {
    layers: [{ id: 'bg', name: 'bg', visible: true, opacity: 1, blendMode: 'normal' }],
    activeLayerId: 'bg', view: { zoom: 1, panX: 0, panY: 0 },
  };

  const mk = (seed) => { let a = seed >>> 0; return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  const out = [];
  for (const preset of group.presets) {
   // A mask break is a chance event: whether a run of dual stamps all miss
   // the spine depends on the draw, so one stroke can easily look clean.
   // Sample several seeds and keep the worst.
   const seedRuns = [];
   for (let seedIdx = 0; seedIdx < SEEDS; seedIdx++) {
    // transparent layer: the composite's alpha IS the coverage
    eng.ensureLayer('bg');
    eng.fillLayer('bg', [0, 0, 0, 0]);

    const pts = [];
    for (let x = 120; x <= W - 120; x += 6) {
      pts.push({ x, y: H / 2, pressure: 0.85, tiltX: 0, tiltY: 0, twist: 0 });
    }
    eng.beginStroke(NL.brush.engineStrokeParams(preset.settings, 'paint'));
    const s = new NL.StrokeSession(eng, preset.settings,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 }, rng: mk(4242 + seedIdx * 9871) });
    s.down(pts[0]);
    s.move(pts.slice(1));
    s.up();
    eng.endStroke('bg');

    const data = await eng.readComposite(state);
    // measurement window avoids the terminals, where coverage tapers by design
    const x0 = 320, x1 = W - 320;
    const THRESH = 13; // ~5% alpha

    // The band is the mark's own vertical extent: 2nd..98th percentile of
    // inked rows, so a few stray scattered dabs do not inflate it.
    const rowCount = new Float64Array(H);
    let total = 0;
    for (let y = 0; y < H; y++) {
      for (let x = x0; x < x1; x++) {
        if (data[(y * W + x) * 4 + 3] >= THRESH) { rowCount[y]++; total++; }
      }
    }
    if (total === 0) { seedRuns.push({ coverage: 0, density: 0, ink: 0, band: 0, maxGap: 0 }); continue; }
    let acc = 0, yLo = 0, yHi = H - 1;
    for (let y = 0; y < H; y++) { acc += rowCount[y]; if (acc >= total * 0.02) { yLo = y; break; } }
    acc = 0;
    for (let y = H - 1; y >= 0; y--) { acc += rowCount[y]; if (acc >= total * 0.02) { yHi = y; break; } }

    let covered = 0, sumCovered = 0, sumAll = 0;
    for (let y = yLo; y <= yHi; y++) {
      for (let x = x0; x < x1; x++) {
        const a = data[(y * W + x) * 4 + 3];
        sumAll += a;
        if (a >= THRESH) { covered++; sumCovered += a; }
      }
    }
    // relative dropout: compare each column against the stroke's own median
    const colSum = new Float64Array(x1 - x0);
    for (let y = yLo; y <= yHi; y++) {
      for (let x = x0; x < x1; x++) colSum[x - x0] += data[(y * W + x) * 4 + 3];
    }
    const sorted = Array.from(colSum).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    let maxGap = 0, run = 0;
    for (let i = 0; i < colSum.length; i++) {
      if (colSum[i] < median * 0.4) { run++; if (run > maxGap) maxGap = run; } else run = 0;
    }
    const bandPx = (yHi - yLo + 1) * (x1 - x0);
    seedRuns.push({
      coverage: covered / bandPx,
      density: sumCovered / Math.max(1, covered) / 255,
      ink: sumAll / bandPx / 255,
      band: yHi - yLo + 1,
      maxGap,
    });
   }
   const avg = (k) => seedRuns.reduce((a, r) => a + r[k], 0) / seedRuns.length;
   out.push({
     name: preset.name,
     coverage: avg('coverage'), density: avg('density'), ink: avg('ink'),
     band: Math.round(avg('band')),
     maxGap: Math.max(...seedRuns.map((r) => r.maxGap)),
       gapSeeds: seedRuns.filter((r) => r.maxGap >= 20).length,
   });
  }
  return out;
}, { GROUP, SEEDS });

rows.sort((a, b) => b.coverage - a.coverage);
console.log(`\n${'brush'.padEnd(22)} coverage  density    ink   band  worst dropout (of ${SEEDS} seeds)`);
console.log('-'.repeat(80));
for (const r of rows) {
  const flag = r.maxGap >= 20 && r.coverage > 0.6
    ? `  <-- breaks in ${r.gapSeeds}/${SEEDS}` : '';
  console.log(`${r.name.padEnd(22)}   ${(r.coverage * 100).toFixed(0).padStart(3)}%    ` +
              `${r.density.toFixed(2)}   ${r.ink.toFixed(2)}  ${String(r.band).padStart(4)}px  ` +
              `${String(r.maxGap).padStart(4)}px${flag}`);
}
await browser.close();
server.kill();
process.exit(0);
