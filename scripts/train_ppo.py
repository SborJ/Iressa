#!/usr/bin/env python3
"""Train or smoke-test a PPO policy for the treatment-control environment."""

from __future__ import annotations

import argparse
from dataclasses import replace
import csv
import os
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
CACHE_ROOT = ROOT / ".tmp"
(CACHE_ROOT / "matplotlib").mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", str(CACHE_ROOT / "matplotlib"))

from cancer_sim.experiments import ExperimentConfig  # noqa: E402
from cancer_sim.cancers import DEFAULT_CANCER, available_cancers  # noqa: E402
from cancer_sim.narration import describe_exposures  # noqa: E402
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cancer", choices=available_cancers(), default=DEFAULT_CANCER, help="cancer model to train on")
    parser.add_argument("--days", type=float, default=120.0)
    parser.add_argument("--dt-days", type=float, default=1.0)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--width", type=int, default=50)
    parser.add_argument("--height", type=int, default=40)
    parser.add_argument("--depth", type=int, default=1)
    parser.add_argument("--cells", type=int, default=350)
    parser.add_argument("--mutation-scale", type=float, default=50.0)
    parser.add_argument("--randomize", action="store_true", help="domain-randomise the biology every episode (spec section 45)")
    parser.add_argument("--eci-min", type=float, default=None, help="controllability cut-off for the controlled-day reward and termination")
    parser.add_argument("--model-name", default="ppo_iressa", help="file stem for the saved policy")
    parser.add_argument("--total-timesteps", type=int, default=10_000)
    parser.add_argument("--smoke", action="store_true", help="run a random-policy environment smoke test")
    parser.add_argument("--smoke-steps", type=int, default=5)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "rl")
    parser.add_argument("--live", action="store_true", help="emit JSON progress for the local UI")
    parser.add_argument("--progress-interval", type=int, default=16)
    parser.add_argument("--rollout-steps", type=int, default=2048)
    parser.add_argument("--ent-coef", type=float, default=0.01, help="exploration bonus; 0 lets the policy lock onto one action early")
    parser.add_argument("--n-envs", type=int, default=1, help="practice tumours simulated in parallel processes")
    parser.add_argument("--no-reward-norm", action="store_true", help="train on raw rewards (default: running reward normalisation)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    env_config = RLConfig(
        experiment=ExperimentConfig(
            cancer=args.cancer,
            seed=args.seed,
            width=args.width,
            height=args.height,
            depth=args.depth,
            # the branching vessel tree in 3D, as the live viewer and the recordings use
            vasculature="tree" if args.depth > 1 else "grid",
            cells=args.cells,
            mutation_scale=args.mutation_scale,
            steps=max(1, round(args.days / args.dt_days)),
            dt=args.dt_days,
        ),
        horizon_days=args.days,
        decision_interval_days=args.dt_days,
        randomize=args.randomize,
        # In 3D an untreated tumour passes the controllability cut-off within days,
        # which would end every practice run early; training runs the full episode.
        eci_min=args.eci_min if args.eci_min is not None else (0.0 if (args.live or args.depth > 1) else 0.05),
        stop_on_progression=not args.live,
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
    from stable_baselines3.common.callbacks import BaseCallback

    from collections import Counter

    cancer_model = env.model

    class LiveProgress(BaseCallback):
        """Per-step samples for the live panel, and one summary per finished
        episode: the learning curve (is the policy getting better?) and what the
        policy mostly did in that episode (is it still exploring, or settled?)."""

        def __init__(self):
            super().__init__()
            self.episode_reward = 0.0
            self.episode = 0
            self.latest_episode_reward = None
            self.actions: Counter = Counter()
            self.switches = 0
            self.last_action: int | None = None
            self.days = 0

        def _init_callback(self) -> None:
            n = self.training_env.num_envs
            self.rewards = [0.0] * n
            self.counters = [Counter() for _ in range(n)]
            self.switch_counts = [0] * n
            self.previous = [None] * n
            self.day_counts = [0] * n

        def _on_step(self) -> bool:
            actions = [int(a) for a in self.locals["actions"]]
            # report the raw reward even when PPO trains on a normalised one
            raw = self.training_env.get_original_reward() if hasattr(self.training_env, "get_original_reward") else self.locals["rewards"]
            infos = self.locals["infos"]
            for i, action in enumerate(actions):
                self.rewards[i] += float(raw[i])
                self.counters[i][action] += 1
                self.day_counts[i] += 1
                if self.previous[i] is not None and action != self.previous[i]:
                    self.switch_counts[i] += 1
                self.previous[i] = action
                if bool(self.locals["dones"][i]):
                    self.episode += 1
                    self.latest_episode_reward = self.rewards[i]
                    top, top_n = self.counters[i].most_common(1)[0]
                    info = infos[i]
                    emit_progress({
                        "type": "episode",
                        "episode": self.episode,
                        "steps": self.num_timesteps,
                        "reward": round(self.rewards[i], 3),
                        "days": self.day_counts[i],
                        "final_burden": info["burden"],
                        "initial_burden": info["initial_burden"],
                        "resistant_fraction": round(info["resistant_fraction"], 4),
                        "eci": round(info["eci"], 4),
                        "distinct_actions": len(self.counters[i]),
                        "switches": self.switch_counts[i],
                        "main_action": describe_exposures(cancer_model, env.action_table[top].exposures),
                        "main_action_share": round(top_n / max(1, self.day_counts[i]), 3),
                    })
                    self.rewards[i] = 0.0
                    self.counters[i] = Counter()
                    self.switch_counts[i] = 0
                    self.previous[i] = None
                    self.day_counts[i] = 0
            action = actions[0]
            info = infos[0]
            if self.num_timesteps % args.progress_interval < len(actions) or self.num_timesteps <= len(actions):
                emit_progress({
                    "type": "progress",
                    "steps": self.num_timesteps,
                    "total": args.total_timesteps,
                    "episode": self.episode,
                    "episode_reward": self.latest_episode_reward,
                    "burden": info["burden"],
                    "eci": info["eci"],
                    "resistant_fraction": info["resistant_fraction"],
                    "action": action,
                    "action_label": describe_exposures(cancer_model, env.action_table[action].exposures),
                })
            return True

    def emit_progress(payload: dict) -> None:
        if args.live:
            print("RL_PROGRESS " + json.dumps(payload), flush=True)

    # The daily burden penalty piles up to large, noisy episode totals (hundreds on
    # a 3D tumour). A running normalisation of the reward keeps PPO's value
    # targets in a sane range; observations are already in [0, 1] and are left as
    # they are, so the saved policy needs no extra statistics to run.
    from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv, VecNormalize
    n_envs = max(1, args.n_envs)
    if n_envs == 1:
        train_env = DummyVecEnv([lambda: env])
    else:
        # each worker draws its own episode seeds from a distinct base seed
        def make(rank: int):
            def _init():
                worker = CancerTreatmentEnv(replace(env_config, experiment=replace(env_config.experiment, seed=args.seed + 1000 * rank)))
                return worker
            return _init
        train_env = SubprocVecEnv([make(rank) for rank in range(n_envs)])
    if not args.no_reward_norm:
        train_env = VecNormalize(train_env, norm_obs=False, norm_reward=True, clip_reward=10.0)
    per_env = max(64, args.rollout_steps // n_envs)
    model = PPO("MlpPolicy", train_env, verbose=0 if args.live else 1, seed=args.seed,
                n_steps=per_env, batch_size=min(64 * n_envs, per_env * n_envs), ent_coef=args.ent_coef)
    model.learn(total_timesteps=args.total_timesteps, callback=LiveProgress())
    # the live simulator looks for outputs/rl/ppo_<cancer>.zip, so a policy trained in the panel becomes its AI
    name = args.model_name if (args.model_name != "ppo_iressa" or not args.live) else f"ppo_{args.cancer}"
    model_path = args.output_dir / f"{name}.zip"
    model.save(model_path)
    print(f"Saved PPO policy to {model_path}")
    if args.live:
        from scripts.evaluate_ppo_ui import evaluate_for_ui

        emit_progress({"type": "stage", "stage": "evaluating"})
        result = evaluate_for_ui(model, env_config)
        emit_progress({"type": "evaluation", "result": result})
        emit_progress({"type": "complete", "checkpoint": str(model_path)})
        return 0
    rows = rollout_trace(
        env_config,
        args,
        policy=lambda env, info: int(model.predict(env.last_observation, deterministic=True)[0]),
    )
    trace_csv = args.output_dir / "ppo_training_trace.csv"
    write_rows(trace_csv, rows)
    trace_png = args.output_dir / "ppo_training_trace.png"
    plot_trace(rows, trace_png, title="PPO training rollout")
    print(f"Wrote {trace_csv}")
    print(f"Wrote {trace_png}")
    return 0


def smoke_test(config: RLConfig, args: argparse.Namespace) -> None:
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows = rollout_trace(
        config,
        args,
        policy=lambda env, info: (info["step"] % len(env.action_table)),
        max_steps=args.smoke_steps,
    )

    output = args.output_dir / "ppo_smoke.csv"
    write_rows(output, rows)
    plot_output = args.output_dir / "ppo_smoke.png"
    plot_trace(rows, plot_output, title="PPO environment smoke rollout")
    print(f"Observation shape: ({len(rows[0]['observation_names'].split('|'))},)")
    print(f"Actions: {len(CancerTreatmentEnv(config).action_table)}")
    print(f"Wrote {output}")
    print(f"Wrote {plot_output}")


def rollout_trace(config: RLConfig, args: argparse.Namespace, *, policy, max_steps: int | None = None) -> list[dict]:
    env = CancerTreatmentEnv(config)
    obs, info = env.reset(seed=args.seed)
    env.last_observation = obs
    rows = []
    total_reward = 0.0
    limit = max_steps or env.max_steps
    for _ in range(limit):
        action = int(policy(env, info))
        obs, reward, terminated, truncated, info = env.step(action)
        env.last_observation = obs
        total_reward += reward
        treatment = env.action_table[action]
        margins = info["control_margins"]
        distances = info["escape_distances"]
        rows.append({
            "step": info["step"],
            "time_days": info["time_days"],
            "action": action,
            "drug": env.action_table[action].label,
            "dose": env.action_table[action].total_dose,
            "reward": reward,
            "total_reward": total_reward,
            "burden": info["burden"],
            "resistant_fraction": info["resistant_fraction"],
            "eci": info["eci"],
            "treatment_exhausted_fraction": info["treatment_exhausted_fraction"],
            "EGFR_control_margin": margins["EGFR"],
            "T790M_control_margin": margins["T790M"],
            "C797S_control_margin": margins["C797S"],
            "MET_AMP_control_margin": margins["MET_AMP"],
            "EGFR_escape_distance": distances["EGFR"],
            "T790M_escape_distance": distances["T790M"],
            "C797S_escape_distance": distances["C797S"],
            "MET_AMP_escape_distance": distances["MET_AMP"],
            "observation_names": "|".join(info["observation_names"]),
        })
        if terminated or truncated:
            break
    return rows


def write_rows(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def plot_trace(rows: list[dict], output: Path, *, title: str) -> None:
    if not rows:
        return
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib is not installed; skipping training trace plot")
        return

    time = [float(row["time_days"]) for row in rows]
    burden = [float(row["burden"]) for row in rows]
    resistant = [float(row["resistant_fraction"]) for row in rows]
    exhausted = [float(row["treatment_exhausted_fraction"]) for row in rows]
    eci = [float(row["eci"]) for row in rows]
    reward = [float(row["total_reward"]) for row in rows]
    doses = [float(row["dose"]) for row in rows]
    actions = [str(row["drug"]) for row in rows]

    fig, axes = plt.subplots(4, 1, figsize=(11, 10), sharex=True, constrained_layout=True)
    fig.suptitle(title)
    axes[0].plot(time, burden, color="#111111", linewidth=2)
    axes[0].set_ylabel("burden")
    axes[0].grid(alpha=0.25)

    axes[1].plot(time, resistant, color="#d95926", linewidth=2, label="resistant fraction")
    axes[1].plot(time, exhausted, color="#7b3f98", linewidth=2, label="exhausted fraction")
    axes[1].set_ylim(0, 1)
    axes[1].set_ylabel("fraction")
    axes[1].legend(loc="upper left")
    axes[1].grid(alpha=0.25)

    axes[2].plot(time, eci, color="#199e70", linewidth=2, label="ECI")
    axes[2].plot(time, reward, color="#555555", linewidth=1.3, label="total reward")
    axes[2].set_ylabel("control")
    axes[2].legend(loc="upper left")
    axes[2].grid(alpha=0.25)

    axes[3].step(time, doses, where="post", color="#2f80ed", linewidth=2)
    for x, drug in zip(time, actions):
        if drug != "none":
            axes[3].text(x, 0.05, drug[:3], rotation=90, va="bottom", ha="center", fontsize=8)
    axes[3].set_ylabel("dose")
    axes[3].set_xlabel("time (days)")
    axes[3].set_ylim(-0.05, max(1.05, max(doses) + 0.1))
    axes[3].grid(alpha=0.25)

    output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output, dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    raise SystemExit(main())
