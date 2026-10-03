#!/usr/bin/env python3
"""Audit raw calibration inputs before running the pipeline."""

from __future__ import annotations

import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.calibration.pipeline import RAW_INPUTS
from cancer_sim.calibration.schema import file_sha256


def main() -> int:
    print("source,present,rows,columns,sha256,path")
    missing = 0
    for source, path in RAW_INPUTS.items():
        present = path.exists()
        if not present:
            missing += 1
            print(f"{source},false,0,0,,{path}")
            continue

        rows, columns = inspect_csv(path)
        print(f"{source},true,{rows},{columns},{file_sha256(path)},{path}")

    if missing:
        print(f"\nMissing {missing} raw input file(s). See data/raw/README.md.")
    return 0


def inspect_csv(path: Path) -> tuple[int, int]:
    with path.open(newline="") as handle:
        reader = csv.reader(handle)
        try:
            header = next(reader)
        except StopIteration:
            return 0, 0
        rows = sum(1 for _ in reader)
    return rows, len(header)


if __name__ == "__main__":
    raise SystemExit(main())

