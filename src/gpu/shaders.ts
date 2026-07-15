/**
 * All WGSL shaders. Layer/accumulation textures store PREMULTIPLIED alpha.
 * Compositing math runs on non-linear sRGB values, matching Photoshop's
 * default (8-bit, "Blend RGB Colors Using Gamma" off).
 */

export const FULLSCREEN_VS = /* wgsl */ `
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = p[vi] * vec2f(0.5, -0.5) + vec2f(0.5, 0.5);
  return out;
}
`;

/**
 * Blend-mode library, following the PDF/ISO 32000 formulas that Photoshop
 * implements. b = backdrop, s = source, both straight (un-premultiplied).
 */
const BLEND_LIB = /* wgsl */ `
fn scr(b: vec3f, s: vec3f) -> vec3f {
  return b + s - b * s;
}

fn hardLight(b: vec3f, s: vec3f) -> vec3f {
  return select(scr(b, 2.0 * s - 1.0), b * (2.0 * s), s <= vec3f(0.5));
}

fn dodgeC(b: f32, s: f32) -> f32 {
  if (b <= 0.0) { return 0.0; }
  if (s >= 1.0) { return 1.0; }
  return min(1.0, b / (1.0 - s));
}

fn burnC(b: f32, s: f32) -> f32 {
  if (b >= 1.0) { return 1.0; }
  if (s <= 0.0) { return 0.0; }
  return 1.0 - min(1.0, (1.0 - b) / s);
}

fn colorDodge(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(dodgeC(b.x, s.x), dodgeC(b.y, s.y), dodgeC(b.z, s.z));
}

fn colorBurn(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(burnC(b.x, s.x), burnC(b.y, s.y), burnC(b.z, s.z));
}

fn softLightC(b: f32, s: f32) -> f32 {
  if (s <= 0.5) {
    return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  }
  var d: f32;
  if (b <= 0.25) {
    d = ((16.0 * b - 12.0) * b + 4.0) * b;
  } else {
    d = sqrt(b);
  }
  return b + (2.0 * s - 1.0) * (d - b);
}

fn softLight(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(softLightC(b.x, s.x), softLightC(b.y, s.y), softLightC(b.z, s.z));
}

fn vividC(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return burnC(b, 2.0 * s); }
  return dodgeC(b, 2.0 * s - 1.0);
}

fn vividLight(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(vividC(b.x, s.x), vividC(b.y, s.y), vividC(b.z, s.z));
}

fn pinC(b: f32, s: f32) -> f32 {
  if (s <= 0.5) { return min(b, 2.0 * s); }
  return max(b, 2.0 * s - 1.0);
}

fn pinLight(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(pinC(b.x, s.x), pinC(b.y, s.y), pinC(b.z, s.z));
}

fn divideBlend(b: vec3f, s: vec3f) -> vec3f {
  return vec3f(
    select(min(1.0, b.x / s.x), 1.0, s.x <= 0.0),
    select(min(1.0, b.y / s.y), 1.0, s.y <= 0.0),
    select(min(1.0, b.z / s.z), 1.0, s.z <= 0.0),
  );
}

// --- non-separable modes (hue / saturation / color / luminosity) ---

fn lum(c: vec3f) -> f32 {
  return dot(c, vec3f(0.3, 0.59, 0.11));
}

fn clipColor(c0: vec3f) -> vec3f {
  var c = c0;
  let l = lum(c);
  let n = min(c.x, min(c.y, c.z));
  let x = max(c.x, max(c.y, c.z));
  if (n < 0.0) {
    c = vec3f(l) + (c - vec3f(l)) * l / max(l - n, 1e-6);
  }
  if (x > 1.0) {
    c = vec3f(l) + (c - vec3f(l)) * (1.0 - l) / max(x - l, 1e-6);
  }
  return c;
}

fn setLum(c: vec3f, l: f32) -> vec3f {
  return clipColor(c + vec3f(l - lum(c)));
}

fn satOf(c: vec3f) -> f32 {
  return max(c.x, max(c.y, c.z)) - min(c.x, min(c.y, c.z));
}

fn setSat(c: vec3f, s: f32) -> vec3f {
  let mn = min(c.x, min(c.y, c.z));
  let mx = max(c.x, max(c.y, c.z));
  if (mx > mn) {
    return (c - vec3f(mn)) * s / (mx - mn);
  }
  return vec3f(0.0);
}

fn blendPixel(mode: u32, b: vec3f, s: vec3f) -> vec3f {
  switch (mode) {
    case 0u: { return s; }                                          // normal
    case 1u: { return min(b, s); }                                  // darken
    case 2u: { return b * s; }                                      // multiply
    case 3u: { return colorBurn(b, s); }
    case 4u: { return clamp(b + s - 1.0, vec3f(0.0), vec3f(1.0)); } // linear burn
    case 5u: { return max(b, s); }                                  // lighten
    case 6u: { return scr(b, s); }                                  // screen
    case 7u: { return colorDodge(b, s); }
    case 8u: { return min(b + s, vec3f(1.0)); }                     // linear dodge
    case 9u: { return hardLight(s, b); }                            // overlay
    case 10u: { return softLight(b, s); }
    case 11u: { return hardLight(b, s); }
    case 12u: { return vividLight(b, s); }
    case 13u: { return clamp(b + 2.0 * s - 1.0, vec3f(0.0), vec3f(1.0)); } // linear light
    case 14u: { return pinLight(b, s); }
    case 15u: { return abs(b - s); }                                // difference
    case 16u: { return b + s - 2.0 * b * s; }                       // exclusion
    case 17u: { return max(b - s, vec3f(0.0)); }                    // subtract
    case 18u: { return divideBlend(b, s); }
    case 19u: { return setLum(setSat(s, satOf(b)), lum(b)); }       // hue
    case 20u: { return setLum(setSat(b, satOf(s)), lum(b)); }       // saturation
    case 21u: { return setLum(s, lum(b)); }                         // color
    case 22u: { return setLum(b, lum(s)); }                         // luminosity
    default: { return s; }
  }
}
`;

/**
 * Composites one layer over the accumulated backdrop. The in-progress stroke
 * (brush or eraser) is merged into the active layer on the fly so painting
 * previews live under the correct blend mode / opacity.
 */
export const COMPOSITE_SHADER = /* wgsl */ `
${FULLSCREEN_VS}
${BLEND_LIB}

struct LayerU {
  blendMode: u32,
  layerOpacity: f32,
  strokeMode: u32,     // 0 = none, 1 = paint, 2 = erase
  strokeOpacity: f32,
  strokeColor: vec4f,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var accumTex: texture_2d<f32>;
@group(0) @binding(2) var layerTex: texture_2d<f32>;
@group(0) @binding(3) var strokeTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> U: LayerU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let dst = textureSampleLevel(accumTex, samp, in.uv, 0.0); // premultiplied backdrop
  var l = textureSampleLevel(layerTex, samp, in.uv, 0.0);   // premultiplied layer
  let m = textureSampleLevel(strokeTex, samp, in.uv, 0.0).r * U.strokeOpacity;

  if (U.strokeMode == 1u) {
    let sp = U.strokeColor.rgb * m;
    l = vec4f(sp + l.rgb * (1.0 - m), m + l.a * (1.0 - m));
  } else if (U.strokeMode == 2u) {
    l = l * (1.0 - m);
  }

  let as_ = l.a * U.layerOpacity;
  let ab = dst.a;
  var cs = vec3f(0.0);
  if (l.a > 0.0) { cs = l.rgb / l.a; }
  var cb = vec3f(0.0);
  if (ab > 0.0) { cb = dst.rgb / ab; }

  let bl = blendPixel(U.blendMode, cb, cs);
  // PDF compositing formula, emitted premultiplied:
  let co = as_ * (1.0 - ab) * cs + as_ * ab * bl + (1.0 - as_) * dst.rgb;
  let ao = as_ + ab * (1.0 - as_);
  return vec4f(co, ao);
}
`;

/**
 * Brush stamp: an instanced quad per dab, accumulated into the stroke
 * coverage texture (r8unorm) with OVER blending so flow builds up where
 * stamps overlap but saturates at 1.
 *
 * Tip profile: solid core of radius `hardness`, then a Gaussian falloff
 * rescaled to reach exactly 0 at the brush radius — this matches measured
 * Photoshop soft-round profiles. Hardness 100% keeps a ~1.6px anti-aliased
 * rim, as Photoshop does.
 */
export const STAMP_SHADER = /* wgsl */ `
struct StampU {
  docSize: vec2f,
  hardness: f32,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> SU: StampU;
@group(0) @binding(1) var selTex: texture_2d<f32>;
@group(0) @binding(2) var selSamp: sampler;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,   // position in units of the stamp radius
  @location(1) docUv: vec2f,
  @location(2) alpha: f32,
  @location(3) radius: f32,
}

@vertex
fn vs(
  @builtin(vertex_index) vi: u32,
  @location(0) center: vec2f,
  @location(1) radius: f32,
  @location(2) alpha: f32,
) -> VSOut {
  var corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi];
  let pad = radius + 1.0; // 1px apron for the anti-aliased rim
  let doc = center + c * pad;
  var out: VSOut;
  out.local = c * pad / max(radius, 1e-4);
  out.docUv = doc / SU.docSize;
  var ndc = doc / SU.docSize * 2.0 - 1.0;
  ndc.y = -ndc.y;
  out.pos = vec4f(ndc, 0.0, 1.0);
  out.alpha = alpha;
  out.radius = radius;
  return out;
}

fn tipProfile(r: f32, hardness: f32, radiusPx: f32) -> f32 {
  if (r >= 1.0) { return 0.0; }
  // Keep at least ~1.6 physical pixels of falloff so hard brushes stay
  // anti-aliased (Photoshop's 100%-hardness tip has the same soft rim).
  let h = min(hardness, max(0.0, 1.0 - 1.6 / max(radiusPx, 1.6)));
  if (r <= h) { return 1.0; }
  let t = (r - h) / (1.0 - h);
  // Gaussian falloff rescaled to hit zero at the radius. k = ln(50) puts the
  // unscaled tail at 2% — the closest published fit to Photoshop's soft round.
  let k = 3.912;
  return (exp(-k * t * t) - exp(-k)) / (1.0 - exp(-k));
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  var a = tipProfile(length(in.local), SU.hardness, in.radius) * in.alpha;
  a = a * textureSampleLevel(selTex, selSamp, in.docUv, 0.0).r;
  return vec4f(a, 0.0, 0.0, a);
}
`;

/**
 * Bakes the finished stroke into the layer (rendered into a scratch texture,
 * then copied back). Mode 1 = paint over, mode 2 = erase.
 */
export const COMMIT_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct CommitU {
  mode: u32,
  opacity: f32,
  _pad: vec2f,
  color: vec4f,
}

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var strokeTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: CommitU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let l = textureSampleLevel(layerTex, samp, in.uv, 0.0);
  let m = textureSampleLevel(strokeTex, samp, in.uv, 0.0).r * U.opacity;
  if (U.mode == 2u) {
    return l * (1.0 - m);
  }
  let sp = U.color.rgb * m;
  return vec4f(sp + l.rgb * (1.0 - m), m + l.a * (1.0 - m));
}
`;

/**
 * Final present pass: applies the viewport transform, draws the transparency
 * checkerboard under the document and the pasteboard around it.
 */
export const PRESENT_SHADER = /* wgsl */ `
${FULLSCREEN_VS}

struct ViewU {
  viewSize: vec2f,
  docSize: vec2f,
  offset: vec2f,
  zoom: f32,
  nearest: f32,
  checker: f32,
  _pad: vec3f,
}

@group(0) @binding(0) var sampLinear: sampler;
@group(0) @binding(1) var sampNearest: sampler;
@group(0) @binding(2) var accumTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: ViewU;

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let screen = in.uv * U.viewSize;
  let doc = (screen - U.offset) / U.zoom;
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x >= U.docSize.x || doc.y >= U.docSize.y) {
    return vec4f(0.118, 0.118, 0.125, 1.0); // pasteboard
  }
  let uv = doc / U.docSize;
  let cLin = textureSampleLevel(accumTex, sampLinear, uv, 0.0);
  let cNear = textureSampleLevel(accumTex, sampNearest, uv, 0.0);
  let c = select(cLin, cNear, U.nearest > 0.5);
  // screen-fixed transparency checkerboard
  let cell = floor(screen / U.checker);
  let odd = (cell.x + cell.y) - 2.0 * floor((cell.x + cell.y) / 2.0);
  let check = select(0.78, 0.62, odd > 0.5);
  return vec4f(c.rgb + vec3f(check) * (1.0 - c.a), 1.0);
}
`;
