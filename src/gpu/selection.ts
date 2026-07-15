import type { Point } from '../types';

/**
 * Rasterizes selection polygons into a single-channel coverage mask using an
 * offscreen 2D canvas (which also gives us anti-aliased edges for free).
 */
export function rasterizeSelection(
  paths: Point[][],
  width: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const path of paths) {
    if (path.length < 3) continue;
    ctx.moveTo(path[0].x, path[0].y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
    ctx.closePath();
  }
  ctx.fill();
  const img = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = img[i * 4 + 3];
  return mask;
}
