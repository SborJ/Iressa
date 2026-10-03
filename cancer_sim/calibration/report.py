"""Calibration report rendering."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def write_report(
    path: Path,
    *,
    raw_files: dict[str, bool],
    raw_counts: dict[str, int],
    input_hashes: dict[str, str],
    clones: list[dict[str, Any]],
    clone_model_matches: list[dict[str, Any]],
    resistance_graph: list[dict[str, Any]],
    physics_config: dict[str, Any],
    diffusion_coefficients: dict[str, float],
    warnings: list[str]
) -> None:
    lines = [
        "# Calibration Report",
        "",
        "## Data Sources",
        "",
        "- GDSC / Cell Model Passports: genotype and drug response when raw exports are present.",
        "- CIViC: literature evidence for sensitivity/resistance relationships.",
        "- cBioPortal: patient/sample alteration prevalence and co-occurrence context.",
        "",
        "## Input Files",
        "",
        "| source | present | rows | sha256 |",
        "| --- | --- | ---: | --- |"
    ]
    for source, present in raw_files.items():
        lines.append(f"| {source} | {present} | {raw_counts.get(source, 0)} | `{input_hashes.get(source, '')}` |")

    lines.extend(["", "## Final Clones", ""])
    for clone in clones:
        matched_models = [
            row for row in clone_model_matches
            if row["clone_id"] == clone["clone_id"]
        ]
        lines.extend([
            f"### {clone['label']}",
            "",
            f"- Alterations: {', '.join(clone['alterations']['value'])}",
            f"- Growth rate: {clone['growth_rate_per_day']['value']} {clone['growth_rate_per_day']['unit']} ({clone['growth_rate_per_day']['status']})",
            f"- Fitness cost: {clone['fitness_cost']['value']} ({clone['fitness_cost']['status']}; {clone['fitness_cost']['source']})",
            f"- Max drug death rate: {clone['max_drug_death_rate_per_day']['value']:.3f} {clone['max_drug_death_rate_per_day']['unit']} ({clone['max_drug_death_rate_per_day']['status']}; {clone['max_drug_death_rate_per_day']['source']})",
            f"- Hill coefficient: {clone['hill_coefficient']['value']} ({clone['hill_coefficient']['status']})"
        ])
        for drug, response in clone["drug_response"].items():
            lines.append(
                f"- {drug} IC50: {response['value']} {response['unit']} "
                f"({response['status']}, n={response['n_records']})"
            )
        for key, label in (
            ("sensitivity_evidence", "Sensitivity evidence"),
            ("resistance_evidence", "Resistance evidence"),
            ("transition_evidence", "Transition evidence")
        ):
            if clone.get(key):
                lines.append(f"- {label}: {'; '.join(clone[key])}")
        used = [row for row in matched_models if row.get("used_in_calibration", True) in (True, "True")]
        dropped = [row for row in matched_models if row.get("used_in_calibration", True) in (False, "False")]
        if used:
            lines.append("- Matched models used: " + ", ".join(
                f"{row['model_id']} ({row.get('model_name', '')}; {row.get('histology', '')})" for row in used
            ))
        else:
            lines.append("- Matched models used: none; using fallback/assumed clone parameters where needed.")
        for row in dropped:
            lines.append(f"- Genotype-matched but EXCLUDED: {row['model_id']} ({row.get('model_name', '')}): {row.get('exclusion_reason', '')}")
        lines.append("")

    lines.extend(["## Resistance Graph", ""])
    for edge in resistance_graph:
        lines.append(
            f"- {edge['from']} -> {edge['to']} via {edge['alteration']}: "
            f"{edge['effect']} in {edge['drug_context']}; "
            f"simulation probability {edge['simulation_probability']} ({edge['probability_status']})"
        )

    lines.extend([
        "",
        "## Physical Calibration",
        "",
        f"- lattice spacing: {physics_config['space']['lattice_spacing_um']} um",
        f"- physical calibration field step: {physics_config['time']['simulation_step_minutes']} minutes",
        "- biological experiment time: configured separately in days with --days and --dt-days",
        "- runtime oxygen solver: quasi-steady iterative solve",
        "- runtime drug solver: explicit diffusion with automatic stability/time substeps",
        "- drug max-death rates are interpreted as day^-1",
        "- hypoxic death rates are interpreted as day^-1; necrosis exposure time is interpreted in days",
        f"- oxygen diffusion grid coefficient: {diffusion_coefficients['oxygen']:.4g}"
    ])
    for drug, drug_config in physics_config["drugs"].items():
        lines.append(
            f"- {drug}: mode={drug_config['concentration_mode']}, "
            f"vessel concentration={drug_config['vessel_concentration_nm']} nM, "
            f"grid diffusion={diffusion_coefficients[drug]:.4g}"
        )

    lines.extend([
        "",
        "## Assumptions And Warnings",
        "",
        "- Measured data, literature-derived evidence, inferred values, and simulation assumptions are intentionally kept separate.",
        "- Mutation probabilities per division are not inferred from cBioPortal prevalence.",
        "- Vessel drug concentrations are simulation assumptions unless explicitly calibrated to pharmacokinetic data."
    ])
    for warning in warnings:
        lines.append(f"- WARNING: {warning}")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
