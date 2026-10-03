"""cBioPortal alteration-summary ingestion."""

from __future__ import annotations

from pathlib import Path

from cancer_sim.calibration.schema import AlterationRecord, ModelRecord, find_value, provenance, read_csv, row_id


def ingest_cbioportal(path: Path) -> tuple[list[ModelRecord], list[AlterationRecord]]:
    models: dict[str, ModelRecord] = {}
    alterations: list[AlterationRecord] = []
    for index, row in enumerate(read_csv(path)):
        record_id = row_id(index, row, ("sample_id", "patient_id", "id"))
        prov = provenance("cBioPortal", path, record_id)
        model_id = find_value(row, ("sample_id", "patient_id", "model_id"), record_id)
        gene = find_value(row, ("gene", "hugo_symbol", "hugo_gene_symbol"), "").upper()
        if not model_id or not gene:
            continue
        alteration = find_value(row, ("alteration", "protein_change", "mutation", "cna", "copy_number"), "")
        alteration_type = _alteration_type(row, alteration)
        models.setdefault(
            model_id,
            ModelRecord(
                model_id=model_id,
                model_name=model_id,
                cancer_type=find_value(row, ("cancer_type", "study_id", "disease"), ""),
                tissue=find_value(row, ("tissue", "sample_type"), ""),
                **prov.__dict__
            )
        )
        alterations.append(
            AlterationRecord(
                model_id=model_id,
                gene=gene,
                alteration_type=alteration_type,
                alteration=alteration,
                protein_change=find_value(row, ("protein_change", "hgvsp", "mutation"), alteration),
                **prov.__dict__
            )
        )
    return list(models.values()), alterations


def _alteration_type(row: dict[str, str], alteration: str) -> str:
    explicit = find_value(row, ("alteration_type", "type", "event_type"), "")
    if explicit:
        return explicit.lower()
    text = " ".join(str(value) for value in row.values()).upper() + " " + alteration.upper()
    if "AMP" in text or "AMPLIFICATION" in text or "GAIN" in text:
        return "amplification"
    return "mutation"

