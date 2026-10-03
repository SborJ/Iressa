#!/usr/bin/env python3
"""Run repeated stochastic treatment experiments and summarize median/IQR."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.config_controls import add_microenvironment_args
from cancer_sim.experiments import ExperimentConfig, calculate_metrics, run_single_experiment


DEFAULT_SCHEDULES = (
    "continuous-gefitinib",
    "gefitinib-osimertinib",
    "adaptive-gefitinib",
    "osimertinib-capmatinib"
)

SUMMARY_METRICS = (
    "final_burden",
    "minimum_burden",
    "final_resistant_fraction",
    "max_resistant_fraction",
    "cumulative_dose",
    "total_drug_deaths",
    "total_hypoxic_deaths"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=float, default=120.0)
    parser.add_argument("--dt-days", type=float, default=1.0)
    parser.add_argument("--seeds", type=int, default=20)
    parser.add_argument("--seed-start", type=int, default=1)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--dose", type=float, default=0.9)
    parser.add_argument("--switch-time", type=float, default=40.0)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument("--clone-weights", default="88,8,2,2")
    parser.add_argument("--c797s-growth-scale", type=float, default=1.0)
    parser.add_argument("--met-growth-scale", type=float, default=1.0)
    parser.add_argument("--c797s-fitness-cost", type=float, default=None)
    parser.add_argument("--met-fitness-cost", type=float, default=None)
    parser.add_argument("--vessel-concentration-scale", type=float, default=1.0)
    parser.add_argument("--schedules", default=",".join(DEFAULT_SCHEDULES))
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "repeated_experiments")
    add_microenvironment_args(parser)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.dt_days <= 0:
        raise ValueError("--dt-days must be positive")
    if args.seeds <= 0:
        raise ValueError("--seeds must be positive")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    schedules = tuple(item.strip() for item in args.schedules.split(",") if item.strip())
    clone_weights = _parse_clone_weights(args.clone_weights)
    steps = int(round(args.days / args.dt_days))

    raw_rows = []
    for seed in range(args.seed_start, args.seed_start + args.seeds):
        config = ExperimentConfig(
            seed=seed,
            width=args.width,
            height=args.height,
            cells=args.cells,
            steps=steps,
            dt=args.dt_days,
            dose=args.dose,
            switch_time=args.switch_time,
            mutation_scale=args.mutation_scale,
            clone_weights=clone_weights,
            c797s_growth_scale=args.c797s_growth_scale,
            met_growth_scale=args.met_growth_scale,
            c797s_fitness_cost=args.c797s_fitness_cost,
            met_fitness_cost=args.met_fitness_cost,
            vessel_concentration_scale=args.vessel_concentration_scale
        )
        for schedule in schedules:
            history = run_single_experiment(
                schedule_name=schedule,
                config=config,
                microenvironment_args=args
            )
            row = calculate_metrics(schedule, seed, history).as_row()
            row["days"] = args.days
            row["dt_days"] = args.dt_days
            raw_rows.append(row)
            print(
                f"seed={seed} schedule={schedule} final={row['final_burden']} "
                f"resistant={float(row['final_resistant_fraction']):.3f}",
                flush=True
            )

    raw_path = args.output_dir / "replicate_metrics.csv"
    summary_path = args.output_dir / "replicate_summary.csv"
    _write_rows(raw_path, raw_rows)
    summary_rows = _summary_rows(raw_rows, schedules)
    _write_rows(summary_path, summary_rows)
    print(f"Wrote {raw_path}")
    print(f"Wrote {summary_path}")
    return 0


def _summary_rows(rows: list[dict[str, object]], schedules: tuple[str, ...]) -> list[dict[str, object]]:
    summary = []
    for schedule in schedules:
        schedule_rows = [row for row in rows if row["experiment"] == schedule]
        item = {
            "experiment": schedule,
            "n": len(schedule_rows),
            "progression_rate": _progression_rate(schedule_rows),
            "time_to_progression_median": _median_optional(schedule_rows, "time_to_progression")
        }
        for metric in SUMMARY_METRICS:
            values = [float(row[metric]) for row in schedule_rows]
            q1, q3 = _iqr(values)
            item[f"{metric}_median"] = median(values)
            item[f"{metric}_q1"] = q1
            item[f"{metric}_q3"] = q3
        summary.append(item)
    return summary


def _progression_rate(rows: list[dict[str, object]]) -> float:
    if not rows:
        return 0.0
    return sum(1 for row in rows if row["time_to_progression"] != "") / len(rows)


def _median_optional(rows: list[dict[str, object]], key: str) -> str | float:
    values = [float(row[key]) for row in rows if row[key] != ""]
    if not values:
        return ""
    return median(values)


def _iqr(values: list[float]) -> tuple[float, float]:
    ordered = sorted(values)
    return _percentile(ordered, 0.25), _percentile(ordered, 0.75)


def _percentile(ordered: list[float], fraction: float) -> float:
    if not ordered:
        return 0.0
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _parse_clone_weights(value: str) -> tuple[float, float, float, float]:
    parts = tuple(float(item.strip()) for item in value.split(",") if item.strip())
    if len(parts) != 4:
        raise ValueError("--clone-weights must be EGFR,T790M,C797S,MET_AMP")
    return parts


def _write_rows(path: Path, rows: list[dict[str, object]]) -> None:
    if not rows:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    raise SystemExit(main())
