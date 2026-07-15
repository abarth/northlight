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

### Brushes
- **Soft Round**, **Hard Round**, and **Round** (custom hardness) tips.
- The soft falloff is a Gaussian profile rescaled to reach exactly zero at the
  brush radius (the closest published fit to Photoshop's measured soft-round
  profile); hardness sets the solid core, and 100% hardness keeps Photoshop's
  ~1px anti-aliased rim. Adobe does not publish the exact curve, so "exact"
  here means indistinguishable in normal use.
- Settings: **size, hardness, opacity, flow, spacing, smoothing**.
  - *Flow* deposits per stamp and builds up within a stroke;
  - *Opacity* caps the whole stroke (one 50%-opacity stroke never
    self-darkens, exactly like Photoshop) — implemented by accumulating stroke
    coverage in a separate GPU texture that is composited live and baked on
    pointer-up.
  - *Spacing* is distance-based (% of diameter) and re-evaluated per stamp, so
    pressure-driven size changes affect stamp density correctly.
- **Eraser** with the same tip/settings system, erasing layer alpha.

### Pen tablet support
- Pointer Events with coalesced samples for full-rate tablet input.
- Pressure can be linked per-brush to **Size**, **Opacity**, and **Flow**
  (toggles in the options bar). Mouse input is treated as full pressure.

### Selections
- **Rectangular marquee**, **freehand lasso**, and **polygonal lasso**
  (click to add points; click the first point / double-click / Enter to
  close, Esc to cancel).
- Selections render as animated marching ants and **clip all painting** (the
  mask multiplies brush coverage on the GPU, with anti-aliased edges).
- `Ctrl+A` select all, `Ctrl+D` deselect.

### Color
- Photoshop-style picker: saturation/brightness square + hue slider.
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
| X / D | Swap / reset colors |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+A / Ctrl+D | Select all / Deselect |
| Ctrl+0 / Ctrl+1 | Fit view / 100% |

## Architecture

```
src/
  gpu/
    shaders.ts    WGSL: compositor (all blend modes), brush stamp, stroke
                  commit, present pass (viewport + checkerboard)
    engine.ts     PaintEngine: device/textures/pipelines, layer manager,
                  stroke accumulation, undo history (CPU snapshots), export
    stroke.ts     StrokeSession: spacing, pressure interpolation, smoothing
    selection.ts  polygon -> anti-aliased coverage mask
  color/convert.ts  HSV / RGB / hex / CIE Lab conversions
  store.ts        zustand app state (tools, brushes, layers, view, selection)
  controller.ts   actions that touch both the store and the GPU engine
  ui/             React components (canvas + overlay, toolbar, panels)
```

Strokes render as instanced quads into a single-channel coverage texture with
OVER accumulation; the compositor merges that texture into the active layer
live (so previews respect blend modes and opacity), and pointer-up bakes it
into the layer texture. Layer compositing ping-pongs between two accumulation
textures, one pass per layer, then a present pass applies the viewport
transform (nearest-neighbor sampling when zoomed in past 200%).

## Testing

`tests/gpu.spec.mjs` drives the real engine in a browser against offscreen
textures and asserts pixels: brush falloff values, flow buildup vs. the
opacity cap, blend-mode math, eraser, selection clipping, undo/redo, pressure
dynamics, the viewport pass, and Lab/HSV conversions.

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
