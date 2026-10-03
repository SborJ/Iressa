#!/usr/bin/env python3
"""Prepare normalized and calibrated data for the resistance simulator."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.calibration import run_calibration


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--strict-raw",
        action="store_true",
        help="fail if no optional public raw exports are available"
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = run_calibration(strict_raw=args.strict_raw)
    print("Prepared calibrated EGFR resistance data in data/processed")
    print(f"Raw extract counts: {manifest['raw_extract_counts']}")
    print(f"Warnings: {len(manifest['warnings'])}")
    print("Report: data/processed/calibration_report.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

