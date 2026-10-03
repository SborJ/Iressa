"""CIViC evidence ingestion."""

from __future__ import annotations

from pathlib import Path

from cancer_sim.calibration.schema import CivicEvidenceRecord, find_value, provenance, read_csv, row_id
from cancer_sim.calibration.targets import canonical_drug


def ingest_civic(path: Path) -> list[CivicEvidenceRecord]:
    evidence: list[CivicEvidenceRecord] = []
    for index, row in enumerate(read_csv(path)):
        record_id = row_id(index, row, ("civic_id", "evidence_id", "id"))
        prov = provenance("CIViC", path, record_id)
        profile = find_value(row, ("molecular_profile", "variant", "alteration", "name"))
        drug = canonical_drug(find_value(row, ("drug", "therapy", "therapies"), ""))
        if not profile:
            continue
        evidence.append(
            CivicEvidenceRecord(
                molecular_profile=profile,
                disease=find_value(row, ("disease", "cancer_type", "phenotype"), ""),
                drug=drug,
                response=find_value(row, ("response", "clinical_significance", "evidence_type"), ""),
                evidence_level=find_value(row, ("evidence_level", "level"), ""),
                evidence_direction=find_value(row, ("evidence_direction", "direction"), ""),
                source_publication=find_value(row, ("source_publication", "citation", "pubmed_id"), ""),
                civic_id=record_id,
                **prov.__dict__
            )
        )
    return evidence
