/**
 * Renders every organic brush tip (and the linen pattern) into one grayscale
 * contact sheet, so the generated bitmaps can be eyeballed.
 *
 *   node tools/renderTipSheet.mjs out.png
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const OUT = process.argv[2] ?? 'tips.png';
const PORT = process.env.PORT ?? '4189';
const CELL = 300, COLS = 4, PAD = 6;

function pngGray(w, h, gray) {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    gray.copy ? gray.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w)
              : Buffer.from(gray.subarray(y * w, (y + 1) * w)).copy(raw, y * (w + 1) + 1);
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
  ihdr[8] = 8; ihdr[9] = 0;
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
  args: ['--no-sandbox', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
await page.goto(APP);
await page.waitForFunction(() => !!window.__northlight, null, { timeout: 30000 });

const tiles = await page.evaluate((CELL) => {
  const NL = window.__northlight;
  const ids = Object.keys(NL.brush.patterns.getPattern ? {} : {});
  const tipIds = [
    'sponge-fractal', 'granite-grit', 'crackle-web',
    'fiber-drag', 'mist-billow', 'stipple-flecks',
    'wisp-filament', 'dust-motes',
    'lichen-crust', 'bone-pore', 'moss-tuft', 'bark-grain', 'rust-bloom',
    'bristle-chisel', 'bristle-round', 'blade-flat', 'plume-soft', 'fan-comb',
  ];
  const out = [];
  const box = (map) => {
    const { size, data } = map;
    const cell = new Uint8Array(CELL * CELL);
    for (let y = 0; y < CELL; y++) {
      const sy = Math.min(size - 1, Math.floor((y * size) / CELL));
      for (let x = 0; x < CELL; x++) {
        cell[y * CELL + x] = data[sy * size + Math.min(size - 1, Math.floor((x * size) / CELL))];
      }
    }
    return Array.from(cell);
  };
  for (const id of tipIds) {
    const t0 = performance.now();
    const map = NL.brush.patterns.getTip(id);
    const ms = performance.now() - t0;
    // Mean over the padded square is misleading; report the ink box, plus
    // how much of it is genuinely zero. Accumulation turns anything above
    // ~1% into solid ink, so only true zeros survive as gaps.
    let sum = 0, zero = 0, minX = map.size, maxX = -1, minY = map.size, maxY = -1;
    for (let y = 0; y < map.size; y++) {
      for (let x = 0; x < map.size; x++) {
        if (map.data[y * map.size + x] > 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const v = map.data[y * map.size + x];
        sum += v;
        if (v <= 2) zero++;
      }
    }
    const boxPx = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    out.push({ id, size: map.size, ms: Math.round(ms),
      mean: +(sum / boxPx / 255).toFixed(3), zero: +(zero / boxPx).toFixed(3),
      box: (maxX - minX + 1) + 'x' + (maxY - minY + 1), cell: box(map) });
  }
  const lp = NL.brush.patterns.getPattern('linen');
  let s2 = 0;
  for (const v of lp.data) s2 += v;
  out.push({ id: 'linen (pattern)', size: lp.size, ms: 0, mean: +(s2 / lp.data.length / 255).toFixed(3), cell: box(lp) });
  return out;
}, CELL);

const rows = Math.ceil(tiles.length / COLS);
const W = COLS * (CELL + PAD) + PAD, H = rows * (CELL + PAD) + PAD;
const sheet = Buffer.alloc(W * H, 40);
tiles.forEach((t, i) => {
  const cx = PAD + (i % COLS) * (CELL + PAD);
  const cy = PAD + Math.floor(i / COLS) * (CELL + PAD);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) sheet[(cy + y) * W + cx + x] = t.cell[y * CELL + x];
  }
});
writeFileSync(OUT, pngGray(W, H, sheet));
console.log('wrote', OUT);
for (const t of tiles) console.log(`  ${t.id.padEnd(18)} ${String(t.size).padStart(5)}px  ink=${String(t.box).padStart(9)}  mean=${String(t.mean).padEnd(5)}  zero=${String(t.zero ?? '').padEnd(5)}  gen=${t.ms}ms`);
await browser.close();
server.kill();
process.exit(0);
