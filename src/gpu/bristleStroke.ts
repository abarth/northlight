import type { PaintEngine } from './engine';
import type { PointerSample } from '../brush/dynamics';
import { BristleSim, type BristleBrushSettings } from '../brush/bristle';
import type { HSV } from '../types';

export interface BristleStrokeOptions {
  fg: HSV;
  bg: HSV;
  /** tuft diameter in document px (shared with the options-bar brush size) */
  sizePx: number;
  /** 0..1 input smoothing (EMA), same meaning as the stamp engine's */
  smoothing: number;
  /** injectable for deterministic tests; defaults to Math.random */
  rng?: () => number;
}

/**
 * With "reload on lift" off, the tuft's pigment state (per-bristle load)
 * carries across strokes: successive strokes keep drying out until the brush
 * is re-dipped. The sim is cached between sessions and invalidated when the
 * brush parameters, size, or colors change (changing color re-dips).
 */
let cachedSim: BristleSim | null = null;
let cachedKey = '';

function simFor(
  settings: BristleBrushSettings,
  opts: BristleStrokeOptions,
): BristleSim {
  const key = JSON.stringify([settings, opts.sizePx, opts.fg, opts.bg]);
  if (!settings.reloadOnLift && cachedSim && cachedKey === key) return cachedSim;
  const sim = new BristleSim(settings, opts.sizePx, opts);
  cachedSim = settings.reloadOnLift ? null : sim;
  cachedKey = key;
  return sim;
}

/**
 * Bristle-engine counterpart of StrokeSession: feeds pointer samples to the
 * BristleSim and flushes the resulting track-segment records to the GPU.
 * Unlike the stamp session there is no spacing walk — every input sample
 * advances every contacted bristle's track, so mark quality is limited by
 * input rate, not by stamp spacing.
 */
export class BristleStrokeSession {
  private engine: PaintEngine;
  private sim: BristleSim;
  private smoothing: number;
  private smoothed: PointerSample | null = null;
  private records: number[] = [];

  constructor(engine: PaintEngine, settings: BristleBrushSettings, opts: BristleStrokeOptions) {
    this.engine = engine;
    this.smoothing = opts.smoothing;
    this.sim = simFor(settings, opts);
    if (settings.reloadOnLift) this.sim.reload();
  }

  down(sample: PointerSample): void {
    this.smoothed = sample;
    this.sim.update(sample, this.records);
    this.flush();
  }

  move(inputs: PointerSample[]): void {
    if (!this.smoothed) return;
    const k = 1 - Math.min(this.smoothing, 0.95) * 0.9;
    for (const raw of inputs) {
      const pt: PointerSample = {
        x: this.smoothed.x + (raw.x - this.smoothed.x) * k,
        y: this.smoothed.y + (raw.y - this.smoothed.y) * k,
        pressure: raw.pressure,
        tiltX: raw.tiltX,
        tiltY: raw.tiltY,
        twist: raw.twist,
      };
      this.smoothed = pt;
      this.sim.update(pt, this.records);
    }
    this.flush();
  }

  up(): void {
    this.sim.liftAll();
    this.flush();
  }

  cancel(): void {
    this.records = [];
  }

  private flush(): void {
    if (this.records.length === 0) return;
    const records = new Float32Array(this.records);
    this.records = [];
    this.engine.drawTracks(records);
  }
}
