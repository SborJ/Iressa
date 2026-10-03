# Connecting the validated engine to the 3D viewer

Branch `engine-viewer-integration` (from `data-driven-events`). The Python engine validated in
Phase 1 (`cancer_sim`, `docs/validation/VALIDATION_REPORT.md`) now produces recorded runs in the
viewer's own format, so the tissue the viewer draws is a run of the calibrated model, not of the
TypeScript stand-in. The viewer's design is unchanged: same event contract, same `rules.json`
vocabulary, same vascular tree, same renderer.

## What flows where

```
rules.json (viewer template)  ─┐
calibrated_clone_parameters.json│   cancer_sim (engine, 2D or 3D)      python/iressa_format.py
resistance_graph.json          ─┼─▶ build_runner(record_events=True) ─▶ EventWriter / Keyframe ─▶ data/runs/<name>/
physics_calibration.json       ─┘   cancer_sim/iressa_export.py                                   rules.json · run.events · run.keyframes
                                                                                                   history.csv · summary.json
                                                                                                             │
                                               npm run dev   ?source=file&rules=…&events=…&keyframes=…  ◀────┘
```

The engine is not modified by the exporter. It gained an optional event log
(`CellularAutomataPhysics(record_events=True)`) that observes what the existing rules do; with
recording off the step is unchanged.

## The 3D extension

The validated engine was a 2D section. To drive a volumetric viewer honestly the same rules were
generalised to a volume, not faked by extrusion:

| rule | 2D (validated) | 3D |
| --- | --- | --- |
| division target | empty Moore neighbour (8) | empty Moore neighbour (26) |
| oxygen / drug fields | five-point quasi-steady solve to tolerance | seven-point quasi-steady solve to tolerance; same coefficients |
| vessels | capillary cross-sections on a 150 µm grid | the viewer's branching tree (Python port of `src/sim/vasculature.ts`), lumen voxels are sources, lumen + wall voxels are blocked for cells; or straight parallel capillaries (Krogh arrangement) |
| seeding | disc | sphere |
| everything else (states, death, clearance, mutation, schedules, parameters) | identical code path | identical code path |

A 1-deep volume reproduces the 2D stencil exactly (`test_one_deep_volume_uses_the_2d_stencil`),
so 2D results are those of the validated engine except for one deliberate change made for both
geometries: cells may no longer divide into a vessel voxel (they could before). The 2D validation
suite was re-run after this change (`outputs/validation`, report re-rendered).

What was checked for 3D (`tests/test_physics_validation.py::VolumeSolverTest`,
`tests/test_scientific_invariants.py::VolumeSanityTests`): the solver against a dense direct solve
of the 3D system, bookkeeping sums, converged and bounded fields, no cell in a vessel voxel,
untreated growth, gefitinib selecting T790M. What was **not** done for 3D: the multi-seed
battery, horizon and dt convergence, pre-existing/acquired resistance sweeps and the sensitivity
analysis. Those remain 2D results; 3D runs are demonstrations of the same rules in a volume.

Vessel density in 3D is set by the tree parameters (default 10 trunks, depth 6 at 48³ × 20 µm,
mean distance from tissue to a lumen ≈ 120 µm), chosen so the tissue sits inside the 100-200 µm
intercapillary range used in 2D (Thomlinson & Gray 1955). It is literature-derived, not measured.

## Vocabulary mapping (engine → viewer)

| engine | viewer (`rules.json`) |
| --- | --- |
| clone `EGFR`, `T790M`, `C797S`, `MET_AMP` | clone ids 0, 1, 2, 3 (names and `derivesFrom` follow the resistance graph) |
| state `proliferating`, `quiescent`, `necrotic` (dead, occupying) | state roles `cycling`, `arrested`, `dying` |
| division (daughter placed) | type 1 `divide`, cause `normalCycle`, `b` = daughter node |
| daughter mutated at birth | type 1 `divide` with the parent clone, then type 4 `mutate` on the daughter (old → new), cause `mutation` |
| hypoxic death | type 2 `death start`, cause `hypoxicNecrosis` |
| drug death | type 2 `death start`, cause `drugApoptosis`, `b` = drug id (gefitinib 0, osimertinib 1, capmatinib 2) |
| dead cell cleared | type 3 `removed`, same cause and drug |
| oxygen-driven quiescence / recovery | type 5 `state change` → `arrested` (cause `hypoxiaArrest`) / → `cycling` (cause `normalCycle`) |
| no free neighbour at division | type 5 `state change` → `arrested`, cause `crowdingArrest` |
| engine step `dt` (default 6 h) | 12 ticks of 30 min; all of a step's events carry the step's end tick |
| keyframes | tick 0 plus one per `keyframe_every_days` at tick `step_end + 1` (a tick without events), i.e. the state after that step, matching "state at the start of its tick" |
| 2D section | exported as the middle plane (z = 1) of a 3-deep box, since the viewer needs `nz ≥ 3` |
| vessels | `vasculature.segments` written from the Python tree; the viewer rasterises them with its own `stamp` (`src/sim/vasculature.ts` gained the `segments` branch) |
| treatment | `treatment.schedule` entries derived from the actual dosing history (one per contiguous drug block), so adaptive schedules show their real on/off pattern |

All ids are resolved by role through `ids_by_role` from the template, never hard-coded.
`rules.json` also carries `provenance` blocks (root, per clone, per mutation) with the Phase 1
statuses; the schema was extended to allow them and the viewer ignores them.

## Viewer-side changes (small, additive)

* `src/sim/vasculature.ts`: if `rules.vasculature.segments` is present, rasterise those instead of growing (same `stamp`).
* `src/sim/rules.ts`: `VasculatureSpec.segments` type.
* `data/schema/rules.schema.json`: `vasculature.segments`, optional `provenance` objects.
* `data/visuals.json`: a fourth clone colour in every palette (C797S, id 3).

All 65 viewer tests pass unchanged.

## Tests

| file | what |
| --- | --- |
| `tests/test_iressa_export.py` | a 3D tree run and a 2D run replay from the tick-0 keyframe through `run.events` to exactly the engine's final matrix; every later keyframe equals the replay at its tick; `rules.json` validates against the viewer schema; schedule markers follow the actual drugs |
| `tests/pythonFormat.test.ts` (viewer) | the Python format module and the TypeScript one agree byte for byte |
| `tests/test_physics_validation.py`, `tests/test_scientific_invariants.py` | 2D and 3D solver and biology checks (see above) |

## Running

```bash
pip install -r requirements.txt            # numpy, matplotlib (jsonschema, websockets for tests/streaming)
python3 scripts/export_iressa_run.py --name demo48 --schedule gefitinib-osimertinib --size 48 --cells 1500 --days 60
npm install && npm run dev
# open the URL the exporter prints, e.g.
# http://localhost:5173/?source=file&rules=/runs/demo48/rules.json&events=/runs/demo48/run.events&keyframes=/runs/demo48/run.keyframes
```

`--depth 1` exports the validated 2D section; `--vasculature grid` uses parallel capillaries;
`--schedule adaptive-gefitinib` etc. select the treatment policy. Exported runs live in
`data/runs/` (git-ignored).

Streaming instead of files: `python3 python/serve.py data/runs/demo48/run.events data/runs/demo48/run.keyframes`
and open `/?source=socket&host=localhost&port=8787&rules=/runs/demo48/rules.json`. The Vite dev
server answers 403 to query strings that contain a `ws://` URL (or a `host:port` pair), so the
viewer also accepts `host` and `port` parameters and assembles the address itself (`src/main.ts`).

## Limitations

* The viewer's hover card shows oxygen and drug values only for the stand-in simulator; for a
  recorded run it shows state and cause.
* Simulated time runs on in-vitro doubling times; the banner states it is not patient time.
* 3D runs are demonstrations of the validated rules in a volume; the statistical validation is 2D.
