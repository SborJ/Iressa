"""Canonical biological targets for the calibration milestone."""

from __future__ import annotations

import re


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

# EGFR exon 19 spans codons 729-761 (Ensembl ENST00000275493). The classical
# activating in-frame deletions cluster on the LREA motif at codons 745-753
# (E746_A750del, L747_P753delinsS, L747_E749del, E746_S752delinsV, ...).
# Reference: Kobayashi & Mitsudomi 2016, Cancer Sci 107:1179 (review of EGFR
# exon 19 deletion variants); Yang et al. 2015 Lancet Oncol 16:830 (LUX-Lung 3/6
# subgroup by deletion type).
_EXON19_DEL_CODON = re.compile(r"[A-Z](74[5-9]|75[0-3])(?!\d)")


def canonical_drug(value: str) -> str:
    text = value.strip().lower()
    aliases = {
        "iressa": "gefitinib",
        "tarceva": "erlotinib",
        "tagrisso": "osimertinib",
        "tabrecta": "capmatinib"
    }
    return aliases.get(text, text)


def is_exon19_deletion(text: str) -> bool:
    """True for an EGFR exon 19 in-frame deletion / deletion-insertion.

    Accepts explicit labels (``exon19 del``, ``del19``, ``exon 19 deletion``) and
    HGVS protein changes whose deleted range touches codons 745-753 and whose
    description contains ``del`` (``p.E746_A750delELREA``, ``p.L747_P753delinsS``).
    Point substitutions at those codons (``p.E746K``) are not deletions.
    """
    upper = text.upper()
    if "EXON19" in upper or "EXON 19" in upper or "DEL19" in upper:
        return True
    if "DEL" not in upper:
        return False
    return bool(_EXON19_DEL_CODON.search(upper))


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
    if is_exon19_deletion(text):
        return "EGFR_EXON19DEL"
    if gene_text == "EGFR":
        return "EGFR_EXON19DEL_OR_L858R"
    return text.strip()


def is_lung_context(*values: str) -> bool:
    text = " ".join(values).lower()
    return any(term in text for term in TARGET_DISEASE_TERMS)


def is_target_drug(value: str) -> bool:
    return canonical_drug(value) in TARGET_DRUGS
