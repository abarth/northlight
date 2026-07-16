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
  type OKLCH,
  type RGB,
} from '../color/convert';
import { useStore } from '../store';
import type { HSV } from '../types';

type Mode = 'hsb' | 'rgb' | 'lab' | 'oklch';

interface ChannelSpec {
  label: string;
  min: number;
  max: number;
  get: (hsv: HSV) => number;
  set: (hsv: HSV, value: number) => HSV;
}

function fromRgb(rgb: RGB, hueHint: number): HSV {
  return rgbToHsv(rgb, hueHint);
}

const CHANNELS: Record<Exclude<Mode, 'oklch'>, ChannelSpec[]> = {
  hsb: [
    { label: 'H', min: 0, max: 360, get: (c) => c.h, set: (c, v) => ({ ...c, h: v }) },
    {
      label: 'S',
      min: 0,
      max: 100,
      get: (c) => c.s * 100,
      set: (c, v) => ({ ...c, s: v / 100 }),
    },
    {
      label: 'B',
      min: 0,
      max: 100,
      get: (c) => c.v * 100,
      set: (c, v) => ({ ...c, v: v / 100 }),
    },
  ],
  rgb: [
    {
      label: 'R',
      min: 0,
      max: 255,
      get: (c) => hsvToRgb(c).r * 255,
      set: (c, v) => fromRgb({ ...hsvToRgb(c), r: v / 255 }, c.h),
    },
    {
      label: 'G',
      min: 0,
      max: 255,
      get: (c) => hsvToRgb(c).g * 255,
      set: (c, v) => fromRgb({ ...hsvToRgb(c), g: v / 255 }, c.h),
    },
    {
      label: 'B',
      min: 0,
      max: 255,
      get: (c) => hsvToRgb(c).b * 255,
      set: (c, v) => fromRgb({ ...hsvToRgb(c), b: v / 255 }, c.h),
    },
  ],
  lab: [
    {
      label: 'L',
      min: 0,
      max: 100,
      get: (c) => rgbToLab(hsvToRgb(c)).l,
      set: (c, v) => fromRgb(labToRgb({ ...rgbToLab(hsvToRgb(c)), l: v }), c.h),
    },
    {
      label: 'a',
      min: -128,
      max: 127,
      get: (c) => rgbToLab(hsvToRgb(c)).a,
      set: (c, v) => fromRgb(labToRgb({ ...rgbToLab(hsvToRgb(c)), a: v }), c.h),
    },
    {
      label: 'b',
      min: -128,
      max: 127,
      get: (c) => rgbToLab(hsvToRgb(c)).b,
      set: (c, v) => fromRgb(labToRgb({ ...rgbToLab(hsvToRgb(c)), b: v }), c.h),
    },
  ],
};

/** CSS gradient for a slider by sweeping one channel across its range. */
function channelGradient(spec: ChannelSpec, color: HSV): string {
  const stops: string[] = [];
  const n = 12;
  for (let i = 0; i <= n; i++) {
    const v = spec.min + ((spec.max - spec.min) * i) / n;
    const rgb = hsvToRgb(spec.set(color, v));
    stops.push(`#${rgbToHex(rgb)} ${(i / n) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
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

// ---------------------------------------------------------------------------
// HSB: saturation/brightness square + hue strip
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
    </>
  );
}

// ---------------------------------------------------------------------------
// Lab: a/b square (a right, b up) + L strip
// ---------------------------------------------------------------------------

function LabArea({ fg, setFg }: { fg: HSV; setFg: (c: HSV) => void }) {
  const abRef = useRef<HTMLCanvasElement>(null);
  const lab = rgbToLab(hsvToRgb(fg));

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
    ctx.arc(((lab.a + 128) / 255) * w, ((127 - lab.b) / 255) * h, 5, 0, Math.PI * 2);
    ctx.strokeStyle = lab.l > 50 ? '#000' : '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [fg, lab.l, lab.a, lab.b]);

  const abPick = (e: React.PointerEvent) => {
    const { fx, fy } = fraction(e, abRef.current!);
    setFg(fromRgb(labToRgb({ l: lab.l, a: -128 + fx * 255, b: 127 - fy * 255 }), fg.h));
  };
  const lPick = (e: React.PointerEvent) => {
    const { fx } = fraction(e, e.currentTarget as HTMLElement);
    setFg(fromRgb(labToRgb({ ...lab, l: fx * 100 }), fg.h));
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
        style={{ background: `linear-gradient(to right, ${stops.join(', ')})` }}
        {...dragPick(lPick)}
      >
        <div className="hue-marker" style={{ left: `${lab.l}%` }} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// OKLCH: gamut-aware L/C/H strips in the style of oklch.com — each strip
// sweeps one channel with the others held, rendering only the slice that is
// inside the sRGB gamut (out-of-gamut regions show the dark checker).
// ---------------------------------------------------------------------------

const C_MAX = 0.4;

function OklchStrip({
  label,
  value,
  max,
  display,
  colorAt,
  onPick,
  step,
}: {
  label: string;
  value: number; // 0..max
  max: number;
  display: { digits: number; scale: number };
  colorAt: (v: number) => OKLCH;
  onPick: (v: number) => void;
  step: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const w = (canvas.width = canvas.clientWidth || 200);
    const h = (canvas.height = canvas.clientHeight || 16);
    const ctx = canvas.getContext('2d')!;
    // dark checker background = out-of-gamut
    ctx.fillStyle = '#26262b';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#333338';
    for (let x = 0; x < w; x += 8) {
      ctx.fillRect(x + (Math.floor(x / 8) % 2 ? 0 : 4), 0, 4, h);
    }
    const img = ctx.getImageData(0, 0, w, h);
    for (let x = 0; x < w; x++) {
      const ok = colorAt((x / (w - 1)) * max);
      if (!oklchInGamut(ok)) continue;
      const rgb = oklchToRgb(ok);
      for (let y = 0; y < h; y++) {
        const i = (y * w + x) * 4;
        img.data[i] = rgb.r * 255;
        img.data[i + 1] = rgb.g * 255;
        img.data[i + 2] = rgb.b * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });

  const pick = (e: React.PointerEvent) => {
    const { fx } = fraction(e, ref.current!);
    onPick(fx * max);
  };

  return (
    <div className="ok-row">
      <span className="ch-label">{label}</span>
      <div className="ok-strip-wrap" {...dragPick(pick)}>
        <canvas ref={ref} className="ok-strip" />
        <div className="hue-marker" style={{ left: `${(value / max) * 100}%` }} />
      </div>
      <input
        className="num ok-num"
        type="number"
        min={0}
        max={max * display.scale}
        step={step}
        value={Number((value * display.scale).toFixed(display.digits))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onPick(clamp(v / display.scale, 0, max));
        }}
      />
    </div>
  );
}

function OklchArea({ fg, setFg }: { fg: HSV; setFg: (c: HSV) => void }) {
  // hue/chroma survive achromatic round-trips through the HSV store color
  const hueRef = useRef(0);
  const ok = rgbToOklch(hsvToRgb(fg), hueRef.current);
  if (ok.c > 1e-3) hueRef.current = ok.h;

  const apply = (next: OKLCH) => {
    hueRef.current = next.h;
    setFg(fromRgb(oklchToRgb(next), fg.h));
  };

  return (
    <div className="ok-area">
      <OklchStrip
        label="L"
        value={ok.l}
        max={1}
        display={{ digits: 1, scale: 100 }}
        step={1}
        colorAt={(l) => ({ ...ok, l })}
        onPick={(l) => apply({ ...ok, l })}
      />
      <OklchStrip
        label="C"
        value={Math.min(ok.c, C_MAX)}
        max={C_MAX}
        display={{ digits: 3, scale: 1 }}
        step={0.005}
        colorAt={(c) => ({ ...ok, c })}
        onPick={(c) => apply({ ...ok, c })}
      />
      <OklchStrip
        label="H"
        value={ok.h}
        max={360}
        display={{ digits: 1, scale: 1 }}
        step={1}
        colorAt={(h) => ({ ...ok, h })}
        onPick={(h) => apply({ ...ok, h })}
      />
      {!oklchInGamut(ok) && (
        <div className="ok-warn">outside sRGB — shown clamped</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ColorPicker() {
  const fg = useStore((s) => s.fg);
  const setFg = useStore((s) => s.setFg);
  const [mode, setMode] = useState<Mode>('hsb');
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const rgb = hsvToRgb(fg);
  const hex = rgbToHex(rgb);

  return (
    <div className="panel color-panel">
      <div className="panel-title">Color</div>

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
      {mode === 'lab' && <LabArea fg={fg} setFg={setFg} />}
      {mode === 'oklch' && <OklchArea fg={fg} setFg={setFg} />}

      {mode !== 'oklch' &&
        CHANNELS[mode].map((spec) => {
          const value = spec.get(fg);
          return (
            <label className="channel-row" key={`${mode}-${spec.label}`}>
              <span className="ch-label">{spec.label}</span>
              <input
                type="range"
                min={spec.min}
                max={spec.max}
                step={1}
                value={Math.round(value)}
                style={{ background: channelGradient(spec, fg) }}
                onChange={(e) => setFg(spec.set(fg, Number(e.target.value)))}
              />
              <input
                className="num"
                type="number"
                min={spec.min}
                max={spec.max}
                value={Math.round(value)}
                onChange={(e) =>
                  setFg(spec.set(fg, clamp(Number(e.target.value), spec.min, spec.max)))
                }
              />
            </label>
          );
        })}

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
