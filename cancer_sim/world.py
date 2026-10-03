"""Lattice world for the cancer resistance simulator (2D section or 3D volume).

The lattice is ``width x height x depth`` with ``depth = 1`` for the validated 2D
section. Sites are addressed as ``(x, y, z)`` with ``z`` defaulting to 0, so every
2D call site keeps working unchanged. Node indices follow the viewer contract
``i = x + y * width + z * width * height``.

Vessels are lumen voxels: sources for oxygen and drug and never occupiable.
``blocked`` holds additional voxels (vessel walls) that cells may not enter.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import exp, hypot, sqrt
from typing import Iterable, Iterator

import numpy as np


@dataclass(frozen=True)
class WorldConfig:
    width: int = 200
    height: int = 200
    depth: int = 1
    cell_size_um: float = 20.0
    oxygen_length_scale: float = 28.0
    drug_length_scale: float = 35.0

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0 or self.depth <= 0:
            raise ValueError("world dimensions must be positive")
        if self.cell_size_um <= 0:
            raise ValueError("cell_size_um must be positive")
        if self.oxygen_length_scale <= 0 or self.drug_length_scale <= 0:
            raise ValueError("length scales must be positive")

    @property
    def is_3d(self) -> bool:
        return self.depth > 1

    @property
    def node_count(self) -> int:
        return self.width * self.height * self.depth

    def node_index(self, x: int, y: int, z: int = 0) -> int:
        return x + y * self.width + z * self.width * self.height

    def node_coords(self, index: int) -> tuple[int, int, int]:
        plane = self.width * self.height
        z, rest = divmod(index, plane)
        y, x = divmod(rest, self.width)
        return x, y, z


@dataclass(frozen=True)
class Vessel:
    x: int
    y: int
    z: int = 0
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
    z: int = 0

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
    """Dense scalar field with clamped normalised values, stored as a numpy array
    of shape ``(depth, height, width)``."""

    def __init__(self, width: int, height: int, default: float = 0.0, depth: int = 1) -> None:
        self.width = width
        self.height = height
        self.depth = depth
        self._values = np.full((depth, height, width), self._clamp(default), dtype=float)

    @property
    def array(self) -> np.ndarray:
        return self._values

    def get(self, x: int, y: int, z: int = 0) -> float:
        self._validate_coordinate(x, y, z)
        return float(self._values[z, y, x])

    def set(self, x: int, y: int, value: float, z: int = 0) -> None:
        self._validate_coordinate(x, y, z)
        self._values[z, y, x] = self._clamp(value)

    def rows(self, z: int = 0) -> list[list[float]]:
        """One plane as nested lists (the whole field for a 2D section)."""
        return self._values[z].tolist()

    @classmethod
    def from_rows(cls, rows) -> "ScalarField":
        data = np.asarray(rows, dtype=float)
        if data.ndim == 2:
            data = data[np.newaxis, :, :]
        field = cls(data.shape[2], data.shape[1], 0.0, data.shape[0])
        field._values = np.clip(data, 0.0, 1.0)
        return field

    @classmethod
    def from_array(cls, array: np.ndarray) -> "ScalarField":
        return cls.from_rows(array)

    @staticmethod
    def _clamp(value: float) -> float:
        return max(0.0, min(1.0, float(value)))

    def _validate_coordinate(self, x: int, y: int, z: int = 0) -> None:
        if not 0 <= x < self.width or not 0 <= y < self.height or not 0 <= z < self.depth:
            raise IndexError(f"coordinate out of bounds: ({x}, {y}, {z})")


class WorldPhysics:
    """Lattice, vessels, cells and fields."""

    def __init__(
        self,
        config: WorldConfig | None = None,
        vessels: list[Vessel] | None = None,
        blocked: Iterable[tuple[int, int, int]] | None = None
    ) -> None:
        self.config = config or WorldConfig()
        self.vessels = vessels[:] if vessels is not None else self.default_vessels(self.config)
        self._validate_vessels()
        self.vessel_sites: set[tuple[int, int, int]] = {(v.x, v.y, v.z) for v in self.vessels}
        self.blocked: set[tuple[int, int, int]] = set(self.vessel_sites)
        if blocked is not None:
            self.blocked.update(tuple(site) for site in blocked)
        self.oxygen = self._build_source_field("oxygen")
        self.drug = self._build_source_field("drug")
        self._cells: dict[tuple[int, int, int], Cell] = {}

    # ---------------------------------------------------------------- vessels
    @staticmethod
    def default_vessels(config: WorldConfig) -> list[Vessel]:
        zc = config.depth // 2
        return [
            Vessel(config.width // 4, config.height // 4, zc),
            Vessel((3 * config.width) // 4, config.height // 3, zc, drug_strength=0.9),
            Vessel(config.width // 2, (3 * config.height) // 4, zc, oxygen_strength=0.9)
        ]

    @staticmethod
    def grid_vessels(config: WorldConfig, spacing_um: float) -> list[Vessel]:
        """Capillaries on a regular grid at the intercapillary distance ``spacing_um``.

        In 2D these are cross-sections (points). In 3D they are straight
        capillaries running along z, i.e. the Krogh tissue-cylinder arrangement
        (Krogh, J Physiol 1919). Tumour intercapillary distances of ~100-200 um
        underlie the ~150 um oxygen diffusion limit (Thomlinson & Gray, Br J
        Cancer 1955; Vaupel et al., Cancer Res 1989); 150 um is literature-derived.
        """
        if spacing_um <= 0:
            raise ValueError("spacing_um must be positive")
        spacing = max(1, int(round(spacing_um / config.cell_size_um)))
        offset = spacing // 2
        vessels = []
        for y in range(offset, config.height, spacing):
            for x in range(offset, config.width, spacing):
                if config.depth == 1:
                    vessels.append(Vessel(x, y))
                else:
                    vessels.extend(Vessel(x, y, z) for z in range(config.depth))
        return vessels

    # ---------------------------------------------------------------- sites
    def site(self, x: int, y: int, z: int = 0) -> CellSite:
        self._validate_coordinate(x, y, z)
        cell = self._cells.get((x, y, z))
        if cell is None:
            return CellSite(x=x, y=y, z=z)
        return CellSite(
            x=x, y=y, z=z,
            clone_id=cell.clone_id, state=cell.state, age=cell.age,
            death_cause=cell.death_cause, oxygen_stress_time=cell.oxygen_stress_time
        )

    def cell_at(self, x: int, y: int, z: int = 0) -> Cell | None:
        self._validate_coordinate(x, y, z)
        return self._cells.get((x, y, z))

    def is_blocked(self, x: int, y: int, z: int = 0) -> bool:
        return (x, y, z) in self.blocked

    def place_cell(self, x: int, y: int, cell: Cell, z: int = 0) -> None:
        if not cell.clone_id:
            raise ValueError("cell.clone_id must not be empty")
        self._validate_coordinate(x, y, z)
        self._cells[(x, y, z)] = cell

    def place_clone(self, x: int, y: int, clone_id: str, z: int = 0) -> None:
        if not clone_id:
            raise ValueError("clone_id must not be empty")
        self.place_cell(x, y, Cell(clone_id=clone_id), z)

    def clear_site(self, x: int, y: int, z: int = 0) -> None:
        self._validate_coordinate(x, y, z)
        self._cells.pop((x, y, z), None)

    def set_cell_state(self, x: int, y: int, state: str, z: int = 0) -> None:
        self._validate_coordinate(x, y, z)
        cell = self._cells.get((x, y, z))
        if cell is None:
            raise ValueError(f"no cell at ({x}, {y}, {z})")
        cell.state = state

    def occupied_sites(self) -> list[tuple[int, int, int]]:
        """Occupied coordinates in scan order (z, then y, then x)."""
        return sorted(self._cells, key=lambda s: (s[2], s[1], s[0]))

    def occupied_count(self) -> int:
        return len(self._cells)

    def living_count(self) -> int:
        return sum(1 for cell in self._cells.values() if cell.living)

    def age_living_cells(self, dt: float) -> None:
        if dt < 0:
            raise ValueError("dt must be non-negative")
        for cell in self._cells.values():
            if cell.living:
                cell.age += dt

    # ---------------------------------------------------------------- neighbours
    def neighbors4(self, x: int, y: int, z: int = 0) -> list[CellSite]:
        self._validate_coordinate(x, y, z)
        coordinates = [(x, y - 1, z), (x + 1, y, z), (x, y + 1, z), (x - 1, y, z)]
        if self.config.depth > 1:
            coordinates += [(x, y, z - 1), (x, y, z + 1)]
        return [self.site(nx, ny, nz) for nx, ny, nz in coordinates if self._inside(nx, ny, nz)]

    def neighbor_coordinates(self, x: int, y: int, z: int = 0) -> list[tuple[int, int, int]]:
        """Moore neighbourhood: 8 sites in a 2D section, 26 in a volume, scan ordered."""
        out = []
        zs = range(z - 1, z + 2) if self.config.depth > 1 else (z,)
        for nz in zs:
            for ny in range(y - 1, y + 2):
                for nx in range(x - 1, x + 2):
                    if nx == x and ny == y and nz == z:
                        continue
                    if self._inside(nx, ny, nz):
                        out.append((nx, ny, nz))
        return out

    def neighbors8(self, x: int, y: int, z: int = 0) -> list[CellSite]:
        self._validate_coordinate(x, y, z)
        return [self.site(nx, ny, nz) for nx, ny, nz in self.neighbor_coordinates(x, y, z)]

    def empty_neighbors8(self, x: int, y: int, z: int = 0) -> list[CellSite]:
        """Unoccupied, non-blocked Moore neighbours (a cell may not enter a vessel)."""
        return [
            self.site(nx, ny, nz)
            for nx, ny, nz in self.neighbor_coordinates(x, y, z)
            if (nx, ny, nz) not in self._cells and (nx, ny, nz) not in self.blocked
        ]

    def local_conditions(self, x: int, y: int, z: int = 0) -> dict[str, float]:
        self._validate_coordinate(x, y, z)
        return {"oxygen": self.oxygen.get(x, y, z), "drug": self.drug.get(x, y, z)}

    def hypoxia_mask(self, threshold: float = 0.25) -> list[list[bool]]:
        return [[value < threshold for value in row] for row in self.oxygen.rows()]

    def necrosis_mask(self, threshold: float = 0.08) -> list[list[bool]]:
        return [[value < threshold for value in row] for row in self.oxygen.rows()]

    # ---------------------------------------------------------------- internals
    def _build_source_field(self, field_name: str) -> ScalarField:
        """Initial guess for the quasi-steady solvers: exponential decay from vessels."""
        c = self.config
        length_scale = c.oxygen_length_scale if field_name == "oxygen" else c.drug_length_scale
        attr = "oxygen_strength" if field_name == "oxygen" else "drug_strength"
        zz, yy, xx = np.indices((c.depth, c.height, c.width), dtype=float)
        values = np.zeros((c.depth, c.height, c.width), dtype=float)
        if len(self.vessels) <= 64 or c.depth == 1:
            for vessel in self.vessels:
                dist = np.sqrt((xx - vessel.x) ** 2 + (yy - vessel.y) ** 2 + (zz - vessel.z) ** 2)
                values += getattr(vessel, attr) * np.exp(-dist / length_scale)
        else:
            # many lumen voxels (a vascular tree): start from a uniform mid value
            values[:] = 0.5
            for vessel in self.vessels:
                values[vessel.z, vessel.y, vessel.x] = 1.0
        return ScalarField.from_array(values)

    def _validate_vessels(self) -> None:
        for vessel in self.vessels:
            self._validate_coordinate(vessel.x, vessel.y, vessel.z)
            if vessel.oxygen_strength < 0 or vessel.drug_strength < 0:
                raise ValueError("vessel source strengths must be non-negative")

    def _inside(self, x: int, y: int, z: int) -> bool:
        return 0 <= x < self.config.width and 0 <= y < self.config.height and 0 <= z < self.config.depth

    def _validate_coordinate(self, x: int, y: int, z: int = 0) -> None:
        if not self._inside(x, y, z):
            raise IndexError(f"coordinate out of bounds: ({x}, {y}, {z})")
