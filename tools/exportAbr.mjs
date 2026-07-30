/**
 * Writes the brush presets out as a Photoshop .abr file.
 *
 * Runs the real exporter (src/brush/abrWrite.ts) in headless Chromium against
 * the built app, so the tips it embeds are the same maps the engine paints
 * with, then writes the bytes to disk.
 *
 * Usage:
 *   npm run build && node tools/exportAbr.mjs [group-id ...]
 *
 * With no arguments it exports the `alla-prima` group. Pass `all` for every
 * built-in group, or one or more group ids (general, size-flow, opacity-flow,
 * dry-media, alla-prima, wet-media, fx).
 *
 * Bristle tips normally go out as Photoshop bristle brushes, so Photoshop draws
 * them with its own bristle engine and the Bristle Qualities sliders stay live.
 * `--sampled` embeds northlight's own tip bitmaps instead: the mark is then
 * exactly the one northlight paints, but the sliders are gone.
 *
 * Env: APP_URL, CHROMIUM_PATH, CHROMIUM_FLAGS, OUT (output path).
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
// --sampled embeds our own tip bitmaps instead of Photoshop bristle tips
const sampled = argv.includes('--sampled');
const groups = argv.filter((a) => a !== '--sampled');
const PORT = process.env.PORT ?? '4187';
let appUrl = process.env.APP_URL;
let server = null;

if (!appUrl) {
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
  const viteBin = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname;
  server = spawn(process.execPath, [viteBin, 'preview', '--port', PORT, '--strictPort'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  appUrl = `http://localhost:${PORT}/`;
  let exited = false;
  server.on('exit', () => {
    exited = true;
  });
  process.on('exit', () => {
    if (!exited) server.kill();
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) {
      console.error('vite preview exited before serving.');
      process.exit(1);
    }
    try {
      if ((await fetch(appUrl)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      console.error(`timed out waiting for ${appUrl}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--no-sandbox',
    ...(process.env.CHROMIUM_FLAGS ?? '--enable-unsafe-webgpu').split(' ').filter(Boolean),
  ],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`${appUrl}?w=64&h=64`);
await page.waitForTimeout(800);

const out = await page.evaluate(({ wanted, sampled }) => {
  const NL = window.__northlight;
  const all = NL.brush.presets.BRUSH_GROUPS;
  const ids = wanted.length === 0 ? ['alla-prima'] : wanted.includes('all') ? all.map((g) => g.id) : wanted;
  const picked = ids.map((id) => {
    const g = all.find((x) => x.id === id);
    if (!g) throw new Error(`unknown group: ${id}`);
    return g;
  });
  const brushes = picked.flatMap((g) =>
    g.presets.map((p) => ({ name: p.name, settings: p.settings })),
  );
  const buf = NL.brush.abrWrite.writeAbr(brushes, { bristleAsSampled: sampled });

  // Read it straight back with the parser as a sanity check before it lands
  // on disk, so a broken file never gets written.
  const back = NL.brush.abr.parseAbr(buf);

  let binary = '';
  const u8 = new Uint8Array(buf);
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return {
    base64: btoa(binary),
    names: brushes.map((b) => b.name),
    groups: picked.map((g) => g.name),
    parsed: { brushes: back.brushes.length, tips: back.tips.size, patterns: back.patterns.size },
    bristle: back.brushes.filter((b) => NL.brush.bristle.isBristleTip(b.settings.tip?.shape ?? ''))
      .length,
  };
}, { wanted: groups, sampled });

await browser.close();
if (server) server.kill();

if (out.parsed.brushes !== out.names.length) {
  console.error(
    `refusing to write: wrote ${out.names.length} brushes but the parser found ${out.parsed.brushes}`,
  );
  process.exit(1);
}

const suffix = sampled ? '-sampled' : '';
const path =
  process.env.OUT ??
  new URL(`../brushes/northlight-alla-prima${suffix}.abr`, import.meta.url).pathname;
const bytes = Buffer.from(out.base64, 'base64');
writeFileSync(path, bytes);
console.log(`wrote ${path} (${(bytes.length / 1024).toFixed(0)} KB)`);
console.log(`  groups:   ${out.groups.join(', ')}`);
console.log(`  brushes:  ${out.parsed.brushes} — ${out.names.join(', ')}`);
console.log(`  tips:     ${out.parsed.tips} sampled bitmap(s), ${out.bristle} bristle`);
console.log(`  patterns: ${out.parsed.patterns}`);
