#!/usr/bin/env python3
"""Train or smoke-test a PPO policy for the treatment-control environment."""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.experiments import ExperimentConfig  # noqa: E402
from cancer_sim.rl_env import ACTION_TABLE, CancerTreatmentEnv, RLConfig  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=float, default=120.0)
    parser.add_argument("--dt-days", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument("--total-timesteps", type=int, default=10_000)
    parser.add_argument("--smoke", action="store_true", help="run a random-policy environment smoke test")
    parser.add_argument("--smoke-steps", type=int, default=5)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "rl")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_config = RLConfig(
        experiment=ExperimentConfig(
            seed=args.seed,
            width=args.width,
            height=args.height,
            cells=args.cells,
            mutation_scale=args.mutation_scale,
            steps=max(1, round(args.days / args.dt_days)),
            dt=args.dt_days,
        ),
        horizon_days=args.days,
        decision_interval_days=args.dt_days,
    )
    if args.smoke:
        smoke_test(env_config, args)
        return 0

    try:
        from stable_baselines3 import PPO
        from stable_baselines3.common.env_checker import check_env
    except ImportError as exc:
        raise SystemExit(
            "PPO dependencies are not installed. Install them with:\n"
            "  pip install -r requirements-rl.txt\n"
            "or run a dependency-free smoke test with:\n"
            "  python3 scripts/train_ppo.py --smoke"
        ) from exc

    args.output_dir.mkdir(parents=True, exist_ok=True)
    env = CancerTreatmentEnv(env_config)
    check_env(env, warn=True)
    model = PPO("MlpPolicy", env, verbose=1, seed=args.seed)
    model.learn(total_timesteps=args.total_timesteps)
    model_path = args.output_dir / "ppo_iressa.zip"
    model.save(model_path)
    print(f"Saved PPO policy to {model_path}")
    return 0


def smoke_test(config: RLConfig, args: argparse.Namespace) -> None:
    args.output_dir.mkdir(parents=True, exist_ok=True)
    env = CancerTreatmentEnv(config)
    obs, info = env.reset(seed=args.seed)
    rows = []
    for step in range(args.smoke_steps):
        action = step % len(ACTION_TABLE)
        obs, reward, terminated, truncated, info = env.step(action)
        rows.append({
            "step": info["step"],
            "time_days": info["time_days"],
            "action": action,
            "drug": ACTION_TABLE[action].drug,
            "dose": ACTION_TABLE[action].dose,
            "reward": reward,
            "burden": info["burden"],
            "resistant_fraction": info["resistant_fraction"],
        })
        if terminated or truncated:
            break

    output = args.output_dir / "ppo_smoke.csv"
    with output.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(f"Observation shape: {obs.shape}")
    print(f"Actions: {len(ACTION_TABLE)}")
    print(f"Wrote {output}")


if __name__ == "__main__":
    raise SystemExit(main())
