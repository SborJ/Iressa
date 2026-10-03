#!/usr/bin/env python3
"""The ER+/HER2- evolutionary-therapy experiment (research brief, section 69).

Start a tumour that is almost all ER-sensitive with rare ESR1-mutant subclones,
treat with endocrine suppression + a CDK4/6 inhibitor, and compare how long each
strategy keeps it controllable:

    A  continuous endocrine + CDK4/6
    B  switch to SERD + CDK4/6 only after the tumour regrows
    C  switch when the ESR1 mutants reach 10% of living cells
    D  switch when they reach 1%
    E  a trained PPO policy (--policy path/to/ppo.zip), if given
    plus the random and model-predictive baselines when asked for

Every strategy runs through the same RL environment so the metrics match
(time to loss of control, time to resistant-clone dominance, burden AUC, dose,
controllability, switches, worst case). Writes CSV, a Markdown table and a
figure into --output-dir.

    python3 scripts/run_breast_experiment.py --seeds 1001,1002,1003,1004,1005 --days 120
    python3 scripts/run_breast_experiment.py --policy outputs/rl_breast/ppo_breast.zip --randomize
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.cancers import load_cancer_model  # noqa: E402
from cancer_sim.experiments import ExperimentConfig  # noqa: E402
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig  # noqa: E402
from cancer_sim.rl_eval import (  # noqa: E402
    evaluate_policy, fixed_policy_factory, mpc_policy_factory, ppo_policy, random_policy_factory,
    run_episode, summarize, summary_markdown, write_episode_metrics, write_summary,
)

CANCER = "breast_er_her2neg"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--seeds", default="1001,1002,1003,1004,1005")
    p.add_argument("--days", type=float, default=120.0)
    p.add_argument("--dt-days", type=float, default=1.0)
    p.add_argument("--width", type=int, default=50)
    p.add_argument("--height", type=int, default=40)
    p.add_argument("--cells", type=int, default=350)
    p.add_argument("--mutation-scale", type=float, default=50.0)
    p.add_argument("--clone-weights", default=None, help="seeding mix, e.g. 99,0.5,0.5,0 (default: the model's)")
    p.add_argument("--eci-min", type=float, default=0.02, help="controllability cut-off for loss of control")
    p.add_argument("--randomize", action="store_true", help="draw the uncertain biology per episode")
    p.add_argument("--policy", type=Path, default=None, help="Stable-Baselines3 PPO .zip for strategy E")
    p.add_argument("--with-random", action="store_true")
    p.add_argument("--with-mpc", action="store_true")
    p.add_argument("--mpc-horizon", type=int, default=4)
    p.add_argument("--no-figure", action="store_true")
    p.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "breast_experiment")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    model = load_cancer_model(CANCER)
    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]
    weights = tuple(float(w) for w in args.clone_weights.split(",")) if args.clone_weights else None
    config = RLConfig(
        experiment=ExperimentConfig(
            cancer=CANCER, width=args.width, height=args.height, cells=args.cells, mutation_scale=args.mutation_scale,
            clone_weights=weights, steps=max(1, round(args.days / args.dt_days)), dt=args.dt_days,
        ),
        horizon_days=args.days, decision_interval_days=args.dt_days, eci_min=args.eci_min, randomize=args.randomize,
    )
    strategies = dict(model.raw["experiment_69"]["strategies"])
    env_factory = lambda seed: CancerTreatmentEnv(config)
    traces: dict[str, dict] = {}
    metrics = []

    def run(label: str, factory) -> None:
        print(f"  {label} ...", flush=True)
        for seed in seeds:
            env = env_factory(seed)
            trace = _Trace()
            m = run_episode(name=label, env=env, policy=trace.wrap(factory()), seed=seed)
            metrics.append(m)
            traces.setdefault(label, {})[seed] = trace.rows
        print(f"    control {sorted(round(x.control_time, 1) for x in metrics if x.policy == label)} d")

    for label, schedule in strategies.items():
        if schedule == "ppo":
            continue
        run(label, fixed_policy_factory(schedule, cancer=model))
    if args.with_random:
        run("random", random_policy_factory(0))
    if args.with_mpc:
        run("F_mpc", mpc_policy_factory(model, horizon_steps=args.mpc_horizon))
    if args.policy is not None:
        from stable_baselines3 import PPO
        ppo = PPO.load(str(args.policy))
        run("E_ppo", lambda: ppo_policy(ppo))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_episode_metrics(args.output_dir / "episodes.csv", metrics)
    rows = summarize(metrics)
    write_summary(args.output_dir / "summary.csv", rows)
    title = f"ER+/HER2- section-69 experiment: {len(seeds)} seeds, {args.days:g} days, eci_min {args.eci_min}" + (", domain-randomised" if args.randomize else "")
    table = summary_markdown(rows, title)
    (args.output_dir / "summary.md").write_text(table)
    (args.output_dir / "traces.json").write_text(json.dumps({k: {str(s): v for s, v in d.items()} for k, d in traces.items()}))
    (args.output_dir / "config.json").write_text(json.dumps({
        "seeds": seeds, "days": args.days, "dt_days": args.dt_days, "lattice": [args.width, args.height], "cells": args.cells,
        "mutation_scale": args.mutation_scale, "clone_weights": list(weights) if weights else list(model.default_clone_weights),
        "eci_min": args.eci_min, "randomize": args.randomize, "strategies": strategies, "policy": None if args.policy is None else str(args.policy),
    }, indent=2))
    print(table)
    if not args.no_figure:
        try:
            _figure(traces, args.output_dir / "trajectories.png", model)
            print(f"figure: {args.output_dir / 'trajectories.png'}")
        except Exception as exc:  # matplotlib is optional
            print(f"(no figure: {exc})")
    print(f"wrote {args.output_dir}")
    return 0


class _Trace:
    """Per-step burden, ESR1 fraction, ECI and action for the figure."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def wrap(self, policy):
        def wrapped(env, info):
            action = policy(env, info)
            counts = info.get("clone_counts") or {}
            living = max(1, info.get("burden", 1))
            self.rows.append({
                "day": info.get("time_days", 0.0), "burden": info.get("burden", 0) / max(1, info.get("initial_burden", 1)),
                "esr1": (counts.get("ESR1_Y537S", 0) + counts.get("ESR1_D538G", 0)) / living,
                "eci": info.get("eci", 0.0), "action": env.action_table[action].label,
            })
            return action
        return wrapped


def _figure(traces: dict[str, dict], path: Path, model) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import statistics

    fig, axes = plt.subplots(1, 3, figsize=(14, 4), dpi=130)
    for label, by_seed in traces.items():
        series = list(by_seed.values())
        n = min(len(s) for s in series)
        if n == 0:
            continue
        days = [series[0][i]["day"] for i in range(n)]
        med = lambda key: [statistics.median(s[i][key] for s in series) for i in range(n)]
        axes[0].plot(days, med("burden"), label=label)
        axes[1].plot(days, med("esr1"), label=label)
        axes[2].plot(days, med("eci"), label=label)
    axes[0].set_title("Tumour burden (× start)"); axes[0].set_xlabel("day")
    axes[1].set_title("ESR1-mutant fraction of living cells"); axes[1].set_xlabel("day")
    axes[2].set_title("Controllability index (proxy)"); axes[2].set_xlabel("day")
    for ax in axes:
        ax.grid(alpha=0.3)
    axes[2].legend(fontsize=8, loc="best")
    fig.suptitle(f"{model.name}: median over seeds; research model, in-vitro timescale", fontsize=10)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


if __name__ == "__main__":
    raise SystemExit(main())
