import { emitStamps, STAMP_FLOATS, type StampContext } from '../brush/dynamics';
import { seededRng } from '../brush/patterns';
import type { BrushSettings } from '../brush/types';

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

  for (let i = 0; i < stamps.length; i += STAMP_FLOATS) {
    const px = stamps[i];
    const py = stamps[i + 1];
    const radius = Math.max(stamps[i + 2], 0.4);
    const alpha = stamps[i + 3];
    const angle = stamps[i + 4];
    const roundness = stamps[i + 5];
    const hard = pv.tip.hardness;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.scale(1, Math.max(roundness, 0.05));
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    const core = pv.tip.shape === 'round' ? hard * 0.98 : 0.35;
    grad.addColorStop(0, `rgba(0,0,0,${alpha})`);
    grad.addColorStop(Math.max(core, 0.01), `rgba(0,0,0,${alpha})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
