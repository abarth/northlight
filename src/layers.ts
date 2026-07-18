import type { LayerLocks, LayerMeta } from './types';
import { NO_LOCKS } from './types';

/**
 * Layer-tree helpers. The store keeps a single flat array, bottom -> top in
 * compositing order, with `parentId` links. Invariant: a group's descendants
 * form a contiguous block immediately BELOW the group entry (lower indices),
 * so the reversed array reads exactly like the Layers panel — group header
 * first, then its children indented beneath it.
 */

export function layerIndex(layers: LayerMeta[], id: string): number {
  return layers.findIndex((l) => l.id === id);
}

export function layerById(layers: LayerMeta[], id: string): LayerMeta | undefined {
  return layers.find((l) => l.id === id);
}

/** Direct children of a group (or of the root when `id` is null), bottom -> top. */
export function childrenOf(layers: LayerMeta[], id: string | null): LayerMeta[] {
  return layers.filter((l) => l.parentId === id);
}

/** Every transitive descendant id of a group. */
export function descendantIds(layers: LayerMeta[], id: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of layers) {
      if (out.has(l.id)) continue;
      if (l.parentId === id || (l.parentId !== null && out.has(l.parentId))) {
        out.add(l.id);
        grew = true;
      }
    }
  }
  return out;
}

export function isDescendantOf(
  layers: LayerMeta[],
  id: string,
  ancestorId: string,
): boolean {
  let cur = layerById(layers, id);
  while (cur && cur.parentId !== null) {
    if (cur.parentId === ancestorId) return true;
    cur = layerById(layers, cur.parentId);
  }
  return false;
}

/** Enclosing groups of a layer, innermost first. */
export function ancestorsOf(layers: LayerMeta[], id: string): LayerMeta[] {
  const out: LayerMeta[] = [];
  let cur = layerById(layers, id);
  while (cur && cur.parentId !== null) {
    const parent = layerById(layers, cur.parentId);
    if (!parent) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/**
 * The contiguous [start, end] index range of an entry's subtree — just the
 * entry itself for layers; descendants plus the header for groups.
 */
export function subtreeRange(layers: LayerMeta[], id: string): [number, number] | null {
  const end = layerIndex(layers, id);
  if (end < 0) return null;
  const inTree = descendantIds(layers, id);
  let start = end;
  while (start > 0 && inTree.has(layers[start - 1].id)) start--;
  return [start, end];
}

export function effectiveVisible(layers: LayerMeta[], id: string): boolean {
  const meta = layerById(layers, id);
  if (!meta || !meta.visible) return false;
  return ancestorsOf(layers, id).every((a) => a.visible);
}

export function effectiveOpacity(layers: LayerMeta[], id: string): number {
  const meta = layerById(layers, id);
  if (!meta) return 0;
  return ancestorsOf(layers, id).reduce((o, a) => o * a.opacity, meta.opacity);
}

/** Locks that apply to a layer, including locks inherited from its groups. */
export function effectiveLocks(layers: LayerMeta[], id: string): LayerLocks {
  const meta = layerById(layers, id);
  if (!meta) return { ...NO_LOCKS };
  const chain = [meta, ...ancestorsOf(layers, id)];
  const all = chain.some((l) => l.locks.all);
  return {
    all,
    transparency: all || chain.some((l) => l.locks.transparency),
    pixels: all || chain.some((l) => l.locks.pixels),
    position: all || chain.some((l) => l.locks.position),
  };
}

/** Any lock set directly on the layer itself (for the panel's lock badge). */
export function hasOwnLock(meta: LayerMeta): boolean {
  const k = meta.locks;
  return k.all || k.transparency || k.pixels || k.position;
}

/**
 * Flattens the tree into the pixel-layer list the GPU compositor consumes:
 * groups disappear, their visibility and opacity folded into each child.
 * Group blending is pass-through (Photoshop's group default), so plain
 * bottom -> top sequential compositing stays correct.
 */
export function resolveRenderLayers(layers: LayerMeta[]): LayerMeta[] {
  return layers
    .filter((l) => l.kind === 'layer')
    .map((l) => ({
      ...l,
      visible: effectiveVisible(layers, l.id),
      opacity: effectiveOpacity(layers, l.id),
    }));
}

/** Pixel layers only (groups have no content). */
export function pixelLayers(layers: LayerMeta[]): LayerMeta[] {
  return layers.filter((l) => l.kind === 'layer');
}

export interface LayerRow {
  meta: LayerMeta;
  depth: number;
}

/** Panel rows, top of the stack first, honoring collapsed groups. */
export function displayRows(layers: LayerMeta[]): LayerRow[] {
  const rows: LayerRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const kids = childrenOf(layers, parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const meta = kids[i];
      rows.push({ meta, depth });
      if (meta.kind === 'group' && !meta.collapsed) walk(meta.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/**
 * Where a newly created layer goes, like Photoshop: inside the active group
 * (as its top child) when a group is active, else directly above the active
 * layer at the same level. Returns the array insertion index and parent.
 */
export function insertionPoint(
  layers: LayerMeta[],
  activeId: string,
): { index: number; parentId: string | null } {
  const active = layerById(layers, activeId);
  if (!active) return { index: layers.length, parentId: null };
  if (active.kind === 'group') {
    // inserting at the header index puts the entry directly below the
    // header, i.e. as the group's topmost child
    return { index: layerIndex(layers, activeId), parentId: active.id };
  }
  const range = subtreeRange(layers, activeId)!;
  return { index: range[1] + 1, parentId: active.parentId };
}

export type DropPosition = 'above' | 'below' | 'into';

/**
 * Drag-and-drop restructuring: moves `dragId`'s whole subtree relative to
 * `targetId` — 'above'/'below' its subtree as a sibling, or 'into' a group
 * as its topmost child. Returns the new array, or null for illegal moves
 * (dropping a group into itself or a descendant).
 */
export function moveSubtree(
  layers: LayerMeta[],
  dragId: string,
  targetId: string,
  pos: DropPosition,
): LayerMeta[] | null {
  if (dragId === targetId) return null;
  if (isDescendantOf(layers, targetId, dragId)) return null;
  const target = layerById(layers, targetId);
  if (!target) return null;
  if (pos === 'into' && target.kind !== 'group') return null;

  const dragRange = subtreeRange(layers, dragId);
  if (!dragRange) return null;
  const block = layers.slice(dragRange[0], dragRange[1] + 1);
  const rest = [...layers.slice(0, dragRange[0]), ...layers.slice(dragRange[1] + 1)];

  const targetRange = subtreeRange(rest, targetId)!;
  let index: number;
  let parentId: string | null;
  if (pos === 'into') {
    index = targetRange[1];
    parentId = target.id;
  } else if (pos === 'above') {
    index = targetRange[1] + 1;
    parentId = target.parentId;
  } else {
    index = targetRange[0];
    parentId = target.parentId;
  }

  const root = block[block.length - 1];
  const moved = block.map((l) => (l === root ? { ...l, parentId } : l));
  return [...rest.slice(0, index), ...moved, ...rest.slice(index)];
}

/** "Layer 4" / "Group 2": one past the highest existing number for `base`. */
export function nextName(layers: LayerMeta[], base: 'Layer' | 'Group'): string {
  const re = new RegExp(`^${base} (\\d+)$`);
  let max = 0;
  for (const l of layers) {
    const m = re.exec(l.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${base} ${max + 1}`;
}
