"""Higher-level simulation orchestration for treatment experiments."""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

from cancer_sim.automata import AutomataStepStats, CellularAutomataPhysics


DRUGS = ("none", "gefitinib", "osimertinib", "capmatinib")
CLONES = ("EGFR", "T790M", "C797S", "MET_AMP")


@dataclass(frozen=True)
class TreatmentAction:
    drug: str
    dose: float

    def __post_init__(self) -> None:
        if self.drug not in DRUGS:
            raise ValueError(f"drug must be one of: {', '.join(DRUGS)}")
        if self.dose < 0:
            raise ValueError("dose must be non-negative")


class TreatmentSchedule:
    """Treatment policy independent of the cellular automata physics."""

    def action(
        self,
        *,
        time: float,
        burden: int,
        initial_burden: int
    ) -> TreatmentAction:
        raise NotImplementedError


@dataclass(frozen=True)
class NoTreatment(TreatmentSchedule):
    def action(self, *, time: float, burden: int, initial_burden: int) -> TreatmentAction:
        return TreatmentAction("none", 0.0)


@dataclass(frozen=True)
class ContinuousTreatment(TreatmentSchedule):
    drug: str
    dose: float = 1.0
    start_time: float = 0.0
    stop_time: float | None = None

    def action(self, *, time: float, burden: int, initial_burden: int) -> TreatmentAction:
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

    def action(self, *, time: float, burden: int, initial_burden: int) -> TreatmentAction:
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

    def action(self, *, time: float, burden: int, initial_burden: int) -> TreatmentAction:
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
class SimulationRecord:
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
    egfr: int
    t790m: int
    c797s: int
    met_amp: int

    def as_row(self) -> dict[str, int | float | str]:
        return {
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
            "EGFR": self.egfr,
            "T790M": self.t790m,
            "C797S": self.c797s,
            "MET_AMP": self.met_amp
        }


class SimulationRunner:
    def __init__(self, automata: CellularAutomataPhysics, schedule: TreatmentSchedule) -> None:
        self.automata = automata
        self.schedule = schedule
        self.initial_burden = automata.living_cell_count()
        self.history: list[SimulationRecord] = []

    def run(self, *, steps: int, dt: float = 1.0) -> list[SimulationRecord]:
        if steps < 0:
            raise ValueError("steps must be non-negative")
        for step in range(1, steps + 1):
            self.step(dt=dt, step_number=step)
        return self.history

    def step(self, *, dt: float = 1.0, step_number: int | None = None) -> SimulationRecord:
        burden = self.automata.living_cell_count()
        action = self.schedule.action(
            time=self.automata.time,
            burden=burden,
            initial_burden=self.initial_burden
        )
        stats = self.automata.step(
            dt=dt,
            drug=action.drug,
            vessel_drug_dose=action.dose
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
        clone_counts = self.clone_counts()
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
            egfr=clone_counts["EGFR"],
            t790m=clone_counts["T790M"],
            c797s=clone_counts["C797S"],
            met_amp=clone_counts["MET_AMP"]
        )

    def clone_counts(self) -> dict[str, int]:
        counts = {clone: 0 for clone in CLONES}
        world = self.automata.world
        for y in range(world.config.height):
            for x in range(world.config.width):
                site = world.site(x, y)
                if site.living and site.clone_id in counts:
                    counts[site.clone_id] += 1
        return counts


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


def build_schedule(name: str, *, dose: float = 1.0, switch_time: float = 40.0) -> TreatmentSchedule:
    if name == "none":
        return NoTreatment()
    if name == "continuous-gefitinib":
        return ContinuousTreatment("gefitinib", dose=dose)
    if name == "continuous-osimertinib":
        return ContinuousTreatment("osimertinib", dose=dose)
    if name == "continuous-capmatinib":
        return ContinuousTreatment("capmatinib", dose=dose)
    if name == "gefitinib-osimertinib":
        return SwitchTreatment(switch_time=switch_time, dose=dose)
    if name == "osimertinib-capmatinib":
        return SwitchTreatment("osimertinib", "capmatinib", switch_time=switch_time, dose=dose)
    if name == "adaptive-gefitinib":
        return AdaptiveAT50Treatment("gefitinib", dose=dose)
    if name == "adaptive-osimertinib":
        return AdaptiveAT50Treatment("osimertinib", dose=dose)
    if name == "adaptive-capmatinib":
        return AdaptiveAT50Treatment("capmatinib", dose=dose)
    raise ValueError(f"unknown schedule: {name}")
