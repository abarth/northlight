import { makeBrush, pressureControl } from './defaults';
import type { BrushSettings } from './types';

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
