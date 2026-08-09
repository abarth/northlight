/**
 * Renders test strokes for Northlight brush presets to a labelled PNG, so the
 * marks can be eyeballed.
 *
 *   node tools/renderBrushSheet.mjs out.png fresco-sponge            # one brush, detailed
 *   node tools/renderBrushSheet.mjs out.png --group oil              # every preset in a group
 *   node tools/renderBrushSheet.mjs out.png --group oil --slice 0 6  # rows 0..5
 *   node tools/renderBrushSheet.mjs out.png fresco-sponge --compare  # vs the reference .abr
 *
 * Env: CHROMIUM_PATH, REF_ABR.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const OUT = argv[0] ?? 'strokes.png';
const flag = (n) => { const i = argv.indexOf(n); return i < 0 ? null : argv[i + 1]; };
const GROUP = flag('--group');
const ABR = flag('--abr');
const COMPARE = argv.includes('--compare');
const PRESET = !GROUP && argv[1] && !argv[1].startsWith('--') ? argv[1] : 'fresco-sponge';
const sliceAt = argv.indexOf('--slice');
const SLICE = sliceAt < 0 ? null : [Number(argv[sliceAt + 1]), Number(argv[sliceAt + 2])];
const REF_ABR = process.env.REF_ABR ??
  '/root/.claude/uploads/2a3dcef1-2c29-5053-a46d-4dd2d0e5bf96/ab52a52a-Size_Flow_Gang.abr';
const PORT = process.env.PORT ?? '4188';
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
         '--use-vulkan=swiftshader', '--use-angle=swiftshader',
         '--enable-webgpu-developer-features'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(APP);
await page.waitForFunction(() => !!window.__northlight, null, { timeout: 30000 });

const refB64 = COMPARE ? readFileSync(REF_ABR).toString('base64') : null;
const abrB64 = ABR ? readFileSync(ABR).toString('base64') : null;

const result = await page.evaluate(async ({ W, PRESET, GROUP, SLICE, refB64, abrB64 }) => {
  const NL = window.__northlight;

  // ---- pick the brushes to draw ----
  const brushes = [];
  const decode = (b64) => {
    const bin = atob(b64);
    const buf = new ArrayBuffer(bin.length);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return buf;
  };
  if (abrB64) {
    // round-trip proof: draw the brushes as they come back out of the .abr
    const before = new Set(NL.brush.presets.allGroups().map((g) => g.id));
    NL.brush.importAbr('exported.abr', decode(abrB64));
    const g = NL.brush.presets.allGroups().find((x) => !before.has(x.id));
    let list = g.presets;
    if (SLICE) list = list.slice(SLICE[0], SLICE[1]);
    for (const pr of list) brushes.push({ label: pr.name + ' (from .abr)', settings: pr.settings, compact: true });
  } else if (GROUP) {
    const g = NL.brush.presets.allGroups().find((x) => x.id === GROUP);
    if (!g) throw new Error('group not found: ' + GROUP);
    let list = g.presets;
    if (SLICE) list = list.slice(SLICE[0], SLICE[1]);
    for (const pr of list) brushes.push({ label: pr.name, settings: pr.settings, compact: true });
  } else {
    const main = NL.brush.presets.findPreset(PRESET);
    if (!main) throw new Error('preset not found: ' + PRESET);
    brushes.push({ label: main.name, settings: main.settings, compact: false });
  }
  if (refB64) {
    NL.brush.importAbr('Size_Flow_Gang.abr', decode(refB64));
    for (const g of NL.brush.presets.allGroups()) {
      for (const pr of g.presets) {
        if (/spongy/i.test(pr.name) && !/tri|oval/i.test(pr.name)) {
          brushes.push({ label: pr.name + ' (reference)', settings: pr.settings, compact: false });
        }
      }
    }
  }

  const ROW = brushes[0].compact ? 236 : 510;
  const H = brushes.length * ROW + 24;

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

  const samp = (x, y, p) => ({ x, y, pressure: p, tiltX: 0, tiltY: 0, twist: 0 });
  const stroke = (settings, pts, seed) => {
    eng.beginStroke(NL.brush.engineStrokeParams(settings, 'paint'));
    const s = new NL.StrokeSession(eng, settings,
      { fg: { h: 24, s: 0.62, v: 0.3 }, bg: { h: 40, s: 0.3, v: 0.85 }, rng: mk(seed) });
    s.down(pts[0]);
    s.move(pts.slice(1));
    s.up();
    eng.endStroke('bg');
  };

  const labels = [];
  let seed = 1000;
  brushes.forEach((b, bi) => {
    const y0 = bi * ROW + 20;
    labels.push({ y: y0, text: b.label });

    // long constant-pressure stroke: the clearest test for repetition,
    // and its flanks show the edge hardness
    {
      const pts = [];
      for (let x = 250; x <= W - 40; x += 6) pts.push(samp(x, y0 + 62, 0.85));
      stroke(b.settings, pts, seed++);
    }
    // pressure ramp 0 -> 1 -> 0: taper and terminal softness
    {
      const pts = [];
      const x0 = 250, x1 = W - 40;
      for (let x = x0; x <= x1; x += 6) {
        const t = (x - x0) / (x1 - x0);
        pts.push(samp(x, y0 + 165, Math.max(0.03, Math.sin(t * Math.PI))));
      }
      stroke(b.settings, pts, seed++);
    }
    if (!b.compact) {
      for (let k = 0; k < 9; k++) {
        const pts = [];
        const bx = 60 + k * 150;
        for (let t = 0; t <= 1.0001; t += 0.02) {
          pts.push(samp(bx + t * 190 + Math.sin(t * 3) * 20,
                        y0 + 300 + t * 150 + Math.cos(t * 2.5) * 18,
                        0.35 + 0.6 * Math.sin(t * Math.PI)));
        }
        stroke(b.settings, pts, seed++);
      }
    }
  });

  // ---- composite, then label with the 2D canvas ----
  const data = await eng.readComposite(state);
  const flat = document.createElement('canvas');
  flat.width = W; flat.height = H;
  const ctx = flat.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), W, H), 0, 0);
  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillStyle = '#1a1410';
  for (const l of labels) ctx.fillText(l.text, 18, l.y + 60);
  const out = ctx.getImageData(0, 0, W, H).data;
  return { data: Array.from(out), W, H, labels: labels.map((l) => l.text) };
}, { W, PRESET, GROUP, SLICE, refB64, abrB64 });

writeFileSync(OUT, png(result.W, result.H, Uint8Array.from(result.data)));
console.log('wrote', OUT, `${result.W}x${result.H}`);
result.labels.forEach((t, i) => console.log(`  row ${i}: ${t}`));
await browser.close();
server.kill();
process.exit(0);
