# How it is drawn

The goal is a scientific image, not a diagram: a cut-open tumour that looks like
a cleared tissue sample, a light-sheet volume, or an H&E section, with every
visible cell a real node of the matrix in its real place with its real state.

## One geometry pass, one image pass

Everything is drawn once into a G-buffer, and one later pass turns that into the
finished image.

| | target | holds |
|---|---|---|
| 0 | colour | the lit surface |
| 1 | normal + depth | view-space normal in rgb, view depth in a |
| 2 | identity | the node id in rgb, what kind of surface in a |

The second pass reads all three and does ambient occlusion, cell membranes, the
depth cue, bloom, optional depth of field, and the tone map. Five draw calls for
the whole scene.

### Why not `MeshPhysicalMaterial` with transmission

The brief allowed "an equivalent wrap-lighting subsurface approximation if
transmission costs too much", and it does, twice over: three.js renders
transmissive materials in a separate pass that cannot write a G-buffer, and at a
few thousand overlapping bodies the cost is far out of proportion to what it
adds. Instead `shadeTissue` combines

- **wrap diffuse** — light bleeds past the terminator, so nothing shows the hard
  shadow line that makes a sphere read as a billiard ball;
- **back-scatter** — light that has travelled through the body and comes out
  towards the eye, which is what makes a cell look full rather than hollow;
- **sheen** on the fresnel rim, **clearcoat** as a second tighter highlight (a
  wet vessel is mostly this), and an analytic sky/ground environment that needs
  no texture and so cannot be blocked.

## What stops it reading as dots

| | |
|---|---|
| **Packing** | resting radius 0.72 voxel, so a cell is 1.44 voxels across at 1.0 voxel spacing and overlaps its neighbours. Hashed jitter (±0.28 voxel) and size variation (±15%) stop the lattice showing. |
| **Shape** | a low-frequency fbm wobble per cell, seeded from the node, so no cell is a sphere and no two are the same. |
| **Membranes** | every instance writes its node id; the image pass draws a line wherever that id changes between neighbouring pixels. Overlapping spheres become a polygonal mosaic, and the boundary is exactly where two real cells meet. |
| **Flat cut faces** | geometry past the cut is **clamped onto** the cut rather than discarded, with the cut face's own normal. A sphere crossing the plane becomes a sphere with a flat face - a cell in a section. Discarding instead leaves a hollow bowl. |
| **Nuclei** | a second instanced draw at ~50% of cell diameter, offset off centre, sharing the cell's instance attributes so the two can never disagree. |
| **Occlusion** | hemisphere-sampled AO in the image pass. The crevices between packed cells are exactly the geometry it darkens, and that is most of what makes them read as touching. |

## Level of detail

Drawing the whole population at a distance is what reads as a cloud of dots, so:

- **far**: the mass is one isosurface. Occupancy is blurred and surface nets
  extract the boundary, which turns a stack of voxels into the smooth organic
  shape a cleared sample has. A procedural Voronoi mosaic at the scale of one
  cell keeps it reading as cellular. The mosaic is illustrative.
- **near the cut**: individual cells, in a slab a few voxels deep behind every
  cut face. They fade in with how many pixels a cell covers.

The three regions are partitioned by one function, so they meet exactly: nothing
past the cut point; individual cells from there back to the slab depth; the
isosurface behind that. The isosurface's cut is offset by the slab depth for
precisely this reason - otherwise the cells sit on top of a skin that should
have been cut away beneath them.

The section thickness is per view: a cleared sample is viewed several cells
deep, an H&E section is thin enough that nearly every cell in it is a cut cell.

## The three views

Each is a complete look declared in `visuals.json` - lighting, palette, material
and post. Adding a fourth is a data change.

- **Tissue** — muted, warm-undertoned clone colours, strong AO, membranes, a
  distance cue. Cool tones for the sensitive lineage, one strong warm hue for
  the resistant one.
- **Fluorescence** — black ground, nuclear stain blue, each clone in its own
  fluorescent-protein hue, emission instead of reflection, bloom restrained to
  the brightest pixels by a threshold. Marks stay solid bodies with depth
  writes: blending them additively turns a dense tumour into one white blob and
  multiplies the fill cost by the overdraw.
- **Histology** — the H&E palette on a white slide, a thin section so cells are
  cut open, eosin cytoplasm, haematoxylin nuclei, pale necrosis, red cells in
  the vessels. Colour-by-cause is disabled here: H&E is a two-dye stain, not a
  per-cause channel.

## Vessels

The vascular tree is grown from `rules.json` by the same function the simulator
uses, so the tubes sit exactly where the oxygen sources are. The living cuff
around a vessel is real structure, not a drawn highlight. Chains through the
tree are smoothed into tortuous tubes with an uneven radius; the lumen shows as
blood where the cut opens a vessel; red cells are instanced biconcave discs
sized from 7.5 µm against the voxel size.

## Picking

The identity already rides in the G-buffer, but WebGL only ever reads back
attachment zero of a multiple-render-target framebuffer, so a pick is its own
one-pixel render with a single-output material that shares the vertex stage.
What you can hover is therefore exactly what you can see, including the cut, the
wobble and any fragmenting.

## Accuracy

One rendered cell is one occupied node. Nothing is added to fill a gap and
nothing is hidden to tidy the picture. Position jitter is capped in the schema
at ±0.35 voxel so a cell always stays inside or against its own node and
adjacency is preserved. Sizes are real ratios: node spacing 15 µm (one cell),
nucleus
45-55% of cell diameter, red cells 7.5 µm. The scale bar is computed from the
voxel size and the camera, never placed by hand.

Three things are illustration, and the legend says so: the membrane line
styling, the procedural cell texture on the distant isosurface, and red blood
cell motion.
