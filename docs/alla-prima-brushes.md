# Alla prima brushes

A set of thirteen direct-painting oil brushes, in the Brushes panel under
**Alla Prima (Oils)**, aimed at the marks you read off a Sargent sleeve or a
Schmid still life: loaded chisel strokes that turn broad-to-thin, hair drag
through the body of the paint, discrete square touches of one value, dry
scumbles that skip over the tooth, and edges that are found in some places and
lost in others.

Everything here uses only features Photoshop has, so the brushes can be
rebuilt there from the recipe table below. Where northlight was missing one of
those features, it was added (see **What was added to the engine**).

## The three things that decide whether a bristle mark reads as paint

These came out of measuring rendered marks, not out of taste, and they are why
the presets look the way they do.

**1. Which way the blade points.** A bristle tip is a contact patch streaked by
its hairs. Set Shape Dynamics ▸ Angle ▸ Control to **Direction** with tip Angle
−90° and the blade stays across the stroke, so every dab's hair gaps land on
the previous dab's and the hairs draw *continuous striations* down the mark.
Leave Angle Control **Off** and the blade is held at one fixed attitude
instead: the mark then turns broad-to-thin on stroke direction alone — a flat
drawn along its own blade is a hairline — which is the other half of the alla
prima vocabulary. Its dabs do shift sideways as they advance, so the
striations fill in; those brushes trade the hair drag for the thick/thin.

**2. Spacing tight enough.** Aligned gaps survive any amount of overlap, so
there is no reason to space wide to keep them, and spacing wide prints the dab
train as ribs across the mark. All the dragged brushes sit at 8–22%.

**3. How much tooth.** A loaded mark is opaque and shows the weave only as a
whisper (Depth around 0.10–0.17). A mark from a brush that is nearly dry is
mostly weave (Depth 0.55+, applied per dab, with a Minimum Depth so it never
smooths out). Anything in between reads as fabric rather than paint.

A fourth, subtler one: a hair *gap* must not be a hole. A true zero in the tip
survives any amount of dab-on-dab accumulation, while anything above zero
saturates — so a gap is either bare ground or invisible, with nothing in
between, unless the tip itself provides the middle. Above about 50% Thickness
the generator therefore bridges the gaps with a thinner film of paint, which is
what real hairs packed that closely do. That is what turns the striations from
holes into a change of value.

## Pen response

Every preset maps **pressure** to both the width of the mark (Shape Dynamics ▸
Size Control, with a Minimum Diameter of 50–75% on the loaded brushes — a
loaded flat rolled up on its edge really does draw at half its width) and to
how much paint it puts down (Transfer ▸ Flow Control). Nothing here is
pressure-blind.

On top of that:

- **Tilt** — the two projected presets use Shape Dynamics ▸ Brush Projection:
  lay the pen over and the tip flattens along the direction of tilt.
- **Barrel rotation** — with Brush Projection on, rolling the barrel spins the
  mark, which is how you steer a flat without turning your wrist.
- **Direction** — the fixed-attitude flats (Bright, Knife, Dagger, Fixed Pose)
  turn broad-to-thin as the stroke turns, with no pen input at all.
- **No tilt sensor, or a mouse** — Brush Pose ▸ Override holds a chosen
  attitude for the whole passage. `Flat Bristle, Fixed Pose` is set up that
  way.

`sheets/response.png` shows all four axes swept.

## The brushes

| Brush | Bristle shape | B / L / T / S | Size | Spacing | Angle | Angle ctl | Min Diam | Flow Min | Tooth |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Flat Bristle Chisel | Flat Blunt | 16 / 50 / 82 / 85 | 64 | 14% | −90° | Direction | 55% | 72% | linen 0.12 Multiply |
| Filbert Loaded | Flat Curve | 14 / 55 / 84 / 80 | 54 | 13% | −90° | Direction | 50% | 75% | linen 0.11 Multiply |
| Bright Short Chisel | Flat Blunt | 10 / 22 / 100 / 95 | 46 | 25% | −45° | Off | 65% | 88% | linen 0.10 Multiply |
| Knife Slab | Flat Blunt | 5 / 16 / 100 / 100 | 78 | 18% | −20° | Off | 75% | 90% | linen 0.08 Height |
| Impasto Loaded Flat | Flat Curve | 13 / 42 / 86 / 90 | 60 | 8% | −90° | Direction | 62% | 82% | linen 0.17 Height |
| Dry Drag Scumble | Flat Blunt | 34 / 70 / 42 / 50 | 74 | 22% | −90° | Direction | 55% | 15% | linen 0.70 Subtract, per tip, Min Depth 50% |
| Broken Color Scumbler | Round Fan | 32 / 80 / 52 / 40 | 62 | 14% | −90° | Direction | 50% | 30% | linen 0.55 Subtract, per tip, Min Depth 45% |
| Fan Blender | Flat Fan | 42 / 60 / 46 / 40 | 92 | 20% | −90° | Direction | 70% | 6% | linen 0.30 Multiply |
| Angular Dagger | Flat Angle | 14 / 55 / 88 / 90 | 52 | 14% | −45° | Off | 50% | 68% | linen 0.10 Multiply |
| Round Sable Accent | Round Point | 20 / 60 / 82 / 80 | 17 | 10% | 0° | Direction | 12% | 35% | — |
| Rigger Liner | Round Point | 10 / 95 / 90 / 85 | 11 | 8% | 0° | Direction | 6% | 55% | — |
| Round Bristle, Tilt Projected | Round Blunt | 22 / 55 / 90 / 75 | 48 | 9% | 0° | Direction | 50% | 80% | linen 0.13 Multiply |
| Flat Bristle, Fixed Pose | Flat Blunt | 10 / 40 / 92 / 90 | 62 | 18% | 0° | Off | 62% | 85% | linen 0.13 Multiply |

B / L / T / S is Bristles / Length / Thickness / Stiffness, as percentages.

Beyond the table:

- **Colour Dynamics** is on, per tip, for every loaded brush — Saturation and
  Brightness jitter around 10%, Hue jitter 1–2%. Once the body of a mark is
  opaque, that internal colour variation is what keeps a passage alive; without
  it the marks are flat slabs.
- **Broken Color Scumbler** also uses Scattering: Count 2, Count Jitter 40%,
  Count **Control: Pen Pressure** — lean in and the veil thickens.
- **Fan Blender** caps Opacity at 55% and Flow at 50%, so repeated coaxing over
  one edge cannot build past a veil.
- **Dry Drag Scumble** runs Flow 90% / Opacity 95%; where it lands it is paint,
  and where it skips there is nothing.
- Smoothing is 15–50%, highest on the Rigger, where a long line has to stay
  clean at speed.

## Rebuilding these in Photoshop

Everything in the table maps one-to-one onto Photoshop's Brush Settings panel:

1. **Brush Tip Shape** — pick the bristle Shape from the list, set Size and
   Spacing, and set the bristle **Angle**. Set Bristles / Length / Thickness /
   Stiffness from the B / L / T / S column.
2. **Shape Dynamics** — Size Control: Pen Pressure, Minimum Diameter from the
   table; Angle Control: Direction or Off per the table. Tick **Brush
   Projection** for the two projected presets.
3. **Scattering** — only for the Scumbler (Count 2, Count Jitter 40%, Count
   Control: Pen Pressure).
4. **Texture** — the `linen` column. Photoshop has no `linen` pattern; use
   **Canvas** from the legacy pattern set, or **Burlap** for a coarser weave.
   Match Depth, Mode, and (where listed) Texture Each Tip + Minimum Depth.
5. **Transfer** — Flow Control: Pen Pressure with the listed Minimum.
6. **Color Dynamics** — Apply Per Tip, with the jitters above.
7. **Options bar** — Flow, Opacity and Smoothing as listed.

Two caveats, stated plainly:

- Photoshop draws bristle tips with a bristle simulation whose internals are
  not published. northlight builds the contact patch those six parameters
  describe and streaks it with the hairs. The same sliders move the mark the
  same way, and the marks are the same kind of mark, but they are not
  bit-identical to Photoshop's, and they cannot be.
- Photoshop's Brush Pose slider values apply as the pen's fallback; northlight
  applies the pose value when its Override is ticked and the pen's value
  otherwise. For the one preset that uses it, all the relevant Overrides are
  ticked, so the behaviour matches.

## What was added to the engine

Each of these exists in Photoshop and was missing from northlight:

| Feature | Where |
| --- | --- |
| Bristle tips (Bristle Qualities: Shape, Bristles, Length, Thickness, Stiffness, Angle) | `src/brush/bristle.ts` |
| Brush Pose (Tilt X/Y, Rotation, Pressure, each with Override) | `types.ts`, `dynamics.ts` (`posedSample`) |
| Shape Dynamics ▸ Brush Projection | `dynamics.ts` (`emitStamps`) |
| Texture ▸ Minimum Depth | `types.ts`, `dynamics.ts` |
| Scattering ▸ Count Control | `types.ts`, `dynamics.ts` |

Two supporting changes that are not Photoshop features but are needed to render
the above honestly:

- **Mipmapped tip textures** with a LOD picked from the dab's own footprint
  (`patterns.ts` `mipChain`, `engine.ts` `grayTexture`, the stamp shader's
  `tipLod`). A 256px hair-striped tip point-sampled onto a 40px dab moirés.
  Imported ABR tips benefit at small sizes too.
- **A `linen` texture pattern** (`patterns.ts`): a plain weave whose threads
  wander, vary in width and carry the odd slub. The existing `canvas` pattern
  is a pair of clean sines, and at the depth a dry-brush drag needs it prints a
  visible screen door — the skips land in a grid instead of in patches.

The bristle tip id is content-addressed — `bristle:flat-blunt:b16l50t82s85`
*is* the tip name — so the tip registry, the GPU texture cache, the spacing
aspect calculation, the brush-outline cursor and the stroke preview all handle
bristle tips with no extra plumbing, and the same id always generates the same
map.

## Sample sheets and how they were judged

`tools/sheets.mjs` opens the built app in headless Chromium and drives the real
`PaintEngine` and `StrokeSession` over synthesized pen paths — position,
pressure, tilt and barrel rotation — then writes the composited documents out
as PNGs. Nothing in `sheets/` is drawn by anything but the brush engine.

```bash
npm run build
node tools/sheets.mjs                 # all sheets into sheets/
node tools/sheets.mjs marks study     # just the ones whose name matches
python3 tools/markStats.py            # measure sheets/probe.png
```

| Sheet | What it shows |
| --- | --- |
| `sheets/marks-1.png`, `marks-2.png` | Every preset against six marks: a level drag, a pressure swell, a sweep through 90°, a comma that lifts, a dry pass over paint already down, and three separate touches at rising pressure |
| `sheets/marks-detail.png` | Six brushes at 1:1, one long stroke each, for looking at the hair drag |
| `sheets/tips.png` | The ten bristle shapes: the generated alpha map beside a stroke from it |
| `sheets/response.png` | Pressure, tilt, barrel rotation and stroke direction swept |
| `sheets/study-sphere.png` | A sphere on a toned ground, blocked in with the set. No gradients — every value on the ball is a brushstroke |
| `sheets/study-passage.png` | A wet-into-wet passage with nothing representational to hide behind: the plate to look at when asking whether these read as oil paint |

### On the comparison against Sargent and Schmid

Reference plates could not be fetched in this environment: the network policy
blocks image hosts (Wikimedia, museum open-access APIs, WikiArt — only GitHub
is reachable), so there are no reproductions on disk to diff against. The
comparison was therefore done two ways, and it is worth being clear about which
is which:

1. **By eye, iteratively** — the sheets above were rendered, looked at, and the
   brushes retuned, repeatedly. That is a judgement against knowledge of these
   painters' marks, not against a plate. It is what caught the corduroy, the
   screen-door tooth, the marks that read as fabric because texture dominated a
   translucent body, and the hair gaps that read as holes.
2. **By measurement** — `tools/markStats.py` renders one long stroke per preset
   in black on white and measures it. The targets come from the physical
   brushes and from how these marks reproduce, not from sampled pixels:

   | Measure | Target | Why |
   | --- | --- | --- |
   | body coverage | ≥ 0.95 | a loaded stroke is opaque; you do not see the ground through the middle of it |
   | striation count | 3–15 across the mark | fewer reads as a knife, more reads as corduroy |
   | striation contrast | 0.03–0.16 of coverage | the hairs are a change of value in opaque paint, not holes in it |
   | along-stroke ribbing | ≤ 0.05 | the dab train must not print itself across the mark |
   | edge width | ≤ 10% of the mark | a chisel trim cuts a crisp edge (round ferrules are exempt — theirs is a disc) |
   | swept width | 0.85–1.12× predicted | the mark is as wide as the tip's ink box projected across the stroke, so a flat held at an angle is *supposed* to come out narrow |

   Brushes that are broken by design (Dry Drag, Scumbler, Fan Blender) are held
   to their own, much lower, coverage windows; Impasto's body window is opened
   to 0.90 because carving with the tooth in Height mode means the low side of
   the weave keeps less paint on purpose. Every exception is in the script with
   its reason.

   All thirteen presets are currently within target.

If you have the plates locally, `python3 tools/markStats.py <your-sheet.png>`
takes any sheet rendered with the same band layout, and the targets in the
script are the place to record numbers measured off a real reproduction.
