"""GDSC-style drug response ingestion."""

from __future__ import annotations

from pathlib import Path
from math import exp

from cancer_sim.calibration.schema import (
    DrugResponseRecord,
    ModelRecord,
    find_value,
    parse_float,
    provenance,
    read_csv,
    row_id
)
from cancer_sim.calibration.targets import canonical_drug, is_target_drug


def ingest_gdsc(path: Path) -> tuple[list[ModelRecord], list[DrugResponseRecord]]:
    models: dict[str, ModelRecord] = {}
    responses: list[DrugResponseRecord] = []
    file_provenance = provenance("GDSC", path, "file")
    for index, row in enumerate(read_csv(path)):
        record_id = row_id(index, row)
        prov_data = {
            **file_provenance.__dict__,
            "source_record_id": record_id
        }
        model_id = find_value(row, ("model_id", "sanger_model_id", "cell_line_id", "cosmic_id", "sample_id", "cell_line_name"))
        model_name = find_value(row, ("model_name", "cell_line_name", "cell_line", "sample_name"), model_id)
        drug = canonical_drug(find_value(row, ("drug", "drug_name", "compound", "compound_name")))
        value, metric, unit = _response_value(row)
        if not model_id or not drug or value is None or not is_target_drug(drug):
            continue

        models.setdefault(
            model_id,
            ModelRecord(
                model_id=model_id,
                model_name=model_name,
                cancer_type=find_value(row, ("cancer_type", "tcga_classification", "tcga_desc", "disease"), ""),
                tissue=find_value(row, ("tissue", "tissue_type", "tissue_descriptor"), ""),
                **prov_data
            )
        )
        responses.append(
            DrugResponseRecord(
                model_id=model_id,
                drug=drug,
                metric=metric,
                value=value,
                unit=unit,
                **prov_data
            )
        )
    return list(models.values()), responses


def _response_value(row: dict[str, str]) -> tuple[float | None, str, str]:
    ic50_nm = parse_float(find_value(row, ("ic50_nm",)))
    if ic50_nm is not None:
        return ic50_nm, "IC50", "nM"

    ln_ic50 = parse_float(find_value(row, ("ln_ic50",)))
    if ln_ic50 is not None:
        # GDSC fitted-response releases report LN_IC50 as natural log IC50 in uM.
        return exp(ln_ic50) * 1000.0, "IC50", "nM"

    ic50 = parse_float(find_value(row, ("ic50",)))
    if ic50 is not None:
        return ic50, "IC50", "nM"

    auc = parse_float(find_value(row, ("auc",)))
    if auc is not None:
        return auc, "AUC", "unitless"
    return None, "unknown", "unknown"
