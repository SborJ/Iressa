"""Cross-experiment metrics visualization."""

from __future__ import annotations

import csv
from pathlib import Path


METRIC_COLUMNS = (
    ("time_to_progression", "Time To Progression"),
    ("cumulative_dose", "Cumulative Dose"),
    ("final_resistant_fraction", "Final Resistant Fraction"),
    ("minimum_burden", "Minimum Burden"),
    ("final_burden", "Final Burden")
)


def read_metrics_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def plot_experiment_metrics(input_csv: Path, output: Path) -> Path:
    rows = read_metrics_csv(input_csv)
    if not rows:
        raise ValueError(f"no rows found in {input_csv}")

    import matplotlib.pyplot as plt

    labels = [row["experiment"] for row in rows]
    fig, axes = plt.subplots(len(METRIC_COLUMNS), 1, figsize=(12, 14), constrained_layout=True)

    for ax, (column, title) in zip(axes, METRIC_COLUMNS):
        values = [_metric_value(row.get(column, "")) for row in rows]
        colors = ["#bbbbbb" if value is None else "#2f80ed" for value in values]
        numeric_values = [0.0 if value is None else value for value in values]
        ax.bar(labels, numeric_values, color=colors)
        ax.set_title(title)
        ax.tick_params(axis="x", labelrotation=25)
        ax.grid(axis="y", alpha=0.25)
        for index, value in enumerate(values):
            label = "NA" if value is None else _format_value(value)
            ax.text(index, numeric_values[index], label, ha="center", va="bottom", fontsize=8)

    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=170)
    plt.close(fig)
    return output


def _metric_value(value: str) -> float | None:
    if value == "":
        return None
    return float(value)


def _format_value(value: float) -> str:
    if 0 <= value <= 1:
        return f"{value:.2f}"
    return f"{value:.0f}"

