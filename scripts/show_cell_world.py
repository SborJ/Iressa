#!/usr/bin/env python3
"""Print a simple seeded terminal visualization of the static cell world."""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.terminal_viz import render_world
from cancer_sim.world_seed import build_seeded_world


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7, help="random seed")
    parser.add_argument("--width", type=int, default=60, help="world width")
    parser.add_argument("--height", type=int, default=30, help="world height")
    parser.add_argument("--cells", type=int, default=180, help="number of cells to place")
    parser.add_argument(
        "--field",
        choices=("oxygen", "drug"),
        default="oxygen",
        help="background scalar field to display"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    world = build_seeded_world(args.width, args.height, args.cells, rng)

    print(f"Seed: {args.seed}")
    print(render_world(world, max_width=args.width, max_height=args.height, show_field=args.field))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
