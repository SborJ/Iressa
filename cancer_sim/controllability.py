"""Evolutionary controllability metrics for treatment-policy experiments.

These metrics are deliberately model-scoped. They estimate whether the current
simulator's represented interventions can suppress each clone, and how close
the represented resistance graph is to a treatment-exhausted state. They are not
clinical curability claims.
"""

from __future__ import annotations

from dataclasses import dataclass
from heapq import heappop, heappush
from math import exp, isfinite, log
from typing import Iterable, Mapping

from cancer_sim.automata import ClonePhenotype, ResistanceTransition
from cancer_sim.simulation import CLONES, DRUGS, SimulationRecord, TreatmentAction


EPSILON = 1e-12
DEFAULT_ALLOWED_ACTIONS: tuple[TreatmentAction, ...] = tuple(
    TreatmentAction(drug, dose)
    for drug in DRUGS
    for dose in (0.0, 0.5, 1.0)
    if (drug == "none" and dose == 0.0) or (drug != "none" and dose > 0)
)


@dataclass(frozen=True)
class CloneControllability:
    clone_id: str
    count: int
    effective_growth_rate: float
    best_action: TreatmentAction
    best_net_growth_rate: float
    margin: float
    treatment_exhausted: bool
    escape_distance: float


@dataclass(frozen=True)
class TumorControllability:
    burden: int
    burden_fraction: float
    safe_burden_fraction: float
    eci: float
    exhausted_fraction: float
    minimum_margin: float
    mean_margin: float
    minimum_escape_distance: float
    clones: dict[str, CloneControllability]

    def margin(self, clone_id: str) -> float:
        return self.clones[clone_id].margin

    def escape_distance(self, clone_id: str) -> float:
        return self.clones[clone_id].escape_distance


def evaluate_tumor_controllability(
    *,
    record: SimulationRecord | None,
    initial_burden: int,
    clone_responses: Mapping[str, ClonePhenotype],
    transitions: Mapping[str, list[ResistanceTransition]],
    allowed_actions: Iterable[TreatmentAction] = DEFAULT_ALLOWED_ACTIONS,
    progression_multiplier: float = 1.2,
    horizon_days: float = 30.0,
    establish_probability: float = 0.1,
    vessel_concentration_nm: Mapping[str, float] | None = None,
) -> TumorControllability:
    """Estimate clone and tumor-level controllability for the current state.

    ``M_i = -min_a lambda_i`` is positive when at least one represented action
    makes clone ``i`` shrink under this simplified net-growth calculation.

    ``escape_distance`` is a shortest-path distance to any clone with ``M_i < 0``
    using ``-log(p_transition)`` edge weights. It is finite only when a modeled
    path to treatment exhaustion exists.
    """

    if initial_burden <= 0:
        raise ValueError("initial_burden must be positive")
    if progression_multiplier <= 0:
        raise ValueError("progression_multiplier must be positive")
    if horizon_days <= 0:
        raise ValueError("horizon_days must be positive")

    actions = tuple(allowed_actions)
    if not actions:
        raise ValueError("allowed_actions must not be empty")

    concentrations = {
        "gefitinib": 1000.0,
        "osimertinib": 1000.0,
        "capmatinib": 1000.0,
    }
    if vessel_concentration_nm is not None:
        concentrations.update(vessel_concentration_nm)

    counts = _clone_counts(record, initial_burden)
    burden = sum(counts.values()) if record is None else record.burden
    proliferative_fraction = _proliferative_fraction(record, burden)

    preliminary = {}
    for clone_id in CLONES:
        response = clone_responses[clone_id]
        effective_growth = response.growth_rate * response.effective_fitness_multiplier * proliferative_fraction
        best_action, best_lambda = _best_action(
            response=response,
            effective_growth=effective_growth,
            actions=actions,
            vessel_concentration_nm=concentrations,
        )
        margin = -best_lambda
        preliminary[clone_id] = CloneControllability(
            clone_id=clone_id,
            count=counts.get(clone_id, 0),
            effective_growth_rate=effective_growth,
            best_action=best_action,
            best_net_growth_rate=best_lambda,
            margin=margin,
            treatment_exhausted=margin < 0,
            escape_distance=0.0,
        )

    distances = _escape_distances(
        preliminary=preliminary,
        transitions=transitions,
        horizon_days=horizon_days,
        establish_probability=establish_probability,
    )
    clones = {
        clone_id: CloneControllability(
            clone_id=item.clone_id,
            count=item.count,
            effective_growth_rate=item.effective_growth_rate,
            best_action=item.best_action,
            best_net_growth_rate=item.best_net_growth_rate,
            margin=item.margin,
            treatment_exhausted=item.treatment_exhausted,
            escape_distance=distances[clone_id],
        )
        for clone_id, item in preliminary.items()
    }

    burden_fraction = burden / max(initial_burden, 1)
    safe_burden_fraction = min(1.0, burden / max(initial_burden * progression_multiplier, 1.0))
    living = max(burden, 1)
    exhausted_fraction = sum(item.count for item in clones.values() if item.treatment_exhausted) / living
    present = [item for item in clones.values() if item.count > 0]
    margins = [item.margin for item in present] or [0.0]
    finite_distances = [
        item.escape_distance for item in present
        if isfinite(item.escape_distance) and item.escape_distance > 0
    ]
    minimum_escape = min(finite_distances) if finite_distances else (
        0.0 if any(item.treatment_exhausted and item.count > 0 for item in clones.values()) else float("inf")
    )
    eci = _eci_proxy(
        safe_burden_fraction=safe_burden_fraction,
        exhausted_fraction=exhausted_fraction,
        margins=margins,
        minimum_escape_distance=minimum_escape,
    )
    return TumorControllability(
        burden=burden,
        burden_fraction=burden_fraction,
        safe_burden_fraction=safe_burden_fraction,
        eci=eci,
        exhausted_fraction=exhausted_fraction,
        minimum_margin=min(margins),
        mean_margin=sum(margins) / len(margins),
        minimum_escape_distance=minimum_escape,
        clones=clones,
    )


def treatment_kill_rate(
    response: ClonePhenotype,
    action: TreatmentAction,
    *,
    vessel_concentration_nm: Mapping[str, float],
) -> float:
    if action.drug == "none" or action.dose <= 0:
        return 0.0
    concentration = action.dose * vessel_concentration_nm[action.drug]
    if concentration <= 0:
        return 0.0
    hill = response.hill_coefficient
    numerator = concentration ** hill
    effect = numerator / (response.ic50(action.drug) ** hill + numerator)
    return response.max_drug_death_rate * effect


def _best_action(
    *,
    response: ClonePhenotype,
    effective_growth: float,
    actions: tuple[TreatmentAction, ...],
    vessel_concentration_nm: Mapping[str, float],
) -> tuple[TreatmentAction, float]:
    best_action = actions[0]
    best_lambda = float("inf")
    for action in actions:
        kill = treatment_kill_rate(
            response,
            action,
            vessel_concentration_nm=vessel_concentration_nm,
        )
        net = effective_growth - kill
        if net < best_lambda:
            best_action = action
            best_lambda = net
    return best_action, best_lambda


def _escape_distances(
    *,
    preliminary: Mapping[str, CloneControllability],
    transitions: Mapping[str, list[ResistanceTransition]],
    horizon_days: float,
    establish_probability: float,
) -> dict[str, float]:
    exhausted = {clone_id for clone_id, item in preliminary.items() if item.treatment_exhausted}
    if not exhausted:
        return {clone_id: float("inf") for clone_id in preliminary}

    distances: dict[str, float] = {}
    for clone_id in preliminary:
        distances[clone_id] = _shortest_exhaustion_path(
            start=clone_id,
            exhausted=exhausted,
            preliminary=preliminary,
            transitions=transitions,
            horizon_days=horizon_days,
            establish_probability=establish_probability,
        )
    return distances


def _shortest_exhaustion_path(
    *,
    start: str,
    exhausted: set[str],
    preliminary: Mapping[str, CloneControllability],
    transitions: Mapping[str, list[ResistanceTransition]],
    horizon_days: float,
    establish_probability: float,
) -> float:
    if start in exhausted:
        return 0.0
    seen: set[str] = set()
    heap: list[tuple[float, str]] = [(0.0, start)]
    while heap:
        distance, clone_id = heappop(heap)
        if clone_id in seen:
            continue
        seen.add(clone_id)
        if clone_id in exhausted:
            return distance
        parent = preliminary[clone_id]
        expected_divisions = max(1.0, parent.count * max(parent.effective_growth_rate, 0.0) * horizon_days)
        for transition in transitions.get(clone_id, []):
            child = transition.child_clone
            if child not in preliminary or child in seen:
                continue
            probability = (
                transition.simulation_probability
                * expected_divisions
                * establish_probability
            )
            weight = -log(min(1.0, max(0.0, probability)) + EPSILON)
            heappush(heap, (distance + weight, child))
    return float("inf")


def _clone_counts(record: SimulationRecord | None, initial_burden: int) -> dict[str, int]:
    if record is None:
        return {"EGFR": initial_burden, "T790M": 0, "C797S": 0, "MET_AMP": 0}
    return {
        "EGFR": record.egfr,
        "T790M": record.t790m,
        "C797S": record.c797s,
        "MET_AMP": record.met_amp,
    }


def _proliferative_fraction(record: SimulationRecord | None, burden: int) -> float:
    if record is None:
        return 1.0
    if burden <= 0:
        return 0.0
    return min(1.0, max(0.0, record.proliferating / burden))


def _eci_proxy(
    *,
    safe_burden_fraction: float,
    exhausted_fraction: float,
    margins: list[float],
    minimum_escape_distance: float,
) -> float:
    burden_component = max(0.0, 1.0 - safe_burden_fraction)
    exhaustion_component = max(0.0, 1.0 - exhausted_fraction)
    margin_component = 1.0 / (1.0 + exp(-4.0 * min(margins)))
    if not isfinite(minimum_escape_distance):
        escape_component = 1.0
    else:
        escape_component = 1.0 - exp(-max(0.0, minimum_escape_distance) / 10.0)
    return max(0.0, min(1.0, burden_component * exhaustion_component * margin_component * escape_component))
