"""Real-time Matplotlib visualization for simulation runs."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from cancer_sim.simulation import CLONES, SimulationRecord, SimulationRunner
from cancer_sim.world import WorldPhysics


CLONE_GRID_VALUES = {
    None: 0,
    "EGFR": 1,
    "T790M": 2,
    "C797S": 3,
    "MET_AMP": 4,
    "hypoxic_necrotic": 5,
    "drug_killed": 6
}


@dataclass(frozen=True)
class LiveViewConfig:
    field: str = "oxygen"
    interval: float = 0.05
    cell_marker_size: int = 8

    def __post_init__(self) -> None:
        if self.field not in {"oxygen", "drug"}:
            raise ValueError("field must be oxygen or drug")
        if self.interval < 0:
            raise ValueError("interval must be non-negative")


def clone_state_grid(world: WorldPhysics) -> list[list[int]]:
    rows = []
    for y in range(world.config.height):
        row = []
        for x in range(world.config.width):
            site = world.site(x, y)
            if site.state == "necrotic":
                if site.death_cause and "kill" in site.death_cause:
                    row.append(CLONE_GRID_VALUES["drug_killed"])
                else:
                    row.append(CLONE_GRID_VALUES["hypoxic_necrotic"])
            else:
                row.append(CLONE_GRID_VALUES.get(site.clone_id, 0))
        rows.append(row)
    return rows


def scalar_rows(world: WorldPhysics, field: str) -> list[list[float]]:
    if field == "oxygen":
        return world.oxygen.rows()
    if field == "drug":
        return world.drug.rows()
    raise ValueError("field must be oxygen or drug")


def run_live_dashboard(
    runner: SimulationRunner,
    *,
    steps: int,
    dt: float = 1.0,
    config: LiveViewConfig | None = None,
    output: Path | None = None,
    headless: bool = False
) -> list[SimulationRecord]:
    if steps < 0:
        raise ValueError("steps must be non-negative")

    config = config or LiveViewConfig()

    import matplotlib.pyplot as plt
    from matplotlib.colors import BoundaryNorm, ListedColormap
    from matplotlib.lines import Line2D

    world = runner.automata.world
    cmap = ListedColormap([
        "#f2f2f2",
        "#2f80ed",
        "#f2994a",
        "#eb5757",
        "#9b51e0",
        "#222222",
        "#6b6b6b"
    ])
    norm = BoundaryNorm([-0.5, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5], cmap.N)
    field_cmap = "YlGnBu_r" if config.field == "oxygen" else "PuRd"

    fig, axes = plt.subplots(2, 2, figsize=(12, 9), constrained_layout=True)
    ax_world, ax_field, ax_burden, ax_clones = axes.ravel()

    clone_image = ax_world.imshow(clone_state_grid(world), cmap=cmap, norm=norm, interpolation="nearest")
    ax_world.set_title("Clone / Cell State")
    ax_world.set_xticks([])
    ax_world.set_yticks([])
    ax_world.legend(
        handles=[
            Line2D([0], [0], marker="s", color="w", label="empty", markerfacecolor="#f2f2f2", markersize=9),
            Line2D([0], [0], marker="s", color="w", label="EGFR", markerfacecolor="#2f80ed", markersize=9),
            Line2D([0], [0], marker="s", color="w", label="T790M", markerfacecolor="#f2994a", markersize=9),
            Line2D([0], [0], marker="s", color="w", label="C797S", markerfacecolor="#eb5757", markersize=9),
            Line2D([0], [0], marker="s", color="w", label="MET amp", markerfacecolor="#9b51e0", markersize=9),
            Line2D([0], [0], marker="s", color="w", label="hypoxic necrosis", markerfacecolor="#222222", markersize=9),
            Line2D([0], [0], marker="s", color="w", label="drug killed", markerfacecolor="#6b6b6b", markersize=9)
        ],
        loc="upper right",
        fontsize=8,
        frameon=True
    )

    field_image = ax_field.imshow(
        scalar_rows(world, config.field),
        cmap=field_cmap,
        interpolation="nearest",
        vmin=0,
        vmax=1
    )
    ax_field.set_title(config.field.capitalize())
    ax_field.set_xticks([])
    ax_field.set_yticks([])
    fig.colorbar(field_image, ax=ax_field, fraction=0.046)

    ax_burden.set_title("Tumor Burden")
    ax_burden.set_xlabel("time")
    ax_burden.set_ylabel("living cells")
    burden_line, = ax_burden.plot([], [], color="#111111", linewidth=2)

    ax_clones.set_title("Clone Counts")
    ax_clones.set_xlabel("time")
    ax_clones.set_ylabel("living cells")
    clone_lines = {
        "EGFR": ax_clones.plot([], [], color="#2f80ed", label="EGFR")[0],
        "T790M": ax_clones.plot([], [], color="#f2994a", label="T790M")[0],
        "C797S": ax_clones.plot([], [], color="#eb5757", label="C797S")[0],
        "MET_AMP": ax_clones.plot([], [], color="#9b51e0", label="MET amp")[0]
    }
    ax_clones.legend(loc="upper right", fontsize=8)

    history: list[SimulationRecord] = []
    if not headless:
        plt.ion()
        fig.show()

    for _ in range(steps):
        record = runner.step(dt=dt)
        history.append(record)
        _refresh(
            fig,
            clone_image,
            field_image,
            burden_line,
            clone_lines,
            ax_burden,
            ax_clones,
            runner.automata.world,
            runner.history,
            config.field
        )
        title = (
            f"step {record.step}  t={record.time:.1f}  "
            f"{record.drug} dose={record.dose:.2f}  burden={record.burden}"
        )
        fig.suptitle(title)
        if not headless:
            plt.pause(config.interval)

    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        fig.savefig(output, dpi=160)

    if headless:
        plt.close(fig)
    else:
        plt.ioff()
        plt.show()

    return history


def _refresh(
    fig,
    clone_image,
    field_image,
    burden_line,
    clone_lines,
    ax_burden,
    ax_clones,
    world: WorldPhysics,
    history: list[SimulationRecord],
    field: str
) -> None:
    clone_image.set_data(clone_state_grid(world))
    field_image.set_data(scalar_rows(world, field))
    times = [item.time for item in history]
    burden_line.set_data(times, [item.burden for item in history])
    clone_lines["EGFR"].set_data(times, [item.egfr for item in history])
    clone_lines["T790M"].set_data(times, [item.t790m for item in history])
    clone_lines["C797S"].set_data(times, [item.c797s for item in history])
    clone_lines["MET_AMP"].set_data(times, [item.met_amp for item in history])

    ax_burden.relim()
    ax_burden.autoscale_view()
    ax_clones.relim()
    ax_clones.autoscale_view()
    fig.canvas.draw_idle()
