"""Plain-language labels for treatment decisions.

A day's exposures compared with the day before, in words a non-specialist can
follow ("switched the endocrine drug to elacestrant", "treatment holiday",
"raised palbociclib to 100%"). The labels describe what the simulator policy
or strategy did; they are never clinical advice, and the vocabulary follows the
project's: resistant share, controllable, exhausted.
"""

from __future__ import annotations

from typing import Mapping

from cancer_sim.cancers import CancerModel

# How agents are grouped for the "switched X" wording: the model's drug mechanism.
ENDOCRINE_MECHANISMS = {"estrogen_deprivation", "estrogen_receptor_degrader"}


def _short(model: CancerModel, drug: str) -> str:
    """'Palbociclib (CDK4/6 inhibitor)' -> 'palbociclib'; 'Endocrine suppression (aromatase inhibitor)' -> 'endocrine suppression'."""
    label = model.drug(drug).label if model.has_drug(drug) else drug
    label = label.split("(")[0].strip()
    return label[:1].lower() + label[1:] if label else drug


def _pct(value: float) -> str:
    return f"{round(value * 100):d}%"


def _group(model: CancerModel, drug: str) -> str:
    mech = model.drug(drug).mechanism if model.has_drug(drug) else ""
    return "endocrine" if mech in ENDOCRINE_MECHANISMS else mech or drug


def describe_decision(
    model: CancerModel,
    previous: Mapping[str, float] | None,
    current: Mapping[str, float],
    *,
    resistant_fraction: float | None = None,
    day: float | None = None,
    actor: str = "",
) -> str:
    """One sentence for what changed between two days of treatment."""
    prev = {k: v for k, v in (previous or {}).items() if v > 0}
    now = {k: v for k, v in current.items() if v > 0}
    prefix = f"{actor}: " if actor else ""
    context = f" (resistant share {_pct(resistant_fraction)})" if resistant_fraction is not None and resistant_fraction >= 0.005 else ""

    if not now and not prev:
        return prefix + ("no treatment" if previous is None else "still untreated")
    if not now:
        return prefix + "treatment holiday: all agents stopped" + context
    if previous is None or not prev:
        agents = " + ".join(f"{_short(model, d)} {_pct(x)}" for d, x in now.items())
        verb = "started" if previous is not None else "starting"
        return prefix + f"{verb} {agents}" + context

    started = [d for d in now if d not in prev]
    stopped = [d for d in prev if d not in now]
    changed = [d for d in now if d in prev and abs(now[d] - prev[d]) > 1e-9]

    # a switch within one mechanism group: stop one endocrine agent, start another
    for s in list(stopped):
        for t in list(started):
            if _group(model, s) == _group(model, t):
                started.remove(t)
                stopped.remove(s)
                kept = [d for d in now if d not in (t,)]
                kept_text = f", kept {' + '.join(_short(model, d) for d in kept)}" if kept else ""
                return prefix + f"switched the {_group(model, s)} drug from {_short(model, s)} to {_short(model, t)} {_pct(now[t])}{kept_text}" + context

    parts = []
    if started:
        parts.append("added " + " + ".join(f"{_short(model, d)} {_pct(now[d])}" for d in started))
    if stopped:
        parts.append("stopped " + " + ".join(_short(model, d) for d in stopped))
    for d in changed:
        direction = "raised" if now[d] > prev[d] else "lowered"
        parts.append(f"{direction} {_short(model, d)} to {_pct(now[d])}")
    if not parts:
        return prefix + "held " + " + ".join(f"{_short(model, d)} {_pct(x)}" for d, x in now.items())
    return prefix + "; ".join(parts) + context


def describe_exposures(model: CancerModel, exposures: Mapping[str, float]) -> str:
    active = {k: v for k, v in exposures.items() if v > 0}
    if not active:
        return "no treatment"
    return " + ".join(f"{_short(model, d)} {_pct(x)}" for d, x in active.items())
