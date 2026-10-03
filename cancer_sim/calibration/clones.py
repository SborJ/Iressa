"""Build calibrated clone parameters from normalized records."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from statistics import median
from typing import Any

from cancer_sim.calibration.schema import (
    AlterationRecord,
    CivicEvidenceRecord,
    CURATED_SEED,
    DrugResponseRecord
)
from cancer_sim.calibration.targets import TARGET_DRUGS, canonical_alteration


CALIBRATION_DRUGS = tuple(drug for drug in TARGET_DRUGS if drug != "erlotinib")


@dataclass(frozen=True)
class ParameterValue:
    value: float | str | list[str] | None
    unit: str
    status: str
    source: str
    n_records: int = 0
    minimum: float | None = None
    maximum: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "value": self.value,
            "unit": self.unit,
            "status": self.status,
            "source": self.source,
            "n_records": self.n_records,
            "min": self.minimum,
            "max": self.maximum
        }


def build_calibrated_clones(
    *,
    alterations: list[AlterationRecord],
    drug_responses: list[DrugResponseRecord],
    civic_evidence: list[CivicEvidenceRecord],
    model_growth_rates: dict[str, float] | None = None,
    seed_path: Path = CURATED_SEED
) -> list[dict[str, Any]]:
    clones, _ = build_calibrated_clones_with_matches(
        alterations=alterations,
        drug_responses=drug_responses,
        civic_evidence=civic_evidence,
        model_growth_rates=model_growth_rates,
        seed_path=seed_path
    )
    return clones


def build_calibrated_clones_with_matches(
    *,
    alterations: list[AlterationRecord],
    drug_responses: list[DrugResponseRecord],
    civic_evidence: list[CivicEvidenceRecord],
    model_growth_rates: dict[str, float] | None = None,
    seed_path: Path = CURATED_SEED,
    excluded_matches_out: dict[str, dict[str, str]] | None = None
) -> tuple[list[dict[str, Any]], dict[str, set[str]]]:
    seed = _read_seed(seed_path)
    model_growth_rates = model_growth_rates or {}
    exclusions = {row["model_id"]: row for row in seed.get("model_exclusions", [])}
    inheritance = seed.get("growth_inheritance", {})
    assay = seed.get("drug_response_assay")
    hill = seed.get("hill_coefficient", {"value": 1.2, "status": "assumed", "source": "curated simulator seed"})
    clones = []
    clones_by_id: dict[str, dict[str, Any]] = {}
    clone_matches = {}
    for seed_clone in seed["clones"]:
        clone_id = seed_clone["id"]
        matching_model_ids, excluded = _matching_model_ids(
            seed_clone["alterations"], alterations, exclusions
        )
        if excluded_matches_out is not None:
            excluded_matches_out[clone_id] = excluded
        parent_id = inheritance.get(clone_id)
        parent_growth = clones_by_id[parent_id]["growth_rate_per_day"] if parent_id in clones_by_id else None
        growth_rate = _calibrate_growth_rate(
            matching_model_ids=matching_model_ids,
            model_growth_rates=model_growth_rates,
            fallback=float(seed_clone["growth_rate"]),
            parent_id=parent_id,
            parent_growth=parent_growth
        )
        clone = {
            "clone_id": clone_id,
            "label": seed_clone["label"],
            "alterations": ParameterValue(
                value=seed_clone["alterations"],
                unit="list",
                status="literature_derived",
                source="curated EGFR resistance graph",
                n_records=len(seed_clone["alterations"])
            ).as_dict(),
            "growth_rate_per_day": growth_rate.as_dict(),
            "fitness_cost": _calibrate_fitness_cost(
                growth_rate_status=growth_rate.status,
                fallback=float(seed_clone["fitness_cost"])
            ).as_dict(),
            "max_drug_death_rate_per_day": _calibrate_max_death_rate(assay).as_dict(),
            "hill_coefficient": ParameterValue(
                value=float(hill["value"]),
                unit="dimensionless",
                status=hill.get("status", "assumed"),
                source=hill.get("source", "curated simulator seed"),
                n_records=0
            ).as_dict(),
            "drug_response": {},
            "allowed_transitions": seed_clone["allowed_next_resistance_transitions"],
            **_evidence_by_role(clone_id, civic_evidence)
        }
        clone["evidence_notes"] = (
            clone["sensitivity_evidence"]
            + clone["resistance_evidence"]
            + clone["transition_evidence"]
        )[:5]
        clone_matches[clone_id] = matching_model_ids
        clones_by_id[clone_id] = clone
        for drug in CALIBRATION_DRUGS:
            clone["drug_response"][drug] = _calibrate_ic50(
                drug=drug,
                matching_model_ids=matching_model_ids,
                drug_responses=drug_responses,
                fallback=float(seed_clone["ic50_nm"][drug])
            ).as_dict()
        clones.append(clone)
    return clones, clone_matches


def build_resistance_graph(seed_path: Path = CURATED_SEED) -> list[dict[str, Any]]:
    seed = _read_seed(seed_path)
    graph = []
    for edge in seed["resistance_evidence"]:
        graph.append(
            {
                "from": edge["parent_clone"],
                "to": edge["child_clone"],
                "mechanism": "amplification" if "MET" in edge["alteration"] else "mutation",
                "alteration": edge["alteration"],
                "drug_context": _drug_context(edge["relationship"]),
                "effect": "resistance",
                "transition_probability": None,
                "evidence": [
                    {
                        "source": edge["evidence_source"],
                        "relationship": edge["relationship"],
                        "status": "literature_derived"
                    }
                ],
                "simulation_probability": edge["simulation_probability"],
                "probability_status": "assumed"
            }
        )
    return graph


def flatten_calibrated_clones(clones: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for clone in clones:
        row = {
            "clone_id": clone["clone_id"],
            "label": clone["label"],
            "alterations": "|".join(clone["alterations"]["value"]),
            "growth_rate_per_day": clone["growth_rate_per_day"]["value"],
            "growth_rate_status": clone["growth_rate_per_day"]["status"],
            "growth_rate_n": clone["growth_rate_per_day"]["n_records"],
            "fitness_cost": clone["fitness_cost"]["value"],
            "fitness_cost_status": clone["fitness_cost"]["status"],
            "max_drug_death_rate_per_day": clone["max_drug_death_rate_per_day"]["value"],
            "max_drug_death_rate_status": clone["max_drug_death_rate_per_day"]["status"],
            "hill_coefficient": clone["hill_coefficient"]["value"],
            "allowed_transitions": "|".join(clone["allowed_transitions"]),
            "evidence_notes": " ".join(clone["evidence_notes"])
        }
        for drug in CALIBRATION_DRUGS:
            response = clone["drug_response"][drug]
            row[f"{drug}_ic50_nm"] = response["value"]
            row[f"{drug}_ic50_status"] = response["status"]
            row[f"{drug}_ic50_n_records"] = response["n_records"]
        rows.append(row)
    return rows


def _calibrate_ic50(
    *,
    drug: str,
    matching_model_ids: set[str],
    drug_responses: list[DrugResponseRecord],
    fallback: float
) -> ParameterValue:
    measured = [
        row.value
        for row in drug_responses
        if row.model_id in matching_model_ids
        and row.drug.lower() == drug
        and row.metric.upper() == "IC50"
        and row.unit == "nM"
        and row.value > 0
    ]
    if measured:
        return ParameterValue(
            value=median(measured),
            unit="nM",
            status="measured",
            source="normalized drug_response.csv",
            n_records=len(measured),
            minimum=min(measured),
            maximum=max(measured)
        )
    return ParameterValue(
        value=fallback,
        unit="nM",
        status="assumed",
        source="curated simulator seed fallback",
        n_records=0,
        minimum=fallback,
        maximum=fallback
    )


def growth_rate_per_day_from_doubling_time_hours(doubling_time_hours: float) -> float:
    return math.log(2) * 24 / doubling_time_hours


def _calibrate_max_death_rate(assay: dict[str, Any] | None) -> ParameterValue:
    """k_max from the assay definition of IC50.

    Relative viability at C = IC50 after T days is exp(-k_max * E(IC50) * T) with
    E(IC50) = 0.5, so k_max = -ln(v) / (0.5 * T). For GDSC (v = 0.5, T = 3 days)
    this is ln(2) / 1.5 = 0.462 per day.
    """
    if not assay:
        return ParameterValue(
            value=0.18, unit="1/day", status="assumed",
            source="legacy simulator constant (no assay definition supplied)", n_records=0
        )
    duration = float(assay["duration_days"])
    viability = float(assay["relative_viability_at_ic50"])
    value = -math.log(viability) / (0.5 * duration)
    return ParameterValue(
        value=value,
        unit="1/day",
        status="inferred",
        source=f"derived from IC50 definition: {assay['name']} ({assay['source']})",
        n_records=0,
        minimum=value,
        maximum=value
    )


def _calibrate_growth_rate(
    *,
    matching_model_ids: set[str],
    model_growth_rates: dict[str, float],
    fallback: float,
    parent_id: str | None = None,
    parent_growth: dict[str, Any] | None = None
) -> ParameterValue:
    measured = [
        model_growth_rates[model_id]
        for model_id in matching_model_ids
        if model_id in model_growth_rates and model_growth_rates[model_id] > 0
    ]
    if measured:
        return ParameterValue(
            value=median(measured),
            unit="1/day",
            status="measured",
            source="Cell Model Passports growth_rate_latest.csv",
            n_records=len(measured),
            minimum=min(measured),
            maximum=max(measured)
        )
    if parent_growth is not None and parent_growth["status"] in {"measured", "inferred"}:
        return ParameterValue(
            value=float(parent_growth["value"]),
            unit="1/day",
            status="inferred",
            source=(
                f"inherited from parent clone {parent_id} ({parent_growth['status']}, "
                f"n={parent_growth['n_records']}); the assumed fitness_cost is applied once by the simulator"
            ),
            n_records=int(parent_growth["n_records"]),
            minimum=parent_growth.get("min"),
            maximum=parent_growth.get("max")
        )
    return ParameterValue(
        value=fallback,
        unit="1/day",
        status="assumed",
        source="curated simulator seed",
        n_records=1,
        minimum=fallback,
        maximum=fallback
    )


def _calibrate_fitness_cost(*, growth_rate_status: str, fallback: float) -> ParameterValue:
    if growth_rate_status == "measured":
        return ParameterValue(
            value=0.0,
            unit="fraction",
            status="not_applied",
            source="measured clone-specific growth_rate_per_day is used directly",
            n_records=0,
            minimum=0.0,
            maximum=0.0
        )
    return ParameterValue(
        value=fallback,
        unit="fraction",
        status="assumed",
        source="curated simulator seed",
        n_records=1,
        minimum=fallback,
        maximum=fallback
    )


def _matching_model_ids(
    clone_alterations: list[str],
    alterations: list[AlterationRecord],
    exclusions: dict[str, dict[str, str]] | None = None
) -> tuple[set[str], dict[str, str]]:
    """Genotype-matched model ids and the subset removed by documented exclusions.

    Returns ``(matches, excluded)`` where ``excluded`` maps model_id to the
    curated exclusion reason. Exclusions are never applied silently: callers
    report them in clone_model_matches.csv and the calibration report.
    """
    exclusions = exclusions or {}
    required = [_canonical_requirement(value) for value in clone_alterations]
    excluded_markers = _excluded_resistance_markers(required)
    matches: set[str] = set()
    excluded: dict[str, str] = {}
    by_model: dict[str, set[str]] = {}
    for row in alterations:
        by_model.setdefault(row.model_id, set()).add(_canonical_record(row))
    for model_id, model_alterations in by_model.items():
        if all(_requirement_matches(req, model_alterations) for req in required) and not (
            model_alterations & excluded_markers
        ):
            if model_id in exclusions:
                excluded[model_id] = exclusions[model_id]["reason"]
            else:
                matches.add(model_id)
    return matches, excluded


def _canonical_requirement(value: str) -> str:
    text = value.upper()
    if "EXON19DEL_OR_L858R" in text or "EXON19DEL_OR" in text:
        return "EGFR_ACTIVATING"
    if "MET" in text and ("AMP" in text or "AMPLIFICATION" in text):
        return "MET_AMP"
    return canonical_alteration("", value).replace("EGFR_", "").replace("_EXON19DEL_OR_L858R", "EGFR")


def _canonical_record(row: AlterationRecord) -> str:
    canonical = canonical_alteration(row.gene, row.alteration_type, row.alteration, row.protein_change)
    return canonical.replace("EGFR_", "").replace("_EXON19DEL_OR_L858R", "EGFR")


def _requirement_matches(requirement: str, model_alterations: set[str]) -> bool:
    if requirement == "EGFR_ACTIVATING":
        return any(alteration in model_alterations for alteration in ("L858R", "EXON19DEL"))
    return any(requirement in alteration for alteration in model_alterations)


def _excluded_resistance_markers(required: list[str]) -> set[str]:
    markers = {"T790M", "C797S", "MET_AMP"}
    return markers - set(required)


def _evidence_by_role(
    clone_id: str,
    civic_evidence: list[CivicEvidenceRecord]
) -> dict[str, list[str]]:
    sensitivity_terms = {
        "EGFR": ("L858R", "EXON 19", "EXON19"),
        "T790M": ("T790M",),
        "C797S": ("C797S",),
        "MET_AMP": ("MET", "AMPLIFICATION", "AMP")
    }[clone_id]
    resistance_terms = {
        "EGFR": (),
        "T790M": ("T790M",),
        "C797S": ("C797S",),
        "MET_AMP": ("MET", "AMPLIFICATION", "AMP")
    }[clone_id]
    evidence = {
        "sensitivity_evidence": [],
        "resistance_evidence": [],
        "transition_evidence": []
    }
    for row in civic_evidence:
        note = f"CIViC {row.civic_id}: {row.molecular_profile} {row.response} {row.drug}".strip()
        profile = row.molecular_profile.upper()
        response = row.response.upper()
        direction = row.evidence_direction.upper()
        drug = row.drug.upper()
        if (
            "SENSITIVITY" in response
            and "SUPPORTS" in direction
            and any(term in profile for term in sensitivity_terms)
            and _evidence_drug_matches(clone_id, "sensitivity", drug)
            and not _has_excluded_profile_terms(clone_id, profile)
        ):
            evidence["sensitivity_evidence"].append(note)
        if (
            "RESISTANCE" in response
            and "SUPPORTS" in direction
            and any(term in profile for term in resistance_terms)
            and _evidence_drug_matches(clone_id, "resistance", drug)
            and not _has_excluded_profile_terms(clone_id, profile)
        ):
            evidence["resistance_evidence"].append(note)

    if clone_id == "T790M":
        evidence["transition_evidence"] = evidence["resistance_evidence"][:5]
    elif clone_id == "C797S":
        evidence["transition_evidence"] = evidence["resistance_evidence"][:5]
    elif clone_id == "MET_AMP":
        evidence["transition_evidence"] = evidence["resistance_evidence"][:5]

    return {key: value[:5] for key, value in evidence.items()}


def _has_excluded_profile_terms(clone_id: str, profile: str) -> bool:
    excluded = {
        "EGFR": ("T790M", "C797S", "MET"),
        "T790M": ("C797S", "MET"),
        "C797S": ("MET",),
        "MET_AMP": ("C797S",)
    }[clone_id]
    return any(term in profile for term in excluded)


def _evidence_drug_matches(clone_id: str, role: str, drug: str) -> bool:
    accepted = {
        ("EGFR", "sensitivity"): ("GEFITINIB", "ERLOTINIB", "OSIMERTINIB"),
        ("EGFR", "resistance"): (),
        ("T790M", "sensitivity"): ("OSIMERTINIB",),
        ("T790M", "resistance"): ("GEFITINIB", "ERLOTINIB"),
        ("C797S", "sensitivity"): (),
        ("C797S", "resistance"): ("OSIMERTINIB",),
        ("MET_AMP", "sensitivity"): ("CAPMATINIB", "MET"),
        ("MET_AMP", "resistance"): ("GEFITINIB", "ERLOTINIB", "OSIMERTINIB")
    }.get((clone_id, role), ())
    return bool(accepted) and any(item in drug for item in accepted)


def _drug_context(relationship: str) -> str:
    text = relationship.lower()
    if "osimertinib" in text:
        return "osimertinib"
    if "gefitinib" in text or "first-generation" in text:
        return "gefitinib/erlotinib"
    return "EGFR inhibitor"


def _read_seed(path: Path) -> dict[str, Any]:
    with path.open() as handle:
        return json.load(handle)
