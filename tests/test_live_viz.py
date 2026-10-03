import unittest

from cancer_sim.live_viz import CLONE_GRID_VALUES, clone_state_grid
from cancer_sim.world import Cell, Vessel, WorldConfig, WorldPhysics


class LiveVizTest(unittest.TestCase):
    def test_clone_state_grid_maps_living_and_necrotic_cells(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=2), vessels=[Vessel(0, 0)])
        world.place_cell(1, 0, Cell(clone_id="EGFR"))
        world.place_cell(2, 1, Cell(clone_id="T790M", state="necrotic", death_cause="hypoxia"))

        grid = clone_state_grid(world)

        self.assertEqual(grid[0][0], CLONE_GRID_VALUES[None])
        self.assertEqual(grid[0][1], CLONE_GRID_VALUES["EGFR"])
        self.assertEqual(grid[1][2], CLONE_GRID_VALUES["hypoxic_necrotic"])


if __name__ == "__main__":
    unittest.main()
