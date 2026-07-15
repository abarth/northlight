import { exportPng, redo, setSelection, undo } from '../controller';
import { useStore } from '../store';
import type { BrushPreset } from '../types';
import { PenIcon, RedoIcon, UndoIcon } from './icons';

function PercentField({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  title,
}: {
  label: string;
  value: number; // 0..1
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  title?: string;
}) {
  const pct = Math.round(value * 100);
  return (
    <label className="opt-field" title={title}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <input
        className="num"
        type="number"
        min={min}
        max={max}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    </label>
  );
}

function PressureToggle({
  label,
  active,
  onToggle,
  title,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  title: string;
}) {
  return (
    <button
      className={`pressure-toggle ${active ? 'active' : ''}`}
      onClick={onToggle}
      title={title}
    >
      <PenIcon size={13} />
      {label}
    </button>
  );
}

function BrushOptions({ toolKey }: { toolKey: 'brush' | 'eraser' }) {
  const settings = useStore((s) => s[toolKey]);
  const update = useStore((s) => s.updateBrush);
  const applyPreset = useStore((s) => s.applyPreset);

  return (
    <>
      <label className="opt-field" title="Brush tip">
        <span>Tip</span>
        <select
          value={settings.preset}
          onChange={(e) => applyPreset(e.target.value as BrushPreset, toolKey)}
        >
          <option value="soft-round">Soft Round</option>
          <option value="hard-round">Hard Round</option>
          <option value="round">Round (custom hardness)</option>
        </select>
      </label>
      <label className="opt-field" title="Brush diameter in pixels">
        <span>Size</span>
        <input
          type="range"
          min={1}
          max={500}
          value={Math.round(settings.size)}
          onChange={(e) => update({ size: Number(e.target.value) }, toolKey)}
        />
        <input
          className="num"
          type="number"
          min={1}
          max={1000}
          value={Math.round(settings.size)}
          onChange={(e) => update({ size: Math.max(1, Number(e.target.value)) }, toolKey)}
        />
      </label>
      <PercentField
        label="Hardness"
        title="Size of the solid core; 0% is a Photoshop-style soft round"
        value={settings.hardness}
        onChange={(v) => update({ hardness: v, preset: 'round' }, toolKey)}
      />
      <PercentField
        label="Opacity"
        title="Maximum darkness a single stroke can reach"
        value={settings.opacity}
        onChange={(v) => update({ opacity: v }, toolKey)}
      />
      <PercentField
        label="Flow"
        title="Paint laid down per stamp; builds up within a stroke"
        value={settings.flow}
        onChange={(v) => update({ flow: v }, toolKey)}
      />
      <PercentField
        label="Spacing"
        title="Distance between stamps as % of brush size"
        value={settings.spacing}
        min={1}
        max={200}
        onChange={(v) => update({ spacing: Math.max(0.01, v) }, toolKey)}
      />
      <PercentField
        label="Smoothing"
        title="Input smoothing for steadier lines"
        value={settings.smoothing}
        onChange={(v) => update({ smoothing: v }, toolKey)}
      />
      <div className="opt-group" title="Pen pressure dynamics">
        <PressureToggle
          label="Size"
          active={settings.pressureSize}
          onToggle={() => update({ pressureSize: !settings.pressureSize }, toolKey)}
          title="Pen pressure controls size"
        />
        <PressureToggle
          label="Opacity"
          active={settings.pressureOpacity}
          onToggle={() => update({ pressureOpacity: !settings.pressureOpacity }, toolKey)}
          title="Pen pressure controls opacity"
        />
        <PressureToggle
          label="Flow"
          active={settings.pressureFlow}
          onToggle={() => update({ pressureFlow: !settings.pressureFlow }, toolKey)}
          title="Pen pressure controls flow"
        />
      </div>
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
