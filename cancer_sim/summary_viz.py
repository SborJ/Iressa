"""Post-run summary plots for simulation CSV histories."""

from __future__ import annotations

import csv
from pathlib import Path


CLONE_COLORS = {
    "EGFR": "#2f80ed",
    "T790M": "#f2994a",
    "C797S": "#eb5757",
    "MET_AMP": "#9b51e0"
}

DRUG_COLORS = {
    "none": "#dddddd",
    "gefitinib": "#2f80ed",
    "osimertinib": "#27ae60",
    "capmatinib": "#9b51e0"
}


def read_history_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def plot_simulation_summary(input_csv: Path, output: Path) -> Path:
    rows = read_history_csv(input_csv)
    if not rows:
        raise ValueError(f"no rows found in {input_csv}")

    import matplotlib.pyplot as plt

    times = [_float(row["time"]) for row in rows]
    burden = [_float(row["burden"]) for row in rows]

    fig, axes = plt.subplots(4, 1, figsize=(11, 12), sharex=True, constrained_layout=True)
    ax_burden, ax_clones, ax_fraction, ax_treatment = axes

    ax_burden.plot(times, burden, color="#111111", linewidth=2)
    ax_burden.set_title("Tumor Burden")
    ax_burden.set_ylabel("living cells")
    ax_burden.grid(alpha=0.25)

    for clone, color in CLONE_COLORS.items():
        values = [_float(row[clone]) for row in rows]
        ax_clones.plot(times, values, label=clone, color=color, linewidth=2)
    ax_clones.set_title("Clone Counts")
    ax_clones.set_ylabel("living cells")
    ax_clones.legend(loc="upper right", ncols=4, fontsize=8)
    ax_clones.grid(alpha=0.25)

    bottoms = [0.0 for _ in rows]
    for clone, color in CLONE_COLORS.items():
        fractions = []
        for index, row in enumerate(rows):
            total = max(_float(row["burden"]), 1.0)
            fractions.append(_float(row[clone]) / total)
        ax_fraction.fill_between(times, bottoms, [bottoms[i] + fractions[i] for i in range(len(rows))],
                                 color=color, alpha=0.8, label=clone)
        bottoms = [bottoms[i] + fractions[i] for i in range(len(rows))]
    ax_fraction.set_title("Clone Fractions")
    ax_fraction.set_ylabel("fraction")
    ax_fraction.set_ylim(0, 1)

    _plot_treatment_timeline(ax_treatment, rows, times)
    ax_treatment.set_title("Treatment Timeline")
    ax_treatment.set_xlabel("time")
    ax_treatment.set_yticks([])

    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=170)
    plt.close(fig)
    return output


def _plot_treatment_timeline(ax, rows: list[dict[str, str]], times: list[float]) -> None:
    start_index = 0
    current = rows[0]["drug"]
    for index, row in enumerate(rows[1:], start=1):
        if row["drug"] != current:
            _span(ax, times[start_index], times[index - 1], current)
            start_index = index
            current = row["drug"]
    _span(ax, times[start_index], times[-1], current)
    ax.set_xlim(min(times), max(times))


def _span(ax, start: float, stop: float, drug: str) -> None:
    ax.axvspan(start, stop, color=DRUG_COLORS.get(drug, "#bbbbbb"), alpha=0.75)
    midpoint = (start + stop) / 2
    ax.text(midpoint, 0.5, drug, ha="center", va="center", fontsize=9)


def _float(value: str) -> float:
    return float(value)

