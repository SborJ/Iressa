#!/usr/bin/env python3
"""Normalize Cell Model Passports downloads for the calibration pipeline."""

from __future__ import annotations

import csv
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.calibration.targets import canonical_alteration


SOURCE_DIR = ROOT / "data" / "raw" / "cell_model_passports" / "current"
OUTPUT = ROOT / "data" / "raw" / "cell_model_passports_mutations.csv"


def main() -> int:
    model_rows = _read_csv(SOURCE_DIR / "model_list.csv")
    mutation_rows = _read_csv(SOURCE_DIR / "mutations_summary.csv")
    cnv_rows = _read_csv(SOURCE_DIR / "cnv_summary.csv")
    growth_rows = _read_csv(SOURCE_DIR / "growth_rate.csv")

    lung_models = {
        row["model_id"]: row
        for row in model_rows
        if _is_lung_model(row)
    }
    growth_by_model = {row["model_id"]: row for row in growth_rows}

    output_rows = []
    for row in mutation_rows:
        if row.get("model_id") not in lung_models or row.get("gene_symbol", "").upper() != "EGFR":
            continue
        canonical = canonical_alteration(
            "EGFR",
            row.get("protein_mutation", ""),
            row.get("cdna_mutation", ""),
            row.get("effect", "")
        )
        if canonical == "EGFR_EXON19DEL" and "del" not in _mutation_text(row).lower():
            continue
        if canonical not in {"EGFR_EXON19DEL", "EGFR_L858R", "EGFR_T790M", "EGFR_C797S"}:
            continue
        output_rows.append(_mutation_output_row(row, lung_models, growth_by_model))

    for row in cnv_rows:
        if row.get("model_id") not in lung_models or row.get("symbol", "").upper() != "MET":
            continue
        category = row.get("cn_category", "").lower()
        if category != "amplification":
            continue
        output_rows.append(_cnv_output_row(row, lung_models, growth_by_model))

    output_rows.sort(key=lambda item: (item["model_id"], item["gene"], item["alteration"]))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    _write_csv(OUTPUT, output_rows)

    versioned_output = SOURCE_DIR / OUTPUT.name
    shutil.copyfile(OUTPUT, versioned_output)
    print(f"Wrote {len(output_rows)} normalized Cell Model Passports rows to {OUTPUT}")
    return 0


def _mutation_output_row(
    row: dict[str, str],
    lung_models: dict[str, dict[str, str]],
    growth_by_model: dict[str, dict[str, str]]
) -> dict[str, str]:
    model = lung_models[row["model_id"]]
    growth = growth_by_model.get(row["model_id"], {})
    return {
        "model_id": row.get("model_id", ""),
        "model_name": row.get("model_name", "") or model.get("model_name", ""),
        "gene": row.get("gene_symbol", ""),
        "alteration": row.get("protein_mutation", "") or row.get("cdna_mutation", ""),
        "protein_change": row.get("protein_mutation", ""),
        "alteration_type": row.get("type", "mutation"),
        "cancer_type": model.get("cancer_type", ""),
        "cancer_type_detail": model.get("cancer_type_detail", ""),
        "tissue": model.get("tissue", ""),
        "cosmic_id": model.get("COSMIC_ID", ""),
        "doubling_time_hours": growth.get("doubling_time_hours", ""),
        "source_dataset": "Cell Model Passports mutations_summary_latest"
    }


def _cnv_output_row(
    row: dict[str, str],
    lung_models: dict[str, dict[str, str]],
    growth_by_model: dict[str, dict[str, str]]
) -> dict[str, str]:
    model = lung_models[row["model_id"]]
    growth = growth_by_model.get(row["model_id"], {})
    return {
        "model_id": row.get("model_id", ""),
        "model_name": row.get("model_name", "") or model.get("model_name", ""),
        "gene": row.get("symbol", ""),
        "alteration": row.get("cn_category", ""),
        "protein_change": "",
        "alteration_type": "amplification",
        "cancer_type": model.get("cancer_type", ""),
        "cancer_type_detail": model.get("cancer_type_detail", ""),
        "tissue": model.get("tissue", ""),
        "cosmic_id": model.get("COSMIC_ID", ""),
        "doubling_time_hours": growth.get("doubling_time_hours", ""),
        "source_dataset": "Cell Model Passports cnv_summary_latest"
    }


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    fieldnames = [
        "model_id",
        "model_name",
        "gene",
        "alteration",
        "protein_change",
        "alteration_type",
        "cancer_type",
        "cancer_type_detail",
        "tissue",
        "cosmic_id",
        "doubling_time_hours",
        "source_dataset"
    ]
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _is_lung_model(row: dict[str, str]) -> bool:
    tissue = row.get("tissue", "").strip().lower()
    if tissue == "lung":
        return True
    text = " ".join(
        row.get(key, "")
        for key in ("cancer_type", "cancer_type_detail")
    ).lower()
    return any(term in text for term in ("lung", "nsclc", "non-small cell"))


def _mutation_text(row: dict[str, str]) -> str:
    return " ".join(
        row.get(key, "")
        for key in ("protein_mutation", "cdna_mutation", "effect", "type")
    )


if __name__ == "__main__":
    raise SystemExit(main())
