import type { SelectionOp } from '../gpu/selection';

/**
 * Photoshop-style tool cursors, built as SVG data URIs. Each glyph is drawn
 * twice — a wide white halo under a thin black stroke — so it reads on any
 * canvas content. Everything is cached by key, since cursors are recomputed
 * on every pointer move.
 */

const cache = new Map<string, string>();

/** Wraps SVG inner markup in the halo treatment shared by every cursor. */
function svgCursor(
  key: string,
  inner: string,
  hotX: number,
  hotY: number,
  fallback: string,
  size = 26,
): string {
  let cur = cache.get(key);
  if (cur) return cur;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<g stroke="%23fff" stroke-width="3.4">${inner}</g>` +
    `<g stroke="%23000" stroke-width="1.6">${inner}</g>` +
    `</g></svg>`;
  cur = `url("data:image/svg+xml,${svg.replace(/"/g, "'")}") ${hotX} ${hotY}, ${fallback}`;
  cache.set(key, cur);
  return cur;
}

/**
 * Boolean-op badge at the lower right of a selection cursor: + (add),
 * − (subtract), × (intersect), like Photoshop.
 */
const OP_BADGES: Record<Exclude<SelectionOp, 'new'>, string> = {
  add: '<path d="M19 15v8M15 19h8"/>',
  subtract: '<path d="M15 19h8"/>',
  intersect: '<path d="M16 16l6 6M22 16l-6 6"/>',
};

const CROSS_GLYPH = '<path d="M10 3v14M3 10h14"/>';

const LASSO_GLYPH =
  '<path d="M12 4c4.7 0 8.5 2.3 8.5 5.1s-3.8 5.1-8.5 5.1c-1.3 0-2.6-.2-3.7-.5"/>' +
  '<path d="M5.9 12.4C4.4 11.5 3.5 10.4 3.5 9.1 3.5 6.3 7.3 4 12 4"/>' +
  '<circle cx="7" cy="14" r="1.9"/>' +
  '<path d="M6.3 15.8c-.3 1.9-1.3 3.3-2.9 4"/>';

const POLY_LASSO_GLYPH =
  '<path d="M9.5 4l10 2.2-1.8 7.3-9 1.6"/>' +
  '<path d="M5.5 12.6L4 8.9l5.5-4.9"/>' +
  '<circle cx="7" cy="14" r="1.9"/>' +
  '<path d="M6.3 15.8c-.3 1.9-1.3 3.3-2.9 4"/>';

/**
 * Cursor for a selection tool showing its pending boolean op. The plain
 * marquee stays the native crosshair; the lassos always use their glyph
 * (hotspot at the rope's tail, where the outline is drawn).
 */
export function selectionToolCursor(
  tool: 'marquee' | 'lasso' | 'polyLasso',
  op: SelectionOp,
): string {
  if (tool === 'marquee' && op === 'new') return 'crosshair';
  const glyph =
    tool === 'marquee' ? CROSS_GLYPH : tool === 'lasso' ? LASSO_GLYPH : POLY_LASSO_GLYPH;
  const [hotX, hotY] = tool === 'marquee' ? [10, 10] : [3, 20];
  const badge = op === 'new' ? '' : OP_BADGES[op];
  return svgCursor(`${tool}-${op}`, glyph + badge, hotX, hotY, 'crosshair');
}

/** Eyedropper cursor; the hotspot sits on the dropper's tip. */
export function eyedropperCursor(): string {
  const glyph =
    '<path d="M20.7 3.3a2.4 2.4 0 0 0-3.4 0l-3 3-1.1-1.1-1.7 1.7 6.6 6.6 1.7-1.7-1.1-1.1 3-3a2.4 2.4 0 0 0 0-3.4z"/>' +
    '<path d="M13.6 8.4L5.5 16.5 4 20l3.5-1.5 8.1-8.1"/>';
  return svgCursor('eyedropper', glyph, 4, 20, 'crosshair');
}

/** Magnifier cursor with a + or − (zoom out while Alt is held). */
export function zoomCursor(dir: 'in' | 'out'): string {
  const lens = '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3L21 21"/>';
  const sign =
    dir === 'in'
      ? '<path d="M7.8 10.5h5.4M10.5 7.8v5.4"/>'
      : '<path d="M7.8 10.5h5.4"/>';
  return svgCursor(`zoom-${dir}`, lens + sign, 10, 10, `zoom-${dir}`);
}

/** Move tool: black pointer arrow with a small four-way move badge. */
export function moveToolCursor(): string {
  const key = 'move';
  let cur = cache.get(key);
  if (cur) return cur;
  const badge =
    '<path d="M19 14.7v8.6M14.7 19h8.6"/>' +
    '<path d="M17.4 16.4L19 14.7l1.6 1.7M17.4 21.6L19 23.3l1.6-1.7M16.4 17.4L14.7 19l1.7 1.6M21.6 17.4L23.3 19l-1.7 1.6"/>';
  const arrow = 'M5 2v14l3.7-3.1 2.2 5.2 2.4-1-2.1-5.2h4.6z';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">` +
    `<g fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<g stroke="%23fff" stroke-width="3">${badge}</g>` +
    `<g stroke="%23000" stroke-width="1.4">${badge}</g>` +
    `</g>` +
    `<path d="${arrow}" fill="%23000" stroke="%23fff" stroke-width="1.4" stroke-linejoin="round"/>` +
    `</svg>`;
  cur = `url("data:image/svg+xml,${svg.replace(/"/g, "'")}") 5 2, default`;
  cache.set(key, cur);
  return cur;
}

/**
 * Resize cursor for an on-screen axis, quantized to the four CSS resize
 * cursors. Because the axis comes from the live quad geometry, a box rotated
 * 90° swaps horizontal/vertical arrows and ~45° rotations show diagonals,
 * like Photoshop.
 */
export function resizeCursorFor(dx: number, dy: number): string {
  let ang = (Math.atan2(dy, dx) * 180) / Math.PI; // y-down screen space
  ang = ((ang % 180) + 180) % 180;
  if (ang < 22.5 || ang >= 157.5) return 'ew-resize';
  if (ang < 67.5) return 'nwse-resize';
  if (ang < 112.5) return 'ns-resize';
  return 'nesw-resize';
}

/**
 * Curved double-arrow rotation cursor, oriented for a pointer sitting at
 * `angle` (radians) from the transform box center; the arc bows away from
 * the box. Cached per 45° step.
 */
export function rotateCursor(angle: number): string {
  const deg =
    ((Math.round((angle * 180) / Math.PI / 45) * 45) % 360 + 360) % 360;
  const key = `rotate-${deg}`;
  let cur = cache.get(key);
  if (cur) return cur;

  // arc from (16,4) to (16,20), radius 9, bowing toward +x
  const head = (px: number, py: number, dx: number, dy: number) => {
    const leg = (rot: number) => {
      const ca = Math.cos(rot);
      const sa = Math.sin(rot);
      const hx = dx * ca - dy * sa;
      const hy = dx * sa + dy * ca;
      return `M${px} ${py} l${(hx * 6).toFixed(1)} ${(hy * 6).toFixed(1)}`;
    };
    return leg(0.45) + leg(-0.45);
  };
  // arrowhead legs point back along the arc so the tips point outward
  const paths =
    '<path d="M16 4 A 9 9 0 0 1 16 20"/>' +
    `<path d="${head(16, 4, 0.894, 0.447)}"/>` +
    `<path d="${head(16, 20, 0.894, -0.447)}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">` +
    `<g transform="rotate(${deg} 12 12)" fill="none" stroke-linecap="round">` +
    `<g stroke="%23fff" stroke-width="4.5">${paths}</g>` +
    `<g stroke="%23000" stroke-width="1.8">${paths}</g>` +
    `</g></svg>`;
  cur = `url("data:image/svg+xml,${svg.replace(/"/g, "'")}") 12 12, auto`;
  cache.set(key, cur);
  return cur;
}
