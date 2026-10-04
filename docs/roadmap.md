# Remaining Bottlenecks And Subtasks

## 1. Replace Fallback Biology With Real Calibration

Goal: reduce assumptions in clone parameters and clearly preserve provenance.

Subtasks:

1. Download or export raw GDSC / Cell Model Passports files into `data/raw/`.
2. Download or export CIViC evidence into `data/raw/civic_evidence.csv`.
3. Export cBioPortal/MSK-style alteration summaries into `data/raw/cbioportal_alterations.csv`.
4. Re-run `python3 scripts/prepare_data.py`.
5. Review `data/processed/calibration_report.md`.
6. Replace fallback IC50 values where measured records exist.
7. Keep growth rates, fitness costs, and mutation probabilities labeled as literature-derived or assumed unless directly supported by a specific source.
8. Add uncertainty ranges for measured values with multiple matching models.

Deliverable:

```text
data/processed/calibrated_clone_parameters.json
data/processed/calibration_report.md
```

## 2. Make Physics Numerically Defensible

Goal: separate biological timesteps from diffusion timesteps.

Subtasks:

1. Add diffusion substeps for oxygen and drug.
2. Add a quasi-steady oxygen option.
3. Keep drug exposure in explicit nM or normalized mode with recorded vessel concentration.
4. Add a warning/error when explicit diffusion coefficients exceed stability limits.
5. Add tests comparing one biological step with multiple diffusion substeps.
6. Later: add a pharmacokinetic exposure curve instead of constant vessel drug source.

Deliverable:

```text
cancer_sim/automata.py with stable diffusion stepping
data/processed/physics_calibration.json
```

## 3. Turn It Into An Experimental Platform

Goal: compare treatment policies and uncertain assumptions quantitatively.

Subtasks:

1. Run a panel of schedules:
   - no treatment,
   - continuous gefitinib,
   - gefitinib to osimertinib,
   - adaptive gefitinib,
   - continuous osimertinib,
   - osimertinib to capmatinib.
2. Compute:
   - time to progression,
   - minimum burden,
   - final burden,
   - resistant fraction,
   - time to resistant dominance,
   - cumulative dose,
   - total drug deaths,
   - total hypoxic deaths.
3. Write one CSV per run plus a metrics summary CSV.
4. Add summary plots across experiments.
5. Add sensitivity analysis over mutation scale, dose, oxygen mode, and starting resistant fraction.

Implemented now:

```bash
python3 scripts/run_experiment_panel.py
```

Outputs:

```text
outputs/experiment_panel/*_schedule.csv
outputs/experiment_panel/experiment_metrics.csv
```

