"""Higher-level simulation orchestration for treatment experiments."""

from __future__ import annotations

import csv
import inspect
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from cancer_sim.automata import AutomataStepStats, CellularAutomataPhysics
from cancer_sim.cancers import DEFAULT_CANCER, CancerModel, load_cancer_model


# The default (lung) model's vocabulary, kept for callers that import it. The
# runner, records and schedules take their clones and drugs from the model in use.
DRUGS = ("none", "gefitinib", "osimertinib", "capmatinib")
CLONES = ("EGFR", "T790M", "C797S", "MET_AMP")
_LEGACY_CLONE_FIELDS = {"EGFR": "egfr", "T790M": "t790m", "C797S": "c797s", "MET_AMP": "met_amp"}


@dataclass(frozen=True)
class TreatmentAction:
    """What is given over the next step.

    ``drug``/``dose`` is the primary agent (the original single-drug API).
    ``extra`` holds further agents given at the same time, as (drug, dose) pairs,
    so a combination such as endocrine deprivation plus a CDK4/6 inhibitor is one
    action. ``exposures`` is the whole thing as a mapping.
    """

    drug: str
    dose: float
    extra: tuple[tuple[str, float], ...] = ()

    def __post_init__(self) -> None:
        if not self.drug:
            raise ValueError("drug must be a non-empty name ('none' for no treatment)")
        if self.dose < 0:
            raise ValueError("dose must be non-negative")
        if self.drug == "none" and self.dose != 0:
            raise ValueError("dose must be 0 when drug is 'none'")
        for name, value in self.extra:
            if not name or name == "none":
                raise ValueError("extra agents need a drug name")
            if value < 0:
                raise ValueError("doses must be non-negative")

    @classmethod
    def combination(cls, exposures: Mapping[str, float]) -> "TreatmentAction":
        active = [(str(k), float(v)) for k, v in exposures.items() if k != "none" and v > 0]
        if not active:
            return cls("none", 0.0)
        return cls(active[0][0], active[0][1], tuple(active[1:]))

    @property
    def exposures(self) -> dict[str, float]:
        out: dict[str, float] = {}
        if self.drug != "none" and self.dose > 0:
            out[self.drug] = self.dose
        for name, value in self.extra:
            if value > 0:
                out[name] = out.get(name, 0.0) + value
        return out

    @property
    def total_dose(self) -> float:
        return sum(self.exposures.values())

    @property
    def label(self) -> str:
        parts = [f"{d}" for d in self.exposures]
        return "+".join(parts) if parts else "none"

    def uses(self, drug: str) -> bool:
        return drug in self.exposures


class TreatmentSchedule:
    """Treatment policy independent of the cellular automata physics."""

    def action(
        self,
        *,
        time: float,
        burden: int,
        initial_burden: int,
        clone_counts: Mapping[str, int] | None = None
    ) -> TreatmentAction:
        raise NotImplementedError


@dataclass(frozen=True)
class NoTreatment(TreatmentSchedule):
    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        return TreatmentAction("none", 0.0)


@dataclass(frozen=True)
class ContinuousTreatment(TreatmentSchedule):
    drug: str
    dose: float = 1.0
    start_time: float = 0.0
    stop_time: float | None = None

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if time < self.start_time:
            return TreatmentAction("none", 0.0)
        if self.stop_time is not None and time >= self.stop_time:
            return TreatmentAction("none", 0.0)
        return TreatmentAction(self.drug, self.dose)


@dataclass(frozen=True)
class SwitchTreatment(TreatmentSchedule):
    first_drug: str = "gefitinib"
    second_drug: str = "osimertinib"
    switch_time: float = 40.0
    dose: float = 1.0
    start_time: float = 0.0

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if time < self.start_time:
            return TreatmentAction("none", 0.0)
        drug = self.first_drug if time < self.switch_time else self.second_drug
        return TreatmentAction(drug, self.dose)


@dataclass
class AdaptiveAT50Treatment(TreatmentSchedule):
    """Window-based adaptive therapy: stop at 50%, restart at 100% burden."""

    drug: str = "gefitinib"
    dose: float = 1.0
    stop_fraction: float = 0.5
    restart_fraction: float = 1.0
    treatment_on: bool = True

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if initial_burden <= 0:
            return TreatmentAction("none", 0.0)

        if self.treatment_on and burden <= self.stop_fraction * initial_burden:
            self.treatment_on = False
        elif not self.treatment_on and burden >= self.restart_fraction * initial_burden:
            self.treatment_on = True

        if self.treatment_on:
            return TreatmentAction(self.drug, self.dose)
        return TreatmentAction("none", 0.0)


@dataclass(frozen=True)
class CombinationTreatment(TreatmentSchedule):
    """Several agents at once, each at its own fraction of the schedule dose."""

    exposures: tuple[tuple[str, float], ...]
    dose: float = 1.0
    start_time: float = 0.0
    stop_time: float | None = None

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if time < self.start_time or (self.stop_time is not None and time >= self.stop_time):
            return TreatmentAction("none", 0.0)
        return TreatmentAction.combination({d: f * self.dose for d, f in self.exposures})


@dataclass(frozen=True)
class CombinationSwitchTreatment(TreatmentSchedule):
    """One combination, then another after ``switch_time`` days."""

    first: tuple[tuple[str, float], ...]
    second: tuple[tuple[str, float], ...]
    switch_time: float = 40.0
    dose: float = 1.0
    start_time: float = 0.0

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if time < self.start_time:
            return TreatmentAction("none", 0.0)
        agents = self.first if time < self.switch_time else self.second
        return TreatmentAction.combination({d: f * self.dose for d, f in agents})


@dataclass
class CloneTriggeredSwitchTreatment(TreatmentSchedule):
    """Switch combinations once named clones reach a fraction of the living tumour.

    The molecular early-switch strategy: the switch is driven by the resistant
    clones' share, not by the tumour regrowing. The switch is one-way.
    """

    first: tuple[tuple[str, float], ...]
    second: tuple[tuple[str, float], ...]
    trigger_clones: tuple[str, ...]
    trigger_fraction: float = 0.1
    dose: float = 1.0
    start_time: float = 0.0
    switched: bool = False
    switch_time: float | None = None

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if time < self.start_time:
            return TreatmentAction("none", 0.0)
        if not self.switched and clone_counts and burden > 0:
            share = sum(clone_counts.get(c, 0) for c in self.trigger_clones) / burden
            if share >= self.trigger_fraction:
                self.switched = True
                self.switch_time = time
        agents = self.second if self.switched else self.first
        return TreatmentAction.combination({d: f * self.dose for d, f in agents})


@dataclass
class RegrowthTriggeredSwitchTreatment(TreatmentSchedule):
    """Switch combinations only after the tumour has responded and regrown.

    The progression-triggered strategy: ``first`` until the burden has fallen
    below ``response_fraction`` of the start and then climbed back to
    ``regrowth_factor`` times its lowest point; ``second`` from then on.
    """

    first: tuple[tuple[str, float], ...]
    second: tuple[tuple[str, float], ...]
    response_fraction: float = 0.8
    regrowth_factor: float = 1.2
    dose: float = 1.0
    start_time: float = 0.0
    responded: bool = False
    nadir: int | None = None
    switched: bool = False
    switch_time: float | None = None

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if time < self.start_time:
            return TreatmentAction("none", 0.0)
        if not self.switched and initial_burden > 0:
            if burden < self.response_fraction * initial_burden:
                self.responded = True
            if self.responded:
                self.nadir = burden if self.nadir is None else min(self.nadir, burden)
                if burden >= self.regrowth_factor * max(self.nadir, 1) and burden > self.nadir:
                    self.switched = True
                    self.switch_time = time
        agents = self.second if self.switched else self.first
        return TreatmentAction.combination({d: f * self.dose for d, f in agents})


@dataclass
class AdaptiveCombinationTreatment(TreatmentSchedule):
    """AT50-style holiday applied to a combination."""

    exposures: tuple[tuple[str, float], ...]
    dose: float = 1.0
    stop_fraction: float = 0.5
    restart_fraction: float = 1.0
    treatment_on: bool = True

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if initial_burden <= 0:
            return TreatmentAction("none", 0.0)
        if self.treatment_on and burden <= self.stop_fraction * initial_burden:
            self.treatment_on = False
        elif not self.treatment_on and burden >= self.restart_fraction * initial_burden:
            self.treatment_on = True
        if self.treatment_on:
            return TreatmentAction.combination({d: f * self.dose for d, f in self.exposures})
        return TreatmentAction("none", 0.0)


@dataclass(frozen=True)
class SimulationRecord:
    """One step of a run. Clone counts are generic (``clone_counts``); the four
    lung clones also appear as ``egfr``/``t790m``/``c797s``/``met_amp`` for the
    original callers and CSV layout."""

    step: int
    time: float
    drug: str
    dose: float
    burden: int
    births: int
    mutations: int
    drug_deaths: int
    hypoxic_deaths: int
    proliferating: int
    quiescent: int
    necrotic: int
    mean_oxygen: float
    mean_drug: float
    egfr: int = 0
    t790m: int = 0
    c797s: int = 0
    met_amp: int = 0
    clone_counts: Mapping[str, int] = field(default_factory=dict)
    exposures: Mapping[str, float] = field(default_factory=dict)

    def __post_init__(self) -> None:
        counts = dict(self.clone_counts)
        if not counts:
            counts = {clone: int(getattr(self, attr)) for clone, attr in _LEGACY_CLONE_FIELDS.items()}
        else:
            for clone, attr in _LEGACY_CLONE_FIELDS.items():
                object.__setattr__(self, attr, int(counts.get(clone, 0)))
        object.__setattr__(self, "clone_counts", counts)
        exposures = dict(self.exposures)
        if not exposures and self.drug != "none" and self.dose > 0:
            exposures = {self.drug: float(self.dose)}
        object.__setattr__(self, "exposures", exposures)

    def count(self, clone_id: str) -> int:
        return int(self.clone_counts.get(clone_id, 0))

    def resistant_count(self, resistant_clones) -> int:
        return sum(self.count(c) for c in resistant_clones)

    def as_row(self) -> dict[str, int | float | str]:
        row: dict[str, int | float | str] = {
            "step": self.step,
            "time": self.time,
            "drug": self.drug,
            "dose": self.dose,
            "burden": self.burden,
            "births": self.births,
            "mutations": self.mutations,
            "drug_deaths": self.drug_deaths,
            "hypoxic_deaths": self.hypoxic_deaths,
            "proliferating": self.proliferating,
            "quiescent": self.quiescent,
            "necrotic": self.necrotic,
            "mean_oxygen": self.mean_oxygen,
            "mean_drug": self.mean_drug,
        }
        row.update(self.clone_counts)
        return row


class SimulationRunner:
    def __init__(self, automata: CellularAutomataPhysics, schedule: TreatmentSchedule) -> None:
        self.automata = automata
        self.schedule = schedule
        self.initial_burden = automata.living_cell_count()
        self.history: list[SimulationRecord] = []
        self._passes_clone_counts = _accepts_clone_counts(schedule)

    @property
    def model(self) -> CancerModel:
        return self.automata.model

    def run(self, *, steps: int, dt: float = 1.0) -> list[SimulationRecord]:
        if steps < 0:
            raise ValueError("steps must be non-negative")
        for step in range(1, steps + 1):
            self.step(dt=dt, step_number=step)
        return self.history

    def step(self, *, dt: float = 1.0, step_number: int | None = None) -> SimulationRecord:
        burden = self.automata.living_cell_count()
        kwargs = {"time": self.automata.time, "burden": burden, "initial_burden": self.initial_burden}
        if self._passes_clone_counts:
            kwargs["clone_counts"] = self.clone_counts()
        action = self.schedule.action(**kwargs)
        extra = dict(action.extra)
        stats = self.automata.step(
            dt=dt,
            drug=action.drug,
            vessel_drug_dose=action.dose,
            exposures=extra or None
        )
        record = self._record(step_number or len(self.history) + 1, action, stats)
        self.history.append(record)
        return record

    def _record(
        self,
        step: int,
        action: TreatmentAction,
        stats: AutomataStepStats
    ) -> SimulationRecord:
        return SimulationRecord(
            step=step,
            time=self.automata.time,
            drug=action.drug,
            dose=action.dose,
            burden=stats.living_cells_after,
            births=stats.births,
            mutations=stats.mutations,
            drug_deaths=stats.drug_deaths,
            hypoxic_deaths=stats.hypoxic_deaths,
            proliferating=stats.proliferating_cells,
            quiescent=stats.quiescent_cells,
            necrotic=stats.necrotic_cells,
            mean_oxygen=stats.mean_oxygen,
            mean_drug=stats.mean_drug,
            clone_counts=self.clone_counts(),
            exposures=action.exposures
        )

    def clone_counts(self) -> dict[str, int]:
        counts = {clone: 0 for clone in self.model.clone_ids}
        for cell in self.automata.world._cells.values():
            if cell.living and cell.clone_id in counts:
                counts[cell.clone_id] += 1
        return counts


def _accepts_clone_counts(schedule: TreatmentSchedule) -> bool:
    """Schedules written against the original three-argument ``action`` keep working."""
    try:
        parameters = inspect.signature(schedule.action).parameters
    except (TypeError, ValueError):
        return False
    return "clone_counts" in parameters or any(p.kind is p.VAR_KEYWORD for p in parameters.values())


def write_history_csv(path: Path, history: list[SimulationRecord]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [record.as_row() for record in history]
    if not rows:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def _agents(spec: Any) -> tuple[tuple[str, float], ...]:
    """``{"drug": fraction}`` or ``[["drug", fraction], ...]`` from a model file."""
    if isinstance(spec, Mapping):
        return tuple((str(k), float(v)) for k, v in spec.items())
    return tuple((str(k), float(v)) for k, v in spec)


def build_schedule(
    name: str,
    *,
    dose: float = 1.0,
    switch_time: float = 40.0,
    model: CancerModel | str | None = None
) -> TreatmentSchedule:
    """A schedule by name, as declared in the cancer model's ``schedules`` block."""
    cancer = model if isinstance(model, CancerModel) else load_cancer_model(model or DEFAULT_CANCER)
    spec = cancer.schedules.get(name)
    if spec is None:
        raise ValueError(f"unknown schedule: {name}")
    kind = spec.get("type", "continuous")
    if kind == "none":
        return NoTreatment()
    if kind == "continuous":
        return ContinuousTreatment(spec["drug"], dose=dose)
    if kind == "switch":
        return SwitchTreatment(spec["first"], spec["second"], switch_time=switch_time, dose=dose)
    if kind == "adaptive":
        return AdaptiveAT50Treatment(spec["drug"], dose=dose)
    if kind == "combination":
        return CombinationTreatment(_agents(spec["agents"]), dose=dose)
    if kind == "combination-switch":
        return CombinationSwitchTreatment(_agents(spec["first"]), _agents(spec["second"]), switch_time=switch_time, dose=dose)
    if kind == "clone-triggered-switch":
        return CloneTriggeredSwitchTreatment(
            _agents(spec["first"]), _agents(spec["second"]),
            trigger_clones=tuple(spec["trigger_clones"]),
            trigger_fraction=float(spec.get("trigger_fraction", 0.1)), dose=dose
        )
    if kind == "adaptive-combination":
        return AdaptiveCombinationTreatment(
            _agents(spec["agents"]), dose=dose,
            stop_fraction=float(spec.get("stop_fraction", 0.5)), restart_fraction=float(spec.get("restart_fraction", 1.0))
        )
    if kind == "regrowth-triggered-switch":
        return RegrowthTriggeredSwitchTreatment(
            _agents(spec["first"]), _agents(spec["second"]), dose=dose,
            response_fraction=float(spec.get("response_fraction", 0.8)), regrowth_factor=float(spec.get("regrowth_factor", 1.2))
        )
    raise ValueError(f"{cancer.id}: schedule {name} has unknown type {kind!r}")
