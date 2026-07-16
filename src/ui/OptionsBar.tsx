import { useEffect, useRef } from 'react';
import {
  cancelTransform,
  commitTransform,
  deleteSelectionContents,
  fillActiveLayer,
  setSelection,
} from '../controller';
import type { SelectionOp } from '../gpu/selection';
import {
  useStore,
  type EyedropperSample,
  type EyedropperSampleSize,
  type PaintToolId,
} from '../store';
import { BLEND_MODES, type BlendMode } from '../types';
import { AirbrushIcon, PenIcon, SettingsIcon } from './icons';
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

/** Brush preview button: opens the Brushes (presets) panel. */
function TipButton({ toolKey }: { toolKey: PaintToolId }) {
  const settings = useStore((s) => s[toolKey]);
  const setSideTab = useStore((s) => s.setSideTab);
  const thumbRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (thumbRef.current) drawBrushPreview(thumbRef.current, settings);
  }, [settings]);

  return (
    <button
      className="tip-picker-btn"
      title="Open the Brushes panel"
      onClick={() => setSideTab('brushes')}
    >
      <canvas ref={thumbRef} className="tip-thumb" />
      <span>{Math.round(settings.tip.size)}px</span>
    </button>
  );
}

/**
 * Photoshop-style brush options bar: brush preview button, Mode, Opacity
 * (+ pressure override), Flow (+ airbrush), Smoothing, and the
 * pressure-for-size button.
 */
function BrushOptions({ toolKey }: { toolKey: PaintToolId }) {
  const settings = useStore((s) => s[toolKey]);
  const updateBrush = useStore((s) => s.updateBrush);
  const setSideTab = useStore((s) => s.setSideTab);

  return (
    <>
      <TipButton toolKey={toolKey} />
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

const SAMPLE_SIZES: { value: EyedropperSampleSize; label: string }[] = [
  { value: 1, label: 'Point Sample' },
  { value: 3, label: '3 by 3 Average' },
  { value: 5, label: '5 by 5 Average' },
  { value: 11, label: '11 by 11 Average' },
  { value: 31, label: '31 by 31 Average' },
  { value: 51, label: '51 by 51 Average' },
  { value: 101, label: '101 by 101 Average' },
];

const SAMPLE_SCOPES: { value: EyedropperSample; label: string }[] = [
  { value: 'all', label: 'All Layers' },
  { value: 'currentBelow', label: 'Current & Below' },
  { value: 'current', label: 'Current Layer' },
];

/** Photoshop-style eyedropper options: Sample Size and Sample scope. */
function EyedropperOptions() {
  const sampleSize = useStore((s) => s.eyedropperSampleSize);
  const sample = useStore((s) => s.eyedropperSample);
  const setSampleSize = useStore((s) => s.setEyedropperSampleSize);
  const setSample = useStore((s) => s.setEyedropperSample);

  return (
    <>
      <label className="opt-field" title="How many pixels to average around the click">
        <span>Sample Size</span>
        <select
          value={sampleSize}
          onChange={(e) => setSampleSize(Number(e.target.value) as EyedropperSampleSize)}
        >
          {SAMPLE_SIZES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="opt-field" title="Which layers the sample reads from">
        <span>Sample</span>
        <select
          value={sample}
          onChange={(e) => setSample(e.target.value as EyedropperSample)}
        >
          {SAMPLE_SCOPES.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <span className="hint">Click picks the foreground color; Alt+click picks the background.</span>
    </>
  );
}

const SELECTION_OPS: { op: SelectionOp; label: string; title: string }[] = [
  { op: 'new', label: 'New', title: 'New selection' },
  { op: 'add', label: 'Add', title: 'Add to selection (Shift)' },
  { op: 'subtract', label: 'Subtract', title: 'Subtract from selection (Alt)' },
  { op: 'intersect', label: 'Intersect', title: 'Intersect with selection (Shift+Alt)' },
];

/** New / Add / Subtract / Intersect toggle group for the selection tools. */
function SelectionOpButtons() {
  const op = useStore((s) => s.selectionOp);
  const setOp = useStore((s) => s.setSelectionOp);
  return (
    <div className="opt-group">
      {SELECTION_OPS.map((o) => (
        <button
          key={o.op}
          className={`icon-btn toggle ${op === o.op ? 'active' : ''}`}
          title={o.title}
          onClick={() => setOp(o.op)}
        >
          <span className="toggle-tag">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const TRANSFORM_LABEL: Record<string, string> = {
  free: 'Free Transform',
  scale: 'Scale',
  rotate: 'Rotate',
  skew: 'Skew',
  distort: 'Distort',
  perspective: 'Perspective',
};

/** Photoshop-style move options: Auto-Select and Show Transform Controls. */
function MoveOptions() {
  const autoSelect = useStore((s) => s.moveAutoSelect);
  const showTransform = useStore((s) => s.moveShowTransform);
  const setAutoSelect = useStore((s) => s.setMoveAutoSelect);
  const setShowTransform = useStore((s) => s.setMoveShowTransform);
  return (
    <>
      <label
        className="opt-check"
        title="Clicking activates the topmost layer with pixels under the cursor"
      >
        <input
          type="checkbox"
          checked={autoSelect}
          onChange={(e) => setAutoSelect(e.target.checked)}
        />
        Auto-Select
      </label>
      <label
        className="opt-check"
        title="Show the transform box around the moved content; dragging a handle transforms"
      >
        <input
          type="checkbox"
          checked={showTransform}
          onChange={(e) => setShowTransform(e.target.checked)}
        />
        Show Transform Controls
      </label>
      <span className="hint">
        Drag to move the layer or selected pixels (Enter applies, Esc cancels).
        Alt-drag duplicates. Arrows nudge (Shift = 10px).
      </span>
    </>
  );
}

export function OptionsBar() {
  const tool = useStore((s) => s.tool);
  const hasSelection = useStore((s) => s.selectionPaths !== null);
  const transform = useStore((s) => s.transform);
  const view = useStore((s) => s.view);

  // An engaged transform shows Apply/Cancel; an un-engaged move-tool float
  // keeps the regular move options, like Photoshop.
  if (transform && transform.engaged) {
    return (
      <div className="options-bar">
        <div className="options-scroll">
          <span className="hint">
            {TRANSFORM_LABEL[transform.mode]}
            {transform.target === 'selection' ? ' (selection)' : ''} — drag handles;
            rotate outside; Shift constrains; Alt from center; Ctrl distorts/skews.
          </span>
        </div>
        <div className="options-right">
          <button className="btn" onClick={commitTransform} title="Apply (Enter)">
            Apply
          </button>
          <button className="btn" onClick={cancelTransform} title="Cancel (Esc)">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="options-bar">
      <div className="options-scroll">
        {tool === 'move' && <MoveOptions />}
        {(tool === 'brush' || tool === 'eraser') && <BrushOptions toolKey={tool} />}
        {(tool === 'marquee' || tool === 'lasso' || tool === 'polyLasso') && (
          <>
            <SelectionOpButtons />
            <span className="hint">
              {tool === 'polyLasso'
                ? 'Click to add points; click the start point, double-click, or press Enter to close. Esc cancels.'
                : 'Drag to select. Click to deselect. Selections clip painting.'}
            </span>
            {hasSelection && (
              <>
                <button
                  className="btn"
                  onClick={() => fillActiveLayer('fg')}
                  title="Fill the selection with the foreground color (Alt+Backspace)"
                >
                  Fill FG
                </button>
                <button
                  className="btn"
                  onClick={deleteSelectionContents}
                  title="Delete the selected pixels (Backspace) — transparent, or background color on the Background layer"
                >
                  Delete
                </button>
                <button className="btn" onClick={() => setSelection(null)}>
                  Deselect (Ctrl+D)
                </button>
              </>
            )}
          </>
        )}
        {tool === 'eyedropper' && <EyedropperOptions />}
        {tool === 'zoom' && (
          <span className="hint">Click to zoom in, Alt+click out, drag to scrub. Ctrl+0 fits.</span>
        )}
        {tool === 'pan' && <span className="hint">Drag to pan. Hold Space from any tool.</span>}
      </div>
      <div className="options-right">
        <span className="zoom-label">{Math.round(view.zoom * 100)}%</span>
      </div>
    </div>
  );
}
