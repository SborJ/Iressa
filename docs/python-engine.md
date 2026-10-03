# Python engine (cancer_sim): original guide

> Vasil Vasilev's original README for the Python engine from the `simulator-integration` branch,
> kept for its command reference. The engine has since been validated and extended to 3D:
> see `docs/validation/VALIDATION_REPORT.md` and `docs/validation/VIEWER_INTEGRATION.md`.
> Result tables below predate the validation fixes and are superseded. The current default
> lattice uses vessels at a 150 um spacing and `numpy` is required.


This repository currently implements **Subtask A: Data preparation** and a
cellular automata **world physics foundation** for an EGFR-mutant lung cancer
resistance simulator.

The data-prep layer creates small, simulator-ready JSON and CSV files for clone
templates and source evidence. It is designed to work offline with a curated
seed dataset, while also accepting downloaded public exports from Cell Model
Passports/GDSC-style drug response tables, CIViC evidence, and cBioPortal cohort
alteration summaries.

## Run

Create the raw-data acquisition manifest:

```bash
python3 scripts/fetch_raw_data.py
```

```bash
python3 scripts/prepare_data.py
```

Outputs are written to `data/processed/`:

- `models.csv`
- `alterations.csv`
- `drug_response.csv`
- `civic_evidence.csv`
- `calibrated_clone_parameters.json`
- `calibrated_clone_parameters.csv`
- `resistance_graph.json`
- `physics_calibration.json`
- `calibration_report.md`
- `clone_templates.json`
- `clone_templates.csv`
- `resistance_evidence.csv`
- `data_manifest.json`

## Optional Raw Inputs

Place public exports in `data/raw/` using these names when available:

- `gdsc_drug_response.csv`
- `cell_model_passports_mutations.csv`
- `civic_evidence.csv`
- `cbioportal_alterations.csv`

The script tolerates missing files and falls back to curated seed records so the
next simulator task has stable inputs.

## Physics Foundation

The world layer is in `cancer_sim/world.py`. It defines:

- a 2D lattice world,
- fixed vessel sources,
- oxygen and drug scalar fields,
- cell occupancy with separate clone identity and cell state,
- local condition queries.

The cellular automata physics layer is in `cancer_sim/automata.py`. It adds:

- oxygen diffusion, vessel supply, and cell uptake,
- optional Michaelis-Menten oxygen consumption,
- drug diffusion, decay, vessel supply, and cell uptake,
- clone-specific Hill drug response using IC50 values,
- stochastic cell death from drug or severe hypoxia.
- oxygen-threshold cell states: proliferating, quiescent, necrotic,
- division only for proliferating cells with free Moore-neighborhood space,
- mutation only on daughter-cell creation using allowed resistance transitions.

It deliberately does not implement active migration or treatment scheduling yet.

Run a small physics smoke test:

```bash
python3 scripts/run_automata_smoke.py --seed 7 --steps 20
```

Run an upgraded treatment simulation and write CSV history:

```bash
python3 scripts/run_simulation.py --schedule gefitinib-osimertinib --steps 80
```

Watch a real-time Matplotlib simulation:

```bash
python3 scripts/watch_simulation.py --schedule gefitinib-osimertinib --steps 200
```

If necrotic/drug-killed cells appear too abruptly, slow the animation and show
the oxygen field:

```bash
python3 scripts/watch_simulation.py --schedule gefitinib-osimertinib --field oxygen --interval 0.15 --warmup-steps 10
```

Control oxygen pressure directly:

```bash
python3 scripts/watch_simulation.py --oxygen-mode vascular
python3 scripts/watch_simulation.py --oxygen-mode hypoxic
python3 scripts/watch_simulation.py --oxygen-mode necrotic
```

Fine-tune individual oxygen settings:

```bash
python3 scripts/watch_simulation.py --oxygen-source 0.5 --oxygen-vmax 0.02 --necrosis-exposure-time 12
```

For a non-interactive smoke run that writes a final PNG:

```bash
python3 scripts/watch_simulation.py --headless --steps 20
```

Available schedules:

- `none`
- `continuous-gefitinib`
- `continuous-osimertinib`
- `continuous-capmatinib`
- `gefitinib-osimertinib`
- `osimertinib-capmatinib`
- `adaptive-gefitinib`
- `adaptive-osimertinib`
- `adaptive-capmatinib`

Create a final summary plot from a simulation CSV:

```bash
python3 scripts/plot_simulation_summary.py --input outputs/simulation_history.csv
```

Run a treatment-comparison experiment panel:

```bash
python3 scripts/run_experiment_panel.py --steps 80
```

This writes per-schedule histories and `outputs/experiment_panel/experiment_metrics.csv`.

Plot cross-experiment metrics:

```bash
python3 scripts/plot_experiment_metrics.py --input outputs/experiment_panel/experiment_metrics.csv
```

Audit raw calibration inputs:

```bash
python3 scripts/audit_raw_data.py
```

## Mutation Flow Preview

Generate a seeded resistance lineage without running population or spatial
simulation:

```bash
python3 scripts/show_mutation_flow.py --seed 7
```

Print several deterministic variants:

```bash
python3 scripts/show_mutation_flow.py --seed 7 --variants 3
```

## Cell World Preview

Print a simple seeded terminal view of the static cell world:

```bash
python3 scripts/show_cell_world.py --seed 7
```

Render drug instead of oxygen as the background field:

```bash
python3 scripts/show_cell_world.py --seed 7 --field drug
```

Create a colored Matplotlib PNG:

```bash
python3 scripts/plot_cell_world.py --seed 7
```

The default output is `outputs/cell_world.png`.

## References

Project references live in `docs/references.md`.

## Tests

```bash
python3 -m unittest discover -s tests
```
