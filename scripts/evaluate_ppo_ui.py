"""Held-out PPO comparison and viewer recording for the local app."""

from __future__ import annotations

from collections import Counter
from dataclasses import replace
from time import time

from cancer_sim.cancers import DEFAULT_CANCER
from cancer_sim.iressa_export import export_run
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig
from cancer_sim.rl_eval import evaluate_policy, fixed_policy_factory, ppo_policy, summarize


# The lung model keeps its hand-written baselines; any other model compares against its own panel.
BASELINES = ("none", "continuous-gefitinib", "gefitinib-osimertinib", "adaptive-gefitinib", "continuous-osimertinib")
TEST_SEEDS = (1001, 1002, 1003)


def baselines_for(config: RLConfig) -> tuple[str, ...]:
    cancer = config.experiment.model
    return BASELINES if cancer.id == DEFAULT_CANCER else cancer.default_panel


def evaluate_for_ui(model, config: RLConfig) -> dict:
    """Use the same simulator, action space, and episode horizon as training."""
    cancer = config.experiment.model
    metrics = []
    for name in baselines_for(config):
        metrics.extend(evaluate_policy(
            name=name,
            env_factory=lambda seed: CancerTreatmentEnv(config),
            policy_factory=fixed_policy_factory(name, switch_day=config.horizon_days / 3, cancer=cancer),
            seeds=list(TEST_SEEDS),
        ))
    metrics.extend(evaluate_policy(
        name="ppo", env_factory=lambda seed: CancerTreatmentEnv(config),
        policy_factory=lambda: ppo_policy(model), seeds=list(TEST_SEEDS),
    ))

    playback_config = replace(config, record_events=True)
    env = CancerTreatmentEnv(playback_config)
    obs, info = env.reset(seed=TEST_SEEDS[0])
    env.last_observation = obs
    decisions = []
    counts = Counter()

    def advance(step: int) -> bool:
        nonlocal info
        action = int(model.predict(env.last_observation, deterministic=True)[0])
        treatment = env.action_table[action]
        obs, reward, terminated, truncated, info = env.step(action)
        env.last_observation = obs
        counts[action] += 1
        decisions.append({
            "day": round(info["time_days"], 2), "drug": treatment.label,
            "dose": treatment.total_dose, "burden": info["burden"],
            "resistant_fraction": round(info["resistant_fraction"], 3),
            "eci": round(info["eci"], 3), "reward": round(reward, 3),
        })
        return not (terminated or truncated)

    name = f"ppo-ui-{int(time() * 1000)}"
    recorded = export_run(
        playback_config.experiment, "none", name=name, runner_override=env.runner,
        advance=advance, keyframe_every_days=1.0,
    )
    return {
        "seeds": list(TEST_SEEDS),
        "summary": summarize(metrics),
        "decisions": decisions,
        "action_counts": [{"drug": env.action_table[i].label, "dose": env.action_table[i].total_dose, "count": n}
                          for i, n in sorted(counts.items())],
        "cancer": cancer.id,
        "viewer_url": recorded["viewer_url"],
        "viewer_seed": TEST_SEEDS[0],
    }
