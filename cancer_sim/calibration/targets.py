"""Canonical biological targets for the calibration milestone."""

from __future__ import annotations


TARGET_DISEASE_TERMS = (
    "lung",
    "luad",
    "nsclc",
    "adenocarcinoma"
)

TARGET_GENES = ("EGFR", "MET")

TARGET_ALTERATIONS = (
    "EGFR_EXON19DEL_OR_L858R",
    "EGFR_L858R",
    "EGFR_EXON19DEL",
    "EGFR_T790M",
    "EGFR_C797S",
    "MET_AMP"
)

TARGET_DRUGS = ("gefitinib", "erlotinib", "osimertinib", "capmatinib")


def canonical_drug(value: str) -> str:
    text = value.strip().lower()
    aliases = {
        "iressa": "gefitinib",
        "tarceva": "erlotinib",
        "tagrisso": "osimertinib"
    }
    return aliases.get(text, text)


def canonical_alteration(gene: str, *values: str) -> str:
    gene_text = gene.upper()
    text = " ".join(values).upper()
    if gene_text == "MET" and any(term in text for term in ("AMP", "AMPLIFICATION", "GAIN")):
        return "MET_AMP"
    if "T790M" in text:
        return "EGFR_T790M"
    if "C797S" in text:
        return "EGFR_C797S"
    if "L858R" in text:
        return "EGFR_L858R"
    if "EXON19" in text or "EXON 19" in text or "DEL19" in text or "E746" in text:
        return "EGFR_EXON19DEL"
    if gene_text == "EGFR":
        return "EGFR_EXON19DEL_OR_L858R"
    return text.strip()


def is_lung_context(*values: str) -> bool:
    text = " ".join(values).lower()
    return any(term in text for term in TARGET_DISEASE_TERMS)


def is_target_drug(value: str) -> bool:
    return canonical_drug(value) in TARGET_DRUGS

