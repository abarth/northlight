import { clamp, hsvToRgb, rgbToHsv, type RGB } from '../color/convert';
import type { HSV, Point } from '../types';
import type { PointerSample } from './dynamics';
import { STAMP_FLOATS } from './dynamics';
import type { PatternId } from './types';

/**
 * Bristle brush: a track-based mark engine that lives alongside the stamp
 * model (see docs/bristle-brush.md). The brush is a 3D filbert-shaped tuft
 * of bristles; pen pressure/tilt/twist select which bristles touch the
 * canvas, and each contacted bristle drags its own pigment track. Tracks are
 * emitted as stretched analytic stamps through the existing GPU stamp
 * pipeline, so this module stays pure math — free of GPU/DOM and
 * unit-testable with a seeded rng.
 */

export interface BristleColorJitter {
  /** 0..1 of ±180 degrees, per bristle */
  hue: number;
  /** 0..1 */
  sat: number;
  /** 0..1 */
  bri: number;
  /** 0..1 blend toward the background color, per bristle */
  fgBg: number;
}

export interface BristleBrushSettings {
  /** bristles in the tuft, 8..256 */
  bristleCount: number;
  /** 0.05..1 — cross-section aspect; a filbert is a flattened tuft */
  thickness: number;
  /**
   * 0.05..1 — dome height of the filbert tip. Small belly = flat-cut tuft
   * whose full footprint arrives at light pressure; large belly = domed tip
   * that needs full pressure to engage the edge bristles.
   */
  belly: number;
  /** 0..1 — how far over-penetration spreads contacted bristles outward */
  splay: number;
  /** 0..1 — how strongly pen tilt shifts/elongates the contact patch */
  tiltResponse: number;
  /** degrees — orientation of the filbert's flat when the pen has no twist */
  baseAngle: number;
  /** rotate the flat with the stylus barrel rotation when available */
  followTwist: boolean;

  /**
   * 0..1.5 — how much of the footprint the tracks fill. Track width is
   * derived from size, bristle count and thickness (width ∝ size/√count),
   * so the mark quality is scale-invariant: resizing the brush scales the
   * whole mark, and more bristles means finer streaks at the same coverage.
   */
  coverage: number;
  /** 0..1 — softness of the track edges (0 = crisp) */
  softness: number;
  /** 0..1 per-segment deposit; tracks build up like flow */
  flow: number;
  /** 0..1 random per-bristle reduction of base opacity */
  opacityJitter: number;

  /**
   * Travel until a bristle runs dry, in brush diameters (0 = never).
   * Size-relative so a stroke "one brush-load long" is the same gesture at
   * any size.
   */
  load: number;
  /** refill the tuft when the pen lifts */
  reloadOnLift: boolean;
  /** 0..1 — fraction of each track that skips (dry-brush breakup) */
  breakup: number;
  /**
   * Wavelength of the deposit/skip alternation along a track, as a fraction
   * of brush size (size-relative, like everything else about the mark).
   */
  breakupScale: number;

  colorJitter: BristleColorJitter;

  /** 0..1 — how strongly canvas tooth gates a dry bristle's deposit */
  toothDepth: number;
  pattern: PatternId;
  /** 0.1..4 — pattern tile scale, relative to the pattern's native size */
  patternScale: number;
}

export function defaultBristleBrush(): BristleBrushSettings {
  return {
    bristleCount: 96,
    thickness: 0.45,
    belly: 0.6,
    splay: 0.35,
    tiltResponse: 0.6,
    baseAngle: 0,
    followTwist: true,
    coverage: 0.7,
    softness: 0.25,
    flow: 0.75,
    opacityJitter: 0.35,
    load: 15,
    reloadOnLift: true,
    breakup: 0.3,
    breakupScale: 0.7,
    colorJitter: { hue: 0.03, sat: 0.12, bri: 0.14, fgBg: 0 },
    toothDepth: 0.5,
    pattern: 'tooth',
    patternScale: 1,
  };
}

/** Deterministic rng for reproducible bundles/strokes in tests. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One bristle's rest geometry in brush-local space. */
export interface Bristle {
  /** cross-section position on the unit disc (long axis = x) */
  ox: number;
  oy: number;
  /** normalized cross-section radius 0..1 */
  r: number;
  /** penetration depth (0..1) required for this bristle's tip to touch */
  tipZ: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/**
 * Builds the tuft: bristle roots on a Vogel spiral over the unit disc (even
 * packing without lattice artifacts) with positional jitter, and tips on a
 * filbert dome — center bristles reach furthest (tipZ 0), edge bristles hang
 * back (tipZ up to `belly`), with a little length raggedness.
 */
export function makeBundle(s: BristleBrushSettings, rng: () => number): Bristle[] {
  const n = Math.max(1, Math.round(s.bristleCount));
  const out: Bristle[] = [];
  for (let i = 0; i < n; i++) {
    const r0 = Math.sqrt((i + 0.5) / n);
    const th = i * GOLDEN_ANGLE;
    const jit = 0.6 / Math.sqrt(n);
    const ox = clamp(r0 * Math.cos(th) + (rng() * 2 - 1) * jit, -1, 1);
    const oy = clamp(r0 * Math.sin(th) + (rng() * 2 - 1) * jit, -1, 1);
    const r = Math.min(1, Math.hypot(ox, oy));
    const dome = 1 - Math.sqrt(Math.max(0, 1 - r * r));
    const tipZ = Math.max(0, s.belly * dome + (rng() * 2 - 1) * 0.03);
    out.push({ ox, oy, r, tipZ });
  }
  return out;
}

/** Pen orientation resolved once per input sample. */
export interface PenPose {
  /** penetration depth 0..1 (from pressure) */
  press: number;
  /** rotation of the filbert's flat, radians (y-down screen space) */
  rot: number;
  /** lean magnitude 0..1 (from tilt) */
  lean: number;
  /** unit lean azimuth (direction the pen body leans toward) */
  leanX: number;
  leanY: number;
}

export function penPose(s: BristleBrushSettings, p: PointerSample): PenPose {
  const press = clamp(p.pressure, 0, 1);
  const twist = s.followTwist ? (p.twist / 360) * Math.PI * 2 : 0;
  const rot = (s.baseAngle / 180) * Math.PI + twist;
  const mag = Math.hypot(p.tiltX, p.tiltY);
  const lean = clamp(mag / 60, 0, 1) * s.tiltResponse;
  const leanX = mag > 1e-6 ? p.tiltX / mag : 1;
  const leanY = mag > 1e-6 ? p.tiltY / mag : 0;
  return { press, rot, lean, leanX, leanY };
}

/**
 * Whether a bristle touches the canvas under this pose. Bristles on the
 * leaning side get an effective depth bonus, so tilt slides the contact
 * patch toward the lean — painting with the side of the filbert.
 */
export function bristleTouches(s: BristleBrushSettings, b: Bristle, pose: PenPose): boolean {
  if (pose.press <= 0) return false;
  const along = leanComponent(s, b, pose);
  return b.tipZ - pose.lean * s.belly * along <= pose.press;
}

/** Component of the bristle's (flattened, rotated) offset along the lean. */
function leanComponent(s: BristleBrushSettings, b: Bristle, pose: PenPose): number {
  const ca = Math.cos(pose.rot);
  const sa = Math.sin(pose.rot);
  const x = b.ox * ca - b.oy * s.thickness * sa;
  const y = b.ox * sa + b.oy * s.thickness * ca;
  return x * pose.leanX + y * pose.leanY;
}

/**
 * Canvas-space offset of a bristle from the pen position, in px. Applies the
 * cross-section flattening, the flat's rotation, pressure splay, and the
 * tilt stretch (footprint elongates along the lean azimuth).
 */
export function bristleOffset(
  s: BristleBrushSettings,
  b: Bristle,
  pose: PenPose,
  sizePx: number,
): Point {
  const ca = Math.cos(pose.rot);
  const sa = Math.sin(pose.rot);
  let x = b.ox * ca - b.oy * s.thickness * sa;
  let y = b.ox * sa + b.oy * s.thickness * ca;
  const splay = 1 + s.splay * pose.press * 0.7;
  x *= splay;
  y *= splay;
  if (pose.lean > 0) {
    // stretch (and slide slightly) along the lean azimuth
    const along = x * pose.leanX + y * pose.leanY;
    const grow = along * pose.lean * 1.2 + pose.lean * 0.35;
    x += pose.leanX * grow;
    y += pose.leanY * grow;
  }
  const half = sizePx / 2;
  return { x: x * half, y: y * half };
}

/**
 * Closed outline of the contact footprint at a given pose — the analytic
 * boundary of the bristles that would touch. Used by the canvas cursor to
 * show the mark before the pen lands. Returned points are offsets from the
 * pen position in document px.
 */
export function footprintOutline(
  s: BristleBrushSettings,
  pose: PenPose,
  sizePx: number,
  segments = 48,
): Point[] {
  // Invert the dome profile: the no-tilt contact boundary is the circle
  // r where belly * (1 - sqrt(1 - r^2)) = press.
  const t = clamp(1 - pose.press / Math.max(s.belly, 1e-3), 0, 1);
  const rc = Math.sqrt(Math.max(0, 1 - t * t));
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b: Bristle = { ox: Math.cos(a) * rc, oy: Math.sin(a) * rc, r: rc, tipZ: 0 };
    pts.push(bristleOffset(s, b, pose, sizePx));
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Deposition
// ---------------------------------------------------------------------------

/** Smooth 1D value noise in ~0..1, deterministic per (seed, position). */
export function valueNoise1(seed: number, x: number): number {
  const cell = Math.floor(x);
  const f = x - cell;
  const u = f * f * (3 - 2 * f);
  const h = (c: number) => {
    const v = Math.sin(c * 127.1 + seed * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  return h(cell) * (1 - u) + h(cell + 1) * u;
}

interface BristleRun {
  /** last canvas position, valid while `down` */
  x: number;
  y: number;
  down: boolean;
  /** px of track laid since the last reload */
  travel: number;
  color: RGB;
  /** per-bristle opacity multiplier */
  baseAlpha: number;
  /** per-bristle noise seed for the breakup gate */
  seed: number;
}

export interface BristleSimOptions {
  fg: HSV;
  bg: HSV;
  /** injectable for deterministic tests; defaults to Math.random */
  rng?: () => number;
}

/** Longest emitted track segment; longer moves are subdivided. */
const MAX_SEGMENT_PX = 6;

/**
 * The per-stroke bristle simulation: owns the bundle and each bristle's
 * pigment state, and turns pointer samples into STAMP_FLOATS-sized track
 * segment records (stretched stamps: radius spans the segment, roundness
 * squashes it to the bristle width).
 */
export class BristleSim {
  private s: BristleBrushSettings;
  private bundle: Bristle[];
  private runs: BristleRun[];
  private sizePx: number;
  /** px — derived from coverage/size/count so marks are scale-invariant */
  private trackWidth: number;
  /** px of travel until dry (0 = never), derived from `load` × size */
  private loadPx: number;
  /** px — breakup wavelength, derived from breakupScale × size */
  private breakupPx: number;

  constructor(s: BristleBrushSettings, sizePx: number, opts: BristleSimOptions) {
    this.s = s;
    this.sizePx = sizePx;
    // Tracks tile the footprint at coverage 1: the elliptical cross-section
    // area split among bristleCount tracks gives width ∝ size/√count.
    this.trackWidth = Math.max(
      s.coverage *
        (sizePx / 2) *
        Math.sqrt((Math.PI * s.thickness) / Math.max(s.bristleCount, 1)),
      0.4,
    );
    this.loadPx = s.load > 0 ? s.load * sizePx : 0;
    this.breakupPx = Math.max(s.breakupScale * sizePx, 1);
    const rng = opts.rng ?? Math.random;
    this.bundle = makeBundle(s, rng);
    this.runs = this.bundle.map(() => ({
      x: 0,
      y: 0,
      down: false,
      travel: 0,
      color: bristleColor(s.colorJitter, opts.fg, opts.bg, rng),
      baseAlpha: 1 - s.opacityJitter * rng(),
      seed: rng() * 1000,
    }));
  }

  /** Refills every bristle (start of a stroke when reloadOnLift is set). */
  reload(): void {
    for (const run of this.runs) run.travel = 0;
  }

  /** All bristles leave the canvas (pen lift). */
  liftAll(): void {
    for (const run of this.runs) run.down = false;
  }

  /**
   * Advances the tuft to a new pen sample, appending track-segment records
   * to `out`. Newly-touching bristles print a touch dab; bristles that stay
   * down drag a subdivided track; bristles that leave simply stop.
   */
  update(sample: PointerSample, out: number[]): void {
    const s = this.s;
    const pose = penPose(s, sample);
    const w = this.trackWidth;

    for (let i = 0; i < this.bundle.length; i++) {
      const b = this.bundle[i];
      const run = this.runs[i];
      if (!bristleTouches(s, b, pose)) {
        run.down = false;
        continue;
      }
      const off = bristleOffset(s, b, pose, this.sizePx);
      const nx = sample.x + off.x;
      const ny = sample.y + off.y;

      if (!run.down) {
        run.down = true;
        run.x = nx;
        run.y = ny;
        this.emitSegment(run, nx, ny, nx, ny, pose, w, out);
        continue;
      }

      const dist = Math.hypot(nx - run.x, ny - run.y);
      const steps = Math.max(1, Math.ceil(dist / MAX_SEGMENT_PX));
      let px = run.x;
      let py = run.y;
      for (let k = 1; k <= steps; k++) {
        const qx = run.x + ((nx - run.x) * k) / steps;
        const qy = run.y + ((ny - run.y) * k) / steps;
        this.emitSegment(run, px, py, qx, qy, pose, w, out);
        run.travel += dist / steps;
        px = qx;
        py = qy;
      }
      run.x = nx;
      run.y = ny;
    }
  }

  /**
   * One capsule-ish segment as a stretched stamp record, gated by the
   * per-bristle breakup noise and faded/tooth-gated by the remaining load.
   */
  private emitSegment(
    run: BristleRun,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    pose: PenPose,
    w: number,
    out: number[],
  ): void {
    const s = this.s;
    const len = Math.hypot(x1 - x0, y1 - y0);

    // dry-brush breakup: coherent skips along the track
    let gate = 1;
    if (s.breakup > 0) {
      const mid = run.travel + len / 2;
      const n = valueNoise1(run.seed, mid / this.breakupPx);
      gate = clamp((n - s.breakup) / 0.1, 0, 1);
      if (gate <= 0) return;
    }

    const load = this.loadPx > 0 ? Math.max(0, 1 - run.travel / this.loadPx) : 1;
    const alpha =
      s.flow * run.baseAlpha * gate * (0.15 + 0.85 * load) * (0.35 + 0.65 * pose.press);
    if (alpha <= 0.003) return;

    // a loaded bristle floods the tooth; a dry one only kisses the peaks
    const depthScale = s.toothDepth * (0.25 + 0.75 * (1 - load));

    const radius = len / 2 + w / 2;
    const roundness = clamp(w / (len + w), 0.01, 1);
    const angle = len > 1e-6 ? Math.atan2(y1 - y0, x1 - x0) : 0;
    out.push(
      (x0 + x1) / 2,
      (y0 + y1) / 2,
      radius,
      clamp(alpha, 0, 1),
      angle,
      roundness,
      run.color.r,
      run.color.g,
      run.color.b,
      0, // flags
      depthScale,
    );
  }
}

/** Per-bristle pigment color: fg→bg blend plus HSV jitter. */
export function bristleColor(
  j: BristleColorJitter,
  fg: HSV,
  bg: HSV,
  rng: () => number,
): RGB {
  const t = clamp(j.fgBg * rng(), 0, 1);
  const a = hsvToRgb(fg);
  const b = hsvToRgb(bg);
  const base: RGB = {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
  const hsv = rgbToHsv(base, fg.h);
  if (j.hue > 0) hsv.h += (rng() * 2 - 1) * j.hue * 180;
  if (j.sat > 0) hsv.s = clamp(hsv.s * (1 + (rng() * 2 - 1) * j.sat), 0, 1);
  if (j.bri > 0) hsv.v = clamp(hsv.v * (1 + (rng() * 2 - 1) * j.bri), 0, 1);
  return hsvToRgb(hsv);
}

/** Sanity guard: record layout must match the stamp shader's. */
export const BRISTLE_RECORD_FLOATS: typeof STAMP_FLOATS = STAMP_FLOATS;
