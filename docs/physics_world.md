# World Physics Foundation

This is the world physics layer for the resistance simulator. It defines the
geometry, scalar fields, and first cellular automata physics step. It includes
space-limited division and mutation-on-division, but does not yet implement
active migration or treatment optimization.

## World

The world is a rectangular 2D lattice. Each lattice site may hold one `Cell` or
remain empty.

```text
Cell:
    clone_id
    state = proliferating | quiescent | necrotic
    age
```

Clone identity tracks the genetic/drug phenotype. Cell state tracks local
oxygen physiology.

Default dimensions:

- width: `200`
- height: `200`
- cell size: `20 micrometers`

## Vessels

Vessels are fixed source points. They seed oxygen and drug concentration fields.
Later simulation steps can consume those fields, but vessel placement itself is
static.

## Scalar Fields

Oxygen and drug fields are computed from source points with radial exponential
falloff:

```text
field(x, y) = clamp(sum(source_strength * exp(-distance / length_scale)), 0, 1)
```

The static radial source field is used for previews. The cellular automata
engine in `cancer_sim/automata.py` adds iterative physics:

```text
O[t+1] = O[t] + dt * (D_O laplacian(O) - uptake(O, rho_cells) + vessel_source)
C[t+1] = C[t] + dt * (D_C laplacian(C) - decay*C - uptake*C*rho_cells + vessel_source)
```

Oxygen uptake can use either first-order uptake or Michaelis-Menten uptake.
Drug uptake uses first-order cellular uptake for the current MVP.

## Occupancy

Occupancy is state storage:

```text
empty | Cell(clone_id, state, age)
```

The cellular automata step applies oxygen-state rules:

```text
O > O_prolif        -> proliferating
O_nec < O <= O_prolif -> quiescent
O <= O_nec          -> necrotic
```

Only proliferating cells can divide. Division requires at least one empty
Moore-neighborhood site. There is no active migration in the current engine.

## Clone Response

At each occupied lattice site, local drug concentration can be converted into a
clone-specific effect using the Hill response:

```text
E(C) = C^n / (IC50^n + C^n)
P_death = 1 - exp(-k_max * E(C) * dt)
```

The current automata can apply death from drug or severe hypoxia.

## Division And Mutation

The update loop is:

```text
1. Update oxygen and drug fields.
2. Read local oxygen/drug for every living cell.
3. Assign proliferating, quiescent, or necrotic state from oxygen thresholds.
4. Apply drug-response and severe-hypoxia death probabilities.
5. For proliferating cells, sample division probability.
6. If division occurs, choose a free Moore-neighborhood site.
7. On daughter creation only, sample allowed resistance transitions.
8. Record births, mutations, deaths, state counts, burden, oxygen, and drug.
```

Allowed transitions are loaded from the curated resistance graph. The engine
does not generate arbitrary mutations.

## Treatment Experiments

`cancer_sim/simulation.py` keeps treatment policy separate from physics. A
schedule maps current time and burden to:

```text
drug, dose
```

Implemented schedules:

- no treatment,
- continuous gefitinib,
- continuous osimertinib,
- gefitinib to osimertinib switch,
- AT50-style adaptive gefitinib,
- AT50-style adaptive osimertinib.

Each run records burden, clone counts, cell-state counts, births, mutations,
deaths, mean oxygen, mean drug, and active treatment.

`scripts/watch_simulation.py` runs the same engine with a live Matplotlib
dashboard showing clone/state occupancy, oxygen or drug field, total burden, and
clone counts.

## Calibration Pipeline

`scripts/prepare_data.py` is now an orchestrator around source-specific ingesters
and calibration modules. It writes:

- normalized `models.csv`,
- normalized `alterations.csv`,
- normalized `drug_response.csv`,
- separate `civic_evidence.csv`,
- `calibrated_clone_parameters.json`,
- `resistance_graph.json`,
- `physics_calibration.json`,
- `calibration_report.md`.

Each calibrated parameter carries a status such as `measured`,
`literature_derived`, `inferred`, or `assumed`. Mutation probabilities remain
simulation assumptions; cBioPortal prevalence is not converted into per-division
mutation probability.
