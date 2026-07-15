# Northlight

A Photoshop-style digital painting app built with **TypeScript + React** on a
**WebGPU** canvas. Every visible pixel is composited on the GPU.

```bash
npm install
npm run dev        # start the dev server
npm run build      # typecheck + production build
```

Requires a browser with WebGPU (Chrome/Edge 113+, recent Safari or Firefox).
Document size defaults to 1600x1000; override with `?w=2048&h=1536` in the URL.

## Features

### Layers & compositing
- Unlimited layers (add, duplicate, delete, reorder, rename, hide, per-layer
  opacity), each stored as a GPU texture with premultiplied alpha.
- 23 Photoshop blend modes (Multiply, Screen, Overlay, Soft/Hard/Vivid/Linear
  /Pin Light, Color Dodge/Burn, Linear Dodge/Burn, Difference, Exclusion,
  Subtract, Divide, Hue, Saturation, Color, Luminosity, ...) implemented from
  the PDF/ISO 32000 formulas that Photoshop follows, evaluated in a ping-pong
  GPU compositor. Math runs on non-linear sRGB, matching Photoshop's 8-bit
  default.

### Brush engine (Photoshop-parity)
The **Brush Settings** panel (right sidebar tab) mirrors Photoshop's
sections, all evaluated per stamp:

- **Brush Tip Shape** — tip (Round analytic, plus sampled Chalk / Spatter /
  Grain tips), size, hardness, **angle**, **roundness** (rotated elliptical
  stamps), spacing, flip X/Y. The soft falloff is a Gaussian profile rescaled
  to reach exactly zero at the brush radius (the closest published fit to
  Photoshop's measured soft round); 100% hardness keeps the ~1px anti-aliased
  rim. Adobe does not publish the exact curve, so "exact" means
  indistinguishable in normal use.
- **Shape Dynamics** — size/angle/roundness jitter, each with a Photoshop
  **Control** source (Off / Fade / Pen Pressure / Pen Tilt / Rotation /
  Direction / Initial Direction where applicable), **Minimum Diameter**,
  **Minimum Roundness**, and flip X/Y jitter.
- **Scattering** — scatter % (across-stroke or both axes) with control,
  **Count** (multiple stamps per step) and **Count Jitter**.
- **Texture** — five procedural tileable patterns (Paper, Canvas, Sponge,
  Clouds, Speckle) with scale, brightness, contrast, invert, five combine
  modes (Multiply/Subtract/Darken/Overlay/Height), **Depth**, and **Texture
  Each Tip** with depth jitter + control (per-stamp) vs. whole-stroke
  texturing (Photoshop's default), applied at commit time.
- **Dual Brush** — a secondary tip (with its own mode, size, spacing,
  scatter, both-axes, count) gates the primary coverage, pre-baked into a
  tileable modulation map.
- **Color Dynamics** — foreground/background jitter (with control), hue,
  saturation and brightness jitter, purity, per-tip or per-stroke. Stroke
  accumulation is full-color, so every dab can have its own color.
- **Transfer** — opacity and flow jitter, each with a control source and a
  **Minimum**, on top of the options-bar values.
- **Tip toggles** — **Noise** (grain in the soft falloff band), **Wet Edges**
  (watercolor-style rim build-up), **Build-up** (airbrush: keeps depositing
  while the pointer is held still), **Smoothing**.

Flow deposits per stamp and builds up within a stroke; Opacity caps the whole
stroke (one 50% stroke never self-darkens) — coverage accumulates in a
separate color stroke texture that is composited live and baked on
pointer-up. Spacing is distance-based and re-evaluated per stamp, so
pressure-driven size changes stamp density correctly. The **eraser** shares
the whole engine and erases layer alpha.

### Brush presets
The **Brushes** panel (sidebar tab) has a grouped, Photoshop-style preset
library with live stroke previews (rendered by the real dynamics evaluator):
General, **Size Flow** (pressure→size), **Opacity Flow** (pressure→opacity),
Dry Media (a **Graphite Pencil** with scatter/multi-stamp roughness, pressure
opacity, 50% minimum size; Charcoal; Chalk), Wet Media (a **Sponge** using
the sponge pattern texture plus a spatter dual brush; Watercolor with wet
edges; Ink Wash), and Special Effects (spatter spray, scattered dots, color
confetti).

### Options bar (Photoshop layout)
Brush tip picker (size/hardness/angle/roundness popover), **Mode** (the
stroke's paint blending mode — all 23 layer blend modes work for painting
too), **Opacity** with an always-use-pressure toggle, **Flow** with the
airbrush toggle, **Smoothing**, and the pressure-controls-size button.

### Pen tablet support
- Pointer Events with coalesced samples for full-rate tablet input; pressure,
  tilt (X/Y) and barrel rotation feed the dynamics controls.
- Any dynamic can map to pen input with a minimum floor (e.g. pressure→size
  with Minimum Diameter 50% for the pencil preset). The options-bar pen
  buttons override Shape Dynamics/Transfer, like Photoshop's.
- Mouse input is treated as full pressure.

### Selections
- **Rectangular marquee**, **freehand lasso**, and **polygonal lasso**
  (click to add points; click the first point / double-click / Enter to
  close, Esc to cancel).
- Selections render as animated marching ants and **clip all painting** (the
  mask multiplies brush coverage on the GPU, with anti-aliased edges).
- `Ctrl+A` select all, `Ctrl+D` deselect.

### Color
- Photoshop-style picker (sidebar tab): saturation/brightness square + hue
  slider.
- Numeric editing in **HSB**, **RGB**, and **Lab** (CIE Lab, D50 with
  Bradford adaptation — same setup as Photoshop/CSS; out-of-gamut Lab values
  clamp to sRGB), plus hex input and foreground/background swatches
  (`X` swap, `D` reset).

### Navigation & workflow
- Pan tool (or hold **Space**), zoom tool (click / Alt-click / scrubby drag),
  wheel zoom around the cursor, `Ctrl+0` fit, `Ctrl+1` 100%.
- Undo/redo for strokes (`Ctrl+Z` / `Ctrl+Shift+Z`), flattened PNG export,
  transparency checkerboard, live brush-outline cursor.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| B / E | Brush / Eraser |
| M / L / P | Marquee / Lasso / Polygonal lasso |
| H / Z / Space | Hand / Zoom / temporary pan |
| [ / ] | Decrease / increase brush size |
| Shift+[ / Shift+] | Hardness −25% / +25% |
| 1…0 | Brush opacity (5 → 50%, 45 typed quickly → 45%, 0 → 100%) |
| Shift+1…0 | Brush flow (swapped with opacity while airbrush is on) |
| X / D | Swap / reset colors |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+A / Ctrl+D | Select all / Deselect |
| Ctrl+0 / Ctrl+1 | Fit view / 100% |

## Architecture

```
src/
  brush/
    types.ts       full Photoshop-style brush settings model
    defaults.ts    defaults + preset deep-merge
    dynamics.ts    pure per-stamp evaluation (controls, jitters, scatter,
                   color dynamics, transfer) — unit-testable
    patterns.ts    procedural tileable patterns, sampled tips, dual-brush
                   tiles (seeded, deterministic)
    presets.ts     grouped preset library
    engineParams.ts settings -> per-stroke GPU parameters
  gpu/
    shaders.ts    WGSL: compositor (all blend modes), brush stamp (rotated
                  elliptical/sampled tips, texture, dual brush, noise),
                  stroke merge/commit (paint modes, wet edges), present pass
    engine.ts     PaintEngine: device/textures/pipelines, layer manager,
                  stroke accumulation, undo history (CPU snapshots), export
    stroke.ts     StrokeSession: spacing, pen-state interpolation, smoothing,
                  direction tracking, airbrush build-up
    selection.ts  polygon -> anti-aliased coverage mask
  color/convert.ts  HSV / RGB / hex / CIE Lab conversions
  store.ts        zustand app state (tools, brushes, layers, view, selection)
  controller.ts   actions that touch both the store and the GPU engine
  ui/             React components (canvas + overlay, toolbar, options bar,
                  Color/Brushes/Brush Settings tabs, layers panel)
```

Strokes render as instanced quads (position, radius, alpha, angle, roundness,
color, flips, texture depth per stamp) into a premultiplied RGBA stroke
texture with OVER accumulation; the compositor merges that texture into the
active layer live (so previews respect the paint mode, opacity, wet edges and
whole-stroke texture), and pointer-up bakes it into the layer texture. Layer
compositing ping-pongs between two accumulation textures, one pass per layer,
then a present pass applies the viewport transform (nearest-neighbor sampling
when zoomed in past 200%).

## Testing

`tests/gpu.spec.mjs` drives the real engine in a browser against offscreen
textures and asserts pixels (65 tests): brush falloff values, rotated
elliptical tips, flow buildup vs. the opacity cap, paint blend modes, wet
edges, per-stamp color, texture / texture-each-tip / dual-brush modulation,
noise, eraser, selection clipping, undo/redo, pressure dynamics with
minimums, airbrush build-up, the pure dynamics module, pattern/preset
integrity, the viewport pass, Lab/HSV conversions, and the Photoshop numeric
keyboard shortcuts.

```bash
npm run build
npx vite preview --port 4173 &
npm i --no-save playwright
node tests/gpu.spec.mjs
```

Headless note: some SwiftShader-backed Chromium builds have a broken GPU
process (uploads or canvas presentation fail with "A valid external Instance
reference no longer exists"). The engine sidesteps the upload half by using
mappedAtCreation staging buffers instead of `queue.write*`, and the tests
avoid the presentation half by rendering offscreen. On real hardware none of
this matters.

## Known limitations

- Undo history covers paint/erase strokes (24 steps), not layer operations.
- One selection at a time (no add/subtract combining yet).
- No document resizing/cropping UI; set size via URL params.
