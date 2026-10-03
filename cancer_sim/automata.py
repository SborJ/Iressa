"""Cellular automata physics for oxygen, drug, and clone response.

The automata keeps cells discrete on a lattice while oxygen and drug are
continuous scalar fields. It implements diffusion, uptake, source terms,
oxygen-driven cell state, space-limited division, mutation on division, and
clone-specific drug death probabilities. It does not implement migration or
treatment strategy logic.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from math import ceil, exp
from pathlib import Path

from cancer_sim.world import Cell, ScalarField, WorldPhysics


DEFAULT_CLONE_DATA = (
    Path(__file__).resolve().parents[1] / "data" / "curated" / "egfr_resistance_seed.json"
)
DEFAULT_CALIBRATED_CLONE_DATA = (
    Path(__file__).resolve().parents[1] / "data" / "processed" / "calibrated_clone_parameters.json"
)
DEFAULT_PHYSICS_CALIBRATION = (
    Path(__file__).resolve().parents[1] / "data" / "processed" / "physics_calibration.json"
)
DEFAULT_RESISTANCE_GRAPH = (
    Path(__file__).resolve().parents[1] / "data" / "processed" / "resistance_graph.json"
)
SUPPORTED_DRUGS = {"none", "gefitinib", "osimertinib", "capmatinib"}


@dataclass(frozen=True)
class ClonePhenotype:
    clone_id: str
    growth_rate: float
    fitness_cost: float
    gefitinib_ic50_nm: float
    osimertinib_ic50_nm: float
    allowed_next_resistance_transitions: tuple[str, ...]
    capmatinib_ic50_nm: float = 8000.0
    hill_coefficient: float = 1.2
    max_drug_death_rate: float = 0.18

    @property
    def effective_fitness_multiplier(self) -> float:
        return max(0.0, 1.0 - self.fitness_cost)

    def ic50(self, drug: str) -> float:
        if drug == "gefitinib":
            return self.gefitinib_ic50_nm
        if drug == "osimertinib":
            return self.osimertinib_ic50_nm
        if drug == "capmatinib":
            return self.capmatinib_ic50_nm
        raise ValueError(f"unknown drug: {drug}")


@dataclass(frozen=True)
class ResistanceTransition:
    parent_clone: str
    child_clone: str
    alteration: str
    simulation_probability: float


@dataclass(frozen=True)
class AutomataConfig:
    field_substep_days: float = 1.0 / 24.0
    oxygen_solver: str = "quasi_steady"
    oxygen_diffusion: float = 0.12
    oxygen_solver_iterations: int = 80
    oxygen_solver_relaxation: float = 1.0
    oxygen_uptake_rate: float = 0.05
    oxygen_vessel_source: float = 0.35
    oxygen_mm_vmax: float | None = None
    oxygen_mm_km: float = 0.25
    drug_diffusion: float = 0.10
    max_explicit_diffusion_step: float = 0.20
    drug_decay_rate: float = 0.02
    drug_uptake_rate: float = 0.015
    drug_vessel_source: float = 0.45
    proliferation_oxygen_threshold: float = 0.22
    quiescence_oxygen_threshold: float = 0.08
    necrosis_threshold: float = 0.06
    necrosis_exposure_time: float = 0.25
    hypoxic_death_rate: float = 0.04
    mutation_probability_scale: float = 1.0
    gefitinib_vessel_concentration_nm: float = 1000.0
    osimertinib_vessel_concentration_nm: float = 1000.0
    capmatinib_vessel_concentration_nm: float = 1000.0

    def __post_init__(self) -> None:
        for name, value in self.__dict__.items():
            if isinstance(value, (int, float)) and value is not None and value < 0:
                raise ValueError(f"{name} must be non-negative")
        if self.oxygen_solver not in {"explicit", "quasi_steady"}:
            raise ValueError("oxygen_solver must be explicit or quasi_steady")
        if self.oxygen_solver == "explicit" and self.oxygen_diffusion > self.max_explicit_diffusion_step:
            raise ValueError("explicit oxygen diffusion exceeds the configured stability limit")
        if self.max_explicit_diffusion_step <= 0 or self.max_explicit_diffusion_step > 0.24:
            raise ValueError("max_explicit_diffusion_step must be in (0, 0.24]")
        if self.oxygen_solver_iterations < 1:
            raise ValueError("oxygen_solver_iterations must be positive")
        if self.oxygen_solver_relaxation <= 0:
            raise ValueError("oxygen_solver_relaxation must be positive")
        if self.field_substep_days <= 0:
            raise ValueError("field_substep_days must be positive")
        if self.oxygen_mm_vmax is not None and self.oxygen_mm_km <= 0:
            raise ValueError("oxygen_mm_km must be positive when Michaelis-Menten uptake is used")


@dataclass(frozen=True)
class AutomataStepStats:
    living_cells_before: int
    living_cells_after: int
    births: int
    mutations: int
    drug_deaths: int
    hypoxic_deaths: int
    proliferating_cells: int
    quiescent_cells: int
    necrotic_cells: int
    mean_oxygen: float
    mean_drug: float


class CellularAutomataPhysics:
    """Step a cell lattice and microenvironment fields forward."""

    def __init__(
        self,
        world: WorldPhysics,
        clone_responses: dict[str, ClonePhenotype] | None = None,
        transitions: dict[str, list[ResistanceTransition]] | None = None,
        config: AutomataConfig | None = None,
        rng: random.Random | None = None
    ) -> None:
        self.world = world
        self.config = config or AutomataConfig()
        loaded_responses, loaded_transitions = load_clone_model()
        self.clone_responses = clone_responses or loaded_responses
        self.transitions = transitions or loaded_transitions
        self.rng = rng or random.Random()
        self.time = 0.0

    def step(
        self,
        *,
        dt: float = 1.0,
        drug: str = "none",
        vessel_drug_dose: float = 0.0,
        apply_death: bool = True,
        allow_division: bool = True
    ) -> AutomataStepStats:
        if dt <= 0:
            raise ValueError("dt must be positive")
        if drug not in SUPPORTED_DRUGS:
            raise ValueError("drug must be one of: none, gefitinib, osimertinib, capmatinib")
        if vessel_drug_dose < 0:
            raise ValueError("vessel_drug_dose must be non-negative")

        living_before = self.living_cell_count()
        density = self.cell_density()
        self.world.oxygen = self._next_oxygen_field(density, dt)
        self.world.drug = self._next_drug_field(density, dt, active_dose=vessel_drug_dose)

        drug_deaths = 0
        hypoxic_deaths = 0
        births = 0
        mutations = 0
        self._update_cell_states(dt)
        if apply_death:
            drug_deaths, hypoxic_deaths = self._apply_death(dt, drug)
        if allow_division:
            births, mutations = self._apply_division(dt)
        self.world.age_living_cells(dt)
        state_counts = self.cell_state_counts()

        self.time += dt
        return AutomataStepStats(
            living_cells_before=living_before,
            living_cells_after=self.living_cell_count(),
            births=births,
            mutations=mutations,
            drug_deaths=drug_deaths,
            hypoxic_deaths=hypoxic_deaths,
            proliferating_cells=state_counts["proliferating"],
            quiescent_cells=state_counts["quiescent"],
            necrotic_cells=state_counts["necrotic"],
            mean_oxygen=self._mean_field(self.world.oxygen),
            mean_drug=self._mean_field(self.world.drug)
        )

    def cell_density(self) -> list[list[float]]:
        return [
            [
                1.0 if self.world.site(x, y).living else 0.0
                for x in range(self.world.config.width)
            ]
            for y in range(self.world.config.height)
        ]

    def living_cell_count(self) -> int:
        return int(sum(sum(row) for row in self.cell_density()))

    def cell_state_counts(self) -> dict[str, int]:
        counts = {"proliferating": 0, "quiescent": 0, "necrotic": 0}
        for y in range(self.world.config.height):
            for x in range(self.world.config.width):
                site = self.world.site(x, y)
                if site.state in counts:
                    counts[site.state] += 1
        return counts

    def drug_effect(self, clone_id: str, drug: str, concentration_nm: float) -> float:
        if drug == "none" or concentration_nm <= 0:
            return 0.0
        response = self.clone_responses[clone_id]
        ic50 = response.ic50(drug)
        n = response.hill_coefficient
        numerator = concentration_nm ** n
        return numerator / (ic50 ** n + numerator)

    def drug_death_probability(
        self,
        clone_id: str,
        drug: str,
        concentration_nm: float,
        dt: float
    ) -> float:
        if drug == "none":
            return 0.0
        response = self.clone_responses[clone_id]
        effect = self.drug_effect(clone_id, drug, concentration_nm)
        return 1.0 - exp(-response.max_drug_death_rate * effect * dt)

    def hypoxic_death_probability(self, oxygen: float, dt: float) -> float:
        if oxygen > self.config.necrosis_threshold:
            return 0.0
        if self.config.hypoxic_death_rate >= 100:
            return 1.0
        return 1.0 - exp(-self.config.hypoxic_death_rate * dt)

    def _next_oxygen_field(self, density: list[list[float]], dt: float) -> ScalarField:
        if self.config.oxygen_solver == "quasi_steady":
            return self._next_quasi_steady_oxygen_field(density)
        return self._next_field_substepped(
            field=self.world.oxygen,
            density=density,
            dt=dt,
            diffusion=self.config.oxygen_diffusion,
            decay=0.0,
            uptake_rate=self.config.oxygen_uptake_rate,
            source_rate=self.config.oxygen_vessel_source,
            source_attr="oxygen_strength",
            use_michaelis_menten=True
        )

    def _next_drug_field(
        self,
        density: list[list[float]],
        dt: float,
        *,
        active_dose: float
    ) -> ScalarField:
        return self._next_field_substepped(
            field=self.world.drug,
            density=density,
            dt=dt,
            diffusion=self.config.drug_diffusion,
            decay=self.config.drug_decay_rate,
            uptake_rate=self.config.drug_uptake_rate,
            source_rate=self.config.drug_vessel_source * active_dose,
            source_attr="drug_strength",
            use_michaelis_menten=False
        )

    def _next_quasi_steady_oxygen_field(self, density: list[list[float]]) -> ScalarField:
        width = self.world.config.width
        height = self.world.config.height
        values = self.world.oxygen.rows()
        source_grid = self._source_grid(self.config.oxygen_vessel_source, "oxygen_strength")
        diffusion = self.config.oxygen_diffusion
        relaxation = self.config.oxygen_solver_relaxation

        if diffusion <= 0:
            next_field = ScalarField(width, height)
            for y in range(height):
                for x in range(width):
                    value = values[y][x]
                    source = source_grid[y][x]
                    uptake_rate = self._linearized_uptake_rate(value, density[y][x])
                    next_field.set(x, y, source / max(uptake_rate, 1e-12) if uptake_rate > 0 else value + source)
            return next_field

        for _ in range(self.config.oxygen_solver_iterations):
            for y in range(height):
                for x in range(width):
                    left = values[y][max(0, x - 1)]
                    right = values[y][min(width - 1, x + 1)]
                    up = values[max(0, y - 1)][x]
                    down = values[min(height - 1, y + 1)][x]
                    uptake_rate = self._linearized_uptake_rate(values[y][x], density[y][x])
                    denominator = 4.0 * diffusion + uptake_rate
                    if denominator <= 0:
                        candidate = values[y][x] + source_grid[y][x]
                    else:
                        candidate = (
                            diffusion * (left + right + up + down)
                            + source_grid[y][x]
                        ) / denominator
                    values[y][x] = self._clamp(
                        values[y][x] + relaxation * (candidate - values[y][x])
                    )

        next_field = ScalarField(width, height)
        for y in range(height):
            for x in range(width):
                next_field.set(x, y, values[y][x])
        return next_field

    def _next_field_substepped(
        self,
        *,
        field: ScalarField,
        density: list[list[float]],
        dt: float,
        diffusion: float,
        decay: float,
        uptake_rate: float,
        source_rate: float,
        source_attr: str,
        use_michaelis_menten: bool
    ) -> ScalarField:
        if diffusion <= 0:
            diffusion_substeps = 1
        else:
            diffusion_substeps = max(1, ceil(diffusion * dt / self.config.max_explicit_diffusion_step))
        time_substeps = max(1, ceil(dt / self.config.field_substep_days))
        substeps = max(diffusion_substeps, time_substeps)
        sub_dt = dt / substeps
        next_field = field
        for _ in range(substeps):
            next_field = self._next_field(
                field=next_field,
                density=density,
                dt=sub_dt,
                diffusion=diffusion,
                decay=decay,
                uptake_rate=uptake_rate,
                source_rate=source_rate,
                source_attr=source_attr,
                use_michaelis_menten=use_michaelis_menten
            )
        return next_field

    def _next_field(
        self,
        *,
        field: ScalarField,
        density: list[list[float]],
        dt: float,
        diffusion: float,
        decay: float,
        uptake_rate: float,
        source_rate: float,
        source_attr: str,
        use_michaelis_menten: bool
    ) -> ScalarField:
        width = self.world.config.width
        height = self.world.config.height
        next_field = ScalarField(width, height)
        source_grid = self._source_grid(source_rate, source_attr)

        for y in range(height):
            for x in range(width):
                value = field.get(x, y)
                laplacian = self._laplacian(field, x, y)
                uptake = self._uptake(value, density[y][x], uptake_rate, use_michaelis_menten)
                next_value = value + dt * (
                    diffusion * laplacian
                    - decay * value
                    - uptake
                    + source_grid[y][x]
                )
                next_field.set(x, y, next_value)
        return next_field

    def _uptake(
        self,
        value: float,
        density: float,
        uptake_rate: float,
        use_michaelis_menten: bool
    ) -> float:
        if density <= 0:
            return 0.0
        if use_michaelis_menten and self.config.oxygen_mm_vmax is not None:
            return self.config.oxygen_mm_vmax * value / (self.config.oxygen_mm_km + value) * density
        return uptake_rate * density * value

    def _linearized_uptake_rate(self, value: float, density: float) -> float:
        if density <= 0:
            return 0.0
        if self.config.oxygen_mm_vmax is None:
            return self.config.oxygen_uptake_rate * density
        return (
            self.config.oxygen_mm_vmax
            / (self.config.oxygen_mm_km + max(value, 1e-9))
            * density
        )

    def _source_grid(self, source_rate: float, source_attr: str) -> list[list[float]]:
        grid = [
            [0.0 for _ in range(self.world.config.width)]
            for _ in range(self.world.config.height)
        ]
        if source_rate <= 0:
            return grid
        for vessel in self.world.vessels:
            grid[vessel.y][vessel.x] += source_rate * getattr(vessel, source_attr)
        return grid

    def _laplacian(self, field: ScalarField, x: int, y: int) -> float:
        center = field.get(x, y)
        left = field.get(max(0, x - 1), y)
        right = field.get(min(field.width - 1, x + 1), y)
        up = field.get(x, max(0, y - 1))
        down = field.get(x, min(field.height - 1, y + 1))
        return left + right + up + down - 4.0 * center

    @staticmethod
    def _clamp(value: float) -> float:
        return max(0.0, min(1.0, float(value)))

    def _update_cell_states(self, dt: float) -> None:
        for y in range(self.world.config.height):
            for x in range(self.world.config.width):
                cell = self.world.cell_at(x, y)
                if cell is None or not cell.living:
                    continue
                oxygen = self.world.oxygen.get(x, y)
                if oxygen <= self.config.necrosis_threshold:
                    cell.oxygen_stress_time += dt
                    cell.state = "quiescent"
                elif oxygen <= self.config.proliferation_oxygen_threshold:
                    cell.oxygen_stress_time = 0.0
                    cell.state = "quiescent"
                else:
                    cell.oxygen_stress_time = 0.0
                    cell.state = "proliferating"

    def _apply_death(self, dt: float, drug: str) -> tuple[int, int]:
        drug_deaths = 0
        hypoxic_deaths = 0
        for y in range(self.world.config.height):
            for x in range(self.world.config.width):
                cell = self.world.cell_at(x, y)
                if cell is None or not cell.living:
                    continue

                hypoxic_probability = self.hypoxic_death_probability(self.world.oxygen.get(x, y), dt)
                if (
                    cell.oxygen_stress_time >= self.config.necrosis_exposure_time
                    and self.rng.random() < hypoxic_probability
                ):
                    cell.state = "necrotic"
                    cell.death_cause = "hypoxia"
                    hypoxic_deaths += 1
                    continue

                concentration_nm = self.local_drug_concentration_nm(drug, x, y)
                drug_probability = self.drug_death_probability(
                    cell.clone_id,
                    drug,
                    concentration_nm,
                    dt
                )
                if self.rng.random() < drug_probability:
                    cell.state = "necrotic"
                    cell.death_cause = f"{drug}_kill"
                    drug_deaths += 1
        return drug_deaths, hypoxic_deaths

    def local_drug_concentration_nm(self, drug: str, x: int, y: int) -> float:
        normalized = self.world.drug.get(x, y)
        if drug == "gefitinib":
            return normalized * self.config.gefitinib_vessel_concentration_nm
        if drug == "osimertinib":
            return normalized * self.config.osimertinib_vessel_concentration_nm
        if drug == "capmatinib":
            return normalized * self.config.capmatinib_vessel_concentration_nm
        return 0.0

    def _apply_division(self, dt: float) -> tuple[int, int]:
        births = 0
        mutations = 0
        parent_sites = [
            (x, y)
            for y in range(self.world.config.height)
            for x in range(self.world.config.width)
            if self.world.site(x, y).state == "proliferating"
        ]
        self.rng.shuffle(parent_sites)

        for x, y in parent_sites:
            parent = self.world.cell_at(x, y)
            if parent is None or parent.state != "proliferating":
                continue

            empty_neighbors = self.world.empty_neighbors8(x, y)
            if not empty_neighbors:
                parent.state = "quiescent"
                continue

            phenotype = self.clone_responses[parent.clone_id]
            division_probability = max(
                0.0,
                1.0 - exp(-phenotype.growth_rate * phenotype.effective_fitness_multiplier * dt)
            )
            if self.rng.random() >= division_probability:
                continue

            target = self.rng.choice(empty_neighbors)
            daughter_clone, mutated = self._daughter_clone(parent.clone_id)
            self.world.place_cell(
                target.x,
                target.y,
                Cell(clone_id=daughter_clone, state="proliferating", age=0.0)
            )
            parent.age = 0.0
            births += 1
            if mutated:
                mutations += 1
        return births, mutations

    def _daughter_clone(self, parent_clone: str) -> tuple[str, bool]:
        transitions = self.transitions.get(parent_clone, [])
        if not transitions:
            return parent_clone, False

        for transition in transitions:
            probability = transition.simulation_probability * self.config.mutation_probability_scale
            if self.rng.random() < probability:
                return transition.child_clone, True
        return parent_clone, False

    @staticmethod
    def _mean_field(field: ScalarField) -> float:
        values = [value for row in field.rows() for value in row]
        return sum(values) / len(values)


def load_clone_model(
    path: Path = DEFAULT_CLONE_DATA
) -> tuple[dict[str, ClonePhenotype], dict[str, list[ResistanceTransition]]]:
    if path == DEFAULT_CLONE_DATA:
        if DEFAULT_CALIBRATED_CLONE_DATA.exists():
            return load_calibrated_clone_model(DEFAULT_CALIBRATED_CLONE_DATA)
        raise FileNotFoundError(
            "Missing data/processed/calibrated_clone_parameters.json. "
            "Run `python3 scripts/prepare_data.py` before starting the simulator."
        )
    with path.open() as handle:
        data = json.load(handle)
    responses = {}
    for clone in data["clones"]:
        responses[clone["id"]] = ClonePhenotype(
            clone_id=clone["id"],
            growth_rate=float(clone["growth_rate"]),
            fitness_cost=float(clone["fitness_cost"]),
            gefitinib_ic50_nm=float(clone["ic50_nm"]["gefitinib"]),
            osimertinib_ic50_nm=float(clone["ic50_nm"]["osimertinib"]),
            capmatinib_ic50_nm=float(clone["ic50_nm"].get("capmatinib", 8000.0)),
            allowed_next_resistance_transitions=tuple(
                clone["allowed_next_resistance_transitions"]
            )
        )
    transitions: dict[str, list[ResistanceTransition]] = {}
    for row in data["resistance_evidence"]:
        transition = ResistanceTransition(
            parent_clone=row["parent_clone"],
            child_clone=row["child_clone"],
            alteration=row["alteration"],
            simulation_probability=float(row["simulation_probability"])
        )
        transitions.setdefault(transition.parent_clone, []).append(transition)
    return responses, transitions


def load_clone_responses(path: Path = DEFAULT_CLONE_DATA) -> dict[str, ClonePhenotype]:
    responses, _ = load_clone_model(path)
    return responses


def load_calibrated_clone_model(
    path: Path
) -> tuple[dict[str, ClonePhenotype], dict[str, list[ResistanceTransition]]]:
    with path.open() as handle:
        data = json.load(handle)
    responses = {}
    for clone in data:
        responses[clone["clone_id"]] = ClonePhenotype(
            clone_id=clone["clone_id"],
            growth_rate=float(clone["growth_rate_per_day"]["value"]),
            fitness_cost=float(clone["fitness_cost"]["value"]),
            gefitinib_ic50_nm=float(clone["drug_response"]["gefitinib"]["value"]),
            osimertinib_ic50_nm=float(clone["drug_response"]["osimertinib"]["value"]),
            capmatinib_ic50_nm=float(clone["drug_response"].get("capmatinib", {"value": 8000.0})["value"]),
            allowed_next_resistance_transitions=tuple(clone["allowed_transitions"])
        )

    return responses, _load_calibrated_transitions()


def _load_calibrated_transitions(
    path: Path = DEFAULT_RESISTANCE_GRAPH
) -> dict[str, list[ResistanceTransition]]:
    if not path.exists():
        raise FileNotFoundError(
            "Missing data/processed/resistance_graph.json. "
            "Run `python3 scripts/prepare_data.py` before starting the simulator."
        )
    with path.open() as handle:
        graph = json.load(handle)
    transitions: dict[str, list[ResistanceTransition]] = {}
    for edge in graph:
        transition = ResistanceTransition(
            parent_clone=edge["from"],
            child_clone=edge["to"],
            alteration=edge["alteration"],
            simulation_probability=float(edge["simulation_probability"])
        )
        transitions.setdefault(transition.parent_clone, []).append(transition)
    return transitions


def _load_seed_transitions() -> tuple[dict[str, ClonePhenotype], dict[str, list[ResistanceTransition]]]:
    with DEFAULT_CLONE_DATA.open() as handle:
        data = json.load(handle)
    transitions: dict[str, list[ResistanceTransition]] = {}
    for row in data["resistance_evidence"]:
        transition = ResistanceTransition(
            parent_clone=row["parent_clone"],
            child_clone=row["child_clone"],
            alteration=row["alteration"],
            simulation_probability=float(row["simulation_probability"])
        )
        transitions.setdefault(transition.parent_clone, []).append(transition)
    return {}, transitions


def automata_config_from_physics_calibration(
    path: Path = DEFAULT_PHYSICS_CALIBRATION,
    **overrides
) -> AutomataConfig:
    params = dict(overrides)
    if path.exists():
        with path.open() as handle:
            payload = json.load(handle)
        config = payload.get("config", payload)
        drugs = config.get("drugs", {})
        if "gefitinib" in drugs:
            params.setdefault(
                "gefitinib_vessel_concentration_nm",
                float(drugs["gefitinib"]["vessel_concentration_nm"])
            )
        if "osimertinib" in drugs:
            params.setdefault(
                "osimertinib_vessel_concentration_nm",
                float(drugs["osimertinib"]["vessel_concentration_nm"])
            )
        if "capmatinib" in drugs:
            params.setdefault(
                "capmatinib_vessel_concentration_nm",
                float(drugs["capmatinib"]["vessel_concentration_nm"])
            )
    return AutomataConfig(**params)
