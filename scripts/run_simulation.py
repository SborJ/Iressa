#!/usr/bin/env python3
"""Run the upgraded cellular automata tumor simulation."""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.automata import CellularAutomataPhysics, automata_config_from_physics_calibration
from cancer_sim.config_controls import add_microenvironment_args, apply_microenvironment_args
from cancer_sim.simulation import SimulationRunner, build_schedule, write_history_csv
from cancer_sim.world import ScalarField
from cancer_sim.world_seed import build_seeded_world


SCHEDULES = (
    "none",
    "continuous-gefitinib",
    "continuous-osimertinib",
    "continuous-capmatinib",
    "gefitinib-osimertinib",
    "osimertinib-capmatinib",
    "adaptive-gefitinib",
    "adaptive-osimertinib",
    "adaptive-capmatinib"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--days", type=float, default=120.0, help="simulation horizon in biological days")
    parser.add_argument("--dt-days", type=float, default=1.0, help="biological update interval in days")
    parser.add_argument("--steps", type=int, default=None, help="deprecated: use --days with --dt-days")
    parser.add_argument("--dt", type=float, default=None, help="deprecated: use --dt-days")
    parser.add_argument("--dose", type=float, default=0.9)
    parser.add_argument("--switch-time", type=float, default=40.0)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument("--schedule", choices=SCHEDULES, default="gefitinib-osimertinib")
    add_microenvironment_args(parser)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "outputs" / "simulation_history.csv"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    world = build_seeded_world(args.width, args.height, args.cells, rng)
    world.drug = ScalarField(args.width, args.height, default=0.0)

    config = apply_microenvironment_args(
        automata_config_from_physics_calibration(
            oxygen_mm_vmax=0.04,
            mutation_probability_scale=args.mutation_scale
        ),
        args
    )
    automata = CellularAutomataPhysics(
        world,
        config=config,
        rng=rng
    )
    schedule = build_schedule(args.schedule, dose=args.dose, switch_time=args.switch_time)
    runner = SimulationRunner(automata, schedule)
    dt_days = args.dt if args.dt is not None else args.dt_days
    if dt_days <= 0:
        raise ValueError("--dt-days/--dt must be positive")
    steps = args.steps if args.steps is not None else int(round(args.days / dt_days))
    history = runner.run(steps=steps, dt=dt_days)
    write_history_csv(args.output, history)

    print_summary(args, history, steps)
    print(f"Wrote {args.output}")
    return 0


def print_summary(args: argparse.Namespace, history, steps: int) -> None:
    print(f"schedule={args.schedule} seed={args.seed} steps={steps} time_unit=days")
    print("step,time_days,drug,dose,burden,EGFR,T790M,C797S,MET_AMP,births,mutations,drug_deaths,necrotic")
    stride = max(1, steps // 10)
    for record in history:
        if record.step == 1 or record.step == steps or record.step % stride == 0:
            print(
                f"{record.step},{record.time:.1f},{record.drug},{record.dose:.2f},"
                f"{record.burden},{record.egfr},{record.t790m},{record.c797s},{record.met_amp},"
                f"{record.births},{record.mutations},{record.drug_deaths},{record.necrotic}"
            )


if __name__ == "__main__":
    raise SystemExit(main())
