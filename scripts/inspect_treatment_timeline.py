#!/usr/bin/env python3
"""Inspect treatment switches and clone counts in a simulation CSV."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


DEFAULT_INPUT = Path("outputs/experiment_panel/02_gefitinib-osimertinib.csv")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--every", type=float, default=30.0, help="also print rows near this day interval")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    rows = _read_rows(args.input)
    if not rows:
        raise ValueError(f"no rows found in {args.input}")

    print("time_days,active_drug,EGFR_count,T790M_count,C797S_count,MET_AMP_count,tumor_burden,event")
    printed = set()
    previous_drug = None
    for index, row in enumerate(rows):
        event = ""
        if row["drug"] != previous_drug:
            event = "drug_switch" if previous_drug is not None else "start"
            previous_drug = row["drug"]
        elif _is_interval_row(row, args.every):
            event = "checkpoint"

        if event and index not in printed:
            printed.add(index)
            print(_format_row(row, event))

    if len(rows) - 1 not in printed:
        print(_format_row(rows[-1], "final"))
    return 0


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def _is_interval_row(row: dict[str, str], interval: float) -> bool:
    if interval <= 0:
        return False
    time = float(row["time"])
    return abs(time / interval - round(time / interval)) < 1e-9


def _format_row(row: dict[str, str], event: str) -> str:
    return ",".join(
        [
            row["time"],
            row["drug"],
            row["EGFR"],
            row["T790M"],
            row["C797S"],
            row["MET_AMP"],
            row["burden"],
            event
        ]
    )


if __name__ == "__main__":
    raise SystemExit(main())
