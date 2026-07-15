import type { PaintEngine } from './engine';
import type { BrushSettings } from '../brush/types';
import {
  dynamicColor,
  emitStamps,
  stampDiameter,
  STAMP_FLOATS,
  type PointerSample,
  type StampContext,
} from '../brush/dynamics';
import { hsvToRgb, type RGB } from '../color/convert';
import type { HSV } from '../types';

export interface StrokeSessionOptions {
  fg: HSV;
  bg: HSV;
  /** injectable for deterministic tests; defaults to Math.random */
  rng?: () => number;
}

const zeroRng = () => 0;

/**
 * Turns a stream of pointer samples into brush stamps: distance-based spacing
 * (re-evaluated per stamp so pressure-driven size changes spacing too),
 * linear interpolation of pen state along segments, EMA smoothing, stroke
 * direction tracking for Direction controls, airbrush build-up, and all the
 * per-stamp dynamics (via brush/dynamics.ts).
 */
export class StrokeSession {
  private engine: PaintEngine;
  private settings: BrushSettings;
  private fg: HSV;
  private bg: HSV;
  private rng: () => number;

  private last: PointerSample | null = null;
  private smoothed: PointerSample | null = null;
  private residual = 0; // distance carried since the last stamp
  private stepIndex = 0;
  private direction = 0;
  private initialDirection = 0;
  private initialDirectionSet = false;
  private strokeColor: RGB;
  private stamps: number[] = [];
  private airbrushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(engine: PaintEngine, settings: BrushSettings, opts: StrokeSessionOptions) {
    this.engine = engine;
    this.settings = settings;
    this.fg = opts.fg;
    this.bg = opts.bg;
    this.rng = opts.rng ?? Math.random;

    // Color Dynamics without "apply per tip" varies the color once per stroke.
    const cd = settings.color;
    this.strokeColor =
      cd.enabled && !cd.applyPerTip
        ? dynamicColor(cd, this.fg, this.bg, this.contextAt(defaultSample(0, 0, 1)), this.rng)
        : hsvToRgb(this.fg);
  }

  private contextAt(sample: PointerSample): StampContext {
    return {
      sample,
      direction: this.direction,
      initialDirection: this.initialDirection,
      stepIndex: this.stepIndex,
    };
  }

  private emit(x: number, y: number, sample: PointerSample): void {
    emitStamps(
      this.settings,
      this.contextAt(sample),
      x,
      y,
      { strokeColor: this.strokeColor, fg: this.fg, bg: this.bg, rng: this.rng },
      this.stamps,
    );
  }

  /** Spacing distance for the current pen state (control-scaled, no jitter). */
  private spacingPx(sample: PointerSample): number {
    const d = stampDiameter(this.settings, this.contextAt(sample), zeroRng);
    return Math.max(this.settings.tip.spacing * d, 0.5);
  }

  down(sample: PointerSample): void {
    this.last = sample;
    this.smoothed = sample;
    this.residual = 0;
    this.stepIndex = 0;
    this.emit(sample.x, sample.y, sample);
    this.flush();

    if (this.settings.airbrush) {
      // Build-up: keep depositing while the pointer is held, Photoshop-style.
      this.airbrushTimer = setInterval(() => {
        const at = this.smoothed;
        if (!at) return;
        this.stepIndex++;
        this.emit(at.x, at.y, at);
        this.flush();
      }, 40);
    }
  }

  move(inputs: PointerSample[]): void {
    if (!this.last || !this.smoothed) return;
    // smoothing strength -> EMA blend factor (0 = raw input)
    const k = 1 - Math.min(this.settings.smoothing, 0.95) * 0.9;
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
      this.segment(this.last, pt);
      this.last = pt;
    }
    this.flush();
  }

  up(): void {
    this.stopAirbrush();
    this.flush();
  }

  cancel(): void {
    this.stopAirbrush();
    this.stamps = [];
  }

  private stopAirbrush(): void {
    if (this.airbrushTimer !== null) {
      clearInterval(this.airbrushTimer);
      this.airbrushTimer = null;
    }
  }

  private segment(a: PointerSample, b: PointerSample): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) return;

    this.direction = Math.atan2(dy, dx);
    if (!this.initialDirectionSet && dist > 1) {
      this.initialDirection = this.direction;
      this.initialDirectionSet = true;
    }

    const lerpSample = (t: number): PointerSample => ({
      x: a.x + dx * t,
      y: a.y + dy * t,
      pressure: a.pressure + (b.pressure - a.pressure) * t,
      tiltX: a.tiltX + (b.tiltX - a.tiltX) * t,
      tiltY: a.tiltY + (b.tiltY - a.tiltY) * t,
      twist: a.twist + (b.twist - a.twist) * t,
    });

    let travelled = 0;
    // Hard cap so a pathological event can't hang the tab.
    for (let guard = 0; guard < 10000; guard++) {
      const here = lerpSample(travelled / dist);
      const need = this.spacingPx(here) - this.residual;
      if (travelled + need > dist) {
        this.residual += dist - travelled;
        break;
      }
      travelled += need;
      this.residual = 0;
      this.stepIndex++;
      const at = lerpSample(travelled / dist);
      this.emit(at.x, at.y, at);
    }
  }

  private flush(): void {
    if (this.stamps.length === 0) return;
    const arr = new Float32Array(this.stamps);
    this.engine.drawStamps(arr, arr.length / STAMP_FLOATS);
    this.stamps = [];
  }
}

function defaultSample(x: number, y: number, pressure: number): PointerSample {
  return { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0 };
}
