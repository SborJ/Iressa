"""Experiment panels and metrics for simulation comparisons."""

from __future__ import annotations

import csv
import random
from dataclasses import dataclass, replace
from pathlib import Path

from cancer_sim.automata import (
    DEFAULT_NECROTIC_CLEARANCE_RATE,
    CellularAutomataPhysics,
    automata_config_from_physics_calibration
)
from cancer_sim.config_controls import apply_microenvironment_args
from cancer_sim.simulation import SimulationRecord, SimulationRunner, build_schedule, write_history_csv
from cancer_sim.world import ScalarField
from cancer_sim.world_seed import DEFAULT_VESSEL_SPACING_UM, build_seeded_world


DEFAULT_PANEL = (
    "none",
    "continuous-gefitinib",
    "gefitinib-osimertinib",
    "adaptive-gefitinib",
    "continuous-osimertinib",
    "osimertinib-capmatinib"
)

RESISTANT_CLONES = ("T790M", "C797S", "MET_AMP")


@dataclass(frozen=True)
class ExperimentConfig:
    seed: int = 7
    width: int = 50
    height: int = 40
    cells: int = 350
    steps: int = 80
    dt: float = 1.0
    dose: float = 0.9
    switch_time: float = 40.0
    mutation_scale: float = 50.0
    clone_weights: tuple[float, float, float, float] = (88.0, 8.0, 2.0, 2.0)
    c797s_growth_scale: float = 1.0
    met_growth_scale: float = 1.0
    c797s_fitness_cost: float | None = None
    met_fitness_cost: float | None = None
    vessel_concentration_scale: float = 1.0
    vessel_spacing_um: float | None = DEFAULT_VESSEL_SPACING_UM
    necrotic_clearance_rate: float = DEFAULT_NECROTIC_CLEARANCE_RATE
    drug_solver: str = "quasi_steady"
    oxygen_mm_vmax: float | None = 0.04
    depth: int = 1
    vasculature: str = "grid"
    cell_size_um: float = 20.0
    vasculature_trunks: int = 10
    vasculature_max_depth: int = 6


@dataclass(frozen=True)
class ExperimentMetrics:
    experiment: str
    seed: int
    initial_burden: int
    final_burden: int
    minimum_burden: int
    time_to_minimum_burden: float
    time_to_progression: float | None
    time_to_progression_baseline: float | None
    final_resistant_fraction: float
    max_resistant_fraction: float
    time_to_resistant_dominance: float | None
    cumulative_dose: float
    final_necrotic: int
    total_births: int
    total_mutations: int
    total_drug_deaths: int
    total_hypoxic_deaths: int

    def as_row(self) -> dict[str, int | float | str]:
        return {
            "experiment": self.experiment,
            "seed": self.seed,
            "initial_burden": self.initial_burden,
            "final_burden": self.final_burden,
            "minimum_burden": self.minimum_burden,
            "time_to_minimum_burden": self.time_to_minimum_burden,
            "time_to_progression": "" if self.time_to_progression is None else self.time_to_progression,
            "time_to_progression_baseline": (
                "" if self.time_to_progression_baseline is None else self.time_to_progression_baseline
            ),
            "final_resistant_fraction": self.final_resistant_fraction,
            "max_resistant_fraction": self.max_resistant_fraction,
            "time_to_resistant_dominance": (
                "" if self.time_to_resistant_dominance is None else self.time_to_resistant_dominance
            ),
            "cumulative_dose": self.cumulative_dose,
            "final_necrotic": self.final_necrotic,
            "total_births": self.total_births,
            "total_mutations": self.total_mutations,
            "total_drug_deaths": self.total_drug_deaths,
            "total_hypoxic_deaths": self.total_hypoxic_deaths
        }


def run_experiment_panel(
    *,
    config: ExperimentConfig,
    schedules: tuple[str, ...] = DEFAULT_PANEL,
    output_dir: Path,
    microenvironment_args=None
) -> list[ExperimentMetrics]:
    output_dir.mkdir(parents=True, exist_ok=True)
    metrics = []
    for index, schedule_name in enumerate(schedules):
        history = run_single_experiment(
            schedule_name=schedule_name,
            config=config,
            output_csv=output_dir / f"{index + 1:02d}_{schedule_name}.csv",
            microenvironment_args=microenvironment_args
        )
        metrics.append(calculate_metrics(schedule_name, config.seed, history))
    write_metrics_csv(output_dir / "experiment_metrics.csv", metrics)
    return metrics


def build_runner(
    *,
    schedule_name: str,
    config: ExperimentConfig,
    microenvironment_args=None,
    record_events: bool = False
) -> SimulationRunner:
    """Construct world, automata and schedule exactly as run_single_experiment does."""
    rng = random.Random(config.seed)
    world = build_seeded_world(
        config.width,
        config.height,
        config.cells,
        rng,
        clone_weights=config.clone_weights,
        vessel_spacing_um=config.vessel_spacing_um,
        depth=config.depth,
        vasculature=config.vasculature,
        vasculature_spec={"trunks": config.vasculature_trunks, "maxDepth": config.vasculature_max_depth},
        cell_size_um=config.cell_size_um
    )
    world.drug = ScalarField(config.width, config.height, default=0.0, depth=config.depth)
    automata_config = automata_config_from_physics_calibration(
        oxygen_mm_vmax=config.oxygen_mm_vmax,
        mutation_probability_scale=config.mutation_scale,
        necrotic_clearance_rate=config.necrotic_clearance_rate,
        drug_solver=config.drug_solver,
        gefitinib_vessel_concentration_nm=1000.0 * config.vessel_concentration_scale,
        osimertinib_vessel_concentration_nm=1000.0 * config.vessel_concentration_scale,
        capmatinib_vessel_concentration_nm=1000.0 * config.vessel_concentration_scale
    )
    if microenvironment_args is not None:
        automata_config = apply_microenvironment_args(automata_config, microenvironment_args)
    automata = CellularAutomataPhysics(world, config=automata_config, rng=rng, record_events=record_events)
    automata.clone_responses = _apply_clone_sensitivity_modifiers(
        automata.clone_responses,
        config
    )
    schedule = build_schedule(schedule_name, dose=config.dose, switch_time=config.switch_time)
    return SimulationRunner(automata, schedule)


def run_single_experiment(
    *,
    schedule_name: str,
    config: ExperimentConfig,
    output_csv: Path | None = None,
    microenvironment_args=None
) -> list[SimulationRecord]:
    runner = build_runner(schedule_name=schedule_name, config=config, microenvironment_args=microenvironment_args)
    history = runner.run(steps=config.steps, dt=config.dt)
    if output_csv is not None:
        write_history_csv(output_csv, history)
    return history


def _apply_clone_sensitivity_modifiers(
    clone_responses,
    config: ExperimentConfig
):
    responses = dict(clone_responses)
    if "C797S" in responses:
        c797s = responses["C797S"]
        responses["C797S"] = replace(
            c797s,
            growth_rate=c797s.growth_rate * config.c797s_growth_scale,
            fitness_cost=(
                c797s.fitness_cost
                if config.c797s_fitness_cost is None
                else config.c797s_fitness_cost
            )
        )
    if "MET_AMP" in responses:
        met = responses["MET_AMP"]
        responses["MET_AMP"] = replace(
            met,
            growth_rate=met.growth_rate * config.met_growth_scale,
            fitness_cost=(
                met.fitness_cost
                if config.met_fitness_cost is None
                else config.met_fitness_cost
            )
        )
    return responses


def calculate_metrics(experiment: str, seed: int, history: list[SimulationRecord]) -> ExperimentMetrics:
    if not history:
        raise ValueError("history must not be empty")

    initial = history[0].burden
    final = history[-1]
    minimum_record = min(history, key=lambda record: record.burden)
    resistant_fractions = [_resistant_fraction(record) for record in history]
    time_to_progression = _time_to_progression(history, minimum_record.burden)
    time_to_progression_baseline = _time_to_progression_baseline(history, initial)
    time_to_resistant_dominance = _time_to_resistant_dominance(history)

    return ExperimentMetrics(
        experiment=experiment,
        seed=seed,
        initial_burden=initial,
        final_burden=final.burden,
        minimum_burden=minimum_record.burden,
        time_to_minimum_burden=minimum_record.time,
        time_to_progression=time_to_progression,
        time_to_progression_baseline=time_to_progression_baseline,
        final_resistant_fraction=_resistant_fraction(final),
        max_resistant_fraction=max(resistant_fractions),
        time_to_resistant_dominance=time_to_resistant_dominance,
        cumulative_dose=sum(record.dose for record in history),
        final_necrotic=final.necrotic,
        total_births=sum(record.births for record in history),
        total_mutations=sum(record.mutations for record in history),
        total_drug_deaths=sum(record.drug_deaths for record in history),
        total_hypoxic_deaths=sum(record.hypoxic_deaths for record in history)
    )


def write_metrics_csv(path: Path, metrics: list[ExperimentMetrics]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = [item.as_row() for item in metrics]
    if not rows:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def _resistant_fraction(record: SimulationRecord) -> float:
    if record.burden <= 0:
        return 0.0
    resistant = record.t790m + record.c797s + record.met_amp
    return resistant / record.burden


def _time_to_progression(history: list[SimulationRecord], minimum_burden: int) -> float | None:
    progression_threshold = minimum_burden * 1.2
    after_minimum = False
    for record in history:
        if record.burden == minimum_burden:
            after_minimum = True
        if after_minimum and record.burden >= progression_threshold and record.burden > minimum_burden:
            return record.time
    return None


def _time_to_progression_baseline(history: list[SimulationRecord], initial_burden: int) -> float | None:
    """First time, after the burden has fallen below its starting value, that it climbs back
    to or above the starting value. Unlike the nadir-based metric this is not triggered by a
    planned drug holiday in an adaptive schedule, and it is undefined (None) for a tumour that
    never responded (never fell below baseline) or never regrew to baseline."""
    responded = False
    for record in history:
        if record.burden < initial_burden:
            responded = True
        elif responded and record.burden >= initial_burden:
            return record.time
    return None


def _time_to_resistant_dominance(history: list[SimulationRecord]) -> float | None:
    for record in history:
        if _resistant_fraction(record) >= 0.5:
            return record.time
    return None
