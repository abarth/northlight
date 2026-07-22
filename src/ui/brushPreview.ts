import { BristleSim, mulberry32, TRACK_FLOATS } from '../brush/bristle';
import type { BristlePreset } from '../brush/bristlePresets';
import { emitStamps, STAMP_FLOATS, type StampContext } from '../brush/dynamics';
import { getTip, seededRng } from '../brush/patterns';
import type { BrushSettings, TipShape } from '../brush/types';

/** Black-tinted canvas of a tip's alpha map, for preview stamping. */
const tipCanvasCache = new Map<string, HTMLCanvasElement>();

export function tipCanvas(shape: TipShape): HTMLCanvasElement {
  let c = tipCanvasCache.get(shape);
  if (!c) {
    const map = getTip(shape);
    c = document.createElement('canvas');
    c.width = map.size;
    c.height = map.size;
    const img = new ImageData(map.size, map.size);
    for (let i = 0; i < map.data.length; i++) img.data[i * 4 + 3] = map.data[i];
    c.getContext('2d')!.putImageData(img, 0, 0);
    tipCanvasCache.set(shape, c);
  }
  return c;
}

/**
 * Draws a Photoshop-style stroke preview for a preset by running the real
 * dynamics evaluator along a sine path and rasterizing the resulting stamps
 * with a cheap radial-gradient approximation of the tip.
 */
export function drawBrushPreview(canvas: HTMLCanvasElement, settings: BrushSettings): void {
  const w = (canvas.width = canvas.clientWidth * (devicePixelRatio || 1) || 96);
  const h = (canvas.height = canvas.clientHeight * (devicePixelRatio || 1) || 30);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  // Preview at a normalized size so scatter/size dynamics stay in frame.
  const pv = structuredClone(settings);
  pv.tip.size = h * 0.55;

  const rng = seededRng(0xbee5);
  const stamps: number[] = [];
  const steps = 48;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = 6 + t * (w - 12);
    const y = h / 2 - Math.sin(t * Math.PI * 2) * h * 0.2;
    const pressure = Math.sin(t * Math.PI); // ramp in and out
    const dirY = -Math.cos(t * Math.PI * 2) * h * 0.2 * ((Math.PI * 2) / (w - 12));
    const ctxStamp: StampContext = {
      sample: { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0 },
      direction: Math.atan2(dirY, 1),
      initialDirection: 0,
      stepIndex: i,
    };
    emitStamps(
      pv,
      ctxStamp,
      x,
      y,
      {
        strokeColor: { r: 0, g: 0, b: 0 },
        fg: { h: 0, s: 0, v: 0 },
        bg: { h: 0, s: 0, v: 1 },
        rng,
      },
      stamps,
    );
  }

  const sampled = pv.tip.shape !== 'round' ? tipCanvas(pv.tip.shape) : null;

  for (let i = 0; i < stamps.length; i += STAMP_FLOATS) {
    const px = stamps[i];
    const py = stamps[i + 1];
    const radius = Math.max(stamps[i + 2], 0.4);
    const alpha = stamps[i + 3];
    const angle = stamps[i + 4];
    const roundness = stamps[i + 5];

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.scale(1, Math.max(roundness, 0.05));
    if (sampled) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(sampled, -radius, -radius, radius * 2, radius * 2);
    } else {
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
      const core = pv.tip.hardness * 0.98;
      grad.addColorStop(0, `rgba(0,0,0,${alpha})`);
      grad.addColorStop(Math.max(core, 0.01), `rgba(0,0,0,${alpha})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/**
 * Stroke preview for a bristle preset: runs the real BristleSim along the
 * same sine path (with a pressure ramp) and draws the emitted track segments
 * as round-capped lines. The sim runs in a fixed virtual space (~300 px of
 * travel) so px-denominated settings — load capacity, breakup scale — read
 * at a realistic short-stroke scale, then the drawing scales to the canvas.
 * Canvas tooth is not simulated here; breakup, depletion and per-bristle
 * jitter all show.
 */
export function drawBristlePreview(canvas: HTMLCanvasElement, preset: BristlePreset): void {
  const w = (canvas.width = canvas.clientWidth * (devicePixelRatio || 1) || 96);
  const h = (canvas.height = canvas.clientHeight * (devicePixelRatio || 1) || 30);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);

  const VW = 300;
  const vh = (VW * h) / Math.max(w, 1);
  const sim = new BristleSim(preset.settings, vh * 0.62, {
    fg: { h: 0, s: 0, v: 0 },
    bg: { h: 0, s: 0, v: 1 },
    rng: mulberry32(0xbee5),
  });

  const records: number[] = [];
  const steps = 72;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    sim.update(
      {
        x: 8 + t * (VW - 16),
        y: vh / 2 - Math.sin(t * Math.PI * 2) * vh * 0.2,
        pressure: Math.sin(t * Math.PI),
        tiltX: 0,
        tiltY: 0,
        twist: 0,
      },
      records,
    );
  }

  const scale = w / VW;
  for (let i = 0; i < records.length; i += TRACK_FLOATS) {
    const x0 = records[i] * scale;
    const y0 = records[i + 1] * scale;
    const x1 = records[i + 2] * scale;
    const y1 = records[i + 3] * scale;
    const width = Math.max(records[i + 8] * 2 * scale, 0.3);
    const alpha = (records[i + 9] + records[i + 10]) / 2;
    const [r, g, b] = [records[i + 11], records[i + 12], records[i + 13]];
    const flags = records[i + 19];
    const style = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(
      b * 255,
    )},${alpha * preset.opacity})`;
    if (Math.hypot(x1 - x0, y1 - y0) < 0.05) {
      ctx.fillStyle = style;
      ctx.beginPath();
      ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineCap = flags > 0 ? 'round' : 'butt';
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
}
