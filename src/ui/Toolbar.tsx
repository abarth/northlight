import { useStore } from '../store';
import type { ToolId } from '../types';
import { hsvToRgb, rgbToHex } from '../color/convert';
import {
  BrushIcon,
  EraserIcon,
  EyedropperIcon,
  HandIcon,
  LassoIcon,
  MarqueeIcon,
  MoveIcon,
  PolyLassoIcon,
  SwapColorsIcon,
  ZoomIcon,
} from './icons';

const TOOLS: { id: ToolId; label: string; shortcut: string; icon: JSX.Element }[] = [
  { id: 'move', label: 'Move', shortcut: 'V', icon: <MoveIcon /> },
  { id: 'marquee', label: 'Rectangular Marquee', shortcut: 'M', icon: <MarqueeIcon /> },
  { id: 'lasso', label: 'Lasso', shortcut: 'L', icon: <LassoIcon /> },
  { id: 'polyLasso', label: 'Polygonal Lasso', shortcut: 'P', icon: <PolyLassoIcon /> },
  { id: 'brush', label: 'Brush', shortcut: 'B', icon: <BrushIcon /> },
  { id: 'eraser', label: 'Eraser', shortcut: 'E', icon: <EraserIcon /> },
  { id: 'eyedropper', label: 'Eyedropper', shortcut: 'I', icon: <EyedropperIcon /> },
  { id: 'pan', label: 'Hand', shortcut: 'H', icon: <HandIcon /> },
  { id: 'zoom', label: 'Zoom', shortcut: 'Z', icon: <ZoomIcon /> },
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const fg = useStore((s) => s.fg);
  const bg = useStore((s) => s.bg);
  const swap = useStore((s) => s.swapColors);
  const setDialog = useStore((s) => s.setDialog);

  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          title={`${t.label} (${t.shortcut})`}
          onClick={() => setTool(t.id)}
        >
          {t.icon}
        </button>
      ))}
      <div className="fgbg">
        <button
          className="swatch bg-swatch"
          title="Background color (click to edit)"
          style={{ background: `#${rgbToHex(hsvToRgb(bg))}` }}
          onClick={() => setDialog('bgColor')}
        />
        <button
          className="swatch fg-swatch"
          title="Foreground color (click to edit)"
          style={{ background: `#${rgbToHex(hsvToRgb(fg))}` }}
          onClick={() => setDialog('fgColor')}
        />
        <button
          className="swap-colors"
          title="Switch foreground and background colors (X)"
          onClick={swap}
        >
          <SwapColorsIcon size={13} />
        </button>
      </div>
    </div>
  );
}
