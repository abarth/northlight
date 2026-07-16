import { useEffect, useRef, useState } from 'react';
import {
  addLayer,
  cropToSelection,
  deleteLayer,
  deleteSelectionContents,
  exportPng,
  fillActiveLayer,
  flattenImage,
  invertSelection,
  mergeDown,
  openImageFile,
  placeImageFile,
  redo,
  reselect,
  rotateCanvas,
  selectAll,
  setSelection,
  startTransform,
  transformImmediate,
  undo,
} from '../controller';
import { useStore } from '../store';

interface Item {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  children?: Entry[];
}
type Entry = Item | 'sep';

/** Photoshop-style application menu bar. */
export function MenuBar() {
  const [open, setOpen] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const openInputRef = useRef<HTMLInputElement>(null);
  const placeInputRef = useRef<HTMLInputElement>(null);

  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const hasSelection = useStore((s) => s.selectionPaths !== null);
  const layers = useStore((s) => s.layers);
  const activeLayerId = useStore((s) => s.activeLayerId);
  const setDialog = useStore((s) => s.setDialog);

  useEffect(() => {
    if (open === null) return;
    const close = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);

  const activeIdx = layers.findIndex((l) => l.id === activeLayerId);

  const transformItems: Entry[] = [
    { label: 'Scale', action: () => void startTransform('layer', 'scale') },
    { label: 'Rotate', action: () => void startTransform('layer', 'rotate') },
    { label: 'Skew', action: () => void startTransform('layer', 'skew') },
    { label: 'Distort', action: () => void startTransform('layer', 'distort') },
    { label: 'Perspective', action: () => void startTransform('layer', 'perspective') },
    'sep',
    { label: 'Rotate 180°', action: () => void transformImmediate('rotate180') },
    { label: 'Rotate 90° Clockwise', action: () => void transformImmediate('rotate90cw') },
    {
      label: 'Rotate 90° Counter Clockwise',
      action: () => void transformImmediate('rotate90ccw'),
    },
    'sep',
    { label: 'Flip Horizontal', action: () => void transformImmediate('flipH') },
    { label: 'Flip Vertical', action: () => void transformImmediate('flipV') },
  ];

  const menus: { label: string; items: Entry[] }[] = [
    {
      label: 'File',
      items: [
        { label: 'New…', shortcut: 'Ctrl+N', action: () => setDialog('new') },
        { label: 'Open…', action: () => openInputRef.current?.click() },
        { label: 'Place…', action: () => placeInputRef.current?.click() },
        'sep',
        { label: 'Export PNG', action: () => void exportPng() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', disabled: !canUndo, action: undo },
        { label: 'Redo', shortcut: 'Shift+Ctrl+Z', disabled: !canRedo, action: redo },
        'sep',
        {
          label: 'Fill Foreground',
          shortcut: 'Alt+Backspace',
          action: () => fillActiveLayer('fg'),
        },
        {
          label: 'Fill Background',
          shortcut: 'Ctrl+Backspace',
          action: () => fillActiveLayer('bg'),
        },
        {
          label: 'Clear',
          shortcut: 'Delete',
          disabled: !hasSelection,
          action: deleteSelectionContents,
        },
        'sep',
        {
          label: 'Free Transform',
          shortcut: 'Ctrl+T',
          action: () => void startTransform('layer', 'free'),
        },
        { label: 'Transform', children: transformItems },
      ],
    },
    {
      label: 'Image',
      items: [
        {
          label: 'Image Size…',
          shortcut: 'Alt+Ctrl+I',
          action: () => setDialog('imageSize'),
        },
        {
          label: 'Canvas Size…',
          shortcut: 'Alt+Ctrl+C',
          action: () => setDialog('canvasSize'),
        },
        'sep',
        {
          label: 'Image Rotation',
          children: [
            { label: '180°', action: () => rotateCanvas('rotate180') },
            { label: '90° Clockwise', action: () => rotateCanvas('rotate90cw') },
            { label: '90° Counter Clockwise', action: () => rotateCanvas('rotate90ccw') },
            'sep',
            { label: 'Flip Canvas Horizontal', action: () => rotateCanvas('flipH') },
            { label: 'Flip Canvas Vertical', action: () => rotateCanvas('flipV') },
          ],
        },
        'sep',
        { label: 'Crop', disabled: !hasSelection, action: cropToSelection },
      ],
    },
    {
      label: 'Layer',
      items: [
        { label: 'New Layer', shortcut: 'Shift+Ctrl+N', action: addLayer },
        {
          label: 'Delete Layer',
          disabled: layers.length <= 1,
          action: () => deleteLayer(activeLayerId),
        },
        'sep',
        {
          label: 'Merge Down',
          shortcut: 'Ctrl+E',
          disabled: activeIdx <= 0,
          action: mergeDown,
        },
        {
          label: 'Flatten Image',
          disabled: layers.length <= 1,
          action: () => void flattenImage(),
        },
      ],
    },
    {
      label: 'Select',
      items: [
        { label: 'All', shortcut: 'Ctrl+A', action: selectAll },
        {
          label: 'Deselect',
          shortcut: 'Ctrl+D',
          disabled: !hasSelection,
          action: () => setSelection(null),
        },
        { label: 'Reselect', shortcut: 'Shift+Ctrl+D', action: reselect },
        {
          label: 'Inverse',
          shortcut: 'Shift+Ctrl+I',
          disabled: !hasSelection,
          action: invertSelection,
        },
        'sep',
        {
          label: 'Transform Selection',
          disabled: !hasSelection,
          action: () => void startTransform('selection', 'free'),
        },
      ],
    },
  ];

  const renderItems = (items: Entry[]) => (
    <div className="menu-list">
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={it.label}
            className={`menu-item ${it.disabled ? 'disabled' : ''} ${
              it.children ? 'has-sub' : ''
            }`}
            onClick={(e) => {
              e.stopPropagation();
              if (it.disabled || it.children) return;
              setOpen(null);
              it.action?.();
            }}
          >
            <span className="menu-label">{it.label}</span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
            {it.children && <span className="menu-arrow">▸</span>}
            {it.children && !it.disabled && (
              <div className="menu-sub">{renderItems(it.children)}</div>
            )}
          </div>
        ),
      )}
    </div>
  );

  const onPick =
    (fn: (f: File) => Promise<void>) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) void fn(file);
    };

  return (
    <div className="menubar" ref={barRef}>
      <div className="brand">Northlight</div>
      {menus.map((m, i) => (
        <div key={m.label} className="menubar-entry">
          <button
            className={`menubar-btn ${open === i ? 'open' : ''}`}
            onClick={() => setOpen(open === i ? null : i)}
            onMouseEnter={() => open !== null && setOpen(i)}
          >
            {m.label}
          </button>
          {open === i && <div className="menu-dropdown">{renderItems(m.items)}</div>}
        </div>
      ))}
      <input
        ref={openInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={onPick(openImageFile)}
      />
      <input
        ref={placeInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={onPick(placeImageFile)}
      />
    </div>
  );
}
