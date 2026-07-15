import { useEffect, useRef, useState } from 'react';
import { BRUSH_GROUPS, type BrushPreset } from '../brush/presets';
import { useStore, type PaintToolId } from '../store';
import { drawBrushPreview } from './brushPreview';
import { ValSlider } from './controls';

function PresetRow({
  preset,
  active,
  onSelect,
}: {
  preset: BrushPreset;
  active: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawBrushPreview(ref.current, preset.settings);
  }, [preset]);
  return (
    <div className={`preset-row ${active ? 'active' : ''}`} onClick={onSelect} title={preset.name}>
      <canvas ref={ref} className="preset-thumb" />
      <span className="preset-name">{preset.name}</span>
      <span className="preset-size">{Math.round(preset.settings.tip.size)}</span>
    </div>
  );
}

export function BrushesPanel() {
  const tool = useStore((s) => s.tool);
  const toolKey: PaintToolId = tool === 'eraser' ? 'eraser' : 'brush';
  const settings = useStore((s) => s[toolKey]);
  const activePreset = useStore((s) => s.activePreset[toolKey]);
  const applyPreset = useStore((s) => s.applyPreset);
  const updateBrush = useStore((s) => s.updateBrush);
  const [closed, setClosed] = useState<Record<string, boolean>>({});

  return (
    <div className="panel brushes-panel">
      <div className="panel-title">Brushes {toolKey === 'eraser' ? '(Eraser)' : ''}</div>
      <ValSlider
        label="Size"
        value={settings.tip.size}
        min={1}
        max={1000}
        unit="px"
        onChange={(v) => updateBrush({ tip: { ...settings.tip, size: v } }, toolKey)}
      />
      <div className="preset-groups">
        {BRUSH_GROUPS.map((group) => {
          const open = !closed[group.id];
          return (
            <div key={group.id} className="preset-group">
              <div
                className="preset-group-header"
                onClick={() => setClosed((c) => ({ ...c, [group.id]: open }))}
              >
                <span className="bs-arrow">{open ? '▾' : '▸'}</span>
                {group.name}
              </div>
              {open &&
                group.presets.map((preset) => (
                  <PresetRow
                    key={preset.id}
                    preset={preset}
                    active={preset.id === activePreset}
                    onSelect={() => applyPreset(preset.id, toolKey)}
                  />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
