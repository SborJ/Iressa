"""Gymnasium-style RL environment for treatment-policy experiments.

The environment wraps the existing calibrated cellular automata engine. It does
not replace the simulator physics; an action only chooses the drug and dose for
the next biological decision interval.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, replace
from typing import Any, Mapping

import numpy as np

from cancer_sim.cancers import CancerModel, load_cancer_model
from cancer_sim.controllability import TumorControllability, evaluate_tumor_controllability, model_actions
from cancer_sim.experiments import ExperimentConfig, build_runner
from cancer_sim.simulation import DRUGS, SimulationRecord, TreatmentAction, TreatmentSchedule

try:  # pragma: no cover - exercised only when Gymnasium is installed.
    import gymnasium as gym
    from gymnasium import spaces
except ImportError:  # pragma: no cover - the fallback is covered by local tests.
    gym = None
    spaces = None


def action_table_for(model: CancerModel) -> tuple[TreatmentAction, ...]:
    """Discrete actions for a model: its ``rl_actions`` block (no treatment first)."""
    return model_actions(model)


def observation_names_for(model: CancerModel) -> tuple[str, ...]:
    """Summary features: per-clone fractions, margins and escape distances, per-drug cumulative exposure."""
    clones = model.clone_ids
    return (
        "time_fraction",
        "burden_fraction",
        "recent_burden_slope",
        *(f"{c}_fraction" for c in clones),
        "necrotic_fraction",
        "mean_oxygen",
        "mean_drug",
        "current_drug_id",
        "current_dose",
        *(f"{c}_control_margin" for c in clones),
        *(f"{c}_escape_distance" for c in clones),
        "evolutionary_controllability_index",
        "treatment_exhausted_fraction",
        *(f"cumulative_{d}" for d in model.drug_ids),
        "days_since_last_switch_fraction",
    )


# The default (lung) model's tables, for callers that import them.
ACTION_TABLE: tuple[TreatmentAction, ...] = action_table_for(load_cancer_model())
OBSERVATION_NAMES: tuple[str, ...] = observation_names_for(load_cancer_model())


def _gym_base():
    return gym.Env if gym is not None else object


def _discrete(n: int):
    if spaces is not None:
        return spaces.Discrete(n)
    return DiscreteSpace(n)


def _box(low: float, high: float, shape: tuple[int, ...], dtype):
    if spaces is not None:
        return spaces.Box(low=low, high=high, shape=shape, dtype=dtype)
    return BoxSpace(low, high, shape, dtype)


@dataclass(frozen=True)
class RLConfig:
    """Configuration for one treatment-control episode."""

    experiment: ExperimentConfig = ExperimentConfig(steps=120, dt=1.0)
    horizon_days: float = 120.0
    decision_interval_days: float = 1.0
    progression_multiplier: float = 1.2
    max_cumulative_dose: float = 240.0
    burden_weight: float = 1.0
    growth_weight: float = 0.5
    resistance_weight: float = 0.5
    dose_weight: float = 0.05
    switch_weight: float = 0.02
    necrosis_weight: float = 0.1
    control_weight: float = 0.5
    controlled_day_reward: float = 1.0
    eci_weight: float = 0.5
    exhaustion_weight: float = 0.5
    eci_min: float = 0.05
    stop_on_progression: bool = True
    controllability_horizon_days: float = 30.0
    # spec section 42: reward the *improvement* in controllability and penalise heavy days
    eci_delta_weight: float = 0.2
    toxicity_weight: float = 0.2
    toxicity_threshold: float = 1.75
    """Total normalised exposure at or above which a day counts as severe toxicity (ASSUMPTION; ablate)."""
    # "full": every feature; "fractions_only": controllability features zeroed (spatial/metric ablation)
    observation_mode: str = "full"
    # spec section 45: draw the uncertain biology from the model's ``randomization`` block each episode
    randomize: bool = False
    record_events: bool = False

    def __post_init__(self) -> None:
        if self.horizon_days <= 0:
            raise ValueError("horizon_days must be positive")
        if self.decision_interval_days <= 0:
            raise ValueError("decision_interval_days must be positive")
        if not 0 <= self.eci_min <= 1:
            raise ValueError("eci_min must be in [0, 1]")
        if self.controllability_horizon_days <= 0:
            raise ValueError("controllability_horizon_days must be positive")
        if self.observation_mode not in ("full", "fractions_only"):
            raise ValueError("observation_mode must be 'full' or 'fractions_only'")


class FixedActionSchedule(TreatmentSchedule):
    """Schedule object used by SimulationRunner; the RL env sets it each step."""

    def __init__(self) -> None:
        self.current = TreatmentAction("none", 0.0)

    def set(self, action: TreatmentAction) -> None:
        self.current = action

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        return self.current


class CancerTreatmentEnv(_gym_base()):
    """Gymnasium-compatible PPO environment for simulated treatment control.

    Actions are discrete drug/dose choices from :data:`ACTION_TABLE`.
    Observations are summary features, not image/lattice tensors, so PPO can be
    debugged before introducing spatial observations.
    """

    metadata = {"render_modes": []}

    def __init__(self, config: RLConfig | None = None):
        if gym is not None:
            super().__init__()
        self.config = config or RLConfig()
        self.model: CancerModel = self.config.experiment.model
        self.action_table: tuple[TreatmentAction, ...] = action_table_for(self.model)
        self.observation_names: tuple[str, ...] = observation_names_for(self.model)
        self._drug_ids = ("none",) + tuple(self.model.drug_ids)
        self.action_space = _discrete(len(self.action_table))
        self.observation_space = _box(-np.inf, np.inf, (len(self.observation_names),), np.float32)
        self._schedule = FixedActionSchedule()
        self._runner = None
        self._last_record: SimulationRecord | None = None
        self._previous_record: SimulationRecord | None = None
        self._step_index = 0
        self._initial_burden = 1
        self._minimum_burden = 1
        self._cumulative_dose = {drug: 0.0 for drug in self._drug_ids}
        self._last_drug = "none"
        self._days_since_switch = 0.0
        self._previous_eci: float | None = None
        self._last_eci_delta = 0.0
        self._toxic_days = 0
        self.theta: dict[str, float] = {}
        self.last_observation = np.zeros(len(self.observation_names), dtype=np.float32)
        self._first_progression_day: float | None = None
        self._episode_rng = np.random.default_rng(self.config.experiment.seed)

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None
    ) -> tuple[np.ndarray, dict[str, Any]]:
        if gym is not None:
            super().reset(seed=seed)
        if seed is not None:
            self._episode_rng = np.random.default_rng(seed)
        else:
            seed = int(self._episode_rng.integers(0, 2**31 - 1))
        experiment = replace(
            self.config.experiment,
            seed=seed,
            steps=self.max_steps,
            dt=self.config.decision_interval_days
        )
        self.theta = {}
        if self.config.randomize:
            experiment, self.theta = sample_domain(self.model, experiment, random.Random(seed ^ 0x5EED))
        self._schedule = FixedActionSchedule()
        self._runner = build_runner(schedule_name="none", config=experiment, record_events=self.config.record_events)
        if self.config.randomize:
            apply_domain(self.model, self._runner.automata, self.theta)
        self._runner.schedule = self._schedule
        self._previous_eci = None
        self._last_eci_delta = 0.0
        self._toxic_days = 0
        self._step_index = 0
        self._last_record = None
        self._previous_record = None
        self._initial_burden = max(self._runner.initial_burden, 1)
        self._minimum_burden = self._initial_burden
        self._first_progression_day = None
        self._cumulative_dose = {drug: 0.0 for drug in self._drug_ids}
        self._last_drug = "none"
        self._days_since_switch = 0.0
        self.last_observation = self._observation()
        return self.last_observation, self._info()

    @property
    def runner(self):
        if self._runner is None:
            raise RuntimeError("environment must be reset before accessing runner")
        return self._runner

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        if self._runner is None:
            self.reset()
        if not 0 <= int(action) < len(self.action_table):
            raise ValueError(f"action must be in [0, {len(self.action_table) - 1}]")
        return self.step_action(self.action_table[int(action)])

    def step_action(self, treatment: TreatmentAction) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        """Advance one decision interval under any treatment, not only one from the
        action table: the live simulator applies whatever exposures the viewer set."""
        if self._runner is None:
            self.reset()
        for drug in treatment.exposures:
            if not self.model.has_drug(drug):
                raise ValueError(f"{self.model.id} has no drug {drug!r}")
        if treatment.label != self._last_drug:
            self._days_since_switch = 0.0
        else:
            self._days_since_switch += self.config.decision_interval_days
        self._last_drug = treatment.label
        self._schedule.set(treatment)

        self._previous_record = self._last_record
        self._last_record = self._runner.step(
            dt=self.config.decision_interval_days,
            step_number=self._step_index + 1
        )
        self._step_index += 1
        self._minimum_burden = min(self._minimum_burden, self._last_record.burden)
        for drug, dose in treatment.exposures.items():
            self._cumulative_dose[drug] = self._cumulative_dose.get(drug, 0.0) + dose

        control = self._controllability()
        reward, components = self._reward(self._last_record, treatment, control)
        self._previous_eci = control.eci
        progressed = self._last_record.burden >= self.config.progression_multiplier * self._initial_burden
        if progressed and self._first_progression_day is None:
            self._first_progression_day = self._step_index * self.config.decision_interval_days
        treatment_exhausted = control.eci < self.config.eci_min
        terminated = (self._last_record.burden <= 0 or
                      (progressed and self.config.stop_on_progression) or treatment_exhausted)
        truncated = self._step_index >= self.max_steps
        info = self._info()
        info["reward_components"] = components
        self.last_observation = self._observation()
        return self.last_observation, reward, terminated, truncated, info

    @property
    def max_steps(self) -> int:
        return max(1, round(self.config.horizon_days / self.config.decision_interval_days))

    def action_meaning(self, action: int) -> TreatmentAction:
        return self.action_table[action]

    def _observation(self) -> np.ndarray:
        record = self._last_record
        clones = self.model.clone_ids
        if record is None:
            burden = self._initial_burden
            counts = {c: (self._initial_burden if i == 0 else 0) for i, c in enumerate(clones)}
            necrotic = 0
            mean_oxygen = 0.0
            mean_drug = 0.0
        else:
            burden = record.burden
            counts = {c: record.count(c) for c in clones}
            necrotic = record.necrotic
            mean_oxygen = record.mean_oxygen
            mean_drug = record.mean_drug

        control = self._controllability()
        metrics_on = self.config.observation_mode == "full"
        prev_burden = self._previous_record.burden if self._previous_record else self._initial_burden
        burden_denom = max(self._initial_burden, 1)
        living_denom = max(burden, 1)
        total_cells = max(burden + necrotic, 1)
        # the primary agent of the current action, as a position in the model's drug list
        primary = self._last_drug.split("+")[0]
        current_drug_id = self._drug_ids.index(primary) / max(1, len(self._drug_ids) - 1) if primary in self._drug_ids else 0.0
        escape_scale = 30.0
        values = [
            min(1.0, self._step_index / self.max_steps),
            burden / burden_denom,
            (burden - prev_burden) / burden_denom,
            *(counts[c] / living_denom for c in clones),
            necrotic / total_cells,
            mean_oxygen,
            mean_drug,
            current_drug_id,
            self.action_table[0].dose if self._last_record is None else self._last_record.dose,
            *((control.margin(c) if metrics_on else 0.0) for c in clones),
            *((_scaled_distance(control.escape_distance(c), escape_scale) if metrics_on else 0.0) for c in clones),
            control.eci if metrics_on else 0.0,
            control.exhausted_fraction if metrics_on else 0.0,
            *(self._cumulative_dose.get(d, 0.0) / self.config.max_cumulative_dose for d in self.model.drug_ids),
            min(1.0, self._days_since_switch / self.config.horizon_days),
        ]
        return np.array(values, dtype=np.float32)

    def _reward(
        self,
        record: SimulationRecord,
        action: TreatmentAction,
        controllability: TumorControllability | None = None
    ) -> tuple[float, dict[str, float]]:
        burden = record.burden / max(self._initial_burden, 1)
        prev = self._previous_record.burden if self._previous_record else self._initial_burden
        growth = max(0.0, (record.burden - prev) / max(self._initial_burden, 1))
        resistance = _resistant_fraction(record, self.model.resistant_clones)
        necrosis = record.necrotic / max(record.burden + record.necrotic, 1)
        control = max(0.0, (prev - record.burden) / max(self._initial_burden, 1))
        controllability = controllability or self._controllability()
        switched = 1.0 if self._previous_record is not None and action.exposures != dict(self._previous_record.exposures) else 0.0
        controlled_day = float(
            record.burden < self.config.progression_multiplier * self._initial_burden
            and controllability.eci >= self.config.eci_min
        )
        eci_delta = 0.0 if self._previous_eci is None else controllability.eci - self._previous_eci
        self._last_eci_delta = eci_delta
        toxic = 1.0 if action.total_dose >= self.config.toxicity_threshold else 0.0
        self._toxic_days += int(toxic)
        components = {
            "controlled_day": self.config.controlled_day_reward * controlled_day,
            "burden": -self.config.burden_weight * burden,
            "growth": -self.config.growth_weight * growth,
            "resistance": -self.config.resistance_weight * resistance,
            "dose": -self.config.dose_weight * action.total_dose,
            "switch": -self.config.switch_weight * switched,
            "necrosis": -self.config.necrosis_weight * necrosis,
            "control": self.config.control_weight * control,
            "eci": self.config.eci_weight * controllability.eci,
            "eci_improvement": self.config.eci_delta_weight * eci_delta,
            "toxicity": -self.config.toxicity_weight * toxic,
            "treatment_exhaustion": -self.config.exhaustion_weight * controllability.exhausted_fraction,
        }
        return float(sum(components.values())), components

    def _info(self) -> dict[str, Any]:
        record = self._last_record
        burden = self._initial_burden if record is None else record.burden
        control = self._controllability()
        return {
            "step": self._step_index,
            "time_days": self._step_index * self.config.decision_interval_days,
            "burden": burden,
            "initial_burden": self._initial_burden,
            "minimum_burden": self._minimum_burden,
            "first_progression_day": self._first_progression_day,
            "resistant_fraction": 0.0 if record is None else _resistant_fraction(record, self.model.resistant_clones),
            "eci": control.eci,
            "treatment_exhausted_fraction": control.exhausted_fraction,
            "control_margins": {
                clone_id: item.margin for clone_id, item in control.clones.items()
            },
            "escape_distances": {
                clone_id: item.escape_distance for clone_id, item in control.clones.items()
            },
            "treatment_exhausted_clones": [
                clone_id for clone_id, item in control.clones.items() if item.treatment_exhausted
            ],
            "clone_counts": (
                {c: (self._initial_burden if i == 0 else 0) for i, c in enumerate(self.model.clone_ids)}
                if record is None else {c: record.count(c) for c in self.model.clone_ids}
            ),
            "cumulative_dose": dict(self._cumulative_dose),
            "eci_delta": self._last_eci_delta,
            "toxic_days": self._toxic_days,
            "randomization": dict(self.theta),
            "observation_names": self.observation_names,
            "action_table": self.action_table,
            "cancer": self.model.id,
        }

    def _controllability(self) -> TumorControllability:
        if self._runner is None:
            raise RuntimeError("environment must be reset before controllability is available")
        automata = self._runner.automata
        return evaluate_tumor_controllability(
            record=self._last_record,
            initial_burden=self._initial_burden,
            clone_responses=automata.clone_responses,
            transitions=automata.transitions,
            allowed_actions=self.action_table,
            progression_multiplier=self.config.progression_multiplier,
            horizon_days=self.config.controllability_horizon_days,
            vessel_concentration_nm={d: automata.reference_concentration_nm(d) for d in self.model.drug_ids},
            clone_ids=self.model.clone_ids,
            current_action=self._schedule.current if self._last_record is not None else None,
            establishment_base=automata.establishment_base,
        )


# ---------------------------------------------------------------- domain randomisation
def _draw(rng: random.Random, spec: Mapping[str, Any]) -> float:
    lo, hi = float(spec["min"]), float(spec["max"])
    if spec.get("distribution", "uniform") == "log_uniform":
        return math.exp(rng.uniform(math.log(lo), math.log(hi)))
    return rng.uniform(lo, hi)


def sample_domain(model: CancerModel, experiment: ExperimentConfig, rng: random.Random) -> tuple[ExperimentConfig, dict[str, float]]:
    """Draw one episode's uncertain biology from the model's ``randomization`` block.

    What can be set before the world is built goes into the experiment config
    (seeding mix, mutation scale, oxygen consumption, drug penetration); the rest
    is applied to the built automata by :func:`apply_domain`.
    """
    block = model.raw.get("randomization") or {}
    theta: dict[str, float] = {}
    overrides: dict[str, Any] = {}
    for key, spec in block.items():
        if not isinstance(spec, Mapping) or "min" not in spec:
            continue
        theta[key] = _draw(rng, spec)
    if "initial_resistant_fraction" in theta:
        fraction = theta["initial_resistant_fraction"]
        defaults = model.default_clone_weights
        resistant = [i for i, c in enumerate(model.clones) if c.resistant and defaults[i] > 0]
        if not resistant:
            resistant = [i for i, c in enumerate(model.clones) if c.resistant]
        share = sum(defaults[i] for i in resistant) or len(resistant)
        weights = [0.0] * len(model.clones)
        for i in resistant:
            weights[i] = 100.0 * fraction * ((defaults[i] / share) if defaults[i] > 0 else 1.0 / len(resistant))
        weights[model.clone_index(model.root_clone)] = 100.0 * (1.0 - fraction)
        overrides["clone_weights"] = tuple(weights)
    if "mutation_scale" in theta:
        overrides["mutation_scale"] = theta["mutation_scale"]
    if "oxygen_mm_vmax" in theta:
        overrides["oxygen_mm_vmax"] = theta["oxygen_mm_vmax"]
    if "vessel_concentration_scale" in theta:
        overrides["vessel_concentration_scale"] = theta["vessel_concentration_scale"]
    return replace(experiment, **overrides), theta


def apply_domain(model: CancerModel, automata, theta: Mapping[str, float]) -> None:
    """Apply the drawn fitness costs, IC50 scales and reference exposures to a built automata."""
    block = model.raw.get("randomization") or {}
    original = dict(automata.clone_responses)
    responses = dict(original)
    for clone_id, response in original.items():
        changes: dict[str, Any] = {}
        if "resistant_fitness_cost" in theta and model.clone(clone_id).resistant:
            changes["fitness_cost"] = theta["resistant_fitness_cost"]
        ic50 = dict(response.ic50_nm)
        if "ic50_multiplier" in theta:
            ic50 = {d: v * theta["ic50_multiplier"] for d, v in ic50.items()}
        for key, spec in block.items():
            if key in theta and isinstance(spec, Mapping) and spec.get("clone") == clone_id and "reference_clone" in spec:
                reference = original[spec["reference_clone"]].ic50(spec["drug"])
                if "ic50_multiplier" in theta:
                    reference *= theta["ic50_multiplier"]
                ic50[spec["drug"]] = reference * theta[key]
        if ic50 != dict(response.ic50_nm):
            changes["ic50_nm"] = ic50
            for legacy in ("gefitinib", "osimertinib", "capmatinib"):
                if legacy in ic50:
                    changes[f"{legacy}_ic50_nm"] = ic50[legacy]
        if changes:
            responses[clone_id] = replace(response, **changes)
    automata.clone_responses = responses
    concentrations = dict(automata.config.drug_vessel_concentration_nm)
    for key, spec in block.items():
        if key in theta and isinstance(spec, Mapping) and spec.get("drug") and "reference_clone" not in spec and key.startswith("reference_concentration"):
            concentrations[spec["drug"]] = theta[key] * automata.config.vessel_concentration_nm(spec["drug"], default=1.0) / model.drug(spec["drug"]).reference_concentration_nm
    if concentrations != dict(automata.config.drug_vessel_concentration_nm):
        automata.config = replace(automata.config, drug_vessel_concentration_nm=concentrations)


def _resistant_fraction(record: SimulationRecord, resistant_clones=("T790M", "C797S", "MET_AMP")) -> float:
    if record.burden <= 0:
        return 0.0
    return record.resistant_count(resistant_clones) / record.burden


def _scaled_distance(value: float, scale: float) -> float:
    if not np.isfinite(value):
        return 1.0
    return float(min(1.0, max(0.0, value / scale)))


@dataclass(frozen=True)
class DiscreteSpace:
    n: int

    def sample(self) -> int:
        return int(np.random.randint(self.n))

    def contains(self, value: object) -> bool:
        return isinstance(value, int) and 0 <= value < self.n


@dataclass(frozen=True)
class BoxSpace:
    low: float
    high: float
    shape: tuple[int, ...]
    dtype: Any

    def sample(self) -> np.ndarray:
        return np.zeros(self.shape, dtype=self.dtype)

    def contains(self, value: object) -> bool:
        arr = np.asarray(value)
        return arr.shape == self.shape
