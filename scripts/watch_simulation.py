#!/usr/bin/env python3
"""Watch the tumor simulation update in real time with Matplotlib."""

from __future__ import annotations

import argparse
import os
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
CACHE_ROOT = ROOT / ".tmp"
(CACHE_ROOT / "matplotlib").mkdir(parents=True, exist_ok=True)
(CACHE_ROOT / "xdg-cache").mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(CACHE_ROOT / "matplotlib"))
os.environ.setdefault("XDG_CACHE_HOME", str(CACHE_ROOT / "xdg-cache"))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--width", type=int, default=60)
    parser.add_argument("--height", type=int, default=45)
    parser.add_argument("--cells", type=int, default=500)
    parser.add_argument("--days", type=float, default=60.0, help="live simulation horizon in biological days")
    parser.add_argument("--dt-days", type=float, default=0.5, help="biological update interval in days")
    parser.add_argument("--steps", type=int, default=None, help="deprecated: use --days with --dt-days")
    parser.add_argument("--dt", type=float, default=None, help="deprecated: use --dt-days")
    parser.add_argument(
        "--warmup-steps",
        type=int,
        default=5,
        help="physics steps before the live window starts, with no death or division"
    )
    parser.add_argument("--interval", type=float, default=0.05, help="pause between frames in seconds")
    parser.add_argument("--dose", type=float, default=0.9)
    parser.add_argument("--switch-time", type=float, default=80.0)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument(
        "--schedule",
        choices=(
            "none",
            "continuous-gefitinib",
            "continuous-osimertinib",
            "continuous-capmatinib",
            "gefitinib-osimertinib",
            "osimertinib-capmatinib",
            "adaptive-gefitinib",
            "adaptive-osimertinib",
            "adaptive-capmatinib"
        ),
        default="gefitinib-osimertinib"
    )
    parser.add_argument("--field", choices=("oxygen", "drug"), default="oxygen")
    from cancer_sim.config_controls import add_microenvironment_args
    add_microenvironment_args(parser)
    parser.add_argument("--headless", action="store_true", help="do not open a GUI window")
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "outputs" / "live_simulation_final.png",
        help="optional final PNG path"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.headless:
        os.environ.setdefault("MPLBACKEND", "Agg")

    from cancer_sim.automata import CellularAutomataPhysics, automata_config_from_physics_calibration
    from cancer_sim.config_controls import apply_microenvironment_args
    from cancer_sim.live_viz import LiveViewConfig, run_live_dashboard
    from cancer_sim.simulation import SimulationRunner, build_schedule
    from cancer_sim.world import ScalarField
    from cancer_sim.world_seed import build_seeded_world

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
    for _ in range(args.warmup_steps):
        automata.step(drug="none", vessel_drug_dose=0.0, apply_death=False, allow_division=False)

    dt_days = args.dt if args.dt is not None else args.dt_days
    if dt_days <= 0:
        raise ValueError("--dt-days/--dt must be positive")
    steps = args.steps if args.steps is not None else int(round(args.days / dt_days))
    run_live_dashboard(
        runner,
        steps=steps,
        dt=dt_days,
        config=LiveViewConfig(field=args.field, interval=args.interval),
        output=args.output,
        headless=args.headless
    )
    if args.output is not None:
        print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
