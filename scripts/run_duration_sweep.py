#!/usr/bin/env python3
"""Run experiment panels across multiple biological horizons."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.config_controls import add_microenvironment_args
from cancer_sim.experiments import ExperimentConfig, run_experiment_panel


DEFAULT_SCHEDULES = (
    "continuous-gefitinib",
    "gefitinib-osimertinib",
    "adaptive-gefitinib",
    "osimertinib-capmatinib"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--horizons", default="30,60,120,240", help="comma-separated days")
    parser.add_argument("--dt-days", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--dose", type=float, default=0.9)
    parser.add_argument("--switch-time", type=float, default=40.0)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument("--schedules", default=",".join(DEFAULT_SCHEDULES))
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "duration_sweep")
    add_microenvironment_args(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.dt_days <= 0:
        raise ValueError("--dt-days must be positive")
    horizons = [float(item.strip()) for item in args.horizons.split(",") if item.strip()]
    schedules = tuple(item.strip() for item in args.schedules.split(",") if item.strip())
    args.output_dir.mkdir(parents=True, exist_ok=True)

    all_rows = []
    for horizon in horizons:
        steps = int(round(horizon / args.dt_days))
        panel_dir = args.output_dir / f"{_label(horizon)}d"
        config = ExperimentConfig(
            seed=args.seed,
            width=args.width,
            height=args.height,
            cells=args.cells,
            steps=steps,
            dt=args.dt_days,
            dose=args.dose,
            switch_time=args.switch_time,
            mutation_scale=args.mutation_scale
        )
        metrics = run_experiment_panel(
            config=config,
            schedules=schedules,
            output_dir=panel_dir,
            microenvironment_args=args
        )
        for metric in metrics:
            row = metric.as_row()
            row["horizon_days"] = horizon
            row["dt_days"] = args.dt_days
            all_rows.append(row)
            print(
                f"{horizon:g}d,{metric.experiment},final={metric.final_burden},"
                f"resistant={metric.final_resistant_fraction:.3f},dose={metric.cumulative_dose:.1f},"
                f"progression={metric.time_to_progression if metric.time_to_progression is not None else ''}"
                ,
                flush=True
            )
        _write_rows(args.output_dir / "duration_sweep_metrics.csv", all_rows)

    summary_path = args.output_dir / "duration_sweep_metrics.csv"
    _write_rows(summary_path, all_rows)
    print(f"Wrote {summary_path}")
    return 0


def _write_rows(path: Path, rows: list[dict[str, int | float | str]]) -> None:
    if not rows:
        path.write_text("")
        return
    fieldnames = ["horizon_days", "dt_days"] + [
        key for key in rows[0].keys() if key not in {"horizon_days", "dt_days"}
    ]
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _label(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value).replace(".", "p")


if __name__ == "__main__":
    raise SystemExit(main())
