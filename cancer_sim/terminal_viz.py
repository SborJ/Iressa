"""Terminal visualization helpers for the static cell world."""

from __future__ import annotations

from cancer_sim.world import WorldPhysics


CLONE_SYMBOLS = {
    "EGFR": "E",
    "T790M": "T",
    "C797S": "C",
    "MET_AMP": "M",
    "hypoxic_necrotic": "N",
    "drug_killed": "X"
}


def render_world(
    world: WorldPhysics,
    *,
    max_width: int = 80,
    max_height: int = 40,
    show_field: str = "oxygen"
) -> str:
    """Render a coarse ASCII view of vessels, cells, and a scalar field."""

    if show_field not in {"oxygen", "drug"}:
        raise ValueError("show_field must be 'oxygen' or 'drug'")
    if max_width <= 0 or max_height <= 0:
        raise ValueError("max_width and max_height must be positive")

    x_step = max(1, world.config.width // max_width)
    y_step = max(1, world.config.height // max_height)
    vessel_points = {(vessel.x, vessel.y) for vessel in world.vessels}
    field = world.oxygen if show_field == "oxygen" else world.drug

    lines = []
    for y in range(0, world.config.height, y_step):
        line = []
        for x in range(0, world.config.width, x_step):
            site = world.site(x, y)
            if (x, y) in vessel_points:
                line.append("V")
            elif site.state == "necrotic":
                if site.death_cause and "kill" in site.death_cause:
                    line.append(CLONE_SYMBOLS["drug_killed"])
                else:
                    line.append(CLONE_SYMBOLS["hypoxic_necrotic"])
            elif site.clone_id is not None:
                line.append(CLONE_SYMBOLS.get(site.clone_id, "?"))
            else:
                line.append(_field_symbol(field.get(x, y)))
        lines.append("".join(line))

    legend = [
        "Legend: V=vessel E=EGFR T=T790M C=C797S M=MET amplification N=hypoxic necrosis X=drug killed",
        f"Field: {show_field}  . low  : medium  + high"
    ]
    return "\n".join(legend + [""] + lines)


def _field_symbol(value: float) -> str:
    if value >= 0.65:
        return "+"
    if value >= 0.25:
        return ":"
    return "."
