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
 * `--no-texture` leaves the texture patterns out and Texture off.
 * `--probe` writes a ladder of small files into brushes/probes/, each adding
 * one construct, so a single import run in Photoshop isolates which one it
 * objects to.
 *
 * Env: APP_URL, CHROMIUM_PATH, CHROMIUM_FLAGS, OUT (output path).
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
// --sampled embeds our own tip bitmaps instead of Photoshop bristle tips
const sampled = argv.includes('--sampled');
const noTexture = argv.includes('--no-texture');
const probe = argv.includes('--probe');
const groups = argv.filter((a) => !a.startsWith('--'));
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

const out = await page.evaluate(({ wanted, sampled, noTexture, probe }) => {
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
  const opts = { bristleAsSampled: sampled, embedPatterns: !noTexture };
  const buf = NL.brush.abrWrite.writeAbr(brushes, opts);

  // Read it straight back with the parser as a sanity check before it lands
  // on disk, so a broken file never gets written.
  const back = NL.brush.abr.parseAbr(buf);

  // Diagnostic ladder: same two brushes, one construct added at each rung.
  const probes = [];
  if (probe) {
    const D = NL.brush.defaults;
    const off = (b) => D.mergeBrush(b, {
      shape: { ...b.shape, enabled: false },
      scatter: { ...b.scatter, enabled: false },
      texture: { ...b.texture, enabled: false },
      transfer: { ...b.transfer, enabled: false },
      color: { ...b.color, enabled: false },
      dual: { ...b.dual, enabled: false },
    });
    const two = brushes.slice(0, 2);
    const bare = two.map((b) => ({ name: b.name, settings: off(b.settings) }));
    const dynamic = two.map((b) => ({
      name: b.name,
      settings: D.mergeBrush(b.settings, { texture: { ...b.settings.texture, enabled: false } }),
    }));
    // Scattering is the one construct in the shipped file that no passing probe
    // has covered yet, so it gets its own rung.
    const scattered = bare.map((b) => ({
      name: b.name + ' Scatter',
      settings: D.mergeBrush(b.settings, {
        scatter: {
          ...b.settings.scatter,
          enabled: true,
          scatter: 0.3,
          count: 3,
          countJitter: 0.4,
          countControl: D.pressureControl(),
        },
      }),
    }));
    probes.push(
      ['probe-1-bristle', NL.brush.abrWrite.writeAbr(bare, { embedPatterns: false })],
      ['probe-2-dynamics', NL.brush.abrWrite.writeAbr(dynamic, { embedPatterns: false })],
      ['probe-3-texture', NL.brush.abrWrite.writeAbr(two, { embedPatterns: true })],
      ['probe-4-sampled', NL.brush.abrWrite.writeAbr(bare.slice(0, 1),
        { bristleAsSampled: true, embedPatterns: false })],
      ['probe-5-scatter', NL.brush.abrWrite.writeAbr(scattered, { embedPatterns: false })],
    );
  }
  const b64 = (buffer) => {
    let s2 = '';
    const a = new Uint8Array(buffer);
    for (let i = 0; i < a.length; i++) s2 += String.fromCharCode(a[i]);
    return btoa(s2);
  };

  return {
    base64: b64(buf),
    probes: probes.map(([n, p]) => [n, b64(p)]),
    names: brushes.map((b) => b.name),
    groups: picked.map((g) => g.name),
    parsed: { brushes: back.brushes.length, tips: back.tips.size, patterns: back.patterns.size },
    bristle: back.brushes.filter((b) => NL.brush.bristle.isBristleTip(b.settings.tip?.shape ?? ''))
      .length,
  };
}, { wanted: groups, sampled, noTexture, probe });

await browser.close();
if (server) server.kill();

if (out.parsed.brushes !== out.names.length) {
  console.error(
    `refusing to write: wrote ${out.names.length} brushes but the parser found ${out.parsed.brushes}`,
  );
  process.exit(1);
}

const suffix = (sampled ? '-sampled' : '') + (noTexture ? '-plain' : '');
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

if (out.probes.length) {
  const { mkdirSync } = await import('node:fs');
  const dir = new URL('../brushes/probes/', import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  for (const [n, data] of out.probes) {
    const buf = Buffer.from(data, 'base64');
    writeFileSync(`${dir}${n}.abr`, buf);
    console.log(`wrote ${dir}${n}.abr (${buf.length} bytes)`);
  }
}
