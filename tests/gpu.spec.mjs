/**
 * End-to-end GPU tests. They drive the real PaintEngine (exposed on
 * window.__northlight) against offscreen textures and assert actual pixels,
 * covering compositing, the full brush engine (tip shape, dynamics, scatter,
 * texture, dual brush, color dynamics, transfer, wet edges, noise, airbrush),
 * eraser, selections, blend modes, undo, the viewport pass, color
 * conversions, and the Photoshop keyboard shortcuts.
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
  const { makeBrush } = NL.brush.defaults;
  const D = NL.brush.dynamics;
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

  // Engine-level stroke params with defaults.
  const sp = (over = {}) => Object.assign({
    mode: 'paint', opacity: 1, blendMode: 'normal', hardness: 1,
    tipShape: 'round', wetEdges: false, noise: false, texture: null, dual: null,
  }, over);

  // One stamp instance record (STAMP_FLOATS = 11).
  const rec = (x, y, radius, alpha, over = {}) => {
    const o = Object.assign(
      { angle: 0, roundness: 1, color: [0, 0, 0], flags: 0, depth: 1 }, over);
    return [x, y, radius, alpha, o.angle, o.roundness, ...o.color, o.flags, o.depth];
  };
  const stamps = (...rs) => new Float32Array(rs.flat());

  const spread = (data, cx, cy, half, step = 2) => {
    let lo = 255, hi = 0;
    for (let y = cy - half; y <= cy + half; y += step) {
      for (let x = cx - half; x <= cx + half; x += step) {
        const v = px(data, x, y)[0];
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
    }
    return hi - lo;
  };

  // ---- 1. background composite ----
  {
    const d = await read();
    assert('white background composites to opaque white',
      px(d, 200, 150).join() === '255,255,255,255', px(d, 200, 150).join());
  }

  // ---- 2. soft round Gaussian profile ----
  {
    eng.beginStroke(sp({ hardness: 0 }));
    eng.drawStamps(stamps(rec(200, 150, 80, 1)), 1);
    const d = await read();
    const center = px(d, 200, 150)[0];
    const mid = px(d, 240, 150)[0];    // r = 0.5
    const edge = px(d, 278, 150)[0];   // r = 0.975
    const out = px(d, 290, 150)[0];    // r > 1
    assert('soft round: center fully painted', center <= 2, 'center=' + center);
    assert('soft round: half-radius matches Gaussian falloff (163±10)',
      near(mid, 163, 10), 'mid=' + mid);
    assert('soft round: near-edge almost transparent', edge >= 235, 'edge=' + edge);
    assert('soft round: outside radius untouched', out === 255, 'out=' + out);
    eng.cancelStroke();
  }

  // ---- 3. hard round: solid core + ~1px AA rim ----
  {
    eng.beginStroke(sp({ hardness: 1 }));
    eng.drawStamps(stamps(rec(200, 150, 50, 1)), 1);
    const d = await read();
    const inner = px(d, 225, 150)[0];
    const nearEdge = px(d, 247, 150)[0];
    const outside = px(d, 253, 150)[0];
    assert('hard round: solid to half radius', inner <= 2, 'inner=' + inner);
    assert('hard round: still dark near edge', nearEdge <= 60, 'nearEdge=' + nearEdge);
    assert('hard round: crisp outside', outside >= 250, 'outside=' + outside);
    eng.cancelStroke();
  }

  // ---- 4. angle + roundness make rotated ellipses ----
  {
    eng.beginStroke(sp({ hardness: 1 }));
    eng.drawStamps(stamps(rec(200, 150, 60, 1, { roundness: 0.3 })), 1);
    let d = await read();
    assert('ellipse: short axis painted', px(d, 200, 160)[0] <= 5,
      'v=' + px(d, 200, 160)[0]);
    assert('ellipse: beyond short axis clear', px(d, 200, 180)[0] >= 245,
      'v=' + px(d, 200, 180)[0]);
    assert('ellipse: long axis painted', px(d, 250, 150)[0] <= 5,
      'v=' + px(d, 250, 150)[0]);
    eng.cancelStroke();

    eng.beginStroke(sp({ hardness: 1 }));
    eng.drawStamps(stamps(rec(200, 150, 60, 1, { roundness: 0.3, angle: Math.PI / 2 })), 1);
    d = await read();
    assert('rotated ellipse: long axis is now vertical', px(d, 200, 200)[0] <= 5,
      'v=' + px(d, 200, 200)[0]);
    assert('rotated ellipse: horizontal is now short', px(d, 250, 150)[0] >= 245,
      'v=' + px(d, 250, 150)[0]);
    eng.cancelStroke();
  }

  // ---- 5. flow builds up; opacity caps; commit bakes ----
  {
    eng.beginStroke(sp());
    eng.drawStamps(stamps(rec(100, 100, 30, 0.5), rec(100, 100, 30, 0.5)), 2);
    let d = await read();
    assert('flow 50%: two overlapping stamps build to 75% (64±8)',
      near(px(d, 100, 100)[0], 64, 8), 'v=' + px(d, 100, 100)[0]);
    eng.cancelStroke();

    eng.beginStroke(sp({ opacity: 0.5 }));
    const many = [];
    for (let i = 0; i < 8; i++) many.push(rec(150, 200, 30, 1));
    eng.drawStamps(stamps(...many), 8);
    d = await read();
    assert('opacity 50%: self-overlap never exceeds the cap (128±6)',
      near(px(d, 150, 200)[0], 128, 6), 'v=' + px(d, 150, 200)[0]);
    eng.endStroke('bg');
    d = await read();
    assert('commit: baked pixels match the live preview (128±6)',
      near(px(d, 150, 200)[0], 128, 6), 'v=' + px(d, 150, 200)[0]);
  }

  // ---- 6. undo / redo ----
  {
    await eng.undo();
    let d = await read();
    assert('undo restores pre-stroke pixels', px(d, 150, 200)[0] === 255,
      'v=' + px(d, 150, 200)[0]);
    await eng.redo();
    d = await read();
    assert('redo re-applies the stroke (128±6)', near(px(d, 150, 200)[0], 128, 6),
      'v=' + px(d, 150, 200)[0]);
    await eng.undo();
  }

  // ---- 7. paint blend mode: multiply red over gray ----
  {
    eng.fillLayer('bg', [0.5, 0.5, 0.5, 1]);
    eng.beginStroke(sp({ blendMode: 'multiply' }));
    eng.drawStamps(stamps(rec(200, 150, 40, 1, { color: [1, 0, 0] })), 1);
    let d = await read();
    let p = px(d, 200, 150);
    assert('brush Mode multiply: live preview red x gray',
      near(p[0], 128, 3) && p[1] <= 2 && p[2] <= 2, p.join());
    eng.endStroke('bg');
    d = await read();
    p = px(d, 200, 150);
    assert('brush Mode multiply: committed', near(p[0], 128, 3) && p[1] <= 2, p.join());
    await eng.undo();
    eng.fillLayer('bg', [1, 1, 1, 1]);
  }

  // ---- 8. wet edges: interior settles at ~60%, rim darker relative ----
  {
    eng.beginStroke(sp({ hardness: 0, wetEdges: true }));
    eng.drawStamps(stamps(rec(200, 150, 60, 1)), 1);
    const d = await read();
    const center = px(d, 200, 150)[0]; // coverage 1 -> wet 0.6 -> 102
    const rim = px(d, 225, 150)[0];    // coverage ~0.5 -> wet ~0.7 -> ~76
    assert('wet edges: interior at ~60% (102±8)', near(center, 102, 8), 'center=' + center);
    assert('wet edges: rim darker than interior', rim < center - 12,
      'rim=' + rim + ' center=' + center);
    eng.cancelStroke();
  }

  // ---- 9. per-stamp color (Color Dynamics plumbing) ----
  {
    eng.beginStroke(sp());
    eng.drawStamps(stamps(
      rec(120, 100, 25, 1, { color: [1, 0, 0] }),
      rec(280, 100, 25, 1, { color: [0, 0.8, 0] }),
    ), 2);
    const d = await read();
    const a = px(d, 120, 100);
    const b = px(d, 280, 100);
    assert('per-stamp color: first stamp red', a[0] >= 250 && a[1] <= 5, a.join());
    assert('per-stamp color: second stamp green', b[1] >= 190 && b[0] <= 5, b.join());
    eng.cancelStroke();
  }

  // ---- 10. whole-stroke texture carves the coverage ----
  {
    const flat = () => {
      eng.beginStroke(sp());
      eng.drawStamps(stamps(rec(200, 150, 80, 1)), 1);
    };
    flat();
    let d = await read();
    const plainSpread = spread(d, 200, 150, 30);
    eng.cancelStroke();

    eng.beginStroke(sp({
      texture: { pattern: 'speckle', scalePx: 256, brightness: 0, contrast: 0,
        invert: false, depth: 1, mode: 'multiply', eachTip: false },
    }));
    eng.drawStamps(stamps(rec(200, 150, 80, 1)), 1);
    d = await read();
    const texSpread = spread(d, 200, 150, 30);
    eng.cancelStroke();
    assert('texture: flat stroke is uniform', plainSpread <= 4, 'spread=' + plainSpread);
    assert('texture: speckle pattern carves holes', texSpread >= 60, 'spread=' + texSpread);
  }

  // ---- 11. texture-each-tip path (per-stamp, in the stamp shader) ----
  {
    eng.beginStroke(sp({
      texture: { pattern: 'sponge', scalePx: 256, brightness: 0, contrast: 0,
        invert: false, depth: 1, mode: 'subtract', eachTip: true },
    }));
    eng.drawStamps(stamps(rec(200, 150, 80, 1)), 1);
    const d = await read();
    const s2 = spread(d, 200, 150, 30);
    eng.cancelStroke();
    assert('texture each tip: sponge carves per stamp', s2 >= 60, 'spread=' + s2);
  }

  // ---- 12. dual brush: a true secondary stamp train gates the primary ----
  {
    const dual = { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
      size: 30, spacing: 0.5, scatter: 0, bothAxes: true, count: 1 };
    eng.beginStroke(sp({ dual }));
    // big primary footprint...
    eng.drawStamps(stamps(rec(200, 150, 80, 1)), 1);
    // ...but the dual tip only stamped at two spots (and one outside).
    // Dual stamps are coverage, written as white (R channel of the mask).
    const cov = { color: [1, 1, 1] };
    eng.drawStamps(stamps(
      rec(170, 150, 15, 1, cov), rec(240, 150, 15, 1, cov), rec(340, 150, 15, 1, cov),
    ), 3, 'dual');
    const d = await read();
    const atDual1 = px(d, 170, 150)[0];
    const atDual2 = px(d, 240, 150)[0];
    const between = px(d, 205, 110)[0]; // inside primary, no dual coverage
    const outside = px(d, 340, 150)[0]; // dual coverage but no primary
    assert('dual brush: paint lands where both tips overlap',
      atDual1 <= 2 && atDual2 <= 2, atDual1 + ',' + atDual2);
    assert('dual brush: primary alone is masked out', between === 255,
      'between=' + between);
    assert('dual brush: dual alone paints nothing', outside === 255,
      'outside=' + outside);
    eng.cancelStroke();
  }

  // ---- 13. dual brush walks its own spacing train along a stroke ----
  {
    const settings = makeBrush({
      tip: { size: 40, hardness: 1, spacing: 0.1 },
      dual: { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
        size: 16, spacing: 2.5, scatter: 0, bothAxes: false, count: 1 },
      smoothing: 0,
    });
    eng.beginStroke(NL.brush.engineStrokeParams(settings, 'paint'));
    const session = new NL.StrokeSession(eng, settings,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    const samp = (x, y) => ({ x, y, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 });
    session.down(samp(80, 150));
    session.move([samp(320, 150)]);
    session.up();
    let dark = 0, light = 0;
    const d = await read();
    for (let x = 85; x <= 315; x += 2) {
      const v = px(d, x, 150)[0];
      if (v < 60) dark++;
      else if (v > 200) light++;
    }
    eng.cancelStroke();
    assert('dual spacing: dabs with gaps along the stroke (not a solid line)',
      dark >= 10 && light >= 10, 'dark=' + dark + ' light=' + light);
  }

  // ---- 13. noise roughens the soft falloff band ----
  {
    eng.beginStroke(sp({ hardness: 0, noise: true }));
    eng.drawStamps(stamps(rec(200, 150, 60, 1)), 1);
    const d = await read();
    let lo = 255, hi = 0;
    for (let x = 225; x <= 245; x++) {
      const v = px(d, x, 150)[0];
      lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    eng.cancelStroke();
    assert('noise: falloff band becomes grainy', hi - lo >= 30, 'spread=' + (hi - lo));
  }

  // ---- 14. eraser ----
  {
    eng.beginStroke(sp({ mode: 'erase' }));
    eng.drawStamps(stamps(rec(300, 100, 40, 1)), 1);
    eng.endStroke('bg');
    const d = await read();
    assert('eraser removes layer alpha', px(d, 300, 100)[3] === 0,
      'a=' + px(d, 300, 100)[3]);
    assert('eraser leaves the rest opaque', px(d, 300, 160)[3] === 255,
      'aOut=' + px(d, 300, 160)[3]);
    eng.fillLayer('bg', [1, 1, 1, 1]);
  }

  // ---- 15. selection clips painting ----
  {
    const mask = NL.rasterizeSelection(
      [[{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }]], 400, 300);
    eng.setSelectionMask(mask);
    eng.beginStroke(sp());
    eng.drawStamps(stamps(rec(200, 150, 60, 1)), 1);
    const d = await read();
    assert('selection: paint lands inside', px(d, 180, 150)[0] <= 2,
      'inside=' + px(d, 180, 150)[0]);
    assert('selection: clipped outside', px(d, 220, 150)[0] === 255,
      'outside=' + px(d, 220, 150)[0]);
    eng.cancelStroke();
    eng.setSelectionMask(null);
  }

  // ---- 16. layer blend modes (gray 0.5 backdrop, red source) ----
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
    const gray = 128;
    let p = await modes('multiply');
    assert('multiply: red x gray = half red', near(p[0], gray, 2) && p[1] === 0, p.join());
    p = await modes('screen');
    assert('screen: red + gray', p[0] === 255 && near(p[1], gray, 2), p.join());
    p = await modes('difference');
    assert('difference: |gray - red|', near(p[0], 127, 2) && near(p[1], gray, 2), p.join());
    p = await modes('luminosity');
    assert('luminosity: gray at red luma (76±3)', near(p[0], 76, 3) && near(p[1], 76, 3),
      p.join());
    p = await modes('normal', 0.5);
    assert('layer opacity 50%: normal mix (191±3)', near(p[0], 191, 3) && near(p[1], 64, 3),
      p.join());
    eng.deleteLayer('l2');
    eng.fillLayer('bg', [1, 1, 1, 1]);
  }

  // ---- 17. StrokeSession: continuous line, no gaps ----
  {
    const settings = makeBrush({ tip: { size: 20, hardness: 1, spacing: 0.25 }, smoothing: 0 });
    eng.beginStroke(NL.brush.engineStrokeParams(settings, 'paint'));
    const session = new NL.StrokeSession(eng, settings,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    const samp = (x, y, p) => ({ x, y, pressure: p, tiltX: 0, tiltY: 0, twist: 0 });
    session.down(samp(100, 150, 1));
    session.move([samp(300, 150, 1)]);
    session.up();
    eng.endStroke('bg');
    const d = await read();
    let gaps = 0;
    for (let x = 105; x <= 295; x += 5) if (px(d, x, 150)[0] > 40) gaps++;
    assert('stroke session: continuous line, no gaps', gaps === 0, gaps + ' gaps');
    await eng.undo();
  }

  // ---- 18. Shape Dynamics: pressure-driven size with a minimum ----
  {
    const settings = makeBrush({
      tip: { size: 40, hardness: 1 },
      shape: { enabled: true, sizeControl: { source: 'pressure', fadeSteps: 25 },
        minDiameter: 0 },
      smoothing: 0,
    });
    eng.beginStroke(NL.brush.engineStrokeParams(settings, 'paint'));
    const session = new NL.StrokeSession(eng, settings,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    session.down({ x: 100, y: 100, pressure: 0.25, tiltX: 0, tiltY: 0, twist: 0 });
    session.up();
    eng.endStroke('bg');
    const d = await read();
    assert('pressure size: small dab painted at low pressure', px(d, 103, 100)[0] <= 30,
      'at3=' + px(d, 103, 100)[0]);
    assert('pressure size: radius scaled down by pressure', px(d, 108, 100)[0] === 255,
      'at8=' + px(d, 108, 100)[0]);
    await eng.undo();
  }

  // ---- 19. airbrush build-up deposits while held still ----
  {
    const settings = makeBrush({
      tip: { size: 40, hardness: 1 }, flow: 0.2, airbrush: true, smoothing: 0,
    });
    eng.beginStroke(NL.brush.engineStrokeParams(settings, 'paint'));
    const session = new NL.StrokeSession(eng, settings,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    session.down({ x: 200, y: 220, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 });
    await new Promise((r) => setTimeout(r, 350));
    session.up();
    eng.endStroke('bg');
    const d = await read();
    const v = px(d, 200, 220)[0];
    // one stamp at flow 0.2 would leave 204; build-up should go much darker
    assert('airbrush: holding builds up coverage', v < 120, 'v=' + v);
    await eng.undo();
  }

  // ---- 20. dynamics unit tests (pure) ----
  {
    const ctx = (pressure, stepIndex = 0) => ({
      sample: { x: 0, y: 0, pressure, tiltX: 0, tiltY: 0, twist: 0 },
      direction: 0, initialDirection: 0, stepIndex,
    });
    const fade = D.controlFactor({ source: 'fade', fadeSteps: 10 }, ctx(1, 5));
    assert('dynamics: fade control halves at half the steps', near(fade, 0.5, 1e-9),
      'fade=' + fade);

    const pencil = makeBrush({
      tip: { size: 100 },
      shape: { enabled: true, sizeControl: { source: 'pressure', fadeSteps: 25 },
        minDiameter: 0.5 },
    });
    const dLow = D.stampDiameter(pencil, ctx(0.2), () => 0);
    const dHigh = D.stampDiameter(pencil, ctx(0.8), () => 0);
    assert('dynamics: minimum diameter floors pressure size (50%)',
      near(dLow, 50, 1e-6) && near(dHigh, 80, 1e-6), dLow + ',' + dHigh);

    const transfer = makeBrush({
      transfer: { enabled: true, opacityControl: { source: 'pressure', fadeSteps: 25 },
        opacityMin: 0.25 },
    });
    const aLow = D.stampAlpha(transfer, ctx(0.1), () => 0);
    assert('dynamics: transfer minimum floors opacity', near(aLow, 0.25, 1e-6),
      'a=' + aLow);

    const scattered = makeBrush({
      scatter: { enabled: true, bothAxes: true, scatter: 2,
        scatterControl: { source: 'off', fadeSteps: 25 }, count: 4, countJitter: 0 },
    });
    const out = [];
    D.emitStamps(scattered, ctx(1), 50, 50,
      { strokeColor: { r: 0, g: 0, b: 0 }, fg: { h: 0, s: 0, v: 0 },
        bg: { h: 0, s: 0, v: 1 }, rng: NL.brush.patterns.seededRng(7) }, out);
    assert('dynamics: scatter count emits N stamps', out.length === 4 * D.STAMP_FLOATS,
      out.length + ' floats');
    const off0 = Math.hypot(out[0] - 50, out[1] - 50);
    assert('dynamics: scatter offsets stamps', off0 > 1, 'offset=' + off0);

    const cd = { enabled: true, applyPerTip: true, fgBgJitter: 0,
      fgBgControl: { source: 'off', fadeSteps: 25 }, hueJitter: 0.5,
      satJitter: 0, briJitter: 0, purity: 0 };
    const rng = NL.brush.patterns.seededRng(3);
    const c1 = D.dynamicColor(cd, { h: 0, s: 1, v: 1 }, { h: 0, s: 0, v: 1 }, ctx(1), rng);
    const c2 = D.dynamicColor(cd, { h: 0, s: 1, v: 1 }, { h: 0, s: 0, v: 1 }, ctx(1), rng);
    const diff = Math.abs(c1.r - c2.r) + Math.abs(c1.g - c2.g) + Math.abs(c1.b - c2.b);
    assert('dynamics: hue jitter varies per-stamp color', diff > 0.05, 'diff=' + diff);
  }

  // ---- 21. patterns & presets ----
  {
    const pat = NL.brush.patterns.getPattern('sponge');
    assert('patterns: sponge generated and cached',
      pat.size === 256 && pat === NL.brush.patterns.getPattern('sponge'), '');
    const custom = new Uint8Array(16 * 16).fill(200);
    NL.brush.patterns.registerTip('test-tip', { size: 16, data: custom });
    assert('patterns: registered tips resolve through getTip',
      NL.brush.patterns.getTip('test-tip').data === custom &&
      NL.brush.patterns.isRegisteredTip('test-tip'), '');

    const pencil = NL.brush.presets.findPreset('pencil');
    assert('presets: graphite pencil matches spec',
      pencil.settings.scatter.enabled && pencil.settings.scatter.count === 2 &&
      pencil.settings.transfer.enabled &&
      pencil.settings.transfer.opacityControl.source === 'pressure' &&
      pencil.settings.shape.minDiameter === 0.5 && pencil.settings.noise, '');
    const sponge = NL.brush.presets.findPreset('sponge');
    assert('presets: sponge uses texture + dual brush',
      sponge.settings.texture.enabled && sponge.settings.texture.pattern === 'sponge' &&
      sponge.settings.dual.enabled, '');
    const groups = NL.brush.presets.BRUSH_GROUPS;
    const total = groups.reduce((n, g) => n + g.presets.length, 0);
    assert('presets: grouped library is well stocked',
      groups.length >= 5 && total >= 18, groups.length + ' groups, ' + total);

    NL.store.getState().applyPreset('pencil', 'brush');
    const b = NL.store.getState().brush;
    assert('store: applying a preset replaces brush settings',
      b.scatter.enabled && b.noise && NL.store.getState().activePreset.brush === 'pencil', '');
    NL.store.getState().applyPreset('soft-round', 'brush');
  }

  // ---- 21b. ABR import: legacy v2, modern v6.2 with descriptor, painting ----
  {
    // big-endian binary writer for synthesizing fixture files
    class W {
      constructor() { this.b = []; }
      u8(x) { this.b.push(x & 0xff); return this; }
      u16(x) { return this.u8(x >> 8).u8(x); }
      u32(x) { return this.u16(Math.floor(x / 65536)).u16(x); }
      f64(x) {
        const dv = new DataView(new ArrayBuffer(8));
        dv.setFloat64(0, x);
        for (let i = 0; i < 8; i++) this.u8(dv.getUint8(i));
        return this;
      }
      ascii(s) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
      unicode(s) { this.u32(s.length); for (const c of s) this.u16(c.charCodeAt(0)); return this; }
      dkey(s) { return s.length === 4 ? this.u32(0).ascii(s) : this.u32(s.length).ascii(s); }
      raw(arr) { this.b.push(...arr); return this; }
      buffer() { return new Uint8Array(this.b).buffer; }
      get length() { return this.b.length; }
    }

    // --- v2 fixture: one 16x16 RLE-compressed sampled brush named "Old" ---
    {
      const w = 16, h = 16;
      const rows = [];
      for (let y = 0; y < h; y++) {
        rows.push([w - 1, ...Array.from({ length: w }, (_, x) => (x < w / 2 ? 255 : 0))]);
      }
      const body = new W();
      body.u32(0).u16(40); // misc, spacing 40%
      body.unicode('Old');
      body.u8(1); // antialiasing
      body.u16(0).u16(0).u16(h).u16(w); // short bounds
      body.u32(0).u32(0).u32(h).u32(w); // long bounds
      body.u16(8).u8(1); // depth, RLE
      for (const row of rows) body.u16(row.length);
      for (const row of rows) body.raw(row);

      const file = new W();
      file.u16(2).u16(1); // version 2, count 1
      file.u16(2).u32(body.length).raw(body.b); // type 2 sampled
      const res = NL.brush.abr.parseAbr(file.buffer());
      const b = res.brushes[0];
      const tip = res.tips.get(b.tipId);
      assert('abr v2: sampled brush parsed with name and spacing',
        res.brushes.length === 1 && b.name === 'Old' &&
        Math.abs(b.settings.tip.spacing - 0.4) < 1e-6, JSON.stringify(b));
      assert('abr v2: RLE tip decoded (left half opaque)',
        tip.size === 16 && tip.data[8 * 16 + 3] === 255 && tip.data[8 * 16 + 12] === 0, '');
    }

    // --- v6.2 fixture: samp bitmap + full descriptor ---
    {
      const uuid = '01234567-89ab-cdef-0123-456789abcdef'; // 36 chars
      const w = 8, h = 8;
      const pixels = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) pixels.push(x < w / 2 ? 255 : 0);
      }
      const samp = new W();
      samp.u8(36).ascii(uuid);
      samp.raw(new Array(264).fill(0)); // subversion-2 header padding
      samp.u32(0).u32(0).u32(h).u32(w); // rect
      samp.u16(8).u8(0); // depth 8, raw
      samp.raw(pixels);
      while (samp.length % 4 !== 0) samp.u8(0);

      // descriptor: Brsh list with one brushPreset
      const desc = new W();
      desc.u32(16); // versioned descriptor
      desc.unicode('').dkey('null').u32(1);
      desc.dkey('Brsh').ascii('VlLs').u32(1).ascii('Objc');
      desc.unicode('').dkey('brsh').u32(9);
      desc.dkey('Nm  ').ascii('TEXT').unicode('Fancy');
      desc.dkey('Brsh').ascii('Objc');
      {
        desc.unicode('').dkey('brsh').u32(5);
        desc.dkey('Dmtr').ascii('UntF').ascii('#Pxl').f64(40);
        desc.dkey('Spcn').ascii('UntF').ascii('#Prc').f64(30);
        desc.dkey('Angl').ascii('UntF').ascii('#Ang').f64(15);
        desc.dkey('Rndn').ascii('UntF').ascii('#Prc').f64(80);
        desc.dkey('sampledData').ascii('TEXT').unicode(uuid);
      }
      desc.dkey('useTipDynamics').ascii('bool').u8(1);
      desc.dkey('szVr').ascii('Objc');
      {
        desc.unicode('').dkey('brVr').u32(3);
        desc.dkey('bVTy').ascii('long').u32(2); // pen pressure
        desc.dkey('fStp').ascii('long').u32(25);
        desc.dkey('jitter').ascii('UntF').ascii('#Prc').f64(30);
      }
      desc.dkey('minimumDiameter').ascii('UntF').ascii('#Prc').f64(40);
      desc.dkey('useScatter').ascii('bool').u8(1);
      desc.dkey('scatterDynamics').ascii('Objc');
      {
        desc.unicode('').dkey('brVr').u32(2);
        desc.dkey('bVTy').ascii('long').u32(0);
        desc.dkey('jitter').ascii('UntF').ascii('#Prc').f64(150);
      }
      desc.dkey('Cnt ').ascii('long').u32(3);
      desc.dkey('Wtdg').ascii('bool').u8(1);

      const file = new W();
      file.u16(6).u16(2); // version 6, subversion 2
      file.ascii('8BIM').ascii('samp').u32(4 + samp.length);
      file.u32(samp.length).raw(samp.b);
      file.ascii('8BIM').ascii('desc').u32(desc.length).raw(desc.b);

      const res = NL.brush.abr.parseAbr(file.buffer());
      const b = res.brushes[0];
      assert('abr v6: descriptor names and tip geometry mapped',
        res.brushes.length === 1 && b.name === 'Fancy' && b.tipId === uuid &&
        b.settings.tip.size === 40 && Math.abs(b.settings.tip.spacing - 0.3) < 1e-6 &&
        b.settings.tip.angle === 15 && Math.abs(b.settings.tip.roundness - 0.8) < 1e-6,
        JSON.stringify(b));
      assert('abr v6: shape dynamics mapped (pressure size, 30% jitter, 40% min)',
        b.settings.shape.enabled && b.settings.shape.sizeControl.source === 'pressure' &&
        Math.abs(b.settings.shape.sizeJitter - 0.3) < 1e-6 &&
        Math.abs(b.settings.shape.minDiameter - 0.4) < 1e-6,
        JSON.stringify(b.settings.shape));
      assert('abr v6: scatter (150% -> 1.5) + count and wet edges mapped',
        b.settings.scatter.enabled && Math.abs(b.settings.scatter.scatter - 1.5) < 1e-6 &&
        b.settings.scatter.count === 3 && b.settings.wetEdges === true,
        JSON.stringify(b.settings.scatter));
      assert('abr v6: sampled tip bitmap decoded',
        res.tips.get(uuid).size === 8 && res.tips.get(uuid).data[4 * 8 + 1] === 255, '');

      // --- full import wiring + painting with the imported tip ---
      const before = NL.brush.presets.allGroups().length;
      const n = NL.brush.importAbr('fixture.abr', file.buffer());
      const groups = NL.brush.presets.allGroups();
      const group = groups[groups.length - 1];
      assert('abr import: registers a new preset group',
        n === 1 && groups.length === before + 1 && group.name === 'fixture' &&
        group.presets[0].name === 'Fancy', group.name);
      assert('abr import: preset applied to the brush tool',
        NL.store.getState().brush.tip.shape.startsWith('abr:fixture:') &&
        NL.store.getState().brush.wetEdges === true, NL.store.getState().brush.tip.shape);

      const imported = group.presets[0].settings;
      const paintSettings = structuredClone(imported);
      paintSettings.wetEdges = false;
      paintSettings.shape.enabled = false;
      paintSettings.scatter.enabled = false;
      eng.beginStroke(NL.brush.engineStrokeParams(paintSettings, 'paint'));
      eng.drawStamps(stamps(rec(200, 150, 32, 1)), 1);
      const d = await read();
      const leftHalf = px(d, 185, 150)[0];  // tip's opaque half
      const rightHalf = px(d, 215, 150)[0]; // tip's transparent half
      eng.cancelStroke();
      assert('abr import: painting uses the sampled tip bitmap',
        leftHalf <= 40 && rightHalf >= 240, leftHalf + ',' + rightHalf);
      NL.store.getState().applyPreset('soft-round', 'brush');
    }
  }

  // ---- 22. viewport present pass (offscreen) ----
  {
    const st = { layers: [meta('bg')], activeLayerId: 'bg',
      view: { zoom: 0.5, panX: 100, panY: 75 } };
    const d = await eng.renderOffscreen(st, 400, 300);
    const fmt = eng.canvasFormat;
    const pxo = (x, y) => {
      const i = (y * 400 + x) * 4;
      const [b0, b1, b2] = [d[i], d[i + 1], d[i + 2]];
      return fmt.startsWith('bgra') ? [b2, b1, b0] : [b0, b1, b2];
    };
    assert('present: pasteboard outside document', near(pxo(20, 20)[0], 30, 3),
      pxo(20, 20).join());
    assert('present: document content inside viewport',
      pxo(200, 150).join() === '255,255,255', pxo(200, 150).join());
  }

  // ---- 23. color conversions ----
  {
    const C = NL.color;
    const lab = C.rgbToLab({ r: 1, g: 1, b: 1 });
    assert('Lab: white is L=100, a=b=0',
      near(lab.l, 100, 0.01) && near(lab.a, 0, 0.01) && near(lab.b, 0, 0.01),
      JSON.stringify(lab));
    const red = C.rgbToLab({ r: 1, g: 0, b: 0 });
    assert('Lab: sRGB red matches reference (54.3, 80.8, 69.9)',
      near(red.l, 54.29, 0.3) && near(red.a, 80.8, 0.6) && near(red.b, 69.9, 0.6),
      JSON.stringify(red));
    const rt = C.labToRgb(red);
    assert('Lab: red round-trips',
      near(rt.r, 1, 0.002) && near(rt.g, 0, 0.002) && near(rt.b, 0, 0.002),
      JSON.stringify(rt));
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

// ---- UI-level keyboard shortcut tests (store-backed, engine not needed) ----
const kb = [];
const kbAssert = (name, cond, detail = '') =>
  kb.push((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' — ' + detail));

await page.evaluate(() => {
  const s = window.__northlight.store.getState();
  s.setTool('brush');
  s.updateBrush({ opacity: 1, flow: 1, airbrush: false }, 'brush');
});
const getBrush = () => page.evaluate(() => {
  const b = window.__northlight.store.getState().brush;
  return { opacity: b.opacity, flow: b.flow };
});

await page.keyboard.press('5');
kbAssert('digits set opacity (5 -> 50%)', (await getBrush()).opacity === 0.5,
  JSON.stringify(await getBrush()));

await page.waitForTimeout(800); // expire the two-digit window
await page.keyboard.press('4');
await page.keyboard.press('5');
kbAssert('quick two digits combine (45%)', (await getBrush()).opacity === 0.45,
  JSON.stringify(await getBrush()));

await page.waitForTimeout(800);
await page.keyboard.press('Shift+7');
kbAssert('Shift+digit sets flow (70%)', (await getBrush()).flow === 0.7,
  JSON.stringify(await getBrush()));

await page.waitForTimeout(800);
await page.keyboard.press('0');
kbAssert('0 sets 100%', (await getBrush()).opacity === 1,
  JSON.stringify(await getBrush()));

await page.evaluate(() => {
  const s = window.__northlight.store.getState();
  s.updateBrush({ airbrush: true }, 'brush');
});
await page.waitForTimeout(800);
await page.keyboard.press('6');
kbAssert('with airbrush on, digits set flow instead', (await getBrush()).flow === 0.6,
  JSON.stringify(await getBrush()));

console.log(kb.join('\n'));

const all = [...res, ...kb];
const fails = all.filter((r) => r.startsWith('FAIL') || r.startsWith('DEVICE-LOST'));
console.log(fails.length === 0 ? '\nALL TESTS PASSED' : `\n${fails.length} FAILURES`);
await browser.close();
process.exit(fails.length === 0 ? 0 : 1);
