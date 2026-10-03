#!/usr/bin/env python3
"""Ablations for the breast model (research brief, section 50).

Each ablation evaluates the model's baseline strategies, and a PPO policy when a
trained one is given, with one ingredient removed:

    eci         reward without the controllability terms (needs training; see --train-steps)
    spatial     observations without the controllability features (fractions only)
    oxygen      a uniform oxygen field instead of the diffusing one
    uncertainty fixed biology vs domain-randomised episodes
    evolution   ESR1 mutants only (CDK escape transition switched off) vs ESR1 + CDK escape

Without --train-steps the reward and observation ablations run the baselines
only (their behaviour does not depend on the reward), and the script says so.
Defaults are deliberately small so the whole set runs in minutes; raise
--seeds and --days for a real study.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.cancers import load_cancer_model  # noqa: E402
from cancer_sim.experiments import ExperimentConfig  # noqa: E402
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig  # noqa: E402
from cancer_sim.rl_eval import evaluate_policy, fixed_policy_factory, ppo_policy, summarize, summary_markdown, write_episode_metrics  # noqa: E402

CANCER = "breast_er_her2neg"
ABLATIONS = ("eci", "spatial", "oxygen", "uncertainty", "evolution")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ablations", default=",".join(ABLATIONS))
    p.add_argument("--seeds", default="1001,1002,1003")
    p.add_argument("--days", type=float, default=60.0)
    p.add_argument("--policies", default="continuous-endocrine-cdk,early-switch-esr1-10,adaptive-endocrine-cdk")
    p.add_argument("--train-steps", type=int, default=0, help="PPO timesteps per arm for the reward/observation ablations (0 = baselines only)")
    p.add_argument("--eci-min", type=float, default=0.02)
    p.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "breast_ablations")
    return p.parse_args()


def base_config(args) -> RLConfig:
    return RLConfig(
        experiment=ExperimentConfig(cancer=CANCER, steps=int(args.days), mutation_scale=50.0),
        horizon_days=args.days, eci_min=args.eci_min,
    )


ARMS = {
    "eci": lambda c: {"with_eci": c, "without_eci": replace(c, eci_weight=0.0, eci_delta_weight=0.0, exhaustion_weight=0.0, controlled_day_reward=0.0)},
    "spatial": lambda c: {"full_state": c, "fractions_only": replace(c, observation_mode="fractions_only")},
    "oxygen": lambda c: {"oxygen_field": c, "uniform_oxygen": replace(c, experiment=replace(c.experiment, uniform_oxygen=True))},
    "uncertainty": lambda c: {"fixed_biology": c, "domain_randomised": replace(c, randomize=True)},
    "evolution": lambda c: {"esr1_and_cdk_escape": c, "esr1_only": replace(c, experiment=replace(c.experiment, disabled_transitions=("CDK_ESCAPE",)))},
}


def main() -> int:
    args = parse_args()
    model = load_cancer_model(CANCER)
    seeds = [int(s) for s in args.seeds.split(",")]
    policies = [p.strip() for p in args.policies.split(",")]
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = [f"# Breast ablations: {len(seeds)} seeds, {args.days:g} days", ""]
    for name in args.ablations.split(","):
        name = name.strip()
        arms = ARMS[name](base_config(args))
        metrics = []
        for arm, config in arms.items():
            env_factory = lambda seed, config=config: CancerTreatmentEnv(config)
            for policy in policies:
                metrics.extend(evaluate_policy(name=f"{arm}/{policy}", env_factory=env_factory,
                                               policy_factory=fixed_policy_factory(policy, cancer=model), seeds=seeds))
            if args.train_steps > 0 and name in ("eci", "spatial"):
                from stable_baselines3 import PPO
                ppo = PPO("MlpPolicy", CancerTreatmentEnv(config), verbose=0, seed=seeds[0])
                ppo.learn(total_timesteps=args.train_steps)
                metrics.extend(evaluate_policy(name=f"{arm}/ppo", env_factory=env_factory, policy_factory=lambda ppo=ppo: ppo_policy(ppo), seeds=seeds))
        write_episode_metrics(args.output_dir / f"{name}_episodes.csv", metrics)
        note = "" if args.train_steps > 0 or name not in ("eci", "spatial") else \
            " (baselines only: the fixed strategies do not read the reward or the observation; pass --train-steps to compare PPO arms)"
        table = summary_markdown(summarize(metrics), f"{name}{note}")
        report += [table]
        print(table)
    (args.output_dir / "ablations.md").write_text("\n".join(report))
    print(f"wrote {args.output_dir / 'ablations.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
