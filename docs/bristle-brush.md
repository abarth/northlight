# Bristle brush — a track-based mark engine (experimental)

This is a second brush model that lives alongside the stamp engine. The goal
is not to simulate oil paint; it is a **digital-first brush** that borrows the
specific qualities that make physical brush marks beautiful — the kind of
marks you see around the edges of a Richard Schmid portrait, or in the
scumbled passages of a Sargent — without inheriting the stamp model's
"repeated dab" fingerprint.

## What we're chasing (the reference material)

Looking at Schmid, Sargent, Zorn, Sorolla — the painters whose brushwork
reads as brushwork — the marks share a set of properties that stamps
fundamentally cannot produce:

1. **A mark is a track, not a dab.** The mark records one gesture: a loaded,
   confident start; a streaked body; a tapered or broken release. Photoshop
   strokes are a train of overlapping stamps, and at any spacing the
   periodicity shows — especially in the falloff at the edges of the stroke.

2. **Internal striation.** A single physical stroke is not uniform across its
   width. The tuft carries dozens of bristles with imperfectly mixed paint,
   so the mark contains parallel streaks of slightly different value and hue
   that run *along* the stroke. This is the single most recognizable
   signature of a real brush, and it is exactly what per-stamp jitter cannot
   make (stamp jitter varies along the stroke, never across it).

3. **Dry-brush breakup.** Around the outside of Schmid's portraits the paint
   skips: a bristle deposits, runs out or bounces off the tooth of the
   canvas, leaves a gap, catches again. The broken passages let the ground
   (or the previous layer) breathe through the mark. Crucially the breakup
   is *coherent along the track* — a streak dies and comes back — rather
   than uniform noise sprinkled over the stroke.

4. **Depletion.** Strokes run out of paint. Coverage and body fade along the
   gesture; the tail of the mark is drier than the head. A painter reloads
   deliberately, and the reload is part of the rhythm of the passage.

5. **The mark family comes from one brush's geometry.** A filbert laid flat
   makes a wide soft swath; on its tip it draws a line; on its edge, a
   ribbon. Pressure, tilt and twist select *which part of the tuft touches
   the canvas* — one tool, a continuous family of marks. Photoshop instead
   gives you one 2D stamp shape scaled by pressure.

6. **Asymmetric, "lost and found" edges.** One side of a stroke can be crisp
   (where the full tuft dragged) while the other feathers away (where only
   the outlying bristles touched). Both edges of a stamp stroke are always
   the same.

## The model

### Geometry: a 3D filbert tuft

The brush is a bundle of up to 256 bristles arranged in a filbert-shaped
tuft, described in brush-local space:

- **Cross-section**: bristle roots are distributed over an ellipse (Vogel
  spiral for even packing, plus per-bristle jitter). `size` is the long
  axis in document pixels (shared with the options bar / `[` `]` keys);
  `thickness` squashes the short axis — a filbert is a flattened tuft.
- **Length profile**: bristle tips lie on a dome. A bristle at normalized
  cross-section radius `r` has tip height `tipZ = (1 − √(1 − r²)) ·
  belly + lengthJitter` — center bristles reach furthest, edge bristles
  hang back. This is what makes the footprint *grow from the center out*
  with pressure, like pressing a real filbert onto canvas.

### Contact: pressure, tilt, twist → footprint

Each input sample intersects the tuft with the canvas plane:

- **Pressure** sets penetration depth `press ∈ 0..1`. A bristle touches when
  `tipZ ≤ press` (after the tilt term below). Light pressure → a few central
  bristles → thin mark. Full pressure → the whole ellipse.
- **Splay**: over-penetration pushes contacted bristles outward
  (`1 + splay · press`), so pressing harder both recruits more bristles and
  spreads them — the mark widens faster than the raw geometry alone.
- **Tilt** leans the tuft. Bristles on the leaning side get an effective
  depth bonus (`tipZ − lean · (offset · leanDir)`), so the contact patch
  slides toward the lean and elongates (positions stretch along the lean
  azimuth) — laying the pen down paints with the *side* of the filbert.
- **Twist** (barrel rotation, plus a base angle for pens without twist)
  rotates the flat of the filbert, so the same gesture drawn with the flat
  across vs. along the stroke gives a broad vs. ribbon mark.

### Deposition: every bristle drags a track

Between input samples, each contacted bristle advances from its previous
canvas position to its new one and deposits a **track segment** (subdivided
to ≤ ~6 px so curves stay smooth). A bristle that loses contact simply stops
mid-canvas — no cap, no stamp; that is where its streak ends.

Two dynamics shape how tracks move through direction changes:

- **Flex** (drag lag): a bristle's tip relaxes toward its geometric target
  by the distance the pen travelled over the bristle's lag length
  (`flex × size`, outer bristles trail more). Tips trail the pen slightly
  during steady motion, and at a reversal they carve rounded turnaround
  loops and fan through the turn instead of pivoting on a sharp point —
  the way a real tuft flops over rather than folding instantly.
- **Turn softening**: deposition is faded by the per-track direction-change
  rate (quadratic in the turn angle, so gentle curves are untouched). At a
  reversal the bristles are flipping over and drag with less of their load,
  which both looks right and hides the double deposit where a retraced
  path overlaps itself.

Per-bristle pigment state (the per-stamp jitter idea, moved to bristles):

- **Color**: assigned per bristle at load time — hue/sat/brightness jitter
  plus an optional blend toward the background color, so the tuft carries
  imperfectly mixed paint. The streaks this makes run along the stroke.
- **Base opacity**: per-bristle jitter; some bristles print harder.
- **Load**: depletes with track distance. `load` is measured in **brush
  diameters** of travel, so "one brush-load of paint" is the same gesture at
  any size. Segment alpha fades with load, and — see below — dryness also
  raises the canvas-tooth gate. Lifting the pen reloads the brush
  (optional), making reload part of the stroke rhythm as it is in paint.
- **Flow breakup**: deposition along a track is gated by a smooth per-bristle
  value noise over arc length (each bristle has its own seed and phase). A
  streak deposits, dies for a stretch, catches again — coherent gaps along
  the track, the drybrush signature. `breakup` sets the threshold (how much
  of the track is dry), `breakupScale` the wavelength of the gaps as a
  fraction of brush size.

### Scale invariance

Every mark-quality parameter is defined relative to brush size, so resizing
the brush scales the whole mark instead of thinning it. Track width is not a
px setting: it derives from `coverage` × size/√bristleCount (× a thickness
term) — the width at which the tracks would exactly tile the footprint,
scaled by coverage. Growing the brush widens every streak proportionally;
raising the bristle count splits the same coverage into finer streaks. Load
and breakup wavelength are size-relative for the same reason. The only
absolute-px quantities are rendering details (segment subdivision length)
and the document-anchored tooth texture, which is a property of the
*surface*, not the brush.

### Canvas tooth

Segments render through the existing texture pipeline in **subtract** mode
with *texture-each-tip* semantics: the pattern is a height field, and each
segment loses coverage in the valleys (`a′ = a − (1−v)·depth`). The
per-instance `depthScale` attribute — already in the stamp vertex layout —
is driven by **bristle dryness**: a loaded bristle floods the tooth (low
depth), a dry one only kisses the peaks (high depth). Dry-brush over canvas
texture emerges from the interaction instead of being painted on.

The default tooth is the **`tooth` pattern**: isotropic multi-octave noise
with no weave or lattice structure. A woven-canvas pattern turned out to
read as a mechanical checkerboard when large areas are filled — the weave
is a screen-aligned periodic grid, and every stroke reveals the same grid.
We are not emulating cloth; what the tooth is *for* is (a) spatially
anchored breakup — two overlapping dry strokes skip at the same places, so
the holes read as a shared surface rather than per-stroke noise — and (b)
cross-track granularity that the along-track breakup noise cannot provide.
Aperiodic granular noise keeps both without the grid. The woven `canvas`
pattern is still selectable, and `toothDepth: 0` removes the surface
entirely — then all breakup is per-bristle and travels with the stroke.

### Rendering: an exact, overlap-free chain decomposition

Track segments render through their own instanced pipeline (`TRACK_SHADER`)
as a chain decomposition with **zero double-coverage anywhere**:

- Interior joints are **mitered**: the emitter runs one segment behind the
  pen so it knows each joint's next direction, and both segments' shared
  end edge is cut along the bisector of the joint angle. The two trapezoids
  tile exactly — no overlap, no gap — and because the across-track distance
  field is mirror-symmetric about the bisector, the falloff profile is
  continuous through the seam. (Earlier versions — stretched elliptical
  stamps, then perpendicular butt ends — both had per-joint artifacts:
  lens-shaped double deposits, then wedge overlap/gap striation as the
  track curved.)
- Chain ends (touch, lift, too-sharp turns) render **SDF half-circle
  caps** past the endpoint; the cap and its adjoining segment split the
  plane, so there is no cap-over-body double deposit. A lone touch is a
  zero-length segment with both caps (a disc). Turns too sharp to miter
  (≳120°, or when the miter would outrun a short segment) break the chain
  with caps — and turn softening fades those to near-invisibility anyway.
- Alpha, color and tooth depth are stored **per endpoint** and interpolate
  along each segment. The emitter evaluates them at the shared joint
  positions (never per segment), so a bristle running dry or fading
  through a turn ramps smoothly with no per-segment stepping, and breakup
  gaps open and close with soft ends.

The result is what a bristle's mark should be: a single analytic shape on
the canvas. Segments still accumulate OVER into the same stroke texture
with the same commit/opacity-cap path, so selections, locks, blend modes
and undo are unchanged. (Genuine self-overlap — a retraced path — still
deposits twice, which is correct: the brush really did pass twice.)

### Cursor

Because the footprint is analytic, the hover cursor can show the real thing
before contact: the full-pressure footprint outline (dashed), the
light-pressure touch footprint (solid, what you'll get at ~30% pressure),
and a tick along the flat of the filbert — all rotated by the live twist
and stretched by the live tilt read from pen hover events. You can see what
the mark will be before the pen lands.

## What's deliberately *not* in v1

- No fluid/impasto simulation, no canvas wetness, no paint mixing on the
  surface. Digital-first: we keep the qualities, not the physics.
- Bristle dynamics stop at first-order drag lag (`flex`). There is no
  spring-back, no inertia, and no interaction between bristles; the lag is
  distance-based rather than time-based (deliberate: marks depend on the
  path, not on how fast you drew it).
- No pigment pickup from the canvas (dragging through wet paint). Would be
  a beautiful phase 3.

## Iteration plan

The settings panel exposes every parameter precisely because this is an
experiment — the intended loop is: paint, judge, tweak, repeat.

1. **Deposition pass (this change)**: bundle geometry, contact model,
   per-bristle pigment/load/breakup, tooth gating, cursor preview, settings
   UI, deterministic unit tests + GPU pixel tests.
2. **Geometry pass**: bristle lag/spring, velocity-aware splay, tilt
   response curves, footprint anti-popping (bristles fading in/out of
   contact over a few px of pressure instead of a hard threshold).
3. **Pigment pass**: two-tone loading (tip vs. heel color), reload gestures,
   load transfer between bristles, optional pickup from the layer.
4. **Mark quality pass**: dedicated capsule shader, per-bristle width
   variation with pressure, edge-of-tuft flick on release.
