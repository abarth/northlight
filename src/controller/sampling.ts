import type * as color from '../color/convert';
import { resolveRenderLayers } from '../layers';
import { useStore } from '../store';
import { getEngine } from './engineHost';

/**
 * Eyedropper sample at a document coordinate, honoring the Sample Size and
 * Sample scope options. Returns straight RGB, or null on transparent pixels.
 */
export async function sampleCanvasColor(x: number, y: number): Promise<color.RGB | null> {
  const engine = getEngine();
  if (!engine) return null;
  const s = useStore.getState();
  const size = s.eyedropperSampleSize;
  let result;
  if (s.eyedropperSample === 'current') {
    result = await engine.sampleColor(x, y, size, { layerId: s.activeLayerId });
  } else {
    let layers = resolveRenderLayers(s.layers);
    if (s.eyedropperSample === 'currentBelow') {
      const idx = layers.findIndex((l) => l.id === s.activeLayerId);
      if (idx >= 0) layers = layers.slice(0, idx + 1);
    }
    result = await engine.sampleColor(x, y, size, {
      state: { layers, activeLayerId: s.activeLayerId, view: s.view },
    });
  }
  return result ? { r: result.r, g: result.g, b: result.b } : null;
}
