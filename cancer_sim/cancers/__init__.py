"""Cancer models: which clones, drugs and treatments a simulation is about.

The physics in :mod:`cancer_sim.automata` knows only generic concepts (clone,
transition, drug, exposure). Everything that names a biology, from "EGFR" to
"ESR1 Y537S", lives in one JSON file per cancer in this package, together with
where its calibrated parameters come from and which treatment schedules and RL
actions make sense for it.

    load_cancer_model("lung_egfr")           the validated EGFR model (default)
    load_cancer_model("breast_er_her2neg")   ER+/HER2- breast cancer
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping

ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = Path(__file__).resolve().parent
DEFAULT_CANCER = "lung_egfr"

EXPOSURE_TYPES = ("diffusing", "global")


@dataclass(frozen=True)
class CloneSpec:
    id: str
    label: str
    parent: str | None
    resistant: bool


@dataclass(frozen=True)
class DrugSpec:
    id: str
    label: str
    exposure: str
    half_life_hours: float
    reference_concentration_nm: float
    """What exposure 1.0 means in nM at the vessel (diffusing) or as a uniform
    level (global). IC50 values are compared against this scale."""
    mechanism: str = ""

    @property
    def diffusing(self) -> bool:
        return self.exposure == "diffusing"


@dataclass(frozen=True)
class CancerModel:
    id: str
    name: str
    description: str
    root_clone: str
    clones: tuple[CloneSpec, ...]
    drugs: tuple[DrugSpec, ...]
    default_clone_weights: tuple[float, ...]
    parameters: Mapping[str, Any]
    schedules: Mapping[str, Mapping[str, Any]]
    default_panel: tuple[str, ...]
    rl_actions: tuple[Mapping[str, Any], ...]
    demo_run: str | None = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    # ---- lookups -----------------------------------------------------------
    @property
    def clone_ids(self) -> tuple[str, ...]:
        return tuple(c.id for c in self.clones)

    @property
    def drug_ids(self) -> tuple[str, ...]:
        return tuple(d.id for d in self.drugs)

    @property
    def resistant_clones(self) -> tuple[str, ...]:
        return tuple(c.id for c in self.clones if c.resistant)

    @property
    def diffusing_drugs(self) -> tuple[str, ...]:
        return tuple(d.id for d in self.drugs if d.diffusing)

    def clone(self, clone_id: str) -> CloneSpec:
        for c in self.clones:
            if c.id == clone_id:
                return c
        raise KeyError(f"{self.id} has no clone {clone_id!r}")

    def drug(self, drug_id: str) -> DrugSpec:
        for d in self.drugs:
            if d.id == drug_id:
                return d
        raise KeyError(f"{self.id} has no drug {drug_id!r}")

    def has_drug(self, drug_id: str) -> bool:
        return any(d.id == drug_id for d in self.drugs)

    def reference_concentrations(self, scale: float = 1.0) -> dict[str, float]:
        return {d.id: d.reference_concentration_nm * scale for d in self.drugs}

    def clone_index(self, clone_id: str) -> int:
        return self.clone_ids.index(clone_id)

    def path(self, key: str) -> Path:
        """A repository-relative path from the ``parameters`` block."""
        return ROOT / str(self.parameters[key])


def _require(data: Mapping[str, Any], key: str, where: str) -> Any:
    if key not in data:
        raise ValueError(f"{where}: missing required key {key!r}")
    return data[key]


def parse_cancer_model(data: Mapping[str, Any], where: str = "cancer model") -> CancerModel:
    clones = tuple(
        CloneSpec(
            id=str(_require(c, "id", where)),
            label=str(c.get("label", c["id"])),
            parent=None if c.get("parent") is None else str(c["parent"]),
            resistant=bool(c.get("resistant", False)),
        )
        for c in _require(data, "clones", where)
    )
    ids = [c.id for c in clones]
    if len(set(ids)) != len(ids):
        raise ValueError(f"{where}: duplicate clone ids")
    for c in clones:
        if c.parent is not None and c.parent not in ids:
            raise ValueError(f"{where}: clone {c.id} has unknown parent {c.parent}")
    drugs = tuple(
        DrugSpec(
            id=str(_require(d, "id", where)),
            label=str(d.get("label", d["id"])),
            exposure=str(d.get("exposure", "diffusing")),
            half_life_hours=float(d.get("half_life_hours", 24.0)),
            reference_concentration_nm=float(d.get("reference_concentration_nm", 1000.0)),
            mechanism=str(d.get("mechanism", "")),
        )
        for d in _require(data, "drugs", where)
    )
    for d in drugs:
        if d.exposure not in EXPOSURE_TYPES:
            raise ValueError(f"{where}: drug {d.id} has unknown exposure type {d.exposure!r}")
        if d.id == "none":
            raise ValueError(f"{where}: 'none' is reserved for no treatment")
    root = str(_require(data, "root_clone", where))
    if root not in ids:
        raise ValueError(f"{where}: root_clone {root} is not a clone")
    weights = tuple(float(w) for w in data.get("default_clone_weights", [1.0] + [0.0] * (len(ids) - 1)))
    if len(weights) != len(ids):
        raise ValueError(f"{where}: default_clone_weights must have one entry per clone")
    return CancerModel(
        id=str(_require(data, "id", where)),
        name=str(data.get("name", data["id"])),
        description=str(data.get("description", "")),
        root_clone=root,
        clones=clones,
        drugs=drugs,
        default_clone_weights=weights,
        parameters=dict(_require(data, "parameters", where)),
        schedules={str(k): dict(v) for k, v in data.get("schedules", {}).items()},
        default_panel=tuple(str(s) for s in data.get("default_panel", list(data.get("schedules", {})))),
        rl_actions=tuple(dict(a) for a in data.get("rl_actions", [])),
        demo_run=data.get("demo_run"),
        raw=dict(data),
    )


def available_cancers() -> tuple[str, ...]:
    return tuple(sorted(p.stem for p in MODELS_DIR.glob("*.json")))


@lru_cache(maxsize=None)
def load_cancer_model(name: str = DEFAULT_CANCER) -> CancerModel:
    """Load a model by id (a file in this package) or by path to a JSON file."""
    path = Path(name)
    if path.suffix != ".json":
        path = MODELS_DIR / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(
            f"unknown cancer model {name!r}; available: {', '.join(available_cancers())}"
        )
    with path.open() as handle:
        return parse_cancer_model(json.load(handle), where=str(path.name))


def default_model() -> CancerModel:
    return load_cancer_model(DEFAULT_CANCER)
