import unittest

from cancer_sim.world import Cell, Vessel, WorldConfig, WorldPhysics


class WorldPhysicsTest(unittest.TestCase):
    def test_builds_default_world(self) -> None:
        world = WorldPhysics(WorldConfig(width=20, height=15))

        self.assertEqual(world.config.width, 20)
        self.assertEqual(world.config.height, 15)
        self.assertEqual(len(world.vessels), 3)

    def test_vessel_source_has_higher_oxygen_than_far_corner(self) -> None:
        world = WorldPhysics(
            WorldConfig(width=25, height=25, oxygen_length_scale=5),
            vessels=[Vessel(12, 12)]
        )

        self.assertGreater(world.oxygen.get(12, 12), world.oxygen.get(0, 0))

    def test_occupancy_is_static_state(self) -> None:
        world = WorldPhysics(WorldConfig(width=5, height=5), vessels=[Vessel(0, 0)])

        self.assertFalse(world.site(2, 2).occupied)
        world.place_clone(2, 2, "EGFR")

        site = world.site(2, 2)
        self.assertTrue(site.occupied)
        self.assertEqual(site.clone_id, "EGFR")

        world.clear_site(2, 2)
        self.assertFalse(world.site(2, 2).occupied)

    def test_neighbors_use_four_connected_lattice(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[Vessel(0, 0)])

        center_neighbors = world.neighbors4(1, 1)
        corner_neighbors = world.neighbors4(0, 0)

        self.assertEqual(len(center_neighbors), 4)
        self.assertEqual(len(corner_neighbors), 2)

    def test_cell_state_is_separate_from_clone_identity(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[Vessel(0, 0)])
        world.place_cell(1, 1, Cell(clone_id="EGFR", state="quiescent", age=2.0))

        site = world.site(1, 1)

        self.assertEqual(site.clone_id, "EGFR")
        self.assertEqual(site.state, "quiescent")
        self.assertEqual(site.age, 2.0)


if __name__ == "__main__":
    unittest.main()
