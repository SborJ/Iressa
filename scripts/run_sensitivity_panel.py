#!/usr/bin/env python3
"""Run one-factor sensitivity sweeps for assumed simulator parameters."""

from __future__ import annotations

import argparse
import csv
import sys
from argparse import Namespace
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.config_controls import add_microenvironment_args, vessel_spacing_from_args
from cancer_sim.automata import DEFAULT_NECROTIC_CLEARANCE_RATE
from cancer_sim.world_seed import DEFAULT_VESSEL_SPACING_UM
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
    "total_mutations",
    "total_drug_deaths",
    "total_hypoxic_deaths"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=float, default=120.0)
    parser.add_argument("--dt-days", type=float, default=1.0)
    parser.add_argument("--seeds", type=int, default=5)
    parser.add_argument("--seed-start", type=int, default=1)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--dose", type=float, default=0.9)
    parser.add_argument("--switch-time", type=float, default=40.0)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument("--clone-weights", default="88,8,2,2")
    parser.add_argument("--schedules", default=",".join(DEFAULT_SCHEDULES))
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "sensitivity_panel")
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
    baseline_weights = _parse_clone_weights(args.clone_weights)
    scenarios = _build_scenarios(args, baseline_weights)
    steps = int(round(args.days / args.dt_days))

    raw_rows = []
    for scenario in scenarios:
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
                mutation_scale=scenario["mutation_scale"],
                vessel_spacing_um=vessel_spacing_from_args(args, DEFAULT_VESSEL_SPACING_UM),
                necrotic_clearance_rate=args.necrotic_clearance_rate if args.necrotic_clearance_rate is not None else DEFAULT_NECROTIC_CLEARANCE_RATE,
                drug_solver=args.drug_solver or "quasi_steady",
                clone_weights=scenario["clone_weights"],
                c797s_growth_scale=scenario["c797s_growth_scale"],
                met_growth_scale=scenario["met_growth_scale"],
                c797s_fitness_cost=scenario["c797s_fitness_cost"],
                met_fitness_cost=scenario["met_fitness_cost"],
                vessel_concentration_scale=scenario["vessel_concentration_scale"]
            )
            microenvironment_args = _scenario_microenvironment_args(args, scenario)
            for schedule in schedules:
                history = run_single_experiment(
                    schedule_name=schedule,
                    config=config,
                    microenvironment_args=microenvironment_args
                )
                row = calculate_metrics(schedule, seed, history).as_row()
                row.update({
                    "scenario": scenario["name"],
                    "factor": scenario["factor"],
                    "factor_value": scenario["factor_value"],
                    "days": args.days,
                    "dt_days": args.dt_days
                })
                raw_rows.append(row)
                print(
                    f"{scenario['name']} seed={seed} schedule={schedule} "
                    f"final={row['final_burden']} resistant={float(row['final_resistant_fraction']):.3f}",
                    flush=True
                )

    raw_path = args.output_dir / "sensitivity_metrics.csv"
    summary_path = args.output_dir / "sensitivity_summary.csv"
    _write_rows(raw_path, raw_rows)
    _write_rows(summary_path, _summary_rows(raw_rows))
    print(f"Wrote {raw_path}")
    print(f"Wrote {summary_path}")
    return 0


def _build_scenarios(args: argparse.Namespace, baseline_weights: tuple[float, float, float, float]):
    baseline = {
        "name": "baseline",
        "factor": "baseline",
        "factor_value": "baseline",
        "mutation_scale": args.mutation_scale,
        "clone_weights": baseline_weights,
        "c797s_growth_scale": 1.0,
        "met_growth_scale": 1.0,
        "c797s_fitness_cost": None,
        "met_fitness_cost": None,
        "vessel_concentration_scale": 1.0,
        "oxygen_uptake": args.oxygen_uptake
    }
    scenarios = [baseline]
    scenarios.extend(_variant(baseline, "mutation_scale_low", "mutation_scale", args.mutation_scale * 0.25))
    scenarios.extend(_variant(baseline, "mutation_scale_high", "mutation_scale", args.mutation_scale * 4.0))
    scenarios.extend(_variant(baseline, "c797s_growth_low", "c797s_growth_scale", 0.5))
    scenarios.extend(_variant(baseline, "c797s_growth_high", "c797s_growth_scale", 2.0))
    scenarios.extend(_variant(baseline, "met_growth_low", "met_growth_scale", 0.5))
    scenarios.extend(_variant(baseline, "met_growth_high", "met_growth_scale", 2.0))
    scenarios.extend(_variant(baseline, "c797s_fitness_none", "c797s_fitness_cost", 0.0))
    scenarios.extend(_variant(baseline, "c797s_fitness_high", "c797s_fitness_cost", 0.35))
    scenarios.extend(_variant(baseline, "met_fitness_none", "met_fitness_cost", 0.0))
    scenarios.extend(_variant(baseline, "met_fitness_high", "met_fitness_cost", 0.25))
    scenarios.extend(_variant(baseline, "vessel_concentration_low", "vessel_concentration_scale", 0.5))
    scenarios.extend(_variant(baseline, "vessel_concentration_high", "vessel_concentration_scale", 2.0))
    scenarios.extend(_variant(baseline, "oxygen_uptake_low", "oxygen_uptake", 0.025))
    scenarios.extend(_variant(baseline, "oxygen_uptake_high", "oxygen_uptake", 0.10))
    scenarios.extend(_variant(baseline, "starting_resistance_low", "clone_weights", (98.0, 2.0, 0.0, 0.0)))
    scenarios.extend(_variant(baseline, "starting_resistance_high", "clone_weights", (75.0, 18.0, 4.0, 3.0)))
    return scenarios


def _variant(base: dict[str, object], name: str, factor: str, value: object) -> list[dict[str, object]]:
    item = dict(base)
    item["name"] = name
    item["factor"] = factor
    item["factor_value"] = _format_value(value)
    item[factor] = value
    return [item]


def _scenario_microenvironment_args(args: argparse.Namespace, scenario: dict[str, object]) -> Namespace:
    values = vars(args).copy()
    values["oxygen_uptake"] = scenario["oxygen_uptake"]
    return Namespace(**values)


def _summary_rows(rows: list[dict[str, object]]) -> list[dict[str, object]]:
    groups = sorted({(row["scenario"], row["experiment"]) for row in rows})
    summary = []
    for scenario, experiment in groups:
        group_rows = [
            row for row in rows
            if row["scenario"] == scenario and row["experiment"] == experiment
        ]
        first = group_rows[0]
        item = {
            "scenario": scenario,
            "factor": first["factor"],
            "factor_value": first["factor_value"],
            "experiment": experiment,
            "n": len(group_rows),
            "progression_rate": _progression_rate(group_rows),
            "time_to_progression_median": _median_optional(group_rows, "time_to_progression")
        }
        for metric in SUMMARY_METRICS:
            values = [float(row[metric]) for row in group_rows]
            q1, q3 = _iqr(values)
            item[f"{metric}_median"] = median(values)
            item[f"{metric}_q1"] = q1
            item[f"{metric}_q3"] = q3
        summary.append(item)
    return summary


def _progression_rate(rows: list[dict[str, object]]) -> float:
    return sum(1 for row in rows if row["time_to_progression"] != "") / len(rows)


def _median_optional(rows: list[dict[str, object]], key: str) -> str | float:
    values = [float(row[key]) for row in rows if row[key] != ""]
    if not values:
        return ""
    return median(values)


def _iqr(values: list[float]) -> tuple[float, float]:
    ordered = sorted(values)
    if not ordered:
        return 0.0, 0.0
    return _percentile(ordered, 0.25), _percentile(ordered, 0.75)


def _percentile(ordered: list[float], fraction: float) -> float:
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
    if any(part < 0 for part in parts) or sum(parts) <= 0:
        raise ValueError("--clone-weights must be non-negative and not all zero")
    return parts


def _format_value(value: object) -> str:
    if isinstance(value, tuple):
        return ",".join(f"{item:g}" for item in value)
    if isinstance(value, float):
        return f"{value:g}"
    return str(value)


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
