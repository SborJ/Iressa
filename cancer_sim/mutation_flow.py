"""Seeded mutation-flow generation for allowed resistance transitions.

This is a lineage generator, not a tumor population simulator. It samples a
branching mutation path from the curated resistance graph and does not model
cell counts, treatment, spatial growth, or time.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


DEFAULT_SEED_DATA = (
    Path(__file__).resolve().parents[1] / "data" / "curated" / "egfr_resistance_seed.json"
)


@dataclass(frozen=True)
class MutationTransition:
    parent_clone: str
    child_clone: str
    alteration: str
    relationship: str
    evidence_source: str
    simulation_probability: float


@dataclass
class MutationNode:
    clone_id: str
    alteration: str | None = None
    probability: float | None = None
    children: list["MutationNode"] = field(default_factory=list)


class MutationFlowGenerator:
    """Generate deterministic mutation-flow trees from a random seed."""

    def __init__(
        self,
        transitions: list[MutationTransition],
        *,
        branch_chance: float = 0.75
    ) -> None:
        if not 0 <= branch_chance <= 1:
            raise ValueError("branch_chance must be between 0 and 1")
        self.branch_chance = branch_chance
        self._by_parent = self._index_transitions(transitions)

    @classmethod
    def from_seed_data(
        cls,
        path: Path = DEFAULT_SEED_DATA,
        *,
        branch_chance: float = 0.75
    ) -> "MutationFlowGenerator":
        with path.open() as handle:
            data = json.load(handle)
        transitions = [
            MutationTransition(
                parent_clone=row["parent_clone"],
                child_clone=row["child_clone"],
                alteration=row["alteration"],
                relationship=row["relationship"],
                evidence_source=row["evidence_source"],
                simulation_probability=float(row["simulation_probability"])
            )
            for row in data["resistance_evidence"]
        ]
        return cls(transitions, branch_chance=branch_chance)

    def generate(
        self,
        *,
        seed: int,
        root_clone: str = "EGFR",
        max_depth: int = 3,
        max_children_per_node: int = 2
    ) -> MutationNode:
        if max_depth < 0:
            raise ValueError("max_depth must be non-negative")
        if max_children_per_node <= 0:
            raise ValueError("max_children_per_node must be positive")

        rng = random.Random(seed)
        root = MutationNode(root_clone)
        self._expand(root, rng, depth=0, max_depth=max_depth, max_children=max_children_per_node)
        return root

    def render_tree(self, root: MutationNode) -> str:
        lines = [root.clone_id]
        for index, child in enumerate(root.children):
            last = index == len(root.children) - 1
            self._render_child(child, prefix="", last=last, lines=lines)
        return "\n".join(lines)

    def _expand(
        self,
        node: MutationNode,
        rng: random.Random,
        *,
        depth: int,
        max_depth: int,
        max_children: int
    ) -> None:
        if depth >= max_depth:
            return

        candidates = self._by_parent.get(node.clone_id, [])
        if not candidates:
            return

        shuffled = candidates[:]
        rng.shuffle(shuffled)
        chosen = []
        for transition in shuffled:
            if len(chosen) >= max_children:
                break
            if rng.random() <= self.branch_chance:
                chosen.append(transition)

        if not chosen:
            chosen.append(self._weighted_choice(candidates, rng))

        for transition in chosen:
            child = MutationNode(
                clone_id=transition.child_clone,
                alteration=transition.alteration,
                probability=transition.simulation_probability
            )
            node.children.append(child)
            self._expand(
                child,
                rng,
                depth=depth + 1,
                max_depth=max_depth,
                max_children=max_children
            )

    def _weighted_choice(
        self,
        transitions: list[MutationTransition],
        rng: random.Random
    ) -> MutationTransition:
        weights = [max(transition.simulation_probability, 0.0) for transition in transitions]
        total = sum(weights)
        if total <= 0:
            return rng.choice(transitions)

        threshold = rng.random() * total
        cumulative = 0.0
        for transition, weight in zip(transitions, weights):
            cumulative += weight
            if cumulative >= threshold:
                return transition
        return transitions[-1]

    @staticmethod
    def _index_transitions(
        transitions: list[MutationTransition]
    ) -> dict[str, list[MutationTransition]]:
        by_parent: dict[str, list[MutationTransition]] = {}
        for transition in transitions:
            by_parent.setdefault(transition.parent_clone, []).append(transition)
        return by_parent

    def _render_child(
        self,
        node: MutationNode,
        *,
        prefix: str,
        last: bool,
        lines: list[str]
    ) -> None:
        connector = "`-- " if last else "|-- "
        detail = ""
        if node.alteration is not None and node.probability is not None:
            detail = f" [{node.alteration}, p={node.probability:g}]"
        lines.append(f"{prefix}{connector}{node.clone_id}{detail}")

        child_prefix = prefix + ("    " if last else "|   ")
        for index, child in enumerate(node.children):
            self._render_child(
                child,
                prefix=child_prefix,
                last=index == len(node.children) - 1,
                lines=lines
            )


def tree_to_dict(node: MutationNode) -> dict[str, Any]:
    return {
        "clone_id": node.clone_id,
        "alteration": node.alteration,
        "probability": node.probability,
        "children": [tree_to_dict(child) for child in node.children]
    }

