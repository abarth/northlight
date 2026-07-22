/**
 * End-to-end GPU tests. They drive the real PaintEngine (exposed on
 * window.__northlight) against offscreen textures and assert actual pixels,
 * covering compositing, the full brush engine (tip shape, dynamics, scatter,
 * texture, dual brush, color dynamics, transfer, wet edges, noise, airbrush),
 * eraser, selections, blend modes, undo, the viewport pass, color
 * conversions, and the Photoshop keyboard shortcuts.
 *
 * Usage:
 *   npm run build && npm test    # tests/run.mjs serves dist/ and runs this
 * or, against an already-running server:
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

  // ---- 12. dual brush: the mask gates the stroke AT COMPOSITE TIME ----
  // (like Photoshop: the accumulated stroke is combined with the accumulated
  // mask when it merges into the layer — gating per dab and re-accumulating
  // would average the mask's texture away at low flow)
  {
    const dual = { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
      size: 30, spacing: 0.5, scatter: 0, bothAxes: true, count: 1 };
    eng.beginStroke(sp({ dual }));
    // Dual stamps are coverage, written as white (R channel of the mask).
    const cov = { color: [1, 1, 1] };
    // dual coverage laid down first at two spots (one outside the primary)
    eng.drawStamps(stamps(
      rec(170, 150, 15, 1, cov), rec(340, 150, 15, 1, cov),
    ), 2, 'dual');
    // then a big primary footprint
    eng.drawStamps(stamps(rec(200, 150, 80, 1)), 1);
    // and a dual stamp AFTER the primary dab — order does not matter
    eng.drawStamps(stamps(rec(240, 150, 15, 1, cov)), 1, 'dual');
    const d = await read();
    const atDual1 = px(d, 170, 150)[0];
    const late = px(d, 240, 150)[0];    // dual arrived after the dab
    const between = px(d, 205, 110)[0]; // inside primary, no dual coverage
    const outside = px(d, 340, 150)[0]; // dual coverage but no primary
    assert('dual brush: dab paints where the mask has ink',
      atDual1 <= 2, 'atDual1=' + atDual1);
    assert('dual brush: later dual stamps reveal the stroke (composite gate)',
      late <= 2, 'late=' + late);
    assert('dual brush: primary alone is masked out', between === 255,
      'between=' + between);
    assert('dual brush: dual alone paints nothing', outside === 255,
      'outside=' + outside);
    eng.cancelStroke();
  }

  // ---- 12b. dual brush burn modes: applied once to accumulated coverage --
  // Photoshop combines the mask with the stroke's ACCUMULATED coverage at
  // composite time (coverage-domain formulas). The stroke stays contained
  // to the dual train's marks, and a saturated mask passes the accumulated
  // coverage through unchanged — the mask's texture survives crisply even
  // when many low-flow dabs overlap (Size_Flow_Gang.abr "06 Gritty").
  for (const mode of ['color-burn', 'linear-burn']) {
    const dual = { enabled: true, shape: 'round', hardness: 1, mode,
      size: 30, spacing: 0.5, scatter: 0, bothAxes: true, count: 1 };
    eng.beginStroke(sp({ dual }));
    // saturated dual ink at one spot, 60% ink at another, then a 0.5 dab
    eng.drawStamps(stamps(
      rec(170, 150, 15, 1, { color: [1, 1, 1] }),
      rec(230, 150, 15, 0.6, { color: [1, 1, 1] }),
    ), 2, 'dual');
    eng.drawStamps(stamps(rec(200, 150, 80, 0.5)), 1);
    const d = await read();
    const full = px(d, 170, 150)[0];    // v=1: coverage passes unchanged
    const mid = px(d, 230, 150)[0];     // v=0.6: modes differ (see below)
    const empty = px(d, 255, 150)[0];   // v=0: contained -> unpainted
    eng.cancelStroke();
    assert('dual ' + mode + ': saturated mask passes coverage unchanged',
      near(full, 128, 3), 'full=' + full);
    // color burn: 1 - (1-0.5)/0.6 = 0.167 -> 213. linear burn:
    // clamp(0.5 + 0.6 - 1) = 0.1 -> 230.
    const wantMid = mode === 'color-burn' ? 213 : 230;
    assert('dual ' + mode + ': burns the accumulated coverage against the mask',
      near(mid, wantMid, 3), 'mid=' + mid + ' want=' + wantMid);
    assert('dual ' + mode + ': contained to the dual marks', empty === 255,
      'empty=' + empty);
  }

  // ---- 13. dual brush walks its own spacing train along a stroke ----
  // (round tip: train pitch = spacing% x diameter, 2.5 x 16 = 40px steps
  // with 16px marks -> a dashed line)
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

  // ---- 13a. primary spacing uses the tip mark's short side too ----
  // A 2:1-wide sampled tip (aspect 0.5) at 180% spacing paces dabs at
  // 0.9 x its mark width, so the stroke stays connected where a round tip
  // with the same settings would leave mark-sized gaps.
  {
    const wideTip = new Uint8Array(64 * 64);
    for (let y = 16; y < 48; y++) {
      for (let x = 0; x < 64; x++) wideTip[y * 64 + x] = 255;
    }
    NL.brush.patterns.registerTip('test-wide-tip', { size: 64, data: wideTip });
    const samp = (x, y) => ({ x, y, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 });
    const runStroke = async (shape) => {
      const b = makeBrush({ tip: { shape, size: 40, hardness: 1, spacing: 1.8 },
        smoothing: 0 });
      eng.beginStroke(NL.brush.engineStrokeParams(b, 'paint'));
      const s = new NL.StrokeSession(eng, b,
        { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
      s.down(samp(80, 150));
      s.move([samp(320, 150)]);
      s.up();
      const d = await read();
      let worst = 0;
      for (let x = 90; x <= 310; x += 2) worst = Math.max(worst, px(d, x, 150)[0]);
      eng.cancelStroke();
      return worst;
    };
    const wideWorst = await runStroke('test-wide-tip');
    const roundWorst = await runStroke('round');
    assert('primary spacing: squat tip paces by its short side (connected)',
      wideWorst <= 60, 'worst=' + wideWorst);
    assert('primary spacing: round tip at 180% leaves gaps (diameter basis)',
      roundWorst >= 250, 'worst=' + roundWorst);
  }

  // ---- 13b. tip angle sign: positive rotates counter-clockwise (Photoshop) ----
  {
    const settings = makeBrush({
      tip: { size: 80, hardness: 1, roundness: 0.25, angle: 45, spacing: 0.15 },
    });
    const recs = [];
    D.emitStamps(
      settings,
      { sample: { x: 200, y: 150, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 },
        direction: 0, initialDirection: 0, stepIndex: 0 },
      200, 150,
      { strokeColor: { r: 0, g: 0, b: 0 }, fg: { h: 0, s: 0, v: 0 },
        bg: { h: 0, s: 0, v: 1 }, rng: () => 0 },
      recs,
    );
    assert('angle sign: +45° emits -pi/4 radians (y-down rotation)',
      near(recs[4], -Math.PI / 4, 1e-6), 'angle=' + recs[4]);
    eng.beginStroke(sp({ hardness: 1 }));
    eng.drawStamps(new Float32Array(recs), recs.length / D.STAMP_FLOATS);
    const d = await read();
    const ccw = px(d, 221, 129)[0]; // up-right: long axis of a +45° ellipse
    const cw = px(d, 221, 171)[0];  // down-right: long axis if the sign flipped
    assert('angle sign: +45° tilts the long axis counter-clockwise on screen',
      ccw <= 40 && cw >= 240, ccw + ',' + cw);
    eng.cancelStroke();
  }

  // ---- 13c. dual brush gates at composite: retroactive, order-free ----
  // The train stamps the mask exactly where the path crosses its spacing
  // marks; because the gate reads the mask at merge time, dabs painted past
  // the last mask stamp stay hidden until the next stamp lands and reveals
  // them (Photoshop's dual texture filling in under the brush).
  {
    const settings = makeBrush({
      tip: { size: 10, hardness: 1, spacing: 0.5 },
      dual: { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
        size: 60, spacing: 2.0, scatter: 0, bothAxes: false, count: 1 },
      smoothing: 0,
    });
    // train pitch 2.0 x 60 = 120px -> mask stamps at x = 80 (down), 200,
    // 320: coverage discs [50..110], [170..230], [290..350] with gaps
    eng.beginStroke(NL.brush.engineStrokeParams(settings, 'paint'));
    const session = new NL.StrokeSession(eng, settings,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    const samp = (x, y) => ({ x, y, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 });
    session.down(samp(80, 150));
    for (let x = 90; x <= 190; x += 10) session.move([samp(x, 150)]);
    const a = await read();
    for (let x = 200; x <= 320; x += 10) session.move([samp(x, 150)]);
    session.up();
    const b = await read();
    assert('dual composite gate: dabs past the last mask stamp stay hidden',
      px(a, 185, 150)[0] >= 250, 'v=' + px(a, 185, 150)[0]);
    assert('dual composite gate: the next mask stamp reveals them',
      px(b, 185, 150)[0] <= 60, 'v=' + px(b, 185, 150)[0]);
    assert('dual composite gate: geometric gaps between stamps stay clear',
      px(b, 140, 150)[0] >= 250, 'v=' + px(b, 140, 150)[0]);
    assert('dual composite gate: painting continues past the mask stamp',
      px(b, 210, 150)[0] <= 60, 'v=' + px(b, 210, 150)[0]);
    eng.cancelStroke();

    // One giant segment must behave identically to many small moves.
    eng.beginStroke(NL.brush.engineStrokeParams(settings, 'paint'));
    const s2 = new NL.StrokeSession(eng, settings,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    s2.down(samp(80, 220));
    s2.move([samp(320, 220)]);
    s2.up();
    const d2 = await read();
    assert('dual in-segment: continuous inside mask coverage',
      px(d2, 178, 220)[0] <= 60, 'v=' + px(d2, 178, 220)[0]);
    assert('dual in-segment: geometric gaps preserved',
      px(d2, 140, 220)[0] >= 250, 'v=' + px(d2, 140, 220)[0]);
    assert('dual in-segment: paints past the mask stamp',
      px(d2, 210, 220)[0] <= 60, 'v=' + px(d2, 210, 220)[0]);
    eng.cancelStroke();

    // Direction reversal: mask stamps land on the walked path, so a stroke
    // that doubles back must not leave an unmasked band on the return leg.
    const rev = makeBrush({
      tip: { size: 40, hardness: 1, spacing: 0.1 },
      dual: { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
        size: 60, spacing: 1.0, scatter: 0, bothAxes: false, count: 1 },
      smoothing: 0,
    });
    eng.beginStroke(NL.brush.engineStrokeParams(rev, 'paint'));
    const sr = new NL.StrokeSession(eng, rev,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    sr.down(samp(200, 150));
    sr.move([samp(200, 140)]);
    sr.move([samp(200, 130)]); // small upward start...
    for (let y = 140; y <= 290; y += 10) sr.move([samp(200, y)]); // ...then reverse
    sr.up();
    const dr = await read();
    let holes = 0;
    for (let y = 155; y <= 260; y += 1) {
      if (px(dr, 200, y)[0] >= 250) holes++;
    }
    assert('dual reversal: no missing band after reversing direction',
      holes === 0, 'unpainted rows=' + holes);
    eng.cancelStroke();

    // With overlapping mask stamps (spacing 50%, dual larger than primary)
    // the stroke must be CONTINUOUS — the case that used to leave seams.
    // (At exactly 100% round marks only touch at a point, like Photoshop,
    // so the gated stroke legitimately pinches there.)
    const cont = makeBrush({
      tip: { size: 40, hardness: 1, spacing: 0.1 },
      dual: { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
        size: 60, spacing: 0.5, scatter: 0, bothAxes: false, count: 1 },
      smoothing: 0,
    });
    eng.beginStroke(NL.brush.engineStrokeParams(cont, 'paint'));
    const s3 = new NL.StrokeSession(eng, cont,
      { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } });
    s3.down(samp(80, 60));
    for (let x = 90; x <= 320; x += 10) s3.move([samp(x, 60)]);
    s3.up();
    const d3 = await read();
    let worst = 0;
    for (let x = 95; x <= 305; x += 2) worst = Math.max(worst, px(d3, x, 60)[0]);
    assert('dual 50% spacing: overlapping mask stamps paint a continuous mark',
      worst <= 60, 'worst=' + worst);
    eng.cancelStroke();
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

  // ---- 15b. Lock Transparent Pixels confines strokes to existing alpha ----
  {
    eng.ensureLayer('lk');
    // an opaque red disk on an otherwise transparent layer
    eng.beginStroke(sp({ hardness: 1 }));
    eng.drawStamps(stamps(rec(120, 150, 40, 1, { color: [1, 0, 0] })), 1);
    eng.endStroke('lk');
    // paint green across the disk boundary with the alpha lock on
    eng.beginStroke(sp({ hardness: 1, lockTransparent: true }));
    eng.drawStamps(stamps(rec(160, 150, 40, 1, { color: [0, 1, 0] })), 1);
    eng.endStroke('lk');
    const st = { layers: [meta('lk')], activeLayerId: 'lk', view };
    let d = await eng.readComposite(st);
    assert('alpha lock: overlap recolored, still opaque',
      px(d, 140, 150)[1] >= 250 && px(d, 140, 150)[3] === 255,
      px(d, 140, 150).join());
    assert('alpha lock: no paint lands on transparent pixels',
      px(d, 190, 150)[3] === 0, 'a=' + px(d, 190, 150)[3]);
    // the eraser cannot remove locked alpha either
    eng.beginStroke(sp({ mode: 'erase', lockTransparent: true }));
    eng.drawStamps(stamps(rec(120, 150, 30, 1)), 1);
    eng.endStroke('lk');
    d = await eng.readComposite(st);
    assert('alpha lock: eraser is a no-op', px(d, 120, 150)[3] === 255,
      'a=' + px(d, 120, 150)[3]);
    eng.deleteLayer('lk');
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

  // ---- 19b. bristle engine: geometry + deposition (pure) ----
  {
    const B = NL.brush.bristle;
    const bs = B.defaultBristleBrush();
    const rng = B.mulberry32(7);
    const bundle = B.makeBundle(bs, rng);
    assert('bristle: bundle has bristleCount bristles', bundle.length === bs.bristleCount,
      'n=' + bundle.length);
    const bundle2 = B.makeBundle(bs, B.mulberry32(7));
    assert('bristle: bundle deterministic under a seeded rng',
      JSON.stringify(bundle) === JSON.stringify(bundle2));

    const pen = (pressure, tiltX = 0, tiltY = 0, twist = 0) =>
      ({ x: 0, y: 0, pressure, tiltX, tiltY, twist });
    const touching = (pose) => bundle.filter((b) => B.bristleTouches(bs, b, pose));
    const nLow = touching(B.penPose(bs, pen(0.15))).length;
    const nMid = touching(B.penPose(bs, pen(0.5))).length;
    const nFull = touching(B.penPose(bs, pen(1))).length;
    assert('bristle: footprint grows with pressure', nLow < nMid && nMid < nFull,
      nLow + ' < ' + nMid + ' < ' + nFull);
    assert('bristle: full pressure engages the whole tuft', nFull === bundle.length,
      nFull + '/' + bundle.length);
    assert('bristle: zero pressure touches nothing',
      touching(B.penPose(bs, pen(0))).length === 0);

    // tilt slides the contact patch toward the lean
    const poseTilt = B.penPose(bs, pen(0.3, 50, 0));
    const hit = touching(poseTilt);
    const cx = hit.reduce((s2, b) => s2 + B.bristleOffset(bs, b, poseTilt, 100).x, 0) /
      Math.max(hit.length, 1);
    assert('bristle: tilt shifts the footprint toward the lean', hit.length > 0 && cx > 0,
      'cx=' + cx.toFixed(2) + ' n=' + hit.length);

    // analytic cursor outline: grows with pressure, respects thickness
    const out1 = B.footprintOutline(bs, B.penPose(bs, pen(1)), 100);
    const outLo = B.footprintOutline(bs, B.penPose(bs, pen(0.2)), 100);
    const extent = (pts, f) => Math.max(...pts.map(f)) - Math.min(...pts.map(f));
    assert('bristle: outline wider at full pressure',
      extent(out1, (p) => p.x) > extent(outLo, (p) => p.x));
    assert('bristle: outline flattened by thickness',
      extent(out1, (p) => p.y) < extent(out1, (p) => p.x) * (bs.thickness + 0.1));

    // value noise: deterministic, bounded
    let nOk = true;
    for (let i = 0; i < 50; i++) {
      const v = B.valueNoise1(3.7, i * 0.31);
      if (!(v >= 0 && v <= 1) || v !== B.valueNoise1(3.7, i * 0.31)) nOk = false;
    }
    assert('bristle: value noise deterministic and in 0..1', nOk);

    // deposition: tracks emit 11-float records; breakup thins them
    const simRecords = (over) => {
      const s2 = Object.assign({}, bs, {
        opacityJitter: 0, load: 0, breakup: 0,
        colorJitter: { hue: 0, sat: 0, bri: 0, fgBg: 0 },
      }, over);
      const sim = new B.BristleSim(s2, 40,
        { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 }, rng: B.mulberry32(11) });
      const out = [];
      sim.update(pen(1), out);
      for (let x = 110; x <= 300; x += 10) {
        sim.update({ x, y: 150, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 }, out);
      }
      return out;
    };
    const solid = simRecords({});
    assert('bristle: sim emits TRACK_FLOATS-sized records',
      solid.length > 0 && solid.length % B.TRACK_FLOATS === 0, 'len=' + solid.length);
    const broken = simRecords({ breakup: 0.85 });
    assert('bristle: breakup skips deposition along tracks',
      broken.length < solid.length * 0.6,
      broken.length + ' vs ' + solid.length);

    // depletion: alpha fades and the tooth gate deepens as bristles dry
    // (load is in brush diameters: 3 x 40px size = 120px of travel)
    const dry = simRecords({ load: 3 });
    const alphaAt = (rs, i) => rs[i * 11 + 5];
    const depthAt = (rs, i) => rs[i * 11 + 9];
    const nRec = dry.length / 11;
    assert('bristle: load depletion fades the track tail',
      alphaAt(dry, nRec - 1) < alphaAt(dry, 0) * 0.5,
      alphaAt(dry, 0).toFixed(3) + ' -> ' + alphaAt(dry, nRec - 1).toFixed(3));
    assert('bristle: dryness raises the tooth gate',
      depthAt(dry, nRec - 1) > depthAt(dry, 0),
      depthAt(dry, 0).toFixed(3) + ' -> ' + depthAt(dry, nRec - 1).toFixed(3));

    // scale invariance: the same gesture at 3x size makes the same mark 3x
    // larger — track width scales with size, and the load runs out at the
    // same point of the (relative) stroke.
    {
      const runAt = (scale) => {
        const s2 = Object.assign({}, bs, {
          opacityJitter: 0, load: 4, breakup: 0,
          colorJitter: { hue: 0, sat: 0, bri: 0, fgBg: 0 },
        });
        const sim = new B.BristleSim(s2, 40 * scale,
          { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 }, rng: B.mulberry32(21) });
        const out = [];
        for (let i = 0; i <= 40; i++) {
          sim.update({ x: (100 + i * 10) * scale, y: 150 * scale, pressure: 1,
            tiltX: 0, tiltY: 0, twist: 0 }, out);
        }
        const widths = [];
        for (let i = 0; i < out.length; i += 11) {
          widths.push(out[i + 4] * 2); // 2 x halfWidth
        }
        return {
          meanWidth: widths.reduce((a, b2) => a + b2, 0) / widths.length,
          lastAlpha: out[out.length - 11 + 5],
        };
      };
      const at1 = runAt(1);
      const at3 = runAt(3);
      assert('bristle: track width scales with brush size',
        near(at3.meanWidth / at1.meanWidth, 3, 0.25),
        'ratio=' + (at3.meanWidth / at1.meanWidth).toFixed(3));
      assert('bristle: load depletes at the same relative travel at any size',
        near(at3.lastAlpha, at1.lastAlpha, 0.05),
        at1.lastAlpha.toFixed(3) + ' vs ' + at3.lastAlpha.toFixed(3));
    }

    // flex: bristle tips trail the pen (drag lag)
    {
      const trailRun = (flex) => {
        const s2 = Object.assign({}, bs, {
          flex, turnSoftness: 0, opacityJitter: 0, load: 0, breakup: 0,
          colorJitter: { hue: 0, sat: 0, bri: 0, fgBg: 0 },
        });
        const sim = new B.BristleSim(s2, 40,
          { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 }, rng: B.mulberry32(31) });
        const out = [];
        for (let i = 0; i <= 20; i++) {
          sim.update({ x: 100 + i * 10, y: 150, pressure: 1,
            tiltX: 0, tiltY: 0, twist: 0 }, out);
        }
        let maxX = -1e9;
        for (let i = 0; i < out.length; i += 11) maxX = Math.max(maxX, out[i + 2]);
        return maxX;
      };
      const rigid = trailRun(0);
      const flexed = trailRun(0.6);
      assert('bristle: flex makes tips trail the pen', flexed < rigid - 1,
        'rigid=' + rigid.toFixed(1) + ' flexed=' + flexed.toFixed(1));
    }

    // turn softening: a reversal deposits less than a straight pass
    {
      const zigzag = (turnSoftness) => {
        const s2 = Object.assign({}, bs, {
          flex: 0, turnSoftness, opacityJitter: 0, load: 0, breakup: 0,
          colorJitter: { hue: 0, sat: 0, bri: 0, fgBg: 0 },
        });
        const sim = new B.BristleSim(s2, 40,
          { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 }, rng: B.mulberry32(41) });
        const out = [];
        // back and forth: four reversals
        const xs = [100, 200, 120, 220, 140, 240];
        for (let leg = 0; leg + 1 < xs.length; leg++) {
          for (let i = leg === 0 ? 0 : 1; i <= 10; i++) {
            const x = xs[leg] + ((xs[leg + 1] - xs[leg]) * i) / 10;
            sim.update({ x, y: 150, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 }, out);
          }
        }
        let sum = 0;
        for (let i = 0; i < out.length; i += 11) sum += out[i + 5];
        return sum;
      };
      const hard = zigzag(0);
      const soft = zigzag(1);
      assert('bristle: turn softening lightens reversals', soft < hard * 0.97,
        'soft=' + soft.toFixed(1) + ' hard=' + hard.toFixed(1));
    }

    // engine params: tooth rides the texture-each-tip subtract path
    const ep = NL.brush.bristleEngineParams(bs, makeBrush({}));
    assert('bristle: engine params gate tooth via subtract/each-tip',
      ep.texture && ep.texture.mode === 'subtract' && ep.texture.eachTip === true &&
      ep.texture.depth === 1 && ep.dual === null);
    const epFlat = NL.brush.bristleEngineParams(
      Object.assign({}, bs, { toothDepth: 0 }), makeBrush({}));
    assert('bristle: zero tooth depth disables the texture pass', epFlat.texture === null);
  }

  // ---- 19c. bristle engine: GPU tracks ----
  {
    const B = NL.brush.bristle;
    const solidSettings = Object.assign(B.defaultBristleBrush(), {
      bristleCount: 96, coverage: 1, softness: 0, flow: 1,
      opacityJitter: 0, load: 0, breakup: 0, toothDepth: 0,
      colorJitter: { hue: 0, sat: 0, bri: 0, fgBg: 0 },
      splay: 0.3, thickness: 0.45, reloadOnLift: true,
    });
    const colors = { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 } };
    const samp = (x, y, p) => ({ x, y, pressure: p, tiltX: 0, tiltY: 0, twist: 0 });
    const drag = (settings, sizePx) => {
      eng.beginStroke(NL.brush.bristleEngineParams(settings, makeBrush({})));
      const session = new NL.BristleStrokeSession(eng, settings,
        Object.assign({ sizePx, smoothing: 0, rng: B.mulberry32(5) }, colors));
      session.down(samp(100, 150, 1));
      for (let x = 110; x <= 300; x += 10) session.move([samp(x, 150, 1)]);
      session.up();
      eng.endStroke('bg');
    };

    drag(solidSettings, 40);
    let d = await read();
    // the stroke spine should be covered along the whole gesture
    let gaps = 0;
    for (let x = 110; x <= 290; x += 5) {
      let lo = 255;
      for (let y = 146; y <= 154; y += 2) lo = Math.min(lo, px(d, x, y)[0]);
      if (lo > 120) gaps++;
    }
    assert('bristle GPU: tracks cover the stroke spine', gaps === 0, gaps + ' gaps');
    assert('bristle GPU: nothing outside the tuft width', px(d, 200, 250)[0] === 255,
      'v=' + px(d, 200, 250)[0]);
    await eng.undo();

    // depletion: the tail of a stroke is drier (lighter) than the head
    // (2.5 diameters x 40px = 100px of loaded travel)
    const drySettings = Object.assign({}, solidSettings, { load: 2.5, flow: 0.9 });
    drag(drySettings, 40);
    d = await read();
    const avgCol = (x) => {
      let s2 = 0, n = 0;
      for (let y = 144; y <= 156; y += 2) { s2 += px(d, x, y)[0]; n++; }
      return s2 / n;
    };
    const head = avgCol(115);
    const tail = avgCol(290);
    assert('bristle GPU: paint runs out along the stroke', tail - head > 40,
      'head=' + head.toFixed(0) + ' tail=' + tail.toFixed(0));
    await eng.undo();

    // pressure footprint: a light touch marks a much thinner band than full press
    const bandHeight = (data) => {
      let top = 1e9, bot = -1e9;
      for (let y = 100; y <= 200; y++) {
        if (px(data, 200, y)[0] < 200) { top = Math.min(top, y); bot = Math.max(bot, y); }
      }
      return bot >= top ? bot - top : 0;
    };
    drag(solidSettings, 60);
    d = await read();
    const hFull = bandHeight(d);
    await eng.undo();

    eng.beginStroke(NL.brush.bristleEngineParams(solidSettings, makeBrush({})));
    const light = new NL.BristleStrokeSession(eng, solidSettings,
      Object.assign({ sizePx: 60, smoothing: 0, rng: B.mulberry32(5) }, colors));
    light.down(samp(100, 150, 0.1));
    for (let x = 110; x <= 300; x += 10) light.move([samp(x, 150, 0.1)]);
    light.up();
    eng.endStroke('bg');
    d = await read();
    const hLight = bandHeight(d);
    assert('bristle GPU: light pressure engages a thinner band',
      hLight > 0 && hLight < hFull * 0.6, hLight + ' vs ' + hFull);
    await eng.undo();
  }

  // ---- 19d. bristle presets ----
  {
    const B = NL.brush.bristle;
    const BP = NL.brush.bristlePresets;
    const presets = BP.BRISTLE_PRESETS;
    assert('bristle presets: library is non-empty', presets.length >= 5,
      'n=' + presets.length);

    const ids = new Set(presets.map((x) => x.id));
    assert('bristle presets: ids unique', ids.size === presets.length);
    assert('bristle presets: findBristlePreset resolves',
      BP.findBristlePreset('br-dry-filbert')?.name === 'Dry Filbert');
    assert('bristle presets: unknown id returns undefined',
      BP.findBristlePreset('nope') === undefined);

    let valid = true;
    let paints = true;
    for (const pr of presets) {
      const s2 = pr.settings;
      if (!(s2.bristleCount >= 8 && s2.bristleCount <= 256) ||
          !(s2.thickness > 0 && s2.thickness <= 1) ||
          !(s2.belly > 0 && s2.belly <= 1) ||
          !(s2.flow > 0 && s2.flow <= 1) ||
          !(s2.coverage > 0 && s2.coverage <= 1.5) ||
          !(s2.load >= 0 && s2.load <= 50) ||
          !(s2.breakupScale > 0 && s2.breakupScale <= 3) ||
          !(pr.size >= 1 && pr.size <= 1000) ||
          !(pr.opacity > 0 && pr.opacity <= 1)) valid = false;
      // every preset must actually deposit on a plain pressure-ramp stroke
      const sim = new B.BristleSim(s2, pr.size,
        { fg: { h: 0, s: 0, v: 0 }, bg: { h: 0, s: 0, v: 1 }, rng: B.mulberry32(9) });
      const out = [];
      for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        sim.update({ x: 50 + t * 250, y: 150, pressure: Math.sin(t * Math.PI),
          tiltX: 0, tiltY: 0, twist: 0 }, out);
      }
      if (out.length === 0 || out.length % 11 !== 0) paints = false;
    }
    assert('bristle presets: all values in range', valid);
    assert('bristle presets: every preset deposits on a test stroke', paints);
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

    // scatter spreads across scatter% x diameter TOTAL: offsets reach
    // +-scatter% x radius, never a full diameter (Photoshop semantics)
    {
      const wide = makeBrush({
        tip: { size: 100 },
        scatter: { enabled: true, bothAxes: true, scatter: 1,
          scatterControl: { source: 'off', fadeSteps: 25 }, count: 1, countJitter: 0 },
      });
      const o = [];
      D.emitStamps(wide, ctx(1), 0, 0,
        { strokeColor: { r: 0, g: 0, b: 0 }, fg: { h: 0, s: 0, v: 0 },
          bg: { h: 0, s: 0, v: 1 }, rng: () => 1 }, o);
      const off = Math.hypot(o[0], o[1]);
      assert('dynamics: 100% scatter tops out at half a diameter',
        near(off, 50, 0.5), 'offset=' + off);
      const dual = { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
        size: 100, spacing: 0.5, scatter: 1, bothAxes: false, count: 1,
        countJitter: 0 };
      const od = [];
      D.emitDualStamps(dual, ctx(1), 0, 0, () => 1, od);
      const offD = Math.hypot(od[0], od[1]);
      assert('dynamics: dual 100% scatter tops out at half a diameter',
        near(offD, 50, 0.5), 'offset=' + offD);

      // Photoshop implicitly mirrors dual marks at random on both axes —
      // even with scatter off — and never rotates them
      const of = [];
      const frng = NL.brush.patterns.seededRng(9);
      for (let i = 0; i < 16; i++) {
        D.emitDualStamps({ ...dual, scatter: 0 }, ctx(1), 0, 0, frng, of);
      }
      const flags = new Set();
      let spun = 0;
      for (let i = 0; i < 16; i++) {
        flags.add(of[i * D.STAMP_FLOATS + 9]);
        if (of[i * D.STAMP_FLOATS + 4] !== 0) spun++;
      }
      assert('dynamics: dual marks get implicit random flips, no rotation',
        flags.size >= 3 && spun === 0,
        'flags=' + [...flags].join('/') + ' spun=' + spun);

      // dual spacing basis: spacing% x the tip MARK's short side. A round
      // tip at 100% abuts (pitch = diameter); a 2:1-wide sampled tip packs
      // twice as tight (Photoshop-verified with circle vs chalk dual tips).
      const wideTip = new Uint8Array(64 * 64);
      for (let y = 16; y < 48; y++) {
        for (let x = 0; x < 64; x++) wideTip[y * 64 + x] = 255;
      }
      NL.brush.patterns.registerTip('test-wide-tip', { size: 64, data: wideTip });
      const spacingBase = { enabled: true, hardness: 1, mode: 'multiply',
        size: 40, spacing: 1, scatter: 0, bothAxes: false, count: 1,
        countJitter: 0 };
      const roundPitch = D.dualSpacingPx({ ...spacingBase, shape: 'round' });
      const squatPitch = D.dualSpacingPx({ ...spacingBase, shape: 'test-wide-tip' });
      assert('dual spacing: 100% of a round tip is its diameter',
        near(roundPitch, 40, 1e-6), 'pitch=' + roundPitch);
      assert('dual spacing: a squat tip packs tighter by its ink aspect',
        near(squatPitch, 20, 1e-6), 'pitch=' + squatPitch);
    }

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

    // Photoshop scales the dual tip proportionally with the primary size
    const st = NL.store.getState();
    st.updateBrush({ dual: { ...st.brush.dual, enabled: true, size: 50 } }, 'brush');
    const size0 = NL.store.getState().brush.tip.size;
    st.updateBrush(
      { tip: { ...NL.store.getState().brush.tip, size: size0 * 2 } }, 'brush');
    assert('store: resizing the tip scales the dual tip proportionally',
      Math.abs(NL.store.getState().brush.dual.size - 100) < 1e-6,
      'dual.size=' + NL.store.getState().brush.dual.size);
    st.updateBrush(
      { dual: { ...NL.store.getState().brush.dual, size: 80 } }, 'brush');
    assert('store: explicit dual edits do not rescale',
      NL.store.getState().brush.dual.size === 80, '');
    NL.store.getState().applyPreset('soft-round', 'brush');
  }

  // ---- 21b. ABR import ----
  //
  // The synthesized fixtures below replicate the descriptor schema observed
  // in real Photoshop ABR files. Files analyzed while building the parser
  // (all fetched from public GitHub repositories):
  //   https://raw.githubusercontent.com/MaousamaQAQ/Nopressure/main/brushes/Spray_Brush_1.abr   (v6.2)
  //   https://raw.githubusercontent.com/MaousamaQAQ/Nopressure/main/brushes/Spray_Brush_2.abr   (v6.2)
  //   https://raw.githubusercontent.com/igdiaysu/Photoshop/main/Brushes/MB%20Starter%20Pack%202021v4.abr (v6.2, texture+dual+patt)
  //   https://raw.githubusercontent.com/igdiaysu/Photoshop/main/Brushes/Selected.abr            (v6.2, texture+dual+toolOptions)
  //   https://raw.githubusercontent.com/igdiaysu/Photoshop/main/Brushes/Evenant-Concept-Art-Brush-Pack.abr (v10.2, 117 brushes)
  //   https://raw.githubusercontent.com/igdiaysu/Photoshop/main/Brushes/Special%20Brushes.abr   (v10.2)
  //   https://raw.githubusercontent.com/igdiaysu/Photoshop/main/Brushes/Perspective%20Grid.abr  (v10.2)
  //   https://raw.githubusercontent.com/igdiaysu/Photoshop/main/Brushes/Architect%20Photoshop%20Brushes%205.abr (v6.2)
  // Format cross-references: GIMP app/core/gimpbrush-load.c (samp header
  // sizes 47/301), github.com/SonyStone/ABR-Viewer research.md, and
  // github.com/jlai/brush-viewer ABR.ksy.
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

    // Tiny DSL for Actions-format descriptors.
    const writeDesc = (w, items) => {
      w.unicode(''); w.dkey('null'); w.u32(items.length);
      for (const [k, fn] of items) { w.dkey(k); fn(w); }
    };
    const T = {
      untf: (unit, v) => (w) => w.ascii('UntF').ascii(unit).f64(v),
      text: (s) => (w) => { w.ascii('TEXT'); w.unicode(s); },
      bool: (b) => (w) => w.ascii('bool').u8(b ? 1 : 0),
      long: (n) => (w) => { w.ascii('long'); w.u32(n); },
      enm: (t, v) => (w) => { w.ascii('enum'); w.dkey(t); w.dkey(v); },
      objc: (items) => (w) => { w.ascii('Objc'); writeDesc(w, items); },
      list: (items) => (w) => { w.ascii('VlLs'); w.u32(items.length); for (const fn of items) fn(w); },
    };
    // dynamics variance object: {bVTy, fStp, jitter%, Mnm%}
    const dyn = (bVTy, jitter, mnm = 0, fStp = 25) => T.objc([
      ['bVTy', T.long(bVTy)], ['fStp', T.long(fStp)],
      ['jitter', T.untf('#Prc', jitter)], ['Mnm ', T.untf('#Prc', mnm)],
    ]);

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

    // --- v6.2 fixture with the full real-world schema ---
    {
      const uuidA = '01234567-89ab-cdef-0123-456789abcdef'; // primary tip
      const uuidB = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'; // dual tip
      const pattG = 'deadbeef-0000-1111-2222-333344445555'; // gray pattern
      const pattC = 'cafebabe-9999-8888-7777-666655554444'; // RGB pattern

      // samp: two 8x8 raw tips. Tip A: left half opaque. Tip B: all opaque.
      const sampEntry = (uuid, pixels) => {
        const e = new W();
        e.u8(36).ascii(uuid);
        e.raw(new Array(301 - 37).fill(0)); // pad header to 301 total
        e.u32(0).u32(0).u32(8).u32(8);
        e.u16(8).u8(0);
        e.raw(pixels);
        while (e.length % 4 !== 0) e.u8(0);
        return e;
      };
      const pxA = [];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pxA.push(x < 4 ? 255 : 0);
      const sampA = sampEntry(uuidA, pxA);
      const sampB = sampEntry(uuidB, new Array(64).fill(255));

      // patt: entry 1 = grayscale raw 8x8 vertical gradient; entry 2 = RGB
      // 4x4 with RLE channels (constant R=200, G=100, B=50 -> luma 127).
      const pattEntry = (uuid, name, mode, w2, h2, channels) => {
        const e = new W();
        e.u32(1).u32(mode).u16(h2).u16(w2);
        e.unicode(name);
        e.u8(uuid.length).ascii(uuid);
        const vma = new W();
        vma.u32(0).u32(0).u32(h2).u32(w2); // rect
        vma.u32(24); // max channels
        let written = 0;
        for (const ch of channels) {
          vma.u32(1); // written
          const chBody = new W();
          chBody.u32(8); // depth
          chBody.u32(0).u32(0).u32(h2).u32(w2);
          chBody.u16(8); // pixel depth
          if (ch.rle) {
            chBody.u8(1);
            for (let y = 0; y < h2; y++) chBody.u16(2); // per-row byte counts
            for (let y = 0; y < h2; y++) { chBody.u8(256 - (w2 - 1)); chBody.u8(ch.value); } // run of w2
          } else {
            chBody.u8(0);
            chBody.raw(ch.data);
          }
          vma.u32(chBody.length); // channel length = 23-byte header + data
          vma.raw(chBody.b);
          written++;
        }
        for (let i = written; i < 26; i++) vma.u32(0); // unwritten channels
        e.u32(3).u32(vma.length); // VMAL version + length
        e.raw(vma.b);
        return e;
      };
      const gradient = [];
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) gradient.push(y * 32);
      const patt1 = pattEntry(pattG, 'GrayGrad', 1, 8, 8, [{ data: gradient }]);
      const patt2 = pattEntry(pattC, 'RGBFlat', 3, 4, 4,
        [{ rle: true, value: 200 }, { rle: true, value: 100 }, { rle: true, value: 50 }]);

      // desc: one brush exercising every mapped section. Note useDualBrush
      // nested inside dualBrush and the dual tip UUID truncated to 35 chars,
      // both as observed in real files.
      const desc = new W();
      desc.u32(16); // versioned descriptor prefix
      writeDesc(desc, [
        ['Brsh', T.list([
          T.objc([
            ['Nm  ', T.text('Fancy')],
            ['Brsh', T.objc([
              ['Dmtr', T.untf('#Pxl', 40)],
              ['Angl', T.untf('#Ang', 15)],
              ['Rndn', T.untf('#Prc', 80)],
              ['Spcn', T.untf('#Prc', 30)],
              ['Intr', T.bool(true)],
              ['flipX', T.bool(false)],
              ['flipY', T.bool(false)],
              ['sampledData', T.text(uuidA)],
            ])],
            ['useTipDynamics', T.bool(true)],
            ['flipX', T.bool(true)], // flip X *jitter*
            ['flipY', T.bool(false)],
            ['minimumDiameter', T.untf('#Prc', 40)],
            ['minimumRoundness', T.untf('#Prc', 30)],
            ['tiltScale', T.untf('#Prc', 200)],
            ['szVr', dyn(2, 30)],            // pen pressure
            ['angleDynamics', dyn(6, 0)],    // direction (5 = initial direction)
            ['roundnessDynamics', dyn(7, 0)],// rotation
            ['useScatter', T.bool(true)],
            ['bothAxes', T.bool(true)],
            ['Spcn', T.untf('#Prc', 100)],
            ['Cnt ', T.long(3)],
            ['scatterDynamics', dyn(0, 150)],
            ['countDynamics', dyn(0, 25)],
            ['useTexture', T.bool(true)],
            ['interpretation', T.bool(true)],
            ['textureScale', T.untf('#Prc', 178)],
            ['textureBlendMode', T.enm('BlnM', 'linearHeight')],
            ['textureDepth', T.untf('#Prc', 60)],
            ['minimumDepth', T.untf('#Prc', 0)],
            ['InvT', T.bool(true)],
            ['TxtC', T.bool(true)],
            ['textureBrightness', T.long(-75)],
            ['textureContrast', T.long(50)],
            ['textureDepthDynamics', dyn(2, 40)],
            ['Txtr', T.objc([['Nm  ', T.text('GrayGrad')], ['Idnt', T.text(pattG)]])],
            ['usePaintDynamics', T.bool(true)],
            ['opVr', dyn(2, 0, 25)],
            ['prVr', dyn(1, 10, 0, 40)],     // fade over 40 steps
            ['useColorDynamics', T.bool(true)],
            ['colorDynamicsPerTip', T.bool(false)],
            ['clVr', dyn(0, 20)],
            ['H   ', T.untf('#Prc', 10)],
            ['Strt', T.untf('#Prc', 15)],
            ['Brgh', T.untf('#Prc', 5)],
            ['purity', T.untf('#Prc', -30)],
            ['dualBrush', T.objc([
              ['useDualBrush', T.bool(true)],
              ['Flip', T.bool(true)],
              ['Brsh', T.objc([
                ['Dmtr', T.untf('#Pxl', 24)],
                ['Spcn', T.untf('#Prc', 10)],
                ['sampledData', T.text(uuidB.slice(0, 35))], // truncated!
              ])],
              ['BlnM', T.enm('BlnM', 'CBrn')],
              ['useScatter', T.bool(true)],
              ['Spcn', T.untf('#Prc', 120)],
              ['Cnt ', T.long(2)],
              ['bothAxes', T.bool(false)],
              ['countDynamics', dyn(0, 50)],
              ['scatterDynamics', dyn(0, 300)],
            ])],
            ['toolOptions', T.objc([
              ['Opct', T.long(80)],
              ['flow', T.long(65)],
              ['smoothingValue', T.long(35)],
              ['Md  ', T.enm('BlnM', 'Mltp')],
              ['usePressureOverridesSize', T.bool(true)],
              ['usePressureOverridesOpacity', T.bool(true)],
            ])],
            ['Wtdg', T.bool(true)],
            ['Nose', T.bool(false)],
            ['Rpt ', T.bool(true)],
          ]),
        ])],
      ]);

      const file = new W();
      file.u16(6).u16(2); // version 6, subversion 2
      const sampBody = new W();
      sampBody.u32(sampA.length).raw(sampA.b);
      sampBody.u32(sampB.length).raw(sampB.b);
      file.ascii('8BIM').ascii('samp').u32(sampBody.length).raw(sampBody.b);
      const pattBody = new W();
      pattBody.u32(patt1.length).raw(patt1.b);
      while (pattBody.length % 4 !== 0) pattBody.u8(0);
      pattBody.u32(patt2.length).raw(patt2.b);
      while (pattBody.length % 4 !== 0) pattBody.u8(0);
      file.ascii('8BIM').ascii('patt').u32(pattBody.length).raw(pattBody.b);
      file.ascii('8BIM').ascii('desc').u32(desc.length).raw(desc.b);

      const res = NL.brush.abr.parseAbr(file.buffer());
      const b = res.brushes[0];
      const s = b.settings;
      assert('abr v6: names, tip geometry, and tip bitmap',
        res.brushes.length === 1 && b.name === 'Fancy' && b.tipId === uuidA &&
        s.tip.size === 40 && Math.abs(s.tip.spacing - 0.3) < 1e-6 &&
        s.tip.angle === 15 && Math.abs(s.tip.roundness - 0.8) < 1e-6 &&
        res.tips.get(uuidA).data[4 * 8 + 1] === 255 && res.tips.get(uuidA).data[4 * 8 + 6] === 0,
        JSON.stringify({ n: b.name, tip: s.tip }));
      assert('abr v6: shape dynamics (pressure size, direction angle, rotation roundness)',
        s.shape.enabled && s.shape.sizeControl.source === 'pressure' &&
        Math.abs(s.shape.sizeJitter - 0.3) < 1e-6 &&
        Math.abs(s.shape.minDiameter - 0.4) < 1e-6 &&
        s.shape.angleControl.source === 'direction' &&
        s.shape.roundnessControl.source === 'rotation' &&
        Math.abs(s.shape.minRoundness - 0.3) < 1e-6 && s.shape.flipXJitter === true,
        JSON.stringify(s.shape));
      assert('abr v6: scattering (150% both axes, count 3, count jitter 25%)',
        s.scatter.enabled && Math.abs(s.scatter.scatter - 1.5) < 1e-6 &&
        s.scatter.bothAxes && s.scatter.count === 3 &&
        Math.abs(s.scatter.countJitter - 0.25) < 1e-6,
        JSON.stringify(s.scatter));
      assert('abr v6: texture block (linearHeight -> height, each tip, BCI)',
        s.texture.enabled && s.texture.mode === 'height' &&
        Math.abs(s.texture.scale - 1.78) < 1e-6 && Math.abs(s.texture.depth - 0.6) < 1e-6 &&
        s.texture.invert === true && s.texture.textureEachTip === true &&
        Math.abs(s.texture.brightness + 0.5) < 1e-6 && Math.abs(s.texture.contrast - 0.5) < 1e-6 &&
        Math.abs(s.texture.depthJitter - 0.4) < 1e-6 &&
        s.texture.depthControl.source === 'pressure' && b.texturePatternId === pattG,
        JSON.stringify(s.texture) + ' pat=' + b.texturePatternId);
      assert('abr v6: transfer (opVr pressure+min, prVr fade 40)',
        s.transfer.enabled && s.transfer.opacityControl.source === 'pressure' &&
        Math.abs(s.transfer.opacityMin - 0.25) < 1e-6 &&
        s.transfer.flowControl.source === 'fade' && s.transfer.flowControl.fadeSteps === 40 &&
        Math.abs(s.transfer.flowJitter - 0.1) < 1e-6,
        JSON.stringify(s.transfer));
      assert('abr v6: color dynamics (per-tip off, jitters, purity)',
        s.color.enabled && s.color.applyPerTip === false &&
        Math.abs(s.color.fgBgJitter - 0.2) < 1e-6 && Math.abs(s.color.hueJitter - 0.1) < 1e-6 &&
        Math.abs(s.color.satJitter - 0.15) < 1e-6 && Math.abs(s.color.purity + 0.3) < 1e-6,
        JSON.stringify(s.color));
      assert('abr v6: dual brush (nested flag, truncated uuid resolved, CBrn)',
        s.dual.enabled && s.dual.shape === uuidB && s.dual.mode === 'color-burn' &&
        // spacing comes from the nested tip's Spcn (the panel value), not
        // the outer dualBrush.Spcn (120 here, a stale default)
        s.dual.size === 24 && Math.abs(s.dual.spacing - 0.1) < 1e-6 &&
        Math.abs(s.dual.scatter - 3) < 1e-6 && s.dual.count === 2 &&
        Math.abs(s.dual.countJitter - 0.5) < 1e-6 &&
        s.dual.bothAxes === false,
        JSON.stringify(s.dual));
      assert('abr v6: toolOptions (opacity/flow/smoothing/mode/pen overrides)',
        Math.abs(s.opacity - 0.8) < 1e-6 && Math.abs(s.flow - 0.65) < 1e-6 &&
        Math.abs(s.smoothing - 0.35) < 1e-6 && s.blendMode === 'multiply' &&
        s.pressureSize === true && s.pressureOpacity === true,
        JSON.stringify({ o: s.opacity, f: s.flow, sm: s.smoothing, m: s.blendMode }));
      assert('abr v6: wet edges + airbrush toggles', s.wetEdges === true && s.airbrush === true, '');
      const g = res.patterns.get(pattG);
      const c = res.patterns.get(pattC);
      assert('abr v6: grayscale pattern decoded (raw, gradient rows)',
        g && g.map.size === 8 && g.map.data[0] === 0 && g.map.data[7 * 8] === 224,
        g ? JSON.stringify([g.map.size, g.map.data[0], g.map.data[7 * 8]]) : 'missing');
      // 0.299*200 + 0.587*100 + 0.114*50 = 124.2
      assert('abr v6: RGB pattern decoded via RLE to luminance (124±2)',
        c && c.map.size === 4 && near(c.map.data[5], 124, 2),
        c ? 'v=' + c.map.data[5] : 'missing');

      // --- full import wiring: tips, dual tip, pattern, painting ---
      const before = NL.brush.presets.allGroups().length;
      const n = NL.brush.importAbr('fixture.abr', file.buffer());
      const groups = NL.brush.presets.allGroups();
      const group = groups[groups.length - 1];
      const imp = group.presets[0].settings;
      assert('abr import: registers group; prefixes tip, dual tip, pattern ids',
        n === 1 && groups.length === before + 1 &&
        imp.tip.shape === 'abr:fixture:' + uuidA &&
        imp.dual.shape === 'abr:fixture:' + uuidB &&
        imp.texture.pattern === 'abr:fixture:' + pattG &&
        NL.brush.patterns.isRegisteredPattern('abr:fixture:' + pattG),
        JSON.stringify({ tip: imp.tip.shape, dual: imp.dual.shape, pat: imp.texture.pattern }));

      // paint with the imported tip only (texture/dual/dynamics off)
      const paintSettings = structuredClone(imp);
      paintSettings.wetEdges = false;
      paintSettings.shape.enabled = false;
      paintSettings.scatter.enabled = false;
      paintSettings.texture.enabled = false;
      paintSettings.dual.enabled = false;
      paintSettings.color.enabled = false;
      paintSettings.transfer.enabled = false;
      paintSettings.opacity = 1; paintSettings.flow = 1;
      paintSettings.blendMode = 'normal';
      eng.beginStroke(NL.brush.engineStrokeParams(paintSettings, 'paint'));
      eng.drawStamps(stamps(rec(200, 150, 32, 1)), 1);
      let d = await read();
      assert('abr import: painting uses the sampled tip bitmap',
        px(d, 185, 150)[0] <= 40 && px(d, 215, 150)[0] >= 240,
        px(d, 185, 150)[0] + ',' + px(d, 215, 150)[0]);
      eng.cancelStroke();

      // paint with the imported *pattern* as a whole-stroke texture:
      // pattern rows ramp 0..224 top-to-bottom, multiply depth 1 => the
      // stroke is carved dark->light along y
      const texSettings = structuredClone(paintSettings);
      texSettings.tip.shape = 'round';
      texSettings.tip.hardness = 1;
      texSettings.texture = {
        enabled: true, pattern: 'abr:fixture:' + pattG, scale: 4, // 8px tile * 4 = 32px
        brightness: 0, contrast: 0, invert: false, mode: 'multiply', depth: 1,
        textureEachTip: false, depthJitter: 0,
        depthControl: { source: 'off', fadeSteps: 25 },
      };
      eng.beginStroke(NL.brush.engineStrokeParams(texSettings, 'paint'));
      eng.drawStamps(stamps(rec(200, 150, 60, 1)), 1);
      d = await read();
      // rows of the 32px tile: y=144..147 -> tile row 4|5 (dark tex value),
      // sample two points: near tile top (tex 0 -> white) vs tile bottom
      const texTop = px(d, 200, 130)[0];    // 130 % 32 = 2 -> row 0 -> v=0 -> no paint
      const texBottom = px(d, 200, 156)[0]; // 156 % 32 = 28 -> row 7 -> v=224 -> strong paint
      eng.cancelStroke();
      assert('abr import: imported pattern drives whole-stroke texture',
        texTop >= 240 && texBottom <= 80, texTop + ',' + texBottom);
      NL.store.getState().applyPreset('soft-round', 'brush');
    }

    // --- new texture combine modes (screen) through the real pipeline ---
    {
      NL.brush.patterns.registerPattern('test-mid-gray',
        { size: 8, data: new Uint8Array(64).fill(128) }, 'MidGray');
      const st = makeBrush({});
      st.texture = {
        enabled: true, pattern: 'test-mid-gray', scale: 1, brightness: 0,
        contrast: 0, invert: false, mode: 'screen', depth: 1,
        textureEachTip: false, depthJitter: 0,
        depthControl: { source: 'off', fadeSteps: 25 },
      };
      eng.beginStroke(NL.brush.engineStrokeParams(st, 'paint'));
      eng.drawStamps(stamps(rec(200, 150, 40, 0.5)), 1);
      const d = await read();
      // screen: 0.5 + 0.502 - 0.5*0.502 = 0.751 -> pixel 255*(1-0.751) = 64
      const v = px(d, 200, 150)[0];
      eng.cancelStroke();
      assert('texture mode screen: coverage brightens through pattern (64±8)',
        near(v, 64, 8), 'v=' + v);
    }

    // --- dual count jitter + flip at the dynamics level ---
    {
      const dual = { enabled: true, shape: 'round', hardness: 1, mode: 'multiply',
        size: 20, spacing: 0.5, scatter: 0, bothAxes: false, count: 4,
        countJitter: 1 };
      const ctx = { sample: { x: 0, y: 0, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 },
        direction: 0, initialDirection: 0, stepIndex: 0 };
      const out = [];
      const rng = NL.brush.patterns.seededRng(11);
      for (let i = 0; i < 6; i++) D.emitDualStamps(dual, ctx, 10, 10, rng, out);
      const count = out.length / D.STAMP_FLOATS;
      let flipped = 0;
      for (let i = 0; i < count; i++) if (out[i * D.STAMP_FLOATS + 9] > 0) flipped++;
      assert('dual dynamics: count jitter reduces count, implicit flips set flags',
        count >= 6 && count < 24 && flipped >= 1, 'count=' + count + ' flipped=' + flipped);
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

    // OKLCH (reference values from Ottosson / CSS Color 4)
    const okWhite = C.rgbToOklch({ r: 1, g: 1, b: 1 });
    assert('OKLCH: white is L=1, C=0',
      near(okWhite.l, 1, 1e-3) && near(okWhite.c, 0, 1e-4), JSON.stringify(okWhite));
    const okRed = C.rgbToOklch({ r: 1, g: 0, b: 0 });
    assert('OKLCH: sRGB red matches reference (0.628, 0.258, 29.2)',
      near(okRed.l, 0.628, 0.002) && near(okRed.c, 0.2577, 0.002) &&
      near(okRed.h, 29.23, 0.3),
      JSON.stringify(okRed));
    const okRt = C.oklchToRgb(okRed);
    assert('OKLCH: red round-trips',
      near(okRt.r, 1, 0.002) && near(okRt.g, 0, 0.004) && near(okRt.b, 0, 0.004),
      JSON.stringify(okRt));
    assert('OKLCH: gamut test rejects impossible chroma',
      C.oklchInGamut({ l: 0.6, c: 0.1, h: 30 }) === true &&
      C.oklchInGamut({ l: 0.6, c: 0.35, h: 30 }) === false, '');
    const maxC = C.oklchMaxChroma(okRed.l, okRed.h);
    assert('OKLCH: max chroma at reds L/H equals reds chroma',
      near(maxC, okRed.c, 0.003), 'maxC=' + maxC);
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

// ---- optional: validate the parser against real ABR files ----
//
// Third-party brush packs are not committed to this repo; set ABR_REAL_DIR
// to a directory containing them to run these checks. Expected values were
// recorded by analyzing the files listed in the fixture comment above
// (Nopressure spray brushes + igdiaysu/Photoshop brush packs on GitHub).
const realResults = [];
if (process.env.ABR_REAL_DIR) {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const EXPECT = [
    // file, version, brushes, tips, patterns, spot check
    ['Spray_Brush_1.abr', 6, 1, 1, 0,
      { name: 'Spray_Brush_1', size: 464, spacing: 0.1 }],
    ['Selected.abr', 6, 8, 5, 2,
      { name: 'text watercolor', texMode: 'subtract', texPattern: 'f7535389-d59a-11dd-b141-e1535ecf768b', smoothing: 0.69, dualMode: 'overlay' }],
    ['MB_Starter_Pack_2021v4.abr', 6, 17, 16, 4,
      { name: 'MB Lineart (Legendary)', dualSize: 63.2, dualScatter: 0.68, dualTip: '67468570-a4ff-11d5-adae-afb3da9c72e6', pressureSize: true }],
  ];
  for (const [file, ver, nBrushes, nTips, nPatterns, spot] of EXPECT) {
    const path = join(process.env.ABR_REAL_DIR, file);
    if (!existsSync(path)) {
      realResults.push(`SKIP real ABR ${file} (not present)`);
      continue;
    }
    const b64 = readFileSync(path).toString('base64');
    const out = await page.evaluate(([b64, spot]) => {
      const bin = atob(b64);
      const buf = new ArrayBuffer(bin.length);
      const u8 = new Uint8Array(buf);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const res = window.__northlight.brush.abr.parseAbr(buf);
      const b = res.brushes.find((x) => x.name === spot.name);
      return {
        version: res.version,
        brushes: res.brushes.length,
        tips: res.tips.size,
        patterns: res.patterns.size,
        found: !!b,
        size: b?.settings.tip?.size,
        spacing: b?.settings.tip?.spacing,
        smoothing: b?.settings.smoothing,
        pressureSize: b?.settings.pressureSize,
        texMode: b?.settings.texture?.mode,
        texPattern: b?.texturePatternId,
        dualMode: b?.settings.dual?.mode,
        dualSize: b?.settings.dual?.size,
        dualScatter: b?.settings.dual?.scatter,
        dualTip: b?.settings.dual?.shape,
      };
    }, [b64, spot]);
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    let ok = out.version === ver && out.brushes === nBrushes &&
      out.tips === nTips && out.patterns === nPatterns && out.found;
    for (const [k, v] of Object.entries(spot)) {
      if (k === 'name') continue;
      if (typeof v === 'number') ok = ok && near(out[k], v);
      else ok = ok && out[k] === v;
    }
    realResults.push(`${ok ? 'PASS' : 'FAIL'} real ABR ${file}${ok ? '' : ' — ' + JSON.stringify(out)}`);
  }
  console.log(realResults.join('\n'));
}

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

// ---- brush-cursor tip outlines ----
const outline = await page.evaluate(() => {
  const { tipOutline } = window.__northlight.brush;
  const loops = tipOutline('chalk');
  let inRange = true;
  let pts = 0;
  for (const loop of loops) {
    for (const p of loop) {
      pts++;
      if (p.x < -1.01 || p.x > 1.01 || p.y < -1.01 || p.y > 1.01) inRange = false;
    }
  }
  return {
    loops: loops.length,
    pts,
    inRange,
    cached: tipOutline('chalk') === loops,
    unknown: tipOutline('abr:missing:tip').length,
    spatter: tipOutline('spatter').length,
  };
});
kbAssert('tip outline: chalk traces at least one loop', outline.loops >= 1,
  JSON.stringify(outline));
kbAssert('tip outline: points normalized to the unit square', outline.inRange && outline.pts > 8,
  JSON.stringify(outline));
kbAssert('tip outline: result is cached per tip', outline.cached, JSON.stringify(outline));
// getTip falls back to the round map for unknown ids, so the mark — and
// therefore the traced cursor outline — is round rather than missing.
kbAssert('tip outline: unknown tip traces the round fallback mark', outline.unknown >= 1,
  JSON.stringify(outline));
kbAssert('tip outline: spatter keeps only meaningful islands', outline.spatter >= 1,
  JSON.stringify(outline));

// ---- bristle presets drive the store (engine toggle + shared size) ----
const bristleStore = await page.evaluate(() => {
  const s = window.__northlight.store;
  s.getState().applyBristlePreset('br-scumble');
  const afterBristle = {
    engine: s.getState().brushEngine,
    size: s.getState().brush.tip.size,
    opacity: s.getState().brush.opacity,
    active: s.getState().activePreset.brush,
    count: s.getState().bristle.bristleCount,
  };
  s.getState().applyPreset('hard-round', 'brush');
  const afterStamp = {
    engine: s.getState().brushEngine,
    active: s.getState().activePreset.brush,
  };
  s.getState().applyBristlePreset('missing-id');
  const afterMissing = { engine: s.getState().brushEngine };
  // restore defaults for later tests
  s.getState().applyPreset('soft-round', 'brush');
  s.getState().updateBrush({ opacity: 1, flow: 1 }, 'brush');
  return { afterBristle, afterStamp, afterMissing };
});
kbAssert('bristle preset: switches to the bristle engine and applies size/opacity',
  bristleStore.afterBristle.engine === 'bristle' &&
  bristleStore.afterBristle.size === 110 &&
  bristleStore.afterBristle.opacity === 0.5 &&
  bristleStore.afterBristle.active === 'br-scumble' &&
  bristleStore.afterBristle.count === 160,
  JSON.stringify(bristleStore.afterBristle));
kbAssert('bristle preset: picking a stamp preset returns to the stamp engine',
  bristleStore.afterStamp.engine === 'stamp' &&
  bristleStore.afterStamp.active === 'hard-round',
  JSON.stringify(bristleStore.afterStamp));
kbAssert('bristle preset: unknown id is a no-op',
  bristleStore.afterMissing.engine === 'stamp',
  JSON.stringify(bristleStore.afterMissing));

// ---- temporary tool overrides (Space / Alt / Ctrl), like Photoshop ----
await page.evaluate(() => {
  window.__northlight.store.getState().setTool('brush');
});
const toolState = () => page.evaluate(() => {
  const s = window.__northlight.store.getState();
  return { tool: s.tool, override: s.overrideTool };
});

await page.keyboard.down('Space');
kbAssert('Space overrides to the hand tool',
  (await toolState()).override === 'pan', JSON.stringify(await toolState()));
await page.keyboard.down('Alt');
kbAssert('Space+Alt overrides to the zoom tool',
  (await toolState()).override === 'zoom', JSON.stringify(await toolState()));
await page.keyboard.up('Alt');
kbAssert('releasing Alt returns to the hand tool',
  (await toolState()).override === 'pan', JSON.stringify(await toolState()));
await page.keyboard.down('Alt');
await page.keyboard.up('Space');
kbAssert('releasing Space (Alt still held, brush) leaves the eyedropper',
  (await toolState()).override === 'eyedropper', JSON.stringify(await toolState()));
await page.keyboard.up('Alt');
{
  const st = await toolState();
  kbAssert('releasing all modifiers restores the brush',
    st.tool === 'brush' && st.override === null, JSON.stringify(st));
}

await page.keyboard.down('Control');
kbAssert('Ctrl with the brush overrides to move',
  (await toolState()).override === 'move', JSON.stringify(await toolState()));
await page.keyboard.up('Control');

await page.keyboard.down('Space');
await page.keyboard.press('e');
{
  const st = await toolState();
  kbAssert('tool shortcut while Space is held retargets the base tool',
    st.tool === 'eraser' && st.override === 'pan', JSON.stringify(st));
}
await page.keyboard.up('Space');
await page.evaluate(() => window.__northlight.store.getState().setTool('brush'));

// ---- View shortcuts: zoom stops and Extras ----
await page.evaluate(() => {
  window.__northlight.store.getState().setView({ zoom: 1, panX: 0, panY: 0 });
});
const zoomLevel = () => page.evaluate(() => window.__northlight.store.getState().view.zoom);
await page.keyboard.press('Control+=');
kbAssert('Ctrl+= zooms in to the next stop (200%)',
  (await zoomLevel()) === 2, String(await zoomLevel()));
await page.keyboard.press('Control+-');
await page.keyboard.press('Control+-');
kbAssert('Ctrl+- steps back out through the stops (66.67%)',
  (await zoomLevel()) === 2 / 3, String(await zoomLevel()));
await page.keyboard.press('Control+1');
kbAssert('Ctrl+1 returns to 100%', (await zoomLevel()) === 1, String(await zoomLevel()));

const extras = () => page.evaluate(() => window.__northlight.store.getState().showExtras);
kbAssert('Extras starts visible', await extras());
await page.keyboard.press('Control+h');
kbAssert('Ctrl+H hides Extras', !(await extras()));
await page.keyboard.press('Control+h');
kbAssert('Ctrl+H shows Extras again', await extras());

// ---- Edit > Copy / Paste (internal clipboard) ----
const clip = await page.evaluate(async () => {
  const NL = window.__northlight;
  // The on-screen engine can lose its device in headless SwiftShader, so
  // point the controller at a fresh offscreen engine for the clipboard flow.
  const doc = NL.store.getState().doc;
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 200;
  const eng = await NL.PaintEngine.create(canvas, doc.width, doc.height);
  NL.setEngine(eng);
  const before = NL.store.getState().layers.length;
  NL.edit.selectAll();
  const copied = await NL.edit.copySelection(false);
  NL.edit.paste(false);
  const s = NL.store.getState();
  return {
    copied,
    before,
    after: s.layers.length,
    hasClipboard: s.hasClipboard,
    deselected: s.selectionPaths === null,
  };
});
kbAssert('Copy captures the selection and Paste adds a layer',
  clip.copied && clip.after === clip.before + 1 && clip.hasClipboard && clip.deselected,
  JSON.stringify(clip));

// ---- layer system: groups, locks, merges (uses the offscreen engine) ----
const layerRes = await page.evaluate(async () => {
  const NL = window.__northlight;
  const store = NL.store;
  const ops = NL.layerOps;
  const util = NL.layersUtil;
  const eng = NL.engine();
  const s = () => store.getState();
  const out = {};

  // start from a clean two-layer stack: white background + red layer
  for (const l of s().layers.filter((x) => x.id !== 'background')) {
    ops.deleteLayer(l.id);
  }
  s().setActiveLayer('background');
  ops.addLayer();
  const layerA = s().activeLayerId;
  eng.fillRegion(layerA, [1, 0, 0]); // opaque red
  out.addedAboveBackground =
    s().layers.length === 2 && s().layers[1].id === layerA;

  // Ctrl+G: wrap the active layer in a group
  ops.groupActiveLayer();
  const groupId = s().activeLayerId;
  out.grouped =
    s().layers.find((l) => l.id === groupId)?.kind === 'group' &&
    s().layers.find((l) => l.id === layerA)?.parentId === groupId;

  // group opacity and visibility fold into the composited layers
  s().patchLayer(groupId, { opacity: 0.5 });
  let resolved = util.resolveRenderLayers(s().layers);
  out.opacityFolds =
    Math.abs(resolved.find((l) => l.id === layerA).opacity - 0.5) < 1e-6;
  s().patchLayer(groupId, { visible: false });
  resolved = util.resolveRenderLayers(s().layers);
  out.visibilityFolds =
    resolved.find((l) => l.id === layerA).visible === false &&
    s().layers.find((l) => l.id === layerA).visible === true;
  s().patchLayer(groupId, { visible: true, opacity: 1 });

  // locking the group locks its children too
  ops.toggleActiveLayerLock('all'); // active is still the group
  out.groupLockInherited = util.effectiveLocks(s().layers, layerA).all === true;
  ops.toggleActiveLayerLock('all');

  // Shift+Ctrl+G: dissolve the group
  ops.ungroupActiveLayer();
  out.ungrouped =
    !s().layers.some((l) => l.id === groupId) &&
    s().layers.find((l) => l.id === layerA)?.parentId === null &&
    s().activeLayerId === layerA;

  // Lock Transparent Pixels: fills cannot conjure alpha on a locked layer
  ops.addLayer();
  const layerB = s().activeLayerId; // fully transparent
  eng.fillRegion(layerB, [0, 0, 0], true); // preserveTransparency
  const lockedFill = await eng.sampleColor(10, 10, 1, { layerId: layerB });
  out.lockKeepsTransparency = lockedFill === null;
  eng.fillRegion(layerB, [0, 1, 0], false);
  const freeFill = await eng.sampleColor(10, 10, 1, { layerId: layerB });
  out.unlockedFillWorks = !!freeFill && freeFill.g > 0.9 && freeFill.a > 0.9;

  // Ctrl+E: merge down (green B into red A)
  const before = s().layers.length;
  ops.mergeDown();
  const aColor = await eng.sampleColor(10, 10, 1, { layerId: layerA });
  out.mergeDown =
    s().layers.length === before - 1 &&
    !s().layers.some((l) => l.id === layerB) &&
    !!aColor && aColor.g > 0.9;

  // Shift+Ctrl+E: merge visible into the bottom-most visible layer;
  // hidden layers survive untouched
  ops.addLayer();
  const hidden = s().activeLayerId;
  s().patchLayer(hidden, { visible: false });
  s().setActiveLayer(layerA);
  await ops.mergeVisible();
  const bg = await eng.sampleColor(10, 10, 1, { layerId: 'background' });
  out.mergeVisible =
    s().layers.some((l) => l.id === hidden) &&
    !s().layers.some((l) => l.id === layerA) &&
    s().layers.filter((l) => l.kind === 'layer').length === 2 &&
    !!bg && bg.g > 0.9 && bg.r < 0.1;

  // Flatten Image: one opaque Background remains, hidden layers dropped
  await ops.flattenImage();
  out.flattened =
    s().layers.length === 1 &&
    s().layers[0].id === 'background' &&
    s().layers[0].kind === 'layer';

  // Ctrl+J without a selection duplicates the layer
  await ops.layerViaCopy(false);
  out.viaCopy = s().layers.length === 2;
  ops.deleteLayer(s().activeLayerId);

  return out;
});
for (const [name, ok] of Object.entries(layerRes)) {
  kbAssert(`layer system: ${name}`, ok === true, JSON.stringify(layerRes));
}

// ---- layer tree structure: rows, drag-drop moves, arrange, groups ----
const structRes = await page.evaluate(async () => {
  const NL = window.__northlight;
  const store = NL.store;
  const ops = NL.layerOps;
  const util = NL.layersUtil;
  const eng = NL.engine();
  const s = () => store.getState();
  const out = {};
  const order = () => s().layers.map((l) => l.id).join();

  // clean slate: background only, then background, A, B, group G(C)
  for (const l of s().layers.filter((x) => x.id !== 'background')) {
    ops.deleteLayer(l.id);
  }
  s().setActiveLayer('background');
  ops.addLayer(); const A = s().activeLayerId;
  ops.addLayer(); const B = s().activeLayerId;
  ops.addLayer(); const C = s().activeLayerId;
  ops.groupActiveLayer(); const G = s().activeLayerId;
  out.initialOrder = order() === ['background', A, B, C, G].join();

  // panel rows are top-first, the group header before its children
  let rows = util.displayRows(s().layers).map((r) => r.meta.id).join();
  out.rowsTopFirst = rows === [G, C, B, A, 'background'].join();

  // collapsing a group hides its children from the rows
  s().patchLayer(G, { collapsed: true });
  rows = util.displayRows(s().layers).map((r) => r.meta.id).join();
  out.collapseHides = rows === [G, B, A, 'background'].join();
  s().patchLayer(G, { collapsed: false });

  // drag-drop: dropping A into G makes it the group's topmost child
  let moved = util.moveSubtree(s().layers, A, G, 'into');
  out.moveInto =
    moved !== null &&
    moved.find((l) => l.id === A).parentId === G &&
    moved.map((l) => l.id).join() === ['background', B, C, A, G].join();

  // dropping a group into its own descendant is rejected
  out.moveIllegal = util.moveSubtree(s().layers, G, C, 'into') === null;

  // dropping B below the background lands it at the bottom of the stack
  moved = util.moveSubtree(s().layers, B, 'background', 'below');
  out.moveBelow = moved !== null && moved[0].id === B;

  // arrange walks the whole subtree among its siblings
  s().setActiveLayer(G);
  ops.arrangeActiveLayer('back');
  out.arrangeBack = order() === [C, G, 'background', A, B].join();
  ops.arrangeActiveLayer('forward');
  out.arrangeForward = order() === ['background', C, G, A, B].join();
  ops.arrangeActiveLayer('front');
  out.arrangeFront = order() === ['background', A, B, C, G].join();

  // nested group opacity multiplies down to the pixel layers
  s().setActiveLayer(G);
  ops.groupActiveLayer();
  const G2 = s().activeLayerId;
  s().patchLayer(G, { opacity: 0.5 });
  s().patchLayer(G2, { opacity: 0.5 });
  const resolved = util.resolveRenderLayers(s().layers);
  out.nestedOpacity =
    Math.abs(resolved.find((l) => l.id === C).opacity - 0.25) < 1e-6;
  s().setActiveLayer(G2);
  ops.ungroupActiveLayer();
  s().patchLayer(G, { opacity: 1 });

  // a new layer created with a group active goes inside the group
  ops.addGroup();
  const NG = s().activeLayerId;
  ops.addLayer();
  const inner = s().activeLayerId;
  out.newLayerIntoGroup = s().layers.find((l) => l.id === inner).parentId === NG;
  ops.deleteLayer(NG); // takes `inner` with it
  out.groupDeleteTakesChildren = !s().layers.some((l) => l.id === inner);

  // duplicating a group duplicates its children under fresh ids
  s().setActiveLayer(G);
  const before = s().layers.length;
  ops.duplicateActiveLayer();
  const dupG = s().activeLayerId;
  const dupKids = s().layers.filter((l) => l.parentId === dupG);
  out.duplicateGroup =
    s().layers.length === before + 2 &&
    dupG !== G &&
    dupKids.length === 1 &&
    dupKids[0].id !== C;
  ops.deleteLayer(dupG);

  // hidden layers delete in one sweep
  ops.addLayer();
  const H = s().activeLayerId;
  s().patchLayer(H, { visible: false });
  ops.deleteHiddenLayers();
  out.deleteHidden = !s().layers.some((l) => l.id === H);

  // merge group bakes to a single layer with the group's name and slot
  const gName = s().layers.find((l) => l.id === G).name;
  eng.fillRegion(C, [1, 0, 0]);
  s().setActiveLayer(G);
  await ops.mergeGroup();
  const mergedId = s().activeLayerId;
  const merged = s().layers.find((l) => l.id === mergedId);
  const mergedColor = await eng.sampleColor(10, 10, 1, { layerId: mergedId });
  out.mergeGroup =
    !!merged &&
    merged.kind === 'layer' &&
    merged.name === gName &&
    merged.parentId === null &&
    !s().layers.some((l) => l.id === G || l.id === C) &&
    !!mergedColor && mergedColor.r > 0.9 && mergedColor.g < 0.1;

  // "Layer 7" numbering continues one past the highest
  out.nextName = util.nextName([{ name: 'Layer 7' }], 'Layer') === 'Layer 8';

  return out;
});
for (const [name, ok] of Object.entries(structRes)) {
  kbAssert(`layer tree: ${name}`, ok === true, JSON.stringify(structRes));
}

// ---- transform interaction math (pure) ----
const tmRes = await page.evaluate(() => {
  const TM = window.__northlight.transformMath;
  const out = {};
  const rect = { x: 0, y: 0, w: 100, h: 50 };
  const tr = {
    target: 'layer', mode: 'free', layerId: 'x', rect,
    quad: TM.rectCorners(rect), duplicate: false, showHandles: true, engaged: true,
  };

  // Shift-move constrains to the dominant axis and rounds to whole pixels
  let drag = TM.makeTransformDrag(tr, 'move', 0, { x: 0, y: 0 });
  let q = TM.computeTransformQuad(drag, rect, { x: 40, y: 3 }, true, false);
  out.moveConstrained = q[0].x === 40 && q[0].y === 0;

  // Shift corner-scale is uniform (dominant factor wins)
  drag = TM.makeTransformDrag(tr, 'scale', 2, { x: 100, y: 50 }); // BR corner
  q = TM.computeTransformQuad(drag, rect, { x: 200, y: 60 }, true, false);
  out.scaleUniform =
    Math.abs(q[2].x - 200) < 1e-6 && Math.abs(q[2].y - 100) < 1e-6;

  // Alt scales about the rect center
  drag = TM.makeTransformDrag(tr, 'scale', 2, { x: 100, y: 50 });
  q = TM.computeTransformQuad(drag, rect, { x: 150, y: 75 }, false, true);
  out.scaleAboutCenter =
    Math.abs(q[0].x + 50) < 1e-6 && Math.abs(q[0].y + 25) < 1e-6;

  // Shift-rotate snaps to 15-degree increments (50deg drag -> 45deg)
  drag = TM.makeTransformDrag(tr, 'rotate', 0, { x: 100, y: 25 });
  const c = { x: 50, y: 25 };
  const ang = (50 * Math.PI) / 180;
  q = TM.computeTransformQuad(
    drag, rect,
    { x: c.x + Math.cos(ang) * 60, y: c.y + Math.sin(ang) * 60 },
    true, false,
  );
  const rot = (pt, th) => ({
    x: c.x + (pt.x - c.x) * Math.cos(th) - (pt.y - c.y) * Math.sin(th),
    y: c.y + (pt.x - c.x) * Math.sin(th) + (pt.y - c.y) * Math.cos(th),
  });
  const want = rot({ x: 100, y: 0 }, Math.PI / 4);
  out.rotateSnaps = Math.hypot(q[1].x - want.x, q[1].y - want.y) < 1e-6;

  // hit testing resolves corners vs inside through the screen mapping
  const space = { docToScreen: (pt) => pt, tolerance: 8, rotateBand: 22 };
  const h = TM.transformHandleAt(tr, { x: 99, y: 49 }, false, space);
  out.handleCorner = h.zone === 'corner' && h.op === 'scale' && h.index === 2;
  out.handleInside =
    TM.transformHandleAt(tr, { x: 50, y: 25 }, false, space).zone === 'inside';
  // Ctrl turns the corner into a distort handle in free mode
  out.handleCtrlDistort =
    TM.transformHandleAt(tr, { x: 99, y: 49 }, true, space).op === 'distort';

  return out;
});
for (const [name, ok] of Object.entries(tmRes)) {
  kbAssert(`transform math: ${name}`, ok === true, JSON.stringify(tmRes));
}

console.log(kb.join('\n'));

const all = [...res, ...realResults, ...kb];
const fails = all.filter((r) => r.startsWith('FAIL') || r.startsWith('DEVICE-LOST'));
console.log(fails.length === 0 ? '\nALL TESTS PASSED' : `\n${fails.length} FAILURES`);
await browser.close();
process.exit(fails.length === 0 ? 0 : 1);
