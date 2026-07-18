import { DOC_SIZE, useStore } from '../store';
import type { Point } from '../types';
import { getEngine } from './engineHost';

/**
 * Viewport control (View > Zoom In / Zoom Out / Fit on Screen / 100%).
 */

export const MIN_ZOOM = 1 / 32;
export const MAX_ZOOM = 32;

/** Photoshop-style zoom stops used by Zoom In/Out and zoom-tool clicks. */
const ZOOM_STOPS = [
  1 / 32, 1 / 24, 1 / 16, 1 / 12, 1 / 8, 1 / 6, 1 / 4, 1 / 3, 1 / 2, 2 / 3,
  1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 24, 32,
];

export function nextZoomStop(zoom: number, dir: 'in' | 'out'): number {
  if (dir === 'in') {
    for (const s of ZOOM_STOPS) if (s > zoom * 1.001) return s;
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STOPS.length - 1; i >= 0; i--) {
    if (ZOOM_STOPS[i] < zoom * 0.999) return ZOOM_STOPS[i];
  }
  return MIN_ZOOM;
}

/**
 * Sets the zoom, keeping `anchor` (device pixels; defaults to the viewport
 * center) fixed on the same document point.
 */
export function applyZoom(newZoom: number, anchor?: Point): void {
  const s = useStore.getState();
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
  const size = getEngine()?.viewSize;
  const a = anchor ?? { x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 };
  const v = s.view;
  const doc = { x: (a.x - v.panX) / v.zoom, y: (a.y - v.panY) / v.zoom };
  s.setView({ zoom, panX: a.x - doc.x * zoom, panY: a.y - doc.y * zoom });
}

export function zoomIn(anchor?: Point): void {
  applyZoom(nextZoomStop(useStore.getState().view.zoom, 'in'), anchor);
}

export function zoomOut(anchor?: Point): void {
  applyZoom(nextZoomStop(useStore.getState().view.zoom, 'out'), anchor);
}

export function zoomTo(zoom: number): void {
  applyZoom(zoom);
}

/** View > Fit on Screen: centers the document at the largest comfortable fit. */
export function fitOnScreen(): void {
  const size = getEngine()?.viewSize;
  if (!size || size.width === 0) return;
  const zoom = Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min((size.width * 0.9) / DOC_SIZE.width, (size.height * 0.9) / DOC_SIZE.height),
    ),
  );
  useStore.getState().setView({
    zoom,
    panX: (size.width - DOC_SIZE.width * zoom) / 2,
    panY: (size.height - DOC_SIZE.height * zoom) / 2,
  });
}
