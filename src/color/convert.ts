import type { HSV } from '../types';

export interface RGB {
  /** 0..1 each */
  r: number;
  g: number;
  b: number;
}

export interface Lab {
  /** 0..100 */
  l: number;
  /** roughly -128..127 */
  a: number;
  b: number;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ---------------------------------------------------------------------------
// HSV (a.k.a. HSB) <-> RGB
// ---------------------------------------------------------------------------

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const hh = (((h % 360) + 360) % 360) / 60;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i) {
    case 0: return { r: v, g: t, b: p };
    case 1: return { r: q, g: v, b: p };
    case 2: return { r: p, g: v, b: t };
    case 3: return { r: p, g: q, b: v };
    case 4: return { r: t, g: p, b: v };
    default: return { r: v, g: p, b: q };
  }
}

/** Converts to HSV. When the color is achromatic, `hueHint` preserves the UI hue. */
export function rgbToHsv({ r, g, b }: RGB, hueHint = 0): HSV {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = hueHint;
  if (d > 1e-9) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    h = ((h % 360) + 360) % 360;
  }
  const s = max <= 1e-9 ? 0 : d / max;
  return { h, s, v: max };
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

export function rgbToHex({ r, g, b }: RGB): string {
  const to = (x: number) =>
    Math.round(clamp(x, 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `${to(r)}${to(g)}${to(b)}`;
}

export function hexToRgb(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(m)) {
    return {
      r: parseInt(m[0] + m[0], 16) / 255,
      g: parseInt(m[1] + m[1], 16) / 255,
      b: parseInt(m[2] + m[2], 16) / 255,
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(m)) {
    return {
      r: parseInt(m.slice(0, 2), 16) / 255,
      g: parseInt(m.slice(2, 4), 16) / 255,
      b: parseInt(m.slice(4, 6), 16) / 255,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CIE Lab (D50, Bradford-adapted — the same setup Photoshop and CSS lab() use)
// ---------------------------------------------------------------------------

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

type Mat3 = number[]; // row-major, 9 entries

const LIN_SRGB_TO_XYZ_D65: Mat3 = [
  0.4123907992659595, 0.35758433938387796, 0.1804807884018343,
  0.21263900587151036, 0.7151686787677559, 0.07219231536073371,
  0.01933081871559185, 0.11919477979462599, 0.9505321522496607,
];

const XYZ_D65_TO_LIN_SRGB: Mat3 = [
  3.2409699419045213, -1.5373831775700935, -0.4986107602930033,
  -0.9692436362808798, 1.8759675015077206, 0.04155505740717561,
  0.05563007969699361, -0.20397695888897652, 1.0569715142428786,
];

// Bradford chromatic adaptation
const D65_TO_D50: Mat3 = [
  1.0479298208405488, 0.022946793341019088, -0.05019222954313557,
  0.029627815688159344, 0.990434484573249, -0.01707382502938514,
  -0.009243058152591178, 0.015055144896577895, 0.7518742899580008,
];

const D50_TO_D65: Mat3 = [
  0.9554734527042182, -0.023098536874261423, 0.0632593086610217,
  -0.028369706963208136, 1.0099954580058226, 0.021041398966943008,
  0.012314001688319899, -0.020507696433477912, 1.3303659366080753,
];

const D50_WHITE = [0.3457 / 0.3585, 1.0, (1.0 - 0.3457 - 0.3585) / 0.3585];

function mul3(m: Mat3, v: number[]): number[] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

const EPS = 216 / 24389; // (6/29)^3
const KAPPA = 24389 / 27;

export function rgbToLab({ r, g, b }: RGB): Lab {
  const lin = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const xyz = mul3(D65_TO_D50, mul3(LIN_SRGB_TO_XYZ_D65, lin));
  const f = xyz.map((v, i) => {
    const t = v / D50_WHITE[i];
    return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
  });
  return {
    l: 116 * f[1] - 16,
    a: 500 * (f[0] - f[1]),
    b: 200 * (f[1] - f[2]),
  };
}

/** Out-of-gamut results are clamped to sRGB. */
export function labToRgb({ l, a, b }: Lab): RGB {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const finv = (t: number) => {
    const t3 = t * t * t;
    return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
  };
  const xyz = [
    finv(fx) * D50_WHITE[0],
    (l > KAPPA * EPS ? fy * fy * fy : l / KAPPA) * D50_WHITE[1],
    finv(fz) * D50_WHITE[2],
  ];
  const lin = mul3(XYZ_D65_TO_LIN_SRGB, mul3(D50_TO_D65, xyz));
  return {
    r: clamp(linearToSrgb(lin[0]), 0, 1),
    g: clamp(linearToSrgb(lin[1]), 0, 1),
    b: clamp(linearToSrgb(lin[2]), 0, 1),
  };
}
