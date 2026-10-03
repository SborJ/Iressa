#!/usr/bin/env python3
"""Plot cross-experiment metrics from experiment_metrics.csv."""

from __future__ import annotations

import argparse
import os
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

from cancer_sim.metrics_viz import plot_experiment_metrics


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=ROOT / "outputs" / "experiment_panel" / "experiment_metrics.csv"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "outputs" / "experiment_panel" / "experiment_metrics.png"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    output = plot_experiment_metrics(args.input, args.output)
    print(f"Wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

