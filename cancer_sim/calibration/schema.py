"""Shared calibration schemas and CSV helpers."""

from __future__ import annotations

import csv
import hashlib
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any, Iterable


RAW_DIR = Path(__file__).resolve().parents[2] / "data" / "raw"
PROCESSED_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"
CURATED_SEED = Path(__file__).resolve().parents[2] / "data" / "curated" / "egfr_resistance_seed.json"
PHYSICS_CONFIG = Path(__file__).resolve().parents[2] / "data" / "config" / "physics_calibration.json"


@dataclass(frozen=True)
class Provenance:
    source: str
    source_version: str
    source_file: str
    source_record_id: str
    download_date: str
    file_sha256: str


@dataclass(frozen=True)
class ModelRecord:
    model_id: str
    model_name: str
    cancer_type: str
    tissue: str
    source: str
    source_version: str
    source_file: str
    source_record_id: str
    download_date: str
    file_sha256: str


@dataclass(frozen=True)
class AlterationRecord:
    model_id: str
    gene: str
    alteration_type: str
    alteration: str
    protein_change: str
    source: str
    source_version: str
    source_file: str
    source_record_id: str
    download_date: str
    file_sha256: str


@dataclass(frozen=True)
class DrugResponseRecord:
    model_id: str
    drug: str
    metric: str
    value: float
    unit: str
    source: str
    source_version: str
    source_file: str
    source_record_id: str
    download_date: str
    file_sha256: str


@dataclass(frozen=True)
class CivicEvidenceRecord:
    molecular_profile: str
    disease: str
    drug: str
    response: str
    evidence_level: str
    evidence_direction: str
    source_publication: str
    civic_id: str
    source: str
    source_version: str
    source_file: str
    source_record_id: str
    download_date: str
    file_sha256: str


def file_sha256(path: Path) -> str:
    if not path.exists():
        return ""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def provenance(source: str, path: Path, record_id: str, version: str = "unknown") -> Provenance:
    return Provenance(
        source=source,
        source_version=version,
        source_file=str(path),
        source_record_id=record_id,
        download_date=date.today().isoformat(),
        file_sha256=file_sha256(path)
    )


def read_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def write_csv(path: Path, rows: Iterable[Any]) -> None:
    row_dicts = [asdict(row) if hasattr(row, "__dataclass_fields__") else dict(row) for row in rows]
    path.parent.mkdir(parents=True, exist_ok=True)
    if not row_dicts:
        path.write_text("")
        return
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(row_dicts[0]))
        writer.writeheader()
        writer.writerows(row_dicts)


def normalize_key(value: str) -> str:
    return value.strip().lower().replace(" ", "_").replace("-", "_").replace(".", "_")


def find_value(row: dict[str, str], candidates: tuple[str, ...], default: str = "") -> str:
    normalized = {normalize_key(key): key for key in row}
    for candidate in candidates:
        key = normalized.get(candidate)
        if key is not None:
            return str(row.get(key, "")).strip()
    return default


def parse_float(value: str) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def row_id(index: int, row: dict[str, str], candidates: tuple[str, ...] = ("id", "model_id", "sample_id")) -> str:
    return find_value(row, candidates, default=str(index + 1)) or str(index + 1)

