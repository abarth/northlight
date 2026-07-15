import { useEffect, useRef, useState } from 'react';
import {
  clamp,
  hexToRgb,
  hsvToRgb,
  labToRgb,
  rgbToHex,
  rgbToHsv,
  rgbToLab,
  type RGB,
} from '../color/convert';
import { useStore } from '../store';
import type { HSV } from '../types';

type Mode = 'hsb' | 'rgb' | 'lab';

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

const CHANNELS: Record<Mode, ChannelSpec[]> = {
  hsb: [
    {
      label: 'H',
      min: 0,
      max: 360,
      get: (c) => c.h,
      set: (c, v) => ({ ...c, h: v }),
    },
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

export function ColorPicker() {
  const fg = useStore((s) => s.fg);
  const setFg = useStore((s) => s.setFg);
  const [mode, setMode] = useState<Mode>('hsb');
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const svRef = useRef<HTMLCanvasElement>(null);

  const rgb = hsvToRgb(fg);
  const hex = rgbToHex(rgb);

  // --- saturation/brightness square ---
  useEffect(() => {
    const canvas = svRef.current;
    if (!canvas) return;
    const w = (canvas.width = canvas.clientWidth || 220);
    const h = (canvas.height = canvas.clientHeight || 140);
    const ctx = canvas.getContext('2d')!;
    const hueRgb = hsvToRgb({ h: fg.h, s: 1, v: 1 });
    ctx.fillStyle = `#${rgbToHex(hueRgb)}`;
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
    // marker
    const x = fg.s * w;
    const y = (1 - fg.v) * h;
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.strokeStyle = fg.v > 0.5 ? '#000' : '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [fg]);

  function svPick(e: React.PointerEvent) {
    const canvas = svRef.current!;
    const rect = canvas.getBoundingClientRect();
    const s = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    const v = clamp(1 - (e.clientY - rect.top) / rect.height, 0, 1);
    setFg({ h: fg.h, s, v });
  }

  function huePick(e: React.PointerEvent, el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    const h = clamp((e.clientX - rect.left) / rect.width, 0, 1) * 360;
    setFg({ ...fg, h });
  }

  const hueGradient =
    'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)';

  return (
    <div className="panel color-panel">
      <div className="panel-title">Color</div>
      <canvas
        ref={svRef}
        className="sv-square"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          svPick(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && svPick(e)}
      />
      <div
        className="hue-slider"
        style={{ background: hueGradient }}
        onPointerDown={(e) => {
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          huePick(e, el);
        }}
        onPointerMove={(e) => e.buttons === 1 && huePick(e, e.currentTarget)}
      >
        <div className="hue-marker" style={{ left: `${(fg.h / 360) * 100}%` }} />
      </div>

      <div className="mode-tabs">
        {(['hsb', 'rgb', 'lab'] as Mode[]).map((m) => (
          <button
            key={m}
            className={`tab ${mode === m ? 'active' : ''}`}
            onClick={() => setMode(m)}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      {CHANNELS[mode].map((spec) => {
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
