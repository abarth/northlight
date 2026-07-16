import { useEffect, useRef, useState } from 'react';
import { allGroups, type BrushPreset } from '../brush/presets';
import { importAbr } from '../controller';
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
  useStore((s) => s.presetRevision); // re-render when the library changes
  const applyPreset = useStore((s) => s.applyPreset);
  const updateBrush = useStore((s) => s.updateBrush);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  async function onImportFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        const count = importAbr(file.name, await file.arrayBuffer());
        console.info(`[northlight] imported ${count} brushes from ${file.name}`);
      } catch (err) {
        alert(`Could not import ${file.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="panel brushes-panel">
      <div className="panel-title-row">
        <span className="hint">{toolKey === 'eraser' ? 'Editing the eraser' : ''}</span>
        <button
          className="btn small"
          title="Import brushes from a Photoshop .abr file"
          onClick={() => fileRef.current?.click()}
        >
          Import ABR…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".abr"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => void onImportFiles(e.target.files)}
        />
      </div>
      <ValSlider
        label="Size"
        value={settings.tip.size}
        min={1}
        max={1000}
        unit="px"
        onChange={(v) => updateBrush({ tip: { ...settings.tip, size: v } }, toolKey)}
      />
      <div className="preset-groups">
        {allGroups().map((group) => {
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
