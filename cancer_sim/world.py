"""2D world physics for the cancer resistance simulator.

This module builds the environment that simulators query: lattice geometry,
vessel sources, oxygen concentration, drug concentration, and cell occupancy.
Cells carry clone identity separately from oxygen-driven state.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import exp, hypot


@dataclass(frozen=True)
class WorldConfig:
    width: int = 200
    height: int = 200
    cell_size_um: float = 20.0
    oxygen_length_scale: float = 28.0
    drug_length_scale: float = 35.0

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("world dimensions must be positive")
        if self.cell_size_um <= 0:
            raise ValueError("cell_size_um must be positive")
        if self.oxygen_length_scale <= 0 or self.drug_length_scale <= 0:
            raise ValueError("length scales must be positive")


@dataclass(frozen=True)
class Vessel:
    x: int
    y: int
    oxygen_strength: float = 1.0
    drug_strength: float = 1.0


@dataclass(frozen=True)
class CellSite:
    x: int
    y: int
    clone_id: str | None = None
    state: str | None = None
    age: float = 0.0
    death_cause: str | None = None
    oxygen_stress_time: float = 0.0

    @property
    def occupied(self) -> bool:
        return self.clone_id is not None

    @property
    def living(self) -> bool:
        return self.occupied and self.state != "necrotic"


@dataclass
class Cell:
    clone_id: str
    state: str = "proliferating"
    age: float = 0.0
    death_cause: str | None = None
    oxygen_stress_time: float = 0.0

    @property
    def living(self) -> bool:
        return self.state != "necrotic"


class ScalarField:
    """Dense rectangular scalar field with clamped normalized values."""

    def __init__(self, width: int, height: int, default: float = 0.0) -> None:
        self.width = width
        self.height = height
        self._values = [[self._clamp(default) for _ in range(width)] for _ in range(height)]

    def get(self, x: int, y: int) -> float:
        self._validate_coordinate(x, y)
        return self._values[y][x]

    def set(self, x: int, y: int, value: float) -> None:
        self._validate_coordinate(x, y)
        self._values[y][x] = self._clamp(value)

    def rows(self) -> list[list[float]]:
        return [row[:] for row in self._values]

    @staticmethod
    def _clamp(value: float) -> float:
        return max(0.0, min(1.0, float(value)))

    def _validate_coordinate(self, x: int, y: int) -> None:
        if not 0 <= x < self.width or not 0 <= y < self.height:
            raise IndexError(f"coordinate out of bounds: ({x}, {y})")


class WorldPhysics:
    """Lattice, vessel, cell, and field representation."""

    def __init__(
        self,
        config: WorldConfig | None = None,
        vessels: list[Vessel] | None = None
    ) -> None:
        self.config = config or WorldConfig()
        self.vessels = vessels[:] if vessels is not None else self.default_vessels(self.config)
        self._validate_vessels()
        self.oxygen = self._build_source_field("oxygen")
        self.drug = self._build_source_field("drug")
        self._cells: list[list[Cell | None]] = [
            [None for _ in range(self.config.width)] for _ in range(self.config.height)
        ]

    @staticmethod
    def default_vessels(config: WorldConfig) -> list[Vessel]:
        return [
            Vessel(config.width // 4, config.height // 4),
            Vessel((3 * config.width) // 4, config.height // 3, drug_strength=0.9),
            Vessel(config.width // 2, (3 * config.height) // 4, oxygen_strength=0.9)
        ]

    def site(self, x: int, y: int) -> CellSite:
        self._validate_coordinate(x, y)
        cell = self._cells[y][x]
        if cell is None:
            return CellSite(x=x, y=y)
        return CellSite(
            x=x,
            y=y,
            clone_id=cell.clone_id,
            state=cell.state,
            age=cell.age,
            death_cause=cell.death_cause,
            oxygen_stress_time=cell.oxygen_stress_time
        )

    def cell_at(self, x: int, y: int) -> Cell | None:
        self._validate_coordinate(x, y)
        return self._cells[y][x]

    def place_cell(self, x: int, y: int, cell: Cell) -> None:
        if not cell.clone_id:
            raise ValueError("cell.clone_id must not be empty")
        self._validate_coordinate(x, y)
        self._cells[y][x] = cell

    def place_clone(self, x: int, y: int, clone_id: str) -> None:
        if not clone_id:
            raise ValueError("clone_id must not be empty")
        self.place_cell(x, y, Cell(clone_id=clone_id))

    def clear_site(self, x: int, y: int) -> None:
        self._validate_coordinate(x, y)
        self._cells[y][x] = None

    def set_cell_state(self, x: int, y: int, state: str) -> None:
        self._validate_coordinate(x, y)
        cell = self._cells[y][x]
        if cell is None:
            raise ValueError(f"no cell at ({x}, {y})")
        cell.state = state

    def age_living_cells(self, dt: float) -> None:
        if dt < 0:
            raise ValueError("dt must be non-negative")
        for row in self._cells:
            for cell in row:
                if cell is not None and cell.living:
                    cell.age += dt

    def neighbors4(self, x: int, y: int) -> list[CellSite]:
        self._validate_coordinate(x, y)
        coordinates = ((x, y - 1), (x + 1, y), (x, y + 1), (x - 1, y))
        return [
            self.site(nx, ny)
            for nx, ny in coordinates
            if 0 <= nx < self.config.width and 0 <= ny < self.config.height
        ]

    def neighbors8(self, x: int, y: int) -> list[CellSite]:
        self._validate_coordinate(x, y)
        sites = []
        for ny in range(y - 1, y + 2):
            for nx in range(x - 1, x + 2):
                if nx == x and ny == y:
                    continue
                if 0 <= nx < self.config.width and 0 <= ny < self.config.height:
                    sites.append(self.site(nx, ny))
        return sites

    def empty_neighbors8(self, x: int, y: int) -> list[CellSite]:
        return [site for site in self.neighbors8(x, y) if not site.occupied]

    def local_conditions(self, x: int, y: int) -> dict[str, float]:
        self._validate_coordinate(x, y)
        return {
            "oxygen": self.oxygen.get(x, y),
            "drug": self.drug.get(x, y)
        }

    def hypoxia_mask(self, threshold: float = 0.25) -> list[list[bool]]:
        return [[value < threshold for value in row] for row in self.oxygen.rows()]

    def necrosis_mask(self, threshold: float = 0.08) -> list[list[bool]]:
        return [[value < threshold for value in row] for row in self.oxygen.rows()]

    def _build_source_field(self, field_name: str) -> ScalarField:
        length_scale = (
            self.config.oxygen_length_scale
            if field_name == "oxygen"
            else self.config.drug_length_scale
        )
        field = ScalarField(self.config.width, self.config.height)
        for y in range(self.config.height):
            for x in range(self.config.width):
                value = 0.0
                for vessel in self.vessels:
                    strength = (
                        vessel.oxygen_strength
                        if field_name == "oxygen"
                        else vessel.drug_strength
                    )
                    value += strength * exp(-hypot(x - vessel.x, y - vessel.y) / length_scale)
                field.set(x, y, value)
        return field

    def _validate_vessels(self) -> None:
        for vessel in self.vessels:
            self._validate_coordinate(vessel.x, vessel.y)
            if vessel.oxygen_strength < 0 or vessel.drug_strength < 0:
                raise ValueError("vessel source strengths must be non-negative")

    def _validate_coordinate(self, x: int, y: int) -> None:
        if not 0 <= x < self.config.width or not 0 <= y < self.config.height:
            raise IndexError(f"coordinate out of bounds: ({x}, {y})")
