# Northlight

[![CI](https://github.com/abarth/northlight/actions/workflows/ci.yml/badge.svg)](https://github.com/abarth/northlight/actions/workflows/ci.yml)
[![Deploy](https://github.com/abarth/northlight/actions/workflows/deploy-pages.yml/badge.svg)](https://github.com/abarth/northlight/actions/workflows/deploy-pages.yml)

A Photoshop-style digital painting app built with **TypeScript + React** on a
**WebGPU** canvas. Every visible pixel is composited on the GPU.

**Try it live: <https://abarth.github.io/northlight/>** (deployed from `prod`
via GitHub Pages once CI passes; day-to-day development happens on `main`, and
merging `main` into `prod` ships a release).

```bash
npm install
npm run dev        # start the dev server
npm run build      # typecheck + production build
npm test           # run the GPU test suite against the build
```

Requires a browser with WebGPU (Chrome/Edge 113+, recent Safari or Firefox).
Document size defaults to 1600x1000; override with `?w=2048&h=1536` in the URL.

## Features

### Layers & compositing
- Unlimited layers (add, duplicate, delete, reorder, rename, hide, per-layer
  opacity), each stored as a GPU texture with premultiplied alpha.
- **Layer groups** with a Photoshop-style panel: nested folders with
  collapse/expand, drag layers into/out of groups, group visibility and
  opacity apply to everything inside (pass-through blending).
- **Locks**, like Photoshop's Lock row: transparent pixels (`/`), image
  pixels, position, and lock-all — enforced in the paint/fill/transform
  pipeline (Lock Transparent Pixels confines strokes and fills to existing
  coverage on the GPU) and inherited from enclosing groups.
- The full **Layer menu**: New (Layer / Group / Layer Via Copy `Ctrl+J` /
  Layer Via Cut `Shift+Ctrl+J`), Duplicate, Delete (Layer / Hidden Layers),
  Rename, Group `Ctrl+G` / Ungroup `Shift+Ctrl+G`, Hide `Ctrl+,`, Arrange
  (`Ctrl+[` / `Ctrl+]`, `Shift` jumps to front/back), per-lock toggles,
  **Merge Down** `Ctrl+E` (merges a selected group), **Merge Visible**
  `Shift+Ctrl+E`, and **Flatten Image**.
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
- **Dual Brush** — a true secondary brush, like Photoshop's: the second tip
  (any shape, with hardness, mode, size, spacing, scatter, both-axes, count)
  stamps its own train along the stroke into a separate GPU coverage mask.
  The mask train runs **ahead of the pen** (by primary + dual radius,
  extrapolated along the stroke direction) and every primary dab is gated by
  the mask as it exists at stamp time — so painting fills in smoothly under
  the brush, strokes are continuous whenever the mask stamps abut (spacing
  ≤ 100%), coverage gaps are purely geometric, and finished areas never
  change retroactively. The dual tip also scales proportionally when the
  primary size changes, like Photoshop.
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

### Bristle brush (experimental track engine)
A second, digital-first mark engine that lives alongside the stamp model
(enable it at the top of Brush Settings; see `docs/bristle-brush.md` for the
design). The brush is a 3D filbert-shaped tuft of up to 256 bristles:

- **Pressure** sets how deep the tuft presses into the canvas — the contact
  footprint grows from the center of the filbert outward, with **splay**
  spreading the contacted bristles. **Tilt** paints with the side of the
  tuft (the footprint slides and elongates toward the lean), and **barrel
  rotation** (or a fixed base angle) turns the filbert's flat.
- Each contacted bristle drags its own **pigment track** (no stamps): a
  per-bristle color (hue/sat/brightness jitter, optional fg→bg mix), a
  per-bristle opacity, and a paint **load** that depletes with travel so
  strokes run dry along the gesture ("reload on lift" off keeps the tuft
  drying across strokes until it's re-dipped).
- **Breakup** gates deposition with coherent per-bristle noise along each
  track — streaks die and catch again, the dry-brush signature — and canvas
  **tooth** (any texture pattern) carves dry bristles harder than loaded
  ones via the per-segment texture depth.
- The brush cursor shows the analytic footprint before the pen lands: the
  full-pressure outline (dashed), the light-touch outline (solid), and the
  flat's orientation, all following live pen tilt/twist.

Tracks render as stretched analytic stamps through the same GPU stroke
pipeline (options-bar opacity/blend mode apply), so selections, locks, undo
and layer compositing all work unchanged.

### Photoshop ABR import
The Brushes panel's **Import ABR…** button loads Photoshop brush files:
legacy v1/v2 and modern v6–v10 (8BIM `samp` tips, Actions-descriptor `desc`,
and `patt` texture patterns), including PackBits-compressed and 16-bit tips.

- **Sampled tips** become first-class brush tips, usable as the primary and
  the dual-brush tip (UUIDs are matched exactly, by 35-char truncated
  prefix, or by order — real files use all three).
- **Texture patterns** (grayscale and RGB→luminance VirtualMemoryArrayList
  images) are imported and selectable in the Texture pattern dropdown.
- **Settings** map onto the engine: name, diameter, spacing, angle,
  roundness, hardness, flips, Shape Dynamics (controls incl.
  Direction/Initial Direction/Rotation, jitters, minimums), Scattering,
  Texture (scale/brightness/contrast/invert/mode/depth/each-tip/depth
  dynamics), Dual Brush (tip, mode, spacing, scatter, count, count jitter,
  flip), Transfer, Color Dynamics, wet edges, noise, airbrush, and the
  options-bar state (opacity, flow, smoothing, paint Mode, and the
  pressure-override buttons).

The descriptor schema was validated against real ABR files from public
GitHub repositories (spray brushes from MaousamaQAQ/Nopressure and five
brush packs from igdiaysu/Photoshop, v6.2 and v10.2 — 288 brushes, 253
tips, 33 patterns parsed with zero unresolved references) and cross-checked
against GIMP's loader, SonyStone/ABR-Viewer, and jlai/brush-viewer; see
`src/brush/abr.ts` and the test suite for the details and URLs.

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
- Boolean combinations like Photoshop: **Shift** adds, **Alt** subtracts,
  **Shift+Alt** intersects (or pick the mode in the options bar). The mask is
  the source of truth; marching ants are re-traced from it, so inverse,
  subtract and transform stay exact.
- `Ctrl+A` select all, `Ctrl+D` deselect, `Ctrl+Shift+D` reselect,
  `Ctrl+Shift+I` inverse, and Select > Transform Selection.
- Selections render as animated marching ants and **clip all painting** (the
  mask multiplies brush coverage on the GPU, with anti-aliased edges).
- Fill and clear the selected pixels: `Alt+Backspace` fills the foreground
  color, `Ctrl+Backspace` the background color, `Delete` clears (transparent,
  or the background color on the Background layer).

### Move & transform
- **Move tool (V)**: drags the layer — or just the selected pixels — as a
  persistent floating selection: repeated drags and nudges accumulate and
  the pixels (and marching ants) bake down only when the sequence ends
  (Enter, tool/layer switch, or another operation; Esc cancels), so the
  anti-aliased boundary is cut exactly once. **Alt-drag duplicates**, Shift
  constrains to 45°, arrow keys nudge (Shift = 10 px). Options bar has
  Photoshop's **Auto-Select** (click activates the topmost layer under the
  cursor) and **Show Transform Controls** (drag a handle to scale/rotate
  without pressing Ctrl+T).
- **Free Transform (`Ctrl+T`)** with the full Photoshop mode set: Scale,
  Rotate (15° snap with Shift), Skew, Distort, Perspective, plus instant
  Rotate 180°/90° CW/90° CCW and Flip Horizontal/Vertical. Corner/edge
  handles, rotate outside the box, Alt scales from the center, Ctrl distorts
  or skews, Enter/double-click applies, Esc cancels. The pointer shows what
  a drag will do — rotation-aware resize arrows on the handles (a box
  rotated 45° shows diagonal arrows) and curved rotate arrows outside.
- Every preview resamples the pristine snapshot through a single homography
  on the GPU, so nothing degrades while you drag.

### Document
- Photoshop-style **menu bar** (File / Edit / Image / Layer / Select / View).
- **Edit > Cut / Copy / Copy Merged / Paste / Paste in Place**: an internal
  clipboard that carries the selected pixels (mask-feathered edges included);
  Paste lands on a new layer, centered or in place.
- **File > New** with paper presets (Letter, Legal, Tabloid, A3–A6) and
  screen presets, in pixels / inches / cm / mm at a chosen resolution (ppi).
- **Image Size** (resample toggle, constrain proportions, percent units) and
  **Canvas Size** (relative mode, 9-way anchor; the Background layer extends
  with the background color), **Image Rotation** (180°/90°/flips) and
  **Crop** to selection.
- **File > Open / Place** import images (PNG, JPEG, …) as a new document or
  as a new layer scaled to fit.
- Layers panel: drag-and-drop reordering (drop onto a group header to move
  a layer inside), collapse/expand groups, double-click to rename, blend
  mode + opacity controls, the Lock row, and new-layer / new-group /
  delete buttons.

### Color
- Model-specific pickers (tabs at the top of the panel): **HSB** with the
  saturation/brightness square + hue strip; **RGB** with gradient sliders;
  **Lab** with an a/b plane and an L strip (CIE Lab, D50 with Bradford
  adaptation — same setup as Photoshop/CSS); and **OKLCH** with
  oklch.com-style two-dimensional gamut diagrams per component (L: chroma
  by lightness, C: chroma by hue, H: lightness by hue — out-of-sRGB regions
  show a checker, and a warning appears when the current color clips).
- The active model is the picker's internal representation: Lab/OKLCH
  values outside the sRGB gamut hold steady while you edit (the exported
  paint color clamps), instead of drifting through an RGB round-trip.
- Numeric readouts + hex input in every mode, foreground/background
  swatches (`X` swap, `D` reset). Clicking a swatch opens the picker in a
  dialog; the little bent arrows above the swatches swap them.

### Navigation & workflow
- Pan tool (or hold **Space**), zoom tool (click / Alt-click / scrubby drag;
  clicks step through the Photoshop zoom stops), wheel zoom around the
  cursor, `Ctrl+=` / `Ctrl+-` zoom in/out, `Ctrl+0` fit, `Ctrl+1` 100%.
- Photoshop's temporary-tool chords, in any press/release order: **Space**
  pans, **Space+Ctrl** zooms in, **Space+Alt** zooms out, **Alt** with a
  painting tool eyedrops, **Ctrl** moves — and releasing keys falls back
  through the chord (Space+Alt then releasing Space leaves the eyedropper).
  The toolbar selection never changes; the keys only borrow the tool.
- Per-tool cursors, like Photoshop: eyedropper, lassos with +/−/× selection
  badges, zoom with +/− (Alt flips it), move arrow with the four-way badge.
- **View > Extras** (`Ctrl+H`) hides the selection edges while keeping the
  selection active.
- Undo/redo for strokes (`Ctrl+Z` / `Ctrl+Shift+Z`), flattened PNG export,
  transparency checkerboard, live brush-outline cursor.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| V | Move |
| B / E | Brush / Eraser |
| I | Eyedropper (Alt+click picks the background color) |
| Alt (held with brush/eraser) | Temporary eyedropper |
| Ctrl (held) | Temporary move tool |
| M / L / P | Marquee / Lasso / Polygonal lasso |
| Shift / Alt / Shift+Alt (drag) | Add / subtract / intersect selection |
| H / Z / Space | Hand / Zoom / temporary pan |
| Space+Ctrl / Space+Alt (held) | Temporary zoom in / zoom out |
| [ / ] | Decrease / increase brush size |
| Shift+[ / Shift+] | Hardness −25% / +25% |
| 1…0 | Brush opacity (5 → 50%, 45 typed quickly → 45%, 0 → 100%) |
| Shift+1…0 | Brush flow (swapped with opacity while airbrush is on) |
| X / D | Swap / reset colors |
| Ctrl+Z / Ctrl+Shift+Z | Undo / Redo |
| Ctrl+X / Ctrl+C / Ctrl+Shift+C | Cut / Copy / Copy Merged |
| Ctrl+V / Ctrl+Shift+V | Paste / Paste in Place |
| Ctrl+T | Free Transform (Enter applies, Esc cancels) |
| Ctrl+A / Ctrl+D | Select all / Deselect |
| Ctrl+Shift+D / Ctrl+Shift+I | Reselect / Inverse |
| Alt+Backspace / Ctrl+Backspace / Delete | Fill foreground / fill background / clear |
| Arrows (Move tool or transform) | Nudge 1 px (Shift = 10 px) |
| Ctrl+Shift+N | New layer |
| Ctrl+J / Ctrl+Shift+J | Layer via copy / via cut |
| Ctrl+G / Ctrl+Shift+G | Group / ungroup layers |
| Ctrl+E / Ctrl+Shift+E | Merge down (or group) / merge visible |
| Ctrl+[ / Ctrl+] | Send layer backward / bring forward (Shift = to back/front) |
| Alt+[ / Alt+] | Select the layer below / above |
| Ctrl+, | Hide/show the active layer |
| / | Lock transparent pixels |
| Alt+Ctrl+I / Alt+Ctrl+C | Image Size / Canvas Size |
| Ctrl+= / Ctrl+- | Zoom in / out through the zoom stops |
| Ctrl+0 / Ctrl+1 (or Alt+Ctrl+0) | Fit view / 100% |
| Ctrl+H | Toggle Extras (selection edges) |

## Architecture

```
src/
  brush/
    types.ts       full Photoshop-style brush settings model
    defaults.ts    defaults + preset deep-merge
    dynamics.ts    pure per-stamp evaluation (controls, jitters, scatter,
                   color dynamics, transfer, dual train) — unit-testable
    patterns.ts    procedural tileable patterns, sampled tips, runtime tip
                   registry (seeded, deterministic)
    presets.ts     grouped preset library + imported groups
    abr.ts         Photoshop .abr parser (v1/v2 + v6-v10, PackBits,
                   Actions-descriptor reader, patt pattern decoder,
                   validated settings mapping)
    bristle.ts     experimental bristle engine: filbert tuft geometry,
                   pressure/tilt/twist contact model, per-bristle pigment
                   state and track-segment emission — pure, unit-testable
    engineParams.ts settings -> per-stroke GPU parameters (both engines)
  gpu/
    shaders.ts    WGSL: compositor (all blend modes), brush stamp (rotated
                  elliptical/sampled tips, texture, dual brush, noise),
                  stroke merge/commit (paint modes, wet edges), present pass
    engine.ts     PaintEngine: device/textures/pipelines, layer manager,
                  stroke accumulation, undo history (CPU snapshots), export
    stroke.ts     StrokeSession: spacing, pen-state interpolation, smoothing,
                  direction tracking, airbrush build-up
    bristleStroke.ts BristleStrokeSession: pointer samples -> bristle track
                  segments (cached tuft state for reload-on-lift off)
    selection.ts  polygon -> anti-aliased coverage mask
  color/convert.ts  HSV / RGB / hex / CIE Lab conversions
  transform/
    matrix.ts     Mat3 helpers + homography solve
    quad.ts       shared quad/rect geometry (corners, hit tests, bounds)
    interaction.ts pure transform-box math: handle hit testing and the
                  drag -> quad update for every mode — unit-testable
  store.ts        zustand app state (tools, brushes, layers, view, selection)
  layers.ts       layer-tree helpers: groups as parentId links over a flat
                  bottom->top array, effective visibility/opacity/locks,
                  panel rows, drag-drop restructuring (memoized resolve)
  controller.ts   facade re-exporting src/controller/ (one module per
                  concern so callers import from a single place)
  controller/
    engineHost.ts singleton PaintEngine + render-state resolution
    selection.ts  coverage-mask selection state + boolean ops
    transform.ts  free transform / move float / transform selection
    layerOps.ts   Layer menu: groups, locks, merges, fills, arrange
    clipboard.ts  internal Cut/Copy/Paste
    sampling.ts   eyedropper readback
    view.ts       zoom stops / fit
    document.ts   New / Image Size / Canvas Size / Rotation / Crop
    io.ts         Open / Place / Export PNG / ABR import
    history.ts    undo / redo
    debug.ts      window.__northlight surface for tests + console
  ui/             React components (canvas view, overlay painter, keyboard
                  map hook, toolbar, options bar, Color/Brushes/Brush
                  Settings tabs, layers panel)
```

Strokes render as instanced quads (position, radius, alpha, angle, roundness,
color, flips, texture depth per stamp) into a premultiplied RGBA stroke
texture with OVER accumulation; the dual brush accumulates its own
single-channel coverage mask the same way, drawn interleaved with the dabs
in path order so each dab samples the mask at stamp time. The compositor
merges the stroke into the active layer live (so previews respect the paint
mode, opacity, wet edges and whole-stroke texture), and pointer-up bakes it
into the layer texture. Layer
compositing ping-pongs between two accumulation textures, one pass per layer,
then a present pass applies the viewport transform (nearest-neighbor sampling
when zoomed in past 200%).

## Testing

`tests/gpu.spec.mjs` drives the real engine in a browser against offscreen
textures and asserts pixels (75+ tests): brush falloff values, rotated
elliptical tips, flow buildup vs. the opacity cap, paint blend modes, wet
edges, per-stamp color, texture / texture-each-tip modulation, true
dual-brush gating (masking and the secondary spacing train), noise, eraser,
selection clipping, undo/redo, pressure dynamics with minimums, airbrush
build-up, the pure dynamics module, pattern/preset integrity, ABR parsing
(synthesized v2 + v6.2 fixtures replicating the real-world descriptor
schema — RLE tips, patt patterns, truncated dual-tip UUIDs, toolOptions —
plus the full import-and-paint path), the viewport pass, Lab/HSV
conversions, and the Photoshop numeric keyboard shortcuts.

Set `ABR_REAL_DIR=/path/to/abr/files` to additionally validate the parser
against real brush packs (expected values for the files listed in the test
comments are baked in).

```bash
npm run build
npm test           # serves dist/ and runs the suite in headless Chromium
```

On a machine without a GPU (like a CI runner), run WebGPU on SwiftShader:

```bash
CHROMIUM_FLAGS="--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader" npm test
```

The [CI workflow](.github/workflows/ci.yml) runs the full suite on every push
and pull request.

Headless note: some SwiftShader-backed Chromium builds have a broken GPU
process (uploads or canvas presentation fail with "A valid external Instance
reference no longer exists"). The engine sidesteps the upload half by using
mappedAtCreation staging buffers instead of `queue.write*`, and the tests
avoid the presentation half by rendering offscreen. On real hardware none of
this matters.

## Known limitations

- Undo history covers paint/erase strokes (24 steps), not layer operations.
- Groups always blend as **Pass Through** (Photoshop's default); a group
  cannot yet take its own blend mode, and the Move tool moves layers, not
  whole groups.
