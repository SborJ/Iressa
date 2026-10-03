"""Seeded construction helpers for static world previews."""

from __future__ import annotations

import random

from cancer_sim.world import Vessel, WorldConfig, WorldPhysics


CLONES = ("EGFR", "T790M", "C797S", "MET_AMP")
CLONE_WEIGHTS = (88, 8, 2, 2)


def build_seeded_world(
    width: int,
    height: int,
    cell_count: int,
    rng: random.Random,
    clone_weights: tuple[float, float, float, float] = CLONE_WEIGHTS
) -> WorldPhysics:
    """Create a static seeded tumor-like occupancy pattern."""
    if len(clone_weights) != len(CLONES):
        raise ValueError("clone_weights must provide EGFR, T790M, C797S, MET_AMP weights")
    if any(weight < 0 for weight in clone_weights) or sum(clone_weights) <= 0:
        raise ValueError("clone_weights must be non-negative and not all zero")

    world = WorldPhysics(
        WorldConfig(width=width, height=height, oxygen_length_scale=max(width, height) / 5),
        vessels=[
            Vessel(width // 5, height // 4),
            Vessel((4 * width) // 5, height // 3, drug_strength=0.9),
            Vessel(width // 2, (4 * height) // 5, oxygen_strength=0.9)
        ]
    )

    center_x = width // 2
    center_y = height // 2
    radius = max(3, min(width, height) // 3)

    placed = 0
    attempts = 0
    while placed < cell_count and attempts < cell_count * 30:
        attempts += 1
        x = max(0, min(width - 1, int(rng.gauss(center_x, radius / 2.6))))
        y = max(0, min(height - 1, int(rng.gauss(center_y, radius / 2.6))))
        if (x - center_x) ** 2 + (y - center_y) ** 2 > radius ** 2:
            continue
        if world.site(x, y).occupied:
            continue

        clone_id = rng.choices(CLONES, weights=clone_weights, k=1)[0]
        world.place_clone(x, y, clone_id)
        placed += 1

    return world
