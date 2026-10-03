"""Evaluation helpers for RL treatment policies."""

from __future__ import annotations

import copy
import csv
import random
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol, Sequence

from cancer_sim.cancers import DEFAULT_CANCER, CancerModel, load_cancer_model
from cancer_sim.rl_env import CancerTreatmentEnv
from cancer_sim.simulation import TreatmentAction, build_schedule


PolicyFn = Callable[[CancerTreatmentEnv, dict], int]
PolicyFactory = Callable[[], PolicyFn]


class PredictPolicy(Protocol):
    def predict(self, observation, deterministic: bool = True): ...


@dataclass(frozen=True)
class EpisodeMetrics:
    """One episode. The spec's comparison metrics (section 49): time to loss of
    control, time to resistant-clone dominance, burden AUC, cumulative dose,
    controllability, switches, plus the terms needed for worst-case summaries."""

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
    horizon_days: float = 0.0
    time_to_loss_of_control: float | None = None
    time_to_resistant_dominance: float | None = None
    controlled_days: float = 0.0
    burden_auc: float = 0.0
    mean_eci: float = 0.0
    final_eci: float = 0.0
    toxic_days: int = 0
    simulated_eradication: bool = False
    randomization: dict | None = None

    @property
    def control_time(self) -> float:
        """Days of control, with the horizon as the value when control was never lost."""
        return self.horizon_days if self.time_to_loss_of_control is None else self.time_to_loss_of_control

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
            "horizon_days": self.horizon_days,
            "time_to_loss_of_control": "" if self.time_to_loss_of_control is None else self.time_to_loss_of_control,
            "time_to_resistant_dominance": "" if self.time_to_resistant_dominance is None else self.time_to_resistant_dominance,
            "controlled_days": self.controlled_days,
            "burden_auc": self.burden_auc,
            "mean_eci": self.mean_eci,
            "final_eci": self.final_eci,
            "toxic_days": self.toxic_days,
            "simulated_eradication": int(self.simulated_eradication),
        }


def fixed_policy_factory(name: str, switch_day: float = 40.0, cancer: str | CancerModel = DEFAULT_CANCER) -> PolicyFactory:
    """A non-learning baseline as an RL policy.

    The lung names keep their original hand-written action indices; any other
    name is a schedule declared by the cancer model, replayed through the action
    table (``schedule_policy_factory``), so every cancer has the same baselines
    its experiment panel uses.
    """
    model = cancer if isinstance(cancer, CancerModel) else load_cancer_model(cancer)
    if model.id == DEFAULT_CANCER:
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
    if name in model.schedules:
        return schedule_policy_factory(name, model, switch_day=switch_day)
    if name == "random":
        return random_policy_factory()
    if name == "mpc":
        return mpc_policy_factory(model)
    raise ValueError(f"unknown fixed RL policy: {name}")


def random_policy_factory(seed: int = 0) -> PolicyFactory:
    """Baseline E: a uniformly random action every decision. RL must beat this."""

    def factory() -> PolicyFn:
        rng = random.Random(seed)

        def policy(env: CancerTreatmentEnv, info: dict) -> int:
            return rng.randrange(len(env.action_table))

        return policy

    return factory


def rollout_score(records, initial_burden: int, resistant_clones: Sequence[str], dose: float, dt: float) -> float:
    """What the model-predictive controller maximises over a rollout: the burden at
    the end of the horizon and along the way, the resistant share, and a small
    dosing cost. Cytostatic drugs change the burden slowly, so the end state is
    weighted more than the path. Not a clinical objective; the simulator's own."""
    if not records:
        return 0.0
    score = 0.0
    for record in records:
        burden = record.burden / max(initial_burden, 1)
        resistant = record.resistant_count(resistant_clones) / max(record.burden, 1)
        score -= (burden + 0.5 * resistant + 0.01 * dose) * dt
    last = records[-1]
    score -= 2.0 * len(records) * dt * (last.burden / max(initial_burden, 1))
    return score


def mpc_policy_factory(model: CancerModel, horizon_steps: int = 6, candidates: Sequence[str] | None = None) -> PolicyFactory:
    """Baseline F: model-predictive control by rollout.

    At every decision the current simulator state is copied and each candidate
    action is held constant for ``horizon_steps`` steps; the action with the best
    :func:`rollout_score` is taken. The candidates are the actions the model's
    own schedules use (the first action of each), or the given labels. Each
    rollout runs the full engine, so this is slow and meant for small lattices.
    """

    def factory() -> PolicyFn:
        chosen: list[int] | None = None

        def policy(env: CancerTreatmentEnv, info: dict) -> int:
            nonlocal chosen
            if chosen is None:
                chosen = _candidate_indices(env, model, candidates)
            runner = env._runner
            dt = env.config.decision_interval_days
            best_index, best_score = chosen[0], float("-inf")
            for index in chosen:
                action = env.action_table[index]
                trial = copy.deepcopy(runner)
                trial.schedule = _Constant(action)
                records = trial.run(steps=horizon_steps, dt=dt)
                score = rollout_score(records, env._initial_burden, model.resistant_clones, action.total_dose, dt)
                if score > best_score:
                    best_index, best_score = index, score
            return best_index

        return policy

    return factory


class _Constant:
    def __init__(self, action: TreatmentAction) -> None:
        self.current = action

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        return self.current


def _candidate_indices(env: CancerTreatmentEnv, model: CancerModel, labels: Sequence[str] | None) -> list[int]:
    wanted: list[dict[str, float]] = [{}]
    if labels:
        # "endocrine:1.0+palbociclib:0.5"
        wanted += [{part.split(":")[0]: float(part.split(":")[1]) for part in label.split("+")} for label in labels]
    else:
        for spec in model.schedules.values():
            for key in ("agents", "first", "second", "drug"):
                if key in spec:
                    value = spec[key]
                    wanted.append({str(value): 1.0} if isinstance(value, str) else {str(k): float(v) for k, v in dict(value).items()})
    indices: list[int] = []
    for target in wanted:
        for index, action in enumerate(env.action_table):
            if action.exposures == target and index not in indices:
                indices.append(index)
                break
    return indices or [0]


def schedule_policy_factory(name: str, model: CancerModel, switch_day: float = 40.0) -> PolicyFactory:
    """Drive the environment with one of the model's treatment schedules.

    Each step the schedule's action is matched to the environment's action table
    (exact agents and doses, with the schedule run at dose 1.0). A schedule whose
    actions are not in the table is a configuration error, raised on first use.
    """

    def factory() -> PolicyFn:
        schedule = build_schedule(name, dose=1.0, switch_time=switch_day, model=model)

        def policy(env: CancerTreatmentEnv, info: dict) -> int:
            wanted: TreatmentAction = schedule.action(
                time=float(info.get("time_days", 0.0)),
                burden=int(info.get("burden", 0)),
                initial_burden=int(info.get("initial_burden", 1)),
                clone_counts=info.get("clone_counts"),
            )
            target = wanted.exposures
            for index, action in enumerate(env.action_table):
                if action.exposures == target:
                    return index
            raise ValueError(f"schedule {name} asks for {wanted.label} at {target}, which is not in the action table")

        return policy

    return factory


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
    dt = env.config.decision_interval_days
    eci_min = env.config.eci_min
    progression = env.config.progression_multiplier * info["initial_burden"]
    loss_of_control: float | None = None
    dominance: float | None = None
    controlled_days = 0.0
    burden_auc = 0.0
    ecis: list[float] = []

    while not (terminated or truncated):
        action = policy(env, info)
        drug = env.action_table[action].label
        if drug != previous_drug:
            switches += 1
        previous_drug = drug
        observation, reward, terminated, truncated, info = env.step(action)
        env.last_observation = observation
        total_reward += reward
        minimum_burden = min(minimum_burden, info["burden"])
        max_resistant = max(max_resistant, info["resistant_fraction"])
        ecis.append(info["eci"])
        burden_auc += info["burden"] / max(info["initial_burden"], 1) * dt
        in_control = info["eci"] >= eci_min and info["burden"] < progression
        if in_control:
            controlled_days += dt
        elif loss_of_control is None:
            loss_of_control = info["time_days"]
        if dominance is None and info["resistant_fraction"] >= 0.5:
            dominance = info["time_days"]

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
        horizon_days=env.config.horizon_days,
        time_to_loss_of_control=loss_of_control,
        time_to_resistant_dominance=dominance,
        controlled_days=controlled_days,
        burden_auc=burden_auc,
        mean_eci=statistics.fmean(ecis) if ecis else 0.0,
        final_eci=info["eci"],
        toxic_days=int(info.get("toxic_days", 0)),
        simulated_eradication=info["burden"] <= 0,
        randomization=dict(info.get("randomization") or {}) or None,
    )


def cvar(values, alpha: float = 0.10) -> float:
    """Mean of the worst ``alpha`` fraction of outcomes (lower tail), at least one value.
    With a handful of seeds this is the worst case; it is the risk-sensitive view the
    spec asks for alongside the median."""
    ordered = sorted(float(v) for v in values)
    if not ordered:
        return float("nan")
    k = max(1, int(round(alpha * len(ordered))))
    return float(statistics.fmean(ordered[:k]))


def summarize(metrics: list[EpisodeMetrics]) -> list[dict[str, int | float | str]]:
    policies = sorted({item.policy for item in metrics})
    rows = []
    for policy in policies:
        group = [item for item in metrics if item.policy == policy]
        dominance = [item.time_to_resistant_dominance for item in group if item.time_to_resistant_dominance is not None]
        rows.append({
            "policy": policy,
            "n": len(group),
            "total_reward_median": _median(item.total_reward for item in group),
            "control_time_median": _median(item.control_time for item in group),
            "control_time_cvar10": cvar(item.control_time for item in group),
            "control_time_min": min(item.control_time for item in group),
            "lost_control_fraction": sum(item.time_to_loss_of_control is not None for item in group) / len(group),
            "controlled_days_median": _median(item.controlled_days for item in group),
            "time_to_resistant_dominance_median": _median(dominance) if dominance else "",
            "dominance_fraction": len(dominance) / len(group),
            "burden_auc_median": _median(item.burden_auc for item in group),
            "final_burden_median": _median(item.final_burden for item in group),
            "minimum_burden_median": _median(item.minimum_burden for item in group),
            "final_resistant_fraction_median": _median(item.final_resistant_fraction for item in group),
            "max_resistant_fraction_median": _median(item.max_resistant_fraction for item in group),
            "mean_eci_median": _median(item.mean_eci for item in group),
            "cumulative_dose_median": _median(item.cumulative_dose for item in group),
            "toxic_days_median": _median(item.toxic_days for item in group),
            "switches_median": _median(item.switches for item in group),
            "eradication_fraction": sum(item.simulated_eradication for item in group) / len(group),
        })
    return rows


def summary_markdown(rows: list[dict[str, int | float | str]], title: str = "") -> str:
    """The summary as a Markdown table, for docs and reports."""
    columns = [
        ("policy", "Policy"), ("n", "n"), ("control_time_median", "Control (d, median)"),
        ("control_time_cvar10", "Control (d, worst 10%)"), ("lost_control_fraction", "Lost control"),
        ("time_to_resistant_dominance_median", "Resistant dominance (d)"), ("dominance_fraction", "Dominated"),
        ("burden_auc_median", "Burden AUC"), ("final_resistant_fraction_median", "Final resistant"),
        ("mean_eci_median", "Mean ECI"), ("cumulative_dose_median", "Dose"), ("switches_median", "Switches"),
    ]
    def fmt(v):
        if v == "" or v is None:
            return "—"
        if isinstance(v, float):
            return f"{v:.2f}" if abs(v) < 100 else f"{v:.0f}"
        return str(v)
    lines = []
    if title:
        lines += [f"### {title}", ""]
    lines.append("| " + " | ".join(h for _, h in columns) + " |")
    lines.append("|" + "|".join("---" for _ in columns) + "|")
    for row in rows:
        lines.append("| " + " | ".join(fmt(row.get(k, "")) for k, _ in columns) + " |")
    return "\n".join(lines) + "\n"


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
