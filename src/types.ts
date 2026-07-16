export type ToolId =
  | 'move'
  | 'brush'
  | 'eraser'
  | 'eyedropper'
  | 'pan'
  | 'zoom'
  | 'marquee'
  | 'lasso'
  | 'polyLasso';

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color-burn'
  | 'linear-burn'
  | 'lighten'
  | 'screen'
  | 'color-dodge'
  | 'linear-dodge'
  | 'overlay'
  | 'soft-light'
  | 'hard-light'
  | 'vivid-light'
  | 'linear-light'
  | 'pin-light'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

/** Order matches the `switch` in the compositor shader. */
export const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'darken', label: 'Darken' },
  { id: 'multiply', label: 'Multiply' },
  { id: 'color-burn', label: 'Color Burn' },
  { id: 'linear-burn', label: 'Linear Burn' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'screen', label: 'Screen' },
  { id: 'color-dodge', label: 'Color Dodge' },
  { id: 'linear-dodge', label: 'Linear Dodge (Add)' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'soft-light', label: 'Soft Light' },
  { id: 'hard-light', label: 'Hard Light' },
  { id: 'vivid-light', label: 'Vivid Light' },
  { id: 'linear-light', label: 'Linear Light' },
  { id: 'pin-light', label: 'Pin Light' },
  { id: 'difference', label: 'Difference' },
  { id: 'exclusion', label: 'Exclusion' },
  { id: 'subtract', label: 'Subtract' },
  { id: 'divide', label: 'Divide' },
  { id: 'hue', label: 'Hue' },
  { id: 'saturation', label: 'Saturation' },
  { id: 'color', label: 'Color' },
  { id: 'luminosity', label: 'Luminosity' },
];

export const BLEND_MODE_INDEX: Record<BlendMode, number> = Object.fromEntries(
  BLEND_MODES.map((m, i) => [m.id, i]),
) as Record<BlendMode, number>;

export interface LayerMeta {
  id: string;
  name: string;
  visible: boolean;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
}

export interface Viewport {
  /** document pixels -> device pixels scale */
  zoom: number;
  /** device-pixel offset of the document origin inside the canvas */
  panX: number;
  panY: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface HSV {
  /** 0..360 */
  h: number;
  /** 0..1 */
  s: number;
  /** 0..1 */
  v: number;
}
