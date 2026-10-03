import random
import unittest

from cancer_sim.automata import (
    AutomataConfig,
    CellularAutomataPhysics,
    ClonePhenotype,
    ResistanceTransition
)
from cancer_sim.world import ScalarField, Vessel, WorldConfig, WorldPhysics


class CellularAutomataPhysicsTest(unittest.TestCase):
    def fast_clone(self, clone_id: str = "EGFR") -> ClonePhenotype:
        return ClonePhenotype(
            clone_id=clone_id,
            growth_rate=100.0,
            fitness_cost=0.0,
            gefitinib_ic50_nm=35.0,
            osimertinib_ic50_nm=18.0,
            allowed_next_resistance_transitions=()
        )

    def test_cell_uptake_reduces_local_oxygen_without_source(self) -> None:
        world = WorldPhysics(WorldConfig(width=5, height=5), vessels=[])
        world.oxygen = ScalarField(5, 5, default=0.8)
        world.place_clone(2, 2, "EGFR")
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(oxygen_diffusion=0.0, oxygen_uptake_rate=0.1),
            rng=random.Random(1)
        )

        automata.step(drug="none", apply_death=False)

        self.assertLess(world.oxygen.get(2, 2), 0.8)
        self.assertEqual(world.oxygen.get(0, 0), 0.8)

    def test_vessel_source_increases_oxygen(self) -> None:
        world = WorldPhysics(WorldConfig(width=5, height=5), vessels=[Vessel(2, 2)])
        world.oxygen = ScalarField(5, 5, default=0.0)
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(oxygen_diffusion=0.0, oxygen_vessel_source=0.2),
            rng=random.Random(1)
        )

        automata.step(drug="none", apply_death=False)

        self.assertGreater(world.oxygen.get(2, 2), 0.0)
        self.assertEqual(world.oxygen.get(0, 0), 0.0)

    def test_drug_diffuses_from_vessel(self) -> None:
        world = WorldPhysics(WorldConfig(width=5, height=5), vessels=[Vessel(2, 2)])
        world.drug = ScalarField(5, 5, default=0.0)
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(drug_diffusion=0.2, drug_vessel_source=1.0),
            rng=random.Random(1)
        )

        automata.step(drug="gefitinib", vessel_drug_dose=1.0, apply_death=False)
        automata.step(drug="gefitinib", vessel_drug_dose=1.0, apply_death=False)

        self.assertGreater(world.drug.get(2, 2), world.drug.get(0, 0))
        self.assertGreater(world.drug.get(2, 1), 0.0)

    def test_high_drug_diffusion_uses_stability_substeps(self) -> None:
        world = WorldPhysics(WorldConfig(width=5, height=5), vessels=[Vessel(2, 2)])
        world.drug = ScalarField(5, 5, default=0.0)
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(drug_diffusion=2.0, drug_vessel_source=1.0),
            rng=random.Random(1)
        )

        automata.step(drug="gefitinib", vessel_drug_dose=1.0, apply_death=False)

        self.assertGreaterEqual(world.drug.get(2, 2), 0.0)
        self.assertLessEqual(world.drug.get(2, 2), 1.0)
        self.assertGreater(world.drug.get(2, 1), 0.0)

    def test_quasi_steady_oxygen_allows_large_diffusion(self) -> None:
        world = WorldPhysics(WorldConfig(width=5, height=5), vessels=[Vessel(2, 2)])
        world.oxygen = ScalarField(5, 5, default=0.0)
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(
                oxygen_solver="quasi_steady",
                oxygen_diffusion=2.0,
                oxygen_vessel_source=1.0,
                oxygen_solver_iterations=10
            ),
            rng=random.Random(1)
        )

        automata.step(drug="none", apply_death=False)

        self.assertGreater(world.oxygen.get(2, 2), 0.0)
        self.assertLessEqual(world.oxygen.get(2, 2), 1.0)

    def test_large_explicit_oxygen_diffusion_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            AutomataConfig(oxygen_solver="explicit", oxygen_diffusion=2.0)

    def test_gefitinib_effect_is_stronger_for_egfr_than_t790m(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        automata = CellularAutomataPhysics(world, rng=random.Random(1))

        egfr = automata.drug_death_probability("EGFR", "gefitinib", 1000.0, 1.0)
        t790m = automata.drug_death_probability("T790M", "gefitinib", 1000.0, 1.0)

        self.assertGreater(egfr, t790m)

    def test_drug_death_probability_uses_dt_in_days(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        automata = CellularAutomataPhysics(world, rng=random.Random(1))

        half_day = automata.drug_death_probability("EGFR", "gefitinib", 1000.0, 0.5)
        full_day = automata.drug_death_probability("EGFR", "gefitinib", 1000.0, 1.0)

        self.assertGreater(full_day, half_day)
        self.assertAlmostEqual(1.0 - full_day, (1.0 - half_day) ** 2)

    def test_osimertinib_effect_is_stronger_for_t790m_than_c797s(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        automata = CellularAutomataPhysics(world, rng=random.Random(1))

        t790m = automata.drug_death_probability("T790M", "osimertinib", 1000.0, 1.0)
        c797s = automata.drug_death_probability("C797S", "osimertinib", 1000.0, 1.0)

        self.assertGreater(t790m, c797s)

    def test_oxygen_thresholds_assign_cell_state(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        world.oxygen = ScalarField(3, 3, default=0.15)
        world.place_clone(1, 1, "EGFR")
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(
                oxygen_diffusion=0.0,
                oxygen_uptake_rate=0.0,
                oxygen_vessel_source=0.0,
                proliferation_oxygen_threshold=0.2,
                necrosis_threshold=0.05
            ),
            rng=random.Random(1)
        )

        automata.step(drug="none", apply_death=False, allow_division=False)

        self.assertEqual(world.site(1, 1).state, "quiescent")

    def test_cell_divides_into_empty_moore_neighbor(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        world.oxygen = ScalarField(3, 3, default=0.9)
        world.place_clone(1, 1, "EGFR")
        automata = CellularAutomataPhysics(
            world,
            clone_responses={"EGFR": self.fast_clone()},
            transitions={},
            config=AutomataConfig(
                oxygen_diffusion=0.0,
                oxygen_uptake_rate=0.0,
                oxygen_vessel_source=0.0
            ),
            rng=random.Random(2)
        )

        stats = automata.step(drug="none", apply_death=False)

        self.assertEqual(stats.births, 1)
        self.assertEqual(automata.living_cell_count(), 2)

    def test_mutation_happens_only_on_daughter_creation(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        world.oxygen = ScalarField(3, 3, default=0.9)
        world.place_clone(1, 1, "EGFR")
        automata = CellularAutomataPhysics(
            world,
            clone_responses={
                "EGFR": self.fast_clone("EGFR"),
                "T790M": self.fast_clone("T790M")
            },
            transitions={
                "EGFR": [
                    ResistanceTransition(
                        parent_clone="EGFR",
                        child_clone="T790M",
                        alteration="EGFR_T790M",
                        simulation_probability=1.0
                    )
                ]
            },
            config=AutomataConfig(
                oxygen_diffusion=0.0,
                oxygen_uptake_rate=0.0,
                oxygen_vessel_source=0.0
            ),
            rng=random.Random(3)
        )

        stats = automata.step(drug="none", apply_death=False)
        clones = [
            world.site(x, y).clone_id
            for y in range(3)
            for x in range(3)
            if world.site(x, y).occupied
        ]

        self.assertEqual(stats.births, 1)
        self.assertEqual(stats.mutations, 1)
        self.assertIn("EGFR", clones)
        self.assertIn("T790M", clones)

    def test_necrotic_cells_do_not_count_as_living(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        world.oxygen = ScalarField(3, 3, default=0.0)
        world.place_clone(1, 1, "EGFR")
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(
                oxygen_diffusion=0.0,
                oxygen_uptake_rate=0.0,
                oxygen_vessel_source=0.0,
                necrosis_threshold=0.05,
                necrosis_exposure_time=0.0,
                hypoxic_death_rate=100.0
            ),
            rng=random.Random(1)
        )

        stats = automata.step(drug="none", apply_death=True, allow_division=False)

        self.assertEqual(world.site(1, 1).state, "necrotic")
        self.assertEqual(stats.living_cells_after, 0)

    def test_hypoxic_exposure_time_is_measured_in_days(self) -> None:
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        world.oxygen = ScalarField(3, 3, default=0.0)
        world.place_clone(1, 1, "EGFR")
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(
                oxygen_solver="explicit",
                oxygen_diffusion=0.0,
                oxygen_uptake_rate=0.0,
                oxygen_vessel_source=0.0,
                necrosis_threshold=0.05,
                necrosis_exposure_time=1.0,
                hypoxic_death_rate=100.0
            ),
            rng=random.Random(1)
        )

        first = automata.step(dt=0.5, drug="none", apply_death=True, allow_division=False)
        second = automata.step(dt=0.5, drug="none", apply_death=True, allow_division=False)

        self.assertEqual(first.hypoxic_deaths, 0)
        self.assertEqual(second.hypoxic_deaths, 1)


if __name__ == "__main__":
    unittest.main()
