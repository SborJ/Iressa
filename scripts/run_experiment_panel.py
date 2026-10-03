#!/usr/bin/env python3
"""Run treatment-comparison experiments and write metrics."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.config_controls import add_microenvironment_args, vessel_spacing_from_args
from cancer_sim.automata import DEFAULT_NECROTIC_CLEARANCE_RATE
from cancer_sim.world_seed import DEFAULT_VESSEL_SPACING_UM
from cancer_sim.experiments import DEFAULT_PANEL, ExperimentConfig, run_experiment_panel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--days", type=float, default=120.0, help="experiment horizon in biological days")
    parser.add_argument("--dt-days", type=float, default=1.0, help="biological update interval in days")
    parser.add_argument("--steps", type=int, default=None, help="deprecated: use --days with --dt-days")
    parser.add_argument("--dt", type=float, default=None, help="deprecated: use --dt-days")
    parser.add_argument("--dose", type=float, default=0.9)
    parser.add_argument("--switch-time", type=float, default=40.0)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument(
        "--schedules",
        default=",".join(DEFAULT_PANEL),
        help="comma-separated schedule names"
    )
    add_microenvironment_args(parser)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "outputs" / "experiment_panel"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dt_days = args.dt if args.dt is not None else args.dt_days
    if dt_days <= 0:
        raise ValueError("--dt-days/--dt must be positive")
    steps = args.steps if args.steps is not None else int(round(args.days / dt_days))
    config = ExperimentConfig(
        seed=args.seed,
        width=args.width,
        height=args.height,
        cells=args.cells,
        steps=steps,
        dt=dt_days,
        dose=args.dose,
        switch_time=args.switch_time,
        mutation_scale=args.mutation_scale,
        vessel_spacing_um=vessel_spacing_from_args(args, DEFAULT_VESSEL_SPACING_UM),
        necrotic_clearance_rate=args.necrotic_clearance_rate if args.necrotic_clearance_rate is not None else DEFAULT_NECROTIC_CLEARANCE_RATE,
        drug_solver=args.drug_solver or "quasi_steady"
    )
    schedules = tuple(item.strip() for item in args.schedules.split(",") if item.strip())
    metrics = run_experiment_panel(
        config=config,
        schedules=schedules,
        output_dir=args.output_dir,
        microenvironment_args=args
    )

    print("experiment,final_burden,min_burden,resistant_fraction,cumulative_dose,time_to_progression")
    for item in metrics:
        print(
            f"{item.experiment},{item.final_burden},{item.minimum_burden},"
            f"{item.final_resistant_fraction:.3f},{item.cumulative_dose:.2f},"
            f"{'' if item.time_to_progression is None else item.time_to_progression}"
        )
    print(f"Wrote {args.output_dir / 'experiment_metrics.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
