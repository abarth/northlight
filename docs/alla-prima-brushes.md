# Alla prima brushes

A set of thirteen direct-painting oil brushes, in the Brushes panel under
**Alla Prima (Oils)**, aimed at the marks you read off a Sargent sleeve or a
Schmid still life: loaded chisel strokes that turn broad-to-thin, hair drag
through the body of the paint, discrete square touches of one value, dry
scumbles that skip over the tooth, and edges that are found in some places and
lost in others.

Everything here uses only features Photoshop has. There are ready-made
`.abr` files to import and a recipe table for rebuilding them by hand — see
**The .abr file** and **Rebuilding these in Photoshop**. Where northlight was missing one of those
features, it was added (see **What was added to the engine**).

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

## The .abr file

Import with **Brushes panel ▸ panel menu ▸ Import Brushes…**, or by
double-clicking.

[`brushes/northlight-alla-prima.abr`](../brushes/northlight-alla-prima.abr)
(100 KB) holds all thirteen, complete: twelve as Photoshop **bristle brushes**
so its Bristle Qualities sliders stay live, the linen tooth as an embedded
pattern, and `Flat Bristle, Fixed Pose` as a tip bitmap because its pose
foreshortens the tip and a bristle descriptor has no Roundness to carry that.

`--sampled` writes a variant whose tips are all northlight's own bitmaps: the
exact marks from the sample sheets, at the cost of the Bristle Qualities
sliders. `--no-texture` leaves the pattern out.

Photoshop draws its bristle tips with its own simulation, so expect a family
resemblance to the sample sheets rather than a pixel match — the Shape and the
four quality sliders are the same, and everything outside the tip (Shape
Dynamics, Scattering, Texture, Transfer, Colour Dynamics, Flow/Opacity/
Smoothing) is identical. The `--sampled` variant trades those sliders for
exactness.

Regenerate with:

```bash
npm run build
node tools/exportAbr.mjs                  # bristle tips
node tools/exportAbr.mjs --sampled        # embedded bitmaps, exact marks
node tools/exportAbr.mjs --no-texture     # leave the linen pattern out
node tools/exportAbr.mjs all              # every built-in group
node tools/exportAbr.mjs --probe          # the diagnostic ladder, below
```

or from inside northlight: select a brush and press **Export ABR…** in the
Brushes panel, which writes out the group that brush belongs to.

### The format, as Photoshop writes it

Reading a Legacy Bristle set exported from Photoshop settled the parts of the
format that had previously been guesswork. A bristle brush is a **version 9.2**
container of `samp` / `patt` / `desc` / `phry` sections whose `desc` holds one
`brushPreset` descriptor per brush, and whose tip is a `dBrush` object:

| Key | Type | Meaning |
| --- | --- | --- |
| `Shp ` | long | Shape, indexing the dropdown in panel order: 0 Round Point, 1 Round Blunt, 2 Round Curve, 3 Round Angle, 4 Round Fan, 5 Flat Point, 6 Flat Blunt, 7 Flat Curve, 8 Flat Angle, 9 Flat Fan |
| `Dnst` | UntF `#Prc` | **Bristles**, as a fraction (0.01 = 1%, the "single bristle" minimum) |
| `Lngt` | UntF `#Prc` | **Length**; runs past 1.0 (observed 0.25–2.46) |
| `thickness` | UntF `#Prc` | **Thickness**; runs past 1.0 (observed 0.01–2.0) |
| `stiffness` | UntF `#Prc` | **Stiffness**, 0..1 |
| `clumping` | UntF `#Prc` | 0.25 in every preset seen, and not on the panel — carried, not interpreted |
| `Angl` | UntF `#Ang` | bristle Angle |
| `Dmtr` | UntF `#Pxl` | Size |
| `Spcn` | UntF `#Prc` | Spacing, on a 0–100 scale (unlike the qualities above) |
| `physics` | bool | true |
| `Intr`, `flipX`, `flipY` | bool | |

The `Shp` order was confirmed from the presets' own names — 0 for the two
"Round Point" brushes, 1 for "Round Blunt Streaks", 6 for "Flat Blunt Streaks",
9 for the three "Flat Fan" ones — and it is the order this repo already listed
the shapes in.

The same file corrected four things about the rest of the container, all of
which had been written the wrong way here before:

- **Every `Objc` carries a class id**, not `null`: `brushPreset`, `dBrush`,
  `sampledBrush`, `dualBrush`, `brushGroup`, and `brVr` for a dynamics variance
  object.
- **Strings are NUL-terminated and the count includes the NUL** — including the
  empty class-name string that precedes every class id, which is therefore one
  NUL and not zero characters.
- **`Cnt ` is a `doub`**, and blend modes use their **long-form enum values**
  (`multiply`, not `Mltp`). The parser now reads both forms; without the long
  ones, a modern file's `darken` fell through to multiply.
- **A bristle tip needs no `samp` record at all.** That retires the one part of
  the format this repo could not previously verify: the fixed 301-byte header
  inside a samp record. It is still written for genuinely sampled tips, and now
  mirrors a real Photoshop record (a u16 1, a few small constants, a second copy
  of the bitmap rectangle, and a tail ending in the pixel depth) instead of
  being zero-filled.

Photoshop also stores Brush Pose as a section toggle, `useBrushPose`. Its
contents are still unrecorded, so the pose stays baked (below) and the toggle is
written false.

### How the format was pinned down

Photoshop 2026 rejected the first attempts at this file. Settling it took three
Photoshop-written reference files and two techniques.

**Reproduce, do not guess.** Feeding a reference file's own decoded content back
through this writer's primitives and diffing against the original is the only
check that actually settles an encoding question. That is now true of:

| Structure | Result |
| --- | --- |
| container header, section framing and padding, `desc`, `phry` | **all 7940 bytes** of the Legacy Bristle file reproduced exactly |
| `samp` record fixed header | **all 301 bytes** reproduced for four records across three files — tips of 18×19, 52×54, 183×143 and 211×238, both compressed and uncompressed |
| `patt` entry | **all 41 473 bytes** of the reference grayscale pattern reproduced exactly, alpha channel and its PackBits packing included |

**A probe ladder for the rest.** Small files each adding one construct, imported
in Photoshop, localise anything reproduction cannot reach. That is what showed
the descriptor half was sound and both failures were in the binary image
sections.

#### The two things that were actually wrong

Both were **computed lengths mistaken for constants**, and both are invisible to
this repo's own parser, which skips those fields — so nothing but Photoshop
could have caught them.

*In a `samp` record's 301-byte header:*

```
+37  u16 1, u16 0
+41  u32 3                    constant
+45  u32 recordLength - 49    the rest of the record, as a block length
+49  the bitmap rectangle, again
+65  u32 56                   constant
+289 u32 1                    constant
+293 u32 23 + dataLength      the image block — the same 23-byte channel
                              header shape a patt channel uses
+297 u32 8                    pixel depth
```

The first reference had a 52×54 tip, whose `+45` and `+293` happen to be `0x4FF`
and `0x3FF`. Written as constants onto a 256×256 tip they are out by two orders
of magnitude. Four records at four sizes made the pattern unmistakable:
`+45 = rl − 49` and `+293 = 23 + dataLength` hold for every one.

*In a `patt` entry's channel table:* three separate errors, each caught only by
importing into Photoshop.

1. The table holds exactly `maxChannels + 2` = **26** slots. 27 were written.
2. A **grayscale pattern has two written channels** — the grey plane and a
   solid-255 alpha — where only one was.
3. **Which slot each channel occupies matters.** The colour planes take slots
   0.. (one for grayscale, three for RGB), and the transparency plane goes in
   the *last* slot, 25 — the two slots past `maxChannels` being the extra pair.
   Putting alpha at slot 1, where a colour plane belongs, changed the failure
   from "not compatible with this version" to "a program error" but was still a
   failure.

Photoshop writes the image plane uncompressed and the alpha PackBits-packed,
which is what this reproduces.

All three rules, and the two samp lengths, are now asserted against the raw
written bytes in the test suite — the parser reads none of those fields and
would not notice them changing back.

### What the export can and cannot carry

**Brush Pose and Brush Projection are baked.** The attitude those settings
produce is computed and written into the tip's Angle, so the exported brush
makes the same mark but will not respond to tilting the pen. One wrinkle: a
`dBrush` has an Angle but **no Roundness**, so a preset whose pose *foreshortens*
the tip cannot be a bristle descriptor at all — the squash would silently
vanish. The writer detects that case and falls back to an embedded bitmap for
that brush, where `Rndn` does exist. In this set that is one brush,
`Flat Bristle, Fixed Pose`; the other twelve go out as bristle tips.

**`Round Bristle, Tilt Projected`** loses its tilt response and exports as the
round mark it makes with the pen upright.

**The `linen` tooth travels with the file** as a pattern in the `patt` section,
so Texture works on import without hunting for a substitute.

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
  bit-identical to Photoshop's, and they cannot be. (Which is why there are two
  `.abr` files: one that keeps the sliders, one that keeps the mark.)
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

And, so the brushes can leave northlight at all, an **.abr writer**
(`src/brush/abrWrite.ts`) — the inverse of the existing parser, emitting v9.2
`samp` / `patt` / `desc` / `phry` sections with Photoshop's own bristle
descriptors. The parser gained the matching read path, so Photoshop's bristle
brushes now import as northlight bristle tips.

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
