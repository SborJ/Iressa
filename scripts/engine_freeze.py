#!/usr/bin/env python3
"""Record or verify the frozen scientific engine.

    python3 scripts/engine_freeze.py --write     # after Phase 1 passes
    python3 scripts/engine_freeze.py             # verify (exit 1 on any change)

The manifest lists sha256 hashes of every file that defines scientific
behaviour. Phase 2 (UI integration) must not change any of them; the test in
tests/test_engine_freeze.py enforces this.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "docs" / "validation" / "engine_freeze.json"

PROTECTED = [
    "cancer_sim/automata.py",
    "cancer_sim/fields.py",
    "cancer_sim/world.py",
    "cancer_sim/world_seed.py",
    "cancer_sim/simulation.py",
    "cancer_sim/experiments.py",
    "cancer_sim/vasculature.py",
    "cancer_sim/calibration/clones.py",
    "cancer_sim/calibration/targets.py",
    "cancer_sim/calibration/pipeline.py",
    "cancer_sim/calibration/validation.py",
    "cancer_sim/calibration/ingest/gdsc.py",
    "cancer_sim/calibration/ingest/passports.py",
    "cancer_sim/calibration/ingest/civic.py",
    "cancer_sim/calibration/ingest/cbioportal.py",
    "data/curated/egfr_resistance_seed.json",
    "data/config/physics_calibration.json",
    "data/processed/calibrated_clone_parameters.json",
    "data/processed/resistance_graph.json",
    "data/processed/physics_calibration.json",
    "data/raw/cell_model_passports_mutations.csv",
]


def hashes() -> dict[str, str]:
    out = {}
    for rel in PROTECTED:
        path = ROOT / rel
        out[rel] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else "MISSING"
    return out


def verify() -> list[str]:
    if not MANIFEST.exists():
        return ["engine_freeze.json missing; run scripts/engine_freeze.py --write after Phase 1"]
    recorded = json.load(open(MANIFEST))["files"]
    current = hashes()
    problems = []
    for rel, digest in current.items():
        if rel not in recorded:
            problems.append(f"{rel}: not in freeze manifest")
        elif recorded[rel] != digest:
            problems.append(f"{rel}: changed since the engine was frozen")
    for rel in recorded:
        if rel not in current:
            problems.append(f"{rel}: in manifest but no longer protected")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    if args.write:
        import datetime
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps({
            "frozen_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "note": "Phase 1 validated engine. Any change to these files requires re-running the validation suite and updating this manifest deliberately.",
            "files": hashes()
        }, indent=2) + "\n")
        print(f"wrote {MANIFEST}")
        return 0
    problems = verify()
    for problem in problems:
        print(problem)
    print("engine unchanged" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
