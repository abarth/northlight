import { useEffect, useRef, useState } from 'react';
import { exportPng, redo, setSelection, undo } from '../controller';
import { useStore, type PaintToolId } from '../store';
import { BLEND_MODES, type BlendMode } from '../types';
import { AirbrushIcon, PenIcon, RedoIcon, SettingsIcon, UndoIcon } from './icons';
import { PctSlider, ValSlider } from './controls';
import { drawBrushPreview } from './brushPreview';

function PctField({
  label,
  value,
  onChange,
  title,
}: {
  label: string;
  value: number; // 0..1
  onChange: (v: number) => void;
  title?: string;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="opt-field" title={title}>
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <input
        className="num"
        type="number"
        min={0}
        max={100}
        value={pct}
        onChange={(e) => onChange(Math.min(100, Math.max(0, Number(e.target.value))) / 100)}
      />
    </label>
  );
}

/** Brush preset picker dropdown: tip preview + size/hardness/angle sliders. */
function TipPicker({ toolKey }: { toolKey: PaintToolId }) {
  const settings = useStore((s) => s[toolKey]);
  const updateBrush = useStore((s) => s.updateBrush);
  const [openPicker, setOpenPicker] = useState(false);
  const thumbRef = useRef<HTMLCanvasElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (thumbRef.current) drawBrushPreview(thumbRef.current, settings);
  }, [settings]);

  useEffect(() => {
    if (!openPicker) return;
    const close = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpenPicker(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [openPicker]);

  const tip = settings.tip;
  return (
    <div className="tip-picker" ref={popRef}>
      <button
        className="tip-picker-btn"
        title="Brush tip (size, hardness, angle, roundness)"
        onClick={() => setOpenPicker(!openPicker)}
      >
        <canvas ref={thumbRef} className="tip-thumb" />
        <span>{Math.round(tip.size)}px ▾</span>
      </button>
      {openPicker && (
        <div className="tip-popover">
          <ValSlider
            label="Size"
            value={tip.size}
            min={1}
            max={1000}
            unit="px"
            onChange={(v) => updateBrush({ tip: { ...tip, size: v } }, toolKey)}
          />
          <PctSlider
            label="Hardness"
            value={tip.hardness}
            disabled={tip.shape !== 'round'}
            onChange={(v) => updateBrush({ tip: { ...tip, hardness: v } }, toolKey)}
          />
          <ValSlider
            label="Angle"
            value={tip.angle}
            min={-180}
            max={180}
            unit="°"
            onChange={(v) => updateBrush({ tip: { ...tip, angle: v } }, toolKey)}
          />
          <PctSlider
            label="Roundness"
            value={tip.roundness}
            min={1}
            onChange={(v) => updateBrush({ tip: { ...tip, roundness: Math.max(v, 0.01) } }, toolKey)}
          />
          <div className="hint" style={{ padding: '4px 2px' }}>
            More presets and dynamics live in the Brushes / Brush Settings tabs.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Photoshop-style brush options bar: tip picker, Mode, Opacity (+ pressure
 * override), Flow (+ airbrush), Smoothing, and the pressure-for-size button.
 */
function BrushOptions({ toolKey }: { toolKey: PaintToolId }) {
  const settings = useStore((s) => s[toolKey]);
  const updateBrush = useStore((s) => s.updateBrush);
  const setSideTab = useStore((s) => s.setSideTab);

  return (
    <>
      <TipPicker toolKey={toolKey} />
      <button
        className="icon-btn"
        title="Toggle the Brush Settings panel"
        onClick={() => setSideTab('settings')}
      >
        <SettingsIcon size={16} />
      </button>
      {toolKey === 'brush' && (
        <label className="opt-field" title="Painting mode: how strokes blend into the layer">
          <span>Mode</span>
          <select
            value={settings.blendMode}
            onChange={(e) => updateBrush({ blendMode: e.target.value as BlendMode }, toolKey)}
          >
            {BLEND_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <PctField
        label="Opacity"
        title="Maximum darkness a single stroke can reach (digits set this)"
        value={settings.opacity}
        onChange={(v) => updateBrush({ opacity: v }, toolKey)}
      />
      <button
        className={`icon-btn toggle ${settings.pressureOpacity ? 'active' : ''}`}
        title="Always use pen pressure for opacity (overrides Transfer)"
        onClick={() => updateBrush({ pressureOpacity: !settings.pressureOpacity }, toolKey)}
      >
        <PenIcon size={15} />
      </button>
      <PctField
        label="Flow"
        title="Paint laid down per stamp; builds up within a stroke (Shift+digits)"
        value={settings.flow}
        onChange={(v) => updateBrush({ flow: v }, toolKey)}
      />
      <button
        className={`icon-btn toggle ${settings.airbrush ? 'active' : ''}`}
        title="Airbrush build-up: keep depositing while the pointer is held"
        onClick={() => updateBrush({ airbrush: !settings.airbrush }, toolKey)}
      >
        <AirbrushIcon size={15} />
      </button>
      <PctField
        label="Smoothing"
        title="Input smoothing for steadier lines"
        value={settings.smoothing}
        onChange={(v) => updateBrush({ smoothing: v }, toolKey)}
      />
      <button
        className={`icon-btn toggle ${settings.pressureSize ? 'active' : ''}`}
        title="Always use pen pressure for size (overrides Shape Dynamics)"
        onClick={() => updateBrush({ pressureSize: !settings.pressureSize }, toolKey)}
      >
        <PenIcon size={15} />
        <span className="toggle-tag">Size</span>
      </button>
    </>
  );
}

export function OptionsBar() {
  const tool = useStore((s) => s.tool);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const hasSelection = useStore((s) => s.selectionPaths !== null);
  const view = useStore((s) => s.view);

  return (
    <div className="options-bar">
      <div className="brand">Northlight</div>
      <div className="options-scroll">
        {(tool === 'brush' || tool === 'eraser') && <BrushOptions toolKey={tool} />}
        {(tool === 'marquee' || tool === 'lasso' || tool === 'polyLasso') && (
          <>
            <span className="hint">
              {tool === 'polyLasso'
                ? 'Click to add points; click the start point, double-click, or press Enter to close. Esc cancels.'
                : 'Drag to select. Click to deselect. Selections clip painting.'}
            </span>
            {hasSelection && (
              <button className="btn" onClick={() => setSelection(null)}>
                Deselect (Ctrl+D)
              </button>
            )}
          </>
        )}
        {tool === 'zoom' && (
          <span className="hint">Click to zoom in, Alt+click out, drag to scrub. Ctrl+0 fits.</span>
        )}
        {tool === 'pan' && <span className="hint">Drag to pan. Hold Space from any tool.</span>}
      </div>
      <div className="options-right">
        <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
        <button className="icon-btn" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
          <UndoIcon size={16} />
        </button>
        <button
          className="icon-btn"
          disabled={!canRedo}
          onClick={redo}
          title="Redo (Ctrl+Shift+Z)"
        >
          <RedoIcon size={16} />
        </button>
        <button className="btn" onClick={() => void exportPng()} title="Export flattened PNG">
          Export PNG
        </button>
      </div>
    </div>
  );
}
