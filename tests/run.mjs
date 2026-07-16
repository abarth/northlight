/**
 * Test runner: serves the built app with `vite preview`, waits for it to come
 * up, runs the GPU test suite against it, then tears the server down and
 * exits with the suite's status.
 *
 * Usage:
 *   npm run build && npm test
 *
 * On a machine without a GPU (e.g. CI), run WebGPU on SwiftShader:
 *   CHROMIUM_FLAGS="--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader" npm test
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const PORT = process.env.PORT ?? '4173';
const APP_URL = `http://localhost:${PORT}/`;

if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

// Spawn vite's JS entry point directly (rather than via npx) so there is a
// single child process that server.kill() reliably terminates.
const viteBin = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname;
const server = spawn(process.execPath, [viteBin, 'preview', '--port', PORT, '--strictPort'], {
  stdio: ['ignore', 'ignore', 'inherit'],
});
let serverExited = false;
server.on('exit', () => { serverExited = true; });
const stop = () => { if (!serverExited) server.kill(); };
process.on('exit', stop);

// Wait for the preview server to accept requests.
const deadline = Date.now() + 30_000;
for (;;) {
  if (serverExited) {
    console.error('vite preview exited before serving.');
    process.exit(1);
  }
  try {
    const res = await fetch(APP_URL);
    if (res.ok) break;
  } catch { /* not up yet */ }
  if (Date.now() > deadline) {
    console.error(`timed out waiting for ${APP_URL}`);
    stop();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}

const test = spawn(process.execPath, [new URL('./gpu.spec.mjs', import.meta.url).pathname], {
  stdio: 'inherit',
  env: { ...process.env, APP_URL: APP_URL },
});
test.on('exit', (code) => {
  stop();
  process.exit(code ?? 1);
});
