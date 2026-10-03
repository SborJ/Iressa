#!/usr/bin/env python3
"""Create a colored Matplotlib visualization of the static cell world."""

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
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MPLCONFIGDIR", str(CACHE_ROOT / "matplotlib"))
os.environ.setdefault("XDG_CACHE_HOME", str(CACHE_ROOT / "xdg-cache"))

from cancer_sim.matplotlib_viz import plot_world
from cancer_sim.world_seed import build_seeded_world


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7, help="random seed")
    parser.add_argument("--width", type=int, default=80, help="world width")
    parser.add_argument("--height", type=int, default=60, help="world height")
    parser.add_argument("--cells", type=int, default=500, help="number of cells to place")
    parser.add_argument(
        "--field",
        choices=("oxygen", "drug"),
        default="oxygen",
        help="background scalar field to display"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "outputs" / "cell_world.png",
        help="path to write the PNG"
    )
    parser.add_argument("--show", action="store_true", help="open an interactive plot window")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    world = build_seeded_world(args.width, args.height, args.cells, rng)
    output = plot_world(
        world,
        field=args.field,
        output=args.output,
        title=f"Static Cancer Cell World, seed {args.seed}",
        show=args.show
    )
    if output is not None:
        print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
