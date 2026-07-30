/**
 * Renders brush sample sheets with the real engine.
 *
 * Serves the built app, opens it in headless Chromium, drives PaintEngine +
 * StrokeSession over synthesized pen paths (position, pressure, tilt and
 * barrel rotation), and writes the composited documents out as PNGs. This is
 * how the alla prima brushes were judged and iterated: `sheets/marks-*.png`
 * for the mark vocabulary of each preset, `sheets/study-*.png` for whether
 * those marks add up to a painting, `sheets/tips.png` for the bristle tip
 * generator itself, and `sheets/response.png` for the pen response.
 *
 * Usage:
 *   npm run build && node tools/sheets.mjs [sheet-name-substring ...]
 *
 * Env: APP_URL (skip the built-in server), CHROMIUM_PATH, CHROMIUM_FLAGS,
 * OUT_DIR (default `sheets/`).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { SHEET_SCRIPT } from './sheetScript.mjs';

const only = process.argv.slice(2);
const OUT_DIR = process.env.OUT_DIR ?? new URL('../sheets/', import.meta.url).pathname;
const PORT = process.env.PORT ?? '4183';

let server = null;
let appUrl = process.env.APP_URL;

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
      const res = await fetch(appUrl);
      if (res.ok) break;
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
// Open a tiny document: the app's own engine is only here to publish the debug
// surface, and on a software WebGPU stack a full-size presenting canvas is
// what tips the GPU process over.
await page.goto(`${appUrl}?w=64&h=64`);
await page.waitForTimeout(800);

await page.evaluate(`window.__buildSheets = ${SHEET_SCRIPT}`);
const sheets = await page.evaluate((names) => window.__buildSheets(names), only);

mkdirSync(OUT_DIR, { recursive: true });
for (const sheet of sheets) {
  if (sheet.error) {
    console.error(`FAIL ${sheet.name}: ${sheet.error}`);
    continue;
  }
  const path = `${OUT_DIR}/${sheet.name}.png`;
  writeFileSync(path, Buffer.from(sheet.png, 'base64'));
  console.log(`wrote ${path} (${sheet.width}x${sheet.height})`);
  if (sheet.rows) {
    // band centres for tools/markStats.py
    writeFileSync(`${OUT_DIR}/${sheet.name}.json`, JSON.stringify(sheet.rows, null, 2));
  }
}

await browser.close();
if (server) server.kill();
if (sheets.some((s) => s.error)) process.exit(1);
