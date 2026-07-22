import type { EngineStrokeParams } from '../gpu/engine';
import type { BristleBrushSettings } from './bristle';
import { getPattern } from './patterns';
import type { BrushSettings } from './types';

/** Maps full brush settings to the per-stroke parameters the GPU needs. */
export function engineStrokeParams(
  s: BrushSettings,
  mode: 'paint' | 'erase',
): EngineStrokeParams {
  return {
    mode,
    opacity: s.opacity,
    blendMode: mode === 'erase' ? 'normal' : s.blendMode,
    hardness: s.tip.hardness,
    tipShape: s.tip.shape,
    wetEdges: s.wetEdges,
    noise: s.noise,
    texture: s.texture.enabled
      ? {
          pattern: s.texture.pattern,
          // scale is relative to the pattern's native size, like Photoshop
          scalePx: getPattern(s.texture.pattern).size * s.texture.scale,
          brightness: s.texture.brightness,
          contrast: s.texture.contrast,
          invert: s.texture.invert,
          depth: s.texture.depth,
          mode: s.texture.mode,
          eachTip: s.texture.textureEachTip,
        }
      : null,
    dual: s.dual.enabled ? s.dual : null,
    lockTransparent: false, // set by the caller from the layer's locks
  };
}

/**
 * Per-stroke GPU parameters for the bristle engine. Track segments render as
 * analytic round stamps; the canvas tooth rides the texture-each-tip path in
 * subtract mode with depth 1 — each segment's depthScale attribute carries
 * the real gate strength (dry bristles get carved harder than loaded ones).
 * Options-bar opacity and paint mode come from the active brush settings.
 */
export function bristleEngineParams(
  b: BristleBrushSettings,
  base: BrushSettings,
): EngineStrokeParams {
  return {
    mode: 'paint',
    opacity: base.opacity,
    blendMode: base.blendMode,
    hardness: 1 - b.softness,
    tipShape: 'round',
    wetEdges: false,
    noise: false,
    texture:
      b.toothDepth > 0
        ? {
            pattern: b.pattern,
            scalePx: getPattern(b.pattern).size * b.patternScale,
            brightness: 0,
            contrast: 0,
            invert: false,
            depth: 1,
            mode: 'subtract',
            eachTip: true,
          }
        : null,
    dual: null,
    lockTransparent: false, // set by the caller from the layer's locks
  };
}
