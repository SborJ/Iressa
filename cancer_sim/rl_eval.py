"""Evaluation helpers for RL treatment policies."""

from __future__ import annotations

import csv
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from cancer_sim.rl_env import ACTION_TABLE, CancerTreatmentEnv


PolicyFn = Callable[[CancerTreatmentEnv, dict], int]
PolicyFactory = Callable[[], PolicyFn]


class PredictPolicy(Protocol):
    def predict(self, observation, deterministic: bool = True): ...


@dataclass(frozen=True)
class EpisodeMetrics:
    policy: str
    seed: int
    total_reward: float
    initial_burden: int
    final_burden: int
    minimum_burden: int
    max_resistant_fraction: float
    final_resistant_fraction: float
    cumulative_dose: float
    switches: int
    steps: int
    first_progression_day: float | None = None

    def as_row(self) -> dict[str, int | float | str]:
        return {
            "policy": self.policy,
            "seed": self.seed,
            "total_reward": self.total_reward,
            "initial_burden": self.initial_burden,
            "final_burden": self.final_burden,
            "minimum_burden": self.minimum_burden,
            "max_resistant_fraction": self.max_resistant_fraction,
            "final_resistant_fraction": self.final_resistant_fraction,
            "cumulative_dose": self.cumulative_dose,
            "switches": self.switches,
            "steps": self.steps,
            "first_progression_day": self.first_progression_day,
        }


def fixed_policy_factory(name: str, switch_day: float = 40.0) -> PolicyFactory:
    if name == "none":
        return lambda: lambda env, info: 0
    if name == "continuous-gefitinib":
        return lambda: lambda env, info: 2
    if name == "continuous-osimertinib":
        return lambda: lambda env, info: 4
    if name == "gefitinib-osimertinib":
        return lambda: switch_policy(switch_day)
    if name == "adaptive-gefitinib":
        return adaptive_gefitinib_policy
    raise ValueError(f"unknown fixed RL policy: {name}")


def switch_policy(switch_day: float = 40.0) -> PolicyFn:
    def policy(env: CancerTreatmentEnv, info: dict) -> int:
        return 2 if info["time_days"] < switch_day else 4

    return policy


def adaptive_gefitinib_policy() -> PolicyFn:
    treatment_on = True

    def policy(env: CancerTreatmentEnv, info: dict) -> int:
        nonlocal treatment_on
        if treatment_on and info["burden"] <= 0.5 * info["initial_burden"]:
            treatment_on = False
        elif not treatment_on and info["burden"] >= info["initial_burden"]:
            treatment_on = True
        return 2 if treatment_on else 0

    return policy


def ppo_policy(model: PredictPolicy) -> PolicyFn:
    def policy(env: CancerTreatmentEnv, info: dict) -> int:
        action, _ = model.predict(env.last_observation, deterministic=True)
        return int(action)

    return policy


def evaluate_policy(
    *,
    name: str,
    env_factory: Callable[[int], CancerTreatmentEnv],
    policy_factory: PolicyFactory,
    seeds: list[int],
) -> list[EpisodeMetrics]:
    return [run_episode(name=name, env=env_factory(seed), policy=policy_factory(), seed=seed) for seed in seeds]


def run_episode(
    *,
    name: str,
    env: CancerTreatmentEnv,
    policy: PolicyFn,
    seed: int,
) -> EpisodeMetrics:
    observation, info = env.reset(seed=seed)
    env.last_observation = observation
    total_reward = 0.0
    minimum_burden = info["initial_burden"]
    max_resistant = 0.0
    previous_drug = "none"
    switches = 0
    terminated = False
    truncated = False

    while not (terminated or truncated):
        action = policy(env, info)
        drug = ACTION_TABLE[action].drug
        if drug != previous_drug:
            switches += 1
        previous_drug = drug
        observation, reward, terminated, truncated, info = env.step(action)
        env.last_observation = observation
        total_reward += reward
        minimum_burden = min(minimum_burden, info["burden"])
        max_resistant = max(max_resistant, info["resistant_fraction"])

    return EpisodeMetrics(
        policy=name,
        seed=seed,
        total_reward=total_reward,
        initial_burden=info["initial_burden"],
        final_burden=info["burden"],
        minimum_burden=minimum_burden,
        max_resistant_fraction=max_resistant,
        final_resistant_fraction=info["resistant_fraction"],
        cumulative_dose=sum(info["cumulative_dose"].values()),
        switches=switches,
        steps=info["step"],
        first_progression_day=info["first_progression_day"],
    )


def summarize(metrics: list[EpisodeMetrics]) -> list[dict[str, int | float | str]]:
    policies = sorted({item.policy for item in metrics})
    rows = []
    for policy in policies:
        group = [item for item in metrics if item.policy == policy]
        rows.append({
            "policy": policy,
            "n": len(group),
            "total_reward_median": _median(item.total_reward for item in group),
            "final_burden_median": _median(item.final_burden for item in group),
            "minimum_burden_median": _median(item.minimum_burden for item in group),
            "final_resistant_fraction_median": _median(item.final_resistant_fraction for item in group),
            "max_resistant_fraction_median": _median(item.max_resistant_fraction for item in group),
            "cumulative_dose_median": _median(item.cumulative_dose for item in group),
            "switches_median": _median(item.switches for item in group),
            "steps_median": _median(item.steps for item in group),
            "progression_fraction": sum(item.first_progression_day is not None for item in group) / len(group),
            "progression_day_median": (
                _median(item.first_progression_day for item in group if item.first_progression_day is not None)
                if any(item.first_progression_day is not None for item in group) else None
            ),
        })
    return rows


def write_episode_metrics(path: Path, metrics: list[EpisodeMetrics]) -> None:
    rows = [item.as_row() for item in metrics]
    _write_rows(path, rows)


def write_summary(path: Path, rows: list[dict[str, int | float | str]]) -> None:
    _write_rows(path, rows)


def _median(values) -> float:
    return float(statistics.median(list(values)))


def _write_rows(path: Path, rows: list[dict[str, int | float | str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
