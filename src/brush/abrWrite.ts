import { getPattern, getTip } from './patterns';
import type { BrushSettings, DynamicControl, TextureBlend } from './types';
import type { BlendMode } from '../types';

/**
 * Photoshop .abr writer — the inverse of `abr.ts`.
 *
 * Emits a version 6.2 container: an `8BIM samp` section holding the tip alpha
 * maps (PackBits-compressed), an `8BIM patt` section holding the texture
 * patterns the brushes reference, and an `8BIM desc` section holding one
 * Actions-format `brushPreset` descriptor per brush.
 *
 * Every descriptor key written here is one `abr.ts` reads, and those key names
 * were recorded from real Photoshop files (see the parser's notes and the test
 * fixtures) — so the settings half of the format is grounded in observed data,
 * and `abrRoundTrip` in the test suite proves the writer and reader agree.
 *
 * The one part that is NOT verifiable from inside this repo is the fixed
 * header of a `samp` record: everything between the tip's UUID and its bitmap
 * rectangle. GIMP's loader documents only its size (47 bytes for subversion 1,
 * 301 for subversion 2+) and skips it, so this writer emits the UUID and zeroes
 * the rest. Photoshop may or may not care about those bytes; nothing here can
 * settle that. See docs/alla-prima-brushes.md.
 */

// ---------------------------------------------------------------------------
// big-endian writer
// ---------------------------------------------------------------------------

class Writer {
  private bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  u8(x: number): this {
    this.bytes.push(x & 0xff);
    return this;
  }

  u16(x: number): this {
    return this.u8(x >> 8).u8(x);
  }

  u32(x: number): this {
    return this.u16(Math.floor(x / 0x10000)).u16(x);
  }

  i32(x: number): this {
    return this.u32(x < 0 ? x + 0x100000000 : x);
  }

  f64(x: number): this {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    for (let i = 0; i < 8; i++) this.u8(dv.getUint8(i));
    return this;
  }

  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }

  /** Photoshop unicode string: u32 char count + UTF-16BE chars. */
  unicode(s: string): this {
    this.u32(s.length);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this;
  }

  /** Pascal string: u8 length + ascii. */
  pascal(s: string): this {
    return this.u8(s.length).ascii(s);
  }

  /** Descriptor key: u32 length (0 means exactly 4 chars) + ascii. */
  key(s: string): this {
    return s.length === 4 ? this.u32(0).ascii(s) : this.u32(s.length).ascii(s);
  }

  raw(data: ArrayLike<number>): this {
    for (let i = 0; i < data.length; i++) this.u8(data[i]);
    return this;
  }

  concat(w: Writer): this {
    return this.raw(w.bytes);
  }

  /** Zero-pads to the next multiple of `n`. */
  align(n: number): this {
    while (this.bytes.length % n !== 0) this.u8(0);
    return this;
  }

  buffer(): ArrayBuffer {
    return new Uint8Array(this.bytes).buffer;
  }
}

/**
 * PackBits-encodes one row. Photoshop's own encoder emits a literal run for
 * anything shorter than three repeats, which is what this reproduces.
 */
function packBits(row: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    // how long is the repeat starting here?
    let run = 1;
    while (run < 128 && i + run < row.length && row[i + run] === row[i]) run++;
    if (run >= 3) {
      out.push(256 - (run - 1), row[i]);
      i += run;
      continue;
    }
    // literal run: copy until a repeat of three or more starts
    let lit = 0;
    while (i + lit < row.length && lit < 128) {
      const a = row[i + lit];
      if (
        lit + 2 < 128 &&
        i + lit + 2 < row.length &&
        row[i + lit + 1] === a &&
        row[i + lit + 2] === a
      ) {
        break;
      }
      lit++;
    }
    out.push(lit - 1);
    for (let k = 0; k < lit; k++) out.push(row[i + k]);
    i += lit;
  }
  return out;
}

/** Photoshop's compressed-rows image: per-row byte counts, then packed rows. */
function rleRows(data: Uint8Array, w: number, h: number): { counts: number[]; body: number[] } {
  const counts: number[] = [];
  const body: number[] = [];
  for (let y = 0; y < h; y++) {
    const packed = packBits(data.subarray(y * w, (y + 1) * w));
    counts.push(packed.length);
    body.push(...packed);
  }
  return { counts, body };
}

// ---------------------------------------------------------------------------
// descriptor values
// ---------------------------------------------------------------------------

type Emit = (w: Writer) => void;
type Entry = [string, Emit];

function writeDescriptor(w: Writer, classId: string, items: Entry[]): void {
  w.unicode(''); // class name — Photoshop leaves this empty for these
  w.key(classId);
  w.u32(items.length);
  for (const [k, emit] of items) {
    w.key(k);
    emit(w);
  }
}

const V = {
  untf: (unit: string, v: number): Emit => (w) => {
    w.ascii('UntF').ascii(unit).f64(v);
  },
  pct: (v: number): Emit => V.untf('#Prc', v),
  px: (v: number): Emit => V.untf('#Pxl', v),
  ang: (v: number): Emit => V.untf('#Ang', v),
  text: (s: string): Emit => (w) => {
    w.ascii('TEXT').unicode(s);
  },
  bool: (b: boolean): Emit => (w) => {
    w.ascii('bool').u8(b ? 1 : 0);
  },
  long: (n: number): Emit => (w) => {
    w.ascii('long').i32(Math.round(n));
  },
  doub: (n: number): Emit => (w) => {
    w.ascii('doub').f64(n);
  },
  enm: (type: string, value: string): Emit => (w) => {
    w.ascii('enum').key(type).key(value);
  },
  objc: (classId: string, items: Entry[]): Emit => (w) => {
    w.ascii('Objc');
    writeDescriptor(w, classId, items);
  },
  list: (items: Emit[]): Emit => (w) => {
    w.ascii('VlLs').u32(items.length);
    for (const emit of items) emit(w);
  },
};

/** Inverse of the parser's CONTROL_MAP (bVTy index per control source). */
const CONTROL_INDEX: Record<DynamicControl['source'], number> = {
  off: 0,
  fade: 1,
  pressure: 2,
  tilt: 3,
  'initial-direction': 5,
  direction: 6,
  rotation: 7,
};

/** A dynamics variance object: control source, fade steps, jitter, minimum. */
function dyn(control: DynamicControl, jitter: number, minimum = 0): Emit {
  return V.objc('null', [
    ['bVTy', V.long(CONTROL_INDEX[control.source] ?? 0)],
    ['fStp', V.long(Math.max(1, Math.round(control.fadeSteps)))],
    ['jitter', V.pct(jitter * 100)],
    ['Mnm ', V.pct(minimum * 100)],
  ]);
}

/** Inverse of the parser's BLEND_MAP, using the keys Photoshop writes. */
const TEX_BLEND_KEY: Record<TextureBlend, string> = {
  multiply: 'Mltp',
  subtract: 'Sbtr',
  darken: 'Drkn',
  overlay: 'Ovrl',
  height: 'Hght',
  lighten: 'Lghn',
  screen: 'Scrn',
  'color-dodge': 'CDdg',
  'color-burn': 'CBrn',
  'linear-burn': 'linearBurn',
  'hard-mix': 'hardMix',
};

/** Inverse of the parser's PAINT_MODE_MAP. */
const PAINT_MODE_KEY: Partial<Record<BlendMode, string>> = {
  normal: 'Nrml',
  darken: 'Drkn',
  multiply: 'Mltp',
  'color-burn': 'CBrn',
  'linear-burn': 'linearBurn',
  lighten: 'Lghn',
  screen: 'Scrn',
  'color-dodge': 'CDdg',
  'linear-dodge': 'linearDodge',
  overlay: 'Ovrl',
  'soft-light': 'SftL',
  'hard-light': 'HrdL',
  'vivid-light': 'vividLight',
  'linear-light': 'linearLight',
  'pin-light': 'pinLight',
  difference: 'Dfrn',
  exclusion: 'Xclu',
  subtract: 'blendSubtraction',
  divide: 'blendDivide',
  hue: 'H   ',
  saturation: 'Strt',
  color: 'Clr ',
  luminosity: 'Lmns',
};

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A stable 36-character UUID derived from a name, so re-exporting the same
 * brush set produces byte-identical ids (and re-importing does not pile up
 * duplicate tips).
 */
export function stableUuid(seed: string): string {
  const hex: string[] = [];
  let state = fnv1a(seed);
  for (let i = 0; i < 16; i++) {
    state = (Math.imul(state ^ (state >>> 13), 0x01000193) + fnv1a(seed + i)) >>> 0;
    hex.push(((state >>> 8) & 0xff).toString(16).padStart(2, '0'));
  }
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// baking what the format cannot carry
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/**
 * Tip angle and roundness as Photoshop will see them.
 *
 * Photoshop has Brush Pose and Brush Projection, but this repo has no recorded
 * descriptor keys for either — the parser never needed them, and guessing key
 * names would produce a file that silently drops the settings. So where a
 * preset holds a fixed attitude through Brush Pose overrides and projects it,
 * the resulting attitude is baked into the tip's own Angle and Roundness, which
 * ARE keys the format is known to carry. The exported brush then makes the same
 * mark; it just is not adjustable by tilting the pen.
 */
export function bakedAttitude(s: BrushSettings): { angle: number; roundness: number } {
  const { pose, shape, tip } = s;
  if (!shape.brushProjection || !pose.enabled) {
    return { angle: tip.angle, roundness: tip.roundness };
  }
  const tiltX = pose.overrideTiltX ? pose.tiltX : 0;
  const tiltY = pose.overrideTiltY ? pose.tiltY : 0;
  const twist = pose.overrideRotation ? pose.rotation : 0;
  const tilt = Math.hypot(tiltX, tiltY) * DEG;
  if (tilt <= DEG) return { angle: tip.angle, roundness: tip.roundness };

  // dynamics.ts builds the stamp angle in y-down radians as
  //   -tipAngle + azimuth + twist
  // and Photoshop's Angle is the counter-clockwise-positive degrees that
  // negates into it, so undo both steps.
  const azimuth = Math.atan2(tiltY, tiltX) / DEG;
  let angle = tip.angle - azimuth - twist;
  angle = ((((angle + 180) % 360) + 360) % 360) - 180;
  return {
    angle,
    roundness: Math.max(tip.roundness * Math.cos(Math.min(tilt, Math.PI / 2)), shape.minRoundness),
  };
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

/** Fixed header size of a samp record, measured from the start of the record. */
const SAMP_HEADER = 301; // subversion 2+; GIMP uses 47 for subversion 1

function sampSection(tips: { uuid: string; map: { size: number; data: Uint8Array } }[]): Writer {
  const out = new Writer();
  for (const { uuid, map } of tips) {
    const rec = new Writer();
    rec.pascal(uuid);
    while (rec.length < SAMP_HEADER) rec.u8(0);
    rec.i32(0).i32(0).i32(map.size).i32(map.size); // top, left, bottom, right
    rec.u16(8); // depth
    rec.u8(1); // PackBits-compressed
    const { counts, body } = rleRows(map.data, map.size, map.size);
    for (const c of counts) rec.u16(c);
    rec.raw(body);
    out.u32(rec.length).concat(rec).align(4);
  }
  return out;
}

/**
 * One `patt` entry: a grayscale (imageMode 1) VirtualMemoryArrayList image.
 * Layout per the parser's validated note.
 */
function pattSection(
  patterns: { uuid: string; name: string; map: { size: number; data: Uint8Array } }[],
): Writer {
  const out = new Writer();
  for (const { uuid, name, map } of patterns) {
    const entry = new Writer();
    entry.u32(1); // version
    entry.u32(1); // image mode: grayscale
    entry.u16(map.size).u16(map.size); // height, width
    entry.unicode(name);
    entry.pascal(uuid);

    const channel = new Writer();
    channel.u32(8); // depth
    channel.i32(0).i32(0).i32(map.size).i32(map.size);
    channel.u16(8); // pixel depth
    channel.u8(1); // compressed
    const { counts, body } = rleRows(map.data, map.size, map.size);
    for (const c of counts) channel.u16(c);
    channel.raw(body);

    const vma = new Writer();
    vma.i32(0).i32(0).i32(map.size).i32(map.size); // rectangle
    vma.u32(24); // max channels
    vma.u32(1); // channel written
    vma.u32(channel.length).concat(channel);
    for (let i = 0; i < 26; i++) vma.u32(0); // remaining channels not written

    entry.u32(3).u32(vma.length).concat(vma);
    out.u32(entry.length).concat(entry).align(4);
  }
  return out;
}

/** The per-brush tip descriptor (`Brsh`). */
function tipDescriptor(
  s: BrushSettings,
  sampledUuid: string | null,
  override?: { angle: number; roundness: number },
): Emit {
  const angle = override ? override.angle : s.tip.angle;
  const roundness = override ? override.roundness : s.tip.roundness;
  const items: Entry[] = [
    ['Dmtr', V.px(s.tip.size)],
    ['Angl', V.ang(angle)],
    ['Rndn', V.pct(roundness * 100)],
    ['Hrdn', V.pct(s.tip.hardness * 100)],
    ['Spcn', V.pct(s.tip.spacing * 100)],
    ['Intr', V.bool(true)],
    ['flipX', V.bool(s.tip.flipX)],
    ['flipY', V.bool(s.tip.flipY)],
  ];
  if (sampledUuid) items.push(['sampledData', V.text(sampledUuid)]);
  return V.objc('null', items);
}

/** One brush's full descriptor. */
function brushDescriptor(
  name: string,
  s: BrushSettings,
  tipUuid: string | null,
  dualTipUuid: string | null,
  patternUuid: string | null,
  patternName: string,
): Emit {
  const attitude = bakedAttitude(s);
  const items: Entry[] = [
    ['Nm  ', V.text(name)],
    ['Brsh', tipDescriptor(s, tipUuid, attitude)],
    ['useTipDynamics', V.bool(s.shape.enabled)],
  ];

  if (s.shape.enabled) {
    items.push(
      ['szVr', dyn(s.shape.sizeControl, s.shape.sizeJitter)],
      ['angleDynamics', dyn(s.shape.angleControl, s.shape.angleJitter)],
      ['roundnessDynamics', dyn(s.shape.roundnessControl, s.shape.roundnessJitter)],
      ['minimumDiameter', V.pct(s.shape.minDiameter * 100)],
      ['minimumRoundness', V.pct(s.shape.minRoundness * 100)],
      // top-level flips are the flip JITTERS; the tip's own flips are inside Brsh
      ['flipX', V.bool(s.shape.flipXJitter)],
      ['flipY', V.bool(s.shape.flipYJitter)],
    );
  }

  items.push(['useScatter', V.bool(s.scatter.enabled)]);
  if (s.scatter.enabled) {
    items.push(
      ['scatterDynamics', dyn(s.scatter.scatterControl, s.scatter.scatter)],
      ['countDynamics', dyn(s.scatter.countControl, s.scatter.countJitter)],
      ['Cnt ', V.long(s.scatter.count)],
      ['bothAxes', V.bool(s.scatter.bothAxes)],
    );
  }

  items.push(['useTexture', V.bool(s.texture.enabled && patternUuid !== null)]);
  if (s.texture.enabled && patternUuid) {
    items.push(
      ['Txtr', V.objc('null', [['Idnt', V.text(patternUuid)], ['Nm  ', V.text(patternName)]])],
      ['textureScale', V.pct(s.texture.scale * 100)],
      ['textureBrightness', V.long(s.texture.brightness * 150)],
      ['textureContrast', V.long(s.texture.contrast * 100)],
      ['InvT', V.bool(s.texture.invert)],
      ['textureBlendMode', V.enm('BlnM', TEX_BLEND_KEY[s.texture.mode])],
      ['textureDepth', V.pct(s.texture.depth * 100)],
      ['TxtC', V.bool(s.texture.textureEachTip)],
      ['textureDepthDynamics', dyn(s.texture.depthControl, s.texture.depthJitter, s.texture.minDepth)],
      // Photoshop's own Minimum Depth slider, alongside the variance object's
      // minimum so either reader finds it
      ['minimumDepth', V.pct(s.texture.minDepth * 100)],
    );
  }

  items.push(['usePaintDynamics', V.bool(s.transfer.enabled)]);
  if (s.transfer.enabled) {
    items.push(
      ['opVr', dyn(s.transfer.opacityControl, s.transfer.opacityJitter, s.transfer.opacityMin)],
      ['prVr', dyn(s.transfer.flowControl, s.transfer.flowJitter, s.transfer.flowMin)],
    );
  }

  items.push(['useColorDynamics', V.bool(s.color.enabled)]);
  if (s.color.enabled) {
    items.push(
      ['clVr', dyn(s.color.fgBgControl, s.color.fgBgJitter)],
      ['H   ', V.long(s.color.hueJitter * 100)],
      ['Strt', V.long(s.color.satJitter * 100)],
      ['Brgh', V.long(s.color.briJitter * 100)],
      ['purity', V.long(s.color.purity * 100)],
      ['colorDynamicsPerTip', V.bool(s.color.applyPerTip)],
    );
  }

  if (s.dual.enabled) {
    items.push([
      'dualBrush',
      V.objc('null', [
        ['useDualBrush', V.bool(true)],
        [
          'Brsh',
          V.objc('null', [
            ['Dmtr', V.px(s.dual.size)],
            ['Angl', V.ang(0)],
            ['Rndn', V.pct(100)],
            ['Hrdn', V.pct(s.dual.hardness * 100)],
            // the panel's Spacing slider lives on the nested tip
            ['Spcn', V.pct(s.dual.spacing * 100)],
            ['Intr', V.bool(true)],
            ...(dualTipUuid ? ([['sampledData', V.text(dualTipUuid)]] as Entry[]) : []),
          ]),
        ],
        ['BlnM', V.enm('BlnM', TEX_BLEND_KEY[s.dual.mode])],
        ['Spcn', V.pct(s.dual.spacing * 100)],
        ['scatterDynamics', dyn({ source: 'off', fadeSteps: 25 }, s.dual.scatter)],
        ['countDynamics', dyn({ source: 'off', fadeSteps: 25 }, s.dual.countJitter)],
        ['Cnt ', V.long(s.dual.count)],
        ['bothAxes', V.bool(s.dual.bothAxes)],
      ]),
    ]);
  }

  items.push(
    ['Wtdg', V.bool(s.wetEdges)],
    ['Nose', V.bool(s.noise)],
    ['Rpt ', V.bool(s.airbrush)],
    [
      'toolOptions',
      V.objc('null', [
        ['Opct', V.pct(s.opacity * 100)],
        ['flow', V.pct(s.flow * 100)],
        ['smoothingValue', V.long(s.smoothing * 100)],
        ['Md  ', V.enm('BlnM', PAINT_MODE_KEY[s.blendMode] ?? 'Nrml')],
        ['usePressureOverridesSize', V.bool(s.pressureSize)],
        ['usePressureOverridesOpacity', V.bool(s.pressureOpacity)],
      ]),
    ],
  );

  return V.objc('null', items);
}

// ---------------------------------------------------------------------------
// top level
// ---------------------------------------------------------------------------

export interface AbrExportBrush {
  name: string;
  settings: BrushSettings;
}

/**
 * Serializes brushes to a Photoshop .abr (version 6.2) file.
 *
 * Any tip that is not the analytic round one is written into the `samp`
 * section as a sampled tip — which is what a generated bristle tip has to
 * become, since it is a bitmap and not one of Photoshop's computed shapes.
 * Texture patterns the brushes reference are written into `patt`.
 */
export function writeAbr(brushes: AbrExportBrush[]): ArrayBuffer {
  const tipUuids = new Map<string, string>();
  const tipList: { uuid: string; map: { size: number; data: Uint8Array } }[] = [];
  const tipFor = (shape: string): string | null => {
    if (shape === 'round') return null;
    let uuid = tipUuids.get(shape);
    if (!uuid) {
      uuid = stableUuid(`northlight-tip:${shape}`);
      tipUuids.set(shape, uuid);
      tipList.push({ uuid, map: getTip(shape) });
    }
    return uuid;
  };

  const patUuids = new Map<string, string>();
  const patList: { uuid: string; name: string; map: { size: number; data: Uint8Array } }[] = [];
  const patFor = (pattern: string): string => {
    let uuid = patUuids.get(pattern);
    if (!uuid) {
      uuid = stableUuid(`northlight-pattern:${pattern}`);
      patUuids.set(pattern, uuid);
      patList.push({
        uuid,
        name: pattern.charAt(0).toUpperCase() + pattern.slice(1),
        map: getPattern(pattern),
      });
    }
    return uuid;
  };

  const entries = brushes.map(({ name, settings }) =>
    brushDescriptor(
      name,
      settings,
      tipFor(settings.tip.shape),
      settings.dual.enabled ? tipFor(settings.dual.shape) : null,
      settings.texture.enabled ? patFor(settings.texture.pattern) : null,
      settings.texture.enabled
        ? settings.texture.pattern.charAt(0).toUpperCase() + settings.texture.pattern.slice(1)
        : '',
    ),
  );

  const descBody = new Writer();
  descBody.u32(16); // versioned-descriptor prefix
  writeDescriptor(descBody, 'null', [['Brsh', V.list(entries)]]);

  const file = new Writer();
  file.u16(6).u16(2); // version 6, subversion 2

  const section = (key: string, body: Writer) => {
    if (body.length === 0) return;
    file.ascii('8BIM').ascii(key).u32(body.length).concat(body).align(4);
  };
  section('samp', sampSection(tipList));
  section('patt', pattSection(patList));
  section('desc', descBody);
  return file.buffer();
}
