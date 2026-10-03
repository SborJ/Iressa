"""End-to-end calibration pipeline orchestration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from cancer_sim.calibration.clones import (
    build_calibrated_clones_with_matches,
    build_resistance_graph,
    flatten_calibrated_clones,
    growth_rate_per_day_from_doubling_time_hours
)
from cancer_sim.calibration.ingest.cbioportal import ingest_cbioportal
from cancer_sim.calibration.ingest.civic import ingest_civic
from cancer_sim.calibration.ingest.gdsc import ingest_gdsc
from cancer_sim.calibration.ingest.passports import ingest_passports
from cancer_sim.calibration.join import build_clone_model_matches, build_model_drug_evidence
from cancer_sim.calibration.physics import calibrated_diffusion_coefficients, load_physics_config
from cancer_sim.calibration.report import write_report
from cancer_sim.calibration.schema import (
    CURATED_SEED,
    PHYSICS_CONFIG,
    PROCESSED_DIR,
    RAW_DIR,
    ModelRecord,
    file_sha256,
    parse_float,
    read_csv,
    write_csv
)
from cancer_sim.calibration.validation import validate_calibrated_clones


RAW_INPUTS = {
    "gdsc_drug_response": RAW_DIR / "gdsc_drug_response.csv",
    "cell_model_passports_mutations": RAW_DIR / "cell_model_passports_mutations.csv",
    "civic_evidence": RAW_DIR / "civic_evidence.csv",
    "cbioportal_alterations": RAW_DIR / "cbioportal_alterations.csv"
}


def run_calibration(
    *,
    processed_dir: Path = PROCESSED_DIR,
    strict_raw: bool = False,
    seed_path: Path = CURATED_SEED,
    physics_config_path: Path = PHYSICS_CONFIG
) -> dict[str, Any]:
    raw_present = {name: path.exists() for name, path in RAW_INPUTS.items()}
    if strict_raw and not any(raw_present.values()):
        raise FileNotFoundError("strict_raw requested but no raw calibration exports were found")

    gdsc_models, gdsc_responses = ingest_gdsc(RAW_INPUTS["gdsc_drug_response"])
    passport_models, passport_alterations = ingest_passports(
        RAW_INPUTS["cell_model_passports_mutations"]
    )
    civic_evidence = ingest_civic(RAW_INPUTS["civic_evidence"])
    cbio_models, cbio_alterations = ingest_cbioportal(RAW_INPUTS["cbioportal_alterations"])

    models = _dedupe_models(gdsc_models + passport_models + cbio_models)
    alterations = passport_alterations + cbio_alterations
    drug_responses = gdsc_responses

    clones, clone_matches = build_calibrated_clones_with_matches(
        alterations=passport_alterations,
        drug_responses=drug_responses,
        civic_evidence=civic_evidence,
        model_growth_rates=_passport_growth_rates(RAW_INPUTS["cell_model_passports_mutations"]),
        seed_path=seed_path
    )
    model_drug_evidence = build_model_drug_evidence(models, alterations, drug_responses)
    clone_model_matches = build_clone_model_matches(clone_matches, passport_alterations, drug_responses)
    resistance_graph = build_resistance_graph(seed_path)
    physics_config = load_physics_config(physics_config_path)
    diffusion_coefficients = calibrated_diffusion_coefficients(physics_config)
    warnings = validate_calibrated_clones(clones)
    warnings.extend(_physics_warnings(diffusion_coefficients))

    processed_dir.mkdir(parents=True, exist_ok=True)
    write_csv(processed_dir / "models.csv", models)
    write_csv(processed_dir / "alterations.csv", alterations)
    write_csv(processed_dir / "drug_response.csv", drug_responses)
    write_csv(processed_dir / "civic_evidence.csv", civic_evidence)
    write_csv(processed_dir / "model_drug_evidence.csv", model_drug_evidence)
    write_csv(processed_dir / "clone_model_matches.csv", clone_model_matches)
    write_csv(processed_dir / "calibrated_clone_parameters.csv", flatten_calibrated_clones(clones))
    _write_json(processed_dir / "calibrated_clone_parameters.json", clones)
    _write_json(processed_dir / "resistance_graph.json", resistance_graph)
    _write_json(processed_dir / "physics_calibration.json", {
        "config": physics_config,
        "diffusion_grid_coefficients": diffusion_coefficients
    })

    _write_json(processed_dir / "clone_templates.json", _legacy_clone_templates(clones))
    write_csv(processed_dir / "clone_templates.csv", _legacy_clone_rows(clones))
    write_csv(processed_dir / "resistance_evidence.csv", _legacy_resistance_rows(resistance_graph))

    raw_counts = {
        "gdsc_drug_response": len(gdsc_responses),
        "cell_model_passports_mutations": len(passport_alterations),
        "civic_evidence": len(civic_evidence),
        "cbioportal_alterations": len(cbio_alterations)
    }
    input_hashes = {name: file_sha256(path) for name, path in RAW_INPUTS.items()}
    write_report(
        processed_dir / "calibration_report.md",
        raw_files=raw_present,
        raw_counts=raw_counts,
        input_hashes=input_hashes,
        clones=clones,
        clone_model_matches=clone_model_matches,
        resistance_graph=resistance_graph,
        physics_config=physics_config,
        diffusion_coefficients=diffusion_coefficients,
        warnings=warnings
    )

    manifest = {
        "outputs": {
            "models": "data/processed/models.csv",
            "alterations": "data/processed/alterations.csv",
            "drug_response": "data/processed/drug_response.csv",
            "civic_evidence": "data/processed/civic_evidence.csv",
            "model_drug_evidence": "data/processed/model_drug_evidence.csv",
            "clone_model_matches": "data/processed/clone_model_matches.csv",
            "calibrated_clone_parameters_json": "data/processed/calibrated_clone_parameters.json",
            "calibrated_clone_parameters_csv": "data/processed/calibrated_clone_parameters.csv",
            "resistance_graph": "data/processed/resistance_graph.json",
            "physics_calibration": "data/processed/physics_calibration.json",
            "calibration_report": "data/processed/calibration_report.md"
        },
        "raw_files_present": raw_present,
        "raw_extract_counts": raw_counts,
        "input_hashes": input_hashes,
        "warnings": warnings
    }
    _write_json(processed_dir / "data_manifest.json", manifest)
    return manifest


def _dedupe_models(models: list[ModelRecord]) -> list[ModelRecord]:
    deduped: dict[tuple[str, str], ModelRecord] = {}
    for model in models:
        deduped.setdefault((model.source, model.model_id), model)
    return list(deduped.values())


def _physics_warnings(diffusion_coefficients: dict[str, float]) -> list[str]:
    warnings = []
    for name, coefficient in diffusion_coefficients.items():
        if coefficient > 0.24:
            warnings.append(
                f"{name} physical diffusion grid coefficient {coefficient:.4g} "
                "exceeds the single-step explicit 2D stability limit; avoid one "
                "biological CA step as one explicit diffusion step. Runtime field "
                "updates use quasi-steady oxygen and drug diffusion substeps."
            )
    return warnings


def _passport_growth_rates(path: Path) -> dict[str, float]:
    growth_rates = {}
    for row in read_csv(path):
        doubling_time_hours = parse_float(row.get("doubling_time_hours", ""))
        model_id = row.get("model_id", "")
        if model_id and doubling_time_hours and doubling_time_hours > 0:
            growth_rates.setdefault(
                model_id,
                growth_rate_per_day_from_doubling_time_hours(doubling_time_hours)
            )
    return growth_rates


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")


def _legacy_clone_templates(clones: list[dict[str, Any]]) -> list[dict[str, Any]]:
    templates = []
    for clone in clones:
        templates.append(
            {
                "id": clone["clone_id"],
                "label": clone["label"],
                "alterations": clone["alterations"]["value"],
                "growth_rate": clone["growth_rate_per_day"]["value"],
                "fitness_cost": clone["fitness_cost"]["value"],
                "drug_sensitivities": _legacy_sensitivities(clone),
                "ic50_nm": {
                    drug: clone["drug_response"][drug]["value"]
                    for drug in ("gefitinib", "osimertinib", "capmatinib")
                },
                "allowed_next_resistance_transitions": clone["allowed_transitions"]
            }
        )
    return templates


def _legacy_clone_rows(clones: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for clone in _legacy_clone_templates(clones):
        rows.append(
            {
                "clone": clone["id"],
                "label": clone["label"],
                "alterations": "|".join(clone["alterations"]),
                "growth_rate": clone["growth_rate"],
                "fitness_cost": clone["fitness_cost"],
                "gefitinib_sensitivity": clone["drug_sensitivities"]["gefitinib"],
                "osimertinib_sensitivity": clone["drug_sensitivities"]["osimertinib"],
                "capmatinib_sensitivity": clone["drug_sensitivities"]["capmatinib"],
                "gefitinib_ic50_nm": clone["ic50_nm"]["gefitinib"],
                "osimertinib_ic50_nm": clone["ic50_nm"]["osimertinib"],
                "capmatinib_ic50_nm": clone["ic50_nm"]["capmatinib"],
                "allowed_next_resistance_transitions": "|".join(
                    clone["allowed_next_resistance_transitions"]
                )
            }
        )
    return rows


def _legacy_resistance_rows(graph: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "parent_clone": edge["from"],
            "child_clone": edge["to"],
            "alteration": edge["alteration"],
            "relationship": edge["evidence"][0]["relationship"],
            "evidence_source": edge["evidence"][0]["source"],
            "simulation_probability": edge["simulation_probability"]
        }
        for edge in graph
    ]


def _legacy_sensitivities(clone: dict[str, Any]) -> dict[str, str]:
    sensitivities = {}
    for drug in ("gefitinib", "osimertinib", "capmatinib"):
        value = float(clone["drug_response"][drug]["value"])
        if value <= 100:
            sensitivities[drug] = "sensitive"
        elif value <= 3000:
            sensitivities[drug] = "partially_resistant"
        else:
            sensitivities[drug] = "resistant"
    return sensitivities
