"""Cell Model Passports mutation/copy-number ingestion."""

from __future__ import annotations

from pathlib import Path

from cancer_sim.calibration.schema import AlterationRecord, ModelRecord, find_value, provenance, read_csv, row_id


def ingest_passports(path: Path) -> tuple[list[ModelRecord], list[AlterationRecord]]:
    models: dict[str, ModelRecord] = {}
    alterations: list[AlterationRecord] = []
    for index, row in enumerate(read_csv(path)):
        record_id = row_id(index, row)
        prov = provenance("Cell Model Passports", path, record_id)
        model_id = find_value(row, ("model_id", "cell_line_id", "model_name", "sample_id", "cell_line_name"))
        model_name = find_value(row, ("model_name", "cell_line_name", "cell_line", "sample_name"), model_id)
        gene = find_value(row, ("gene", "hugo_symbol", "symbol")).upper()
        if not model_id or not gene:
            continue
        alteration = find_value(row, ("alteration", "mutation", "variant", "protein_change", "cna"), "")
        protein_change = find_value(row, ("protein_change", "aa_change", "hgvsp", "mutation"), alteration)
        alteration_type = _alteration_type(row, alteration)

        models.setdefault(
            model_id,
            ModelRecord(
                model_id=model_id,
                model_name=model_name,
                cancer_type=find_value(row, ("cancer_type", "disease", "tcga_classification"), ""),
                tissue=find_value(row, ("tissue", "tissue_type"), ""),
                **prov.__dict__
            )
        )
        alterations.append(
            AlterationRecord(
                model_id=model_id,
                gene=gene,
                alteration_type=alteration_type,
                alteration=alteration or protein_change,
                protein_change=protein_change,
                **prov.__dict__
            )
        )
    return list(models.values()), alterations


def _alteration_type(row: dict[str, str], alteration: str) -> str:
    explicit = find_value(row, ("alteration_type", "variant_type", "type"), "")
    if explicit:
        return explicit.lower()
    text = " ".join(str(value) for value in row.values()).upper() + " " + alteration.upper()
    if "AMP" in text or "AMPLIFICATION" in text or "GAIN" in text:
        return "amplification"
    return "mutation"

