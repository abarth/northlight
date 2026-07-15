import { addLayer, deleteLayer, duplicateLayer } from '../controller';
import { useStore } from '../store';
import { BLEND_MODES, type BlendMode } from '../types';
import {
  CopyIcon,
  DownIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  TrashIcon,
  UpIcon,
} from './icons';
import { useState } from 'react';

export function LayersPanel() {
  const layers = useStore((s) => s.layers);
  const activeId = useStore((s) => s.activeLayerId);
  const setActive = useStore((s) => s.setActiveLayer);
  const patchLayer = useStore((s) => s.patchLayer);
  const moveLayer = useStore((s) => s.moveLayer);
  const [renaming, setRenaming] = useState<string | null>(null);

  const active = layers.find((l) => l.id === activeId);
  const displayed = [...layers].reverse(); // top of stack first

  return (
    <div className="panel layers-panel">
      <div className="panel-title">Layers</div>
      <div className="layers-controls">
        <select
          value={active?.blendMode ?? 'normal'}
          disabled={!active}
          onChange={(e) =>
            active && patchLayer(active.id, { blendMode: e.target.value as BlendMode })
          }
          title="Blend mode"
        >
          {BLEND_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <label className="layers-opacity" title="Layer opacity">
          <span>Opacity</span>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((active?.opacity ?? 1) * 100)}
            disabled={!active}
            onChange={(e) =>
              active && patchLayer(active.id, { opacity: Number(e.target.value) / 100 })
            }
          />
          <span className="num-label">{Math.round((active?.opacity ?? 1) * 100)}%</span>
        </label>
      </div>
      <div className="layers-list">
        {displayed.map((l) => (
          <div
            key={l.id}
            className={`layer-row ${l.id === activeId ? 'active' : ''}`}
            onClick={() => setActive(l.id)}
          >
            <button
              className="icon-btn eye"
              title={l.visible ? 'Hide layer' : 'Show layer'}
              onClick={(e) => {
                e.stopPropagation();
                patchLayer(l.id, { visible: !l.visible });
              }}
            >
              {l.visible ? <EyeIcon size={15} /> : <EyeOffIcon size={15} />}
            </button>
            {renaming === l.id ? (
              <input
                className="rename"
                autoFocus
                defaultValue={l.name}
                onBlur={(e) => {
                  patchLayer(l.id, { name: e.target.value || l.name });
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <span className="layer-name" onDoubleClick={() => setRenaming(l.id)}>
                {l.name}
              </span>
            )}
            {l.blendMode !== 'normal' && (
              <span className="layer-mode">
                {BLEND_MODES.find((m) => m.id === l.blendMode)?.label}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="layers-buttons">
        <button className="icon-btn" onClick={addLayer} title="New layer">
          <PlusIcon size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => active && duplicateLayer(active.id)}
          title="Duplicate layer"
        >
          <CopyIcon size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => active && moveLayer(active.id, 1)}
          title="Move layer up"
        >
          <UpIcon size={15} />
        </button>
        <button
          className="icon-btn"
          onClick={() => active && moveLayer(active.id, -1)}
          title="Move layer down"
        >
          <DownIcon size={15} />
        </button>
        <button
          className="icon-btn danger"
          disabled={layers.length <= 1}
          onClick={() => active && deleteLayer(active.id)}
          title="Delete layer"
        >
          <TrashIcon size={15} />
        </button>
      </div>
    </div>
  );
}
