"""Calibration validation checks."""

from __future__ import annotations


def validate_calibrated_clones(clones: list[dict]) -> list[str]:
    warnings = []
    by_id = {clone["clone_id"]: clone for clone in clones}
    for clone in clones:
        fitness = float(clone["fitness_cost"]["value"])
        if not 0 <= fitness <= 1:
            warnings.append(f"{clone['clone_id']} fitness_cost is outside [0, 1]")
        for drug, response in clone["drug_response"].items():
            if float(response["value"]) <= 0:
                warnings.append(f"{clone['clone_id']} {drug} IC50 must be > 0")
            if response["unit"] != "nM":
                warnings.append(f"{clone['clone_id']} {drug} IC50 unit should be nM")

    if {"EGFR", "T790M"}.issubset(by_id):
        egfr_gefitinib = by_id["EGFR"]["drug_response"]["gefitinib"]["value"]
        t790m_gefitinib = by_id["T790M"]["drug_response"]["gefitinib"]["value"]
        if not egfr_gefitinib < t790m_gefitinib:
            warnings.append("expected EGFR gefitinib IC50 < T790M gefitinib IC50")

    if {"T790M", "C797S"}.issubset(by_id):
        t790m_osi = by_id["T790M"]["drug_response"]["osimertinib"]["value"]
        c797s_osi = by_id["C797S"]["drug_response"]["osimertinib"]["value"]
        if not t790m_osi < c797s_osi:
            warnings.append("expected T790M osimertinib IC50 < C797S osimertinib IC50")

    for clone in clones:
        growth = float(clone["growth_rate_per_day"]["value"])
        if growth <= 0:
            warnings.append(f"{clone['clone_id']} growth_rate_per_day must be > 0")
        kmax = float(clone["max_drug_death_rate_per_day"]["value"])
        if kmax <= 0:
            warnings.append(f"{clone['clone_id']} max_drug_death_rate_per_day must be > 0")
        if clone["growth_rate_per_day"]["status"] == "assumed" and clone["fitness_cost"]["status"] != "assumed":
            warnings.append(f"{clone['clone_id']} assumed growth should carry an assumed fitness cost status")
        if clone["growth_rate_per_day"]["status"] == "measured" and float(clone["fitness_cost"]["value"]) != 0.0:
            warnings.append(f"{clone['clone_id']} measured growth must not also carry a fitness cost (double counting)")

    measured_growth = [
        float(c["growth_rate_per_day"]["value"]) for c in clones if c["growth_rate_per_day"]["status"] == "measured"
    ]
    for clone in clones:
        if clone["growth_rate_per_day"]["status"] == "assumed" and measured_growth:
            value = float(clone["growth_rate_per_day"]["value"])
            if value < 0.25 * min(measured_growth):
                warnings.append(
                    f"{clone['clone_id']} assumed growth {value:.3f}/day is far below measured clones "
                    f"(min {min(measured_growth):.3f}/day): scale mismatch between assumed and measured parameters"
                )

    clone_ids = set(by_id)
    for clone in clones:
        for target in clone["allowed_transitions"]:
            if target not in clone_ids:
                warnings.append(f"{clone['clone_id']} transition target {target} is not a clone")
    return warnings

