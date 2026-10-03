#!/usr/bin/env python3
"""Evaluate fixed and PPO treatment policies on held-out seeds."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.experiments import ExperimentConfig  # noqa: E402
from cancer_sim.cancers import DEFAULT_CANCER, available_cancers, load_cancer_model  # noqa: E402
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig  # noqa: E402
from cancer_sim.rl_eval import (  # noqa: E402
    evaluate_policy,
    fixed_policy_factory,
    mpc_policy_factory,
    summary_markdown,
    ppo_policy,
    summarize,
    write_episode_metrics,
    write_summary,
)


# Lung baselines keep their hand-written RL policies; other models use their experiment panel.
DEFAULT_POLICIES = (
    "none",
    "continuous-gefitinib",
    "gefitinib-osimertinib",
    "adaptive-gefitinib",
    "continuous-osimertinib",
)


def baseline_policies(cancer: str) -> tuple[str, ...]:
    if cancer == DEFAULT_CANCER:
        return DEFAULT_POLICIES
    return load_cancer_model(cancer).default_panel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, default=None, help="optional Stable-Baselines3 PPO .zip policy")
    parser.add_argument("--cancer", choices=available_cancers(), default=DEFAULT_CANCER, help="cancer model to evaluate on")
    parser.add_argument("--seeds", default="1001,1002,1003")
    parser.add_argument("--days", type=float, default=120.0)
    parser.add_argument("--dt-days", type=float, default=1.0)
    parser.add_argument("--switch-day", type=float, default=40.0)
    parser.add_argument("--policies", default=None, help="comma-separated baseline names (default: the model's panel); add random,mpc for those baselines")
    parser.add_argument("--randomize", action="store_true", help="draw the uncertain biology per episode (domain randomisation)")
    parser.add_argument("--eci-min", type=float, default=None, help="controllability cut-off for loss of control (default 0.05)")
    parser.add_argument("--mpc-horizon", type=int, default=4)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "rl_eval")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    seeds = [int(item) for item in args.seeds.split(",") if item.strip()]
    config = RLConfig(
        experiment=ExperimentConfig(
            cancer=args.cancer,
            width=args.width,
            height=args.height,
            cells=args.cells,
            mutation_scale=args.mutation_scale,
            steps=max(1, round(args.days / args.dt_days)),
            dt=args.dt_days,
        ),
        horizon_days=args.days,
        decision_interval_days=args.dt_days,
        randomize=args.randomize,
        **({"eci_min": args.eci_min} if args.eci_min is not None else {}),
    )
    env_factory = lambda seed: CancerTreatmentEnv(config)

    names = tuple(n.strip() for n in args.policies.split(",")) if args.policies else baseline_policies(args.cancer)
    all_metrics = []
    for name in names:
        if name == "mpc":
            factory = mpc_policy_factory(load_cancer_model(args.cancer), horizon_steps=args.mpc_horizon)
        else:
            factory = fixed_policy_factory(name, switch_day=args.switch_day, cancer=args.cancer)
        all_metrics.extend(
            evaluate_policy(
                name=name,
                env_factory=env_factory,
                policy_factory=factory,
                seeds=seeds,
            )
        )

    if args.policy is not None:
        try:
            from stable_baselines3 import PPO
        except ImportError as exc:
            raise SystemExit(
                "Stable-Baselines3 is required to evaluate a PPO checkpoint. "
                "Install with: pip install -r requirements-rl.txt"
            ) from exc
        model = PPO.load(args.policy)
        all_metrics.extend(
            evaluate_policy(
                name="ppo",
                env_factory=env_factory,
                policy_factory=lambda: ppo_policy(model),
                seeds=seeds,
            )
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    write_episode_metrics(args.output_dir / "episode_metrics.csv", all_metrics)
    summary = summarize(all_metrics)
    write_summary(args.output_dir / "policy_summary.csv", summary)
    (args.output_dir / "policy_summary.md").write_text(summary_markdown(summary, f"{args.cancer}: {len(seeds)} seeds, {args.days:g} days"))
    print(summary_markdown(summary))
    print(f"Wrote {args.output_dir / 'episode_metrics.csv'}")
    print(f"Wrote {args.output_dir / 'policy_summary.csv'}")
    for row in summary:
        print(
            f"{row['policy']}: final={row['final_burden_median']:.0f} "
            f"resistant={row['final_resistant_fraction_median']:.3f} "
            f"dose={row['cumulative_dose_median']:.1f}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
