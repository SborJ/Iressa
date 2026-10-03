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
from cancer_sim.cancers import CancerModel
from cancer_sim.simulation import CLONES, DRUGS, SimulationRecord, TreatmentAction


EPSILON = 1e-12
# The default (lung) model's action set: no treatment, or one drug at half or full exposure.
DEFAULT_ALLOWED_ACTIONS: tuple[TreatmentAction, ...] = tuple(
    TreatmentAction(drug, dose)
    for drug in DRUGS
    for dose in (0.0, 0.5, 1.0)
    if (drug == "none" and dose == 0.0) or (drug != "none" and dose > 0)
)


def action_grid(spec: Mapping) -> tuple[TreatmentAction, ...]:
    """Every combination of the listed agents at the listed exposure levels, minus
    the combinations the mask forbids: at most one non-zero agent per
    ``exclusive_groups`` entry. No treatment comes first."""
    levels = [float(v) for v in spec["levels"]]
    agents = [str(a) for a in spec["agents"]]
    groups = [set(g) for g in spec.get("exclusive_groups", [])]
    max_agents = spec.get("max_simultaneous_agents")
    actions: list[TreatmentAction] = [TreatmentAction("none", 0.0)]
    seen = {frozenset()}

    def walk(index: int, chosen: dict[str, float]) -> None:
        if index == len(agents):
            active = {k: v for k, v in chosen.items() if v > 0}
            key = frozenset(active.items())
            if not active or key in seen:
                return
            for group in groups:
                if sum(1 for a in active if a in group) > 1:
                    return
            if max_agents is not None and len(active) > int(max_agents):
                return
            seen.add(key)
            actions.append(TreatmentAction.combination(active))
            return
        for level in levels:
            chosen[agents[index]] = level
            walk(index + 1, chosen)
        del chosen[agents[index]]

    walk(0, {})
    return tuple(actions)


def model_actions(model: CancerModel) -> tuple[TreatmentAction, ...]:
    """The represented interventions for a cancer model: its ``rl_action_grid``
    (levels x agents with a mask) or, failing that, its explicit ``rl_actions``."""
    grid = model.raw.get("rl_action_grid")
    if grid:
        return action_grid(grid)
    actions: list[TreatmentAction] = []
    for spec in model.rl_actions:
        if "exposures" in spec:
            actions.append(TreatmentAction.combination(spec["exposures"]))
        else:
            actions.append(TreatmentAction(str(spec.get("drug", "none")), float(spec.get("dose", 0.0))))
    if not actions:
        actions.append(TreatmentAction("none", 0.0))
    return tuple(actions)


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
    clone_ids: Iterable[str] | None = None,
    current_action: TreatmentAction | None = None,
    establishment_base: float | None = None,
) -> TumorControllability:
    """Estimate clone and tumor-level controllability for the current state.

    ``M_i = -min_a lambda_i`` is positive when at least one represented action
    makes clone ``i`` shrink under this simplified net-growth calculation.

    ``escape_distance`` is a shortest-path distance to any clone with ``M_i < 0``
    using ``-log(p_transition)`` edge weights. It is finite only when a modeled
    path to treatment exhaustion exists.

    With ``current_action`` the distance is dynamic, ``D_i(s, a)``: the expected
    divisions of each parent and the establishment chance of each child are taken
    under that treatment, so an escape route shortens under a drug that favours
    the mutant and lengthens under one that does not. Without it the static
    ``establish_probability`` is used (the original behaviour).
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

    clones_in_scope = tuple(clone_ids) if clone_ids is not None else tuple(clone_responses)
    counts = _clone_counts(record, initial_burden, clones_in_scope)
    burden = sum(counts.values()) if record is None else record.burden
    proliferative_fraction = _proliferative_fraction(record, burden)

    preliminary = {}
    for clone_id in clones_in_scope:
        response = clone_responses[clone_id]
        effective_growth = response.growth_rate * response.effective_fitness_multiplier * proliferative_fraction
        best_action, best_lambda = _best_action(
            response=response,
            effective_growth=response.growth_rate * proliferative_fraction,
            actions=actions,
            vessel_concentration_nm=concentrations,
            reference=clone_responses[clones_in_scope[0]],
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
        current_action=current_action,
        clone_responses=clone_responses,
        vessel_concentration_nm=concentrations,
        proliferative_fraction=proliferative_fraction,
        establishment_base=establishment_base,
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
    # The shortest route from a present, still-controllable clone to exhaustion.
    # Exhausted clones that are already present have distance 0 by definition;
    # their presence is charged through exhausted_fraction and the minimum
    # margin, not here, otherwise the index would jump to exactly 0 the moment
    # one such cell appears when no other clone has a mapped route.
    finite_distances = [
        item.escape_distance for item in present
        if isfinite(item.escape_distance) and item.escape_distance > 0
    ]
    minimum_escape = min(finite_distances) if finite_distances else float("inf")
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


def _drug_effect(response: ClonePhenotype, drug: str, concentration: float) -> float:
    if concentration <= 0:
        return 0.0
    hill = response.hill(drug)
    numerator = concentration ** hill
    return numerator / (response.ic50(drug) ** hill + numerator)


def treatment_kill_rate(
    response: ClonePhenotype,
    action: TreatmentAction,
    *,
    vessel_concentration_nm: Mapping[str, float],
) -> float:
    """Summed kill hazard (1/day) of every agent in ``action`` at full exposure."""
    total = 0.0
    for drug, dose in action.exposures.items():
        concentration = dose * vessel_concentration_nm.get(drug, 1.0)
        total += response.max_death_rate(drug) * _drug_effect(response, drug, concentration)
    return total


def treatment_growth_factor(
    response: ClonePhenotype,
    action: TreatmentAction,
    *,
    vessel_concentration_nm: Mapping[str, float],
) -> float:
    """Fraction of the division rate left under the cytostatic agents in ``action`` (1.0 for cytotoxic-only drugs)."""
    factor = 1.0
    for drug, dose in action.exposures.items():
        inhibition = response.growth_inhibition(drug)
        if inhibition <= 0:
            continue
        concentration = dose * vessel_concentration_nm.get(drug, 1.0)
        factor *= 1.0 - inhibition * _drug_effect(response, drug, concentration)
    return factor


def treatment_fitness_multiplier(
    response: ClonePhenotype,
    action: TreatmentAction,
    *,
    vessel_concentration_nm: Mapping[str, float],
    reference: ClonePhenotype | None = None,
) -> float:
    """1 - fitness cost, with the cost relieved by agents that shift the environment
    (measured on ``reference``, the founding sensitive clone) while leaving this clone alone."""
    if not response.drug_fitness_cost_relief:
        return response.effective_fitness_multiplier
    reference = reference or response
    remaining = 1.0
    for drug, dose in action.exposures.items():
        relief = response.fitness_cost_relief(drug)
        if relief <= 0:
            continue
        concentration = dose * vessel_concentration_nm.get(drug, 1.0)
        remaining *= 1.0 - relief * _drug_effect(reference, drug, concentration)
    return max(0.0, 1.0 - response.fitness_cost * remaining)


def net_growth_rate(
    response: ClonePhenotype,
    action: TreatmentAction,
    *,
    base_growth: float,
    vessel_concentration_nm: Mapping[str, float],
    reference: ClonePhenotype | None = None,
) -> float:
    """lambda_i(s, a): division rate under the action minus its kill hazard."""
    growth = base_growth * treatment_fitness_multiplier(response, action, vessel_concentration_nm=vessel_concentration_nm, reference=reference)
    growth *= treatment_growth_factor(response, action, vessel_concentration_nm=vessel_concentration_nm)
    return growth - treatment_kill_rate(response, action, vessel_concentration_nm=vessel_concentration_nm)


def _best_action(
    *,
    response: ClonePhenotype,
    effective_growth: float,
    actions: tuple[TreatmentAction, ...],
    vessel_concentration_nm: Mapping[str, float],
    reference: ClonePhenotype | None = None,
) -> tuple[TreatmentAction, float]:
    best_action = actions[0]
    best_lambda = float("inf")
    for action in actions:
        net = net_growth_rate(response, action, base_growth=effective_growth, vessel_concentration_nm=vessel_concentration_nm, reference=reference)
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
    current_action: TreatmentAction | None = None,
    clone_responses: Mapping[str, ClonePhenotype] | None = None,
    vessel_concentration_nm: Mapping[str, float] | None = None,
    proliferative_fraction: float = 1.0,
    establishment_base: float | None = None,
) -> dict[str, float]:
    exhausted = {clone_id for clone_id, item in preliminary.items() if item.treatment_exhausted}
    if not exhausted:
        return {clone_id: float("inf") for clone_id in preliminary}

    # Division rates under the current treatment, when one is given: the
    # selective environment that decides how fast each escape route is travelled.
    growth_under_action: dict[str, float] | None = None
    if current_action is not None and clone_responses is not None and vessel_concentration_nm is not None:
        growth_under_action = {}
        reference = clone_responses[next(iter(preliminary))]
        for clone_id in preliminary:
            response = clone_responses[clone_id]
            rate = response.growth_rate * proliferative_fraction
            rate *= treatment_fitness_multiplier(response, current_action, vessel_concentration_nm=vessel_concentration_nm, reference=reference)
            rate *= treatment_growth_factor(response, current_action, vessel_concentration_nm=vessel_concentration_nm)
            growth_under_action[clone_id] = max(0.0, rate)

    distances: dict[str, float] = {}
    for clone_id in preliminary:
        distances[clone_id] = _shortest_exhaustion_path(
            start=clone_id,
            exhausted=exhausted,
            preliminary=preliminary,
            transitions=transitions,
            horizon_days=horizon_days,
            establish_probability=establish_probability,
            growth_under_action=growth_under_action,
            establishment_base=establishment_base,
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
    growth_under_action: Mapping[str, float] | None = None,
    establishment_base: float | None = None,
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
        parent_growth = (
            growth_under_action[clone_id] if growth_under_action is not None else max(parent.effective_growth_rate, 0.0)
        )
        expected_divisions = max(1.0, parent.count * parent_growth * horizon_days)
        for transition in transitions.get(clone_id, []):
            child = transition.child_clone
            if child not in preliminary or child in seen:
                continue
            if growth_under_action is not None:
                # the same establishment rule the automata applies: base * child/parent fitness
                base = establish_probability if establishment_base is None else establishment_base
                child_growth = growth_under_action[child]
                establish = 1.0 if parent_growth <= 0 and child_growth > 0 else (
                    base if parent_growth <= 0 else min(1.0, base * child_growth / parent_growth)
                )
            else:
                establish = establish_probability
            probability = transition.simulation_probability * expected_divisions * establish
            weight = -log(min(1.0, max(0.0, probability)) + EPSILON)
            heappush(heap, (distance + weight, child))
    return float("inf")


def _clone_counts(record: SimulationRecord | None, initial_burden: int, clone_ids: tuple[str, ...]) -> dict[str, int]:
    if record is None:
        # Before the first step everything is the founding (first) clone.
        return {clone_id: (initial_burden if index == 0 else 0) for index, clone_id in enumerate(clone_ids)}
    return {clone_id: record.count(clone_id) for clone_id in clone_ids}


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
