import unittest

from cancer_sim.terminal_viz import render_world
from cancer_sim.world import Vessel, WorldConfig, WorldPhysics


class TerminalVizTest(unittest.TestCase):
    def test_render_world_contains_legend_and_cells(self) -> None:
        world = WorldPhysics(WorldConfig(width=8, height=6), vessels=[Vessel(0, 0)])
        world.place_clone(3, 3, "EGFR")

        output = render_world(world, max_width=8, max_height=6)

        self.assertIn("Legend:", output)
        self.assertIn("V", output)
        self.assertIn("E", output)


if __name__ == "__main__":
    unittest.main()

