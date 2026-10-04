# The stand-in simulator and its numbers

Notes on the TypeScript simulator in `src/sim/` (`?source=local`, `npm run sim`), the
seam it shares with the Python engine, and how to read the values in `data/rules.json`.

## The two halves

**`src/sim/` knows the biology but not the numbers.** It grows a vascular tree
from the rules, perfuses the lattice from its lumen, then reads each living
node's local situation out of the matrix — oxygen, drug concentration, free
neighbours, its clone profile, how long it has been in its state — turns that
into per-cause hazards using the rules, and emits the event with the cause that
fired. It resolves cause and state ids by *role* (`drugApoptosis`,
`hypoxicNecrosis`, …) so even the ids live in the data file. Rolls are hashed
from `(seed, tick, node, channel)`, so a run is reproducible and does not depend
on the order nodes are visited in.

**`src/render/` and `src/ui/` know neither.** They read the meaning of a cause
from the cause table in `rules.json` and its appearance from `visuals.json`.
There is not a rate, a threshold or a probability anywhere in them. The shader
implements six generic effects — scale curve, colour curve, blebbing,
fragmenting, transparency, emissive — and a preset is a set of numbers that
combines them.

## Swapping in the real simulation

`SimulationSource` (`src/source/types.ts`) is the only thing the renderer talks
to. Three implementations ship:

| Source | How to use it |
|---|---|
| the stand-in simulator | the default |
| a recorded run | `?source=file&events=/run.events&keyframes=/run.keyframes` |
| a stream | `?source=socket&url=ws://localhost:8787` |

A Python run supplies its own `rules.json` alongside its events; point the
viewer at it with `?rules=/path/to/rules.json`.

`docs/format.md` is the contract. `python/iressa_format.py` implements it, and
`tests/pythonFormat.test.ts` checks the two implementations against each other
byte for byte rather than each against its own idea of the format.

## Reading the numbers

The *structure* of `rules.json` is meant to survive contact with the real
simulation; several of the *values* in it were chosen so that a 60-day run shows
something, and should be replaced rather than cited.

- **Mutation rates** (`2e-5` and `8e-6` per division) are orders of magnitude
  above real somatic rates. At a realistic rate no resistant clone would appear
  in 44 000 divisions, and the relapse — the thing worth looking at — would
  never happen. This is the number to change first when real models arrive.
- **The fields are in normalised lattice units.** `oxygen.diffusion` is a
  per-sweep lattice coefficient (above 1/6 the 6-point Laplacian goes unstable,
  which the schema enforces), oxygen runs 0–1 against the boundary supply, and
  drug concentrations are on whatever scale the IC50s are. A plasma reading of
  1.48 means "1.48 of the same units as the IC50s", not ng/mL.
- **`immune.killPerHour`** is a flat surface-only hazard, not an immune model.
  It exists so the immune-kill cause is exercised; it is the most obviously
  placeholder parameter in the file.
- **Pharmacokinetics** is one compartment with first-order absorption. The
  half-life is gefitinib's; the dose is normalised.

What is meant to be taken seriously is that none of these live in code: the
hypoxic core, the treatment response, the relapse and the radiation effect are
all consequences of this file, and replacing a value changes them.

## Oxygen Controls

The viewer uses plain-language oxygen controls:

| Control | Meaning |
|---|---|
| Blood delivery | how strongly vessels add oxygen to nearby tissue |
| Cell consumption | how quickly living cells remove oxygen |
| More flow | more vessel supply and less hypoxia pressure |
| Low flow | reduced supply and stronger oxygen stress |
| Starved | severe oxygen stress; sustained low oxygen can cause necrosis |

In the model, oxygen is not a cure. It is a resource field. High oxygen lets
cells keep cycling; intermediate oxygen slows or arrests them; very low oxygen
for long enough causes hypoxic necrosis.

## Performance

Five draw calls for the whole scene: one G-buffer pass over the isosurface,
the cells, the nuclei and the vessels, then one pass that turns it into the
image. Only the cells the cut exposes are instanced - a few thousand of them -
and the rest of the mass is the isosurface, which is both what makes it
affordable and what stops a distant tumour reading as a cloud of dots. Preset
parameters ride along as per-instance attributes, so an event touches only the
slots it changed. The oxygen and drug fields are relaxed only inside a box
around the tumour.

The knobs that matter if you change the grid: `cell.detail` (0 is 20 triangles
per cell, 1 is 80, 2 is 320), `cell.slabVoxels` and each view's own
`slabVoxels`, and `oxygen.relaxSweepsPerTick`. `docs/rendering.md` explains the architecture.
