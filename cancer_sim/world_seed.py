"""Seeded construction of the initial tumour and its vessels (2D section or 3D volume)."""

from __future__ import annotations

import random

from typing import Sequence

from cancer_sim.vasculature import DEFAULT_SPEC, VesselNetwork, grow_vasculature
from cancer_sim.world import Vessel, WorldConfig, WorldPhysics


# The default (lung) model's clones and seeding mix; any model's can be passed in.
CLONES = ("EGFR", "T790M", "C797S", "MET_AMP")
CLONE_WEIGHTS = (88, 8, 2, 2)
DEFAULT_VESSEL_SPACING_UM = 150.0  # literature-derived intercapillary distance (see WorldPhysics.grid_vessels)


def build_seeded_world(
    width: int,
    height: int,
    cell_count: int,
    rng: random.Random,
    clone_weights: Sequence[float] = CLONE_WEIGHTS,
    vessel_spacing_um: float | None = DEFAULT_VESSEL_SPACING_UM,
    depth: int = 1,
    vasculature: str = "grid",
    vasculature_spec: dict | None = None,
    cell_size_um: float = 20.0,
    clones: Sequence[str] = CLONES
) -> WorldPhysics:
    """Create a seeded tumour.

    2D (``depth == 1``): a disc of cells around the centre; vessels are capillary
    cross-sections on a grid at ``vessel_spacing_um`` (``None``/0 reproduces the
    legacy three point vessels).

    3D: a sphere of cells around the centre; ``vasculature="grid"`` gives straight
    parallel capillaries along z at the same spacing (Krogh arrangement), and
    ``vasculature="tree"`` grows the viewer's branching tree (``vasculature.py``),
    whose lumen voxels are the sources and whose walls are blocked. The network is
    attached as ``world.vessel_network`` so the exporter can write its segments.
    """
    clones = tuple(clones)
    if len(clone_weights) != len(clones):
        raise ValueError(f"clone_weights must provide one weight per clone: {', '.join(clones)}")
    if any(weight < 0 for weight in clone_weights) or sum(clone_weights) <= 0:
        raise ValueError("clone_weights must be non-negative and not all zero")
    if vasculature not in ("grid", "tree"):
        raise ValueError("vasculature must be 'grid' or 'tree'")

    config = WorldConfig(
        width=width, height=height, depth=depth, cell_size_um=cell_size_um,
        oxygen_length_scale=max(width, height, depth) / 5
    )
    network: VesselNetwork | None = None
    blocked = None
    if vasculature == "tree" and depth > 1:
        # grown from the experiment seed so the tree is reproducible per run
        network = grow_vasculature(rng.randrange(0, 2 ** 31), width, height, depth, vasculature_spec or DEFAULT_SPEC)
        vessels = [Vessel(*network.coords(int(i))) for i in network.lumen_indices]
        blocked = [network.coords(int(i)) for i in network.blocked_indices]
    elif vessel_spacing_um:
        vessels = WorldPhysics.grid_vessels(config, vessel_spacing_um)
    else:
        zc = depth // 2
        vessels = [
            Vessel(width // 5, height // 4, zc),
            Vessel((4 * width) // 5, height // 3, zc, drug_strength=0.9),
            Vessel(width // 2, (4 * height) // 5, zc, oxygen_strength=0.9)
        ]
    world = WorldPhysics(config, vessels=vessels, blocked=blocked)
    world.vessel_network = network

    center_x, center_y, center_z = width // 2, height // 2, depth // 2
    if depth == 1:
        radius = max(3, min(width, height) // 3)
    else:
        # sphere holding ~cell_count voxels at full packing, padded for the Gaussian spread
        radius = max(3, int(round(1.6 * (3 * cell_count / (4 * 3.14159)) ** (1 / 3))))
        radius = min(radius, min(width, height, depth) // 2 - 1)

    placed = 0
    attempts = 0
    while placed < cell_count and attempts < cell_count * 30:
        attempts += 1
        x = max(0, min(width - 1, int(rng.gauss(center_x, radius / 2.6))))
        y = max(0, min(height - 1, int(rng.gauss(center_y, radius / 2.6))))
        z = 0 if depth == 1 else max(0, min(depth - 1, int(rng.gauss(center_z, radius / 2.6))))
        if (x - center_x) ** 2 + (y - center_y) ** 2 + (z - center_z) ** 2 > radius ** 2:
            continue
        if world.site(x, y, z).occupied or world.is_blocked(x, y, z):
            continue
        clone_id = rng.choices(clones, weights=clone_weights, k=1)[0]
        world.place_clone(x, y, clone_id, z)
        placed += 1

    return world
