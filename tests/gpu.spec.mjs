/**
 * End-to-end GPU tests. They drive the real PaintEngine (exposed on
 * window.__northlight) against offscreen textures and assert actual pixels,
 * covering compositing, brush falloff, flow/opacity semantics, eraser,
 * selections, blend modes, undo, pressure dynamics, the viewport pass, and
 * color conversions.
 *
 * Usage:
 *   npm run build && npx vite preview --port 4173 &
 *   npm i --no-save playwright   # once; needs a Chromium with WebGPU
 *   node tests/gpu.spec.mjs
 *
 * Env overrides: APP_URL, CHROMIUM_PATH, CHROMIUM_FLAGS.
 * In headless CI without a GPU, SwiftShader works:
 *   CHROMIUM_FLAGS="--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader"
 */
import { chromium } from 'playwright';

const TEST = `
(async () => {
  const NL = window.__northlight;
  const results = [];
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const assert = (name, cond, detail = '') =>
    results.push((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + detail));

  // --- engine on a canvas we never present to ---
  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 300;
  const eng = await NL.PaintEngine.create(canvas, 400, 300);
  let lost = null;
  eng.device.lost.then((i) => { lost = i.reason + ': ' + i.message; });

  const meta = (id, over = {}) =>
    ({ id, name: id, visible: true, opacity: 1, blendMode: 'normal', ...over });
  const view = { zoom: 1, panX: 0, panY: 0 };
  let state = { layers: [meta('bg')], activeLayerId: 'bg', view };

  eng.ensureLayer('bg');
  eng.fillLayer('bg', [1, 1, 1, 1]);

  const px = (data, x, y) => {
    const i = (y * 400 + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const read = () => eng.readComposite(state);

  // ---- 1. background composite ----
  {
    const d = await read();
    assert('white background composites to opaque white',
      px(d, 200, 150).join() === '255,255,255,255', px(d, 200, 150).join());
  }

  // ---- 2. soft round Gaussian profile ----
  {
    eng.beginStroke({ mode: 'paint', color: [0, 0, 0], opacity: 1, hardness: 0 });
    eng.drawStamps(new Float32Array([200, 150, 80, 1]), 1);
    const d = await read();
    const center = px(d, 200, 150)[0];
    const mid = px(d, 240, 150)[0];    // r = 0.5
    const edge = px(d, 278, 150)[0];   // r = 0.975
    const out = px(d, 290, 150)[0];    // r > 1
    assert('soft round: center fully painted', center <= 2, 'center=' + center);
    // rescaled Gaussian at t=0.5: (e^{-k/4}-e^{-k})/(1-e^{-k}) = 0.3627 -> 162.5
    assert('soft round: half-radius matches Gaussian falloff (163±10)',
      near(mid, 163, 10), 'mid=' + mid);
    assert('soft round: near-edge almost transparent', edge >= 235, 'edge=' + edge);
    assert('soft round: outside radius untouched', out === 255, 'out=' + out);
    eng.cancelStroke();
  }

  // ---- 3. hard round: solid core + ~1px AA rim ----
  {
    eng.beginStroke({ mode: 'paint', color: [0, 0, 0], opacity: 1, hardness: 1 });
    eng.drawStamps(new Float32Array([200, 150, 50, 1]), 1);
    const d = await read();
    const inner = px(d, 225, 150)[0];  // r = 0.5
    const nearEdge = px(d, 247, 150)[0]; // r = 0.94
    const outside = px(d, 253, 150)[0];  // r = 1.06
    assert('hard round: solid to half radius', inner <= 2, 'inner=' + inner);
    assert('hard round: still dark near edge', nearEdge <= 60, 'nearEdge=' + nearEdge);
    assert('hard round: crisp outside', outside >= 250, 'outside=' + outside);
    eng.cancelStroke();
  }

  // ---- 4. flow builds up per stamp ----
  {
    eng.beginStroke({ mode: 'paint', color: [0, 0, 0], opacity: 1, hardness: 1 });
    eng.drawStamps(new Float32Array([100, 100, 30, 0.5, 100, 100, 30, 0.5]), 2);
    const d = await read();
    // coverage 0.5 + 0.5*0.5 = 0.75 -> 255*(1-0.75) = 64
    const v = px(d, 100, 100)[0];
    assert('flow 50%: two overlapping stamps build to 75% (64±8)', near(v, 64, 8), 'v=' + v);
    eng.cancelStroke();
  }

  // ---- 5. opacity caps the whole stroke; commit bakes it ----
  {
    eng.beginStroke({ mode: 'paint', color: [0, 0, 0], opacity: 0.5, hardness: 1 });
    const many = [];
    for (let i = 0; i < 8; i++) many.push(150, 200, 30, 1); // heavy self-overlap
    eng.drawStamps(new Float32Array(many), 8);
    let d = await read();
    let v = px(d, 150, 200)[0];
    assert('opacity 50%: self-overlap never exceeds the cap (128±6)', near(v, 128, 6), 'v=' + v);
    eng.endStroke('bg');
    d = await read();
    v = px(d, 150, 200)[0];
    assert('commit: baked pixels match the live preview (128±6)', near(v, 128, 6), 'v=' + v);
  }

  // ---- 6. undo / redo ----
  {
    await eng.undo();
    let d = await read();
    let v = px(d, 150, 200)[0];
    assert('undo restores pre-stroke pixels', v === 255, 'v=' + v);
    await eng.redo();
    d = await read();
    v = px(d, 150, 200)[0];
    assert('redo re-applies the stroke (128±6)', near(v, 128, 6), 'v=' + v);
    await eng.undo(); // leave canvas clean
  }

  // ---- 7. eraser ----
  {
    eng.beginStroke({ mode: 'erase', color: [0, 0, 0], opacity: 1, hardness: 1 });
    eng.drawStamps(new Float32Array([300, 100, 40, 1]), 1);
    eng.endStroke('bg');
    const d = await read();
    const a = px(d, 300, 100)[3];
    const aOut = px(d, 300, 160)[3];
    assert('eraser removes layer alpha', a === 0, 'a=' + a);
    assert('eraser leaves the rest opaque', aOut === 255, 'aOut=' + aOut);
    eng.fillLayer('bg', [1, 1, 1, 1]); // reset
  }

  // ---- 8. selection clips painting ----
  {
    const mask = NL.rasterizeSelection(
      [[{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }]], 400, 300);
    eng.setSelectionMask(mask);
    eng.beginStroke({ mode: 'paint', color: [0, 0, 0], opacity: 1, hardness: 1 });
    eng.drawStamps(new Float32Array([200, 150, 60, 1]), 1);
    const d = await read();
    const inside = px(d, 180, 150)[0];
    const outside = px(d, 220, 150)[0];
    assert('selection: paint lands inside', inside <= 2, 'inside=' + inside);
    assert('selection: clipped outside', outside === 255, 'outside=' + outside);
    eng.cancelStroke();
    eng.setSelectionMask(null);
  }

  // ---- 9. blend modes (gray 0.5 backdrop, red source) ----
  {
    eng.fillLayer('bg', [0.5, 0.5, 0.5, 1]);
    eng.ensureLayer('l2');
    eng.fillLayer('l2', [1, 0, 0, 1]);
    const modes = async (blendMode, opacity = 1) => {
      const st = {
        layers: [meta('bg'), meta('l2', { blendMode, opacity })],
        activeLayerId: 'l2', view,
      };
      const d = await eng.readComposite(st);
      return px(d, 200, 150);
    };
    const gray = Math.round(0.5 * 255); // fillLayer's 0.5 quantizes to 128
    let p = await modes('multiply');
    assert('multiply: red x gray = half red', near(p[0], gray, 2) && p[1] === 0 && p[2] === 0,
      p.join());
    p = await modes('screen');
    assert('screen: red + gray', p[0] === 255 && near(p[1], gray, 2) && near(p[2], gray, 2),
      p.join());
    p = await modes('difference');
    assert('difference: |gray - red|', near(p[0], 127, 2) && near(p[1], gray, 2) && near(p[2], gray, 2),
      p.join());
    p = await modes('luminosity');
    // setLum(gray, lum(red)=0.3): 0.5 + (0.3-0.5) = 0.3 -> 76
    assert('luminosity: gray at red\\'s luma (76±3)',
      near(p[0], 76, 3) && near(p[1], 76, 3) && near(p[2], 76, 3), p.join());
    p = await modes('linear-dodge');
    assert('linear dodge: clamps at white on red channel',
      p[0] === 255 && near(p[1], gray, 2), p.join());
    p = await modes('normal', 0.5);
    // 0.5 red over gray: r = 0.5*1 + 0.5*0.5 = 0.75
    assert('layer opacity 50%: normal mix (191±3)',
      near(p[0], 191, 3) && near(p[1], 64, 3), p.join());
    eng.deleteLayer('l2');
    eng.fillLayer('bg', [1, 1, 1, 1]);
  }

  // ---- 10. StrokeSession spacing produces a continuous line ----
  {
    const settings = {
      preset: 'hard-round', size: 20, hardness: 1, opacity: 1, flow: 1,
      spacing: 0.25, smoothing: 0, pressureSize: false, pressureOpacity: false,
      pressureFlow: false,
    };
    eng.beginStroke({ mode: 'paint', color: [0, 0, 0], opacity: 1, hardness: 1 });
    const session = new NL.StrokeSession(eng, settings);
    session.down({ x: 100, y: 150, pressure: 1 });
    session.move([{ x: 300, y: 150, pressure: 1 }]);
    session.up();
    eng.endStroke('bg');
    const d = await read();
    let gaps = 0;
    for (let x = 105; x <= 295; x += 5) if (px(d, x, 150)[0] > 40) gaps++;
    assert('stroke session: continuous line, no gaps', gaps === 0, gaps + ' gaps');
    await eng.undo();
  }

  // ---- 11. pressure-size dynamics change stamp radius ----
  {
    const settings = {
      preset: 'hard-round', size: 40, hardness: 1, opacity: 1, flow: 1,
      spacing: 0.25, smoothing: 0, pressureSize: true, pressureOpacity: false,
      pressureFlow: false,
    };
    eng.beginStroke({ mode: 'paint', color: [0, 0, 0], opacity: 1, hardness: 1 });
    const session = new NL.StrokeSession(eng, settings);
    session.down({ x: 100, y: 100, pressure: 0.25 });
    session.up();
    eng.endStroke('bg');
    const d = await read();
    // pressure 0.25 -> diameter 10 -> radius 5
    const at3 = px(d, 103, 100)[0];
    const at8 = px(d, 108, 100)[0];
    assert('pressure size: small dab painted at low pressure', at3 <= 30, 'at3=' + at3);
    assert('pressure size: radius scaled down by pressure', at8 === 255, 'at8=' + at8);
    await eng.undo();
  }

  // ---- 12. viewport present pass (offscreen) ----
  {
    const st = { layers: [meta('bg')], activeLayerId: 'bg', view: { zoom: 0.5, panX: 100, panY: 75 } };
    const d = await eng.renderOffscreen(st, 400, 300);
    const fmt = eng.canvasFormat; // bgra8unorm or rgba8unorm
    const pxo = (x, y) => {
      const i = (y * 400 + x) * 4;
      const [b0, b1, b2] = [d[i], d[i + 1], d[i + 2]];
      return fmt.startsWith('bgra') ? [b2, b1, b0] : [b0, b1, b2];
    };
    const paste = pxo(20, 20);
    const doc = pxo(200, 150);
    const paste2 = pxo(390, 290);
    assert('present: pasteboard outside document (30,30,32)',
      near(paste[0], 30, 3) && near(paste[2], 32, 3), paste.join());
    assert('present: document content inside viewport', doc.join() === '255,255,255', doc.join());
    assert('present: pasteboard beyond bottom-right corner',
      near(paste2[0], 30, 3), paste2.join());
  }

  // ---- 13. color conversions ----
  {
    const C = NL.color;
    const lab = C.rgbToLab({ r: 1, g: 1, b: 1 });
    assert('Lab: white is L=100, a=b=0',
      near(lab.l, 100, 0.01) && near(lab.a, 0, 0.01) && near(lab.b, 0, 0.01),
      JSON.stringify(lab));
    const red = C.rgbToLab({ r: 1, g: 0, b: 0 });
    // sRGB red in Lab(D50): L~54.29, a~80.8, b~69.9
    assert('Lab: sRGB red matches reference (54.3, 80.8, 69.9)',
      near(red.l, 54.29, 0.3) && near(red.a, 80.8, 0.6) && near(red.b, 69.9, 0.6),
      JSON.stringify(red));
    const rt = C.labToRgb(red);
    assert('Lab: red round-trips',
      near(rt.r, 1, 0.002) && near(rt.g, 0, 0.002) && near(rt.b, 0, 0.002),
      JSON.stringify(rt));
    const hsv = C.rgbToHsv({ r: 0.5, g: 0.25, b: 0.75 });
    const back = C.hsvToRgb(hsv);
    assert('HSV: round-trips',
      near(back.r, 0.5, 1e-6) && near(back.g, 0.25, 1e-6) && near(back.b, 0.75, 1e-6),
      JSON.stringify(back));
    assert('hex: parse + format', C.rgbToHex(C.hexToRgb('#3d8bff')) === '3d8bff',
      C.rgbToHex(C.hexToRgb('#3d8bff')));
  }

  results.push(lost ? 'DEVICE-LOST ' + lost : 'device: alive');
  return results;
})()
`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--no-sandbox',
    ...(process.env.CHROMIUM_FLAGS ?? '--enable-unsafe-webgpu').split(' ').filter(Boolean),
  ],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).split('\n')[0]));
await page.goto((process.env.APP_URL ?? 'http://localhost:4173/') + '?w=64&h=64');
await page.waitForTimeout(800);
const res = await page.evaluate(TEST);
console.log(res.join('\n'));
const fails = res.filter((r) => r.startsWith('FAIL') || r.startsWith('DEVICE-LOST'));
console.log(fails.length === 0 ? '\nALL TESTS PASSED' : `\n${fails.length} FAILURES`);
await browser.close();
process.exit(fails.length === 0 ? 0 : 1);
