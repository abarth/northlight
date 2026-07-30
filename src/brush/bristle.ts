import type { GrayMap } from './patterns';
import type { TipShape } from './types';

/**
 * Bristle tips — Photoshop's Bristle Qualities (CS5+): a Shape drawn from the
 * ten ferrule/trim combinations, plus Bristles, Length, Thickness, Stiffness
 * and Angle.
 *
 * Photoshop draws these with a bristle simulation whose internals are not
 * published; what it *deposits* is a contact patch whose width is the blade,
 * whose depth is how far the hairs bend under the pen, and which is streaked
 * by the individual hairs. That patch is what a tip alpha map has to be, so
 * these generators build it directly from the same six parameters:
 *
 *   - tip-space x runs along the BLADE (the mark's width),
 *   - tip-space y runs along the CONTACT DEPTH (how far the patch reaches in
 *     the travel direction),
 *   - alpha varies across x in hair-wide stripes with true zeros between.
 *
 * Point the blade across the stroke (tip Angle, or Shape Dynamics' Angle
 * control set to Direction) and every dab's stripes land on the previous
 * dab's, so the hairs draw continuous striations down the stroke instead of a
 * train of repeated stamps. The zeros survive accumulation, which is what
 * keeps a bristle mark from filling in to a flat band.
 *
 * The map is content-addressed: `bristleTipId` serializes the qualities into
 * the tip id itself (`bristle:flat-blunt:b40l55t35s75`), so the existing tip
 * registry, texture cache, spacing aspect, brush cursor and preview all work
 * on bristle tips with no extra plumbing — and the same id always generates
 * the same map.
 */

/** Photoshop's Bristle Qualities > Shape list. */
export type BristleShape =
  | 'round-point'
  | 'round-blunt'
  | 'round-curve'
  | 'round-angle'
  | 'round-fan'
  | 'flat-point'
  | 'flat-blunt'
  | 'flat-curve'
  | 'flat-angle'
  | 'flat-fan';

export interface BristleQualities {
  shape: BristleShape;
  /** 0..1 — Photoshop's Bristles (hair count) */
  bristles: number;
  /** 0..1 — Length: longer hairs bend further, deepening the contact patch */
  length: number;
  /** 0..1 — Thickness: hair width, i.e. how much of each period is ink */
  thickness: number;
  /** 0..1 — Stiffness: stiff hairs keep crisp, separate streaks */
  stiffness: number;
}

export const BRISTLE_SHAPES: { id: BristleShape; label: string }[] = [
  { id: 'round-point', label: 'Round Point' },
  { id: 'round-blunt', label: 'Round Blunt' },
  { id: 'round-curve', label: 'Round Curve' },
  { id: 'round-angle', label: 'Round Angle' },
  { id: 'round-fan', label: 'Round Fan' },
  { id: 'flat-point', label: 'Flat Point' },
  { id: 'flat-blunt', label: 'Flat Blunt' },
  { id: 'flat-curve', label: 'Flat Curve' },
  { id: 'flat-angle', label: 'Flat Angle' },
  { id: 'flat-fan', label: 'Flat Fan' },
];

const SHAPE_IDS = new Set<string>(BRISTLE_SHAPES.map((s) => s.id));

export const DEFAULT_BRISTLE: BristleQualities = {
  shape: 'flat-blunt',
  bristles: 0.35,
  length: 0.5,
  thickness: 0.45,
  stiffness: 0.7,
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const pct = (x: number) => Math.round(clamp01(x) * 100);

/** Serializes qualities into a tip id, e.g. `bristle:flat-blunt:b35l50t45s70`. */
export function bristleTipId(q: Partial<BristleQualities> = {}): TipShape {
  const full = { ...DEFAULT_BRISTLE, ...q };
  return (
    `bristle:${full.shape}:` +
    `b${pct(full.bristles)}l${pct(full.length)}t${pct(full.thickness)}s${pct(full.stiffness)}`
  );
}

export function isBristleTip(id: string): boolean {
  return id.startsWith('bristle:');
}

const ID_RE = /^bristle:([a-z-]+):b(\d+)l(\d+)t(\d+)s(\d+)$/;

/** Parses a bristle tip id, or null when `id` is not one. */
export function parseBristleTip(id: string): BristleQualities | null {
  const m = ID_RE.exec(id);
  if (!m || !SHAPE_IDS.has(m[1])) return null;
  return {
    shape: m[1] as BristleShape,
    bristles: Number(m[2]) / 100,
    length: Number(m[3]) / 100,
    thickness: Number(m[4]) / 100,
    stiffness: Number(m[5]) / 100,
  };
}

/** Human label for a bristle tip id (falls back to the raw id). */
export function bristleTipLabel(id: string): string {
  const q = parseBristleTip(id);
  if (!q) return id;
  const shape = BRISTLE_SHAPES.find((s) => s.id === q.shape)?.label ?? q.shape;
  return `${shape} Bristle`;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Bristle maps are generated large so the streaks stay band-limited. */
const BRISTLE_TIP_SIZE = 256;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Per-shape footprint geometry, in tip space (x and y both in [-1, 1]).
 *
 * `depth` and `center` describe the contact patch as a function of position
 * along the blade; `env` is the blade's own coverage profile, which is what
 * makes a blunt trim end square and a point taper away.
 */
interface Footprint {
  /** half-depth of the contact patch at the middle of the blade */
  patch: number;
  /** patch half-depth multiplier along the blade */
  depth: (u: number) => number;
  /** patch centre offset along the blade (a curved or angled trim) */
  center: (u: number) => number;
  /** coverage envelope along the blade */
  env: (u: number) => number;
  /** extra hair-position spread (fans splay), 1 = evenly spaced */
  spread: number;
  /** fraction of hairs that carry (almost) no paint */
  dropout: number;
  /** hair-width multiplier */
  duty: number;
}

/** Smooth 0..1 ramp used for trims and shoulders. */
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function footprint(q: BristleQualities): Footprint {
  const round = q.shape.startsWith('round-');
  const trim = q.shape.slice(round ? 6 : 5);

  // Longer, softer hairs bend further under the pen and lay a deeper patch.
  // A round ferrule's patch is as deep as the blade is wide; a flat one's is
  // the thickness of the blade, which is what makes its mark a chisel.
  const bend = q.length * (1 - 0.4 * q.stiffness);
  const flatPatch = 0.10 + 0.30 * bend;
  const patch = round ? 0.62 + 0.30 * bend : flatPatch;

  // Square trim: full coverage with a crisp shoulder right at the blade end.
  const bluntEnv = (u: number) => 1 - smoothstep(0.95, 1, Math.abs(u));
  const one = () => 1;
  const zero = () => 0;

  switch (trim) {
    case 'point':
      // Hairs drawn to a point: the blade tapers and the patch shallows with
      // it, so the mark has soft, drawn-out ends.
      return {
        patch: patch * (round ? 0.8 : 1),
        depth: (u) => Math.pow(Math.max(0, 1 - u * u), round ? 0.5 : 0.35),
        center: zero,
        env: (u) => Math.pow(Math.max(0, 1 - Math.abs(u) ** 2.2), 0.55),
        spread: 1,
        dropout: 0.06,
        duty: 0.95,
      };
    case 'blunt':
      // A freshly cut flat: square ends, even depth — Sargent's chisel mark.
      return {
        patch,
        depth: round ? (u) => Math.sqrt(Math.max(0, 1 - u * u)) : one,
        center: zero,
        env: bluntEnv,
        spread: 1,
        dropout: 0.02,
        duty: 1,
      };
    case 'curve':
      // Filbert: domed trim, and the contact line arcs across the blade.
      return {
        patch,
        depth: (u) => 0.74 + 0.26 * Math.cos((u * Math.PI) / 2),
        center: (u) => patch * 0.45 * (u * u - 0.35),
        // domed, but with a shoulder at the very end so the mark's long edges
        // stay crisp instead of fading out over a tenth of the blade
        env: (u) =>
          Math.pow(Math.cos(clamp01(Math.abs(u)) * (Math.PI / 2)), 0.18) *
          (1 - smoothstep(0.93, 1, Math.abs(u))),
        spread: 1,
        dropout: 0.04,
        duty: 1,
      };
    case 'angle':
      // Angular/dagger: the trim is cut on a slant, so hair length — and with
      // it the patch depth and offset — ramps along the blade.
      return {
        patch,
        depth: (u) => 0.45 + 0.55 * ((u + 1) / 2),
        center: (u) => patch * 0.55 * u,
        env: (u) => bluntEnv(u) * (0.72 + 0.28 * ((u + 1) / 2)),
        spread: 1,
        dropout: 0.03,
        duty: 1,
      };
    case 'fan':
      // Splayed hairs: sparse, separated streaks that flare at the ends.
      return {
        patch: patch * (round ? 0.7 : 1.15),
        depth: (u) => 0.7 + 0.55 * Math.abs(u),
        center: (u) => patch * 0.2 * u * Math.abs(u),
        env: (u) => (1 - smoothstep(0.82, 1.0, Math.abs(u))) * 0.9,
        spread: 1.25,
        dropout: 0.22,
        duty: 0.62,
      };
    default:
      return {
        patch,
        depth: one,
        center: zero,
        env: bluntEnv,
        spread: 1,
        dropout: 0,
        duty: 1,
      };
  }
}

/**
 * Generates a bristle tip's alpha map. Deterministic in the qualities, so the
 * tip cache can key it by id.
 */
export function makeBristleTip(q: BristleQualities): GrayMap {
  const size = BRISTLE_TIP_SIZE;
  const fp = footprint(q);
  const rng = mulberry32(hashString(bristleTipId(q)));

  // Photoshop's Bristles runs 1..100; the useful range for a mark that still
  // reads as separate hairs at painting sizes is a few up to ~40 streaks.
  const hairs = Math.max(2, Math.round(3 + q.bristles * 37));
  const margin = 0.03;
  const span = 2 * (1 - margin);
  const period = span / hairs;

  // Thickness is, directly, the fraction of each period that carries paint —
  // the remainder is a true zero, and a true zero is the only thing that
  // survives dab-on-dab accumulation to read as a hair line. Stiffness sets
  // how sharply a hair's edge falls off (soft hairs bleed into their gap),
  // capped so a hair always keeps a core.
  const half = period / 2;
  const inkHalf = half * (0.12 + 0.88 * q.thickness) * fp.duty;
  const soft = Math.min(half * (0.05 + 0.5 * (1 - q.stiffness)), inkHalf * 0.9);
  const halfWidth = inkHalf - soft;

  // Hair positions, strengths and how far each one's contact line sits ahead
  // of or behind the others (a ragged leading edge).
  // A few slow lobes of "where the paint is" across the blade. Without this
  // the hairs are all equally loaded and the mark rules itself into corduroy;
  // real bristles carry paint in clumps a third of the blade wide.
  const lobe = [0, 1].map(() => ({
    freq: 1 + Math.floor(rng() * 3),
    phase: rng() * Math.PI * 2,
    amp: 0.08 + rng() * 0.14,
  }));
  const load = (u: number) => {
    let v = 1;
    for (const l of lobe) v -= l.amp * (0.5 - 0.5 * Math.cos(l.freq * (u + 1) * Math.PI + l.phase));
    return clamp01(v);
  };

  const centers = new Float32Array(hairs);
  const strength = new Float32Array(hairs);
  const lead = new Float32Array(hairs);
  // Even a stiff brush does not space its hairs on a ruler; without a floor
  // here the striations come out as machined corduroy.
  const wander = period * (0.18 + 0.34 * (1 - q.stiffness)) * (0.35 + 0.65 * q.length);
  for (let i = 0; i < hairs; i++) {
    const t = hairs === 1 ? 0.5 : i / (hairs - 1);
    const even = -1 + margin + span * t;
    // Fans push their hairs outward; the sign keeps the blade centred.
    const splayed = fp.spread === 1 ? even : Math.sign(even) * Math.pow(Math.abs(even), 1 / fp.spread);
    centers[i] = splayed + (rng() * 2 - 1) * wander;
    strength[i] =
      rng() < fp.dropout
        ? 0.04 + rng() * 0.12
        : (0.7 + 0.3 * Math.pow(rng(), 0.6)) * (0.76 + 0.24 * load(centers[i]));
    lead[i] = (rng() * 2 - 1) * 0.3 * (1 - 0.5 * q.stiffness);
  }

  // Hairs packed thickly enough stop behaving like a comb: paint bridges the
  // gaps between them, so what the mark shows is a thinner FILM between the
  // hairs rather than bare ground. Without this a loaded flat prints holes,
  // because a true zero in the tip survives any amount of accumulation while
  // anything above zero saturates — there is no middle unless the tip itself
  // provides one.
  // Calibrated, not guessed: tools/markStats.py measures the depth of the hair
  // lines in a rendered mark, and this curve is what puts a loaded flat's
  // streak contrast at ~0.08 of coverage (a line you read as value) instead of
  // ~0.30 (a line you read as a hole), while leaving a dry brush's thin hairs
  // with gaps that are still gaps.
  const bridge = clamp01((q.thickness - 0.35) / 0.65) * 0.9;

  // Per-column hair coverage plus the dominant hair's lead offset. Hairs are
  // narrow in x, so at most a couple contribute to any column.
  const colInk = new Float32Array(size);
  const colLead = new Float32Array(size);
  for (let x = 0; x < size; x++) {
    const u = ((x + 0.5) / size) * 2 - 1;
    let ink = 0;
    let best = -1;
    let bestW = 0;
    for (let i = 0; i < hairs; i++) {
      const d = Math.abs(u - centers[i]);
      if (d > halfWidth + soft) continue;
      const w = soft <= 0 ? 1 : clamp01((halfWidth + soft - d) / soft);
      const v = w * strength[i];
      if (v > ink) ink = v;
      if (w > bestW) {
        bestW = w;
        best = i;
      }
    }
    colInk[x] = Math.max(ink, bridge * load(u));
    colLead[x] = best >= 0 ? lead[best] : 0;
  }

  // Falloff of the contact patch in the travel direction. Deliberately gentle
  // even for a stiff brush: this profile is what neighbouring dabs sum over,
  // and a flat-topped one prints the dab train as ribs across the mark. It
  // costs only a slightly softened start and end to the stroke, which is what
  // a real chisel end looks like anyway.
  const rim = 0.42 + 0.5 * (1 - q.stiffness);
  const out = new Uint8Array(size * size);
  for (let x = 0; x < size; x++) {
    const ink = colInk[x];
    if (ink <= 0) continue;
    const u = ((x + 0.5) / size) * 2 - 1;
    const env = clamp01(fp.env(u));
    if (env <= 0) continue;
    const half = Math.max(1e-4, fp.patch * clamp01(fp.depth(u)));
    const mid = fp.center(u) + colLead[x] * half;
    const col = ink * env;
    for (let y = 0; y < size; y++) {
      const v = ((y + 0.5) / size) * 2 - 1;
      const t = Math.abs((v - mid) / half);
      if (t >= 1) continue;
      const prof = rim <= 0 ? 1 : clamp01((1 - t) / rim);
      const a = col * prof;
      if (a > 0) out[y * size + x] = Math.round(clamp01(a) * 255);
    }
  }
  return { size, data: out };
}
