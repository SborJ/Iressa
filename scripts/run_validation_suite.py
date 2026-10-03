#!/usr/bin/env python3
"""Phase 1 validation suite: multi-seed biology, horizons, dt convergence,
pre-existing and acquired resistance, adaptive vs continuous, sensitivity.

    python3 scripts/run_validation_suite.py                 # full suite (~1 h)
    python3 scripts/run_validation_suite.py --quick         # smoke settings

Writes CSVs, a markdown summary and figures to outputs/validation/.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import sys
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".tmp" / "matplotlib"))
(ROOT / ".tmp" / "matplotlib").mkdir(parents=True, exist_ok=True)

from cancer_sim.automata import automata_config_from_physics_calibration
from cancer_sim.experiments import ExperimentConfig, calculate_metrics, run_single_experiment
from cancer_sim.provenance import write_provenance_tables

PANEL = ("none", "continuous-gefitinib", "gefitinib-osimertinib", "adaptive-gefitinib",
         "continuous-osimertinib", "osimertinib-capmatinib", "adaptive-osimertinib")


def pct(values, q):
    if not values:
        return float("nan")
    ordered = sorted(values)
    pos = q * (len(ordered) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (pos - lo)


def summarise(values):
    values = [v for v in values if v is not None]
    if not values:
        return {"n": 0}
    return {
        "n": len(values), "median": statistics.median(values), "mean": statistics.fmean(values),
        "sd": statistics.pstdev(values) if len(values) > 1 else 0.0,
        "q1": pct(values, 0.25), "q3": pct(values, 0.75), "p2_5": pct(values, 0.025), "p97_5": pct(values, 0.975)
    }


def run_one(schedule, seed, days, dt, **overrides):
    config = ExperimentConfig(seed=seed, steps=int(round(days / dt)), dt=dt, **overrides)
    history = run_single_experiment(schedule_name=schedule, config=config)
    metrics = calculate_metrics(schedule, seed, history)
    row = metrics.as_row()
    row.update({
        "days": days, "dt_days": dt,
        "mean_burden": statistics.fmean(r.burden for r in history),
        "final_t790m": history[-1].t790m, "final_c797s": history[-1].c797s, "final_met_amp": history[-1].met_amp,
        "final_egfr": history[-1].egfr,
        "peak_burden": max(r.burden for r in history),
        "resistant_emerged": int(sum(r.mutations for r in history) > 0),
        "final_necrotic": history[-1].necrotic
    })
    for key, value in overrides.items():
        row[f"cfg_{key}"] = value if not isinstance(value, tuple) else ",".join(f"{v:g}" for v in value)
    return row, history


def write_rows(path, rows):
    if not rows:
        return
    keys = []
    for row in rows:
        for k in row:
            if k not in keys:
                keys.append(k)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        writer.writerows(rows)


def section_multiseed(out, seeds, days, dt, quick):
    rows, histories = [], {}
    for schedule in PANEL:
        for seed in seeds:
            row, history = run_one(schedule, seed, days, dt)
            rows.append(row)
            if seed == seeds[0]:
                histories[schedule] = history
        print(f"  multiseed {schedule} done", flush=True)
    write_rows(out / "multiseed_metrics.csv", rows)
    summary = []
    for schedule in PANEL:
        sub = [r for r in rows if r["experiment"] == schedule]
        item = {"experiment": schedule, "n": len(sub),
                "progression_rate": sum(1 for r in sub if r["time_to_progression"] != "") / len(sub),
                "progression_baseline_rate": sum(1 for r in sub if r["time_to_progression_baseline"] != "") / len(sub)}
        for metric in ("time_to_progression", "time_to_progression_baseline", "minimum_burden", "mean_burden", "final_burden",
                       "final_resistant_fraction", "time_to_resistant_dominance", "cumulative_dose",
                       "total_drug_deaths", "total_hypoxic_deaths", "final_t790m", "final_c797s", "final_met_amp"):
            values = [float(r[metric]) for r in sub if r[metric] != ""]
            stats = summarise(values)
            for k in ("median", "mean", "sd", "q1", "q3", "p2_5", "p97_5"):
                item[f"{metric}_{k}"] = stats.get(k, "")
            item[f"{metric}_n"] = stats["n"]
        summary.append(item)
    write_rows(out / "multiseed_summary.csv", summary)
    # trajectory CSVs for the first seed
    for schedule, history in histories.items():
        write_rows(out / f"trajectory_seed{seeds[0]}_{schedule}.csv", [r.as_row() for r in history])
    plot_trajectories(out, histories, seeds[0])
    return summary


def section_horizons(out, seeds, dt):
    rows = []
    for days in (30, 60, 120, 240):
        for schedule in ("none", "continuous-gefitinib", "gefitinib-osimertinib", "adaptive-gefitinib"):
            for seed in seeds:
                switch = min(40.0, days / 2)
                row, _ = run_one(schedule, seed, days, dt, switch_time=switch)
                rows.append(row)
        print(f"  horizon {days}d done", flush=True)
    write_rows(out / "horizon_metrics.csv", rows)
    return rows


def section_dt(out, seeds, days):
    rows = []
    for dt in (1.0, 0.5, 0.25):
        for schedule in ("none", "continuous-gefitinib", "gefitinib-osimertinib"):
            for seed in seeds:
                row, _ = run_one(schedule, seed, days, dt)
                rows.append(row)
        print(f"  dt {dt} done", flush=True)
    write_rows(out / "dt_convergence_metrics.csv", rows)
    summary = []
    for dt in (1.0, 0.5, 0.25):
        for schedule in ("none", "continuous-gefitinib", "gefitinib-osimertinib"):
            sub = [r for r in rows if r["dt_days"] == dt and r["experiment"] == schedule]
            item = {"dt_days": dt, "experiment": schedule}
            for metric in ("final_burden", "minimum_burden", "final_resistant_fraction", "total_births", "total_drug_deaths"):
                st = summarise([float(r[metric]) for r in sub])
                item[f"{metric}_median"] = st["median"]; item[f"{metric}_q1"] = st["q1"]; item[f"{metric}_q3"] = st["q3"]
            summary.append(item)
    write_rows(out / "dt_convergence_summary.csv", summary)
    return summary


def section_preexisting(out, seeds, days, dt):
    rows = []
    cells = 350
    for fraction in (0.0, 0.0001, 0.001, 0.01, 0.05, 0.08):
        weights = (100.0 - 100.0 * fraction, 100.0 * fraction, 0.0, 0.0)
        for schedule in ("continuous-gefitinib", "adaptive-gefitinib"):
            for seed in seeds:
                row, _ = run_one(schedule, seed, days, dt, clone_weights=weights, mutation_scale=1.0)
                row["preexisting_fraction"] = fraction
                row["expected_initial_resistant_cells"] = cells * fraction
                rows.append(row)
        print(f"  pre-existing {fraction} done", flush=True)
    write_rows(out / "preexisting_resistance_metrics.csv", rows)
    return rows


def section_acquired(out, seeds, days, dt):
    rows = []
    for scale in (1.0, 50.0, 500.0):
        for schedule in ("none", "continuous-gefitinib"):
            for seed in seeds:
                row, _ = run_one(schedule, seed, days, dt, clone_weights=(100.0, 0.0, 0.0, 0.0), mutation_scale=scale)
                rows.append(row)
        print(f"  acquired scale {scale} done", flush=True)
    write_rows(out / "acquired_resistance_metrics.csv", rows)
    return rows


SENSITIVITY_FACTORS = {
    "mutation_scale": [12.5, 200.0],
    "vessel_spacing_um": [100.0, 200.0],
    "necrotic_clearance_rate": [0.0, 1.0],
    "vessel_concentration_scale": [0.5, 2.0],
    "c797s_growth_scale": [0.5, 1.0],   # 0.5 halves inherited growth
    "met_growth_scale": [0.5, 1.0],
    "c797s_fitness_cost": [0.0, 0.35],
    "met_fitness_cost": [0.0, 0.25],
    "clone_weights": [(98.0, 2.0, 0.0, 0.0), (75.0, 18.0, 4.0, 3.0)],
    "oxygen_mm_vmax": [0.02, 0.08],
}


def section_sensitivity(out, seeds, days, dt):
    rows = []
    schedules = ("continuous-gefitinib", "gefitinib-osimertinib", "adaptive-gefitinib")
    baseline = []
    for schedule in schedules:
        for seed in seeds:
            row, _ = run_one(schedule, seed, days, dt)
            row.update({"factor": "baseline", "level": "baseline"})
            rows.append(row); baseline.append(row)
    for factor, levels in SENSITIVITY_FACTORS.items():
        for level in levels:
            for schedule in schedules:
                for seed in seeds:
                    row, _ = run_one(schedule, seed, days, dt, **{factor: level})
                    row.update({"factor": factor, "level": level if not isinstance(level, tuple) else ",".join(f"{v:g}" for v in level)})
                    rows.append(row)
        print(f"  sensitivity {factor} done", flush=True)
    # clone-phenotype factors that need engine-level overrides are run through a patched ExperimentConfig below
    write_rows(out / "sensitivity_metrics.csv", rows)
    summary = []
    groups = sorted({(r["factor"], str(r["level"]), r["experiment"]) for r in rows})
    for factor, level, schedule in groups:
        sub = [r for r in rows if r["factor"] == factor and str(r["level"]) == level and r["experiment"] == schedule]
        item = {"factor": factor, "level": level, "experiment": schedule, "n": len(sub),
                "progression_rate": sum(1 for r in sub if r["time_to_progression"] != "") / len(sub)}
        for metric in ("time_to_progression", "final_burden", "minimum_burden", "final_resistant_fraction", "cumulative_dose", "final_c797s", "final_met_amp"):
            st = summarise([float(r[metric]) for r in sub if r[metric] != ""])
            item[f"{metric}_median"] = st.get("median", ""); item[f"{metric}_q1"] = st.get("q1", ""); item[f"{metric}_q3"] = st.get("q3", "")
        summary.append(item)
    write_rows(out / "sensitivity_summary.csv", summary)
    return summary


def plot_trajectories(out, histories, seed):
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return
    fig, axes = plt.subplots(len(histories), 1, figsize=(10, 2.6 * len(histories)), sharex=True, constrained_layout=True)
    colors = {"EGFR": "#2f80ed", "T790M": "#f2994a", "C797S": "#eb5757", "MET_AMP": "#9b51e0"}
    for ax, (schedule, history) in zip(axes, histories.items()):
        t = [r.time for r in history]
        for clone, key in (("EGFR", "egfr"), ("T790M", "t790m"), ("C797S", "c797s"), ("MET_AMP", "met_amp")):
            ax.plot(t, [getattr(r, key) for r in history], color=colors[clone], label=clone, linewidth=1.8)
        ax.plot(t, [r.burden for r in history], color="black", linewidth=1, linestyle="--", label="burden")
        current = history[0].drug; start = t[0]
        for i, r in enumerate(history[1:], 1):
            if r.drug != current:
                if current != "none":
                    ax.axvspan(start, t[i - 1], alpha=0.12, color={"gefitinib": "#2f80ed", "osimertinib": "#27ae60", "capmatinib": "#9b51e0"}.get(current, "grey"))
                current = r.drug; start = t[i - 1]
        if current != "none":
            ax.axvspan(start, t[-1], alpha=0.12, color={"gefitinib": "#2f80ed", "osimertinib": "#27ae60", "capmatinib": "#9b51e0"}.get(current, "grey"))
        ax.set_title(f"{schedule} (seed {seed})", fontsize=10, loc="left")
        ax.set_ylabel("living cells")
        ax.grid(alpha=0.25)
    axes[0].legend(loc="upper right", ncols=5, fontsize=8)
    axes[-1].set_xlabel("simulated days (in-vitro growth timescale)")
    fig.savefig(out / f"trajectories_seed_{seed}.png", dpi=140)
    plt.close(fig)


def plot_multiseed(out, summary):
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return
    metrics = [("time_to_progression", "time to progression (days)"), ("final_burden", "final burden"),
               ("final_resistant_fraction", "final resistant fraction"), ("cumulative_dose", "cumulative dose")]
    fig, axes = plt.subplots(1, len(metrics), figsize=(4 * len(metrics), 4), constrained_layout=True)
    labels = [s["experiment"].replace("continuous-", "cont-").replace("gefitinib", "gef").replace("osimertinib", "osi").replace("capmatinib", "cap").replace("adaptive-", "adap-") for s in summary]
    for ax, (metric, title) in zip(axes, metrics):
        med = [float(s[f"{metric}_median"]) if s[f"{metric}_median"] != "" else float("nan") for s in summary]
        q1 = [float(s[f"{metric}_q1"]) if s[f"{metric}_q1"] != "" else float("nan") for s in summary]
        q3 = [float(s[f"{metric}_q3"]) if s[f"{metric}_q3"] != "" else float("nan") for s in summary]
        err = [[m - a for m, a in zip(med, q1)], [b - m for m, b in zip(med, q3)]]
        ax.bar(range(len(summary)), med, yerr=err, capsize=3, color="#7f8c8d")
        ax.set_xticks(range(len(summary))); ax.set_xticklabels(labels, rotation=60, ha="right", fontsize=8)
        ax.set_title(title + " (median, IQR)", fontsize=10)
        ax.grid(axis="y", alpha=0.25)
    fig.savefig(out / "multiseed_summary.png", dpi=140)
    plt.close(fig)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "validation")
    parser.add_argument("--seeds", type=int, default=20)
    parser.add_argument("--days", type=float, default=120.0)
    parser.add_argument("--only", default=None, help="comma-separated subset of sections: multiseed,horizons,dt,preexisting,acquired,sensitivity")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else None
    out = args.output_dir; out.mkdir(parents=True, exist_ok=True)
    quick = args.quick
    seeds = list(range(1, (3 if quick else args.seeds) + 1))
    days = 20 if quick else args.days
    t0 = time.time()
    manifest = {"quick": quick, "seeds": seeds, "days": days, "sections": {}}

    write_provenance_tables(out, automata_config_from_physics_calibration(oxygen_mm_vmax=0.04), mutation_probability_scale=50.0)

    previous = json.load(open(out / "manifest.json")) if (out / "manifest.json").exists() else {}
    if only:
        manifest["sections"] = previous.get("sections", {})

    def wanted(name):
        return only is None or name in only

    if wanted("multiseed"):
        print("multi-seed panel", flush=True); s = time.time()
        summary = section_multiseed(out, seeds, days, 1.0, quick); plot_multiseed(out, summary)
        manifest["sections"]["multiseed"] = time.time() - s
    if wanted("horizons") and not quick:
        print("horizons", flush=True); s = time.time()
        section_horizons(out, seeds[:5], 1.0)
        manifest["sections"]["horizons"] = time.time() - s
    if wanted("dt"):
        print("dt convergence", flush=True); s = time.time()
        section_dt(out, seeds[: (2 if quick else 10)], 10 if quick else 60)
        manifest["sections"]["dt"] = time.time() - s
    if wanted("preexisting"):
        print("pre-existing resistance", flush=True); s = time.time()
        section_preexisting(out, seeds, days, 1.0)
        manifest["sections"]["preexisting"] = time.time() - s
    if wanted("acquired"):
        print("acquired resistance", flush=True); s = time.time()
        section_acquired(out, seeds, days, 1.0)
        manifest["sections"]["acquired"] = time.time() - s
    if wanted("sensitivity"):
        print("sensitivity", flush=True); s = time.time()
        section_sensitivity(out, seeds[: (2 if quick else 5)], days, 1.0)
        manifest["sections"]["sensitivity"] = time.time() - s
    manifest["total_seconds"] = previous.get("total_seconds", 0) + (time.time() - t0) if only else time.time() - t0
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"done in {manifest['total_seconds']:.0f}s -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
