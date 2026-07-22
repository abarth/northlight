import { clamp, hsvToRgb, rgbToHsv, type RGB } from '../color/convert';
import type { HSV, Point } from '../types';
import type { PointerSample } from './dynamics';
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
  /**
   * 0..1 — bristle flexibility: tips trail the pen (drag lag ∝ flex × size,
   * outer bristles trail more), so direction changes carve rounded
   * turnaround loops and the tuft fans through turns instead of pivoting on
   * a point.
   */
  flex: number;
  /**
   * 0..1 — lighten deposition where a track changes direction sharply
   * (bristles flipping over at a reversal drag with less of their load).
   */
  turnSoftness: number;
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
  /**
   * 0..3 — fade length at BOTH ends of every track chain, in track widths.
   * Symmetric by construction: chains fade in from transparent over this
   * distance and fade back out over the same distance when they end (lift,
   * bristle release, or a turn too sharp to miter — which is what makes a
   * scrubbed-back-and-forth mark's edges soft). 0 = hard segment ends.
   */
  tipTaper: number;
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
    flex: 0.2,
    turnSoftness: 0.5,
    baseAngle: 0,
    followTwist: true,
    coverage: 0.7,
    softness: 0.25,
    tipTaper: 1,
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

/** Width of the soft contact band, in pressure units. */
const CONTACT_BAND = 0.08;

/**
 * How firmly a bristle presses the canvas under this pose, 0..1. Contact is
 * a smooth band rather than a hard threshold: bristles graze in and out of
 * contact gradually as pressure/tilt recruit them (no chain-chopping pops
 * at the footprint boundary while splay/pressure fluctuates). Bristles on
 * the leaning side get an effective depth bonus, so tilt slides the contact
 * patch toward the lean — painting with the side of the filbert.
 */
export function contactFactor(s: BristleBrushSettings, b: Bristle, pose: PenPose): number {
  if (pose.press <= 0) return 0;
  const along = leanComponent(s, b, pose);
  const margin = pose.press - (b.tipZ - pose.lean * s.belly * along);
  const t = clamp(margin / CONTACT_BAND, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Whether a bristle touches at all (see contactFactor for how firmly). */
export function bristleTouches(s: BristleBrushSettings, b: Bristle, pose: PenPose): boolean {
  return contactFactor(s, b, pose) > 0;
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

/**
 * A track segment waiting for its successor: the miter at a joint needs the
 * NEXT segment's direction, so segments are emitted one behind the pen.
 */
interface PendingSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** start-edge lateral (unit perpendicular, or miter-scaled bisector) */
  l0x: number;
  l0y: number;
  a0: number;
  a1: number;
  d0: number;
  d1: number;
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
  /** drag-lag length in px (flex × size, outer bristles trail more) */
  lagPx: number;
  /** direction of the last emitted move, radians; null after a touch-down */
  dir: number | null;
  /** segment awaiting its successor (for the joint miter) */
  pend: PendingSeg | null;
  /** deposit params at the current position (shared joint values) */
  lastA: number;
  lastD: number;
  /** pressure/turn multiplier at the current position (ramped per move) */
  prevMult: number;
  /** travel at the current chain's start — drives the fade-in ramp */
  chainStartTravel: number;
  /** pen travel at the last touch-down, to tell a tap from a grazing touch */
  touchPenTravel: number;
  /**
   * Emitted-but-held-back chain records totalling ~tipTaper of track length.
   * When the chain ends they are ramped to transparent from the end
   * backwards, giving the end the same taper the start gets.
   */
  tail: { rec: number[]; len: number }[];
  tailLen: number;
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
  /** px — end-fade length (both ends), derived from tipTaper × track width */
  private taperPx: number;
  /** per-track alpha that makes the TUFT's single-pass deposit ≈ flow */
  private flowAlpha: number;

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
    this.taperPx = Math.max(s.tipTaper * this.trackWidth, 0);
    // For a moving stroke the 2D bundle collapses to 1D: many bristles share
    // nearly the same lateral offset, so ~(count × width / band) tracks pile
    // onto each pixel row. Normalize per-track alpha for that overdraw so a
    // single pass deposits ≈ flow and low flow genuinely builds up over
    // repeated passes (Photoshop flow semantics). Scale-invariant: count is
    // fixed and width/band both scale with size.
    const band = Math.max((sizePx * (1 + s.thickness)) / 2, 1);
    const overdraw = Math.max((s.bristleCount * this.trackWidth) / band, 1);
    const flow = clamp(s.flow, 0.005, 1);
    this.flowAlpha = 1 - Math.pow(1 - flow, 1 / overdraw);
    const rng = opts.rng ?? Math.random;
    this.bundle = makeBundle(s, rng);
    this.runs = this.bundle.map((b) => ({
      x: 0,
      y: 0,
      down: false,
      travel: 0,
      color: bristleColor(s.colorJitter, opts.fg, opts.bg, rng),
      baseAlpha: 1 - s.opacityJitter * rng(),
      seed: rng() * 1000,
      lagPx: s.flex * sizePx * (0.25 + 0.75 * b.r),
      dir: null,
      pend: null,
      lastA: 0,
      lastD: 0,
      prevMult: 1,
      chainStartTravel: 0,
      touchPenTravel: 0,
      tail: [],
      tailLen: 0,
    }));
  }

  /** cumulative pen travel this stroke, for telling taps from moves */
  private penTravel = 0;

  /** Refills every bristle (start of a stroke when reloadOnLift is set). */
  reload(): void {
    for (const run of this.runs) run.travel = 0;
  }

  /** All bristles leave the canvas (pen lift), fading their tracks out. */
  liftAll(out: number[]): void {
    for (const run of this.runs) {
      this.flushPending(run, out, true);
      run.down = false;
      run.dir = null;
    }
    this.lastPen = null;
  }

  /** previous raw pen position, for the drag-lag step size */
  private lastPen: { x: number; y: number } | null = null;

  /**
   * Advances the tuft to a new pen sample, appending track-segment records
   * to `out`. Newly-touching bristles print a touch dab; bristles that stay
   * down drag a subdivided track; bristles that leave simply stop.
   */
  update(sample: PointerSample, out: number[]): void {
    const s = this.s;
    const pose = penPose(s, sample);
    const w = this.trackWidth;
    const penStep = this.lastPen
      ? Math.hypot(sample.x - this.lastPen.x, sample.y - this.lastPen.y)
      : 0;
    this.penTravel += penStep;
    this.lastPen = { x: sample.x, y: sample.y };

    for (let i = 0; i < this.bundle.length; i++) {
      const b = this.bundle[i];
      const run = this.runs[i];
      const contact = contactFactor(s, b, pose);
      if (contact <= 0) {
        this.flushPending(run, out, true);
        run.down = false;
        run.dir = null;
        continue;
      }
      const off = bristleOffset(s, b, pose, this.sizePx);
      const tx = sample.x + off.x;
      const ty = sample.y + off.y;
      // grazing bristles at the footprint boundary press (and print) lightly
      const pressMult = (0.35 + 0.65 * pose.press) * contact;

      if (!run.down) {
        run.down = true;
        run.x = tx;
        run.y = ty;
        run.prevMult = pressMult;
        run.touchPenTravel = this.penTravel;
        const p = this.pointParams(run, run.travel, pressMult);
        run.lastA = p.alpha;
        run.lastD = p.depth;
        // held only if the pen never moves: a stationary tap prints a dab,
        // while a grazing touch during a moving stroke prints nothing
        run.pend = {
          x0: tx, y0: ty, x1: tx, y1: ty,
          l0x: 0, l0y: 1,
          a0: p.alpha, a1: p.alpha, d0: p.depth, d1: p.depth,
        };
        continue;
      }

      // Drag lag: the tip relaxes toward its target by the distance the pen
      // travelled, over the bristle's lag length — so tips trail the pen and
      // a reversal carves a rounded turnaround loop instead of a sharp point.
      let nx = tx;
      let ny = ty;
      if (run.lagPx > 0.01) {
        const k = 1 - Math.exp(-penStep / run.lagPx);
        nx = run.x + (tx - run.x) * k;
        ny = run.y + (ty - run.y) * k;
      }

      const dist = Math.hypot(nx - run.x, ny - run.y);
      if (dist < 1e-6) {
        run.prevMult = pressMult;
        continue;
      }

      // Turn softening: bristles flipping through a sharp direction change
      // deposit less of their load.
      const newDir = Math.atan2(ny - run.y, nx - run.x);
      let fade = 1;
      if (s.turnSoftness > 0 && run.dir !== null) {
        let dTheta = Math.abs(newDir - run.dir);
        if (dTheta > Math.PI) dTheta = Math.PI * 2 - dTheta;
        const t = clamp(dTheta / (Math.PI * 0.75), 0, 1);
        fade = 1 - s.turnSoftness * t * t;
      }
      run.dir = newDir;

      // The pressure/turn multiplier ramps across this move from its value
      // at the previous joint, so alpha stays continuous through the seams.
      const multTarget = pressMult * fade;
      const travelBase = run.travel;
      const steps = Math.max(1, Math.ceil(dist / MAX_SEGMENT_PX));
      let px = run.x;
      let py = run.y;
      for (let k = 1; k <= steps; k++) {
        const f = k / steps;
        const qx = run.x + (nx - run.x) * f;
        const qy = run.y + (ny - run.y) * f;
        const mult = run.prevMult + (multTarget - run.prevMult) * f;
        this.pushSegment(run, px, py, qx, qy, travelBase + dist * f, mult, w, out);
        px = qx;
        py = qy;
      }
      run.travel = travelBase + dist;
      run.prevMult = multTarget;
      run.x = nx;
      run.y = ny;
    }
  }

  /**
   * Deposit strength at a single point along a bristle's track. Evaluated at
   * the shared joint positions (never per segment), so interpolating the
   * results along each segment is continuous through every seam.
   */
  private pointParams(
    run: BristleRun,
    travel: number,
    mult: number,
  ): { alpha: number; depth: number } {
    const s = this.s;
    // dry-brush breakup: coherent skips along the track
    let gate = 1;
    if (s.breakup > 0) {
      const n = valueNoise1(run.seed, travel / this.breakupPx);
      gate = clamp((n - s.breakup) / 0.1, 0, 1);
    }
    const load = this.loadPx > 0 ? Math.max(0, 1 - travel / this.loadPx) : 1;
    const alpha = this.flowAlpha * run.baseAlpha * gate * (0.15 + 0.85 * load) * mult;
    // a loaded bristle floods the tooth; a dry one only kisses the peaks
    const depth = this.s.toothDepth * (0.25 + 0.75 * (1 - load));
    return { alpha: clamp(alpha, 0, 1), depth };
  }

  /**
   * Advances a bristle by one sub-segment: mitering the joint with the
   * pending segment when the turn allows (the shared slanted edge makes the
   * chain exactly overlap-free), or fading the chain out and restarting it
   * when the turn is too sharp. The new segment becomes pending; its
   * predecessor is emitted. Chain starts fade in from transparent over
   * about one track width of travel — no caps, no dark knots.
   */
  private pushSegment(
    run: BristleRun,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    travelEnd: number,
    mult: number,
    w: number,
    out: number[],
  ): void {
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1e-6) return;
    const dx = (x1 - x0) / len;
    const dy = (y1 - y0) / len;
    // unit perpendicular of this segment (start lateral when no miter)
    let l0x = -dy;
    let l0y = dx;
    let a0 = run.lastA;
    const d0 = run.lastD;
    let newChain = false;

    const pend = run.pend;
    if (pend) {
      const plen = Math.hypot(pend.x1 - pend.x0, pend.y1 - pend.y0);
      if (plen < 1e-6) {
        // lone-touch pending: the move absorbs it; the chain fades in here
        run.pend = null;
        newChain = true;
      } else {
        const pdx = (pend.x1 - pend.x0) / plen;
        const pdy = (pend.y1 - pend.y0) / plen;
        // miter: shared end edge along the bisector of the joint normals
        const msx = -pdy - dy;
        const msy = pdx + dx;
        const mlen = Math.hypot(msx, msy);
        const c = mlen > 1e-6 ? (msx * -dy + msy * dx) / mlen : 0; // cos(θ/2)
        const cosTurn = pdx * dx + pdy * dy;
        const tanHalf = Math.abs(pdx * dy - pdy * dx) / Math.max(1 + cosTurn, 1e-4);
        const hw = w / 2 + 1;
        // too sharp (or miter longer than the segments can host): the chain
        // fades out over its last segment and a new one fades back in
        if (c < 0.5 || hw * tanHalf > 0.45 * Math.min(plen, len)) {
          this.flushPending(run, out, true);
          newChain = true;
        } else {
          const scale = 1 / c;
          const mx = (msx / mlen) * scale;
          const my = (msy / mlen) * scale;
          this.flushPending(run, out, false, { x: mx, y: my });
          l0x = mx;
          l0y = my;
        }
      }
    }

    if (newChain) {
      a0 = 0;
      run.chainStartTravel = travelEnd - len;
    }
    // fade in from transparent over the tip taper (the chain's end gets the
    // mirror-image ramp from rampTailOut, so both ends taper identically)
    const fadeIn = clamp(
      (travelEnd - run.chainStartTravel) / Math.max(this.taperPx, 1e-4),
      0,
      1,
    );
    const end = this.pointParams(run, travelEnd, mult);
    const a1 = end.alpha * fadeIn;
    run.lastA = a1;
    run.lastD = end.depth;

    // fully dry stretch: break the chain (ends ramp to ~0 on their own)
    if (a0 <= 0.003 && a1 <= 0.003) {
      this.flushPending(run, out, false);
      return;
    }

    run.pend = { x0, y0, x1, y1, l0x, l0y, a0, a1, d0, d1: end.depth };
  }

  /**
   * Emits the pending segment into the bristle's tail buffer. `fadeEnd`
   * ends the chain: the buffered tail is ramped to transparent from the end
   * backwards over the tip taper — the mirror image of the chain's fade-in.
   * `endLateral` is the miter-scaled bisector when the chain continues.
   * A zero-length pending (touch that never moved) prints a dab only for a
   * genuinely stationary tap.
   */
  private flushPending(
    run: BristleRun,
    out: number[],
    fadeEnd: boolean,
    endLateral?: { x: number; y: number },
  ): void {
    const pend = run.pend;
    if (!pend) {
      if (fadeEnd) this.drainTail(run, out);
      return;
    }
    run.pend = null;

    const hw = Math.max(this.trackWidth / 2, 0.2);
    const c = run.color;
    const len = Math.hypot(pend.x1 - pend.x0, pend.y1 - pend.y0);
    if (len < 1e-6) {
      // grazing touches during a moving stroke print nothing; a stationary
      // tap prints the tuft's dab (a both-capped disc)
      if (pend.a0 > 0.003 && this.penTravel - run.touchPenTravel < 0.5) {
        out.push(
          pend.x0, pend.y0, pend.x1, pend.y1,
          0, 1, 0, 1,
          hw, pend.a0, pend.a0,
          c.r, c.g, c.b, c.r, c.g, c.b,
          pend.d0, pend.d0, 3,
        );
      }
      if (fadeEnd) this.drainTail(run, out);
      return;
    }

    if (Math.max(pend.a0, pend.a1) > 0.003) {
      const dx = (pend.x1 - pend.x0) / len;
      const dy = (pend.y1 - pend.y0) / len;
      const l1x = endLateral ? endLateral.x : -dy;
      const l1y = endLateral ? endLateral.y : dx;
      run.tail.push({
        rec: [
          pend.x0, pend.y0, pend.x1, pend.y1,
          pend.l0x, pend.l0y, l1x, l1y,
          hw, pend.a0, pend.a1,
          c.r, c.g, c.b, c.r, c.g, c.b,
          pend.d0, pend.d1, 0,
        ],
        len,
      });
      run.tailLen += len;
    }

    if (fadeEnd) {
      this.rampTailOut(run, out);
      return;
    }
    // keep ~a taper's worth of chain buffered; emit the rest
    while (run.tail.length > 1 && run.tailLen - run.tail[0].len >= this.taperPx) {
      const head = run.tail.shift()!;
      run.tailLen -= head.len;
      out.push(...head.rec);
    }
  }

  /** Ends the chain: ramps the buffered tail to transparent and emits it. */
  private rampTailOut(run: BristleRun, out: number[]): void {
    const taper = Math.max(this.taperPx, 1e-4);
    let cum = 0;
    for (let i = run.tail.length - 1; i >= 0; i--) {
      const t = run.tail[i];
      t.rec[10] *= Math.min(cum / taper, 1); // alpha1 (nearer the end)
      cum += t.len;
      t.rec[9] *= Math.min(cum / taper, 1); // alpha0
    }
    this.drainTail(run, out);
  }

  /** Emits the buffered tail unmodified (gap breaks keep their own ramps). */
  private drainTail(run: BristleRun, out: number[]): void {
    for (const t of run.tail) out.push(...t.rec);
    run.tail = [];
    run.tailLen = 0;
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

/**
 * Floats per track-segment instance, matching the track shader's vertex
 * layout: x0, y0, x1, y1, l0x, l0y, l1x, l1y (end laterals: unit
 * perpendicular or miter-scaled bisector), halfWidth, alpha0, alpha1,
 * r0, g0, b0, r1, g1, b1, depth0, depth1, flags (1=startCap, 2=endCap).
 */
export const TRACK_FLOATS = 20;
