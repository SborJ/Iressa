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
    drug_responses: list[DrugResponseRecord]
) -> list[dict[str, str | int]]:
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
        for model_id in sorted(model_ids):
            rows.append(
                {
                    "clone_id": clone_id,
                    "model_id": model_id,
                    "canonical_alterations": "|".join(sorted(set(alterations_by_model.get(model_id, [])))),
                    "drugs": "|".join(sorted(set(drugs_by_model.get(model_id, [])))),
                    "n_drug_measurements": len(drugs_by_model.get(model_id, []))
                }
            )
    return rows

