import * as color from '../color/convert';
import {
  childrenOf,
  descendantIds,
  displayRows,
  effectiveLocks,
  effectiveVisible,
  layerById,
  moveSubtree,
  nextName,
  pixelLayers,
  resolveRenderLayers,
  subtreeRange,
} from '../layers';
import { DOC_SIZE, nextLayerId, useStore } from '../store';
import type { LayerLocks, LayerMeta } from '../types';
import { makeLayerMeta } from '../types';
import { MAX_LAYERS, getEngine } from './engineHost';
import { getSelectionMask, maskedPixels, setSelection } from './selection';
import { cancelTransform, commitTransform } from './transform';

/**
 * Layer and group operations: the Layer menu, the layers panel's buttons,
 * and the pixel edits (fill/clear) that respect the active layer's locks.
 */

function activeLayer(): LayerMeta | undefined {
  const s = useStore.getState();
  return layerById(s.layers, s.activeLayerId);
}

/** Locks on the active layer, including locks inherited from its groups. */
export function activeLocks(): LayerLocks {
  const s = useStore.getState();
  return effectiveLocks(s.layers, s.activeLayerId);
}

/** Whether painting / erasing / filling may touch the active layer. */
export function canEditActivePixels(): boolean {
  const s = useStore.getState();
  const a = activeLayer();
  if (!a || a.kind !== 'layer' || !effectiveVisible(s.layers, a.id)) return false;
  const locks = activeLocks();
  return !locks.pixels && !locks.all;
}

/** Whether the active layer may be moved or transformed. */
export function canMoveActiveLayer(): boolean {
  const s = useStore.getState();
  const a = activeLayer();
  if (!a || a.kind !== 'layer' || !effectiveVisible(s.layers, a.id)) return false;
  const locks = activeLocks();
  return !locks.position && !locks.all;
}

export function addLayer(): void {
  const engine = getEngine();
  if (!engine) return;
  const s = useStore.getState();
  if (pixelLayers(s.layers).length >= MAX_LAYERS) return;
  const id = nextLayerId();
  engine.ensureLayer(id);
  s.addLayerMeta(
    makeLayerMeta({ id, name: nextName(s.layers, 'Layer') }),
    s.activeLayerId,
  );
}

/** Layer > New > Group: an empty group above (or inside) the active layer. */
export function addGroup(): void {
  const s = useStore.getState();
  s.addLayerMeta(
    makeLayerMeta({ id: nextLayerId(), name: nextName(s.layers, 'Group'), kind: 'group' }),
    s.activeLayerId,
  );
}

/** Layer > Group Layers (Ctrl+G): wraps the active layer/group in a group. */
export function groupActiveLayer(): void {
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  const range = subtreeRange(s.layers, active.id)!;
  const id = nextLayerId();
  const group = makeLayerMeta({
    id,
    name: nextName(s.layers, 'Group'),
    kind: 'group',
    parentId: active.parentId,
  });
  const layers = s.layers.map((l, i) =>
    i === range[1] ? { ...l, parentId: id } : l,
  );
  layers.splice(range[1] + 1, 0, group);
  s.setLayers(layers, id);
}

/** Layer > Ungroup Layers (Shift+Ctrl+G): dissolves the active group. */
export function ungroupActiveLayer(): void {
  const s = useStore.getState();
  const g = layerById(s.layers, s.activeLayerId);
  if (!g || g.kind !== 'group') return;
  const kids = childrenOf(s.layers, g.id);
  const layers = s.layers
    .filter((l) => l.id !== g.id)
    .map((l) => (l.parentId === g.id ? { ...l, parentId: g.parentId } : l));
  const active = kids.length > 0 ? kids[kids.length - 1].id : layers[0]?.id;
  if (!active) return;
  s.setLayers(layers, active);
}

/** Deleting must always leave at least one pixel layer behind. */
export function canDeleteActiveLayer(): boolean {
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a) return false;
  const inTree = a.kind === 'group' ? descendantIds(s.layers, a.id) : new Set<string>();
  return s.layers.some(
    (l) => l.kind === 'layer' && l.id !== a.id && !inTree.has(l.id),
  );
}

/** Deletes a layer, or a group with everything in it. */
export function deleteLayer(id: string): void {
  const engine = getEngine();
  const s = useStore.getState();
  const range = subtreeRange(s.layers, id);
  if (!range) return;
  const block = s.layers.slice(range[0], range[1] + 1);
  const blockIds = new Set(block.map((l) => l.id));
  if (s.transform && blockIds.has(s.transform.layerId)) cancelTransform();
  else commitTransform();
  const remaining = s.layers.filter((l) => !blockIds.has(l.id));
  if (!remaining.some((l) => l.kind === 'layer')) return; // keep >= 1 layer
  for (const l of block) {
    if (l.kind === 'layer') engine?.deleteLayer(l.id);
  }
  const active = blockIds.has(s.activeLayerId)
    ? remaining[Math.min(Math.max(range[0] - 1, 0), remaining.length - 1)].id
    : s.activeLayerId;
  useStore.getState().setLayers(remaining, active);
}

/** Layer > Delete > Hidden Layers. */
export function deleteHiddenLayers(): void {
  const engine = getEngine();
  commitTransform();
  const s = useStore.getState();
  const doomed = s.layers.filter((l) => !effectiveVisible(s.layers, l.id));
  if (doomed.length === 0) return;
  const doomedIds = new Set(doomed.map((l) => l.id));
  const remaining = s.layers.filter((l) => !doomedIds.has(l.id));
  if (!remaining.some((l) => l.kind === 'layer')) return;
  for (const l of doomed) {
    if (l.kind === 'layer') engine?.deleteLayer(l.id);
  }
  const active = doomedIds.has(s.activeLayerId)
    ? remaining[remaining.length - 1].id
    : s.activeLayerId;
  s.setLayers(remaining, active);
}

/** Layer > Duplicate Layer: copies the active layer or whole group. */
export function duplicateActiveLayer(): void {
  const engine = getEngine();
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  const range = subtreeRange(s.layers, active.id)!;
  const block = s.layers.slice(range[0], range[1] + 1);
  const copiesNeeded = block.filter((l) => l.kind === 'layer').length;
  if (pixelLayers(s.layers).length + copiesNeeded > MAX_LAYERS) return;
  const idMap = new Map(block.map((l) => [l.id, nextLayerId()]));
  const copies = block.map((l) =>
    makeLayerMeta({
      ...l,
      id: idMap.get(l.id)!,
      parentId:
        l.parentId !== null && idMap.has(l.parentId)
          ? idMap.get(l.parentId)!
          : l.parentId,
      name: l.id === active.id ? `${l.name} copy` : l.name,
    }),
  );
  for (const l of block) {
    if (l.kind === 'layer') engine.copyLayer(l.id, idMap.get(l.id)!);
  }
  const layers = [...s.layers];
  layers.splice(range[1] + 1, 0, ...copies);
  s.setLayers(layers, idMap.get(active.id)!);
}

/**
 * Layer > New > Layer Via Copy / Via Cut (Ctrl+J / Shift+Ctrl+J): lifts the
 * selected pixels of the active layer onto a new layer above it. Without a
 * selection, Via Copy duplicates the layer.
 */
export async function layerViaCopy(cut: boolean): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active || active.kind !== 'layer') return;
  if (cut && !canEditActivePixels()) return;
  commitTransform();
  const mask = getSelectionMask();
  if (!mask) {
    if (!cut) duplicateActiveLayer();
    return;
  }
  if (pixelLayers(s.layers).length >= MAX_LAYERS) return;
  const { width: dw, height: dh } = DOC_SIZE;
  const src = await engine.readLayerPixels(active.id);
  if (src.length < dw * dh * 4) return;
  const out = maskedPixels(src, mask, dw, { x: 0, y: 0, w: dw, h: dh });
  const id = nextLayerId();
  engine.putLayerImage(id, out, dw, dh);
  const st = useStore.getState();
  st.addLayerMeta(
    makeLayerMeta({ id, name: nextName(st.layers, 'Layer') }),
    active.id,
  );
  if (cut) {
    // clear the selected pixels out of the source, like Edit > Clear
    if (active.id === 'background') {
      const rgb = color.hsvToRgb(st.bg);
      engine.fillRegion(active.id, [rgb.r, rgb.g, rgb.b]);
    } else {
      engine.fillRegion(active.id, null);
    }
  }
  setSelection(null);
}

export type ArrangeOp = 'front' | 'forward' | 'backward' | 'back';

/** Layer > Arrange: moves the active layer/group among its siblings. */
export function arrangeActiveLayer(op: ArrangeOp): void {
  commitTransform();
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  const siblings = childrenOf(s.layers, active.parentId); // bottom -> top
  const pos = siblings.findIndex((l) => l.id === active.id);
  const target =
    op === 'forward'
      ? Math.min(pos + 1, siblings.length - 1)
      : op === 'backward'
        ? Math.max(pos - 1, 0)
        : op === 'front'
          ? siblings.length - 1
          : 0;
  if (target === pos) return;
  const layers = moveSubtree(
    s.layers,
    active.id,
    siblings[target].id,
    target > pos ? 'above' : 'below',
  );
  if (layers) s.setLayers(layers, active.id);
}

/** Layer > Hide Layers (Ctrl+,): toggles the active layer's visibility. */
export function toggleActiveLayerVisibility(): void {
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (active) s.patchLayer(active.id, { visible: !active.visible });
}

/** Toggles one of the active layer's own locks. */
export function toggleActiveLayerLock(kind: keyof LayerLocks): void {
  const s = useStore.getState();
  const active = layerById(s.layers, s.activeLayerId);
  if (!active) return;
  s.patchLayer(active.id, {
    locks: { ...active.locks, [kind]: !active.locks[kind] },
  });
}

/** Layer > Rename Layer: opens the panel's inline rename on the active row. */
export function renameActiveLayer(): void {
  useStore.getState().requestRename();
}

/** Alt+[ / Alt+]: steps the active layer down/up through the panel rows. */
export function selectNeighborLayer(dir: 'up' | 'down'): void {
  const s = useStore.getState();
  const rows = displayRows(s.layers);
  const i = rows.findIndex((r) => r.meta.id === s.activeLayerId);
  if (i < 0) return;
  const j = dir === 'up' ? i - 1 : i + 1; // rows are top-first
  if (j < 0 || j >= rows.length) return;
  s.setActiveLayer(rows[j].meta.id);
}

// ---------------------------------------------------------------------------
// Pixel edits on the active layer (Edit > Fill / Clear)
// ---------------------------------------------------------------------------

/**
 * Fills the active layer with the foreground or background color, clipped to
 * the current selection when one exists (Alt+Backspace / Ctrl+Backspace).
 */
export function fillActiveLayer(which: 'fg' | 'bg'): void {
  commitTransform();
  if (!canEditActivePixels()) return;
  const s = useStore.getState();
  const rgb = color.hsvToRgb(which === 'fg' ? s.fg : s.bg);
  getEngine()?.fillRegion(
    s.activeLayerId,
    [rgb.r, rgb.g, rgb.b],
    activeLocks().transparency,
  );
}

/**
 * Deletes the selected pixels: clears them to transparency, except on the
 * Background layer where they fill with the background color instead.
 */
export function deleteSelectionContents(): void {
  commitTransform();
  const s = useStore.getState();
  if (!s.selectionPaths || !canEditActivePixels()) return;
  if (s.activeLayerId === 'background') {
    const rgb = color.hsvToRgb(s.bg);
    getEngine()?.fillRegion(s.activeLayerId, [rgb.r, rgb.g, rgb.b]);
  } else if (!activeLocks().transparency) {
    // clearing changes alpha, which Lock Transparent Pixels forbids
    getEngine()?.fillRegion(s.activeLayerId, null);
  }
}

// ---------------------------------------------------------------------------
// Merges (Layer > Merge Down / Merge Group / Merge Visible / Flatten Image)
// ---------------------------------------------------------------------------

/** The sibling directly below the active layer, when both are mergeable. */
function mergeDownTarget(): LayerMeta | null {
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a || a.kind !== 'layer' || !a.visible) return null;
  const siblings = childrenOf(s.layers, a.parentId);
  const pos = siblings.findIndex((l) => l.id === a.id);
  const below = pos > 0 ? siblings[pos - 1] : null;
  if (!below || below.kind !== 'layer' || !below.visible) return null;
  for (const id of [a.id, below.id]) {
    const locks = effectiveLocks(s.layers, id);
    if (locks.pixels || locks.position || locks.all) return null;
  }
  return below;
}

/** Whether Ctrl+E can do anything (merge down, or merge the active group). */
export function canMergeDown(): boolean {
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a) return false;
  if (a.kind === 'group') {
    return [...descendantIds(s.layers, a.id)].some(
      (id) => layerById(s.layers, id)?.kind === 'layer',
    );
  }
  return mergeDownTarget() !== null;
}

/** Ctrl+E: merges the active layer into the one below, or bakes a group. */
export function mergeDown(): void {
  const engine = getEngine();
  commitTransform();
  const s = useStore.getState();
  const a = layerById(s.layers, s.activeLayerId);
  if (!a || !engine) return;
  if (a.kind === 'group') {
    void mergeGroup();
    return;
  }
  const below = mergeDownTarget();
  if (!below) return;
  engine.mergeDown(a.id, below.id, a.opacity, a.blendMode);
  s.removeLayerMeta(a.id);
  engine.deleteLayer(a.id);
}

/** Layer > Merge Group: bakes the active group into a single layer. */
export async function mergeGroup(): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  const g = layerById(s.layers, s.activeLayerId);
  if (!g || g.kind !== 'group') return;
  const range = subtreeRange(s.layers, g.id)!;
  const block = s.layers.slice(range[0], range[1] + 1);
  const members = block.filter((l) => l.id !== g.id);
  // resolve visibility/opacity relative to the group: the group's own
  // opacity and visibility stay on the merged layer's meta
  const resolved = resolveRenderLayers(members);
  if (!resolved.some((l) => l.visible)) return;
  const data = await engine.readComposite({
    layers: resolved,
    activeLayerId: s.activeLayerId,
    view: s.view,
  });
  if (data.length === 0) return;
  const id = nextLayerId();
  engine.putLayerImage(id, data, DOC_SIZE.width, DOC_SIZE.height);
  const merged = makeLayerMeta({
    id,
    name: g.name,
    visible: g.visible,
    opacity: g.opacity,
    parentId: g.parentId,
    locks: g.locks,
  });
  for (const l of members) {
    if (l.kind === 'layer') engine.deleteLayer(l.id);
  }
  const st = useStore.getState();
  const blockIds = new Set(block.map((l) => l.id));
  const layers = st.layers.filter((l) => !blockIds.has(l.id));
  const at = st.layers.slice(0, range[0]).filter((l) => !blockIds.has(l.id)).length;
  layers.splice(at, 0, merged);
  st.setLayers(layers, id);
}

/**
 * Layer > Merge Visible (Shift+Ctrl+E): bakes every visible layer into the
 * bottom-most visible one; hidden layers survive untouched.
 */
export async function mergeVisible(): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  const resolved = resolveRenderLayers(s.layers);
  const visible = resolved.filter((l) => l.visible);
  if (visible.length <= 1) return;
  // a locked visible layer blocks the merge, like Photoshop
  for (const l of visible) {
    const locks = effectiveLocks(s.layers, l.id);
    if (locks.pixels || locks.position || locks.all) return;
  }
  const data = await engine.readComposite({
    layers: resolved,
    activeLayerId: s.activeLayerId,
    view: s.view,
  });
  if (data.length === 0) return;

  const st = useStore.getState();
  const target = layerById(st.layers, visible[0].id)!;
  const visibleIds = new Set(visible.map((l) => l.id));
  // keep hidden pixel layers, and groups that still contain one
  const keptPixels = new Set(
    resolved.filter((l) => !visibleIds.has(l.id)).map((l) => l.id),
  );
  const keep = (l: LayerMeta) =>
    l.kind === 'layer'
      ? keptPixels.has(l.id)
      : [...descendantIds(st.layers, l.id)].some((id) => keptPixels.has(id));
  // the merged result lands at the root, where the target's top-level
  // ancestor sat in the stack
  let root = target;
  while (root.parentId !== null) root = layerById(st.layers, root.parentId)!;
  const rootStart = subtreeRange(st.layers, root.id)![0];
  const merged = makeLayerMeta({
    ...target,
    parentId: null,
    visible: true,
    opacity: 1,
    blendMode: 'normal',
  });
  const remaining = st.layers.filter(keep);
  const at = st.layers.slice(0, rootStart).filter(keep).length;
  remaining.splice(at, 0, merged);
  engine.putLayerImage(target.id, data, DOC_SIZE.width, DOC_SIZE.height);
  for (const l of visible) {
    if (l.id !== target.id) engine.deleteLayer(l.id);
  }
  st.setLayers(remaining, target.id);
}

/** Layer > Flatten Image: everything visible onto one opaque Background. */
export async function flattenImage(): Promise<void> {
  const engine = getEngine();
  if (!engine) return;
  commitTransform();
  const s = useStore.getState();
  if (s.layers.length === 1 && s.layers[0].opacity === 1 && s.layers[0].kind === 'layer') {
    return;
  }
  const data = await engine.readComposite({
    layers: resolveRenderLayers(s.layers),
    activeLayerId: s.activeLayerId,
    view: s.view,
  });
  if (data.length === 0) return;
  // flatten composites onto opaque white, like Photoshop
  for (let i = 0; i < data.length; i += 4) {
    const inv = 255 - data[i + 3];
    data[i] = Math.min(255, data[i] + inv);
    data[i + 1] = Math.min(255, data[i + 1] + inv);
    data[i + 2] = Math.min(255, data[i + 2] + inv);
    data[i + 3] = 255;
  }
  const keepId = s.layers.some((l) => l.id === 'background')
    ? 'background'
    : pixelLayers(s.layers)[0].id;
  engine.putLayerImage(keepId, data, DOC_SIZE.width, DOC_SIZE.height);
  for (const l of s.layers) {
    if (l.id !== keepId && l.kind === 'layer') engine.deleteLayer(l.id);
  }
  s.setLayers([makeLayerMeta({ id: keepId, name: 'Background' })], keepId);
}
