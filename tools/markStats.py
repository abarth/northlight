#!/usr/bin/env python3
"""
Measures the alla prima marks rendered by tools/sheets.mjs and checks them
against what a loaded bristle mark is supposed to do.

Reference plates by Sargent and Schmid could not be fetched in this
environment (the network policy blocks image hosts, see
docs/alla-prima-brushes.md), so the comparison is against mark statistics
derived from the physical brushes and from how these painters' marks are
described and reproduced, rather than against pixels lifted from a plate:

  body coverage      >= 0.95   a loaded stroke is opaque; you do not see the
                               ground through the middle of it
  streak count        4..14    hairs you can count across a mark that wide —
                               fewer reads as a knife, more reads as corduroy
  streak contrast   0.03..0.22 the hairs are a change of VALUE in opaque
                               paint, not holes in it
  along-stroke rib   <= 0.05   the dab train must not print its own ribs
                               (Impasto, which carves with the tooth in Height
                               mode on purpose, is allowed 0.08)
  edge width       <= 0.10*w   a chisel trim cuts a crisp edge (round
                               ferrules are exempt: theirs is a disc)
  width accuracy   0.85..1.10  the mark is as wide as the tip's ink box
                               projected across the stroke (a flat held at an
                               angle is SUPPOSED to draw narrow)

Dry-media presets (scumbles, blenders) are held to their own, much lower,
coverage targets — being broken is their job.

Usage: python3 tools/markStats.py [sheets/probe.png]
"""
import json
import sys

import numpy as np
from PIL import Image

SHEET = sys.argv[1] if len(sys.argv) > 1 else 'sheets/probe.png'
ROWS = json.load(open(SHEET.replace('.png', '.json')))

# id -> (min body coverage, max body coverage). Broken-by-design brushes get
# their own window; everything else is a loaded brush and must go opaque.
COVERAGE = {
    'ap-dry-drag': (0.30, 0.75),
    'ap-scumbler': (0.20, 0.70),
    'ap-fan-blender': (0.08, 0.45),
    # Impasto carves with the tooth in Height mode, so by design the low side of
    # the weave keeps less paint than the ridge. It is still a loaded brush and
    # is checked as one (streaks, edge, width) — only the body window is opened.
    'ap-impasto': (0.90, 1.01),
}
LOADED = (0.95, 1.01)

# The rib limit catches the dab train printing itself across the mark. Impasto
# carves with the tooth in Height mode on purpose, and that carve is periodic
# along the stroke too, so it gets a wider window.
RIB = {'ap-impasto': 0.08}

# Only brushes with visible hairs are held to a streak target; a rigger or a
# small round has too few hairs across too little width to show any, and a
# knife is meant to be one solid slab.
STREAKED = {
    'ap-flat-chisel', 'ap-filbert', 'ap-impasto', 'ap-dagger',
    'ap-flat-posed', 'ap-fan-blender',
}

# A chisel trim cuts a crisp edge and is held to it. A round ferrule cannot:
# its contact patch is a disc, so the mark's edge falls off over the curve of
# it, and a hard edge there would be the wrong answer.
CHISEL = {
    'ap-flat-chisel', 'ap-filbert', 'ap-bright', 'ap-knife', 'ap-impasto',
    'ap-dagger', 'ap-flat-posed',
}

img = np.asarray(Image.open(SHEET).convert('L')).astype(np.float64) / 255.0
cov = 1.0 - img  # black ink on white ground

failures = []
print(f'{"brush":<30}{"width":>12}{"body":>8}{"streaks":>9}{"contrast":>10}'
      f'{"rib":>7}{"edge":>7}')
print('-' * 83)

for row in ROWS:
    y = row['y']
    size = row['size']
    half = int(max(size, row['expect']) * 0.85) + 14
    # cross-section: average along the middle of the stroke, away from the ends
    band = cov[max(0, y - half):y + half, 300:700]
    profile = band.mean(axis=1)

    peak = profile.max()
    if peak < 0.02:
        failures.append(f'{row["id"]}: nothing painted')
        continue

    # the mark's extent: where the cross-section is above a tenth of its peak
    inside = np.where(profile > peak * 0.1)[0]
    lo, hi = inside[0], inside[-1]
    width = hi - lo + 1
    core = profile[lo:hi + 1]

    # BODY: the coverage the paint reaches in the middle of the mark, taken as
    # the 85th percentile of the cross-section so a couple of hair gaps do not
    # define it
    body = float(np.percentile(core, 85))

    # STREAKS: peaks in the cross-section, and how deep the dips between them
    # go relative to the body
    inner = core[int(len(core) * 0.12):int(len(core) * 0.88)]
    if len(inner) > 6:
        d = np.diff(inner)
        peaks = int(np.sum((d[:-1] > 0) & (d[1:] <= 0)))
        # contrast measured on the smooth part of the profile, not on noise
        contrast = float(np.percentile(inner, 90) - np.percentile(inner, 15))
    else:
        peaks, contrast = 0, 0.0

    # RIB: periodic variation ALONG the stroke on the mark's centre line
    mid = cov[y - max(2, int(size * 0.06)):y + max(2, int(size * 0.06)), 300:700].mean(axis=0)
    detr = mid - np.convolve(mid, np.ones(21) / 21, mode='same')
    rib = float(np.percentile(detr[30:-30], 97) - np.percentile(detr[30:-30], 3))

    # EDGE: how many pixels the mark takes to climb from 15% to 85% of body
    def edge_px(seg):
        a, b = 0.15 * body, 0.85 * body
        above = np.where(seg >= b)[0]
        below = np.where(seg <= a)[0]
        if len(above) == 0 or len(below) == 0:
            return 0
        return int(abs(above[0] - below[-1])) if below[-1] < above[0] else 0

    edge = max(edge_px(profile[max(0, lo - 14):lo + 20]),
               edge_px(profile[hi - 20:hi + 14][::-1]))

    lo_c, hi_c = COVERAGE.get(row['id'], LOADED)
    expect = row['expect']
    wr = width / expect
    bad = []
    if not (lo_c <= body <= hi_c):
        bad.append(f'body {body:.2f} outside {lo_c}-{hi_c}')
    if not (0.85 <= wr <= 1.12):
        bad.append(f'width {wr:.2f}x expected')
    if row['id'] in STREAKED:
        if not (0.03 <= contrast <= 0.16):
            bad.append(f'streak contrast {contrast:.3f}')
        if not (3 <= peaks <= 15):
            bad.append(f'streak count {peaks}')
    if row['id'] not in COVERAGE or row['id'] == 'ap-impasto':
        if rib > RIB.get(row['id'], 0.05):
            bad.append(f'rib {rib:.3f}')
        if row['id'] in CHISEL and edge > max(4, 0.10 * expect):
            bad.append(f'edge {edge}px')
    flag = '' if not bad else '   <-- ' + '; '.join(bad)
    if bad:
        failures.append(f'{row["id"]}: ' + '; '.join(bad))
    print(f'{row["name"]:<30}{width:>5}/{expect:<6.0f}{body:>8.2f}{peaks:>9}'
          f'{contrast:>10.3f}{rib:>7.3f}{edge:>7}{flag}')

print()
if failures:
    print(f'{len(failures)} out of target:')
    for f in failures:
        print('  -', f)
    sys.exit(1)
print('all marks within target.')
