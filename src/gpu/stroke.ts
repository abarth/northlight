import type { PaintEngine } from './engine';
import type { BrushSettings } from '../types';

export interface StrokeInput {
  x: number; // document px
  y: number;
  pressure: number; // 0..1
}

/**
 * Turns a stream of pointer samples into brush stamps: distance-based spacing
 * (re-evaluated per stamp so pressure-driven size changes spacing too),
 * linear pressure interpolation along segments, and optional EMA smoothing.
 */
export class StrokeSession {
  private engine: PaintEngine;
  private settings: BrushSettings;
  private last: StrokeInput | null = null;
  private smoothed: StrokeInput | null = null;
  private residual = 0; // distance carried since the last stamp
  private stamps: number[] = [];

  constructor(engine: PaintEngine, settings: BrushSettings) {
    this.engine = engine;
    this.settings = settings;
  }

  private diameter(pressure: number): number {
    const s = this.settings;
    const d = s.size * (s.pressureSize ? Math.max(pressure, 0.02) : 1);
    return Math.max(d, 0.5);
  }

  private stampAlpha(pressure: number): number {
    const s = this.settings;
    let a = s.flow;
    if (s.pressureFlow) a *= pressure;
    // Opacity dynamics modulate per-dab deposition; the stroke-level opacity
    // cap itself stays constant (set at beginStroke).
    if (s.pressureOpacity) a *= pressure;
    return Math.min(Math.max(a, 0), 1);
  }

  private spacingPx(pressure: number): number {
    return Math.max(this.settings.spacing * this.diameter(pressure), 0.5);
  }

  private emit(x: number, y: number, pressure: number): void {
    this.stamps.push(x, y, this.diameter(pressure) / 2, this.stampAlpha(pressure));
  }

  down(input: StrokeInput): void {
    this.last = input;
    this.smoothed = input;
    this.residual = 0;
    this.emit(input.x, input.y, input.pressure);
    this.flush();
  }

  move(inputs: StrokeInput[]): void {
    if (!this.last || !this.smoothed) return;
    // smoothing strength -> EMA blend factor (0 = raw input)
    const k = 1 - Math.min(this.settings.smoothing, 0.95) * 0.9;
    for (const raw of inputs) {
      const pt: StrokeInput = {
        x: this.smoothed.x + (raw.x - this.smoothed.x) * k,
        y: this.smoothed.y + (raw.y - this.smoothed.y) * k,
        pressure: raw.pressure,
      };
      this.smoothed = pt;
      this.segment(this.last, pt);
      this.last = pt;
    }
    this.flush();
  }

  up(): void {
    this.flush();
  }

  private segment(a: StrokeInput, b: StrokeInput): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) return;
    let travelled = 0;
    // Hard cap so a pathological event can't hang the tab.
    for (let guard = 0; guard < 10000; guard++) {
      const t = travelled / dist;
      const pHere = a.pressure + (b.pressure - a.pressure) * t;
      const need = this.spacingPx(pHere) - this.residual;
      if (travelled + need > dist) {
        this.residual += dist - travelled;
        break;
      }
      travelled += need;
      this.residual = 0;
      const tt = travelled / dist;
      this.emit(
        a.x + dx * tt,
        a.y + dy * tt,
        a.pressure + (b.pressure - a.pressure) * tt,
      );
    }
  }

  private flush(): void {
    if (this.stamps.length === 0) return;
    const arr = new Float32Array(this.stamps);
    this.engine.drawStamps(arr, arr.length / 4);
    this.stamps = [];
  }
}
