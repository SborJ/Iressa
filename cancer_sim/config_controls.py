"""Command-line controls for oxygen and microenvironment presets."""

from __future__ import annotations

from argparse import ArgumentParser, Namespace
from dataclasses import replace

from cancer_sim.automata import AutomataConfig


OXYGEN_PRESETS = ("default", "vascular", "hypoxic", "necrotic")


def add_microenvironment_args(parser: ArgumentParser) -> None:
    parser.add_argument(
        "--oxygen-mode",
        choices=OXYGEN_PRESETS,
        default="default",
        help="oxygen preset controlling supply, uptake, and necrosis pressure"
    )
    parser.add_argument("--oxygen-source", type=float, default=None)
    parser.add_argument("--oxygen-uptake", type=float, default=None)
    parser.add_argument("--oxygen-vmax", type=float, default=None)
    parser.add_argument("--oxygen-prolif-threshold", type=float, default=None)
    parser.add_argument("--oxygen-necrosis-threshold", type=float, default=None)
    parser.add_argument("--necrosis-exposure-time", type=float, default=None)
    parser.add_argument("--hypoxic-death-rate", type=float, default=None)
    parser.add_argument(
        "--field-substep-minutes",
        type=float,
        default=None,
        help="internal oxygen/drug field update interval in minutes"
    )


def apply_microenvironment_args(config: AutomataConfig, args: Namespace) -> AutomataConfig:
    values = _preset_values(args.oxygen_mode)
    override_map = {
        "oxygen_vessel_source": args.oxygen_source,
        "oxygen_uptake_rate": args.oxygen_uptake,
        "oxygen_mm_vmax": args.oxygen_vmax,
        "proliferation_oxygen_threshold": args.oxygen_prolif_threshold,
        "necrosis_threshold": args.oxygen_necrosis_threshold,
        "necrosis_exposure_time": args.necrosis_exposure_time,
        "hypoxic_death_rate": args.hypoxic_death_rate,
        "field_substep_days": (
            None if args.field_substep_minutes is None
            else args.field_substep_minutes / (24.0 * 60.0)
        )
    }
    values.update({key: value for key, value in override_map.items() if value is not None})
    return replace(config, **values)


def _preset_values(name: str) -> dict[str, float | None]:
    if name == "default":
        return {}
    if name == "vascular":
        return {
            "oxygen_vessel_source": 0.55,
            "oxygen_uptake_rate": 0.025,
            "oxygen_mm_vmax": 0.02,
            "proliferation_oxygen_threshold": 0.16,
            "necrosis_threshold": 0.035,
            "necrosis_exposure_time": 14.0 / 24.0,
            "hypoxic_death_rate": 0.02
        }
    if name == "hypoxic":
        return {
            "oxygen_vessel_source": 0.22,
            "oxygen_uptake_rate": 0.075,
            "oxygen_mm_vmax": 0.065,
            "proliferation_oxygen_threshold": 0.28,
            "necrosis_threshold": 0.09,
            "necrosis_exposure_time": 6.0 / 24.0,
            "hypoxic_death_rate": 0.05
        }
    if name == "necrotic":
        return {
            "oxygen_vessel_source": 0.14,
            "oxygen_uptake_rate": 0.10,
            "oxygen_mm_vmax": 0.09,
            "proliferation_oxygen_threshold": 0.34,
            "necrosis_threshold": 0.13,
            "necrosis_exposure_time": 3.0 / 24.0,
            "hypoxic_death_rate": 0.09
        }
    raise ValueError(f"unknown oxygen mode: {name}")
