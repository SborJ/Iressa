# EGFR-Mutant Lung Cancer Resistance Simulator

> **Validation status (branch `sim-validation`).** The engine was audited and corrected in
> Phase 1; see `docs/validation/VALIDATION_REPORT.md`. Result tables further down this file
> were produced by the pre-validation engine, whose drug field did not reach the cells and whose
> oxygen solver was unconverged; treat them as superseded. Defaults changed: physical quasi-steady
> drug transport, converged oxygen solver, vessels at 150 um spacing, dead-cell clearance
> 0.25/day, k_max derived from the 72 h assay definition, resistant clones inherit parent growth.
> `numpy` is now required (`pip install -r requirements.txt`).
>
> **Viewer integration (branch `engine-viewer-integration`).** The engine was extended from a 2D
> section to a 3D volume with the same rules and exports runs in the 3D viewer's recorded-run
> format (`scripts/export_iressa_run.py`); see `docs/validation/VIEWER_INTEGRATION.md`.


## Current Status

This project is now a working research-demo scaffold for visualizing treatment-driven tumor evolution in EGFR-mutant lung cancer.

It includes:

- calibrated data-preparation pipeline,
- clone and resistance-graph definitions,
- cellular automata tumor engine,
- oxygen and drug diffusion fields,
- cell-state dynamics,
- division and mutation-on-division,
- treatment schedules,
- real-time visualization,
- post-run summary plots,
- CSV history outputs.

The simulator is educational and exploratory. It is **not** a clinical treatment optimizer.

## Biological Story

The modeled resistance sequence is:

```text
EGFR-sensitive tumor
  -> gefitinib / erlotinib pressure
  -> EGFR T790M resistance
  -> osimertinib pressure
  -> EGFR C797S or MET amplification resistance
```

## Clone Types

The current clone templates are:

| Clone | Alterations | Main Phenotype |
| --- | --- | --- |
| `EGFR` | EGFR exon19del or L858R | sensitive to EGFR inhibitors |
| `T790M` | EGFR + T790M | gefitinib resistant, osimertinib sensitive |
| `C797S` | EGFR + T790M + C797S | osimertinib resistant |
| `MET_AMP` | EGFR + MET amplification | bypass resistance |

## Drugs

The simulator currently supports:

| Drug | Role |
| --- | --- |
| `gefitinib` | first-generation EGFR inhibitor |
| `osimertinib` | third-generation EGFR inhibitor, active against T790M |
| `capmatinib` | MET inhibitor demo drug for MET-amplified resistance |

`capmatinib` is currently included as an explicitly assumed demo parameter until real drug-response data is ingested.

## Data And Calibration Pipeline

Create or update the raw-data acquisition manifest:

```bash
python3 scripts/fetch_raw_data.py
```

Normalize the official Cell Model Passports downloads into the simulator's
focused EGFR/MET lung-cancer raw table:

```bash
python3 scripts/normalize_passports_raw_data.py
```

Run:

```bash
python3 scripts/prepare_data.py
```

The pipeline is modular:

```text
cancer_sim/calibration/
  ingest/
    gdsc.py
    passports.py
    civic.py
    cbioportal.py
  schema.py
  clones.py
  physics.py
  validation.py
  report.py
  pipeline.py
```

It writes:

```text
data/processed/models.csv
data/processed/alterations.csv
data/processed/drug_response.csv
data/processed/civic_evidence.csv
data/processed/model_drug_evidence.csv
data/processed/clone_model_matches.csv
data/processed/calibrated_clone_parameters.json
data/processed/calibrated_clone_parameters.csv
data/processed/resistance_graph.json
data/processed/physics_calibration.json
data/processed/calibration_report.md
```

The simulator now uses `data/processed/calibrated_clone_parameters.json` as the
default runtime source for clone biology. If processed calibrated files are
missing, run `scripts/prepare_data.py`.

Each calibrated value tracks whether it is:

- `measured`,
- `literature_derived`,
- `inferred`,
- `assumed`.

Important rule:

```text
measured data != literature evidence != simulation assumption
```

Current raw-data audit:

| Source | Rows | Status |
| --- | ---: | --- |
| GDSC drug response | 242036 | present |
| Cell Model Passports target alterations | 17 | present, normalized from official CMP downloads |
| CIViC evidence | 69 | present |
| cBioPortal NSCLC EGFR/MET alterations | 777 | present |

Audit raw inputs:

```bash
python3 scripts/audit_raw_data.py
```

Expected raw-file schemas are documented in:

```text
data/raw/README.md
```

Current calibration status:

| Parameter | Current status |
| --- | --- |
| EGFR gefitinib IC50 | measured from GDSC/CMP matched models, n=4 |
| EGFR osimertinib IC50 | measured from GDSC/CMP matched models, n=4 |
| T790M gefitinib IC50 | measured from GDSC/CMP matched model, n=1 |
| T790M osimertinib IC50 | measured from GDSC/CMP matched model, n=1 |
| C797S osimertinib resistance | literature-supported, numeric IC50 still assumed |
| MET amplification resistance | literature-supported, numeric EGFR-inhibitor IC50 still assumed |
| MET capmatinib IC50 | assumed demo value |
| clone growth rate | measured for EGFR and T790M matched CMP models; assumed for C797S and MET_AMP |
| fitness cost | not applied for measured-growth clones; assumed for fallback-growth clones |
| mutation probability | assumed |

## Physics

The simulator uses a 2D cellular automata lattice.

Each site can contain:

```text
Cell:
    clone_id
    state = proliferating | quiescent | necrotic
    age
    death_cause
    oxygen_stress_time
```

Oxygen and drug are continuous scalar fields over the lattice.

### Oxygen

Oxygen uses a quasi-steady iterative field solve with:

- diffusion,
- vessel source,
- cellular uptake,
- optional Michaelis-Menten uptake.

Cell behavior depends on oxygen:

```text
high oxygen        -> proliferating
intermediate      -> quiescent
sustained low O2  -> hypoxic necrosis
```

Hypoxic necrosis is delayed by `necrosis_exposure_time`, so cells must remain oxygen-starved before dying.

### Drug

Drug uses explicit diffusion with automatic stability/time substeps. It evolves through:

- diffusion,
- vessel source,
- decay,
- cellular uptake.

Local drug concentration is converted into clone-specific death probability using a Hill response:

```text
E(C) = C^n / (IC50^n + C^n)
P_death = 1 - exp(-k_max * E(C) * dt)
```

The previous hidden scaling `local_drug * 10000` has been removed. Drug concentration scaling now comes from explicit vessel concentration settings in `physics_calibration.json`.

The simulator now separates timescales:

```text
field substeps        -> minutes to hours, controlled by --field-substep-minutes
biological dt         -> days, controlled by --dt-days
experiment horizon    -> days, controlled by --days
```

Division uses:

```text
P_division = 1 - exp(-growth_rate_per_day * dt_days)
```

Drug killing uses:

```text
P_death = 1 - exp(-k_max_per_day * E(C) * dt_days)
```

Hypoxic exposure time is also measured in days.

## Cellular Automata Rules

Each simulation step:

1. update oxygen and drug fields,
2. assign cell state from local oxygen,
3. apply hypoxic death if oxygen starvation persists,
4. apply drug-response death,
5. divide proliferating cells if empty Moore-neighborhood space exists,
6. mutate only on daughter-cell creation,
7. record clone counts, burden, deaths, births, mutations, oxygen, and drug.

There is currently **no active migration**.

## Mutation And Resistance Graph

Allowed transitions:

```text
EGFR -> T790M
EGFR -> MET_AMP
T790M -> C797S
T790M -> MET_AMP
```

No arbitrary mutations are generated.

Mutation probabilities are explicitly simulation assumptions. cBioPortal prevalence is **not** converted into per-division mutation probability.

## Treatment Schedules

Available schedules:

```text
none
continuous-gefitinib
continuous-osimertinib
continuous-capmatinib
gefitinib-osimertinib
osimertinib-capmatinib
adaptive-gefitinib
adaptive-osimertinib
adaptive-capmatinib
```

Adaptive schedules use an AT50-style rule:

```text
stop treatment at 50% of initial burden
restart at 100% of initial burden
```

## Oxygen Controls

The model can be run under different oxygen environments:

```bash
python3 scripts/watch_simulation.py --oxygen-mode vascular
python3 scripts/watch_simulation.py --oxygen-mode hypoxic
python3 scripts/watch_simulation.py --oxygen-mode necrotic
```

Fine controls:

```bash
--oxygen-source
--oxygen-uptake
--oxygen-vmax
--oxygen-prolif-threshold
--oxygen-necrosis-threshold
--necrosis-exposure-time
--hypoxic-death-rate
```

## Real-Time Visualization

Run:

```bash
python3 scripts/watch_simulation.py --schedule gefitinib-osimertinib --days 60 --dt-days 0.5
```

Useful examples:

```bash
python3 scripts/watch_simulation.py --schedule gefitinib-osimertinib --field oxygen --interval 0.12
python3 scripts/watch_simulation.py --schedule osimertinib-capmatinib --field drug --interval 0.12
python3 scripts/watch_simulation.py --schedule none --oxygen-mode necrotic --field oxygen
```

The live dashboard shows:

- clone/state lattice,
- oxygen or drug heatmap,
- tumor burden curve,
- clone-count curves.

Cell colors distinguish:

- living clones,
- hypoxic necrosis,
- drug-killed cells.

## Batch Simulation

Run:

```bash
python3 scripts/run_simulation.py --schedule gefitinib-osimertinib --days 120 --dt-days 1
```

Outputs a CSV history containing:

- time in days,
- active drug,
- dose,
- tumor burden,
- clone counts,
- births,
- mutations,
- drug deaths,
- hypoxic deaths,
- proliferating/quiescent/necrotic counts,
- mean oxygen,
- mean drug.

## Experiment Panel

Run:

```bash
python3 scripts/run_experiment_panel.py --days 120 --dt-days 1
```

The experiment panel compares schedules such as no treatment, continuous
gefitinib, gefitinib to osimertinib, adaptive treatment, and MET-targeting
follow-up schedules.

It writes:

```text
outputs/experiment_panel/experiment_metrics.csv
outputs/experiment_panel/01_none.csv
outputs/experiment_panel/02_continuous-gefitinib.csv
...
```

Metrics include:

- time to progression,
- minimum burden,
- final burden,
- resistant fraction,
- time to resistant dominance,
- cumulative dose,
- total drug deaths,
- total hypoxic deaths.

Create a cross-experiment metrics figure:

```bash
python3 scripts/plot_experiment_metrics.py --input outputs/experiment_panel/experiment_metrics.csv
```

The figure compares:

- time to progression,
- cumulative dose,
- final resistant fraction,
- minimum burden,
- final burden.

Latest recalibrated four-schedule run over 30 biological days:

| Schedule | Final burden | Minimum burden | Resistant fraction | Cumulative dose | Time to progression |
| --- | ---: | ---: | ---: | ---: | ---: |
| continuous-gefitinib | 125 | 125 | 0.112 | 27.0 | not reached |
| gefitinib-osimertinib | 125 | 125 | 0.112 | 27.0 | not reached |
| adaptive-gefitinib | 128 | 128 | 0.133 | 18.0 | not reached |
| osimertinib-capmatinib | 110 | 110 | 0.145 | 27.0 | not reached |

At 30 days, `gefitinib-osimertinib` is identical to continuous gefitinib
because the default switch time is 40 days.

Inspect treatment switches and clone counts:

```bash
python3 scripts/inspect_treatment_timeline.py --input outputs/experiment_panel/01_gefitinib-osimertinib.csv --every 20
```

Example 60-day sequential schedule audit:

| Day | Active drug | EGFR | T790M | C797S | MET_AMP | Burden | Event |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | gefitinib | 295 | 28 | 4 | 11 | 338 | start |
| 40 | gefitinib | 93 | 8 | 1 | 3 | 105 | checkpoint |
| 41 | osimertinib | 89 | 8 | 1 | 2 | 100 | drug_switch |
| 60 | osimertinib | 47 | 5 | 0 | 0 | 52 | checkpoint |

Run horizon sweeps:

```bash
python3 scripts/run_duration_sweep.py --horizons 30,60,120,240 --dt-days 1
```

Full-grid results completed through 120 days:

| Horizon | Schedule | Final burden | Resistant fraction | Cumulative dose | Time to progression |
| ---: | --- | ---: | ---: | ---: | --- |
| 30 | continuous-gefitinib | 125 | 0.112 | 27.0 | not reached |
| 30 | gefitinib-osimertinib | 125 | 0.112 | 27.0 | not reached |
| 30 | adaptive-gefitinib | 128 | 0.133 | 18.0 | not reached |
| 30 | osimertinib-capmatinib | 110 | 0.145 | 27.0 | not reached |
| 60 | continuous-gefitinib | 59 | 0.068 | 54.0 | not reached |
| 60 | gefitinib-osimertinib | 52 | 0.096 | 54.0 | not reached |
| 60 | adaptive-gefitinib | 61 | 0.098 | 18.0 | not reached |
| 60 | osimertinib-capmatinib | 57 | 0.070 | 54.0 | not reached |
| 120 | continuous-gefitinib | 35 | 0.086 | 108.0 | not reached |
| 120 | gefitinib-osimertinib | 23 | 0.174 | 108.0 | not reached |
| 120 | adaptive-gefitinib | 47 | 0.064 | 18.0 | not reached |
| 120 | osimertinib-capmatinib | 41 | 0.024 | 108.0 | not reached |

Focused 240-day pair comparison:

| Horizon | Schedule | Final burden | Resistant fraction | Cumulative dose | Time to progression |
| ---: | --- | ---: | ---: | ---: | --- |
| 240 | continuous-gefitinib | 33 | 0.091 | 216.0 | not reached |
| 240 | gefitinib-osimertinib | 23 | 0.043 | 216.0 | 201 |

The latest cross-experiment figure is:

```text
outputs/experiment_panel/experiment_metrics.png
```

## Repeated Stochastic Experiments

Run repeated seeds for treatment comparisons:

```bash
python3 scripts/run_repeated_experiments.py --days 120 --dt-days 0.5 --seeds 20
```

It writes:

```text
outputs/repeated_experiments/replicate_metrics.csv
outputs/repeated_experiments/replicate_summary.csv
```

The summary reports median and IQR across seeds for:

- final burden,
- minimum burden,
- final resistant fraction,
- maximum resistant fraction,
- cumulative dose,
- total drug deaths,
- total hypoxic deaths,
- progression rate,
- median time to progression when progression occurs.

Current smoke test:

```bash
python3 scripts/run_repeated_experiments.py --days 30 --dt-days 1 --seeds 3 --width 24 --height 18 --cells 100 --schedules continuous-gefitinib,gefitinib-osimertinib --output-dir outputs/repeated_smoke
```

At 30 days, continuous gefitinib and gefitinib-to-osimertinib remain identical
across the smoke seeds because the default osimertinib switch occurs at day 40.

## Sensitivity Panel

Run one-factor sensitivity sweeps over assumed parameters:

```bash
python3 scripts/run_sensitivity_panel.py --days 120 --dt-days 0.5 --seeds 20
```

It writes:

```text
outputs/sensitivity_panel/sensitivity_metrics.csv
outputs/sensitivity_panel/sensitivity_summary.csv
```

The current panel varies:

- mutation probability scale,
- starting resistant clone fraction,
- C797S growth scale,
- MET amplification growth scale,
- C797S fitness cost,
- MET amplification fitness cost,
- vessel drug concentration scale,
- oxygen uptake.

Current smoke test:

```bash
python3 scripts/run_sensitivity_panel.py --days 10 --dt-days 1 --seeds 1 --width 18 --height 14 --cells 60 --schedules continuous-gefitinib --output-dir outputs/sensitivity_smoke
```

On the short smoke run, vessel concentration and starting resistant fraction
change the observed output immediately, while mutation-scale and rare-clone
growth changes mostly require longer horizons before they matter.

## Summary Plots

Create a post-run figure:

```bash
python3 scripts/plot_simulation_summary.py --input outputs/simulation_history.csv
```

The summary plot includes:

- tumor burden,
- clone counts,
- clone fractions,
- treatment timeline.

## Tests

Run:

```bash
python3 -m unittest discover -s tests
```

Current status:

```text
Python engine/export tests and TypeScript viewer tests pass on main.
```

## Reinforcement Learning Plan

The planned RL layer is documented in:

```text
docs/rl-treatment-design.md
```

The first learning baseline should be PPO over the existing simulator, with:

- fixed schedule policies as baselines,
- summary observations first rather than full 3D fields,
- discrete treatment actions first,
- reward components reported separately,
- 20-100 held-out seeds for evaluation,
- no clinical recommendation language.

Oxygen should be part of the RL observation through mean oxygen, low-oxygen
fraction, necrotic fraction, and recent hypoxic deaths.

## Important Limitations

- Raw public datasets are now present, but the calibration is still sparse for rare resistance states.
- EGFR and T790M IC50s are measured from matched GDSC/CMP models; C797S, MET_AMP, capmatinib response, fallback-growth fitness costs, and mutation probabilities still use fallback assumptions.
- Physical diffusion coefficients are recorded and the runtime no longer uses one unstable explicit diffusion step, but the field model is still a simplified research-demo approximation.
- The model is not clinically calibrated.
- No active migration is implemented.
- No real pharmacokinetic model is implemented.
- Capmatinib is included as a MET-inhibitor demonstration, not yet calibrated from measured data.

## Recommended Next Steps

1. Run full repeated stochastic comparisons with 20-100 seeds over 120-240+ day horizons.
2. Run the sensitivity panel at 120-240+ days and identify which assumptions dominate outcomes.
3. Build a Gymnasium-style RL environment and PPO baseline around the same action/schedule interface.
4. Add PK-style drug exposure curves instead of constant vessel concentration.
5. Improve rare-state calibration for C797S, MET_AMP, and capmatinib response.
6. Add tests/plots that compare explicit-substep drug transport against an implicit reference solve.
