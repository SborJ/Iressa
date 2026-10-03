#!/usr/bin/env python3
"""Run the validated engine and write a viewer-ready recorded run into data/runs/<name>/.

    python3 scripts/export_iressa_run.py --name demo --schedule gefitinib-osimertinib --days 60
    python3 scripts/export_iressa_run.py --name flat2d --depth 1 --width 50 --height 40 --cells 350

Then: npm run dev  and open the printed URL.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.experiments import ExperimentConfig  # noqa: E402
from cancer_sim.iressa_export import DEFAULT_3D_TREE, export_run  # noqa: E402
from cancer_sim.simulation import DRUGS  # noqa: E402

SCHEDULES = ("none", "continuous-gefitinib", "continuous-osimertinib", "continuous-capmatinib",
             "gefitinib-osimertinib", "osimertinib-capmatinib", "adaptive-gefitinib", "adaptive-osimertinib", "adaptive-capmatinib")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--name", default="demo")
    p.add_argument("--schedule", choices=SCHEDULES, default="gefitinib-osimertinib")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--size", type=int, default=48, help="lattice edge for a cubic 3D run")
    p.add_argument("--width", type=int, default=None)
    p.add_argument("--height", type=int, default=None)
    p.add_argument("--depth", type=int, default=None, help="1 for the validated 2D section")
    p.add_argument("--cells", type=int, default=1500)
    p.add_argument("--days", type=float, default=60.0)
    p.add_argument("--dt-days", type=float, default=0.25, help="engine step; must be a whole number of ticks")
    p.add_argument("--tick-minutes", type=float, default=30.0)
    p.add_argument("--keyframe-every-days", type=float, default=1.0)
    p.add_argument("--dose", type=float, default=0.9)
    p.add_argument("--switch-time", type=float, default=20.0)
    p.add_argument("--mutation-scale", type=float, default=50.0)
    p.add_argument("--resistant-fraction", type=float, default=0.08, help="initial T790M fraction (0-1)")
    p.add_argument("--vasculature", choices=("tree", "grid"), default="tree")
    p.add_argument("--vessel-spacing-um", type=float, default=150.0)
    p.add_argument("--voxel-um", type=float, default=20.0)
    p.add_argument("--trunks", type=int, default=DEFAULT_3D_TREE["trunks"])
    p.add_argument("--max-depth", type=int, default=DEFAULT_3D_TREE["maxDepth"])
    args = p.parse_args()

    width = args.width or args.size
    height = args.height or args.size
    depth = args.depth if args.depth is not None else args.size
    frac = min(max(args.resistant_fraction, 0.0), 0.95)
    config = ExperimentConfig(
        seed=args.seed, width=width, height=height, depth=depth, cells=args.cells,
        steps=int(round(args.days / args.dt_days)), dt=args.dt_days, dose=args.dose, switch_time=args.switch_time,
        mutation_scale=args.mutation_scale, clone_weights=(100.0 * (1 - frac), 100.0 * frac, 0.0, 0.0),
        vessel_spacing_um=args.vessel_spacing_um, vasculature=args.vasculature if depth > 1 else "grid",
        cell_size_um=args.voxel_um
    )
    spec = {**DEFAULT_3D_TREE, "trunks": args.trunks, "maxDepth": args.max_depth}
    t0 = time.time()

    def progress(step, total, rec):
        print(f"  step {step}/{total}  day {rec.time:.1f}  {rec.drug:12s} burden {rec.burden:6d}  "
              f"EGFR {rec.egfr} T790M {rec.t790m} C797S {rec.c797s} MET {rec.met_amp}  ({time.time() - t0:.0f}s)", flush=True)

    summary = export_run(config, args.schedule, name=args.name, tick_minutes=args.tick_minutes,
                         keyframe_every_days=args.keyframe_every_days, vasculature_spec=spec, progress=progress)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("config",)}, indent=2))
    print(f"\nopen: http://localhost:5173{summary['viewer_url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
