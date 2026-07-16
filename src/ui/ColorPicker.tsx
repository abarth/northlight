import { useEffect, useRef, useState } from 'react';
import {
  clamp,
  hexToRgb,
  hsvToRgb,
  labToRgb,
  oklchInGamut,
  oklchToRgb,
  rgbToHex,
  rgbToHsv,
  rgbToLab,
  rgbToOklch,
  type Lab,
  type OKLCH,
  type RGB,
} from '../color/convert';
import { useStore } from '../store';
import type { HSV } from '../types';

type Mode = 'hsb' | 'rgb' | 'lab' | 'oklch';

function fromRgb(rgb: RGB, hueHint: number): HSV {
  return rgbToHsv(rgb, hueHint);
}

const dragPick =
  (pick: (e: React.PointerEvent) => void) =>
  ({
    onPointerDown: (e: React.PointerEvent) => {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      pick(e);
    },
    onPointerMove: (e: React.PointerEvent) => e.buttons === 1 && pick(e),
  });

function fraction(e: React.PointerEvent, el: HTMLElement): { fx: number; fy: number } {
  const rect = el.getBoundingClientRect();
  return {
    fx: clamp((e.clientX - rect.left) / rect.width, 0, 1),
    fy: clamp((e.clientY - rect.top) / rect.height, 0, 1),
  };
}

/**
 * Keeps the active color model as the view's internal representation: local
 * state holds the (possibly out-of-sRGB-gamut) model values, edits export a
 * clamped color to the store, and only *external* changes to the foreground
 * color re-derive the local values. This is what keeps e.g. Lab a=110 from
 * being pulled back by the sRGB clamp on the next render.
 */
function useModelState<T>(
  fg: HSV,
  setFg: (c: HSV) => void,
  derive: (fg: HSV) => T,
  toRgb: (value: T) => RGB,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => derive(fg));
  const exportedRef = useRef<HSV | null>(null);
  const lastFgRef = useRef(fg);
  if (fg !== lastFgRef.current) {
    lastFgRef.current = fg;
    if (exportedRef.current !== fg) setValue(derive(fg));
  }
  const apply = (next: T) => {
    setValue(next);
    const hsv = fromRgb(toRgb(next), fg.h);
    exportedRef.current = hsv;
    setFg(hsv);
  };
  return [value, apply];
}

/** One labeled numeric field of a values row. */
interface NumSpec {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  digits?: number;
  onChange: (v: number) => void;
}

function ValuesRow({ items }: { items: NumSpec[] }) {
  return (
    <div className="values-row">
      {items.map((it) => (
        <label key={it.label} className="values-field">
          <span className="ch-label">{it.label}</span>
          <input
            className="num"
            type="number"
            min={it.min}
            max={it.max}
            step={it.step ?? 1}
            value={Number(it.value.toFixed(it.digits ?? 0))}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) it.onChange(clamp(v, it.min, it.max));
            }}
          />
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HSB: saturation/brightness square + hue strip + numeric readouts
// ---------------------------------------------------------------------------

function HsbArea({ fg, setFg }: { fg: HSV; setFg: (c: HSV) => void }) {
  const svRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = svRef.current;
    if (!canvas) return;
    const w = (canvas.width = canvas.clientWidth || 220);
    const h = (canvas.height = canvas.clientHeight || 140);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = `#${rgbToHex(hsvToRgb({ h: fg.h, s: 1, v: 1 }))}`;
    ctx.fillRect(0, 0, w, h);
    const white = ctx.createLinearGradient(0, 0, w, 0);
    white.addColorStop(0, 'rgba(255,255,255,1)');
    white.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, w, h);
    const black = ctx.createLinearGradient(0, 0, 0, h);
    black.addColorStop(0, 'rgba(0,0,0,0)');
    black.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(fg.s * w, (1 - fg.v) * h, 5, 0, Math.PI * 2);
    ctx.strokeStyle = fg.v > 0.5 ? '#000' : '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [fg]);

  const svPick = (e: React.PointerEvent) => {
    const { fx, fy } = fraction(e, svRef.current!);
    setFg({ h: fg.h, s: fx, v: 1 - fy });
  };
  const huePick = (e: React.PointerEvent) => {
    const { fx } = fraction(e, e.currentTarget as HTMLElement);
    setFg({ ...fg, h: fx * 360 });
  };

  return (
    <>
      <canvas ref={svRef} className="sv-square" {...dragPick(svPick)} />
      <div
        className="hue-slider"
        style={{
          background:
            'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)',
        }}
        {...dragPick(huePick)}
      >
        <div className="hue-marker" style={{ left: `${(fg.h / 360) * 100}%` }} />
      </div>
      <ValuesRow
        items={[
          { label: 'H', value: fg.h, min: 0, max: 360, onChange: (v) => setFg({ ...fg, h: v }) },
          {
            label: 'S',
            value: fg.s * 100,
            min: 0,
            max: 100,
            onChange: (v) => setFg({ ...fg, s: v / 100 }),
          },
          {
            label: 'B',
            value: fg.v * 100,
            min: 0,
            max: 100,
            onChange: (v) => setFg({ ...fg, v: v / 100 }),
          },
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// RGB: three gradient sliders
// ---------------------------------------------------------------------------

function RgbArea({ fg, setFg }: { fg: HSV; setFg: (c: HSV) => void }) {
  const rgb = hsvToRgb(fg);
  const channels: { label: string; key: keyof RGB }[] = [
    { label: 'R', key: 'r' },
    { label: 'G', key: 'g' },
    { label: 'B', key: 'b' },
  ];
  return (
    <>
      {channels.map((ch) => {
        const lo = { ...rgb, [ch.key]: 0 };
        const hi = { ...rgb, [ch.key]: 1 };
        return (
          <label className="channel-row" key={ch.label}>
            <span className="ch-label">{ch.label}</span>
            <input
              type="range"
              min={0}
              max={255}
              step={1}
              value={Math.round(rgb[ch.key] * 255)}
              style={{
                backgroundImage: `linear-gradient(to right, #${rgbToHex(lo)}, #${rgbToHex(hi)})`,
              }}
              onChange={(e) =>
                setFg(fromRgb({ ...rgb, [ch.key]: Number(e.target.value) / 255 }, fg.h))
              }
            />
            <input
              className="num"
              type="number"
              min={0}
              max={255}
              value={Math.round(rgb[ch.key] * 255)}
              onChange={(e) =>
                setFg(
                  fromRgb(
                    { ...rgb, [ch.key]: clamp(Number(e.target.value), 0, 255) / 255 },
                    fg.h,
                  ),
                )
              }
            />
          </label>
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Lab: a/b plane (a right, b up) + L strip + numeric readouts.
// Lab is the internal representation while this mode is active, so values
// outside the sRGB gamut hold steady instead of drifting through the clamp.
// ---------------------------------------------------------------------------

function LabArea({ fg, setFg }: { fg: HSV; setFg: (c: HSV) => void }) {
  const abRef = useRef<HTMLCanvasElement>(null);
  const [lab, apply] = useModelState<Lab>(
    fg,
    setFg,
    (c) => rgbToLab(hsvToRgb(c)),
    (v) => labToRgb(v),
  );

  useEffect(() => {
    const canvas = abRef.current;
    if (!canvas) return;
    const w = (canvas.width = canvas.clientWidth || 220);
    const h = (canvas.height = canvas.clientHeight || 140);
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const b = 127 - (y / (h - 1)) * 255;
      for (let x = 0; x < w; x++) {
        const a = -128 + (x / (w - 1)) * 255;
        const rgb = labToRgb({ l: lab.l, a, b });
        const i = (y * w + x) * 4;
        img.data[i] = rgb.r * 255;
        img.data[i + 1] = rgb.g * 255;
        img.data[i + 2] = rgb.b * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    ctx.beginPath();
    ctx.arc(
      (clamp(lab.a, -128, 127) + 128) / 255 * w,
      ((127 - clamp(lab.b, -128, 127)) / 255) * h,
      5,
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = lab.l > 50 ? '#000' : '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [lab.l, lab.a, lab.b]);

  const abPick = (e: React.PointerEvent) => {
    const { fx, fy } = fraction(e, abRef.current!);
    apply({ l: lab.l, a: -128 + fx * 255, b: 127 - fy * 255 });
  };
  const lPick = (e: React.PointerEvent) => {
    const { fx } = fraction(e, e.currentTarget as HTMLElement);
    apply({ ...lab, l: fx * 100 });
  };

  const stops: string[] = [];
  for (let i = 0; i <= 10; i++) {
    stops.push(`#${rgbToHex(labToRgb({ l: i * 10, a: lab.a, b: lab.b }))} ${i * 10}%`);
  }

  return (
    <>
      <canvas ref={abRef} className="sv-square lab-square" {...dragPick(abPick)} />
      <div
        className="hue-slider"
        title="L (lightness)"
        style={{ backgroundImage: `linear-gradient(to right, ${stops.join(', ')})` }}
        {...dragPick(lPick)}
      >
        <div className="hue-marker" style={{ left: `${clamp(lab.l, 0, 100)}%` }} />
      </div>
      <ValuesRow
        items={[
          { label: 'L', value: lab.l, min: 0, max: 100, onChange: (v) => apply({ ...lab, l: v }) },
          {
            label: 'a',
            value: lab.a,
            min: -128,
            max: 127,
            onChange: (v) => apply({ ...lab, a: v }),
          },
          {
            label: 'b',
            value: lab.b,
            min: -128,
            max: 127,
            onChange: (v) => apply({ ...lab, b: v }),
          },
        ]}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// OKLCH, in the style of oklch.com: each component gets a two-dimensional
// gamut diagram (rendered per-pixel; the checker marks out-of-sRGB regions):
//   L — x: lightness, y: chroma (at the current hue)
//   C — x: hue,       y: chroma (at the current lightness)
//   H — x: hue,       y: lightness (at the current chroma)
// Dragging a diagram picks both of its axes; the numbers give exact entry.
// ---------------------------------------------------------------------------

const C_MAX = 0.4;

function OklchChart({
  xMax,
  yMax,
  deps,
  colorAt,
  marker,
  onPick,
}: {
  xMax: number;
  yMax: number;
  /** cache key: the parameters the field depends on (not the marker) */
  deps: string;
  colorAt: (xv: number, yv: number) => OKLCH;
  marker: { x: number; y: number };
  onPick: (xv: number, yv: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<{ key: string; img: ImageData } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    // Render at the device pixel ratio so the field is crisp on high-DPI
    // displays, and draw the marker in device pixels so it stays circular.
    const dpr = devicePixelRatio || 1;
    const w = Math.max(2, Math.round((canvas.clientWidth || 200) * dpr));
    const h = Math.max(2, Math.round((canvas.clientHeight || 52) * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    // The gamut field only depends on `deps`, so drags that just move the
    // marker reuse the cached pixels.
    const key = `${deps}|${w}x${h}`;
    let cache = cacheRef.current;
    if (!cache || cache.key !== key) {
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const yv = yMax * (1 - y / (h - 1));
        for (let x = 0; x < w; x++) {
          const ok = colorAt((x / (w - 1)) * xMax, yv);
          if (!oklchInGamut(ok)) continue; // out of gamut stays transparent
          const rgb = oklchToRgb(ok);
          const i = (y * w + x) * 4;
          img.data[i] = rgb.r * 255;
          img.data[i + 1] = rgb.g * 255;
          img.data[i + 2] = rgb.b * 255;
          img.data[i + 3] = 255;
        }
      }
      cache = { key, img };
      cacheRef.current = cache;
    }
    ctx.clearRect(0, 0, w, h);
    ctx.putImageData(cache.img, 0, 0);

    const mx = clamp(marker.x / xMax, 0, 1) * (w - 1);
    const my = (1 - clamp(marker.y / yMax, 0, 1)) * (h - 1);
    ctx.beginPath();
    ctx.arc(mx, my, 4.5 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my, 5.6 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.stroke();
  });

  const pick = (e: React.PointerEvent) => {
    const { fx, fy } = fraction(e, ref.current!);
    onPick(fx * xMax, (1 - fy) * yMax);
  };

  return (
    <div className="ok-row">
      <span className="ch-label" aria-hidden />
      <div className="ok-chart-wrap" {...dragPick(pick)}>
        <canvas ref={ref} className="ok-chart" />
      </div>
    </div>
  );
}

/** Regular one-axis slider (like the RGB rows) under each gamut diagram. */
function OklchSlider({
  label,
  value,
  min,
  max,
  step,
  digits,
  colorAt,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  colorAt: (v: number) => OKLCH;
  onChange: (v: number) => void;
}) {
  const stops: string[] = [];
  for (let i = 0; i <= 12; i++) {
    const v = min + ((max - min) * i) / 12;
    stops.push(`#${rgbToHex(oklchToRgb(colorAt(v)))} ${(i / 12) * 100}%`);
  }
  return (
    <label className="channel-row ok-sub">
      <span className="ch-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ backgroundImage: `linear-gradient(to right, ${stops.join(', ')})` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        className="num ok-num"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number(value.toFixed(digits))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(clamp(v, min, max));
        }}
      />
    </label>
  );
}

function OklchArea({ fg, setFg }: { fg: HSV; setFg: (c: HSV) => void }) {
  const [ok, apply] = useModelState<OKLCH>(
    fg,
    setFg,
    (c) => rgbToOklch(hsvToRgb(c)),
    (v) => oklchToRgb(v),
  );

  return (
    <div className="ok-area">
      <OklchChart
        xMax={1}
        yMax={C_MAX}
        deps={`h${ok.h.toFixed(2)}`}
        colorAt={(l, c) => ({ l, c, h: ok.h })}
        marker={{ x: ok.l, y: ok.c }}
        onPick={(l, c) => apply({ l, c, h: ok.h })}
      />
      <OklchSlider
        label="L"
        value={ok.l * 100}
        min={0}
        max={100}
        step={0.5}
        digits={1}
        colorAt={(v) => ({ ...ok, l: v / 100 })}
        onChange={(v) => apply({ ...ok, l: v / 100 })}
      />
      <OklchChart
        xMax={360}
        yMax={C_MAX}
        deps={`l${ok.l.toFixed(3)}`}
        colorAt={(h, c) => ({ l: ok.l, c, h })}
        marker={{ x: ok.h, y: ok.c }}
        onPick={(h, c) => apply({ l: ok.l, c, h })}
      />
      <OklchSlider
        label="C"
        value={ok.c}
        min={0}
        max={C_MAX}
        step={0.002}
        digits={3}
        colorAt={(v) => ({ ...ok, c: v })}
        onChange={(v) => apply({ ...ok, c: v })}
      />
      <OklchChart
        xMax={360}
        yMax={1}
        deps={`c${ok.c.toFixed(4)}`}
        colorAt={(h, l) => ({ l, c: ok.c, h })}
        marker={{ x: ok.h, y: ok.l }}
        onPick={(h, l) => apply({ l, c: ok.c, h })}
      />
      <OklchSlider
        label="H"
        value={ok.h}
        min={0}
        max={360}
        step={1}
        digits={1}
        colorAt={(v) => ({ ...ok, h: v })}
        onChange={(v) => apply({ ...ok, h: v })}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ColorPicker() {
  const fg = useStore((s) => s.fg);
  const setFg = useStore((s) => s.setFg);
  const [mode, setMode] = useState<Mode>('hsb');
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const hex = rgbToHex(hsvToRgb(fg));

  return (
    <div className="panel color-panel">
      {/* model tabs stay at the top so they don't move as panel height changes */}
      <div className="mode-tabs">
        {(['hsb', 'rgb', 'lab', 'oklch'] as Mode[]).map((m) => (
          <button
            key={m}
            className={`tab ${mode === m ? 'active' : ''}`}
            onClick={() => setMode(m)}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      {mode === 'hsb' && <HsbArea fg={fg} setFg={setFg} />}
      {mode === 'rgb' && <RgbArea fg={fg} setFg={setFg} />}
      {mode === 'lab' && <LabArea fg={fg} setFg={setFg} />}
      {mode === 'oklch' && <OklchArea fg={fg} setFg={setFg} />}

      <label className="channel-row hex-row">
        <span className="ch-label">#</span>
        <input
          className="hex"
          value={hexDraft ?? hex}
          onChange={(e) => {
            setHexDraft(e.target.value);
            const parsed = hexToRgb(e.target.value);
            if (parsed) setFg(rgbToHsv(parsed, fg.h));
          }}
          onBlur={() => setHexDraft(null)}
          spellCheck={false}
        />
        <div className="preview" style={{ background: `#${hex}` }} />
      </label>
    </div>
  );
}
