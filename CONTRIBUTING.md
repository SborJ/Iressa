# Contributing to Iressa

Thanks for wanting to help. Bug reports, scientific corrections, new cancer
models and code are all welcome.

## Setup

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cp .env.example .env.local     # see docs/research-access.md
npm run dev
```

The RL pipeline needs more: `.venv/bin/pip install -r requirements-rl.txt`.

## Before you open a pull request

```bash
npm run typecheck
npm test
.venv/bin/python -m pytest -q
```

CI runs the same three, plus `npm run build`. If your change is visible, open
the viewer and look at it; a screenshot in the pull request helps reviewers.

## The rules of the house

**Numbers live in data, not in code.** Every rate, threshold, probability and
schedule belongs in `data/rules.json` or a model file in `cancer_sim/cancers/`.
Every colour and animation belongs in `data/visuals.json`. The renderer and
the UI must stay free of biology. If you find yourself typing a constant into
`src/render/` or `src/ui/`, it belongs in a data file.

**Every model value carries its provenance.** Label new or changed parameters
`DIRECT`, `DERIVED`, `INFERRED` or `ASSUMPTION`, and give the source. An
honest assumption is fine. An unlabelled one is not.

**The engine core is frozen.** The files listed in
`docs/validation/engine_freeze.json` (the automaton, the field solvers, the
world, the schedules and the calibration pipeline) were validated as a unit
(`docs/validation/VALIDATION_REPORT.md`), and `tests/test_engine_freeze.py`
fails if one changes. Changes there need a reason, a test, a re-run of
`scripts/run_validation_suite.py` and a refreshed freeze
(`scripts/engine_freeze.py`).

**The event format is a contract.** `docs/format.md` is implemented twice, in
`src/format/` and `python/iressa_format.py`, and the tests compare them byte
for byte. Change both together or neither.

**Keep the language careful.** This is a research model. Write "the simulated
tumour stays controlled", not "the treatment works". Nothing in the project
should read as advice for a patient.

## Common tasks

- **Add a cause of death or arrest:** `docs/adding-a-cause.md`. No code needed.
- **Add a cancer model:** copy a file in `cancer_sim/cancers/`, then follow
  `docs/breast_er_positive.md` for what a complete model documents.
- **Record a run for the viewer:** `scripts/export_iressa_run.py --help`.

## Raw data

Files under `data/raw/` are hashed in `data/processed/data_manifest.json`.
Do not reformat them or change their line endings. To refresh them, use
`scripts/fetch_raw_data.py` and re-run `scripts/prepare_data.py`.

## Conduct

Be kind and assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
