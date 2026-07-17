import { clamp, hsvToRgb, rgbToHsv, type RGB } from '../color/convert';
import type { HSV } from '../types';
import type { BrushSettings, ColorDynamics, DualBrush, DynamicControl } from './types';

/**
 * Pure per-stamp dynamics evaluation: turns brush settings + pen state into
 * concrete stamp parameters. Kept free of GPU/DOM so it is unit-testable.
 */

export interface PointerSample {
  x: number;
  y: number;
  /** 0..1 */
  pressure: number;
  /** degrees, -90..90 */
  tiltX: number;
  tiltY: number;
  /** stylus barrel rotation, 0..359 */
  twist: number;
}

export interface StampContext {
  sample: PointerSample;
  /** stroke travel direction at this point, radians */
  direction: number;
  /** direction at the start of the stroke, radians */
  initialDirection: number;
  /** spacing steps emitted so far in this stroke */
  stepIndex: number;
}

/** Floats per stamp instance, must match the stamp shader's vertex layout. */
export const STAMP_FLOATS = 11;
// layout: x, y, radius, alpha, angle(rad), roundness, r, g, b, flags, texDepthScale

export const FLAG_FLIP_X = 1;
export const FLAG_FLIP_Y = 2;

const TAU = Math.PI * 2;

/** Scalar control value in 0..1 for size/opacity/flow/roundness/etc. */
export function controlFactor(ctrl: DynamicControl, ctx: StampContext): number {
  switch (ctrl.source) {
    case 'off':
      return 1;
    case 'pressure':
      return clamp(ctx.sample.pressure, 0, 1);
    case 'fade':
      return clamp(1 - ctx.stepIndex / Math.max(1, ctrl.fadeSteps), 0, 1);
    case 'tilt':
      return clamp(Math.hypot(ctx.sample.tiltX, ctx.sample.tiltY) / 60, 0, 1);
    case 'rotation':
      return (((ctx.sample.twist % 360) + 360) % 360) / 360;
    case 'direction':
      return (((ctx.direction % TAU) + TAU) % TAU) / TAU;
    case 'initial-direction':
      return (((ctx.initialDirection % TAU) + TAU) % TAU) / TAU;
  }
}

/** Angle controls rotate the tip rather than scaling a value. */
function controlAngle(ctrl: DynamicControl, ctx: StampContext, base: number): number {
  switch (ctrl.source) {
    case 'off':
      return base;
    case 'direction':
      return base + ctx.direction;
    case 'initial-direction':
      return base + ctx.initialDirection;
    case 'rotation':
      return base + (ctx.sample.twist / 360) * TAU;
    case 'tilt':
      return base + Math.atan2(ctx.sample.tiltY, ctx.sample.tiltX);
    case 'pressure':
    case 'fade':
      return base + controlFactor(ctrl, ctx) * TAU;
  }
}

/** Control x jitter with a floor, Photoshop-style. */
function dynamicScale(
  ctrl: DynamicControl,
  jitter: number,
  minimum: number,
  ctx: StampContext,
  rng: () => number,
): number {
  let f = controlFactor(ctrl, ctx);
  if (jitter > 0) f *= 1 - jitter * rng();
  return clamp(Math.max(f, minimum), 0, 1);
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

/** Evaluates Color Dynamics for one stamp (or once per stroke). */
export function dynamicColor(
  cd: ColorDynamics,
  fg: HSV,
  bg: HSV,
  ctx: StampContext,
  rng: () => number,
): RGB {
  let t = 0;
  if (cd.fgBgJitter > 0) {
    // With a control, high control value keeps the foreground color;
    // without one, blend a random amount toward the background.
    const v = cd.fgBgControl.source === 'off' ? rng() : 1 - controlFactor(cd.fgBgControl, ctx);
    t = v * cd.fgBgJitter;
  }
  const base = lerpRgb(hsvToRgb(fg), hsvToRgb(bg), clamp(t, 0, 1));
  const hsv = rgbToHsv(base, fg.h);
  if (cd.hueJitter > 0) hsv.h += (rng() * 2 - 1) * cd.hueJitter * 180;
  if (cd.satJitter > 0) hsv.s = clamp(hsv.s * (1 + (rng() * 2 - 1) * cd.satJitter), 0, 1);
  if (cd.briJitter > 0) hsv.v = clamp(hsv.v * (1 + (rng() * 2 - 1) * cd.briJitter), 0, 1);
  if (cd.purity !== 0) hsv.s = clamp(hsv.s * (1 + cd.purity), 0, 1);
  return hsvToRgb(hsv);
}

/** Per-stamp deposition (flow) and opacity dynamics folded into stamp alpha. */
export function stampAlpha(
  s: BrushSettings,
  ctx: StampContext,
  rng: () => number,
): number {
  let a = s.flow;
  if (s.transfer.enabled) {
    a *= dynamicScale(s.transfer.flowControl, s.transfer.flowJitter, s.transfer.flowMin, ctx, rng);
    a *= dynamicScale(
      s.transfer.opacityControl,
      s.transfer.opacityJitter,
      s.transfer.opacityMin,
      ctx,
      rng,
    );
  }
  // options-bar override: always use pressure for opacity
  if (s.pressureOpacity) a *= clamp(ctx.sample.pressure, 0, 1);
  return clamp(a, 0, 1);
}

/** Effective diameter for this stamp (drives spacing too). */
export function stampDiameter(s: BrushSettings, ctx: StampContext, rng: () => number): number {
  let f = 1;
  if (s.shape.enabled) {
    f = dynamicScale(s.shape.sizeControl, s.shape.sizeJitter, s.shape.minDiameter, ctx, rng);
  }
  if (s.pressureSize) {
    // options-bar override: pressure scales size, honoring the minimum floor
    f *= Math.max(clamp(ctx.sample.pressure, 0, 1), s.shape.enabled ? s.shape.minDiameter : 0.02);
  }
  return Math.max(s.tip.size * f, 0.5);
}

export interface StampEmitOptions {
  /** fixed per-stroke color when Color Dynamics is off or not per-tip */
  strokeColor: RGB;
  fg: HSV;
  bg: HSV;
  rng: () => number;
}

/**
 * Emits the stamps for one spacing step (scatter/count included) into `out`
 * as STAMP_FLOATS-sized records.
 */
export function emitStamps(
  s: BrushSettings,
  ctx: StampContext,
  x: number,
  y: number,
  opts: StampEmitOptions,
  out: number[],
): void {
  const { rng } = opts;
  const sc = s.scatter;
  let count = 1;
  let scatterAmt = 0;
  if (sc.enabled) {
    count = Math.max(1, Math.round(sc.count * (1 - sc.countJitter * rng())));
    scatterAmt = sc.scatter * controlFactor(sc.scatterControl, ctx);
  }

  for (let i = 0; i < count; i++) {
    const diameter = stampDiameter(s, ctx, rng);
    const radius = diameter / 2;

    let sx = x;
    let sy = y;
    if (sc.enabled && scatterAmt > 0) {
      // Photoshop's Scatter spreads marks across scatter% x diameter in
      // total, so individual offsets reach +-scatter% x radius
      const dist = (rng() * 2 - 1) * scatterAmt * (diameter / 2);
      if (sc.bothAxes) {
        const a = rng() * TAU;
        sx += Math.cos(a) * dist;
        sy += Math.sin(a) * dist;
      } else {
        // across the stroke direction
        const n = ctx.direction + Math.PI / 2;
        sx += Math.cos(n) * dist;
        sy += Math.sin(n) * dist;
      }
    }

    // Photoshop's tip angle is counter-clockwise-positive on screen, while
    // the stamp rotation runs in y-down coordinates (clockwise-positive), so
    // the static angle flips sign here. Direction/rotation controls below
    // already produce y-down angles and stay as they are.
    let angle = (-s.tip.angle / 180) * Math.PI;
    let roundness = s.tip.roundness;
    let flipX = s.tip.flipX;
    let flipY = s.tip.flipY;
    if (s.shape.enabled) {
      angle = controlAngle(s.shape.angleControl, ctx, angle);
      if (s.shape.angleJitter > 0) angle += (rng() * 2 - 1) * Math.PI * s.shape.angleJitter;
      roundness *= dynamicScale(
        s.shape.roundnessControl,
        s.shape.roundnessJitter,
        s.shape.minRoundness,
        ctx,
        rng,
      );
      if (s.shape.flipXJitter && rng() < 0.5) flipX = !flipX;
      if (s.shape.flipYJitter && rng() < 0.5) flipY = !flipY;
    }
    roundness = clamp(roundness, 0.01, 1);

    const alpha = stampAlpha(s, ctx, rng);

    const color =
      s.color.enabled && s.color.applyPerTip
        ? dynamicColor(s.color, opts.fg, opts.bg, ctx, rng)
        : opts.strokeColor;

    let depthScale = 1;
    if (s.texture.enabled && s.texture.textureEachTip) {
      depthScale = dynamicScale(
        s.texture.depthControl,
        s.texture.depthJitter,
        0,
        ctx,
        rng,
      );
    }

    out.push(
      sx,
      sy,
      radius,
      alpha,
      angle,
      roundness,
      color.r,
      color.g,
      color.b,
      (flipX ? FLAG_FLIP_X : 0) + (flipY ? FLAG_FLIP_Y : 0),
      depthScale,
    );
  }
}

/**
 * Emits the secondary (Dual Brush) stamps for one of its spacing steps. The
 * dual tip runs its own train along the stroke — full-coverage stamps with
 * their own scatter and count — accumulated into a separate mask that gates
 * the primary stroke.
 */
export function emitDualStamps(
  dual: DualBrush,
  ctx: StampContext,
  x: number,
  y: number,
  rng: () => number,
  out: number[],
): void {
  let count = dual.count;
  if (dual.countJitter > 0) {
    count = Math.max(1, Math.round(count * (1 - dual.countJitter * rng())));
  }
  for (let i = 0; i < count; i++) {
    let sx = x;
    let sy = y;
    if (dual.scatter > 0) {
      // +-scatter% x radius, as for the primary tip's Scatter above; keeping
      // offsets within the dual tip's radius is what lets a scattered train
      // (e.g. 86% scatter) still lay contiguous ink along the stroke spine
      const dist = (rng() * 2 - 1) * dual.scatter * (dual.size / 2);
      if (dual.bothAxes) {
        const a = rng() * TAU;
        sx += Math.cos(a) * dist;
        sy += Math.sin(a) * dist;
      } else {
        const n = ctx.direction + Math.PI / 2;
        sx += Math.cos(n) * dist;
        sy += Math.sin(n) * dist;
      }
    }
    let flags = 0;
    if (dual.flip) {
      if (rng() < 0.5) flags += FLAG_FLIP_X;
      if (rng() < 0.5) flags += FLAG_FLIP_Y;
    }
    out.push(sx, sy, dual.size / 2, 1, 0, 1, 1, 1, 1, flags, 1);
  }
}
