"""Physical-unit calibration helpers."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cancer_sim.calibration.schema import PHYSICS_CONFIG


def load_physics_config(path: Path = PHYSICS_CONFIG) -> dict[str, Any]:
    with path.open() as handle:
        return json.load(handle)


def diffusion_grid_coefficient(
    *,
    diffusion_um2_s: float,
    dt_seconds: float,
    dx_um: float
) -> float:
    if diffusion_um2_s < 0 or dt_seconds <= 0 or dx_um <= 0:
        raise ValueError("diffusion, dt, and dx must be physically valid")
    return diffusion_um2_s * dt_seconds / (dx_um ** 2)


def calibrated_diffusion_coefficients(config: dict[str, Any]) -> dict[str, float]:
    dx = float(config["space"]["lattice_spacing_um"])
    dt = float(config["time"]["simulation_step_minutes"]) * 60.0
    coefficients = {
        "oxygen": diffusion_grid_coefficient(
            diffusion_um2_s=float(config["oxygen"]["diffusion_um2_s"]),
            dt_seconds=dt,
            dx_um=dx
        )
    }
    for drug, drug_config in config["drugs"].items():
        coefficients[drug] = diffusion_grid_coefficient(
            diffusion_um2_s=float(drug_config["diffusion_um2_s"]),
            dt_seconds=dt,
            dx_um=dx
        )
    return coefficients

