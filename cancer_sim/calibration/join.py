"""Evidence joins used before clone calibration."""

from __future__ import annotations

from cancer_sim.calibration.schema import AlterationRecord, DrugResponseRecord, ModelRecord
from cancer_sim.calibration.targets import canonical_alteration


def build_model_drug_evidence(
    models: list[ModelRecord],
    alterations: list[AlterationRecord],
    drug_responses: list[DrugResponseRecord]
) -> list[dict[str, str | float]]:
    models_by_id = {model.model_id: model for model in models}
    alterations_by_model: dict[str, list[str]] = {}
    for alteration in alterations:
        alterations_by_model.setdefault(alteration.model_id, []).append(
            canonical_alteration(
                alteration.gene,
                alteration.alteration_type,
                alteration.alteration,
                alteration.protein_change
            )
        )

    rows = []
    for response in drug_responses:
        model = models_by_id.get(response.model_id)
        rows.append(
            {
                "model_id": response.model_id,
                "model_name": model.model_name if model else "",
                "cancer_type": model.cancer_type if model else "",
                "tissue": model.tissue if model else "",
                "canonical_alterations": "|".join(sorted(set(alterations_by_model.get(response.model_id, [])))),
                "drug": response.drug,
                "metric": response.metric,
                "value": response.value,
                "unit": response.unit,
                "source": response.source
            }
        )
    return rows


def build_clone_model_matches(
    clone_matches: dict[str, set[str]],
    alterations: list[AlterationRecord],
    drug_responses: list[DrugResponseRecord],
    models: list[ModelRecord] | None = None,
    excluded_matches: dict[str, dict[str, str]] | None = None,
    model_growth_rates: dict[str, float] | None = None
) -> list[dict[str, str | int | float]]:
    models_by_id = {model.model_id: model for model in (models or [])}
    excluded_matches = excluded_matches or {}
    model_growth_rates = model_growth_rates or {}
    alterations_by_model: dict[str, list[str]] = {}
    drugs_by_model: dict[str, list[str]] = {}
    for alteration in alterations:
        alterations_by_model.setdefault(alteration.model_id, []).append(
            canonical_alteration(
                alteration.gene,
                alteration.alteration_type,
                alteration.alteration,
                alteration.protein_change
            )
        )
    for response in drug_responses:
        drugs_by_model.setdefault(response.model_id, []).append(response.drug)

    rows = []
    for clone_id, model_ids in clone_matches.items():
        excluded_here = excluded_matches.get(clone_id, {})
        for model_id in sorted(set(model_ids) | set(excluded_here)):
            model = models_by_id.get(model_id)
            ic50_by_drug = {
                response.drug: response.value
                for response in drug_responses
                if response.model_id == model_id and response.metric == "IC50"
            }
            rows.append(
                {
                    "clone_id": clone_id,
                    "model_id": model_id,
                    "model_name": model.model_name if model else "",
                    "histology": model.cancer_type if model else "",
                    "canonical_alterations": "|".join(sorted(set(alterations_by_model.get(model_id, [])))),
                    "drugs": "|".join(sorted(set(drugs_by_model.get(model_id, [])))),
                    "n_drug_measurements": len(drugs_by_model.get(model_id, [])),
                    "gefitinib_ic50_nm": ic50_by_drug.get("gefitinib", ""),
                    "erlotinib_ic50_nm": ic50_by_drug.get("erlotinib", ""),
                    "osimertinib_ic50_nm": ic50_by_drug.get("osimertinib", ""),
                    "growth_rate_per_day": model_growth_rates.get(model_id, ""),
                    "used_in_calibration": model_id not in excluded_here,
                    "exclusion_reason": excluded_here.get(model_id, "")
                }
            )
    return rows

