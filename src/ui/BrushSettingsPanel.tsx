import { useEffect, useRef, useState } from 'react';
import { useStore, type PaintToolId } from '../store';
import type { BrushSettings, TipShape } from '../brush/types';
import { PATTERNS, TEXTURE_BLENDS, TIP_SHAPES } from '../brush/types';
import { registeredPatternOptions } from '../brush/patterns';
import { tipCanvas } from './brushPreview';
import {
  CheckRow,
  ControlRow,
  PanelSection,
  PctSlider,
  SelectRow,
  ValSlider,
} from './controls';

/** Thumbnail of a brush tip: the alpha bitmap for sampled/textured tips. */
function TipThumb({ shape }: { shape: TipShape }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const s = (canvas.width = canvas.height = 36);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 0, s, s);
    if (shape === 'round') {
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s * 0.38, 0, Math.PI * 2);
      ctx.fill();
    } else {
      try {
        ctx.drawImage(tipCanvas(shape), 2, 2, s - 4, s - 4);
      } catch {
        // unknown tip id: leave the blank swatch
      }
    }
  }, [shape]);

  return <canvas ref={ref} className="tip-shape-thumb" title={String(shape)} />;
}

/** Tip selector with a live thumbnail of the tip texture. */
function TipRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: TipShape;
  options: { id: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="ctl-row">
      <span className="ctl-label">{label}</span>
      <TipThumb shape={value} />
      <select
        className="ctl-grow"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Photoshop-style Brush Settings panel: Brush Tip Shape plus the dynamics
 * sections, each with its enable checkbox and controls.
 */
export function BrushSettingsPanel() {
  const tool = useStore((s) => s.tool);
  const toolKey: PaintToolId = tool === 'eraser' ? 'eraser' : 'brush';
  const s = useStore((st) => st[toolKey]);
  const updateBrush = useStore((st) => st.updateBrush);
  const [open, setOpen] = useState<string>('tip');

  const upd = (patch: Partial<BrushSettings>) => updateBrush(patch, toolKey);
  const sect = <K extends keyof BrushSettings>(key: K, patch: Partial<BrushSettings[K]>) =>
    upd({ [key]: { ...(s[key] as object), ...patch } } as Partial<BrushSettings>);
  const openIt = (id: string) => setOpen((o) => (o === id ? '' : id));

  /** Builtin tip options, plus the current imported tip when one is active. */
  const tipOptions = (current: string) =>
    TIP_SHAPES.some((t) => t.id === current)
      ? TIP_SHAPES
      : [...TIP_SHAPES, { id: current, label: `Imported (${current.split(':')[1] ?? '?'})` }];

  const tipRow = (label: string, value: TipShape, onChange: (v: string) => void) => (
    <TipRow label={label} value={value} options={tipOptions(value)} onChange={onChange} />
  );

  /** Builtin patterns plus everything imported from ABR files. */
  const patternOptions = (current: string) => {
    const opts = [
      ...PATTERNS,
      ...registeredPatternOptions().map((p) => ({ id: p.id, label: `${p.label} (imported)` })),
    ];
    return opts.some((p) => p.id === current)
      ? opts
      : [...opts, { id: current, label: 'Imported' }];
  };

  return (
    <div className="panel brush-settings-panel">
      {toolKey === 'eraser' && (
        <div className="hint" style={{ marginBottom: 6 }}>
          Editing the eraser
        </div>
      )}

      <PanelSection title="Brush Tip Shape" open={open === 'tip'} onOpen={() => openIt('tip')}>
        {tipRow('Tip', s.tip.shape, (v) => sect('tip', { shape: v }))}
        <ValSlider
          label="Size"
          value={s.tip.size}
          min={1}
          max={1000}
          unit="px"
          onChange={(v) => sect('tip', { size: v })}
        />
        <PctSlider
          label="Hardness"
          value={s.tip.hardness}
          disabled={s.tip.shape !== 'round'}
          title="Solid-core fraction of the round tip"
          onChange={(v) => sect('tip', { hardness: v })}
        />
        <ValSlider
          label="Angle"
          value={s.tip.angle}
          min={-180}
          max={180}
          unit="°"
          onChange={(v) => sect('tip', { angle: v })}
        />
        <PctSlider
          label="Roundness"
          value={s.tip.roundness}
          min={1}
          onChange={(v) => sect('tip', { roundness: Math.max(v, 0.01) })}
        />
        <PctSlider
          label="Spacing"
          value={s.tip.spacing}
          min={1}
          max={1000}
          onChange={(v) => sect('tip', { spacing: Math.max(v, 0.01) })}
        />
        <div className="ctl-inline">
          <CheckRow label="Flip X" checked={s.tip.flipX} onChange={(v) => sect('tip', { flipX: v })} />
          <CheckRow label="Flip Y" checked={s.tip.flipY} onChange={(v) => sect('tip', { flipY: v })} />
        </div>
      </PanelSection>

      <PanelSection
        title="Shape Dynamics"
        enabled={s.shape.enabled}
        onToggle={(v) => sect('shape', { enabled: v })}
        open={open === 'shape'}
        onOpen={() => openIt('shape')}
      >
        <PctSlider
          label="Size Jitter"
          value={s.shape.sizeJitter}
          onChange={(v) => sect('shape', { sizeJitter: v })}
        />
        <ControlRow
          value={s.shape.sizeControl}
          onChange={(v) => sect('shape', { sizeControl: v })}
        />
        <PctSlider
          label="Min Diameter"
          value={s.shape.minDiameter}
          onChange={(v) => sect('shape', { minDiameter: v })}
        />
        <hr />
        <PctSlider
          label="Angle Jitter"
          value={s.shape.angleJitter}
          onChange={(v) => sect('shape', { angleJitter: v })}
        />
        <ControlRow
          value={s.shape.angleControl}
          allowDirection
          onChange={(v) => sect('shape', { angleControl: v })}
        />
        <hr />
        <PctSlider
          label="Round. Jitter"
          value={s.shape.roundnessJitter}
          onChange={(v) => sect('shape', { roundnessJitter: v })}
        />
        <ControlRow
          value={s.shape.roundnessControl}
          onChange={(v) => sect('shape', { roundnessControl: v })}
        />
        <PctSlider
          label="Min Roundness"
          value={s.shape.minRoundness}
          onChange={(v) => sect('shape', { minRoundness: v })}
        />
        <div className="ctl-inline">
          <CheckRow
            label="Flip X Jitter"
            checked={s.shape.flipXJitter}
            onChange={(v) => sect('shape', { flipXJitter: v })}
          />
          <CheckRow
            label="Flip Y Jitter"
            checked={s.shape.flipYJitter}
            onChange={(v) => sect('shape', { flipYJitter: v })}
          />
        </div>
      </PanelSection>

      <PanelSection
        title="Scattering"
        enabled={s.scatter.enabled}
        onToggle={(v) => sect('scatter', { enabled: v })}
        open={open === 'scatter'}
        onOpen={() => openIt('scatter')}
      >
        <CheckRow
          label="Both Axes"
          checked={s.scatter.bothAxes}
          onChange={(v) => sect('scatter', { bothAxes: v })}
        />
        <PctSlider
          label="Scatter"
          value={s.scatter.scatter}
          max={1000}
          onChange={(v) => sect('scatter', { scatter: v })}
        />
        <ControlRow
          value={s.scatter.scatterControl}
          onChange={(v) => sect('scatter', { scatterControl: v })}
        />
        <ValSlider
          label="Count"
          value={s.scatter.count}
          min={1}
          max={16}
          onChange={(v) => sect('scatter', { count: Math.round(v) })}
        />
        <PctSlider
          label="Count Jitter"
          value={s.scatter.countJitter}
          onChange={(v) => sect('scatter', { countJitter: v })}
        />
      </PanelSection>

      <PanelSection
        title="Texture"
        enabled={s.texture.enabled}
        onToggle={(v) => sect('texture', { enabled: v })}
        open={open === 'texture'}
        onOpen={() => openIt('texture')}
      >
        <SelectRow
          label="Pattern"
          value={s.texture.pattern}
          options={patternOptions(s.texture.pattern)}
          onChange={(v) => sect('texture', { pattern: v })}
        />
        <PctSlider
          label="Scale"
          value={s.texture.scale}
          min={10}
          max={400}
          onChange={(v) => sect('texture', { scale: v })}
        />
        <ValSlider
          label="Brightness"
          value={Math.round(s.texture.brightness * 150)}
          min={-150}
          max={150}
          onChange={(v) => sect('texture', { brightness: v / 150 })}
        />
        <ValSlider
          label="Contrast"
          value={Math.round(s.texture.contrast * 100)}
          min={-50}
          max={100}
          onChange={(v) => sect('texture', { contrast: v / 100 })}
        />
        <CheckRow
          label="Invert"
          checked={s.texture.invert}
          onChange={(v) => sect('texture', { invert: v })}
        />
        <SelectRow
          label="Mode"
          value={s.texture.mode}
          options={TEXTURE_BLENDS}
          onChange={(v) => sect('texture', { mode: v })}
        />
        <PctSlider
          label="Depth"
          value={s.texture.depth}
          onChange={(v) => sect('texture', { depth: v })}
        />
        <CheckRow
          label="Texture Each Tip"
          checked={s.texture.textureEachTip}
          onChange={(v) => sect('texture', { textureEachTip: v })}
          title="Apply the texture per stamp (enables depth jitter) instead of once per stroke"
        />
        <PctSlider
          label="Depth Jitter"
          value={s.texture.depthJitter}
          disabled={!s.texture.textureEachTip}
          onChange={(v) => sect('texture', { depthJitter: v })}
        />
        <ControlRow
          value={s.texture.depthControl}
          disabled={!s.texture.textureEachTip}
          onChange={(v) => sect('texture', { depthControl: v })}
        />
      </PanelSection>

      <PanelSection
        title="Dual Brush"
        enabled={s.dual.enabled}
        onToggle={(v) => sect('dual', { enabled: v })}
        open={open === 'dual'}
        onOpen={() => openIt('dual')}
      >
        {tipRow('Tip', s.dual.shape, (v) => sect('dual', { shape: v }))}
        <PctSlider
          label="Hardness"
          value={s.dual.hardness}
          disabled={s.dual.shape !== 'round'}
          onChange={(v) => sect('dual', { hardness: v })}
        />
        <SelectRow
          label="Mode"
          value={s.dual.mode}
          options={TEXTURE_BLENDS}
          onChange={(v) => sect('dual', { mode: v })}
        />
        <ValSlider
          label="Size"
          value={s.dual.size}
          min={1}
          max={512}
          unit="px"
          onChange={(v) => sect('dual', { size: v })}
        />
        <PctSlider
          label="Spacing"
          value={s.dual.spacing}
          min={1}
          max={1000}
          onChange={(v) => sect('dual', { spacing: Math.max(v, 0.01) })}
        />
        <PctSlider
          label="Scatter"
          value={s.dual.scatter}
          max={1000}
          onChange={(v) => sect('dual', { scatter: v })}
        />
        <CheckRow
          label="Both Axes"
          checked={s.dual.bothAxes}
          onChange={(v) => sect('dual', { bothAxes: v })}
        />
        <ValSlider
          label="Count"
          value={s.dual.count}
          min={1}
          max={16}
          onChange={(v) => sect('dual', { count: Math.round(v) })}
        />
        <PctSlider
          label="Count Jitter"
          value={s.dual.countJitter}
          onChange={(v) => sect('dual', { countJitter: v })}
        />
      </PanelSection>

      <PanelSection
        title="Color Dynamics"
        enabled={s.color.enabled}
        onToggle={(v) => sect('color', { enabled: v })}
        open={open === 'color'}
        onOpen={() => openIt('color')}
      >
        <CheckRow
          label="Apply Per Tip"
          checked={s.color.applyPerTip}
          onChange={(v) => sect('color', { applyPerTip: v })}
        />
        <PctSlider
          label="FG/BG Jitter"
          value={s.color.fgBgJitter}
          onChange={(v) => sect('color', { fgBgJitter: v })}
        />
        <ControlRow
          value={s.color.fgBgControl}
          onChange={(v) => sect('color', { fgBgControl: v })}
        />
        <PctSlider
          label="Hue Jitter"
          value={s.color.hueJitter}
          onChange={(v) => sect('color', { hueJitter: v })}
        />
        <PctSlider
          label="Sat. Jitter"
          value={s.color.satJitter}
          onChange={(v) => sect('color', { satJitter: v })}
        />
        <PctSlider
          label="Bright. Jitter"
          value={s.color.briJitter}
          onChange={(v) => sect('color', { briJitter: v })}
        />
        <ValSlider
          label="Purity"
          value={Math.round(s.color.purity * 100)}
          min={-100}
          max={100}
          unit="%"
          onChange={(v) => sect('color', { purity: v / 100 })}
        />
      </PanelSection>

      <PanelSection
        title="Transfer"
        enabled={s.transfer.enabled}
        onToggle={(v) => sect('transfer', { enabled: v })}
        open={open === 'transfer'}
        onOpen={() => openIt('transfer')}
      >
        <PctSlider
          label="Opacity Jitter"
          value={s.transfer.opacityJitter}
          onChange={(v) => sect('transfer', { opacityJitter: v })}
        />
        <ControlRow
          value={s.transfer.opacityControl}
          onChange={(v) => sect('transfer', { opacityControl: v })}
        />
        <PctSlider
          label="Minimum"
          value={s.transfer.opacityMin}
          onChange={(v) => sect('transfer', { opacityMin: v })}
        />
        <hr />
        <PctSlider
          label="Flow Jitter"
          value={s.transfer.flowJitter}
          onChange={(v) => sect('transfer', { flowJitter: v })}
        />
        <ControlRow
          value={s.transfer.flowControl}
          onChange={(v) => sect('transfer', { flowControl: v })}
        />
        <PctSlider
          label="Minimum"
          value={s.transfer.flowMin}
          onChange={(v) => sect('transfer', { flowMin: v })}
        />
      </PanelSection>

      <div className="bs-toggles">
        <CheckRow label="Noise" checked={s.noise} onChange={(v) => upd({ noise: v })} />
        <CheckRow label="Wet Edges" checked={s.wetEdges} onChange={(v) => upd({ wetEdges: v })} />
        <CheckRow
          label="Build-up"
          checked={s.airbrush}
          onChange={(v) => upd({ airbrush: v })}
          title="Airbrush: keep depositing while the pointer is held still"
        />
      </div>
      <PctSlider
        label="Smoothing"
        value={s.smoothing}
        onChange={(v) => upd({ smoothing: v })}
      />
    </div>
  );
}
