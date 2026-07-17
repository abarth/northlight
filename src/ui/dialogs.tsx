import { useEffect, useMemo, useState } from 'react';
import { newDocument, resizeCanvas, resizeImage } from '../controller';
import { useStore } from '../store';
import type { HSV } from '../types';
import { ColorPickerBody } from './ColorPicker';

const MAX_DIM = 8192;

type Unit = 'px' | 'in' | 'cm' | 'mm';
type SizeUnit = Unit | 'percent';

const toPx = (v: number, unit: Unit, res: number): number => {
  switch (unit) {
    case 'px': return v;
    case 'in': return v * res;
    case 'cm': return (v * res) / 2.54;
    case 'mm': return (v * res) / 25.4;
  }
};

const fromPx = (px: number, unit: Unit, res: number): number => {
  switch (unit) {
    case 'px': return px;
    case 'in': return px / res;
    case 'cm': return (px * 2.54) / res;
    case 'mm': return (px * 25.4) / res;
  }
};

const round = (v: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const clampDim = (px: number) => Math.min(MAX_DIM, Math.max(1, Math.round(px)));

function NumField({
  label,
  value,
  onChange,
  disabled,
  after,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  after?: React.ReactNode;
}) {
  return (
    <label className="dlg-row">
      <span className="dlg-label">{label}</span>
      <input
        className="num dlg-num"
        type="number"
        value={Number.isFinite(value) ? value : ''}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {after}
    </label>
  );
}

function Dialog({
  title,
  onOk,
  onClose,
  children,
}: {
  title: string;
  onOk: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        onOk();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  return (
    <div className="dlg-overlay">
      <div className="dlg">
        <div className="dlg-title">{title}</div>
        <div className="dlg-body">{children}</div>
        <div className="dlg-actions">
          <button className="btn" onClick={onOk}>
            OK
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File > New
// ---------------------------------------------------------------------------

interface Preset {
  label: string;
  w: number;
  h: number;
  unit: Unit;
  res: number;
}

const PRESETS: Preset[] = [
  { label: 'Default Northlight Size', w: 1600, h: 1000, unit: 'px', res: 72 },
  { label: 'Letter (8.5 × 11 in)', w: 8.5, h: 11, unit: 'in', res: 300 },
  { label: 'Legal (8.5 × 14 in)', w: 8.5, h: 14, unit: 'in', res: 300 },
  { label: 'Tabloid (11 × 17 in)', w: 11, h: 17, unit: 'in', res: 300 },
  { label: 'A3 (297 × 420 mm)', w: 297, h: 420, unit: 'mm', res: 300 },
  { label: 'A4 (210 × 297 mm)', w: 210, h: 297, unit: 'mm', res: 300 },
  { label: 'A5 (148 × 210 mm)', w: 148, h: 210, unit: 'mm', res: 300 },
  { label: 'A6 (105 × 148 mm)', w: 105, h: 148, unit: 'mm', res: 300 },
  { label: 'HD 1920 × 1080', w: 1920, h: 1080, unit: 'px', res: 72 },
  { label: '4K UHD 3840 × 2160', w: 3840, h: 2160, unit: 'px', res: 72 },
];

export function NewDocDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const [preset, setPreset] = useState(-1);
  const [width, setWidth] = useState(doc.width);
  const [height, setHeight] = useState(doc.height);
  const [unit, setUnit] = useState<Unit>('px');
  const [res, setRes] = useState(doc.resolution);
  const [bg, setBg] = useState<'white' | 'background' | 'transparent'>('white');

  const applyPreset = (i: number) => {
    setPreset(i);
    if (i < 0) return;
    const p = PRESETS[i];
    setUnit(p.unit);
    setWidth(p.w);
    setHeight(p.h);
    setRes(p.res);
  };

  const changeUnit = (u: Unit) => {
    setWidth(round(fromPx(toPx(width, unit, res), u, res), 3));
    setHeight(round(fromPx(toPx(height, unit, res), u, res), 3));
    setUnit(u);
  };

  const pxW = clampDim(toPx(width, unit, res));
  const pxH = clampDim(toPx(height, unit, res));

  const ok = () => {
    newDocument(pxW, pxH, Math.max(1, res), bg);
    onClose();
  };

  const unitSelect = (
    <select value={unit} onChange={(e) => changeUnit(e.target.value as Unit)}>
      <option value="px">pixels</option>
      <option value="in">inches</option>
      <option value="cm">centimeters</option>
      <option value="mm">millimeters</option>
    </select>
  );

  return (
    <Dialog title="New Document" onOk={ok} onClose={onClose}>
      <label className="dlg-row">
        <span className="dlg-label">Preset</span>
        <select value={preset} onChange={(e) => applyPreset(Number(e.target.value))}>
          <option value={-1}>Custom</option>
          {PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <NumField
        label="Width"
        value={width}
        onChange={(v) => {
          setWidth(v);
          setPreset(-1);
        }}
        after={unitSelect}
      />
      <NumField
        label="Height"
        value={height}
        onChange={(v) => {
          setHeight(v);
          setPreset(-1);
        }}
      />
      <NumField label="Resolution" value={res} onChange={setRes} after={<span>ppi</span>} />
      <label className="dlg-row">
        <span className="dlg-label">Background</span>
        <select
          value={bg}
          onChange={(e) => setBg(e.target.value as 'white' | 'background' | 'transparent')}
        >
          <option value="white">White</option>
          <option value="background">Background Color</option>
          <option value="transparent">Transparent</option>
        </select>
      </label>
      <div className="dlg-info">
        {pxW} × {pxH} px
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Image > Image Size
// ---------------------------------------------------------------------------

export function ImageSizeDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const [pxW, setPxW] = useState(doc.width);
  const [pxH, setPxH] = useState(doc.height);
  const [res, setRes] = useState(doc.resolution);
  const [unit, setUnit] = useState<SizeUnit>('px');
  const [constrain, setConstrain] = useState(true);
  const [resample, setResample] = useState(true);

  const display = (px: number, base: number): number => {
    if (unit === 'percent') return round((px / base) * 100, 2);
    return round(fromPx(px, unit, res), unit === 'px' ? 0 : 3);
  };

  const toPixels = (v: number, base: number): number => {
    if (unit === 'percent') return (v / 100) * base;
    return toPx(v, unit, res);
  };

  const setWidthFrom = (v: number) => {
    const w = clampDim(toPixels(v, doc.width));
    setPxW(w);
    if (constrain) setPxH(clampDim((w * doc.height) / doc.width));
  };

  const setHeightFrom = (v: number) => {
    const h = clampDim(toPixels(v, doc.height));
    setPxH(h);
    if (constrain) setPxW(clampDim((h * doc.width) / doc.height));
  };

  const setResolution = (v: number) => {
    const r = Math.max(1, v);
    if (resample) {
      // keep the physical print size: pixels scale with the resolution
      setPxW(clampDim((pxW * r) / res));
      setPxH(clampDim((pxH * r) / res));
    }
    setRes(r);
  };

  const ok = () => {
    resizeImage(pxW, pxH, res);
    onClose();
  };

  return (
    <Dialog title="Image Size" onOk={ok} onClose={onClose}>
      <div className="dlg-info">
        Current: {doc.width} × {doc.height} px @ {doc.resolution} ppi
      </div>
      <NumField
        label="Width"
        value={display(pxW, doc.width)}
        disabled={!resample && (unit === 'px' || unit === 'percent')}
        onChange={setWidthFrom}
        after={
          <select value={unit} onChange={(e) => setUnit(e.target.value as SizeUnit)}>
            <option value="px">pixels</option>
            <option value="percent">percent</option>
            <option value="in">inches</option>
            <option value="cm">centimeters</option>
            <option value="mm">millimeters</option>
          </select>
        }
      />
      <NumField
        label="Height"
        value={display(pxH, doc.height)}
        disabled={!resample && (unit === 'px' || unit === 'percent')}
        onChange={setHeightFrom}
      />
      <NumField
        label="Resolution"
        value={round(res, 2)}
        onChange={setResolution}
        after={<span>ppi</span>}
      />
      <label className="dlg-check">
        <input
          type="checkbox"
          checked={constrain}
          onChange={(e) => setConstrain(e.target.checked)}
        />
        Constrain Proportions
      </label>
      <label className="dlg-check">
        <input
          type="checkbox"
          checked={resample}
          onChange={(e) => {
            setResample(e.target.checked);
            if (!e.target.checked) {
              // resolution-only edits from here on; restore the pixel dims
              setPxW(doc.width);
              setPxH(doc.height);
              if (unit === 'px' || unit === 'percent') setUnit('in');
            }
          }}
        />
        Resample Image
      </label>
      <div className="dlg-info">
        New: {pxW} × {pxH} px ({round(fromPx(pxW, 'in', res), 2)} ×{' '}
        {round(fromPx(pxH, 'in', res), 2)} in)
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Image > Canvas Size
// ---------------------------------------------------------------------------

export function CanvasSizeDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const [unit, setUnit] = useState<Unit>('px');
  const [relative, setRelative] = useState(false);
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [anchor, setAnchor] = useState<[number, number]>([0.5, 0.5]);

  const changeUnit = (u: Unit) => {
    setW(round(fromPx(toPx(w, unit, doc.resolution), u, doc.resolution), 3));
    setH(round(fromPx(toPx(h, unit, doc.resolution), u, doc.resolution), 3));
    setUnit(u);
  };

  const toggleRelative = (rel: boolean) => {
    setRelative(rel);
    if (rel) {
      setW(0);
      setH(0);
    } else {
      setW(round(fromPx(doc.width, unit, doc.resolution), 3));
      setH(round(fromPx(doc.height, unit, doc.resolution), 3));
    }
  };

  const pxW = clampDim(toPx(w, unit, doc.resolution) + (relative ? doc.width : 0));
  const pxH = clampDim(toPx(h, unit, doc.resolution) + (relative ? doc.height : 0));

  const ok = () => {
    resizeCanvas(pxW, pxH, anchor[0], anchor[1]);
    onClose();
  };

  return (
    <Dialog title="Canvas Size" onOk={ok} onClose={onClose}>
      <div className="dlg-info">
        Current: {doc.width} × {doc.height} px
      </div>
      <NumField
        label={relative ? 'Width Δ' : 'Width'}
        value={w}
        onChange={setW}
        after={
          <select value={unit} onChange={(e) => changeUnit(e.target.value as Unit)}>
            <option value="px">pixels</option>
            <option value="in">inches</option>
            <option value="cm">centimeters</option>
            <option value="mm">millimeters</option>
          </select>
        }
      />
      <NumField label={relative ? 'Height Δ' : 'Height'} value={h} onChange={setH} />
      <label className="dlg-check">
        <input
          type="checkbox"
          checked={relative}
          onChange={(e) => toggleRelative(e.target.checked)}
        />
        Relative
      </label>
      <div className="dlg-row">
        <span className="dlg-label">Anchor</span>
        <div className="anchor-grid">
          {[0, 0.5, 1].map((ay) =>
            [0, 0.5, 1].map((ax) => (
              <button
                key={`${ax}-${ay}`}
                className={`anchor-cell ${
                  anchor[0] === ax && anchor[1] === ay ? 'active' : ''
                }`}
                onClick={() => setAnchor([ax, ay])}
              />
            )),
          )}
        </div>
      </div>
      <div className="dlg-info">
        New: {pxW} × {pxH} px
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Color Picker (clicking the foreground / background swatch)
// ---------------------------------------------------------------------------

export function ColorPickerDialog({
  target,
  onClose,
}: {
  target: 'fg' | 'bg';
  onClose: () => void;
}) {
  // edits stay local until OK, like Photoshop's picker
  const [draft, setDraft] = useState<HSV>(() => useStore.getState()[target]);

  const ok = () => {
    const s = useStore.getState();
    if (target === 'fg') s.setFg(draft);
    else s.setBg(draft);
    onClose();
  };

  return (
    <Dialog
      title={`Color Picker (${target === 'fg' ? 'Foreground' : 'Background'} Color)`}
      onOk={ok}
      onClose={onClose}
    >
      <ColorPickerBody color={draft} onChange={setDraft} />
    </Dialog>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  const setDialog = useStore((s) => s.setDialog);
  const close = useMemo(() => () => setDialog(null), [setDialog]);
  if (dialog === 'new') return <NewDocDialog onClose={close} />;
  if (dialog === 'imageSize') return <ImageSizeDialog onClose={close} />;
  if (dialog === 'canvasSize') return <CanvasSizeDialog onClose={close} />;
  if (dialog === 'fgColor') return <ColorPickerDialog target="fg" onClose={close} />;
  if (dialog === 'bgColor') return <ColorPickerDialog target="bg" onClose={close} />;
  return null;
}
