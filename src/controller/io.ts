import * as brushAbr from '../brush/abr';
import * as brushDefaults from '../brush/defaults';
import * as brushPatterns from '../brush/patterns';
import * as brushPresets from '../brush/presets';
import { pixelLayers } from '../layers';
import { DOC_SIZE, nextLayerId, useStore } from '../store';
import { makeLayerMeta } from '../types';
import { MAX_LAYERS, buildRenderState, getEngine } from './engineHost';
import { newDocument } from './document';

/**
 * Import/export: File > Open / Place / Export PNG, and ABR brush import.
 */

/** Draws a bitmap into a doc-sized buffer of premultiplied RGBA. */
function bitmapToDocPixels(
  bmp: ImageBitmap,
  fit: boolean,
): Uint8Array<ArrayBuffer> {
  const { width: dw, height: dh } = DOC_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  let w = bmp.width;
  let h = bmp.height;
  if (fit) {
    const scale = Math.min(1, dw / w, dh / h);
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  ctx.drawImage(bmp, Math.round((dw - w) / 2), Math.round((dh - h) / 2), w, h);
  const img = ctx.getImageData(0, 0, dw, dh).data;
  const out = new Uint8Array(dw * dh * 4);
  for (let i = 0; i < out.length; i += 4) {
    const a = img[i + 3];
    out[i] = (img[i] * a + 127) / 255;
    out[i + 1] = (img[i + 1] * a + 127) / 255;
    out[i + 2] = (img[i + 2] * a + 127) / 255;
    out[i + 3] = a;
  }
  return out;
}

/** File > Place: imports an image as a new layer, scaled down to fit. */
export async function placeImageFile(file: File): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  const s = useStore.getState();
  if (pixelLayers(s.layers).length >= MAX_LAYERS) return;
  const bmp = await createImageBitmap(file);
  const id = nextLayerId();
  engine.putLayerImage(id, bitmapToDocPixels(bmp, true), DOC_SIZE.width, DOC_SIZE.height);
  bmp.close();
  s.addLayerMeta(
    makeLayerMeta({ id, name: file.name.replace(/\.[^.]+$/, '') || 'Placed Image' }),
    s.activeLayerId,
  );
}

/** File > Open: replaces the document with one sized to the image. */
export async function openImageFile(file: File): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  const bmp = await createImageBitmap(file);
  const res = useStore.getState().doc.resolution;
  newDocument(Math.min(bmp.width, 8192), Math.min(bmp.height, 8192), res, 'transparent');
  engine.putLayerImage(
    'background',
    bitmapToDocPixels(bmp, true),
    DOC_SIZE.width,
    DOC_SIZE.height,
  );
  bmp.close();
}

export async function exportPng(): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  let data: Uint8Array;
  try {
    data = await engine.readComposite(buildRenderState());
  } catch (err) {
    alert(`Export failed: ${err}`);
    return;
  }
  if (data.length === 0) {
    alert('Export failed: could not read pixels back from the GPU.');
    return;
  }
  const { width, height } = DOC_SIZE;
  // un-premultiply for PNG
  const img = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    const inv = a > 0 ? 255 / a : 0;
    img.data[i * 4] = Math.min(255, data[i * 4] * inv);
    img.data[i * 4 + 1] = Math.min(255, data[i * 4 + 1] * inv);
    img.data[i * 4 + 2] = Math.min(255, data[i * 4 + 2] * inv);
    img.data[i * 4 + 3] = a;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(img, 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'northlight.png';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Imports a Photoshop .abr file: registers its sampled tips and texture
 * patterns, wraps every brush into a preset under a new "Imported" group,
 * and selects the first one. Returns the number of imported brushes.
 */
export function importAbr(fileName: string, buffer: ArrayBuffer): number {
  const result = brushAbr.parseAbr(buffer);
  const baseName = fileName.replace(/\.abr$/i, '') || 'Imported';
  const prefixed = (id: string) => `abr:${baseName}:${id}`;

  for (const [id, map] of result.tips) {
    brushPatterns.registerTip(prefixed(id), map);
  }
  for (const [id, pattern] of result.patterns) {
    brushPatterns.registerPattern(prefixed(id), pattern.map, pattern.name || id);
  }

  const presets = result.brushes.map((b, i) => {
    const settings = brushDefaults.makeBrush(b.settings);
    if (b.tipId) {
      settings.tip.shape = prefixed(b.tipId);
      // sampled tips ignore hardness; keep size sane if the desc lacked one
      if (!b.settings.tip?.size) {
        const map = result.tips.get(b.tipId);
        if (map) settings.tip.size = Math.min(map.size, 300);
      }
    }
    // dual brush may reference another sampled tip from this file
    if (settings.dual.enabled && result.tips.has(settings.dual.shape)) {
      settings.dual.shape = prefixed(settings.dual.shape);
    }
    if (settings.texture.enabled) {
      settings.texture.pattern = b.texturePatternId
        ? prefixed(b.texturePatternId)
        : 'paper';
    }
    return {
      id: `abr:${baseName}:${i}`,
      name: b.name || `${baseName} ${i + 1}`,
      settings,
    };
  });

  if (presets.length === 0) {
    throw new Error('No brushes found in this ABR file.');
  }

  brushPresets.registerImportedGroup(baseName, presets);
  const s = useStore.getState();
  s.bumpPresetRevision();
  s.applyPreset(presets[0].id, 'brush');
  return presets.length;
}
