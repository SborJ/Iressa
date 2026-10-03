#!/usr/bin/env python3
"""Run a short cellular automata physics smoke test."""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.automata import CellularAutomataPhysics, automata_config_from_physics_calibration
from cancer_sim.world import ScalarField
from cancer_sim.world_seed import build_seeded_world


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--width", type=int, default=40)
    parser.add_argument("--height", type=int, default=30)
    parser.add_argument("--cells", type=int, default=250)
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--drug", choices=("none", "gefitinib", "osimertinib"), default="gefitinib")
    parser.add_argument("--dose", type=float, default=0.8)
    parser.add_argument("--no-death", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    world = build_seeded_world(args.width, args.height, args.cells, rng)
    world.drug = ScalarField(args.width, args.height, default=0.0)
    automata = CellularAutomataPhysics(
        world,
        config=automata_config_from_physics_calibration(oxygen_mm_vmax=0.04),
        rng=rng
    )

    print(
        "step,time,cells,births,mutations,drug_deaths,hypoxic_deaths,"
        "proliferating,quiescent,necrotic,mean_oxygen,mean_drug"
    )
    for step in range(args.steps):
        stats = automata.step(
            drug=args.drug,
            vessel_drug_dose=args.dose,
            apply_death=not args.no_death
        )
        print(
            f"{step + 1},{automata.time:.1f},{stats.living_cells_after},"
            f"{stats.births},{stats.mutations},"
            f"{stats.drug_deaths},{stats.hypoxic_deaths},"
            f"{stats.proliferating_cells},{stats.quiescent_cells},{stats.necrotic_cells},"
            f"{stats.mean_oxygen:.4f},{stats.mean_drug:.4f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
