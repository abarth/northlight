import { makeBrush, pressureControl } from './defaults';
import type { BrushSettings, TextureBlend, TipShape } from './types';

export interface BrushPreset {
  id: string;
  name: string;
  settings: BrushSettings;
}

export interface BrushGroup {
  id: string;
  name: string;
  presets: BrushPreset[];
}

const p = (id: string, name: string, settings: BrushSettings): BrushPreset => ({
  id,
  name,
  settings,
});

/**
 * Oil & Fresco brushes: a dual brush plus the two knobs that shape it.
 *
 * EDGE comes from K = flow / spacing. Accumulating N overlapping dabs of
 * flow f gives A(r) = 1 - exp(-K * sqrt(1 - (r/R)^2) * a(r)) for a tip
 * profile a(r), so a large K squares the cross-section off into a hard flank
 * while a small one lets the stroke keep the tip's own falloff. Because N
 * collapses at the ends of a stroke, a low K also leaves the long translucent
 * terminal that Ol' Huckleberry gets from 10% flow at 5% spacing (K = 2).
 * Here K runs from 15 (Palette Knife) down to 1.1 (Fresco Veil).
 *
 * NON-REPETITION comes from rho = dualScatter / dualSpacing. The dual mask is
 * the stamp train convolved with the tip, M(f) = T(f) * S(f); a spectral line
 * in S at the stamp frequency is the "same mark every N pixels" artifact, and
 * jitter attenuates it by the characteristic function of the offset
 * distribution, which falls off with rho. Every brush below keeps rho >= 3.1,
 * cutting the periodic amplitude to under a tenth of an unscattered train.
 * Both Axes is on everywhere and is not optional: across-stroke-only scatter
 * leaves the along-stroke coordinate untouched and does nothing at all for
 * repetition. The tips supply the other factor, a broadband T with no
 * characteristic blob size (see organicTips.ts).
 */
interface FrescoSpec {
  /** primary tip: sets the shape of the mark */
  tip: TipShape;
  size: number;
  /** primary spacing as a fraction of diameter; with flow this fixes K */
  spacing: number;
  flow: number;
  /** fixed tip angle in degrees; omit to let the tip follow the stroke */
  angle?: number;
  /** dual tip: supplies the organic texture */
  dual: TipShape;
  dualSize: number;
  dualSpacing: number;
  dualScatter: number;
  dualMode?: TextureBlend;
  dualCount?: number;
  /**
   * Primary Scattering: displaces individual dabs off the stroke spine, which
   * is the one mechanism here that lowers coverage without touching the tip
   * or the dual mask at all.
   */
  scatter?: number;
  scatterCount?: number;
  /**
   * Shape-jitter amount, default 0.05. The fan tips set it to 0 on purpose:
   * their hairs only draw as continuous strands if consecutive dabs land in
   * register, and any jitter smears the gaps closed.
   */
  jitter?: number;
  /** linen canvas tooth depth; omit for no texture */
  tooth?: number;
  opacity?: number;
}

const fresco = (s: FrescoSpec): BrushSettings =>
  makeBrush({
    tip: { shape: s.tip, size: s.size, spacing: s.spacing, angle: s.angle ?? 0 },
    shape: {
      enabled: true,
      // pressure -> size with no floor is what gives these brushes their taper
      sizeControl: pressureControl(),
      minDiameter: 0,
      sizeJitter: s.jitter ?? 0.05,
      // with no fixed angle the tip follows the stroke, like a dragged brush
      angleControl:
        s.angle === undefined
          ? { source: 'direction', fadeSteps: 25 }
          : { source: 'off', fadeSteps: 25 },
      angleJitter: s.jitter === 0 ? 0 : 0.02,
      roundnessJitter: s.jitter === 0 ? 0 : 0.1,
      minRoundness: 0.65,
      // No flip jitter on purpose: striations only read as dragged bristles
      // if consecutive stamps reinforce each other, and mirroring every stamp
      // scrubs them into mush. Decorrelation is the dual tip's job.
      flipXJitter: false,
      flipYJitter: false,
    },
    scatter: s.scatter
      ? {
          enabled: true,
          bothAxes: true,
          scatter: s.scatter,
          count: s.scatterCount ?? 2,
          countJitter: 0.4,
        }
      : { enabled: false },
    dual: {
      enabled: true,
      shape: s.dual,
      mode: s.dualMode ?? 'multiply',
      size: s.dualSize,
      // Overlapping dual stamps union together, so the mask saturates and the
      // texture washes out as ~1/spacing. These stay long enough to keep
      // holes, with scatter raised to hold rho >= 3.1.
      spacing: s.dualSpacing,
      scatter: s.dualScatter,
      bothAxes: true,
      count: s.dualCount ?? 1,
      countJitter: 0.3,
    },
    // document-anchored (textureEachTip off), so the tooth adds no
    // along-stroke period of its own
    texture: s.tooth
      ? {
          enabled: true,
          pattern: 'linen',
          scale: 1,
          mode: 'multiply',
          depth: s.tooth,
          contrast: 0.1,
          textureEachTip: false,
        }
      : { enabled: false },
    transfer: {
      enabled: true,
      flowControl: pressureControl(),
      flowMin: 0.25,
      flowJitter: 0.15,
    },
    flow: s.flow,
    opacity: s.opacity ?? 1,
    smoothing: 0.2,
  });

export const BRUSH_GROUPS: BrushGroup[] = [
  {
    id: 'general',
    name: 'General Brushes',
    presets: [
      p('soft-round', 'Soft Round', makeBrush({ tip: { hardness: 0, size: 40 } })),
      p('hard-round', 'Hard Round', makeBrush({ tip: { hardness: 1, size: 24 } })),
      p(
        'soft-round-pressure',
        'Soft Round Pressure',
        makeBrush({ tip: { hardness: 0, size: 48 }, pressureSize: true, pressureOpacity: true }),
      ),
      p(
        'airbrush-soft',
        'Airbrush Soft Low Density',
        makeBrush({
          tip: { hardness: 0, size: 96, spacing: 0.1 },
          airbrush: true,
          flow: 0.12,
          transfer: { enabled: true, flowControl: pressureControl() },
        }),
      ),
      p(
        'calligraphy-flat',
        'Flat Calligraphy',
        makeBrush({
          tip: { hardness: 0.9, size: 28, roundness: 0.25, angle: -40, spacing: 0.08 },
        }),
      ),
    ],
  },
  {
    id: 'size-flow',
    name: 'Size Flow (Pressure → Size)',
    presets: [
      p(
        'sf-soft',
        'Soft Round Size Flow',
        makeBrush({
          tip: { hardness: 0, size: 44 },
          shape: { enabled: true, sizeControl: pressureControl(), minDiameter: 0 },
        }),
      ),
      p(
        'sf-hard',
        'Hard Round Size Flow',
        makeBrush({
          tip: { hardness: 1, size: 28, spacing: 0.12 },
          shape: { enabled: true, sizeControl: pressureControl(), minDiameter: 0 },
        }),
      ),
      p(
        'sf-taper',
        'Tapered Inker',
        makeBrush({
          tip: { hardness: 0.95, size: 18, spacing: 0.06 },
          shape: { enabled: true, sizeControl: pressureControl(), minDiameter: 0.05 },
          smoothing: 0.45,
        }),
      ),
      p(
        'sf-sketch',
        'Sketching Size Flow',
        makeBrush({
          tip: { hardness: 0.8, size: 12, spacing: 0.15 },
          shape: { enabled: true, sizeControl: pressureControl(), minDiameter: 0.3 },
          transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.2 },
          flow: 0.85,
        }),
      ),
    ],
  },
  {
    id: 'opacity-flow',
    name: 'Opacity Flow (Pressure → Opacity)',
    presets: [
      p(
        'of-soft',
        'Soft Round Opacity Flow',
        makeBrush({
          tip: { hardness: 0, size: 44 },
          transfer: { enabled: true, opacityControl: pressureControl() },
        }),
      ),
      p(
        'of-hard',
        'Hard Round Opacity Flow',
        makeBrush({
          tip: { hardness: 1, size: 24, spacing: 0.12 },
          transfer: { enabled: true, opacityControl: pressureControl() },
        }),
      ),
      p(
        'of-shader',
        'Shader Opacity Flow',
        makeBrush({
          tip: { hardness: 0.35, size: 64, roundness: 0.6, angle: 35 },
          transfer: {
            enabled: true,
            opacityControl: pressureControl(),
            flowControl: pressureControl(),
            flowMin: 0.1,
          },
          flow: 0.6,
        }),
      ),
    ],
  },
  {
    id: 'dry-media',
    name: 'Dry Media',
    presets: [
      p(
        'pencil',
        'Graphite Pencil',
        makeBrush({
          tip: { shape: 'grain', size: 8, spacing: 0.12 },
          shape: {
            enabled: true,
            sizeControl: pressureControl(),
            minDiameter: 0.5, // pencils thin only a little with light pressure
            angleJitter: 0.2,
          },
          scatter: { enabled: true, bothAxes: true, scatter: 0.12, count: 2, countJitter: 0.3 },
          transfer: {
            enabled: true,
            opacityControl: pressureControl(),
            opacityMin: 0.05,
            flowJitter: 0.25,
          },
          noise: true,
          flow: 0.85,
          smoothing: 0.2,
        }),
      ),
      p(
        'charcoal',
        'Soft Charcoal',
        makeBrush({
          tip: { shape: 'chalk', size: 26, spacing: 0.15 },
          shape: { enabled: true, sizeControl: pressureControl(), minDiameter: 0.35, angleControl: { source: 'direction', fadeSteps: 25 } },
          texture: { enabled: true, pattern: 'paper', depth: 0.55, scale: 1.2 },
          transfer: { enabled: true, opacityControl: pressureControl(), opacityMin: 0.1 },
          flow: 0.9,
        }),
      ),
      p(
        'chalk',
        'Rough Chalk',
        makeBrush({
          tip: { shape: 'chalk', size: 42, spacing: 0.22 },
          shape: { enabled: true, angleJitter: 0.12 },
          texture: { enabled: true, pattern: 'canvas', depth: 0.7, mode: 'subtract' },
          transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.15 },
        }),
      ),
    ],
  },
  {
    id: 'wet-media',
    name: 'Wet Media',
    presets: [
      p(
        'sponge',
        'Sponge',
        makeBrush({
          tip: { hardness: 0.15, size: 90, spacing: 0.3 },
          texture: {
            enabled: true,
            pattern: 'sponge',
            depth: 0.85,
            scale: 1.4,
            mode: 'subtract',
          },
          dual: {
            enabled: true,
            shape: 'spatter',
            mode: 'multiply',
            size: 72,
            spacing: 0.4,
            scatter: 0.4,
            bothAxes: true,
            count: 2,
          },
          transfer: { enabled: true, opacityControl: pressureControl(), opacityMin: 0.1 },
          flow: 0.75,
        }),
      ),
      p(
        'watercolor',
        'Watercolor Wash',
        makeBrush({
          tip: { hardness: 0.1, size: 70, spacing: 0.18 },
          wetEdges: true,
          texture: { enabled: true, pattern: 'paper', depth: 0.35 },
          transfer: { enabled: true, opacityControl: pressureControl(), opacityMin: 0.15 },
          opacity: 0.8,
          flow: 0.5,
        }),
      ),
      p(
        'ink-wash',
        'Ink Wash',
        makeBrush({
          tip: { hardness: 0.3, size: 48, roundness: 0.85 },
          wetEdges: true,
          shape: { enabled: true, sizeControl: pressureControl(), minDiameter: 0.2 },
          flow: 0.65,
          smoothing: 0.35,
        }),
      ),
    ],
  },
  {
    id: 'fx',
    name: 'Special Effects',
    presets: [
      p(
        'spatter-spray',
        'Spatter Spray',
        makeBrush({
          tip: { shape: 'spatter', size: 60, spacing: 0.35 },
          shape: { enabled: true, angleJitter: 1, sizeJitter: 0.4 },
          scatter: { enabled: true, bothAxes: true, scatter: 0.8, count: 3, countJitter: 0.4 },
          transfer: { enabled: true, flowControl: pressureControl() },
        }),
      ),
      p(
        'scatter-dots',
        'Scattered Dots',
        makeBrush({
          tip: { hardness: 1, size: 10, spacing: 0.9 },
          scatter: { enabled: true, bothAxes: true, scatter: 2.4, count: 4, countJitter: 0.5 },
          shape: { enabled: true, sizeJitter: 0.6 },
        }),
      ),
      p(
        'confetti',
        'Color Confetti',
        makeBrush({
          tip: { hardness: 0.9, size: 14, roundness: 0.55, spacing: 1.1 },
          scatter: { enabled: true, bothAxes: true, scatter: 2, count: 3, countJitter: 0.3 },
          shape: { enabled: true, sizeJitter: 0.5, angleJitter: 1 },
          color: { enabled: true, applyPerTip: true, hueJitter: 0.25, satJitter: 0.2, briJitter: 0.25 },
        }),
      ),
    ],
  },
  {
    id: 'oil',
    name: 'Oil & Fresco',
    presets: [
      // --- hard edge (K >= 9): crisp flanks, for blocking and knife work ---
      p('palette-knife', 'Palette Knife', fresco({
        tip: 'blade-flat', size: 220, spacing: 0.04, flow: 0.6, angle: 30,
        dual: 'crackle-web', dualSize: 220, dualSpacing: 0.25, dualScatter: 0.8,
        tooth: 0.08,
      })),
      p('granite-block', 'Granite Block', fresco({
        tip: 'blade-flat', size: 200, spacing: 0.045, flow: 0.55,
        dual: 'granite-grit', dualSize: 240, dualSpacing: 0.22, dualScatter: 0.7,
        tooth: 0.13,
      })),
      p('impasto-chisel', 'Impasto Chisel', fresco({
        tip: 'bristle-chisel', size: 175, spacing: 0.05, flow: 0.5, angle: -20,
        dual: 'granite-grit', dualSize: 200, dualSpacing: 0.2, dualScatter: 0.65,
        tooth: 0.14,
      })),
      p('stone-edge', 'Stone Edge', fresco({
        tip: 'blade-flat', size: 140, spacing: 0.05, flow: 0.45,
        dual: 'sponge-fractal', dualSize: 170, dualSpacing: 0.22, dualScatter: 0.72,
        tooth: 0.11,
      })),

      // --- firm edge (K ~ 3-6): defined but broken, the everyday brushes ---
      p('fresco-sponge', 'Fresco Sponge', fresco({
        tip: 'bristle-chisel', size: 180, spacing: 0.06, flow: 0.35,
        dual: 'sponge-fractal', dualSize: 260, dualSpacing: 0.24, dualScatter: 0.78,
        tooth: 0.13,
      })),
      p('bristle-drag', 'Dry Bristle Drag', fresco({
        tip: 'bristle-chisel', size: 160, spacing: 0.05, flow: 0.3,
        dual: 'fiber-drag', dualSize: 190, dualSpacing: 0.2, dualScatter: 0.66,
        tooth: 0.11,
      })),
      p('fresco-scumble', 'Fresco Scumble', fresco({
        tip: 'bristle-round', size: 150, spacing: 0.07, flow: 0.28,
        dual: 'crackle-web', dualSize: 200, dualSpacing: 0.26, dualScatter: 0.85,
        tooth: 0.14,
      })),
      p('lichen-stipple', 'Lichen Stipple', fresco({
        tip: 'bristle-round', size: 170, spacing: 0.08, flow: 0.3,
        dual: 'stipple-flecks', dualSize: 210, dualSpacing: 0.26, dualScatter: 0.85,
        tooth: 0.12,
      })),

      // --- soft edge: the feathered plume tip does the softening, while K
      //     stays near 2 so one pass still reads. Fresco Veil alone drops to
      //     K = 1.1, where the stroke is a true translucent glaze. ---
      p('salt-wash', 'Salt Wash', fresco({
        tip: 'plume-soft', size: 190, spacing: 0.1, flow: 0.22,
        dual: 'stipple-flecks', dualSize: 230, dualSpacing: 0.28, dualScatter: 0.9,
        tooth: 0.1,
      })),
      p('ash-drift', 'Ash Drift', fresco({
        tip: 'plume-soft', size: 210, spacing: 0.1, flow: 0.2,
        dual: 'fiber-drag', dualSize: 250, dualSpacing: 0.3, dualScatter: 0.95,
      })),
      p('fresco-veil', 'Fresco Veil', fresco({
        tip: 'plume-soft', size: 240, spacing: 0.14, flow: 0.15,
        dual: 'mist-billow', dualSize: 300, dualSpacing: 0.3, dualScatter: 1,
        opacity: 0.9,
      })),
      // Soft by low K rather than by a feathered tip: the edge stays
      // translucent but keeps a firmer boundary than the plume brushes.
      p('sponge-glaze', 'Sponge Glaze', fresco({
        tip: 'bristle-round', size: 200, spacing: 0.12, flow: 0.22,
        dual: 'sponge-fractal', dualSize: 240, dualSpacing: 0.28, dualScatter: 0.92,
        tooth: 0.12,
      })),
    ],
  },
  {
    id: 'wisp',
    name: 'Wisp & Scumble (low coverage)',
    presets: [
      /**
       * These vary COVERAGE — how much of the mark's own footprint carries
       * any ink at all — rather than density. The distinction matters because
       * flow does not control it: Fresco Veil paints at 15% flow and is still
       * ~90% covered, just uniformly thin. To open real gaps inside a mark,
       * one of three things has to be sparse, and each brush below leans on a
       * different one:
       *
       *  - the PRIMARY TIP itself (fan-comb's hairs are cut to zero between
       *    strands). Its dabs must land in register for the gaps to survive,
       *    so those presets set jitter: 0 and keep spacing tight — otherwise
       *    successive dabs smear the gaps closed.
       *  - the DUAL MASK, via a sparse tip and a long dual spacing. Union of
       *    overlapping stamps fills in as 1-(1-m)^(1/spacing), so a mask with
       *    holes needs both a low-mean tip and few overlaps.
       *  - SCATTERING on the primary, which throws whole dabs off the spine
       *    and is the only one of the three that leaves the tip and the mask
       *    untouched.
       *
       * Measured coverage runs from ~55% (Fan Bristle) to ~5% (Dust Motes);
       * tools/measureCoverage.mjs reports it.
       */
      p('fan-bristle', 'Fan Bristle', fresco({
        tip: 'fan-comb', size: 190, spacing: 0.05, flow: 0.26, jitter: 0,
        dual: 'sponge-fractal', dualSize: 220, dualSpacing: 0.32, dualScatter: 1.05,
        tooth: 0.1,
      })),
      p('hair-fringe', 'Hair Fringe', fresco({
        tip: 'fan-comb', size: 130, spacing: 0.05, flow: 0.16, jitter: 0,
        dual: 'crackle-web', dualSize: 160, dualSpacing: 0.34, dualScatter: 1.12,
      })),
      p('scumble-dust', 'Scumble Dust', fresco({
        tip: 'bristle-round', size: 150, spacing: 0.16, flow: 0.28,
        scatter: 1.15, scatterCount: 2,
        dual: 'crackle-web', dualSize: 190, dualSpacing: 0.3, dualScatter: 0.98,
        tooth: 0.12,
      })),
      p('dry-fan-scrub', 'Dry Fan Scrub', fresco({
        tip: 'fan-comb', size: 210, spacing: 0.06, flow: 0.18, jitter: 0,
        dual: 'sponge-fractal', dualSize: 240, dualSpacing: 0.5, dualScatter: 1.6,
        tooth: 0.1,
      })),
      p('wisp-veil', 'Wisp Veil', fresco({
        tip: 'plume-soft', size: 200, spacing: 0.14, flow: 0.22,
        dual: 'wisp-filament', dualSize: 250, dualSpacing: 0.5, dualScatter: 1.6,
      })),
      p('smoke-wisp', 'Smoke Wisp', fresco({
        tip: 'plume-soft', size: 170, spacing: 0.17, flow: 0.2,
        scatter: 0.75, scatterCount: 2,
        dual: 'wisp-filament', dualSize: 220, dualSpacing: 0.6, dualScatter: 1.9,
      })),
      p('ash-spray', 'Ash Spray', fresco({
        tip: 'bristle-round', size: 70, spacing: 0.34, flow: 0.36,
        scatter: 1.9, scatterCount: 3,
        dual: 'granite-grit', dualSize: 110, dualSpacing: 0.35, dualScatter: 1.15,
      })),
      p('dust-motes', 'Dust Motes', fresco({
        tip: 'plume-soft', size: 180, spacing: 0.18, flow: 0.42,
        scatter: 0.9, scatterCount: 3,
        dual: 'dust-motes', dualSize: 230, dualSpacing: 0.7, dualScatter: 2.2,
      })),
    ],
  },
];

/** Groups added at runtime (e.g. imported from .abr files). */
const importedGroups: BrushGroup[] = [];

export function allGroups(): BrushGroup[] {
  return [...BRUSH_GROUPS, ...importedGroups];
}

let importCounter = 1;

/** Registers an imported preset group and returns it. */
export function registerImportedGroup(name: string, presets: BrushPreset[]): BrushGroup {
  const group: BrushGroup = { id: `imported-${importCounter++}`, name, presets };
  importedGroups.push(group);
  return group;
}

export function findPreset(id: string): BrushPreset | undefined {
  for (const g of allGroups()) {
    const hit = g.presets.find((x) => x.id === id);
    if (hit) return hit;
  }
  return undefined;
}
