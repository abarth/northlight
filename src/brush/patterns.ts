import type { DualBrush, PatternId, TipShape } from './types';

/**
 * Procedural, tileable grayscale patterns (for the Texture section) and
 * sampled-style brush tip alpha maps (chalk/spatter/grain). Everything is
 * generated deterministically from fixed seeds so rendering is reproducible.
 */

export interface GrayMap {
  size: number;
  /** size*size bytes, 0..255 */
  data: Uint8Array<ArrayBuffer>;
}

/** Deterministic PRNG, exported for previews and tests. */
export function seededRng(seed: number): () => number {
  return mulberry32(seed);
}

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

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Periodic (tileable) value noise on a `cells`-wide lattice. */
function noiseLattice(cells: number, rng: () => number): number[] {
  const g: number[] = [];
  for (let i = 0; i < cells * cells; i++) g.push(rng());
  return g;
}

function sampleLattice(g: number[], cells: number, u: number, v: number): number {
  const x = u * cells;
  const y = v * cells;
  const x0 = Math.floor(x) % cells;
  const y0 = Math.floor(y) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const fx = smooth(x - Math.floor(x));
  const fy = smooth(y - Math.floor(y));
  const a = g[y0 * cells + x0];
  const b = g[y0 * cells + x1];
  const c = g[y1 * cells + x0];
  const d = g[y1 * cells + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Tileable fractal noise in [0,1]. */
function fractal(size: number, seed: number, octaves: number, baseCells: number): Float32Array {
  const rng = mulberry32(seed);
  const layers: { g: number[]; cells: number; amp: number }[] = [];
  let amp = 1;
  let cells = baseCells;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ g: noiseLattice(cells, rng), cells, amp });
    total += amp;
    amp *= 0.55;
    cells *= 2;
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const l of layers) v += sampleLattice(l.g, l.cells, x / size, y / size) * l.amp;
      out[y * size + x] = v / total;
    }
  }
  return out;
}

function toBytes(f: Float32Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(clamp01(f[i]) * 255);
  return out;
}

// ---------------------------------------------------------------------------
// Patterns (256x256, tileable). Value 1 = full paint, 0 = fully carved.
// ---------------------------------------------------------------------------

const PATTERN_SIZE = 256;

function makePattern(id: PatternId): GrayMap {
  const size = PATTERN_SIZE;
  const out = new Float32Array(size * size);

  switch (id) {
    case 'paper': {
      const coarse = fractal(size, 101, 4, 4);
      const fine = fractal(size, 102, 2, 32);
      for (let i = 0; i < out.length; i++) {
        out[i] = 0.55 + (coarse[i] - 0.5) * 0.55 + (fine[i] - 0.5) * 0.45;
      }
      break;
    }
    case 'canvas': {
      const n = fractal(size, 201, 3, 8);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const wx = 0.5 + 0.5 * Math.sin((x / size) * Math.PI * 2 * 16);
          const wy = 0.5 + 0.5 * Math.sin((y / size) * Math.PI * 2 * 16 + Math.PI / 2);
          const weave = Math.max(wx, wy) * 0.6 + 0.25;
          out[y * size + x] = weave + (n[y * size + x] - 0.5) * 0.35;
        }
      }
      break;
    }
    case 'sponge': {
      // irregular holes: darker where the fractal dips
      const n = fractal(size, 301, 4, 6);
      for (let i = 0; i < out.length; i++) {
        const t = smooth(clamp01((n[i] - 0.38) / 0.3));
        out[i] = 0.15 + 0.85 * t;
      }
      break;
    }
    case 'clouds': {
      const n = fractal(size, 401, 5, 4);
      for (let i = 0; i < out.length; i++) out[i] = clamp01(0.5 + (n[i] - 0.5) * 1.6);
      break;
    }
    case 'speckle': {
      out.fill(0.95);
      const rng = mulberry32(501);
      for (let k = 0; k < 900; k++) {
        const cx = rng() * size;
        const cy = rng() * size;
        const r = 1 + rng() * 3;
        const depth = 0.5 + rng() * 0.5;
        const ri = Math.ceil(r + 1);
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            const d = Math.hypot(dx, dy);
            if (d > r + 1) continue;
            const x = (Math.round(cx + dx) + size) % size;
            const y = (Math.round(cy + dy) + size) % size;
            const fall = clamp01(1 - d / r);
            const i = y * size + x;
            out[i] = Math.min(out[i], 0.95 - depth * fall);
          }
        }
      }
      break;
    }
  }
  return { size, data: toBytes(out) };
}

// ---------------------------------------------------------------------------
// Tip shapes (128x128 alpha maps, transparent border)
// ---------------------------------------------------------------------------

const TIP_SIZE = 128;

function makeTip(shape: TipShape): GrayMap {
  const size = TIP_SIZE;
  const out = new Float32Array(size * size);
  const cx = size / 2;
  const r = size / 2 - 2;

  const circle = (x: number, y: number, soft = 0.06) => {
    const d = Math.hypot(x - cx, y - cx) / r;
    return clamp01((1 - d) / soft);
  };

  switch (shape) {
    case 'round': {
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) out[y * size + x] = circle(x, y);
      break;
    }
    case 'chalk': {
      // grainy, torn-edged disc
      const n = fractal(size, 601, 4, 8);
      const g = fractal(size, 602, 2, 32);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const edge = circle(x, y, 0.35); // wide soft rim to modulate
          const tear = clamp01((n[i] - 0.25) * 2.2);
          const grain = 0.55 + g[i] * 0.65;
          out[i] = clamp01(edge * tear * grain * 1.35);
        }
      }
      break;
    }
    case 'spatter': {
      // many droplets inside the tip radius
      const rng = mulberry32(701);
      for (let k = 0; k < 170; k++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.sqrt(rng()) * r * 0.92;
        const bx = cx + Math.cos(ang) * rad;
        const by = cx + Math.sin(ang) * rad;
        const br = 1.5 + rng() * rng() * 9;
        const a = 0.45 + rng() * 0.55;
        const ri = Math.ceil(br + 1);
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            const x = Math.round(bx + dx);
            const y = Math.round(by + dy);
            if (x < 0 || y < 0 || x >= size || y >= size) continue;
            const d = Math.hypot(dx, dy);
            const fall = clamp01((br - d) / 1.5);
            const i = y * size + x;
            out[i] = Math.max(out[i], a * fall);
          }
        }
      }
      break;
    }
    case 'grain': {
      const g = fractal(size, 801, 3, 24);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = y * size + x;
          const body = circle(x, y, 0.25);
          const speck = clamp01((g[i] - 0.35) * 2.8);
          out[i] = clamp01(body * speck * 1.2);
        }
      }
      break;
    }
  }
  return { size, data: toBytes(out) };
}

// ---------------------------------------------------------------------------
// Dual-brush tiles
//
// Photoshop's dual brush stamps a secondary tip along the stroke with its own
// spacing/scatter/count and combines it with the primary coverage. We
// approximate that by pre-baking the secondary tip train into a tileable
// 256x256 map (grid placement + scatter jitter, wrap-around drawing) that the
// stamp shader samples in document space.
// ---------------------------------------------------------------------------

const DUAL_TILE = 256;

function makeDualTile(dual: DualBrush): GrayMap {
  const size = DUAL_TILE;
  const out = new Float32Array(size * size);
  const rng = mulberry32(0xd0a1);
  const tip = getTip(dual.shape);
  const tipSize = Math.max(3, Math.min(dual.size, size));
  const step = Math.max(tipSize * Math.max(dual.spacing, 0.05), 3);
  const jitter = dual.scatter * tipSize;

  const drawTip = (cx: number, cy: number, gain: number) => {
    const half = tipSize / 2;
    const lo = Math.floor(-half);
    const hi = Math.ceil(half);
    for (let dy = lo; dy <= hi; dy++) {
      for (let dx = lo; dx <= hi; dx++) {
        // sample the tip alpha map
        const u = (dx / tipSize + 0.5) * tip.size;
        const v = (dy / tipSize + 0.5) * tip.size;
        if (u < 0 || v < 0 || u >= tip.size || v >= tip.size) continue;
        const a = (tip.data[(v | 0) * tip.size + (u | 0)] / 255) * gain;
        if (a <= 0) continue;
        const x = ((Math.round(cx + dx) % size) + size) % size;
        const y = ((Math.round(cy + dy) % size) + size) % size;
        const i = y * size + x;
        out[i] = Math.max(out[i], a);
      }
    }
  };

  for (let gy = 0; gy < size / step; gy++) {
    for (let gx = 0; gx < size / step; gx++) {
      const n = Math.max(1, Math.round(dual.count * (0.6 + rng() * 0.4)));
      for (let k = 0; k < n; k++) {
        let x = gx * step + rng() * step;
        let y = gy * step + rng() * step;
        if (jitter > 0) {
          if (dual.bothAxes) {
            x += (rng() * 2 - 1) * jitter;
            y += (rng() * 2 - 1) * jitter;
          } else {
            y += (rng() * 2 - 1) * jitter;
          }
        }
        drawTip(x, y, 0.75 + rng() * 0.25);
      }
    }
  }
  return { size, data: toBytes(out) };
}

const patternCache = new Map<PatternId, GrayMap>();
const tipCache = new Map<TipShape, GrayMap>();
const dualCache = new Map<string, GrayMap>();

export function getPattern(id: PatternId): GrayMap {
  let p = patternCache.get(id);
  if (!p) {
    p = makePattern(id);
    patternCache.set(id, p);
  }
  return p;
}

export function getTip(shape: TipShape): GrayMap {
  let t = tipCache.get(shape);
  if (!t) {
    t = makeTip(shape);
    tipCache.set(shape, t);
  }
  return t;
}

export function getDualTile(dual: DualBrush): GrayMap {
  const key = JSON.stringify([
    dual.shape,
    dual.size,
    dual.spacing,
    dual.scatter,
    dual.bothAxes,
    dual.count,
  ]);
  let t = dualCache.get(key);
  if (!t) {
    t = makeDualTile(dual);
    dualCache.set(key, t);
  }
  return t;
}
