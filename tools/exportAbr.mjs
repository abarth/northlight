/**
 * Exports a Northlight brush group to a Photoshop .abr file, then verifies it
 * by parsing the bytes back with the importer and diffing every setting that
 * survives a round trip.
 *
 *   node tools/exportAbr.mjs brushes/Northlight-Oil-Fresco.abr oil
 *
 * Env: CHROMIUM_PATH.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

const OUT = process.argv[2] ?? 'brushes/Northlight-Oil-Fresco.abr';
const GROUP = process.argv[3] ?? 'oil';
const PORT = process.env.PORT ?? '4190';

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

const res = await page.evaluate(async (GROUP) => {
  const NL = window.__northlight;
  const group = NL.brush.presets.allGroups().find((g) => g.id === GROUP);
  if (!group) throw new Error('group not found: ' + GROUP);

  const brushes = group.presets.map((p) => ({ name: p.name, settings: p.settings }));
  const buf = NL.brush.abrWrite.writeAbr(brushes);

  // ---- verify: parse our own bytes back ----
  const back = NL.brush.abr.parseAbr(buf);
  const issues = [];
  const near = (a, b, tol, what, i) => {
    if (Math.abs(a - b) > tol) issues.push(`[${i}] ${what}: wrote ${a}, read ${b}`);
  };
  const eq = (a, b, what, i) => {
    if (a !== b) issues.push(`[${i}] ${what}: wrote ${JSON.stringify(a)}, read ${JSON.stringify(b)}`);
  };

  if (back.brushes.length !== brushes.length) {
    issues.push(`brush count: wrote ${brushes.length}, read ${back.brushes.length}`);
  }

  back.brushes.forEach((got, i) => {
    const want = brushes[i];
    const s = want.settings;
    const g = got.settings;
    eq(want.name, got.name, 'name', i);
    near(s.tip.size, g.tip.size, 0.01, 'tip.size', i);
    near(s.tip.spacing, g.tip.spacing, 1e-6, 'tip.spacing', i);
    near(s.tip.angle, g.tip.angle, 1e-6, 'tip.angle', i);
    near(s.tip.roundness, g.tip.roundness, 1e-6, 'tip.roundness', i);

    eq(s.shape.enabled, !!g.shape?.enabled, 'shape.enabled', i);
    if (s.shape.enabled) {
      eq(s.shape.sizeControl.source, g.shape.sizeControl.source, 'shape.sizeControl', i);
      eq(s.shape.angleControl.source, g.shape.angleControl.source, 'shape.angleControl', i);
      near(s.shape.sizeJitter, g.shape.sizeJitter, 1e-6, 'shape.sizeJitter', i);
      near(s.shape.angleJitter, g.shape.angleJitter, 1e-6, 'shape.angleJitter', i);
      near(s.shape.minDiameter, g.shape.minDiameter, 1e-6, 'shape.minDiameter', i);
      near(s.shape.minRoundness, g.shape.minRoundness, 1e-6, 'shape.minRoundness', i);
    }

    eq(s.dual.enabled, !!g.dual?.enabled, 'dual.enabled', i);
    if (s.dual.enabled) {
      near(s.dual.size, g.dual.size, 0.01, 'dual.size', i);
      near(s.dual.spacing, g.dual.spacing, 1e-6, 'dual.spacing', i);
      near(s.dual.scatter, g.dual.scatter, 1e-6, 'dual.scatter', i);
      eq(s.dual.bothAxes, g.dual.bothAxes, 'dual.bothAxes', i);
      eq(s.dual.count, g.dual.count, 'dual.count', i);
      near(s.dual.countJitter, g.dual.countJitter, 1e-6, 'dual.countJitter', i);
      eq(s.dual.mode, g.dual.mode, 'dual.mode', i);
      // the dual tip must resolve to a real sampled bitmap in this file
      if (!back.tips.has(g.dual.shape)) issues.push(`[${i}] dual tip unresolved: ${g.dual.shape}`);
    }

    eq(s.texture.enabled, !!g.texture?.enabled, 'texture.enabled', i);
    if (s.texture.enabled) {
      near(s.texture.depth, g.texture.depth, 1e-6, 'texture.depth', i);
      near(s.texture.scale, g.texture.scale, 1e-6, 'texture.scale', i);
      eq(s.texture.mode, g.texture.mode, 'texture.mode', i);
      eq(s.texture.textureEachTip, g.texture.textureEachTip, 'texture.eachTip', i);
      if (!got.texturePatternId) issues.push(`[${i}] texture pattern unresolved`);
    }

    eq(s.transfer.enabled, !!g.transfer?.enabled, 'transfer.enabled', i);
    if (s.transfer.enabled) {
      eq(s.transfer.flowControl.source, g.transfer.flowControl.source, 'transfer.flowControl', i);
      near(s.transfer.flowMin, g.transfer.flowMin, 1e-6, 'transfer.flowMin', i);
      near(s.transfer.flowJitter, g.transfer.flowJitter, 1e-6, 'transfer.flowJitter', i);
    }

    near(s.flow, g.flow, 1e-6, 'flow', i);
    near(s.opacity, g.opacity, 1e-6, 'opacity', i);
    eq(s.blendMode, g.blendMode, 'blendMode', i);

    if (!got.tipId || !back.tips.has(got.tipId)) issues.push(`[${i}] primary tip unresolved`);
  });

  // ---- tip bitmaps survived? compare against the live generated maps ----
  const tipReport = [];
  const seen = new Set();
  for (const b of brushes) {
    for (const shape of [b.settings.tip.shape, b.settings.dual.enabled ? b.settings.dual.shape : null]) {
      if (!shape || shape === 'round' || seen.has(shape)) continue;
      seen.add(shape);
      const src = NL.brush.patterns.getTip(shape);
      let ink = 0, minX = src.size, maxX = -1, minY = src.size, maxY = -1;
      for (let y = 0; y < src.size; y++) {
        for (let x = 0; x < src.size; x++) {
          if (src.data[y * src.size + x] > 0) {
            ink++;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      tipReport.push({ shape, srcSize: src.size, ink: [maxX - minX + 1, maxY - minY + 1] });
    }
  }
  const parsedTips = [...back.tips].map(([id, m]) => {
    let sum = 0;
    for (const v of m.data) sum += v;
    return { id: id.slice(0, 8), size: m.size, mean: +(sum / m.data.length / 255).toFixed(3) };
  });

  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return {
    b64: btoa(bin), size: bytes.length, issues,
    names: back.brushes.map((b) => b.name),
    tipReport, parsedTips,
    patterns: [...back.patterns].map(([id, p]) => ({ id: id.slice(0, 8), name: p.name, size: p.map.size })),
  };
}, GROUP);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(res.b64, 'base64'));
console.log(`wrote ${OUT} — ${(res.size / 1048576).toFixed(2)} MB, ${res.names.length} brushes`);
console.log('\nsource tips (square map -> ink box):');
for (const t of res.tipReport) console.log(`  ${t.shape.padEnd(18)} ${t.srcSize}px -> ${t.ink[0]}x${t.ink[1]}`);
console.log('\nre-parsed from the written file:');
for (const t of res.parsedTips) console.log(`  tip ${t.id}  ${t.size}px  mean=${t.mean}`);
for (const p of res.patterns) console.log(`  pattern ${p.id}  "${p.name}"  ${p.size}px`);
console.log('\nbrushes: ' + res.names.join(', '));
if (res.issues.length) {
  console.log(`\nROUND-TRIP ISSUES (${res.issues.length}):`);
  for (const s of res.issues) console.log('  ' + s);
} else {
  console.log('\nround-trip: OK — every checked setting survived');
}
await browser.close();
server.kill();
process.exit(res.issues.length ? 1 : 0);
