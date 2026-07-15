import type { GrayMap } from './patterns';
import type { BrushPatch, DynamicControl, TextureBlend } from './types';

/**
 * Photoshop .abr brush file parser.
 *
 * Supports the legacy v1/v2 format (a flat list of sampled brushes) and the
 * modern v6/v7/v10 format (8BIM 'samp' section with the sampled tip bitmaps
 * plus an 8BIM 'desc' section carrying an Actions-style descriptor with the
 * brush names and dynamics). Tip bitmaps are always imported; descriptor
 * settings are mapped onto our engine best-effort (diameter, spacing, angle,
 * roundness, hardness, flips, shape/scatter/transfer/color dynamics, dual
 * brush, wet edges, noise, airbrush). Texture patterns ('patt' section) are
 * not imported.
 */

export interface AbrBrush {
  name: string;
  /** id of the sampled tip in `tips`, or null for a computed round brush */
  tipId: string | null;
  settings: BrushPatch;
}

export interface AbrResult {
  version: number;
  tips: Map<string, GrayMap>;
  brushes: AbrBrush[];
}

class Reader {
  private v: DataView;
  private buf: ArrayBuffer;
  pos = 0;

  constructor(buf: ArrayBuffer) {
    this.buf = buf;
    this.v = new DataView(buf);
  }

  get length(): number {
    return this.v.byteLength;
  }

  get remaining(): number {
    return this.v.byteLength - this.pos;
  }

  u8(): number {
    return this.v.getUint8(this.pos++);
  }

  i8(): number {
    return this.v.getInt8(this.pos++);
  }

  u16(): number {
    const x = this.v.getUint16(this.pos);
    this.pos += 2;
    return x;
  }

  i16(): number {
    const x = this.v.getInt16(this.pos);
    this.pos += 2;
    return x;
  }

  u32(): number {
    const x = this.v.getUint32(this.pos);
    this.pos += 4;
    return x;
  }

  i32(): number {
    const x = this.v.getInt32(this.pos);
    this.pos += 4;
    return x;
  }

  f64(): number {
    const x = this.v.getFloat64(this.pos);
    this.pos += 8;
    return x;
  }

  peekU32(): number {
    return this.v.getUint32(this.pos);
  }

  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  bytes(n: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.buf.slice(this.pos, this.pos + n));
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    this.pos += n;
  }

  /** Pascal string: u8 length + ascii chars. */
  pascal(): string {
    return this.ascii(this.u8());
  }

  /** Photoshop unicode string: u32 char count + UTF-16BE chars. */
  unicode(): string {
    const n = this.u32();
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = this.u16();
      if (c !== 0) s += String.fromCharCode(c);
    }
    return s;
  }

  /** Descriptor key: u32 length (0 means 4) + ascii. */
  key(): string {
    const n = this.u32();
    return this.ascii(n === 0 ? 4 : n).trim();
  }
}

/** PackBits RLE decode of exactly `expected` output bytes. */
function unpackBits(r: Reader, expected: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(expected);
  let o = 0;
  while (o < expected && r.remaining > 0) {
    const n = r.i8();
    if (n >= 0) {
      for (let i = 0; i <= n && o < expected; i++) out[o++] = r.u8();
    } else if (n !== -128) {
      const b = r.u8();
      for (let i = 0; i < 1 - n && o < expected; i++) out[o++] = b;
    }
  }
  return out;
}

/** Pads a possibly non-square bitmap into a square, centered GrayMap. */
function toSquareMap(data: Uint8Array, w: number, h: number): GrayMap {
  const size = Math.max(w, h);
  const out = new Uint8Array(size * size);
  const ox = Math.floor((size - w) / 2);
  const oy = Math.floor((size - h) / 2);
  for (let y = 0; y < h; y++) {
    out.set(data.subarray(y * w, (y + 1) * w), (y + oy) * size + ox);
  }
  return { size, data: out };
}

const MAX_TIP_DIM = 5000;

/** Reads one sampled-brush bitmap: rect, depth, compression, pixel data. */
function readSampledBitmap(r: Reader): GrayMap | null {
  const top = r.i32();
  const left = r.i32();
  const bottom = r.i32();
  const right = r.i32();
  const depth = r.i16();
  const compressed = r.u8() !== 0;
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0 || w > MAX_TIP_DIM || h > MAX_TIP_DIM) return null;
  if (depth !== 8 && depth !== 16) return null;

  let gray: Uint8Array;
  if (!compressed) {
    if (depth === 8) {
      gray = r.bytes(w * h);
    } else {
      gray = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = r.u16() >> 8;
    }
  } else {
    // per-row compressed byte counts, then PackBits rows
    const counts: number[] = [];
    for (let y = 0; y < h; y++) counts.push(r.i16());
    const bpr = w * (depth >> 3);
    gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const rowEnd = r.pos + counts[y];
      const row = unpackBits(r, bpr);
      r.pos = rowEnd;
      if (depth === 8) {
        gray.set(row, y * w);
      } else {
        for (let x = 0; x < w; x++) gray[y * w + x] = row[x * 2];
      }
    }
  }
  return toSquareMap(gray, w, h);
}

// ---------------------------------------------------------------------------
// Actions-format descriptor parsing
// ---------------------------------------------------------------------------

type DescValue =
  | number
  | boolean
  | string
  | null
  | { unit: string; value: number }
  | { enumType: string; enumValue: string }
  | DescValue[]
  | Descriptor;

interface Descriptor {
  [key: string]: DescValue;
}

function parseDescriptor(r: Reader): Descriptor {
  r.unicode(); // class name
  r.key(); // class id
  const count = r.u32();
  const out: Descriptor = {};
  for (let i = 0; i < count; i++) {
    const key = r.key();
    const type = r.ascii(4);
    out[key] = parseValue(r, type);
  }
  return out;
}

function parseValue(r: Reader, type: string): DescValue {
  switch (type) {
    case 'Objc':
    case 'GlbO':
      return parseDescriptor(r);
    case 'VlLs': {
      const n = r.u32();
      const items: DescValue[] = [];
      for (let i = 0; i < n; i++) {
        const t = r.ascii(4);
        items.push(parseValue(r, t));
      }
      return items;
    }
    case 'doub':
      return r.f64();
    case 'UntF': {
      const unit = r.ascii(4);
      return { unit, value: r.f64() };
    }
    case 'TEXT':
      return r.unicode();
    case 'enum': {
      const enumType = r.key();
      const enumValue = r.key();
      return { enumType, enumValue };
    }
    case 'long':
      return r.i32();
    case 'comp': {
      const hi = r.u32();
      const lo = r.u32();
      return hi * 0x100000000 + lo;
    }
    case 'bool':
      return r.u8() !== 0;
    case 'type':
    case 'GlbC':
      r.unicode();
      r.key();
      return null;
    case 'alis':
    case 'tdta':
    case 'Pth ': {
      const n = r.u32();
      r.skip(n);
      return null;
    }
    case 'obj ': {
      const n = r.u32();
      for (let i = 0; i < n; i++) {
        const t = r.ascii(4);
        switch (t) {
          case 'prop':
            r.unicode();
            r.key();
            r.key();
            break;
          case 'Clss':
            r.unicode();
            r.key();
            break;
          case 'Enmr':
            r.unicode();
            r.key();
            r.key();
            r.key();
            break;
          case 'rele':
            r.unicode();
            r.key();
            r.u32();
            break;
          case 'Idnt':
          case 'indx':
            r.u32();
            break;
          case 'name':
            r.unicode();
            r.key();
            r.unicode();
            break;
          default:
            throw new Error(`unknown reference type ${t}`);
        }
      }
      return null;
    }
    default:
      throw new Error(`unknown descriptor type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// Descriptor -> BrushSettings mapping (best-effort)
// ---------------------------------------------------------------------------

const isDesc = (v: DescValue | undefined): v is Descriptor =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !('unit' in v) && !('enumType' in v);

/** Narrowing helper: returns the value when it is a nested descriptor. */
function desc(v: DescValue | undefined): Descriptor | undefined {
  return isDesc(v) ? v : undefined;
}

function num(v: DescValue | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const value = (v as { value?: unknown }).value;
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function bool(v: DescValue | undefined): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function str(v: DescValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** bVTy control values used across ABR dynamics. */
const CONTROL_MAP: DynamicControl['source'][] = [
  'off', 'fade', 'pressure', 'tilt', 'rotation', 'rotation',
  'initial-direction', 'direction',
];

function mapControl(d: Descriptor | undefined): {
  control: DynamicControl;
  jitter: number;
  minimum: number;
} {
  if (!d) {
    return { control: { source: 'off', fadeSteps: 25 }, jitter: 0, minimum: 0 };
  }
  const idx = num(d['bVTy']) ?? 0;
  return {
    control: {
      source: CONTROL_MAP[idx] ?? 'off',
      fadeSteps: Math.max(1, num(d['fStp']) ?? 25),
    },
    // raw fraction; most consumers clamp to 0..1 but scatter can reach 10
    jitter: Math.max(0, (num(d['jitter']) ?? 0) / 100),
    minimum: clamp01((num(d['Mnm']) ?? 0) / 100),
  };
}

const BLEND_MAP: Record<string, TextureBlend> = {
  Mltp: 'multiply',
  Drkn: 'darken',
  Sbtr: 'subtract',
  blendSubtraction: 'subtract',
  Ovrl: 'overlay',
  CBrn: 'darken',
  linearBurn: 'subtract',
  Hght: 'height',
  linearHeight: 'height',
  hardMix: 'height',
};

function mapBlend(v: DescValue | undefined): TextureBlend {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const enumValue = (v as { enumValue?: unknown }).enumValue;
    if (typeof enumValue === 'string') return BLEND_MAP[enumValue] ?? 'multiply';
  }
  return 'multiply';
}

interface TipInfo {
  tipId: string | null;
  size?: number;
  angle?: number;
  roundness?: number;
  hardness?: number;
  spacing?: number;
  flipX?: boolean;
  flipY?: boolean;
}

function mapTip(tip: Descriptor | undefined): TipInfo {
  if (!tip) return { tipId: null };
  const spacingOn = bool(tip['Intr']);
  const spacing = num(tip['Spcn']) ?? num(tip['Spcg']);
  return {
    tipId: str(tip['sampledData']) ?? null,
    size: num(tip['Dmtr']),
    angle: num(tip['Angl']),
    roundness: num(tip['Rndn']),
    hardness: num(tip['Hrdn']),
    spacing:
      spacingOn === false ? 0.01 : spacing !== undefined ? spacing / 100 : undefined,
    flipX: bool(tip['flipX']),
    flipY: bool(tip['flipY']),
  };
}

/** Maps one brushPreset descriptor to a name/tip/settings triple. */
function mapBrushDescriptor(d: Descriptor): AbrBrush {
  const tipDesc = desc(d['Brsh']);
  const tip = mapTip(tipDesc);
  const settings: BrushPatch = {};
  const tipPatch: NonNullable<BrushPatch['tip']> = {};

  if (tip.size !== undefined) tipPatch.size = Math.min(Math.max(tip.size, 1), 1000);
  if (tip.angle !== undefined) tipPatch.angle = tip.angle;
  if (tip.roundness !== undefined) tipPatch.roundness = clamp01(tip.roundness / 100) || 0.01;
  if (tip.hardness !== undefined) tipPatch.hardness = clamp01(tip.hardness / 100);
  if (tip.spacing !== undefined) tipPatch.spacing = Math.max(tip.spacing, 0.01);
  if (tip.flipX !== undefined) tipPatch.flipX = tip.flipX;
  if (tip.flipY !== undefined) tipPatch.flipY = tip.flipY;
  settings.tip = tipPatch;

  // Shape Dynamics
  if (bool(d['useTipDynamics'])) {
    const size = mapControl(desc(d['szVr']));
    const angle = mapControl(desc(d['angleDynamics']));
    const round = mapControl(desc(d['roundnessDynamics']));
    settings.shape = {
      enabled: true,
      sizeJitter: clamp01(size.jitter),
      sizeControl: size.control,
      minDiameter: clamp01((num(d['minimumDiameter']) ?? 0) / 100) || size.minimum,
      angleJitter: clamp01(angle.jitter),
      angleControl: angle.control,
      roundnessJitter: clamp01(round.jitter),
      roundnessControl: round.control,
      minRoundness: clamp01((num(d['minimumRoundness']) ?? 25) / 100),
      flipXJitter: bool(d['flipX']) ?? false,
      flipYJitter: bool(d['flipY']) ?? false,
    };
  }

  // Scattering
  if (bool(d['useScatter'])) {
    const sc = mapControl(desc(d['scatterDynamics']));
    const cnt = mapControl(desc(d['countDynamics']));
    settings.scatter = {
      enabled: true,
      bothAxes: bool(d['bothAxes']) ?? false,
      // ABR stores scatter as a percentage that can reach 1000%; our model
      // uses 0..10 where 1.0 = 100% of the diameter
      scatter: Math.min(sc.jitter, 10),
      scatterControl: sc.control,
      count: Math.min(Math.max(num(d['Cnt']) ?? 1, 1), 16),
      countJitter: clamp01(cnt.jitter),
    };
  }

  // Transfer (paint dynamics)
  if (bool(d['usePaintDynamics'])) {
    const op = mapControl(desc(d['opVr']) ?? desc(d['prVr']));
    const fl = mapControl(desc(d['flVr']) ?? desc(d['flwV']));
    settings.transfer = {
      enabled: true,
      opacityJitter: clamp01(op.jitter),
      opacityControl: op.control,
      opacityMin: op.minimum,
      flowJitter: clamp01(fl.jitter),
      flowControl: fl.control,
      flowMin: fl.minimum,
    };
  }

  // Color Dynamics
  if (bool(d['useColorDynamics'])) {
    const fgbg = mapControl(desc(d['clVr']));
    settings.color = {
      enabled: true,
      applyPerTip: bool(d['perTip']) ?? true,
      fgBgJitter: clamp01(fgbg.jitter),
      fgBgControl: fgbg.control,
      hueJitter: clamp01((num(d['H']) ?? 0) / 100),
      satJitter: clamp01((num(d['Strt']) ?? 0) / 100),
      briJitter: clamp01((num(d['Brgh']) ?? 0) / 100),
      purity: Math.min(1, Math.max(-1, (num(d['purity']) ?? 0) / 100)),
    };
  }

  // Dual Brush
  const dualDesc = desc(d['dualBrush']);
  if (bool(d['useDualBrush']) && dualDesc) {
    const dualTipDesc = desc(dualDesc['Brsh']);
    const dualTip = mapTip(dualTipDesc);
    settings.dual = {
      enabled: true,
      shape: dualTip.tipId ?? 'round',
      hardness: dualTip.hardness !== undefined ? clamp01(dualTip.hardness / 100) : 1,
      mode: mapBlend(dualDesc['BlnM']),
      size: Math.min(Math.max(dualTip.size ?? 40, 1), 1000),
      spacing: Math.max(dualTip.spacing ?? 0.25, 0.01),
      scatter: Math.min(Math.max((num(dualDesc['Sctr']) ?? 0) / 100, 0), 10),
      bothAxes: bool(dualDesc['bothAxes']) ?? true,
      count: Math.min(Math.max(num(dualDesc['Cnt']) ?? 1, 1), 16),
    };
  }

  if (bool(d['Wtdg']) !== undefined) settings.wetEdges = bool(d['Wtdg']);
  if (bool(d['Nose']) !== undefined) settings.noise = bool(d['Nose']);
  if (bool(d['Rpt']) !== undefined) settings.airbrush = bool(d['Rpt']);

  return {
    name: str(d['Nm']) ?? '',
    tipId: tip.tipId,
    settings,
  };
}

// ---------------------------------------------------------------------------
// Top-level parsing
// ---------------------------------------------------------------------------

function parseV6(r: Reader, version: number, subVersion: number): AbrResult {
  const tips = new Map<string, GrayMap>();
  const sampleOrder: string[] = [];
  let described: AbrBrush[] = [];

  while (r.remaining >= 12) {
    const sig = r.ascii(4);
    if (sig !== '8BIM') break;
    const key = r.ascii(4);
    const len = r.u32();
    const end = r.pos + len + ((4 - (len % 4)) % 4);

    if (key === 'samp') {
      while (r.pos < end - 4) {
        const brushLen = r.u32();
        const brushEnd = r.pos + brushLen + ((4 - (brushLen % 4)) % 4);
        try {
          const start = r.pos;
          const id = r.pascal();
          // header padding after the id: 10 bytes (subversion 1) or 264 (2)
          r.pos = start + id.length + 1 + (subVersion === 1 ? 10 : 264);
          const map = readSampledBitmap(r);
          if (map && id) {
            tips.set(id, map);
            sampleOrder.push(id);
          }
        } catch {
          // skip malformed brush records
        }
        r.pos = brushEnd;
      }
    } else if (key === 'desc') {
      try {
        if (r.peekU32() === 16) r.u32(); // versioned descriptor prefix
        const desc = parseDescriptor(r);
        const list = desc['Brsh'];
        if (Array.isArray(list)) {
          described = list.filter(isDesc).map(mapBrushDescriptor);
        }
      } catch (err) {
        console.warn('[northlight] ABR descriptor parse failed:', err);
      }
    }
    r.pos = end;
  }

  // Prefer descriptor entries (they carry names + dynamics); fall back to
  // bare sampled tips when there is no usable descriptor.
  let brushes: AbrBrush[];
  if (described.length > 0) {
    brushes = described.filter((b) => b.tipId === null || tips.has(b.tipId));
  } else {
    brushes = sampleOrder.map((id, i) => ({
      name: `Brush ${i + 1}`,
      tipId: id,
      settings: {},
    }));
  }
  return { version, tips, brushes };
}

function parseV12(r: Reader, version: number): AbrResult {
  const tips = new Map<string, GrayMap>();
  const brushes: AbrBrush[] = [];
  const count = r.u16();

  for (let i = 0; i < count && r.remaining > 6; i++) {
    const type = r.u16();
    const size = r.u32();
    const end = r.pos + size;
    try {
      if (type === 2) {
        r.u32(); // misc
        const spacing = r.u16();
        let name = '';
        if (version === 2) name = r.unicode();
        r.u8(); // antialiasing
        r.skip(8); // short bounds
        const map = readSampledBitmap(r);
        if (map) {
          const id = `v${version}-tip-${i}`;
          tips.set(id, map);
          brushes.push({
            name: name || `Brush ${i + 1}`,
            tipId: id,
            settings: {
              tip: {
                size: Math.min(map.size, 1000),
                spacing: Math.max(spacing / 100, 0.01),
              },
            },
          });
        }
      }
      // type 1 (computed) brushes carry little useful data; skip them
    } catch {
      // skip malformed brush records
    }
    r.pos = end;
  }
  return { version, tips, brushes };
}

export function parseAbr(buf: ArrayBuffer): AbrResult {
  const r = new Reader(buf);
  if (r.length < 4) throw new Error('Not an ABR file (too short).');
  const version = r.u16();
  if (version === 1 || version === 2) {
    return parseV12(r, version);
  }
  if (version === 6 || version === 7 || version === 10) {
    const subVersion = r.u16();
    return parseV6(r, version, subVersion);
  }
  throw new Error(`Unsupported ABR version ${version}.`);
}
