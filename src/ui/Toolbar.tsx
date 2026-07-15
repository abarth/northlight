import { useStore } from '../store';
import type { ToolId } from '../types';
import { hsvToRgb, rgbToHex } from '../color/convert';
import {
  BrushIcon,
  EraserIcon,
  HandIcon,
  LassoIcon,
  MarqueeIcon,
  PolyLassoIcon,
  ZoomIcon,
} from './icons';

const TOOLS: { id: ToolId; label: string; shortcut: string; icon: JSX.Element }[] = [
  { id: 'marquee', label: 'Rectangular Marquee', shortcut: 'M', icon: <MarqueeIcon /> },
  { id: 'lasso', label: 'Lasso', shortcut: 'L', icon: <LassoIcon /> },
  { id: 'polyLasso', label: 'Polygonal Lasso', shortcut: 'P', icon: <PolyLassoIcon /> },
  { id: 'brush', label: 'Brush', shortcut: 'B', icon: <BrushIcon /> },
  { id: 'eraser', label: 'Eraser', shortcut: 'E', icon: <EraserIcon /> },
  { id: 'pan', label: 'Hand', shortcut: 'H', icon: <HandIcon /> },
  { id: 'zoom', label: 'Zoom', shortcut: 'Z', icon: <ZoomIcon /> },
];

export function Toolbar() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const fg = useStore((s) => s.fg);
  const bg = useStore((s) => s.bg);
  const swap = useStore((s) => s.swapColors);

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
      <div className="fgbg" title="Foreground / background colors (X to swap)" onClick={swap}>
        <div
          className="swatch bg-swatch"
          style={{ background: `#${rgbToHex(hsvToRgb(bg))}` }}
        />
        <div
          className="swatch fg-swatch"
          style={{ background: `#${rgbToHex(hsvToRgb(fg))}` }}
        />
      </div>
    </div>
  );
}
