#!/usr/bin/env python3
"""Print a seeded terminal visualization of mutation flow."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from cancer_sim.mutation_flow import MutationFlowGenerator


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=7, help="random seed")
    parser.add_argument("--root", default="EGFR", help="starting clone ID")
    parser.add_argument("--depth", type=int, default=3, help="maximum lineage depth")
    parser.add_argument(
        "--branch-chance",
        type=float,
        default=0.75,
        help="chance that each allowed transition appears"
    )
    parser.add_argument(
        "--variants",
        type=int,
        default=1,
        help="number of consecutive seed variants to print"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    generator = MutationFlowGenerator.from_seed_data(branch_chance=args.branch_chance)

    for offset in range(args.variants):
        seed = args.seed + offset
        tree = generator.generate(seed=seed, root_clone=args.root, max_depth=args.depth)
        if args.variants > 1:
            print(f"Seed {seed}")
            print("-" * (5 + len(str(seed))))
        print(generator.render_tree(tree))
        if offset < args.variants - 1:
            print()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
