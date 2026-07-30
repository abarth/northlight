/**
 * The in-page half of `tools/sheets.mjs`: builds every sample sheet against
 * the live PaintEngine and returns them as base64 PNGs. Kept as a string so
 * it can be handed to `page.evaluate` without a bundler step.
 */
export const SHEET_SCRIPT = /* js */ `async (only) => {
const NL = window.__northlight;
const { hsvToRgb } = NL.color;
const { engineStrokeParams } = NL.brush;
const { seededRng, getTip } = NL.brush.patterns;
const { BRISTLE_SHAPES, bristleTipId } = NL.brush.bristle;
const { makeBrush, pressureControl } = NL.brush.defaults;

const GROUPS = NL.brush.presets.allGroups();
const ALLA = GROUPS.find((g) => g.id === 'alla-prima').presets;
const byId = (id) => ALLA.find((p) => p.id === id).settings;

// ---------------------------------------------------------------------------
// document + stroke plumbing
// ---------------------------------------------------------------------------

const META = { id: 'bg', name: 'bg', visible: true, opacity: 1, blendMode: 'normal' };
const VIEW = { zoom: 1, panX: 0, panY: 0 };

async function makeDoc(w, h, ground) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const eng = await NL.PaintEngine.create(canvas, w, h);
  eng.ensureLayer('bg');
  const c = hsvToRgb(ground);
  eng.fillLayer('bg', [c.r, c.g, c.b, 1]);
  return { eng, w, h, state: { layers: [META], activeLayerId: 'bg', view: VIEW } };
}

let seedCounter = 1;

/** Runs one stroke of \`settings\` along \`path\` in colour \`fg\`. */
function stroke(doc, settings, path, fg, opts = {}) {
  if (path.length < 2) return;
  const s = opts.patch ? NL.brush.defaults.mergeBrush(settings, opts.patch) : settings;
  doc.eng.beginStroke(engineStrokeParams(s, 'paint'));
  const sess = new NL.StrokeSession(doc.eng, s, {
    fg,
    bg: opts.bg ?? { h: fg.h, s: Math.max(0, fg.s - 0.15), v: Math.min(1, fg.v + 0.12) },
    rng: seededRng(opts.seed ?? seedCounter++),
  });
  sess.down(path[0]);
  for (let i = 1; i < path.length; i++) sess.move([path[i]]);
  sess.up();
  doc.eng.endStroke('bg');
}

const S = (x, y, pressure, extra) => ({
  x,
  y,
  pressure,
  tiltX: extra && extra.tiltX || 0,
  tiltY: extra && extra.tiltY || 0,
  twist: extra && extra.twist || 0,
});

/** Samples a parametric path; \`fn(t)\` returns [x, y] and \`pr(t)\` pressure. */
function sample(n, fn, pr, extra) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const [x, y] = fn(t);
    out.push(S(x, y, pr(t), typeof extra === 'function' ? extra(t) : extra));
  }
  return out;
}

const line = (x0, y0, x1, y1) => (t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
const arc = (cx, cy, r, a0, a1) => (t) => {
  const a = a0 + (a1 - a0) * t;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
};
const bez = (p0, p1, p2, p3) => (t) => {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [
    w[0] * p0[0] + w[1] * p1[0] + w[2] * p2[0] + w[3] * p3[0],
    w[0] * p0[1] + w[1] * p1[1] + w[2] * p2[1] + w[3] * p3[1],
  ];
};

const flat = (p) => () => p;
const swell = (lo, hi) => (t) => lo + (hi - lo) * Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
const attack = (hi, lo) => (t) => hi + (lo - hi) * Math.pow(t, 0.7);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// readback -> labelled PNG
// ---------------------------------------------------------------------------

async function toPng(doc, decorate) {
  const data = await doc.eng.readComposite(doc.state);
  const out = document.createElement('canvas');
  out.width = doc.w;
  out.height = doc.h;
  const ctx = out.getContext('2d');
  const img = new ImageData(new Uint8ClampedArray(data), doc.w, doc.h);
  ctx.putImageData(img, 0, 0);
  if (decorate) decorate(ctx);
  return out.toDataURL('image/png').split(',')[1];
}

function label(ctx, text, x, y, opts = {}) {
  ctx.save();
  ctx.font = (opts.font ?? '600 15px system-ui, sans-serif');
  ctx.fillStyle = opts.color ?? '#1b1b1b';
  ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// sheet: mark vocabulary, one row per preset
// ---------------------------------------------------------------------------

const GROUND = { h: 38, s: 0.1, v: 0.9 };

/**
 * Six marks that between them show what a brush can do: a level drag, a
 * pressure swell, a sweep that turns 90 degrees under a fixed blade, a comma
 * that lifts, a dry pass over paint that is already down, and three separate
 * touches at rising pressure.
 */
function markRow(doc, settings, ox, oy, cw, ch, ink) {
  const mid = oy + ch / 2;
  // inset by the widest mark this brush can make, so nothing bleeds into the
  // neighbouring cell or row
  const pad = Math.max(26, settings.tip.size * 0.62);
  const cell = (i) => ox + i * cw;

  stroke(doc, settings, sample(60, line(cell(0) + pad, mid, cell(0) + cw - pad, mid), flat(0.85)), ink);

  stroke(doc, settings, sample(60, line(cell(1) + pad, mid, cell(1) + cw - pad, mid), swell(0.08, 1)), ink);

  const r = Math.min(cw, ch) / 2 - pad * 0.7;
  stroke(
    doc,
    settings,
    sample(70, arc(cell(2) + cw / 2 - r / 2, mid + r / 2, r, -90 * DEG, 0), flat(0.8)),
    ink,
  );

  stroke(
    doc,
    settings,
    sample(
      60,
      bez(
        [cell(3) + pad, oy + pad],
        [cell(3) + cw * 0.8, oy + ch * 0.32],
        [cell(3) + cw * 0.24, oy + ch * 0.7],
        [cell(3) + cw - pad, oy + ch - pad],
      ),
      attack(1, 0.06),
    ),
    ink,
  );

  // dry pass: block in the left half with a knife, then drag a light tone
  // straight across the boundary so both halves of the mark are visible
  const under = { h: 24, s: 0.5, v: 0.3 };
  const slab = byId('ap-knife');
  // blade across the drag (angle -90) so the knife lays a band, not a hairline
  for (let i = -2; i <= 2; i++) {
    stroke(
      doc,
      slab,
      sample(24, line(cell(4) + pad * 0.6, mid + i * 20, cell(4) + cw * 0.52, mid + i * 20), flat(1)),
      under,
      { seed: 700 + i, patch: { tip: { ...slab.tip, size: 52, angle: -90 } } },
    );
  }
  stroke(
    doc,
    settings,
    sample(60, line(cell(4) + pad * 0.5, mid + 4, cell(4) + cw - pad * 0.5, mid - 4), flat(0.6)),
    { h: 44, s: 0.12, v: 0.98 },
  );

  [0.3, 0.62, 1].forEach((p, i) => {
    const x = cell(5) + pad + i * ((cw - 1.4 * pad) / 3);
    const d = Math.min(40, ch / 2 - pad * 0.6);
    stroke(doc, settings, sample(16, line(x, mid - d, x + d * 0.8, mid + d), flat(p)), ink, {
      seed: 900 + i,
    });
  });
}

async function marksSheet(name, presets) {
  const GUT = 210;
  const CW = 300;
  const CH = 214;
  const W = GUT + 6 * CW + 16;
  const H = 34 + presets.length * CH;
  const doc = await makeDoc(W, H, GROUND);
  const ink = { h: 22, s: 0.62, v: 0.36 };
  presets.forEach((p, i) => {
    markRow(doc, p.settings, GUT, 34 + i * CH, CW, CH, ink);
  });
  return {
    name,
    width: W,
    height: H,
    png: await toPng(doc, (ctx) => {
      ['drag', 'pressure swell', 'sweep through 90°', 'comma, lifting', 'dry pass over paint', 'separate touches'].forEach(
        (t, i) => label(ctx, t, GUT + i * CW + 18, 10, { font: '500 13px system-ui', color: '#666' }),
      );
      presets.forEach((p, i) => {
        label(ctx, p.name, 14, 34 + i * CH + 12);
        const q = NL.brush.bristle.parseBristleTip(p.settings.tip.shape);
        const desc = q
          ? q.shape + '  b' + Math.round(q.bristles * 100) + ' l' + Math.round(q.length * 100) +
            ' t' + Math.round(q.thickness * 100) + ' s' + Math.round(q.stiffness * 100)
          : p.settings.tip.shape;
        label(ctx, desc, 14, 34 + i * CH + 32, { font: '400 11px ui-monospace, monospace', color: '#777' });
        label(
          ctx,
          'size ' + p.settings.tip.size + '  sp ' + Math.round(p.settings.tip.spacing * 100) +
            '%  ang ' + p.settings.tip.angle + '°',
          14,
          34 + i * CH + 48,
          { font: '400 11px ui-monospace, monospace', color: '#777' },
        );
      });
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      presets.forEach((_, i) => {
        ctx.beginPath();
        ctx.moveTo(0, 34 + i * CH);
        ctx.lineTo(W, 34 + i * CH);
        ctx.stroke();
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// sheet: 1:1 detail of single long strokes
// ---------------------------------------------------------------------------

async function detailSheet() {
  const ids = ['ap-flat-chisel', 'ap-filbert', 'ap-bright', 'ap-dry-drag', 'ap-impasto', 'ap-knife'];
  const RH = 132;
  const W = 900;
  const doc = await makeDoc(W, ids.length * RH, GROUND);
  ids.forEach((id, i) => {
    const y = i * RH + RH / 2;
    stroke(doc, byId(id), sample(120, line(150, y, W - 30, y - 8), swell(0.35, 1)), {
      h: 20,
      s: 0.6,
      v: 0.34,
    }, { seed: 40 + i });
  });
  return {
    name: 'marks-detail',
    width: W,
    height: ids.length * RH,
    png: await toPng(doc, (ctx) => {
      ids.forEach((id, i) => {
        label(ctx, ALLA.find((p) => p.id === id).name, 12, i * RH + 12);
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// sheet: the bristle tip generator itself
// ---------------------------------------------------------------------------

async function tipsSheet() {
  const RH = 128;
  const TILE = 104;
  const W = 1080;
  const H = BRISTLE_SHAPES.length * RH;
  const doc = await makeDoc(W, H, GROUND);
  const base = makeBrush({
    tip: { size: 62, spacing: 0.4, angle: -90 },
    shape: {
      enabled: true,
      angleControl: { source: 'direction', fadeSteps: 25 },
      sizeControl: pressureControl(),
      minDiameter: 0.7,
    },
    transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.5 },
    smoothing: 0.2,
  });
  const tiles = [];
  BRISTLE_SHAPES.forEach((sh, i) => {
    const id = bristleTipId({ shape: sh.id, bristles: 0.4, length: 0.55, thickness: 0.5, stiffness: 0.8 });
    tiles.push(getTip(id));
    const y = i * RH + RH / 2;
    stroke(doc, NL.brush.defaults.mergeBrush(base, { tip: { ...base.tip, shape: id } }),
      sample(110, line(330, y, W - 24, y - 6), swell(0.3, 1)), { h: 20, s: 0.6, v: 0.34 },
      { seed: 200 + i });
  });
  return {
    name: 'tips',
    width: W,
    height: H,
    png: await toPng(doc, (ctx) => {
      BRISTLE_SHAPES.forEach((sh, i) => {
        label(ctx, sh.label, 12, i * RH + RH / 2 - 8);
        // the raw alpha map, so the generator can be read directly
        const map = tiles[i];
        const t = document.createElement('canvas');
        t.width = map.size;
        t.height = map.size;
        const img = new ImageData(map.size, map.size);
        for (let k = 0; k < map.data.length; k++) {
          img.data[k * 4 + 3] = map.data[k];
        }
        t.getContext('2d').putImageData(img, 0, 0);
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.strokeRect(190, i * RH + (RH - TILE) / 2, TILE, TILE);
        ctx.drawImage(t, 190, i * RH + (RH - TILE) / 2, TILE, TILE);
        ctx.restore();
      });
    }),
  };
}

// ---------------------------------------------------------------------------
// sheet: pen response
// ---------------------------------------------------------------------------

async function responseSheet() {
  const W = 1180;
  const RH = 170;
  const rows = 4;
  // the direction row needs two sub-rows of strokes
  const doc = await makeDoc(W, 24 + rows * RH + 60, GROUND);
  const ink = { h: 20, s: 0.6, v: 0.34 };
  const chisel = byId('ap-flat-chisel');
  const tilted = byId('ap-round-tilt');
  const posed = byId('ap-flat-posed');

  // pressure
  [0.1, 0.25, 0.45, 0.65, 0.85, 1].forEach((p, i) => {
    const x = 150 + i * 168;
    stroke(doc, chisel, sample(30, line(x, 24 + 30, x, 24 + RH - 30), flat(p)), ink, { seed: 10 + i });
  });
  // tilt, with Brush Projection on
  [0, 15, 30, 45, 60, 78].forEach((tilt, i) => {
    const x = 150 + i * 168;
    stroke(
      doc,
      tilted,
      sample(30, line(x, 24 + RH + 30, x, 24 + 2 * RH - 30), flat(0.9), { tiltX: tilt, tiltY: 0 }),
      ink,
      { seed: 20 + i },
    );
  });
  // barrel rotation at a fixed tilt
  [0, 60, 120, 180, 240, 300].forEach((tw, i) => {
    const x = 150 + i * 168;
    stroke(
      doc,
      tilted,
      sample(30, line(x, 24 + 2 * RH + 30, x, 24 + 3 * RH - 30), flat(0.9), {
        tiltX: 55,
        tiltY: 0,
        twist: tw,
      }),
      ink,
      { seed: 30 + i },
    );
  });
  // direction sweep: a fixed blade turns broad-to-thin on its own
  // Radiating strokes, spaced far enough apart to read separately: a blade
  // held at one attitude draws broad across itself and hairline along itself,
  // which is the whole reason a painter fixes the attitude.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const gx = 150 + (i % 6) * 168;
    const gy = 24 + 3 * RH + (i < 6 ? RH * 0.3 : RH * 0.75);
    stroke(
      doc,
      posed,
      sample(20, line(gx - Math.cos(a) * 52, gy - Math.sin(a) * 34, gx + Math.cos(a) * 52, gy + Math.sin(a) * 34), flat(0.9)),
      ink,
      { seed: 50 + i },
    );
  }
  return {
    name: 'response',
    width: W,
    height: 24 + rows * RH + 60,
    png: await toPng(doc, (ctx) => {
      label(ctx, 'pressure 10→100%', 10, 24 + 10);
      label(ctx, 'Flat Bristle Chisel', 10, 24 + 30, { font: '400 11px ui-monospace', color: '#777' });
      label(ctx, 'tilt 0→78°', 10, 24 + RH + 10);
      label(ctx, 'Brush Projection', 10, 24 + RH + 30, { font: '400 11px ui-monospace', color: '#777' });
      label(ctx, 'barrel 0→300°', 10, 24 + 2 * RH + 10);
      label(ctx, 'tilt held at 55°', 10, 24 + 2 * RH + 30, { font: '400 11px ui-monospace', color: '#777' });
      label(ctx, 'direction 0→360°', 10, 24 + 3 * RH + 10);
      label(ctx, 'Fixed Pose, one attitude', 10, 24 + 3 * RH + 30, { font: '400 11px ui-monospace', color: '#777' });
    }),
  };
}

// ---------------------------------------------------------------------------
// sheet: studies — do the marks add up to a painting?
// ---------------------------------------------------------------------------

/**
 * A sphere on a toned ground, blocked in the way it would be in oils: the
 * ground laid in with broad passes, then the form built from concentric shells
 * of separate strokes whose colour comes from a Lambert model with a cool
 * bounce off the table. Nothing here is a gradient — every value on the ball is
 * a brushstroke — which is what makes it a fair test of whether these marks add
 * up to a painting.
 */
async function sphereStudy() {
  const W = 1120;
  const H = 820;
  const doc = await makeDoc(W, H, { h: 36, s: 0.16, v: 0.66 });
  const cx = 470;
  const cy = 372;
  const R = 218;

  const chisel = byId('ap-flat-chisel');
  const filbert = byId('ap-filbert');
  const bright = byId('ap-bright');
  const dry = byId('ap-dry-drag');
  const scumble = byId('ap-scumbler');
  const blender = byId('ap-fan-blender');
  const accent = byId('ap-round-accent');
  const impasto = byId('ap-impasto');

  // light from the upper left, slightly toward the viewer
  const LN = (v) => {
    const m = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / m, v[1] / m, v[2] / m];
  };
  const LIGHT = LN([-0.5, -0.62, 0.6]);
  const BOUNCE = LN([0.15, 0.95, 0.28]);

  // Three notes mixed in RGB, not in hue degrees — interpolating hue
  // numerically walks the wrong way round the wheel and turns a warm shadow
  // magenta.
  const SHADOW = hsvToRgb({ h: 19, s: 0.5, v: 0.27 });
  const LIT = hsvToRgb({ h: 44, s: 0.29, v: 0.95 });
  const COOL = hsvToRgb({ h: 206, s: 0.3, v: 0.48 });
  const mixRgb = (a, b, t) => ({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });

  /** Local colour of the ball at disc polar coords (fraction of R, radians). */
  const shade = (rf, th) => {
    const z = Math.sqrt(Math.max(0, 1 - rf * rf));
    const n = [rf * Math.cos(th), rf * Math.sin(th), z];
    const d = Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    const b = Math.max(0, n[0] * BOUNCE[0] + n[1] * BOUNCE[1] + n[2] * BOUNCE[2]);
    const lit = Math.pow(d, 0.85);
    const base = mixRgb(SHADOW, LIT, lit);
    return NL.color.rgbToHsv(mixRgb(base, COOL, 0.45 * b * (1 - lit)), 30);
  };

  // ground: broad overlapping passes at a slight slant, so the field is paint
  // rather than a fill
  for (let i = 0; i < 17; i++) {
    const y = -30 + i * 54;
    const t = (i % 5) / 4;
    stroke(doc, chisel, sample(46, line(-70, y + (i % 2) * 8, W + 70, y + 22 - (i % 3) * 12), flat(0.95)),
      { h: 30 + t * 12, s: 0.14 + t * 0.09, v: 0.58 + ((i * 7) % 5) * 0.035 },
      { seed: 1000 + i, patch: { tip: { ...chisel.tip, size: 100 } } });
  }
  // cross it on the diagonal so it is not all one grain, and drop in separate
  // slabs the way a painter breaks up a large flat area
  for (let i = 0; i < 9; i++) {
    stroke(doc, chisel, sample(40, line(-80 + i * 150, -50, -280 + i * 150, H + 50), flat(0.9)),
      { h: 28 + (i % 4) * 6, s: 0.15 + (i % 3) * 0.05, v: 0.6 + ((i * 3) % 4) * 0.04 },
      { seed: 1040 + i, patch: { tip: { ...chisel.tip, size: 78 } } });
  }
  for (let i = 0; i < 12; i++) {
    const gx = 60 + (i % 4) * 320 + (i % 3) * 40;
    const gy = 40 + Math.floor(i / 4) * 170 + (i % 2) * 50;
    stroke(doc, byId('ap-knife'), sample(18, line(gx, gy, gx + 130, gy + 22), flat(0.95)),
      { h: 30 + (i % 3) * 10, s: 0.13 + (i % 2) * 0.07, v: 0.55 + (i % 5) * 0.045 },
      { seed: 1060 + i, patch: { tip: { ...byId('ap-knife').tip, size: 96, angle: -70 } } });
  }
  // table plane: cooler and darker below the horizon
  for (let i = 0; i < 8; i++) {
    const y = 536 + i * 46;
    stroke(doc, chisel, sample(46, line(-70, y, W + 70, y - 14), flat(0.95)),
      { h: 26 + (i % 3) * 7, s: 0.24 + (i % 2) * 0.05, v: 0.46 - i * 0.026 },
      { seed: 1100 + i, patch: { tip: { ...chisel.tip, size: 92 } } });
  }

  // cast shadow: solid where it meets the ball, dragged out where it runs away
  for (let i = 0; i < 7; i++) {
    const p = sample(44, line(cx + 30, cy + R - 52 + i * 20, cx + 250 + i * 30, cy + R - 4 + i * 26), flat(0.95));
    stroke(doc, chisel, p.slice(0, Math.round(p.length * 0.62)),
      { h: 22, s: 0.4, v: 0.24 + i * 0.02 },
      { seed: 1200 + i, patch: { tip: { ...chisel.tip, size: 44 } } });
    stroke(doc, dry, p.slice(Math.round(p.length * 0.5)),
      { h: 24, s: 0.4, v: 0.28 + i * 0.022 }, { seed: 1250 + i });
  }

  // ---- the ball ----
  // Mass it in with short strokes that follow the form, then break the rings up
  // with a scattered second pass. Strokes are kept to 25-35 degrees of arc:
  // longer ones read as concentric rings, which is the tell of a machine rather
  // than a hand.
  const rnd = seededRng(0x5be7);
  const brushFor = (rf, th, si) => {
    // the lit pole sits at 225 degrees, the two turns at 135 and 315
    if (Math.cos(th - 225 * DEG) > 0.55) return impasto;
    if (Math.abs(Math.cos(th - 135 * DEG)) > 0.93 && si < 3) return dry;
    return filbert;
  };

  [0.93, 0.79, 0.65, 0.5, 0.34, 0.18].forEach((shell, si) => {
    const segs = Math.max(5, Math.round(26 * shell));
    const phase = si * 0.41;
    for (let k = 0; k < segs; k++) {
      const span = (2 * Math.PI) / segs;
      const a0 = phase + k * span - span * 0.28;
      const a1 = phase + (k + 1) * span + span * 0.28;
      const mid = (a0 + a1) / 2;
      const rf = Math.max(0.05, shell + (rnd() - 0.5) * 0.06);
      stroke(doc, brushFor(rf, mid, si), sample(22, arc(cx, cy, rf * R, a0, a1), swell(0.62, 1)),
        shade(rf, mid), { seed: 1300 + si * 40 + k });
    }
  });

  // break-up pass: separate touches dropped over the mass-in, each in its own
  // local colour nudged a little off, which is what keeps a passage alive
  for (let k = 0; k < 34; k++) {
    const rf = Math.sqrt(rnd()) * 0.9;
    const th = rnd() * 2 * Math.PI;
    const span = 0.28 + rnd() * 0.3;
    const c = shade(rf, th);
    const off = (rnd() - 0.5) * 0.1;
    stroke(doc, brushFor(rf, th, 3),
      sample(16, arc(cx, cy, rf * R, th - span / 2, th + span / 2), swell(0.55, 0.95)),
      { h: c.h + off * 40, s: Math.max(0.03, c.s - off * 0.2), v: Math.min(1, c.v + off) },
      { seed: 1600 + k });
  }

  // the centre of a set of concentric shells is where they all converge, so
  // cross it with a few touches at other angles
  for (let k = 0; k < 7; k++) {
    const th = (k / 7) * Math.PI * 2 + 0.3;
    const rf = 0.05 + rnd() * 0.14;
    stroke(doc, filbert, sample(14, arc(cx, cy, rf * R, th - 0.7, th + 0.7), swell(0.5, 0.9)),
      shade(rf, th), { seed: 1560 + k });
  }

  // clean the silhouette, then lose the top-left of it into the ground
  for (let k = 0; k < 20; k++) {
    const a0 = (k / 20) * 2 * Math.PI;
    const mid = a0 + Math.PI / 20;
    stroke(doc, filbert, sample(14, arc(cx, cy, 0.965 * R, a0 - 0.06, a0 + 0.38), swell(0.6, 0.95)),
      shade(0.965, mid), { seed: 1700 + k });
  }

  // reflected light bouncing up off the table into the shadow
  for (let i = 0; i < 3; i++) {
    stroke(doc, scumble, sample(34, arc(cx, cy, (0.94 - i * 0.1) * R, 52 * DEG, 116 * DEG), flat(0.8)),
      { h: 202, s: 0.26, v: 0.4 + i * 0.03 }, { seed: 1900 + i });
  }
  // core shadow: the darkest note, kept narrow, just inside the turn
  stroke(doc, bright, sample(40, arc(cx, cy, 0.9 * R, 24 * DEG, 124 * DEG), swell(0.7, 1)),
    { h: 14, s: 0.58, v: 0.19 }, { seed: 1400 });

  // highlight: two small touches, not one blob
  stroke(doc, accent, sample(18, arc(cx, cy, 0.46 * R, 212 * DEG, 240 * DEG), swell(0.5, 1)),
    { h: 46, s: 0.07, v: 0.99 }, { seed: 1800 });
  stroke(doc, accent, sample(12, arc(cx, cy, 0.36 * R, 220 * DEG, 236 * DEG), swell(0.3, 0.8)),
    { h: 48, s: 0.03, v: 1 }, { seed: 1810 });

  // lose the top-left contour into the ground; leave the lit edge found
  for (let i = 0; i < 4; i++) {
    stroke(doc, blender, sample(44, arc(cx, cy, (1.0 - i * 0.035) * R, 252 * DEG, 340 * DEG), flat(0.85)),
      { h: 36, s: 0.17, v: 0.68 }, { seed: 2000 + i });
  }

  return { name: 'study-sphere', width: W, height: H, png: await toPng(doc) };
}

/**
 * A wet-into-wet passage: the kind of loose block-in a painter makes when
 * massing a subject, with nothing representational to hide behind. Strokes come
 * from the whole set at many sizes and angles out of one coherent palette, laid
 * over each other in the order a painter would — darks first, lights last,
 * knife slabs and dry drags into the wet, a few edges deliberately lost.
 *
 * This is the plate to look at when asking whether these brushes read as OIL
 * PAINT rather than whether the composition works: every quality that matters —
 * opaque bodies, chisel ends, hair drag, broken colour, found and lost edges —
 * is visible in it side by side.
 */
async function passageStudy() {
  const W = 1120;
  const H = 760;
  const doc = await makeDoc(W, H, { h: 30, s: 0.17, v: 0.58 });
  const rnd = seededRng(0xa11a);
  const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];

  const chisel = byId('ap-flat-chisel');
  const filbert = byId('ap-filbert');
  const bright = byId('ap-bright');
  const knife = byId('ap-knife');
  const impasto = byId('ap-impasto');
  const dry = byId('ap-dry-drag');
  const scumble = byId('ap-scumbler');
  const blender = byId('ap-fan-blender');
  const dagger = byId('ap-dagger');
  const rigger = byId('ap-rigger');
  const accent = byId('ap-round-accent');

  // A limited palette, the way one would actually be mixed: two warms, two
  // cools, a dark and a light, each drawn from with a little variation.
  const PALETTE = [
    { h: 22, s: 0.52, v: 0.3 },
    { h: 34, s: 0.44, v: 0.52 },
    { h: 44, s: 0.26, v: 0.82 },
    { h: 52, s: 0.12, v: 0.96 },
    { h: 206, s: 0.3, v: 0.42 },
    { h: 192, s: 0.18, v: 0.66 },
    { h: 14, s: 0.42, v: 0.2 },
  ];
  const note = (i) => {
    const c = PALETTE[i % PALETTE.length];
    return {
      h: c.h + (rnd() - 0.5) * 18,
      s: Math.max(0.02, Math.min(1, c.s + (rnd() - 0.5) * 0.12)),
      v: Math.max(0, Math.min(1, c.v + (rnd() - 0.5) * 0.12)),
    };
  };

  /** A stroke that curves gently, the way a hand draws one. */
  const sweep = (x0, y0, ang, len) => {
    const bend = (rnd() - 0.5) * len * 0.34;
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    const p3 = [x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len];
    return bez(
      [x0, y0],
      [x0 + Math.cos(ang) * len * 0.33 + nx * bend, y0 + Math.sin(ang) * len * 0.33 + ny * bend],
      [x0 + Math.cos(ang) * len * 0.66 + nx * bend, y0 + Math.sin(ang) * len * 0.66 + ny * bend],
      p3,
    );
  };

  // 1. mass in the darks and mid-tones with big flats and filberts
  for (let i = 0; i < 46; i++) {
    const brush = pick([chisel, filbert, chisel, impasto]);
    const size = 54 + rnd() * 48;
    const len = 150 + rnd() * 320;
    const ang = (rnd() - 0.5) * 1.5 + (i % 3 === 0 ? Math.PI / 2 : 0);
    stroke(doc, brush,
      sample(60, sweep(rnd() * W, rnd() * H, ang, len), swell(0.55, 1)),
      note(i % 2 ? 0 : rnd() < 0.4 ? 4 : 1),
      { seed: 4000 + i, patch: { tip: { ...brush.tip, size } } });
  }

  // 2. scumble a couple of passages so the darks are not flat
  for (let i = 0; i < 10; i++) {
    stroke(doc, scumble,
      sample(50, sweep(rnd() * W, rnd() * H, (rnd() - 0.5) * 2, 220 + rnd() * 260), flat(0.8)),
      note(rnd() < 0.5 ? 5 : 1), { seed: 4100 + i });
  }

  // 3. the lights, laid on thickly and left alone
  for (let i = 0; i < 34; i++) {
    const brush = pick([chisel, impasto, bright, knife]);
    const size = 38 + rnd() * 44;
    const len = 90 + rnd() * 240;
    stroke(doc, brush,
      sample(48, sweep(rnd() * W, rnd() * H, (rnd() - 0.5) * 1.8, len), swell(0.6, 1)),
      note(rnd() < 0.55 ? 2 : 3),
      { seed: 4200 + i, patch: { tip: { ...brush.tip, size } } });
  }

  // 4. dry drags across the wet lights, where the tooth takes over
  for (let i = 0; i < 12; i++) {
    stroke(doc, dry,
      sample(44, sweep(rnd() * W, rnd() * H, (rnd() - 0.5) * 2.4, 180 + rnd() * 240), swell(0.45, 1)),
      note(rnd() < 0.5 ? 3 : 2), { seed: 4300 + i });
  }

  // 5. lose three edges
  for (let i = 0; i < 3; i++) {
    stroke(doc, blender,
      sample(50, sweep(rnd() * W, rnd() * H, (rnd() - 0.5) * 2, 260 + rnd() * 240), flat(0.85)),
      note(1), { seed: 4400 + i });
  }

  // 6. the accents that go on last: daggers, a few crisp brights, flicks
  for (let i = 0; i < 16; i++) {
    stroke(doc, dagger,
      sample(30, sweep(rnd() * W, rnd() * H, (rnd() - 0.5) * 2.6, 70 + rnd() * 140), swell(0.5, 1)),
      note(rnd() < 0.5 ? 6 : 3), { seed: 4500 + i });
  }
  for (let i = 0; i < 10; i++) {
    stroke(doc, accent,
      sample(24, sweep(rnd() * W, rnd() * H, (rnd() - 0.5) * 3, 50 + rnd() * 90), swell(0.35, 1)),
      note(3), { seed: 4600 + i, patch: { tip: { ...accent.tip, size: 14 + rnd() * 16 } } });
  }
  for (let i = 0; i < 7; i++) {
    stroke(doc, rigger,
      sample(28, sweep(rnd() * W, rnd() * H, (rnd() - 0.5) * 3, 80 + rnd() * 130), attack(1, 0.1)),
      note(rnd() < 0.5 ? 3 : 6), { seed: 4700 + i });
  }
  return { name: 'study-passage', width: W, height: H, png: await toPng(doc) };
}

// ---------------------------------------------------------------------------

/** Fraction of a tip map its ink actually occupies, as {w, h}. */
function inkBox(shape) {
  const m = getTip(shape);
  let minX = m.size, minY = m.size, maxX = -1, maxY = -1;
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.data[y * m.size + x] > 2) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return { w: 1, h: 1 };
  return { w: (maxX - minX + 1) / m.size, h: (maxY - minY + 1) / m.size };
}

/**
 * How wide a mark this brush should leave when dragged along +x at a given
 * pressure: the tip's ink box, scaled and rotated the way the dynamics will
 * rotate it, projected onto the across-stroke axis. A fixed-attitude flat
 * SHOULD come out narrow here — that is the point of holding it at an angle —
 * so tools/markStats.py compares against this rather than against Size.
 */
function sweptWidth(s, pressure) {
  const box = inkBox(s.tip.shape);
  let f = 1;
  if (s.shape.enabled && s.shape.sizeControl.source === 'pressure') {
    f = Math.max(pressure, s.shape.minDiameter);
  }
  const d = s.tip.size * f;
  let theta = (-s.tip.angle / 180) * Math.PI;
  if (s.shape.enabled && s.shape.angleControl.source === 'direction') theta += 0; // travel is +x
  let roundness = s.tip.roundness;
  if (s.shape.enabled && s.shape.brushProjection) {
    const tx = s.pose.enabled && s.pose.overrideTiltX ? s.pose.tiltX : 0;
    const ty = s.pose.enabled && s.pose.overrideTiltY ? s.pose.tiltY : 0;
    const tw = s.pose.enabled && s.pose.overrideRotation ? s.pose.rotation : 0;
    const tilt = Math.hypot(tx, ty) * DEG;
    if (tilt > DEG) {
      theta = (-s.tip.angle / 180) * Math.PI + Math.atan2(ty, tx) + (tw / 360) * Math.PI * 2;
      roundness = Math.max(roundness * Math.cos(tilt), s.shape.minRoundness);
    }
  }
  const a = (d * box.w) / 2;
  const b = (d * roundness * box.h) / 2;
  return 2 * (a * Math.abs(Math.sin(theta)) + b * Math.abs(Math.cos(theta)));
}

/**
 * Measurement target for tools/markStats.py: one long straight stroke per
 * preset, pure black on pure white at a known band centre, so coverage can be
 * read straight off the luminance. No labels — nothing but paint.
 */
async function probeSheet() {
  const W = 1000;
  const RH = 150;
  const doc = await makeDoc(W, ALLA.length * RH, { h: 0, s: 0, v: 1 });
  ALLA.forEach((preset, i) => {
    const y = i * RH + RH / 2;
    stroke(doc, preset.settings, sample(150, line(70, y, W - 70, y), flat(0.85)),
      { h: 0, s: 0, v: 0 }, { seed: 5000 + i });
  });
  return {
    name: 'probe',
    width: W,
    height: ALLA.length * RH,
    rows: ALLA.map((p, i) => ({
      id: p.id,
      name: p.name,
      y: i * RH + RH / 2,
      size: p.settings.tip.size,
      expect: sweptWidth(p.settings, 0.85),
    })),
    png: await toPng(doc),
  };
}

const BUILDERS = [
  ['probe', probeSheet],
  ['marks-1', () => marksSheet('marks-1', ALLA.slice(0, 6))],
  ['marks-2', () => marksSheet('marks-2', ALLA.slice(6))],
  ['marks-detail', detailSheet],
  ['tips', tipsSheet],
  ['response', responseSheet],
  ['study-sphere', sphereStudy],
  ['study-passage', passageStudy],
];

const out = [];
for (const [name, build] of BUILDERS) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  try {
    out.push(await build());
  } catch (err) {
    out.push({ name, error: String(err && err.stack || err) });
  }
}
return out;
}`;
