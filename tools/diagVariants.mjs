/**
 * Renders one preset several times with targeted setting overrides, to
 * isolate which control is responsible for an artifact.
 *
 *   node tools/diagVariants.mjs out.png bone-dust
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const OUT = process.argv[2] ?? 'diag.png';
const PRESET = process.argv[3] ?? 'bone-dust';
const PORT = process.env.PORT ?? '4192';
const W = 1500;

function png(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2];
    }
  }
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  const chunk = (tag, payload) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
    const body = Buffer.concat([Buffer.from(tag), payload]);
    let c = -1;
    for (const b of body) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ -1) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

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

const result = await page.evaluate(async ({ W, PRESET }) => {
  const NL = window.__northlight;
  const base = NL.brush.presets.findPreset(PRESET);
  if (!base) throw new Error('preset not found: ' + PRESET);

  // Each variant knocks out one suspect. Whichever removes the gaps is the
  // one responsible.
  const variants = [
    ['as shipped', (s) => s],
    ['dual OFF', (s) => { s.dual.enabled = false; return s; }],
    ['dual scatter 0', (s) => { s.dual.scatter = 0; return s; }],
    ['dual spacing 0.3 -> 0.12', (s) => { s.dual.spacing = 0.12; return s; }],
    ['dual count 1 -> 3', (s) => { s.dual.count = 3; return s; }],
  ];

  const ROW = 150;
  const H = variants.length * ROW + 30;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const eng = await NL.PaintEngine.create(canvas, W, H);
  eng.ensureLayer('bg');
  eng.fillLayer('bg', [0.97, 0.955, 0.92, 1]);
  const state = {
    layers: [{ id: 'bg', name: 'bg', visible: true, opacity: 1, blendMode: 'normal' }],
    activeLayerId: 'bg', view: { zoom: 1, panX: 0, panY: 0 },
  };
  const mk = (seed) => { let a = seed >>> 0; return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  const labels = [];
  variants.forEach(([label, mutate], i) => {
    const s = mutate(structuredClone(base.settings));
    const y = i * ROW + 75;
    labels.push({ y, text: label });
    const pts = [];
    for (let x = 300; x <= W - 40; x += 6) {
      pts.push({ x, y, pressure: 0.85, tiltX: 0, tiltY: 0, twist: 0 });
    }
    eng.beginStroke(NL.brush.engineStrokeParams(s, 'paint'));
    // same seed everywhere, so the trains line up and differences are causal
    const ss = new NL.StrokeSession(eng, s,
      { fg: { h: 24, s: 0.62, v: 0.3 }, bg: { h: 40, s: 0.3, v: 0.85 }, rng: mk(7) });
    ss.down(pts[0]);
    ss.move(pts.slice(1));
    ss.up();
    eng.endStroke('bg');
  });

  const data = await eng.readComposite(state);
  const flat = document.createElement('canvas');
  flat.width = W; flat.height = H;
  const ctx = flat.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
  ctx.font = '600 18px system-ui, sans-serif';
  ctx.fillStyle = '#1a1410';
  for (const l of labels) ctx.fillText(l.text, 16, l.y + 5);
  return { data: Array.from(ctx.getImageData(0, 0, W, H).data), W, H,
           labels: labels.map((l) => l.text),
           step: NL.brush.dynamics.dualSpacingPx(base.settings.dual),
           reach: base.settings.dual.scatter * base.settings.dual.size / 2,
           radius: base.settings.dual.size / 2 };
}, { W, PRESET });

writeFileSync(OUT, png(result.W, result.H, Uint8Array.from(result.data)));
console.log('wrote', OUT);
console.log(`dual train: step ${result.step.toFixed(1)}px, scatter reach +-${result.reach.toFixed(1)}px, stamp radius ${result.radius}px`);
result.labels.forEach((t, i) => console.log(`  row ${i}: ${t}`));
await browser.close();
server.kill();
process.exit(0);
