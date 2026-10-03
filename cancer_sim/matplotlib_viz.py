"""Matplotlib visualization for the static cell world."""

from __future__ import annotations

from pathlib import Path

from cancer_sim.world import WorldPhysics


CLONE_COLORS = {
    "EGFR": "#2f80ed",
    "T790M": "#f2994a",
    "C797S": "#eb5757",
    "MET_AMP": "#9b51e0",
    "hypoxic_necrotic": "#222222",
    "drug_killed": "#6b6b6b"
}


def plot_world(
    world: WorldPhysics,
    *,
    field: str = "oxygen",
    output: Path | None = None,
    title: str | None = None,
    show: bool = False
) -> Path | None:
    """Plot vessels and clone cells over an oxygen or drug heatmap."""

    if field not in {"oxygen", "drug"}:
        raise ValueError("field must be 'oxygen' or 'drug'")

    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    scalar = world.oxygen if field == "oxygen" else world.drug
    cmap = "YlGnBu_r" if field == "oxygen" else "PuRd"

    fig, ax = plt.subplots(figsize=(9, 7), constrained_layout=True)
    image = ax.imshow(
        scalar.rows(),
        cmap=cmap,
        origin="upper",
        interpolation="nearest",
        vmin=0,
        vmax=1
    )
    fig.colorbar(image, ax=ax, label=f"{field} concentration")

    clone_points: dict[str, tuple[list[int], list[int]]] = {
        clone_id: ([], []) for clone_id in CLONE_COLORS
    }
    for y in range(world.config.height):
        for x in range(world.config.width):
            site = world.site(x, y)
            if site.state == "necrotic" and site.death_cause and "kill" in site.death_cause:
                key = "drug_killed"
            elif site.state == "necrotic":
                key = "hypoxic_necrotic"
            else:
                key = site.clone_id
            if key in clone_points:
                xs, ys = clone_points[key]
                xs.append(x)
                ys.append(y)

    for clone_id, (xs, ys) in clone_points.items():
        if xs:
            ax.scatter(
                xs,
                ys,
                s=18,
                c=CLONE_COLORS[clone_id],
                edgecolors="black",
                linewidths=0.2,
                label=clone_id,
                alpha=0.95
            )

    vessel_xs = [vessel.x for vessel in world.vessels]
    vessel_ys = [vessel.y for vessel in world.vessels]
    ax.scatter(
        vessel_xs,
        vessel_ys,
        s=140,
        c="#d00000",
        marker="*",
        edgecolors="white",
        linewidths=0.8,
        label="vessel",
        zorder=5
    )

    ax.set_title(title or f"Static Cancer Cell World ({field})")
    ax.set_xlabel("x lattice position")
    ax.set_ylabel("y lattice position")
    ax.set_xlim(-0.5, world.config.width - 0.5)
    ax.set_ylim(world.config.height - 0.5, -0.5)

    legend_items = [
        Line2D([0], [0], marker="o", color="w", label=clone_id,
               markerfacecolor=color, markeredgecolor="black", markersize=8)
        for clone_id, color in CLONE_COLORS.items()
    ]
    legend_items.append(
        Line2D([0], [0], marker="*", color="w", label="vessel",
               markerfacecolor="#d00000", markeredgecolor="white", markersize=13)
    )
    ax.legend(handles=legend_items, loc="upper right", frameon=True)

    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(output, dpi=180)

    if show:
        plt.show()
    else:
        plt.close(fig)

    return output
