import { bristleTipId } from './bristle';
import { directionControl, makeBrush, pressureControl } from './defaults';
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
    id: 'alla-prima',
    name: 'Alla Prima (Oils)',
    /*
     * Direct-painting brushes: hog flats, filberts, brights, a fan, a dagger,
     * two rounds and a knife, built to leave the marks a painter working wet
     * into wet in one sitting leaves — the vocabulary you read off a Sargent
     * sleeve or a Schmid still life.
     *
     * Three things decide whether a bristle mark reads as paint, and every
     * preset below is tuned around them:
     *
     * 1. WHICH WAY THE BLADE POINTS. Set Angle Control to Direction and the
     *    blade stays across the stroke, so every hair's gap lands on the
     *    previous dab's gap and the hairs draw continuous striations. Leave
     *    Angle Control off and the blade is held at one fixed attitude
     *    instead: the mark then turns broad-to-thin on stroke direction alone
     *    (a flat drawn along its own blade is a hairline), which is the other
     *    half of the alla prima vocabulary — but its dabs shift sideways as
     *    they advance, so the striations fill in. Those brushes are spaced
     *    wide instead, and read as separate chisel touches.
     * 2. SPACING. Tight enough that dabs overlap several times, or the train
     *    prints its own ribs across the mark. Aligned gaps survive any
     *    spacing, so there is no reason to space wide to keep them.
     * 3. HOW MUCH TOOTH. A loaded mark is opaque and shows the weave only as
     *    a whisper (Depth around 0.15); a mark from a brush that is nearly dry
     *    is mostly weave (Depth 0.75+, per dab, with a Minimum Depth so it
     *    never smooths out). Anything in between just looks like fabric.
     */
    presets: [
      p(
        'ap-flat-chisel',
        'Flat Bristle Chisel',
        makeBrush({
          // The workhorse: a loaded hog flat dragged with the blade across the
          // stroke. Hairs are wide with narrow gaps, so the mark is a solid
          // body of paint crossed by a few drag lines rather than a comb.
          tip: {
            shape: bristleTipId({
              shape: 'flat-blunt',
              bristles: 0.16,
              length: 0.5,
              thickness: 0.82,
              stiffness: 0.85,
            }),
            size: 64,
            spacing: 0.14,
            angle: -90,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            // a degree of wobble, and a little size flutter so the long edges
            // are not ruled lines
            angleJitter: 0.006,
            sizeJitter: 0.03,
            sizeControl: pressureControl(),
            minDiameter: 0.55,
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.72,
            flowJitter: 0.1,
          },
          texture: { enabled: true, pattern: 'linen', scale: 1.5, depth: 0.12 },
          color: {
            enabled: true,
            applyPerTip: true,
            hueJitter: 0.012,
            satJitter: 0.11,
            briJitter: 0.1,
          },
          smoothing: 0.25,
        }),
      ),
      p(
        'ap-filbert',
        'Filbert Loaded',
        makeBrush({
          // Domed trim: the same broad drag as the flat but with ends that
          // round off instead of cutting square — the safe brush for form.
          tip: {
            shape: bristleTipId({
              shape: 'flat-curve',
              bristles: 0.14,
              length: 0.55,
              thickness: 0.84,
              stiffness: 0.8,
            }),
            size: 54,
            spacing: 0.13,
            angle: -90,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            angleJitter: 0.008,
            sizeJitter: 0.03,
            sizeControl: pressureControl(),
            minDiameter: 0.5,
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.75,
            flowJitter: 0.1,
          },
          texture: { enabled: true, pattern: 'linen', scale: 1.5, depth: 0.11 },
          color: {
            enabled: true,
            applyPerTip: true,
            hueJitter: 0.014,
            satJitter: 0.12,
            briJitter: 0.11,
          },
          smoothing: 0.3,
        }),
      ),
      p(
        'ap-bright',
        'Bright Short Chisel',
        makeBrush({
          // A short, stiff flat held at ONE attitude and spaced so wide its
          // dabs only just touch. Hairs are thick enough to close up into a
          // solid chisel, so each dab is a separate square note whose width
          // depends on which way you drew it — Schmid's mosaic.
          tip: {
            shape: bristleTipId({
              shape: 'flat-blunt',
              bristles: 0.1,
              length: 0.22,
              thickness: 1,
              stiffness: 0.95,
            }),
            size: 46,
            spacing: 0.25,
            angle: -45,
          },
          shape: {
            enabled: true,
            angleJitter: 0.02,
            sizeJitter: 0.08,
            sizeControl: pressureControl(),
            minDiameter: 0.65,
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.88,
            flowJitter: 0.1,
          },
          texture: { enabled: true, pattern: 'linen', scale: 1.3, depth: 0.1 },
          color: { enabled: true, applyPerTip: true, satJitter: 0.12, briJitter: 0.1 },
          smoothing: 0.2,
        }),
      ),
      p(
        'ap-knife',
        'Knife Slab',
        makeBrush({
          // A painting knife, not a brush: a few very wide "hairs" close into
          // one solid slab with square ends. Fixed attitude, tight spacing, no
          // tooth worth speaking of — the edges stay razor sharp and it turns
          // broad-to-thin purely on the direction it is drawn.
          tip: {
            shape: bristleTipId({
              shape: 'flat-blunt',
              bristles: 0.05,
              length: 0.16,
              thickness: 1,
              stiffness: 1,
            }),
            size: 78,
            spacing: 0.18,
            angle: -20,
          },
          shape: { enabled: true, sizeControl: pressureControl(), minDiameter: 0.75 },
          transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.9 },
          texture: { enabled: true, pattern: 'linen', scale: 1.8, depth: 0.08, mode: 'height' },
          color: { enabled: true, applyPerTip: true, briJitter: 0.04 },
          smoothing: 0.15,
        }),
      ),
      p(
        'ap-impasto',
        'Impasto Loaded Flat',
        makeBrush({
          // Thick hairs, and the tooth carving in Height mode: the deposit is
          // cut back hard on the low side of the weave, so the paint left
          // standing on the high side reads as a ridge with a shadow in it.
          tip: {
            shape: bristleTipId({
              shape: 'flat-curve',
              bristles: 0.13,
              length: 0.42,
              thickness: 0.86,
              stiffness: 0.9,
            }),
            size: 60,
            spacing: 0.08,
            angle: -90,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            angleJitter: 0.006,
            sizeJitter: 0.03,
            sizeControl: pressureControl(),
            minDiameter: 0.62,
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.82,
            flowJitter: 0.08,
          },
          texture: { enabled: true, pattern: 'linen', scale: 1.6, depth: 0.17, mode: 'height' },
          color: {
            enabled: true,
            applyPerTip: true,
            hueJitter: 0.016,
            satJitter: 0.11,
            briJitter: 0.11,
          },
          smoothing: 0.2,
        }),
      ),
      p(
        'ap-dry-drag',
        'Dry Drag Scumble',
        makeBrush({
          // Thin, slack hairs on a brush that is nearly out of paint. The
          // tooth is deep, jittered per dab and floored by Minimum Depth, so
          // the drag skips in patches instead of fading evenly, and pressure
          // decides how far into the weave it reaches.
          tip: {
            shape: bristleTipId({
              shape: 'flat-blunt',
              bristles: 0.34,
              length: 0.7,
              thickness: 0.42,
              stiffness: 0.5,
            }),
            size: 74,
            spacing: 0.22,
            angle: -90,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            angleJitter: 0.012,
            sizeJitter: 0.08,
            sizeControl: pressureControl(),
            minDiameter: 0.55,
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.15,
            flowJitter: 0.3,
          },
          texture: {
            enabled: true,
            pattern: 'linen',
            scale: 1.4,
            depth: 0.7,
            mode: 'subtract',
            textureEachTip: true,
            depthJitter: 0.35,
            minDepth: 0.5,
            depthControl: pressureControl(),
          },
          color: { enabled: true, applyPerTip: true, satJitter: 0.09, briJitter: 0.09 },
          flow: 0.9,
          opacity: 0.95,
          smoothing: 0.25,
        }),
      ),
      p(
        'ap-scumbler',
        'Broken Color Scumbler',
        makeBrush({
          // A splayed round dragged over a dry underlayer. Count is on
          // pressure, so leaning in multiplies the dabs per step and the veil
          // thickens where you press without ever going flat.
          tip: {
            shape: bristleTipId({
              shape: 'round-fan',
              bristles: 0.32,
              length: 0.8,
              thickness: 0.52,
              stiffness: 0.4,
            }),
            size: 62,
            spacing: 0.14,
            angle: -90,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            angleJitter: 0.04,
            sizeJitter: 0.1,
            sizeControl: pressureControl(),
            minDiameter: 0.5,
          },
          scatter: {
            enabled: true,
            scatter: 0.1,
            count: 2,
            countJitter: 0.4,
            countControl: pressureControl(),
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.3,
            flowJitter: 0.25,
          },
          texture: {
            enabled: true,
            pattern: 'linen',
            scale: 1.2,
            depth: 0.55,
            mode: 'subtract',
            textureEachTip: true,
            depthJitter: 0.25,
            minDepth: 0.45,
          },
          color: {
            enabled: true,
            applyPerTip: true,
            hueJitter: 0.022,
            satJitter: 0.13,
            briJitter: 0.13,
          },
          flow: 1,
          opacity: 0.9,
          smoothing: 0.2,
        }),
      ),
      p(
        'ap-fan-blender',
        'Fan Blender',
        makeBrush({
          // Almost no paint, very wide, dragged across a boundary to lose it.
          // Opacity caps the whole pass, so repeated coaxing over one edge
          // cannot build past a veil.
          tip: {
            shape: bristleTipId({
              shape: 'flat-fan',
              bristles: 0.42,
              length: 0.6,
              thickness: 0.46,
              stiffness: 0.4,
            }),
            size: 92,
            spacing: 0.2,
            angle: -90,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            angleJitter: 0.016,
            sizeJitter: 0.06,
            sizeControl: pressureControl(),
            minDiameter: 0.7,
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.06,
            flowJitter: 0.25,
          },
          texture: { enabled: true, pattern: 'linen', scale: 1.6, depth: 0.3 },
          flow: 0.5,
          opacity: 0.55,
          smoothing: 0.4,
        }),
      ),
      p(
        'ap-dagger',
        'Angular Dagger',
        makeBrush({
          // Slanted trim held at a fixed attitude: one corner reaches further
          // than the other, so the mark is asymmetric and rolls from a broad
          // face onto a point as the stroke turns.
          tip: {
            shape: bristleTipId({
              shape: 'flat-angle',
              bristles: 0.14,
              length: 0.55,
              thickness: 0.88,
              stiffness: 0.9,
            }),
            size: 52,
            spacing: 0.14,
            angle: -45,
          },
          shape: {
            enabled: true,
            angleJitter: 0.008,
            sizeJitter: 0.03,
            sizeControl: pressureControl(),
            minDiameter: 0.5,
          },
          transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.68 },
          texture: { enabled: true, pattern: 'linen', scale: 1.4, depth: 0.1 },
          color: { enabled: true, applyPerTip: true, satJitter: 0.1, briJitter: 0.09 },
          smoothing: 0.25,
        }),
      ),
      p(
        'ap-round-accent',
        'Round Sable Accent',
        makeBrush({
          // The small round that draws into the block-in: an eye, a nostril, a
          // highlight. Size on pressure with a low minimum, so it tapers to
          // nothing at both ends of the stroke.
          tip: {
            shape: bristleTipId({
              shape: 'round-point',
              bristles: 0.2,
              length: 0.6,
              thickness: 0.82,
              stiffness: 0.8,
            }),
            size: 17,
            spacing: 0.1,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            sizeControl: pressureControl(),
            minDiameter: 0.12,
          },
          transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.35 },
          smoothing: 0.35,
        }),
      ),
      p(
        'ap-rigger',
        'Rigger Liner',
        makeBrush({
          // Very long, very few hairs: the whip-thin accents that go over a
          // finished passage. Heavy smoothing keeps the line clean at speed.
          tip: {
            shape: bristleTipId({
              shape: 'round-point',
              bristles: 0.1,
              length: 0.95,
              thickness: 0.9,
              stiffness: 0.85,
            }),
            size: 11,
            spacing: 0.08,
          },
          shape: {
            enabled: true,
            angleControl: directionControl(),
            sizeControl: pressureControl(),
            minDiameter: 0.06,
          },
          transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.55 },
          smoothing: 0.5,
        }),
      ),
      p(
        'ap-round-tilt',
        'Round Bristle, Tilt Projected',
        makeBrush({
          // Brush Projection on: hold the pen upright for a round mark, lay it
          // over and the tip flattens into a chisel along the direction of
          // tilt, and roll the barrel to steer it — the same three gestures
          // you would use on a real round brush.
          tip: {
            shape: bristleTipId({
              shape: 'round-blunt',
              bristles: 0.22,
              length: 0.55,
              thickness: 0.9,
              stiffness: 0.75,
            }),
            size: 48,
            spacing: 0.09,
          },
          shape: {
            enabled: true,
            brushProjection: true,
            angleControl: directionControl(),
            sizeControl: pressureControl(),
            minDiameter: 0.5,
            minRoundness: 0.22,
          },
          transfer: {
            enabled: true,
            flowControl: pressureControl(),
            flowMin: 0.8,
            flowJitter: 0.12,
          },
          texture: { enabled: true, pattern: 'linen', scale: 1.5, depth: 0.13 },
          color: { enabled: true, applyPerTip: true, satJitter: 0.1, briJitter: 0.09 },
          smoothing: 0.25,
        }),
      ),
      p(
        'ap-flat-posed',
        'Flat Bristle, Fixed Pose',
        makeBrush({
          // The same flat, but held for you: Brush Pose overrides tilt and
          // rotation, so a mouse — or a pen with no tilt sensor — still gets
          // one consistent attitude for a whole passage, and the mark turns
          // broad-to-thin on stroke direction alone.
          tip: {
            shape: bristleTipId({
              shape: 'flat-blunt',
              bristles: 0.1,
              length: 0.4,
              thickness: 0.92,
              stiffness: 0.9,
            }),
            size: 62,
            spacing: 0.18,
          },
          pose: {
            enabled: true,
            tiltX: 34,
            tiltY: -20,
            rotation: 325,
            overrideTiltX: true,
            overrideTiltY: true,
            overrideRotation: true,
          },
          shape: {
            enabled: true,
            brushProjection: true,
            sizeJitter: 0.03,
            sizeControl: pressureControl(),
            minDiameter: 0.62,
            minRoundness: 0.32,
          },
          transfer: { enabled: true, flowControl: pressureControl(), flowMin: 0.85 },
          texture: { enabled: true, pattern: 'linen', scale: 1.5, depth: 0.13 },
          color: { enabled: true, applyPerTip: true, satJitter: 0.1, briJitter: 0.09 },
          smoothing: 0.25,
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
