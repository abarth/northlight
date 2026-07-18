import {
  addGroup,
  addLayer,
  canDeleteActiveLayer,
  deleteLayer,
  toggleActiveLayerLock,
} from '../controller';
import {
  displayRows,
  effectiveVisible,
  hasOwnLock,
  isDescendantOf,
  moveSubtree,
  type DropPosition,
} from '../layers';
import { useStore } from '../store';
import { BLEND_MODES, type BlendMode, type LayerMeta } from '../types';
import {
  BrushIcon,
  CheckerIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderPlusIcon,
  LockIcon,
  MoveIcon,
  PlusIcon,
  TrashIcon,
} from './icons';
import { useEffect, useState } from 'react';

/** Photoshop's Lock row: transparent pixels, image pixels, position, all. */
const LOCK_BUTTONS = [
  { kind: 'transparency', title: 'Lock transparent pixels', icon: CheckerIcon },
  { kind: 'pixels', title: 'Lock image pixels', icon: BrushIcon },
  { kind: 'position', title: 'Lock position', icon: MoveIcon },
  { kind: 'all', title: 'Lock all', icon: LockIcon },
] as const;

export function LayersPanel() {
  const layers = useStore((s) => s.layers);
  const activeId = useStore((s) => s.activeLayerId);
  const setActive = useStore((s) => s.setActiveLayer);
  const patchLayer = useStore((s) => s.patchLayer);
  const setLayers = useStore((s) => s.setLayers);
  const renameNonce = useStore((s) => s.renameNonce);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; pos: DropPosition } | null>(null);

  const active = layers.find((l) => l.id === activeId);
  const isGroup = active?.kind === 'group';
  const rows = displayRows(layers);

  // Layer > Rename Layer opens the inline rename on the active row
  useEffect(() => {
    if (renameNonce > 0) setRenaming(useStore.getState().activeLayerId);
  }, [renameNonce]);

  const completeDrop = () => {
    if (dragId && drop) {
      const s = useStore.getState();
      const next = moveSubtree(s.layers, dragId, drop.id, drop.pos);
      if (next) setLayers(next, s.activeLayerId);
    }
    setDragId(null);
    setDrop(null);
  };

  const dropZoneFor = (
    meta: LayerMeta,
    e: React.DragEvent<HTMLDivElement>,
  ): DropPosition => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = (e.clientY - rect.top) / rect.height;
    if (meta.kind !== 'group') return t > 0.5 ? 'below' : 'above';
    // group rows: edges reorder around the group, the middle drops into it
    if (t < 0.25) return 'above';
    if (meta.collapsed && t > 0.75) return 'below';
    return 'into';
  };

  return (
    <div className="panel layers-panel">
      <div className="panel-title">Layers</div>
      <div className="layers-controls">
        {isGroup ? (
          <select value="passthrough" disabled title="Groups blend as pass-through">
            <option value="passthrough">Pass Through</option>
          </select>
        ) : (
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
        )}
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
        <div className="layers-locks" title="Lock">
          <span>Lock:</span>
          {LOCK_BUTTONS.map(({ kind, title, icon: Icon }) => (
            <button
              key={kind}
              className={`icon-btn toggle ${active?.locks[kind] ? 'active' : ''}`}
              disabled={!active}
              title={title}
              onClick={() => toggleActiveLayerLock(kind)}
            >
              <Icon size={13} />
            </button>
          ))}
        </div>
      </div>
      <div className="layers-list">
        {rows.map(({ meta: l, depth }) => {
          const dropCls =
            drop?.id === l.id && dragId !== l.id ? ` drop-${drop.pos}` : '';
          const dimmed = l.visible && !effectiveVisible(layers, l.id);
          return (
            <div
              key={l.id}
              className={`layer-row ${l.id === activeId ? 'active' : ''}${
                dragId === l.id ? ' dragging' : ''
              }${dimmed ? ' dim' : ''}${dropCls}`}
              draggable={renaming !== l.id}
              onDragStart={(e) => {
                setDragId(l.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', l.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDrop(null);
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === l.id) return;
                if (isDescendantOf(layers, l.id, dragId)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const pos = dropZoneFor(l, e);
                if (drop?.id !== l.id || drop.pos !== pos) setDrop({ id: l.id, pos });
              }}
              onDrop={(e) => {
                e.preventDefault();
                completeDrop();
              }}
              onClick={() => setActive(l.id)}
            >
              {depth > 0 && <span className="layer-indent" style={{ width: depth * 14 }} />}
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
              {l.kind === 'group' && (
                <>
                  <button
                    className={`icon-btn caret ${l.collapsed ? '' : 'open'}`}
                    title={l.collapsed ? 'Expand group' : 'Collapse group'}
                    onClick={(e) => {
                      e.stopPropagation();
                      patchLayer(l.id, { collapsed: !l.collapsed });
                    }}
                  >
                    ▸
                  </button>
                  <span className="layer-kind-icon">
                    <FolderIcon size={14} />
                  </span>
                </>
              )}
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
              {l.kind === 'layer' && l.blendMode !== 'normal' && (
                <span className="layer-mode">
                  {BLEND_MODES.find((m) => m.id === l.blendMode)?.label}
                </span>
              )}
              {hasOwnLock(l) && (
                <span
                  className={`layer-lock-badge ${l.locks.all ? 'full' : ''}`}
                  title="Layer is locked"
                >
                  <LockIcon size={12} />
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="layers-buttons">
        <button className="icon-btn" onClick={addLayer} title="New layer (Shift+Ctrl+N)">
          <PlusIcon size={15} />
        </button>
        <button className="icon-btn" onClick={addGroup} title="New group">
          <FolderPlusIcon size={15} />
        </button>
        <button
          className="icon-btn danger"
          disabled={!canDeleteActiveLayer()}
          onClick={() => active && deleteLayer(active.id)}
          title={isGroup ? 'Delete group' : 'Delete layer'}
        >
          <TrashIcon size={15} />
        </button>
      </div>
    </div>
  );
}
