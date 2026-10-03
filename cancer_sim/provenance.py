"""Parameter provenance and unit tables for the validated engine.

Everything the simulator uses numerically is listed here with its unit and its
status (measured / literature_derived / inferred / assumed), so the report and
the UI can show where each number comes from without re-deriving it.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from cancer_sim.automata import (
    DEFAULT_CALIBRATED_CLONE_DATA,
    DEFAULT_PHYSICS_CALIBRATION,
    DEFAULT_RESISTANCE_GRAPH,
    AutomataConfig
)
from cancer_sim.world_seed import DEFAULT_VESSEL_SPACING_UM


STATUSES = ("measured", "literature_derived", "inferred", "assumed", "not_applied")


@dataclass(frozen=True)
class ParameterProvenance:
    name: str
    scope: str            # clone id, "physics", "world", "treatment", "mutation"
    value: Any
    unit: str
    status: str
    source: str
    n: int = 0
    low: Any = None
    high: Any = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def clone_parameter_table(path: Path = DEFAULT_CALIBRATED_CLONE_DATA) -> list[ParameterProvenance]:
    rows: list[ParameterProvenance] = []
    for clone in json.load(open(path)):
        cid = clone["clone_id"]
        for key, label in (
            ("growth_rate_per_day", "growth_rate"),
            ("fitness_cost", "fitness_cost"),
            ("max_drug_death_rate_per_day", "max_drug_death_rate"),
            ("hill_coefficient", "hill_coefficient")
        ):
            p = clone[key]
            rows.append(ParameterProvenance(label, cid, p["value"], p["unit"], p["status"], p["source"],
                                            int(p.get("n_records", 0)), p.get("min"), p.get("max")))
        for drug, p in clone["drug_response"].items():
            rows.append(ParameterProvenance(f"{drug}_ic50", cid, p["value"], p["unit"], p["status"], p["source"],
                                            int(p.get("n_records", 0)), p.get("min"), p.get("max")))
    return rows


def mutation_parameter_table(
    path: Path = DEFAULT_RESISTANCE_GRAPH,
    mutation_probability_scale: float = 1.0
) -> list[ParameterProvenance]:
    rows = []
    for edge in json.load(open(path)):
        base = float(edge["simulation_probability"])
        rows.append(ParameterProvenance(
            f"p_mutation[{edge['from']}->{edge['to']}]", "mutation", base, "per division",
            edge["probability_status"], "curated resistance graph; not derived from cBioPortal prevalence"
        ))
        if mutation_probability_scale != 1.0:
            rows.append(ParameterProvenance(
                f"p_mutation_effective[{edge['from']}->{edge['to']}]", "mutation", base * mutation_probability_scale,
                "per division", "assumed",
                f"demo scaling x{mutation_probability_scale:g} so that resistance can arise in a ~10^3-cell lattice"
            ))
    return rows


def physics_parameter_table(
    config: AutomataConfig,
    vessel_spacing_um: float | None = DEFAULT_VESSEL_SPACING_UM
) -> list[ParameterProvenance]:
    A = "assumed"
    rows = [
        ParameterProvenance("lattice_spacing", "physics", config.lattice_spacing_um, "um", "literature_derived",
                            "typical epithelial tumour cell diameter 15-20 um (PhysiCell default volume 2494 um^3)"),
        ParameterProvenance("drug_diffusion", "physics", config.drug_diffusion_um2_s, "um^2/s", "literature_derived",
                            "small-molecule interstitial diffusivity order of magnitude (physics_calibration.json)"),
        ParameterProvenance("drug_diffusion_lattice", "physics", config.drug_grid_diffusion_per_day, "sites^2/day", "inferred",
                            "D * 86400 / dx^2"),
        ParameterProvenance("drug_decay", "physics", config.drug_decay_per_hour, "1/h", A,
                            "physics_calibration.json; gefitinib plasma t1/2 ~41 h would give 0.017/h"),
        ParameterProvenance("drug_decay_length", "physics", config.drug_decay_length_sites, "sites", "inferred", "sqrt(D/k)"),
        ParameterProvenance("drug_uptake_rate", "physics", config.drug_uptake_rate, "1/day per occupied site", A, "simulator constant"),
        ParameterProvenance("vessel_drug_concentration", "physics", config.gefitinib_vessel_concentration_nm, "nM", A,
                            "constant plasma level; no pharmacokinetics (physics_calibration.json)"),
        ParameterProvenance("oxygen_diffusion", "physics", config.oxygen_diffusion, "lattice units", A,
                            "dimensionless; with uptake sets ~120-170 um penetration, consistent with Thomlinson & Gray 1955"),
        ParameterProvenance("oxygen_uptake_rate", "physics", config.oxygen_uptake_rate, "lattice units", A, "simulator constant (linear uptake)"),
        ParameterProvenance("oxygen_mm_vmax", "physics", config.oxygen_mm_vmax, "lattice units", A, "Michaelis-Menten uptake"),
        ParameterProvenance("oxygen_mm_km", "physics", config.oxygen_mm_km, "normalised O2", A, "Michaelis-Menten half-saturation"),
        ParameterProvenance("oxygen_vessel_source", "physics", config.oxygen_vessel_source, "lattice units", A, "vessel sites saturate at 1.0"),
        ParameterProvenance("proliferation_oxygen_threshold", "physics", config.proliferation_oxygen_threshold, "fraction of vessel O2", A,
                            "PhysiCell: proliferation stops below 5 mmHg of a 38 mmHg vessel (0.13); here 0.22"),
        ParameterProvenance("necrosis_threshold", "physics", config.necrosis_threshold, "fraction of vessel O2", A,
                            "PhysiCell necrosis onset 5 mmHg / 38 mmHg = 0.13; here 0.06"),
        ParameterProvenance("necrosis_exposure_time", "physics", config.necrosis_exposure_time, "days", A, "sustained hypoxia before necrosis"),
        ParameterProvenance("hypoxic_death_rate", "physics", config.hypoxic_death_rate, "1/day", A, "after exposure time is exceeded"),
        ParameterProvenance("necrotic_clearance_rate", "physics", config.necrotic_clearance_rate, "1/day", A,
                            "dead-cell clearance; apoptotic clearance is hours, necrotic debris days-weeks"),
        ParameterProvenance("vessel_spacing", "world", vessel_spacing_um, "um", "literature_derived",
                            "tumour intercapillary distance 100-200 um (Thomlinson & Gray 1955; Vaupel 1989)"),
        ParameterProvenance("oxygen_solver_tolerance", "physics", config.oxygen_solver_tolerance, "normalised O2", "numerical", "max change per SOR sweep"),
        ParameterProvenance("drug_solver_tolerance", "physics", config.drug_solver_tolerance, "normalised C", "numerical", "max change per SOR sweep"),
    ]
    return rows


def unit_table() -> list[dict[str, str]]:
    return [
        {"quantity": "lattice spacing dx", "unit": "um", "where": "AutomataConfig.lattice_spacing_um, WorldConfig.cell_size_um"},
        {"quantity": "biological time step dt", "unit": "days", "where": "SimulationRunner.run(dt=...), AutomataConfig.necrosis_exposure_time"},
        {"quantity": "experiment horizon", "unit": "days", "where": "--days"},
        {"quantity": "growth rate", "unit": "1/day", "where": "ClonePhenotype.growth_rate; P_div = 1 - exp(-r (1-c) dt)"},
        {"quantity": "max drug death rate k_max", "unit": "1/day", "where": "ClonePhenotype.max_drug_death_rate; P_death = 1 - exp(-k_max E(C) dt)"},
        {"quantity": "hypoxic death rate", "unit": "1/day", "where": "AutomataConfig.hypoxic_death_rate"},
        {"quantity": "dead-cell clearance rate", "unit": "1/day", "where": "AutomataConfig.necrotic_clearance_rate"},
        {"quantity": "drug concentration", "unit": "nM", "where": "IC50 (GDSC LN_IC50 in ln uM -> exp()*1000 nM); local C = normalised field x vessel nM"},
        {"quantity": "drug diffusivity", "unit": "um^2/s -> sites^2/day", "where": "AutomataConfig.drug_diffusion_um2_s -> drug_grid_diffusion_per_day"},
        {"quantity": "drug decay", "unit": "1/h -> 1/day", "where": "AutomataConfig.drug_decay_per_hour -> drug_decay_per_day"},
        {"quantity": "oxygen", "unit": "fraction of vessel value (0-1)", "where": "ScalarField; thresholds are fractions"},
        {"quantity": "oxygen diffusion / uptake", "unit": "dimensionless lattice coefficients", "where": "only their ratio (penetration depth) is physical"},
        {"quantity": "mutation probability", "unit": "per successful division", "where": "resistance_graph.json x mutation_probability_scale"},
        {"quantity": "legacy explicit drug solver", "unit": "sites^2/day (0.1), 1/day decay", "where": "drug_solver=explicit_legacy only; dimensionally inconsistent with the physics file"},
    ]


def write_provenance_tables(output_dir: Path, config: AutomataConfig, mutation_probability_scale: float = 1.0) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = clone_parameter_table() + mutation_parameter_table(mutation_probability_scale=mutation_probability_scale) + physics_parameter_table(config)
    (output_dir / "parameter_provenance.json").write_text(json.dumps([r.as_dict() for r in rows], indent=2) + "\n")
    lines = ["# Parameter provenance", "", "| scope | parameter | value | unit | status | n | range | source |", "| --- | --- | ---: | --- | --- | ---: | --- | --- |"]
    for r in rows:
        value = f"{r.value:.4g}" if isinstance(r.value, float) else str(r.value)
        rng = "" if r.low is None else f"{r.low:.4g}-{r.high:.4g}" if isinstance(r.low, float) else f"{r.low}-{r.high}"
        lines.append(f"| {r.scope} | {r.name} | {value} | {r.unit} | {r.status} | {r.n} | {rng} | {r.source} |")
    lines += ["", "# Units", "", "| quantity | unit | where |", "| --- | --- | --- |"]
    for row in unit_table():
        lines.append(f"| {row['quantity']} | {row['unit']} | {row['where']} |")
    (output_dir / "parameter_provenance.md").write_text("\n".join(lines) + "\n")
