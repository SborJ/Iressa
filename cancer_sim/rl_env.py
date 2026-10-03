"""Gymnasium-style RL environment for treatment-policy experiments.

The environment wraps the existing calibrated cellular automata engine. It does
not replace the simulator physics; an action only chooses the drug and dose for
the next biological decision interval.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

import numpy as np

from cancer_sim.controllability import TumorControllability, evaluate_tumor_controllability
from cancer_sim.experiments import ExperimentConfig, build_runner
from cancer_sim.simulation import DRUGS, SimulationRecord, TreatmentAction, TreatmentSchedule

try:  # pragma: no cover - exercised only when Gymnasium is installed.
    import gymnasium as gym
    from gymnasium import spaces
except ImportError:  # pragma: no cover - the fallback is covered by local tests.
    gym = None
    spaces = None


ACTION_TABLE: tuple[TreatmentAction, ...] = (
    TreatmentAction("none", 0.0),
    TreatmentAction("gefitinib", 0.5),
    TreatmentAction("gefitinib", 1.0),
    TreatmentAction("osimertinib", 0.5),
    TreatmentAction("osimertinib", 1.0),
    TreatmentAction("capmatinib", 0.5),
    TreatmentAction("capmatinib", 1.0),
)

OBSERVATION_NAMES: tuple[str, ...] = (
    "time_fraction",
    "burden_fraction",
    "recent_burden_slope",
    "EGFR_fraction",
    "T790M_fraction",
    "C797S_fraction",
    "MET_AMP_fraction",
    "necrotic_fraction",
    "mean_oxygen",
    "mean_drug",
    "current_drug_id",
    "current_dose",
    "EGFR_control_margin",
    "T790M_control_margin",
    "C797S_control_margin",
    "MET_AMP_control_margin",
    "EGFR_escape_distance",
    "T790M_escape_distance",
    "C797S_escape_distance",
    "MET_AMP_escape_distance",
    "evolutionary_controllability_index",
    "treatment_exhausted_fraction",
    "cumulative_gefitinib",
    "cumulative_osimertinib",
    "cumulative_capmatinib",
    "days_since_last_switch_fraction",
)


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
    controllability_horizon_days: float = 30.0

    def __post_init__(self) -> None:
        if self.horizon_days <= 0:
            raise ValueError("horizon_days must be positive")
        if self.decision_interval_days <= 0:
            raise ValueError("decision_interval_days must be positive")
        if not 0 <= self.eci_min <= 1:
            raise ValueError("eci_min must be in [0, 1]")
        if self.controllability_horizon_days <= 0:
            raise ValueError("controllability_horizon_days must be positive")


class FixedActionSchedule(TreatmentSchedule):
    """Schedule object used by SimulationRunner; the RL env sets it each step."""

    def __init__(self) -> None:
        self.current = TreatmentAction("none", 0.0)

    def set(self, action: TreatmentAction) -> None:
        self.current = action

    def action(self, *, time: float, burden: int, initial_burden: int) -> TreatmentAction:
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
        self.action_space = _discrete(len(ACTION_TABLE))
        self.observation_space = _box(-np.inf, np.inf, (len(OBSERVATION_NAMES),), np.float32)
        self._schedule = FixedActionSchedule()
        self._runner = None
        self._last_record: SimulationRecord | None = None
        self._previous_record: SimulationRecord | None = None
        self._step_index = 0
        self._initial_burden = 1
        self._minimum_burden = 1
        self._cumulative_dose = {drug: 0.0 for drug in DRUGS}
        self._last_drug = "none"
        self._days_since_switch = 0.0
        self.last_observation = np.zeros(len(OBSERVATION_NAMES), dtype=np.float32)

    def reset(
        self,
        *,
        seed: int | None = None,
        options: dict[str, Any] | None = None
    ) -> tuple[np.ndarray, dict[str, Any]]:
        if gym is not None:
            super().reset(seed=seed)
        if seed is None:
            seed = self.config.experiment.seed
        experiment = replace(
            self.config.experiment,
            seed=seed,
            steps=self.max_steps,
            dt=self.config.decision_interval_days
        )
        self._schedule = FixedActionSchedule()
        self._runner = build_runner(schedule_name="none", config=experiment)
        self._runner.schedule = self._schedule
        self._step_index = 0
        self._last_record = None
        self._previous_record = None
        self._initial_burden = max(self._runner.initial_burden, 1)
        self._minimum_burden = self._initial_burden
        self._cumulative_dose = {drug: 0.0 for drug in DRUGS}
        self._last_drug = "none"
        self._days_since_switch = 0.0
        self.last_observation = self._observation()
        return self.last_observation, self._info()

    def step(self, action: int) -> tuple[np.ndarray, float, bool, bool, dict[str, Any]]:
        if self._runner is None:
            self.reset()
        if not 0 <= int(action) < len(ACTION_TABLE):
            raise ValueError(f"action must be in [0, {len(ACTION_TABLE) - 1}]")

        treatment = ACTION_TABLE[int(action)]
        if treatment.drug != self._last_drug:
            self._days_since_switch = 0.0
        else:
            self._days_since_switch += self.config.decision_interval_days
        self._last_drug = treatment.drug
        self._schedule.set(treatment)

        self._previous_record = self._last_record
        self._last_record = self._runner.step(
            dt=self.config.decision_interval_days,
            step_number=self._step_index + 1
        )
        self._step_index += 1
        self._minimum_burden = min(self._minimum_burden, self._last_record.burden)
        self._cumulative_dose[treatment.drug] = self._cumulative_dose.get(treatment.drug, 0.0) + treatment.dose

        reward, components = self._reward(self._last_record, treatment)
        control = self._controllability()
        progressed = self._last_record.burden >= self.config.progression_multiplier * self._initial_burden
        treatment_exhausted = control.eci < self.config.eci_min
        terminated = self._last_record.burden <= 0 or progressed or treatment_exhausted
        truncated = self._step_index >= self.max_steps
        info = self._info()
        info["reward_components"] = components
        self.last_observation = self._observation()
        return self.last_observation, reward, terminated, truncated, info

    @property
    def max_steps(self) -> int:
        return max(1, round(self.config.horizon_days / self.config.decision_interval_days))

    def action_meaning(self, action: int) -> TreatmentAction:
        return ACTION_TABLE[action]

    def _observation(self) -> np.ndarray:
        record = self._last_record
        if record is None:
            burden = self._initial_burden
            counts = {
                "EGFR": self._initial_burden,
                "T790M": 0,
                "C797S": 0,
                "MET_AMP": 0,
                "necrotic": 0,
            }
            mean_oxygen = 0.0
            mean_drug = 0.0
        else:
            burden = record.burden
            counts = {
                "EGFR": record.egfr,
                "T790M": record.t790m,
                "C797S": record.c797s,
                "MET_AMP": record.met_amp,
                "necrotic": record.necrotic,
            }
            mean_oxygen = record.mean_oxygen
            mean_drug = record.mean_drug

        control = self._controllability()
        prev_burden = self._previous_record.burden if self._previous_record else self._initial_burden
        burden_denom = max(self._initial_burden, 1)
        living_denom = max(burden, 1)
        total_cells = max(burden + counts["necrotic"], 1)
        current_drug_id = DRUGS.index(self._last_drug) / (len(DRUGS) - 1)
        escape_scale = 30.0
        return np.array(
            [
                min(1.0, self._step_index / self.max_steps),
                burden / burden_denom,
                (burden - prev_burden) / burden_denom,
                counts["EGFR"] / living_denom,
                counts["T790M"] / living_denom,
                counts["C797S"] / living_denom,
                counts["MET_AMP"] / living_denom,
                counts["necrotic"] / total_cells,
                mean_oxygen,
                mean_drug,
                current_drug_id,
                ACTION_TABLE[0].dose if self._last_record is None else self._last_record.dose,
                control.margin("EGFR"),
                control.margin("T790M"),
                control.margin("C797S"),
                control.margin("MET_AMP"),
                _scaled_distance(control.escape_distance("EGFR"), escape_scale),
                _scaled_distance(control.escape_distance("T790M"), escape_scale),
                _scaled_distance(control.escape_distance("C797S"), escape_scale),
                _scaled_distance(control.escape_distance("MET_AMP"), escape_scale),
                control.eci,
                control.exhausted_fraction,
                self._cumulative_dose["gefitinib"] / self.config.max_cumulative_dose,
                self._cumulative_dose["osimertinib"] / self.config.max_cumulative_dose,
                self._cumulative_dose["capmatinib"] / self.config.max_cumulative_dose,
                min(1.0, self._days_since_switch / self.config.horizon_days),
            ],
            dtype=np.float32
        )

    def _reward(
        self,
        record: SimulationRecord,
        action: TreatmentAction
    ) -> tuple[float, dict[str, float]]:
        burden = record.burden / max(self._initial_burden, 1)
        prev = self._previous_record.burden if self._previous_record else self._initial_burden
        growth = max(0.0, (record.burden - prev) / max(self._initial_burden, 1))
        resistance = _resistant_fraction(record)
        necrosis = record.necrotic / max(record.burden + record.necrotic, 1)
        control = max(0.0, (prev - record.burden) / max(self._initial_burden, 1))
        controllability = self._controllability()
        switched = 1.0 if self._previous_record is not None and action.drug != self._previous_record.drug else 0.0
        controlled_day = 1.0 if controllability.eci >= self.config.eci_min else 0.0
        components = {
            "controlled_day": self.config.controlled_day_reward * controlled_day,
            "burden": -self.config.burden_weight * burden,
            "growth": -self.config.growth_weight * growth,
            "resistance": -self.config.resistance_weight * resistance,
            "dose": -self.config.dose_weight * action.dose,
            "switch": -self.config.switch_weight * switched,
            "necrosis": -self.config.necrosis_weight * necrosis,
            "control": self.config.control_weight * control,
            "eci": self.config.eci_weight * controllability.eci,
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
            "resistant_fraction": 0.0 if record is None else _resistant_fraction(record),
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
            "cumulative_dose": dict(self._cumulative_dose),
            "observation_names": OBSERVATION_NAMES,
            "action_table": ACTION_TABLE,
        }

    def _controllability(self) -> TumorControllability:
        if self._runner is None:
            raise RuntimeError("environment must be reset before controllability is available")
        config = self._runner.automata.config
        return evaluate_tumor_controllability(
            record=self._last_record,
            initial_burden=self._initial_burden,
            clone_responses=self._runner.automata.clone_responses,
            transitions=self._runner.automata.transitions,
            allowed_actions=ACTION_TABLE,
            progression_multiplier=self.config.progression_multiplier,
            horizon_days=self.config.controllability_horizon_days,
            vessel_concentration_nm={
                "gefitinib": config.gefitinib_vessel_concentration_nm,
                "osimertinib": config.osimertinib_vessel_concentration_nm,
                "capmatinib": config.capmatinib_vessel_concentration_nm,
            },
        )


def _resistant_fraction(record: SimulationRecord) -> float:
    if record.burden <= 0:
        return 0.0
    return (record.t790m + record.c797s + record.met_amp) / record.burden


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
