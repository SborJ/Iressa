"""Numerical validation of the field solvers and unit conversions (Phase 1)."""

import math
import random
import unittest

import numpy as np

from cancer_sim.automata import AutomataConfig, CellularAutomataPhysics, automata_config_from_physics_calibration
from cancer_sim.fields import dense_reference_solve, residual, solve_quasi_steady
from cancer_sim.world import ScalarField, Vessel, WorldConfig, WorldPhysics
from cancer_sim.world_seed import build_seeded_world


class QuasiSteadySolverTest(unittest.TestCase):
    def test_linear_sink_matches_dense_reference(self) -> None:
        height, width = 10, 12
        rng = np.random.default_rng(3)
        source = np.zeros((height, width))
        source[4, 5] = 0.35
        sink = 0.05 * (rng.random((height, width)) > 0.5)
        reference = dense_reference_solve(diffusion=0.12, source=source, sink=sink)
        result = solve_quasi_steady(
            np.zeros((height, width)), diffusion=0.12, source=source, linear_sink=sink,
            tolerance=1e-12, max_iterations=50000, clamp=None
        )
        self.assertTrue(result.converged)
        self.assertLess(np.abs(result.values - reference).max(), 1e-8)

    def test_dirichlet_vessels_match_dense_reference(self) -> None:
        height, width = 9, 11
        source = np.zeros((height, width))
        sink = np.full((height, width), 0.48)
        fixed = np.zeros((height, width), dtype=bool)
        fixed[2, 3] = True
        fixed[6, 8] = True
        values = np.where(fixed, 0.9, 0.0)
        reference = dense_reference_solve(
            diffusion=300.0, source=source, sink=sink, fixed_mask=fixed, fixed_values=values
        )
        result = solve_quasi_steady(
            np.zeros((height, width)), diffusion=300.0, source=source, linear_sink=sink,
            fixed_mask=fixed, fixed_values=values, tolerance=1e-13, max_iterations=100000, clamp=None
        )
        self.assertTrue(result.converged)
        self.assertLess(np.abs(result.values - reference).max(), 1e-7)

    def test_solver_residual_is_small_and_has_no_nans(self) -> None:
        height, width = 20, 25
        source = np.zeros((height, width))
        source[10, 12] = 0.35
        sink = np.full((height, width), 0.02)
        result = solve_quasi_steady(
            np.zeros((height, width)), diffusion=0.12, source=source, linear_sink=sink,
            tolerance=1e-12, max_iterations=50000, clamp=None
        )
        res = residual(result.values, diffusion=0.12, source=source, sink=sink)
        self.assertFalse(np.isnan(result.values).any())
        self.assertLess(res.max(), 1e-9)


class VolumeSolverTest(unittest.TestCase):
    def test_3d_linear_sink_matches_dense_reference(self) -> None:
        shape = (5, 6, 7)
        rng = np.random.default_rng(5)
        source = np.zeros(shape); source[2, 3, 3] = 0.35
        sink = 0.05 * (rng.random(shape) > 0.5)
        reference = dense_reference_solve(diffusion=0.12, source=source, sink=sink)
        result = solve_quasi_steady(np.zeros(shape), diffusion=0.12, source=source, linear_sink=sink,
                                    tolerance=1e-12, max_iterations=50000, clamp=None)
        self.assertTrue(result.converged)
        self.assertLess(np.abs(result.values - reference).max(), 1e-8)

    def test_3d_dirichlet_matches_dense_reference(self) -> None:
        shape = (4, 5, 6)
        fixed = np.zeros(shape, dtype=bool); fixed[1, 2, 2] = True; fixed[3, 4, 5] = True
        values = np.where(fixed, 0.9, 0.0)
        sink = np.full(shape, 0.48)
        reference = dense_reference_solve(diffusion=300.0, source=np.zeros(shape), sink=sink, fixed_mask=fixed, fixed_values=values)
        result = solve_quasi_steady(np.zeros(shape), diffusion=300.0, source=np.zeros(shape), linear_sink=sink,
                                    fixed_mask=fixed, fixed_values=values, tolerance=1e-13, max_iterations=100000, clamp=None)
        self.assertLess(np.abs(result.values - reference).max(), 1e-7)

    def test_one_deep_volume_uses_the_2d_stencil(self) -> None:
        shape2 = (6, 7); shape3 = (1, 6, 7)
        source2 = np.zeros(shape2); source2[2, 3] = 0.3
        sink2 = np.full(shape2, 0.1)
        r2 = solve_quasi_steady(np.zeros(shape2), diffusion=0.12, source=source2, linear_sink=sink2, tolerance=1e-12, max_iterations=20000, clamp=None)
        r3 = solve_quasi_steady(np.zeros(shape3), diffusion=0.12, source=source2[np.newaxis], linear_sink=sink2[np.newaxis], tolerance=1e-12, max_iterations=20000, clamp=None)
        self.assertLess(np.abs(r2.values - r3.values[0]).max(), 1e-10)


class EngineOxygenSolverTest(unittest.TestCase):
    def test_engine_oxygen_field_is_converged_and_matches_reference(self) -> None:
        rng = random.Random(7)
        world = build_seeded_world(50, 40, 350, rng)
        config = automata_config_from_physics_calibration(oxygen_mm_vmax=0.04)
        automata = CellularAutomataPhysics(world, config=config, rng=rng)
        density = np.array(automata.cell_density())[0]
        field = np.array(automata._next_quasi_steady_oxygen_field(automata.cell_density()).rows())
        self.assertTrue(automata.last_oxygen_solve.converged)

        source = np.array(automata._source_grid(config.oxygen_vessel_source, "oxygen_strength"))[0]
        fixed = source > 0  # vessel sites saturate at the clamp
        sink = np.where(density > 0, config.oxygen_mm_vmax / (config.oxygen_mm_km + np.maximum(field, 1e-9)) * density, 0.0)
        reference = np.clip(dense_reference_solve(
            diffusion=config.oxygen_diffusion, source=source, sink=sink,
            fixed_mask=fixed, fixed_values=np.ones_like(source)
        ), 0, 1)
        self.assertLess(np.abs(field - reference).max(), 1e-4)
        self.assertFalse(np.isnan(field).any())

    def test_legacy_sweep_cap_was_not_converged(self) -> None:
        """Documents the Phase 1 finding: 80 Gauss-Seidel sweeps left errors of order 0.1."""
        rng = random.Random(7)
        world = build_seeded_world(50, 40, 350, rng)
        config = automata_config_from_physics_calibration(
            oxygen_mm_vmax=0.04, oxygen_solver_iterations=80, oxygen_solver_relaxation=1.0, oxygen_solver_tolerance=0.0
        )
        automata = CellularAutomataPhysics(world, config=config, rng=rng)
        capped = np.array(automata._next_quasi_steady_oxygen_field(automata.cell_density()).rows())
        self.assertFalse(automata.last_oxygen_solve.converged)
        automata.config = automata_config_from_physics_calibration(oxygen_mm_vmax=0.04)
        world.oxygen = build_seeded_world(50, 40, 350, random.Random(7)).oxygen
        converged = np.array(automata._next_quasi_steady_oxygen_field(automata.cell_density()).rows())
        self.assertGreater(np.abs(capped - converged).max(), 0.05)


class DrugFieldTest(unittest.TestCase):
    def test_physical_units_convert_to_lattice_per_day(self) -> None:
        config = AutomataConfig(drug_diffusion_um2_s=500.0, lattice_spacing_um=20.0, drug_decay_per_hour=0.02)
        self.assertAlmostEqual(config.drug_grid_diffusion_per_day, 500.0 * 86400 / 400.0)
        self.assertAlmostEqual(config.drug_decay_per_day, 0.48)
        self.assertGreater(config.drug_decay_length_sites, 400)

    def test_quasi_steady_drug_is_near_uniform_at_physical_diffusivity(self) -> None:
        world = WorldPhysics(WorldConfig(width=50, height=40), vessels=[Vessel(10, 10), Vessel(40, 30)])
        world.drug = ScalarField(50, 40, default=0.0)
        config = automata_config_from_physics_calibration(oxygen_mm_vmax=0.04)
        automata = CellularAutomataPhysics(world, config=config, rng=random.Random(1))
        for x in range(20, 30):
            world.place_clone(x, 20, "EGFR")
        automata.step(drug="gefitinib", vessel_drug_dose=0.9, apply_death=False, allow_division=False)
        values = np.array(world.drug.rows())
        self.assertTrue(automata.last_drug_solve.converged)
        self.assertAlmostEqual(values[10, 10], 0.9, places=9)
        self.assertGreater(values.min(), 0.85)
        self.assertGreater(values[0, 49], 0.9 * 0.9)   # far corner sees > 90% of vessel level
        self.assertEqual(automata.local_drug_concentration_nm("gefitinib", 49, 0), values[0, 49] * 1000.0)

    def test_quasi_steady_drug_matches_dense_reference(self) -> None:
        world = WorldPhysics(WorldConfig(width=12, height=9), vessels=[Vessel(3, 2)])
        world.drug = ScalarField(12, 9, default=0.0)
        config = AutomataConfig(drug_diffusion_um2_s=0.05, lattice_spacing_um=20.0, drug_decay_per_hour=0.02)
        automata = CellularAutomataPhysics(world, config=config, rng=random.Random(1))
        for x in range(5, 9):
            world.place_clone(x, 4, "EGFR")
        automata.step(drug="gefitinib", vessel_drug_dose=1.0, apply_death=False, allow_division=False)
        values = np.array(world.drug.rows())
        density = np.array(automata.cell_density())[0]
        fixed = np.zeros((9, 12), dtype=bool); fixed[2, 3] = True
        reference = dense_reference_solve(
            diffusion=config.drug_grid_diffusion_per_day, source=np.zeros((9, 12)),
            sink=config.drug_decay_per_day + config.drug_uptake_rate * density,
            fixed_mask=fixed, fixed_values=np.where(fixed, 1.0, 0.0)
        )
        self.assertLess(np.abs(values - np.clip(reference, 0, 1)).max(), 1e-6)

    def test_no_dose_gives_zero_field(self) -> None:
        world = WorldPhysics(WorldConfig(width=10, height=10), vessels=[Vessel(5, 5)])
        world.drug = ScalarField(10, 10, default=0.7)
        automata = CellularAutomataPhysics(world, config=AutomataConfig(), rng=random.Random(1))
        automata.step(drug="none", vessel_drug_dose=0.0, apply_death=False, allow_division=False)
        self.assertEqual(max(max(row) for row in world.drug.rows()), 0.0)

    def test_legacy_explicit_solver_confines_drug_near_vessel(self) -> None:
        """Documents the Phase 1 finding that motivated the physical solver."""
        world = WorldPhysics(WorldConfig(width=30, height=30), vessels=[Vessel(15, 15)])
        world.drug = ScalarField(30, 30, default=0.0)
        config = AutomataConfig(drug_solver="explicit_legacy")
        automata = CellularAutomataPhysics(world, config=config, rng=random.Random(1))
        for _ in range(10):
            automata.step(drug="gefitinib", vessel_drug_dose=0.9, apply_death=False, allow_division=False)
        values = np.array(world.drug.rows())
        self.assertGreater(values[15, 15], 0.9)
        self.assertLess(values[15, 21], 0.01)   # six sites away: essentially no drug


class SolverConfigTest(unittest.TestCase):
    def test_invalid_solver_options_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            AutomataConfig(drug_solver="magic")
        with self.assertRaises(ValueError):
            AutomataConfig(oxygen_solver_relaxation=2.5)
        with self.assertRaises(ValueError):
            AutomataConfig(lattice_spacing_um=0)

    def test_physics_calibration_file_drives_drug_physics(self) -> None:
        config = automata_config_from_physics_calibration()
        self.assertEqual(config.lattice_spacing_um, 20.0)
        self.assertEqual(config.drug_diffusion_um2_s, 500.0)
        self.assertEqual(config.drug_decay_per_hour, 0.02)
        self.assertEqual(config.gefitinib_vessel_concentration_nm, 1000.0)


if __name__ == "__main__":
    unittest.main()
