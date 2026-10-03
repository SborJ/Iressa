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

import numpy as np

from cancer_sim.fields import SolveResult, neighbor_sum, solve_quasi_steady
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
# Simulation assumption (not measured): dead cells are cleared at this rate per
# day, i.e. a mean residence of 4 days. Apoptotic cells are phagocytosed within
# hours in vivo while necrotic debris persists for days to weeks; the engine
# does not distinguish the two. 0 reproduces the legacy "debris never cleared"
# behaviour, which blocks all regrowth once the lattice fills with dead sites.
DEFAULT_NECROTIC_CLEARANCE_RATE = 0.25


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
    """Runtime physics configuration.

    Units (see docs/validation/units.md):
      * biological ``dt`` passed to :meth:`CellularAutomataPhysics.step` is in days;
      * ``oxygen_*`` fields are dimensionless (oxygen normalised to the vessel
        value; ``oxygen_diffusion`` and uptake rates are lattice coefficients
        whose ratio sets the penetration depth);
      * drug physical inputs are ``drug_diffusion_um2_s`` (um^2/s),
        ``lattice_spacing_um`` (um) and ``drug_decay_per_hour`` (1/h); the solver
        converts them to lattice units per day. ``drug_uptake_rate`` is 1/day.
      * ``necrosis_exposure_time`` is in days, death rates in 1/day.
    """

    field_substep_days: float = 1.0 / 24.0
    oxygen_solver: str = "quasi_steady"
    oxygen_diffusion: float = 0.12
    oxygen_solver_iterations: int = 5000
    oxygen_solver_relaxation: float = 1.7
    oxygen_solver_tolerance: float = 1e-7
    oxygen_uptake_rate: float = 0.05
    oxygen_vessel_source: float = 0.35
    oxygen_mm_vmax: float | None = None
    oxygen_mm_km: float = 0.25
    drug_solver: str = "quasi_steady"
    lattice_spacing_um: float = 20.0
    drug_diffusion_um2_s: float = 500.0
    drug_decay_per_hour: float = 0.02
    drug_solver_tolerance: float = 1e-9
    drug_solver_iterations: int = 20000
    drug_diffusion: float = 0.10
    max_explicit_diffusion_step: float = 0.20
    drug_decay_rate: float = 0.02
    drug_uptake_rate: float = 0.015
    drug_vessel_source: float = 0.45
    necrotic_clearance_rate: float = DEFAULT_NECROTIC_CLEARANCE_RATE
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
        if self.drug_solver not in {"quasi_steady", "explicit_legacy"}:
            raise ValueError("drug_solver must be quasi_steady or explicit_legacy")
        if not 0 < self.oxygen_solver_relaxation < 2:
            raise ValueError("oxygen_solver_relaxation must be in (0, 2) for SOR convergence")
        if self.lattice_spacing_um <= 0:
            raise ValueError("lattice_spacing_um must be positive")
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

    @property
    def drug_grid_diffusion_per_day(self) -> float:
        """D in lattice sites^2 per day: D[um^2/s] * 86400 / dx[um]^2."""
        return self.drug_diffusion_um2_s * 86400.0 / (self.lattice_spacing_um ** 2)

    @property
    def drug_decay_per_day(self) -> float:
        return self.drug_decay_per_hour * 24.0

    @property
    def drug_decay_length_sites(self) -> float:
        """sqrt(D / k): the distance over which a vessel-fed drug field decays."""
        k = self.drug_decay_per_day
        return float("inf") if k <= 0 else (self.drug_grid_diffusion_per_day / k) ** 0.5


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
    cleared_cells: int = 0
    oxygen_solver_iterations: int = 0
    oxygen_solver_converged: bool = True
    drug_solver_iterations: int = 0
    drug_solver_converged: bool = True


class CellularAutomataPhysics:
    """Step a cell lattice (2D section or 3D volume) and its microenvironment fields forward.

    Set ``record_events=True`` to collect, per step, the list of changes as tuples
    ``(kind, node, ...)`` for the viewer exporter:
      ("divide", parent_node, daughter_node, clone)
      ("mutate", node, old_clone, new_clone)
      ("death", node, cause_role, drug_or_None, clone)
      ("removed", node, cause_role, drug_or_None, clone)
      ("state", node, new_state, cause_role, clone)
    Recording never changes behaviour; it only observes it.
    """

    def __init__(
        self,
        world: WorldPhysics,
        clone_responses: dict[str, ClonePhenotype] | None = None,
        transitions: dict[str, list[ResistanceTransition]] | None = None,
        config: AutomataConfig | None = None,
        rng: random.Random | None = None,
        record_events: bool = False
    ) -> None:
        self.world = world
        self.config = config or AutomataConfig()
        loaded_responses, loaded_transitions = load_clone_model()
        self.clone_responses = clone_responses or loaded_responses
        self.transitions = transitions or loaded_transitions
        self.rng = rng or random.Random()
        self.time = 0.0
        self.last_oxygen_solve: SolveResult | None = None
        self.last_drug_solve: SolveResult | None = None
        self.record_events = record_events
        self.events: list[tuple] = []
        self._shape = (world.config.depth, world.config.height, world.config.width)

    # ------------------------------------------------------------------ stepping
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

        self.events = []
        living_before = self.living_cell_count()
        density = self.cell_density()
        self.world.oxygen = self._next_oxygen_field(density, dt)
        self.world.drug = self._next_drug_field(density, dt, active_dose=vessel_drug_dose)

        drug_deaths = hypoxic_deaths = births = mutations = cleared = 0
        self._update_cell_states(dt)
        if apply_death:
            drug_deaths, hypoxic_deaths = self._apply_death(dt, drug)
            cleared = self._clear_dead_cells(dt)
        if allow_division:
            births, mutations = self._apply_division(dt)
        self.world.age_living_cells(dt)
        state_counts = self.cell_state_counts()

        self.time += dt
        oxygen_solve = self.last_oxygen_solve
        drug_solve = self.last_drug_solve
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
            mean_oxygen=float(self.world.oxygen.array.mean()),
            mean_drug=float(self.world.drug.array.mean()),
            cleared_cells=cleared,
            oxygen_solver_iterations=0 if oxygen_solve is None else oxygen_solve.iterations,
            oxygen_solver_converged=True if oxygen_solve is None else oxygen_solve.converged,
            drug_solver_iterations=0 if drug_solve is None else drug_solve.iterations,
            drug_solver_converged=True if drug_solve is None else drug_solve.converged
        )

    # ------------------------------------------------------------------ counts
    def cell_density(self) -> np.ndarray:
        """1.0 at living-cell voxels, shape (depth, height, width)."""
        density = np.zeros(self._shape, dtype=float)
        for (x, y, z), cell in self.world._cells.items():
            if cell.living:
                density[z, y, x] = 1.0
        return density

    def living_cell_count(self) -> int:
        return self.world.living_count()

    def cell_state_counts(self) -> dict[str, int]:
        counts = {"proliferating": 0, "quiescent": 0, "necrotic": 0}
        for cell in self.world._cells.values():
            if cell.state in counts:
                counts[cell.state] += 1
        return counts

    # ------------------------------------------------------------------ pharmacodynamics
    def drug_effect(self, clone_id: str, drug: str, concentration_nm: float) -> float:
        if drug == "none" or concentration_nm <= 0:
            return 0.0
        response = self.clone_responses[clone_id]
        ic50 = response.ic50(drug)
        n = response.hill_coefficient
        numerator = concentration_nm ** n
        return numerator / (ic50 ** n + numerator)

    def drug_death_probability(self, clone_id: str, drug: str, concentration_nm: float, dt: float) -> float:
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

    def local_drug_concentration_nm(self, drug: str, x: int, y: int, z: int = 0) -> float:
        normalized = self.world.drug.get(x, y, z)
        if drug == "gefitinib":
            return normalized * self.config.gefitinib_vessel_concentration_nm
        if drug == "osimertinib":
            return normalized * self.config.osimertinib_vessel_concentration_nm
        if drug == "capmatinib":
            return normalized * self.config.capmatinib_vessel_concentration_nm
        return 0.0

    # ------------------------------------------------------------------ fields
    def _source_grid(self, source_rate: float, source_attr: str) -> np.ndarray:
        grid = np.zeros(self._shape, dtype=float)
        if source_rate <= 0:
            return grid
        for vessel in self.world.vessels:
            grid[vessel.z, vessel.y, vessel.x] += source_rate * getattr(vessel, source_attr)
        return grid

    def _next_oxygen_field(self, density: np.ndarray, dt: float) -> ScalarField:
        if self.config.oxygen_solver == "quasi_steady":
            return self._next_quasi_steady_oxygen_field(density)
        return self._next_field_substepped(
            field=self.world.oxygen, density=density, dt=dt,
            diffusion=self.config.oxygen_diffusion, decay=0.0,
            uptake_rate=self.config.oxygen_uptake_rate, source_rate=self.config.oxygen_vessel_source,
            source_attr="oxygen_strength", use_michaelis_menten=True
        )

    def _next_drug_field(self, density: np.ndarray, dt: float, *, active_dose: float) -> ScalarField:
        if self.config.drug_solver == "quasi_steady":
            return self._next_quasi_steady_drug_field(density, active_dose=active_dose)
        return self._next_field_substepped(
            field=self.world.drug, density=density, dt=dt,
            diffusion=self.config.drug_diffusion, decay=self.config.drug_decay_rate,
            uptake_rate=self.config.drug_uptake_rate, source_rate=self.config.drug_vessel_source * active_dose,
            source_attr="drug_strength", use_michaelis_menten=False
        )

    def _next_quasi_steady_oxygen_field(self, density: np.ndarray) -> ScalarField:
        """Converged solve of D*lap(O) - uptake(O)*O + source = 0 (see fields.py)."""
        dens = np.asarray(density, dtype=float)
        source = self._source_grid(self.config.oxygen_vessel_source, "oxygen_strength")
        linear_sink = None if self.config.oxygen_mm_vmax is not None else self.config.oxygen_uptake_rate * dens
        result = solve_quasi_steady(
            self.world.oxygen.array, diffusion=self.config.oxygen_diffusion, source=source,
            linear_sink=linear_sink, mm_vmax=self.config.oxygen_mm_vmax, mm_km=self.config.oxygen_mm_km,
            density=dens, omega=self.config.oxygen_solver_relaxation,
            tolerance=self.config.oxygen_solver_tolerance, max_iterations=self.config.oxygen_solver_iterations,
            clamp=(0.0, 1.0)
        )
        self.last_oxygen_solve = result
        return ScalarField.from_array(result.values)

    def _next_quasi_steady_drug_field(self, density: np.ndarray, *, active_dose: float) -> ScalarField:
        """Converged solve of D*lap(C) - (k_decay + k_uptake*rho)*C = 0 with vessel lumen fixed at the dose.

        Concentrations are normalised to the vessel (plasma) level. Physical D (um^2/s),
        lattice spacing (um) and decay (1/h) come from the configuration. For small-
        molecule TKIs the decay length is hundreds of sites, so the field is nearly
        uniform; the legacy explicit solver (D 0.1 sites^2/day) is kept as an option.
        """
        dens = np.asarray(density, dtype=float)
        fixed_mask = np.zeros(self._shape, dtype=bool)
        fixed_values = np.zeros(self._shape, dtype=float)
        for vessel in self.world.vessels:
            fixed_mask[vessel.z, vessel.y, vessel.x] = True
            fixed_values[vessel.z, vessel.y, vessel.x] = min(1.0, max(0.0, active_dose * vessel.drug_strength))
        if active_dose <= 0 or not fixed_mask.any():
            self.last_drug_solve = SolveResult(np.zeros(self._shape), 0, True, 0.0)
            return ScalarField(self.world.config.width, self.world.config.height, 0.0, self.world.config.depth)
        sink = self.config.drug_decay_per_day + self.config.drug_uptake_rate * dens
        result = solve_quasi_steady(
            self.world.drug.array, diffusion=self.config.drug_grid_diffusion_per_day,
            source=np.zeros(self._shape), linear_sink=sink, fixed_mask=fixed_mask, fixed_values=fixed_values,
            omega=self.config.oxygen_solver_relaxation, tolerance=self.config.drug_solver_tolerance,
            max_iterations=self.config.drug_solver_iterations, clamp=(0.0, 1.0)
        )
        self.last_drug_solve = result
        return ScalarField.from_array(result.values)

    def _next_field_substepped(self, *, field, density, dt, diffusion, decay, uptake_rate, source_rate,
                               source_attr, use_michaelis_menten) -> ScalarField:
        """Legacy explicit solver with automatic stability sub-steps (kept for reproducibility)."""
        if diffusion <= 0:
            diffusion_substeps = 1
        else:
            diffusion_substeps = max(1, ceil(diffusion * dt / self.config.max_explicit_diffusion_step))
        time_substeps = max(1, ceil(dt / self.config.field_substep_days))
        substeps = max(diffusion_substeps, time_substeps)
        sub_dt = dt / substeps
        values = np.array(field.array, dtype=float, copy=True)
        source = self._source_grid(source_rate, source_attr)
        dens = np.asarray(density, dtype=float)
        ndim = len([n for n in self._shape if n > 1]) or 1
        for _ in range(substeps):
            lap = neighbor_sum(values) - 2.0 * ndim * values
            if use_michaelis_menten and self.config.oxygen_mm_vmax is not None:
                uptake = np.where(dens > 0, self.config.oxygen_mm_vmax * values / (self.config.oxygen_mm_km + values) * dens, 0.0)
            else:
                uptake = uptake_rate * dens * values
            values = np.clip(values + sub_dt * (diffusion * lap - decay * values - uptake + source), 0.0, 1.0)
        return ScalarField.from_array(values)

    # ------------------------------------------------------------------ cell rules
    def _node(self, x: int, y: int, z: int) -> int:
        return self.world.config.node_index(x, y, z)

    def _update_cell_states(self, dt: float) -> None:
        oxygen = self.world.oxygen.array
        for x, y, z in self.world.occupied_sites():
            cell = self.world._cells[(x, y, z)]
            if not cell.living:
                continue
            previous = cell.state
            value = oxygen[z, y, x]
            if value <= self.config.necrosis_threshold:
                cell.oxygen_stress_time += dt
                cell.state = "quiescent"
            elif value <= self.config.proliferation_oxygen_threshold:
                cell.oxygen_stress_time = 0.0
                cell.state = "quiescent"
            else:
                cell.oxygen_stress_time = 0.0
                cell.state = "proliferating"
            if self.record_events and cell.state != previous:
                cause = "hypoxiaArrest" if cell.state == "quiescent" else "normalCycle"
                self.events.append(("state", self._node(x, y, z), cell.state, cause, cell.clone_id))

    def _apply_death(self, dt: float, drug: str) -> tuple[int, int]:
        drug_deaths = 0
        hypoxic_deaths = 0
        oxygen = self.world.oxygen.array
        for x, y, z in self.world.occupied_sites():
            cell = self.world._cells[(x, y, z)]
            if not cell.living:
                continue
            hypoxic_probability = self.hypoxic_death_probability(oxygen[z, y, x], dt)
            if cell.oxygen_stress_time >= self.config.necrosis_exposure_time and self.rng.random() < hypoxic_probability:
                cell.state = "necrotic"
                cell.death_cause = "hypoxia"
                hypoxic_deaths += 1
                if self.record_events:
                    self.events.append(("death", self._node(x, y, z), "hypoxicNecrosis", None, cell.clone_id))
                continue
            concentration_nm = self.local_drug_concentration_nm(drug, x, y, z)
            if self.rng.random() < self.drug_death_probability(cell.clone_id, drug, concentration_nm, dt):
                cell.state = "necrotic"
                cell.death_cause = f"{drug}_kill"
                drug_deaths += 1
                if self.record_events:
                    self.events.append(("death", self._node(x, y, z), "drugApoptosis", drug, cell.clone_id))
        return drug_deaths, hypoxic_deaths

    def _clear_dead_cells(self, dt: float) -> int:
        """Remove dead cells at ``necrotic_clearance_rate`` per day (0 = legacy: debris never cleared)."""
        rate = self.config.necrotic_clearance_rate
        if rate <= 0:
            return 0
        probability = 1.0 - exp(-rate * dt)
        cleared = 0
        for x, y, z in self.world.occupied_sites():
            cell = self.world._cells[(x, y, z)]
            if cell.living:
                continue
            if self.rng.random() < probability:
                if self.record_events:
                    cause = "hypoxicNecrosis" if cell.death_cause == "hypoxia" else "drugApoptosis"
                    drug = None if cause == "hypoxicNecrosis" else (cell.death_cause or "").replace("_kill", "")
                    self.events.append(("removed", self._node(x, y, z), cause, drug, cell.clone_id))
                self.world.clear_site(x, y, z)
                cleared += 1
        return cleared

    def _apply_division(self, dt: float) -> tuple[int, int]:
        births = 0
        mutations = 0
        parent_sites = [
            site for site in self.world.occupied_sites()
            if self.world._cells[site].state == "proliferating"
        ]
        self.rng.shuffle(parent_sites)
        for x, y, z in parent_sites:
            parent = self.world._cells.get((x, y, z))
            if parent is None or parent.state != "proliferating":
                continue
            empty_neighbors = self.world.empty_neighbors8(x, y, z)
            if not empty_neighbors:
                parent.state = "quiescent"
                if self.record_events:
                    self.events.append(("state", self._node(x, y, z), "quiescent", "crowdingArrest", parent.clone_id))
                continue
            phenotype = self.clone_responses[parent.clone_id]
            division_probability = max(0.0, 1.0 - exp(-phenotype.growth_rate * phenotype.effective_fitness_multiplier * dt))
            if self.rng.random() >= division_probability:
                continue
            target = self.rng.choice(empty_neighbors)
            daughter_clone, mutated = self._daughter_clone(parent.clone_id)
            self.world.place_cell(target.x, target.y, Cell(clone_id=daughter_clone, state="proliferating", age=0.0), target.z)
            parent.age = 0.0
            births += 1
            if mutated:
                mutations += 1
            if self.record_events:
                parent_node = self._node(x, y, z)
                daughter_node = self._node(target.x, target.y, target.z)
                self.events.append(("divide", parent_node, daughter_node, parent.clone_id))
                if mutated:
                    self.events.append(("mutate", daughter_node, parent.clone_id, daughter_clone))
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
        return float(field.array.mean())


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
            allowed_next_resistance_transitions=tuple(clone["allowed_transitions"]),
            hill_coefficient=float(clone.get("hill_coefficient", {"value": 1.2})["value"]),
            max_drug_death_rate=float(clone.get("max_drug_death_rate_per_day", {"value": 0.18})["value"])
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
        if "space" in config and "lattice_spacing_um" in config["space"]:
            params.setdefault("lattice_spacing_um", float(config["space"]["lattice_spacing_um"]))
        if "gefitinib" in drugs:
            params.setdefault("drug_diffusion_um2_s", float(drugs["gefitinib"].get("diffusion_um2_s", 500.0)))
            params.setdefault("drug_decay_per_hour", float(drugs["gefitinib"].get("decay_per_hour", 0.02)))
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
