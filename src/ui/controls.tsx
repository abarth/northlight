import type { ReactNode } from 'react';
import { CONTROL_SOURCES, type DynamicControl } from '../brush/types';

/** Labeled slider + numeric field. `value` is in model units. */
export function ValSlider({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = '',
  disabled = false,
  title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  title?: string;
}) {
  const shown = step >= 1 ? Math.round(value) : Math.round(value * 100) / 100;
  return (
    <label className={`ctl-row ${disabled ? 'disabled' : ''}`} title={title}>
      <span className="ctl-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="ctl-value">
        <input
          className="num"
          type="number"
          min={min}
          max={max}
          step={step}
          value={shown}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
        />
        {unit}
      </span>
    </label>
  );
}

/** Slider for a 0..1 model value shown as 0..100%. */
export function PctSlider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  disabled = false,
  title,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <ValSlider
      label={label}
      value={Math.round(value * 100)}
      onChange={(v) => onChange(v / 100)}
      min={min}
      max={max}
      unit="%"
      disabled={disabled}
      title={title}
    />
  );
}

/** Photoshop's "Control:" dropdown with fade-steps input. */
export function ControlRow({
  label = 'Control',
  value,
  onChange,
  disabled = false,
  allowDirection = false,
}: {
  label?: string;
  value: DynamicControl;
  onChange: (v: DynamicControl) => void;
  disabled?: boolean;
  /** direction sources only make sense for angle */
  allowDirection?: boolean;
}) {
  const sources = CONTROL_SOURCES.filter(
    (s) => allowDirection || (s.id !== 'direction' && s.id !== 'initial-direction'),
  );
  return (
    <div className={`ctl-row ctl-control ${disabled ? 'disabled' : ''}`}>
      <span className="ctl-label">{label}</span>
      <select
        value={value.source}
        disabled={disabled}
        onChange={(e) => onChange({ ...value, source: e.target.value as DynamicControl['source'] })}
      >
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {value.source === 'fade' && (
        <input
          className="num"
          type="number"
          min={1}
          max={9999}
          value={value.fadeSteps}
          disabled={disabled}
          title="Fade steps"
          onChange={(e) =>
            onChange({ ...value, fadeSteps: Math.max(1, Number(e.target.value) || 1) })
          }
        />
      )}
    </div>
  );
}

export function CheckRow({
  label,
  checked,
  onChange,
  disabled = false,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className={`ctl-check ${disabled ? 'disabled' : ''}`} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`ctl-row ${disabled ? 'disabled' : ''}`}>
      <span className="ctl-label">{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Accordion section with an optional enable checkbox, Photoshop-style. */
export function PanelSection({
  title,
  enabled,
  onToggle,
  open,
  onOpen,
  children,
}: {
  title: string;
  /** undefined = always-on section (no checkbox) */
  enabled?: boolean;
  onToggle?: (v: boolean) => void;
  open: boolean;
  onOpen: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={`bs-section ${open ? 'open' : ''}`}>
      <div className="bs-header" onClick={onOpen}>
        {onToggle ? (
          <input
            type="checkbox"
            checked={enabled ?? false}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onToggle(e.target.checked)}
          />
        ) : (
          <span className="bs-dot" />
        )}
        <span className={`bs-title ${enabled === false ? 'off' : ''}`}>{title}</span>
        <span className="bs-arrow">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="bs-body">{children}</div>}
    </div>
  );
}
