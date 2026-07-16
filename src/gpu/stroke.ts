import type { PaintEngine } from './engine';
import type { BrushSettings } from '../brush/types';
import {
  dynamicColor,
  emitDualStamps,
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
  /** total path length walked so far (drives the dual train positions) */
  private pathDist = 0;
  /** path distance at which the next dual mask stamp is due */
  private dualNext = 0;
  /**
   * Pending stamp batches in emission order. Order matters for the dual
   * brush: a primary dab is gated by the dual mask as it exists when the
   * dab is drawn, so each segment's mask stamps render before its dabs.
   */
  private queue: { target: 'primary' | 'dual'; records: number[] }[] = [];
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

  /** Batch records for `target`, merging with the queue tail when possible. */
  private queueFor(target: 'primary' | 'dual'): number[] {
    const tail = this.queue[this.queue.length - 1];
    if (tail && tail.target === target) return tail.records;
    const batch = { target, records: [] as number[] };
    this.queue.push(batch);
    return batch.records;
  }

  private emit(x: number, y: number, sample: PointerSample): void {
    emitStamps(
      this.settings,
      this.contextAt(sample),
      x,
      y,
      { strokeColor: this.strokeColor, fg: this.fg, bg: this.bg, rng: this.rng },
      this.queueFor('primary'),
    );
  }

  private emitDual(x: number, y: number, sample: PointerSample): void {
    const dual = this.settings.dual;
    if (!dual.enabled) return;
    emitDualStamps(dual, this.contextAt(sample), x, y, this.rng, this.queueFor('dual'));
  }

  /** Spacing distance for the current pen state (control-scaled, no jitter). */
  private spacingPx(sample: PointerSample): number {
    const d = stampDiameter(this.settings, this.contextAt(sample), zeroRng);
    return Math.max(this.settings.tip.spacing * d, 0.5);
  }

  private dualSpacingPx(): number {
    const dual = this.settings.dual;
    return Math.max(dual.spacing * dual.size, 0.5);
  }

  down(sample: PointerSample): void {
    this.last = sample;
    this.smoothed = sample;
    this.residual = 0;
    this.stepIndex = 0;
    this.pathDist = 0;
    // dual mask first so the very first dab is gated by it; the train's
    // next stamp fires ahead of the pen once a direction exists
    this.emitDual(sample.x, sample.y, sample);
    this.dualNext = this.dualSpacingPx();
    this.emit(sample.x, sample.y, sample);
    this.flush();

    if (this.settings.airbrush) {
      // Build-up: keep depositing while the pointer is held, Photoshop-style.
      this.airbrushTimer = setInterval(() => {
        const at = this.smoothed;
        if (!at) return;
        this.stepIndex++;
        // build-up dabs reuse the existing dual mask; the train only
        // advances with pen travel
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
    this.queue = [];
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

    // The dual mask train runs AHEAD of the pen: a dab at position p paints
    // fragments up to p + primaryRadius, and every fragment is gated by the
    // mask as it exists when the dab is drawn — so the stamp covering those
    // fragments must already be down. Firing each stamp once the pen is
    // within (primaryRadius + dualRadius) of its train position (stamps
    // beyond the walked path are extrapolated along the current direction)
    // keeps painting continuous when the mask stamps abut (spacing <= 100%)
    // and incremental — later stamps still never reveal old dabs. This is
    // how Photoshop's dual texture fills in smoothly under the brush.
    if (this.settings.dual.enabled) {
      const dual = this.settings.dual;
      const lookahead = (this.settings.tip.size + dual.size) / 2;
      const end = this.pathDist + dist;
      const step = this.dualSpacingPx();
      for (let guard = 0; guard < 10000 && this.dualNext <= end + lookahead; guard++) {
        const t = this.dualNext;
        this.dualNext += step;
        if (t <= end) {
          const at = lerpSample((t - this.pathDist) / dist);
          this.emitDual(at.x, at.y, at);
        } else {
          const ahead = t - end;
          this.emitDual(
            b.x + Math.cos(this.direction) * ahead,
            b.y + Math.sin(this.direction) * ahead,
            b,
          );
        }
      }
    }

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

    this.pathDist += dist;
  }

  private flush(): void {
    // Batches draw in path order (see `queue`), which is what makes per-dab
    // dual gating behave like Photoshop.
    for (const batch of this.queue) {
      if (batch.records.length === 0) continue;
      const arr = new Float32Array(batch.records);
      this.engine.drawStamps(arr, arr.length / STAMP_FLOATS, batch.target);
    }
    this.queue = [];
  }
}

function defaultSample(x: number, y: number, pressure: number): PointerSample {
  return { x, y, pressure, tiltX: 0, tiltY: 0, twist: 0 };
}
