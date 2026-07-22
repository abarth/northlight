import { defaultBristleBrush, type BristleBrushSettings } from './bristle';

/**
 * Starter presets for the experimental bristle engine — tuned personalities
 * of the same filbert model, meant as jumping-off points for iteration.
 * Unlike stamp presets these carry BristleBrushSettings plus the shared
 * options-bar values they want (tip size, stroke opacity).
 */

export interface BristlePreset {
  id: string;
  name: string;
  /** tuft diameter, applied to the shared options-bar brush size */
  size: number;
  /** stroke opacity cap, applied to the options-bar opacity */
  opacity: number;
  settings: BristleBrushSettings;
}

type BristlePatch = Partial<Omit<BristleBrushSettings, 'colorJitter'>> & {
  colorJitter?: Partial<BristleBrushSettings['colorJitter']>;
};

function makeBristle(patch: BristlePatch): BristleBrushSettings {
  const base = defaultBristleBrush();
  return {
    ...base,
    ...patch,
    colorJitter: { ...base.colorJitter, ...(patch.colorJitter ?? {}) },
  };
}

const p = (
  id: string,
  name: string,
  size: number,
  patch: BristlePatch,
  opacity = 1,
): BristlePreset => ({ id, name, size, opacity, settings: makeBristle(patch) });

export const BRISTLE_PRESETS: BristlePreset[] = [
  // The reason this engine exists: broken, toothy marks for the edges of a
  // painting. Runs dry over a stroke; reload by lifting.
  p('br-dry-filbert', 'Dry Filbert', 70, {
    breakup: 0.45,
    breakupScale: 34,
    loadCapacity: 500,
    toothDepth: 0.75,
    flow: 0.8,
    softness: 0.2,
    splay: 0.4,
    colorJitter: { hue: 0.03, sat: 0.15, bri: 0.18 },
  }),

  // Juicy, opaque body-color stroke — long load, faint tooth, soft edges.
  p('br-loaded-filbert', 'Loaded Filbert', 56, {
    breakup: 0.05,
    loadCapacity: 1600,
    toothDepth: 0.25,
    flow: 0.95,
    softness: 0.35,
    bristleWidth: 2.2,
    opacityJitter: 0.2,
    colorJitter: { hue: 0.02, sat: 0.08, bri: 0.08 },
  }),

  // Thin translucent veil dragged over the tooth — for knocking back or
  // warming a passage without covering it.
  p(
    'br-scumble',
    'Scumble Veil',
    110,
    {
      bristleCount: 160,
      flow: 0.3,
      breakup: 0.6,
      breakupScale: 18,
      loadCapacity: 0,
      toothDepth: 0.9,
      splay: 0.5,
      opacityJitter: 0.5,
      colorJitter: { bri: 0.2, sat: 0.1 },
    },
    0.5,
  ),

  // Few thick bristles, strong per-bristle opacity spread — pronounced
  // parallel striation, like dragging a rake through paint.
  p('br-rake', 'Rake', 64, {
    bristleCount: 20,
    bristleWidth: 3.2,
    thickness: 0.3,
    opacityJitter: 0.6,
    breakup: 0.25,
    breakupScale: 46,
    loadCapacity: 900,
    toothDepth: 0.5,
    colorJitter: { bri: 0.22, sat: 0.12 },
  }),

  // Nearly round, dense, smooth tuft with a strong pressure taper — clean
  // liner strokes that swell and thin with the hand.
  p('br-round-sable', 'Round Sable', 24, {
    bristleCount: 120,
    thickness: 0.95,
    belly: 0.9,
    bristleWidth: 1.2,
    splay: 0.2,
    breakup: 0.05,
    breakupScale: 60,
    loadCapacity: 0,
    toothDepth: 0.15,
    opacityJitter: 0.15,
    softness: 0.4,
    colorJitter: { hue: 0.01, sat: 0.05, bri: 0.05 },
  }),

  // Very flat, flat-cut tuft (low belly = full width at light pressure) with
  // ragged color — broad blocking strokes with lost-and-found edges.
  p('br-ragged-flat', 'Ragged Flat', 84, {
    thickness: 0.22,
    belly: 0.25,
    splay: 0.5,
    breakup: 0.35,
    breakupScale: 30,
    loadCapacity: 800,
    toothDepth: 0.6,
    opacityJitter: 0.45,
    colorJitter: { hue: 0.06, sat: 0.2, bri: 0.2 },
  }),

  // Half the bristles dip toward the background color — two paints on one
  // brush, striped along the stroke. Try complementary fg/bg.
  p('br-two-tone', 'Two-Tone Filbert', 60, {
    breakup: 0.15,
    loadCapacity: 1200,
    toothDepth: 0.35,
    flow: 0.9,
    opacityJitter: 0.2,
    colorJitter: { fgBg: 0.85, hue: 0.02, sat: 0.1, bri: 0.1 },
  }),
];

export function findBristlePreset(id: string): BristlePreset | undefined {
  return BRISTLE_PRESETS.find((x) => x.id === id);
}
