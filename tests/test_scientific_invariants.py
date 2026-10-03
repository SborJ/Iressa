"""Scientific invariants of the engine, calibration and treatment layer (Phase 1, spec section 20)."""

import json
import math
import random
import unittest
from pathlib import Path

from cancer_sim.automata import (
    DEFAULT_CALIBRATED_CLONE_DATA,
    DEFAULT_RESISTANCE_GRAPH,
    AutomataConfig,
    CellularAutomataPhysics,
    ClonePhenotype,
    ResistanceTransition,
    load_clone_model
)
from cancer_sim.calibration.clones import growth_rate_per_day_from_doubling_time_hours
from cancer_sim.calibration.targets import canonical_alteration, is_exon19_deletion
from cancer_sim.experiments import ExperimentConfig, run_single_experiment
from cancer_sim.simulation import AdaptiveAT50Treatment, SimulationRunner, SwitchTreatment, build_schedule
from cancer_sim.world import ScalarField, Vessel, WorldConfig, WorldPhysics
from cancer_sim.world_seed import build_seeded_world


def _clones():
    return {c["clone_id"]: c for c in json.load(open(DEFAULT_CALIBRATED_CLONE_DATA))}


class CalibratedParameterInvariants(unittest.TestCase):
    def test_ic50_values_are_positive_in_nanomolar(self) -> None:
        for clone in _clones().values():
            for drug, response in clone["drug_response"].items():
                self.assertGreater(float(response["value"]), 0.0, f"{clone['clone_id']} {drug}")
                self.assertEqual(response["unit"], "nM")

    def test_t790m_is_gefitinib_resistant_and_osimertinib_sensitive_in_measured_data(self) -> None:
        clones = _clones()
        egfr_gef = clones["EGFR"]["drug_response"]["gefitinib"]
        t790m_gef = clones["T790M"]["drug_response"]["gefitinib"]
        t790m_osi = clones["T790M"]["drug_response"]["osimertinib"]
        self.assertEqual(egfr_gef["status"], "measured")
        self.assertEqual(t790m_gef["status"], "measured")
        self.assertGreater(t790m_gef["value"], 10 * egfr_gef["value"])
        self.assertGreater(t790m_gef["value"], 100 * t790m_osi["value"])

    def test_c797s_osimertinib_ic50_exceeds_t790m(self) -> None:
        clones = _clones()
        self.assertGreater(
            clones["C797S"]["drug_response"]["osimertinib"]["value"],
            clones["T790M"]["drug_response"]["osimertinib"]["value"]
        )
        self.assertEqual(clones["C797S"]["drug_response"]["osimertinib"]["status"], "assumed")

    def test_measured_growth_has_no_fitness_cost_and_inherited_growth_has_one(self) -> None:
        clones = _clones()
        for clone_id in ("EGFR", "T790M"):
            self.assertEqual(clones[clone_id]["growth_rate_per_day"]["status"], "measured")
            self.assertEqual(float(clones[clone_id]["fitness_cost"]["value"]), 0.0)
        self.assertEqual(clones["C797S"]["growth_rate_per_day"]["status"], "inferred")
        self.assertEqual(clones["C797S"]["growth_rate_per_day"]["value"], clones["T790M"]["growth_rate_per_day"]["value"])
        self.assertEqual(clones["C797S"]["fitness_cost"]["status"], "assumed")
        self.assertEqual(clones["MET_AMP"]["growth_rate_per_day"]["value"], clones["EGFR"]["growth_rate_per_day"]["value"])

    def test_assumed_and_measured_growth_are_on_the_same_scale(self) -> None:
        clones = _clones()
        measured = [c["growth_rate_per_day"]["value"] for c in clones.values() if c["growth_rate_per_day"]["status"] == "measured"]
        for clone in clones.values():
            self.assertGreater(clone["growth_rate_per_day"]["value"], 0.25 * min(measured))

    def test_max_death_rate_is_derived_from_the_assay_definition(self) -> None:
        for clone in _clones().values():
            kmax = clone["max_drug_death_rate_per_day"]
            self.assertEqual(kmax["status"], "inferred")
            self.assertAlmostEqual(kmax["value"], math.log(2) / 1.5, places=9)
            # at C = IC50 (Hill effect 0.5) survival after 72 h is 50%
            self.assertAlmostEqual(math.exp(-kmax["value"] * 0.5 * 3.0), 0.5, places=9)

    def test_doubling_time_conversion(self) -> None:
        self.assertAlmostEqual(growth_rate_per_day_from_doubling_time_hours(24.0), math.log(2))
        self.assertAlmostEqual(growth_rate_per_day_from_doubling_time_hours(40.84), 0.4073, places=3)

    def test_transitions_point_to_valid_clones_and_follow_the_curated_graph(self) -> None:
        clones = _clones()
        graph = json.load(open(DEFAULT_RESISTANCE_GRAPH))
        edges = {(e["from"], e["to"]) for e in graph}
        self.assertEqual(edges, {("EGFR", "T790M"), ("EGFR", "MET_AMP"), ("T790M", "C797S"), ("T790M", "MET_AMP")})
        for edge in graph:
            self.assertIn(edge["from"], clones)
            self.assertIn(edge["to"], clones)
            self.assertEqual(edge["probability_status"], "assumed")
        for clone in clones.values():
            for target in clone["allowed_transitions"]:
                self.assertIn((clone["clone_id"], target), edges)

    def test_c797s_only_arises_from_t790m(self) -> None:
        _, transitions = load_clone_model()
        parents = {parent for parent, rows in transitions.items() if any(t.child_clone == "C797S" for t in rows)}
        self.assertEqual(parents, {"T790M"})

    def test_exon19_deletion_recognition(self) -> None:
        for text in ("p.E746_A750delELREA", "p.L747_E749delLRE", "p.L747_P753delinsS", "E746_A750del", "exon19 del"):
            self.assertTrue(is_exon19_deletion(text), text)
        for text in ("p.E746K", "p.L858R", "p.T790M", "p.G719A", "p.L747_P753dup"):
            self.assertFalse(is_exon19_deletion(text), text)
        self.assertEqual(canonical_alteration("EGFR", "p.L747_E749delLRE"), "EGFR_EXON19DEL")

    def test_excluded_model_is_reported_not_silently_dropped(self) -> None:
        rows = Path("data/processed/clone_model_matches.csv").read_text().splitlines()
        header = rows[0].split(",")
        h1650 = [r for r in rows if "SIDM00745" in r]
        self.assertEqual(len(h1650), 1)
        values = dict(zip(header, h1650[0].split(",")))
        self.assertEqual(values["used_in_calibration"], "False")
        self.assertIn("PTEN", values["exclusion_reason"])


class EngineProbabilityInvariants(unittest.TestCase):
    def make(self, **config):
        world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
        return CellularAutomataPhysics(world, config=AutomataConfig(**config), rng=random.Random(1))

    def test_drug_death_probability_in_unit_interval_and_monotone(self) -> None:
        automata = self.make()
        previous = 0.0
        for conc in (0.0, 1.0, 10.0, 100.0, 1000.0, 1e5, 1e9):
            p = automata.drug_death_probability("EGFR", "gefitinib", conc, 1.0)
            self.assertGreaterEqual(p, 0.0)
            self.assertLessEqual(p, 1.0)
            self.assertGreaterEqual(p, previous)
            previous = p

    def test_division_probability_monotone_in_growth_rate_and_vanishes_as_dt_to_zero(self) -> None:
        def p_div(rate, dt):
            return 1.0 - math.exp(-rate * dt)
        self.assertLess(p_div(0.1, 1.0), p_div(0.2, 1.0))
        self.assertLess(p_div(0.2, 1.0), p_div(0.4, 1.0))
        self.assertLess(p_div(0.4, 1e-6), 1e-5)
        # sub-stepping is consistent: four quarter-day steps = one day
        self.assertAlmostEqual(1 - (1 - p_div(0.4, 0.25)) ** 4, p_div(0.4, 1.0))

    def test_hypoxic_death_respects_threshold_ordering(self) -> None:
        config = AutomataConfig()
        self.assertLess(config.necrosis_threshold, config.proliferation_oxygen_threshold)
        automata = self.make()
        self.assertEqual(automata.hypoxic_death_probability(config.necrosis_threshold + 0.01, 1.0), 0.0)
        self.assertGreater(automata.hypoxic_death_probability(config.necrosis_threshold - 0.01, 1.0), 0.0)

    def test_oxygen_states_follow_threshold_order(self) -> None:
        for oxygen, expected in ((0.9, "proliferating"), (0.15, "quiescent"), (0.01, "quiescent")):
            world = WorldPhysics(WorldConfig(width=3, height=3), vessels=[])
            world.oxygen = ScalarField(3, 3, default=oxygen)
            world.place_clone(1, 1, "EGFR")
            automata = CellularAutomataPhysics(
                world,
                config=AutomataConfig(oxygen_diffusion=0.0, oxygen_uptake_rate=0.0, oxygen_vessel_source=0.0),
                rng=random.Random(1)
            )
            automata.step(drug="none", apply_death=False, allow_division=False)
            self.assertEqual(world.site(1, 1).state, expected, f"oxygen {oxygen}")


class EngineBookkeepingInvariants(unittest.TestCase):
    def test_clone_counts_sum_to_burden_and_nothing_is_negative(self) -> None:
        config = ExperimentConfig(seed=3, width=24, height=20, cells=120, steps=20)
        for schedule in ("none", "continuous-gefitinib", "gefitinib-osimertinib"):
            for record in run_single_experiment(schedule_name=schedule, config=config):
                self.assertEqual(record.egfr + record.t790m + record.c797s + record.met_amp, record.burden)
                for value in (record.burden, record.births, record.mutations, record.drug_deaths,
                              record.hypoxic_deaths, record.proliferating, record.quiescent, record.necrotic):
                    self.assertGreaterEqual(value, 0)
                self.assertEqual(record.proliferating + record.quiescent, record.burden)
                self.assertFalse(math.isnan(record.mean_oxygen) or math.isnan(record.mean_drug))

    def test_mutation_only_occurs_with_a_birth(self) -> None:
        config = ExperimentConfig(seed=5, width=24, height=20, cells=120, steps=30, mutation_scale=2000.0)
        history = run_single_experiment(schedule_name="none", config=config)
        self.assertGreater(sum(r.mutations for r in history), 0)
        for record in history:
            self.assertLessEqual(record.mutations, record.births)

    def test_dead_cells_are_cleared_at_the_configured_rate(self) -> None:
        world = WorldPhysics(WorldConfig(width=10, height=10), vessels=[])
        for y in range(10):
            for x in range(10):
                world.place_clone(x, y, "EGFR")
                world.set_cell_state(x, y, "necrotic")
        automata = CellularAutomataPhysics(
            world, config=AutomataConfig(oxygen_vessel_source=0.0, necrotic_clearance_rate=1.0), rng=random.Random(2)
        )
        stats = automata.step(drug="none")
        expected = 100 * (1 - math.exp(-1.0))
        self.assertGreater(stats.cleared_cells, expected - 20)
        self.assertLess(stats.cleared_cells, expected + 20)
        self.assertEqual(stats.necrotic_cells, 100 - stats.cleared_cells)

    def test_zero_clearance_reproduces_legacy_permanent_debris(self) -> None:
        world = WorldPhysics(WorldConfig(width=5, height=5), vessels=[])
        world.place_clone(2, 2, "EGFR")
        world.set_cell_state(2, 2, "necrotic")
        automata = CellularAutomataPhysics(world, config=AutomataConfig(necrotic_clearance_rate=0.0), rng=random.Random(2))
        for _ in range(5):
            automata.step(drug="none")
        self.assertEqual(world.site(2, 2).state, "necrotic")

    def test_fields_stay_in_unit_interval_without_nans(self) -> None:
        config = ExperimentConfig(seed=9, width=30, height=24, cells=200, steps=10)
        rng = random.Random(9)
        world = build_seeded_world(30, 24, 200, rng)
        from cancer_sim.automata import automata_config_from_physics_calibration
        automata = CellularAutomataPhysics(world, config=automata_config_from_physics_calibration(oxygen_mm_vmax=0.04), rng=rng)
        for drug in ("none", "gefitinib", "osimertinib"):
            automata.step(drug=drug, vessel_drug_dose=0.9)
            for field in (world.oxygen, world.drug):
                values = [v for row in field.rows() for v in row]
                self.assertTrue(all(0.0 <= v <= 1.0 for v in values))
                self.assertFalse(any(math.isnan(v) for v in values))
            self.assertTrue(automata.last_oxygen_solve.converged)


class TreatmentScheduleInvariants(unittest.TestCase):
    def test_switch_happens_at_biological_time_not_step_index(self) -> None:
        schedule = SwitchTreatment(switch_time=40.0)
        self.assertEqual(schedule.action(time=39.5, burden=10, initial_burden=10).drug, "gefitinib")
        self.assertEqual(schedule.action(time=40.0, burden=10, initial_burden=10).drug, "osimertinib")

    def test_adaptive_rule_switches_at_50_and_100_percent(self) -> None:
        schedule = AdaptiveAT50Treatment("gefitinib")
        self.assertEqual(schedule.action(time=0, burden=100, initial_burden=100).drug, "gefitinib")
        self.assertEqual(schedule.action(time=1, burden=51, initial_burden=100).drug, "gefitinib")
        self.assertEqual(schedule.action(time=2, burden=50, initial_burden=100).drug, "none")
        self.assertEqual(schedule.action(time=3, burden=99, initial_burden=100).drug, "none")
        self.assertEqual(schedule.action(time=4, burden=100, initial_burden=100).drug, "gefitinib")

    def test_every_named_schedule_builds(self) -> None:
        for name in ("none", "continuous-gefitinib", "continuous-osimertinib", "continuous-capmatinib",
                     "gefitinib-osimertinib", "osimertinib-capmatinib", "adaptive-gefitinib",
                     "adaptive-osimertinib", "adaptive-capmatinib"):
            build_schedule(name)


class BiologicalSanityTests(unittest.TestCase):
    """Short deterministic-seed runs; the multi-seed versions live in the validation suite."""

    def test_untreated_tumor_grows(self) -> None:
        history = run_single_experiment(schedule_name="none", config=ExperimentConfig(seed=7, steps=30))
        self.assertGreater(history[-1].burden, 1.2 * history[0].burden)
        self.assertGreater(sum(r.births for r in history), 100)

    def test_gefitinib_kills_egfr_and_spares_t790m(self) -> None:
        history = run_single_experiment(schedule_name="continuous-gefitinib", config=ExperimentConfig(seed=7, steps=30))
        self.assertLess(history[-1].egfr, 0.1 * history[0].egfr)
        self.assertGreater(history[-1].t790m, history[0].t790m)
        resistant = history[-1].t790m + history[-1].c797s + history[-1].met_amp
        self.assertGreater(resistant / max(history[-1].burden, 1), 0.9)

    def test_osimertinib_suppresses_t790m_and_c797s_survives(self) -> None:
        history = run_single_experiment(schedule_name="gefitinib-osimertinib", config=ExperimentConfig(seed=7, steps=90, switch_time=40.0))
        # record.time is the time at the END of a step; record.drug is the action decided at its START,
        # so the first osimertinib record is the one ending at day 41.
        at_switch = next(r for r in history if r.time > 40.0)
        self.assertGreater(at_switch.t790m, 50)
        self.assertLess(history[-1].t790m, 0.1 * at_switch.t790m)
        self.assertGreater(history[-1].c797s, at_switch.c797s)
        self.assertEqual(at_switch.drug, "osimertinib")
        self.assertEqual(next(r for r in history if r.time >= 40.0).drug, "gefitinib")


if __name__ == "__main__":
    unittest.main()


class VolumeSanityTests(unittest.TestCase):
    """The 3D extension applies the same rules in a volume with a vascular tree."""

    def _run(self, schedule, steps=40):
        config = ExperimentConfig(seed=7, width=24, height=24, depth=24, cells=400, steps=steps, dt=0.25,
                                  vasculature="tree", switch_time=5.0)
        return run_single_experiment(schedule_name=schedule, config=config)

    def test_untreated_volume_grows_and_stays_bookkept(self) -> None:
        history = self._run("none")
        self.assertGreater(history[-1].burden, 1.5 * history[0].burden)
        for record in history:
            self.assertEqual(record.egfr + record.t790m + record.c797s + record.met_amp, record.burden)
            self.assertEqual(record.proliferating + record.quiescent, record.burden)

    def test_cells_never_occupy_vessel_voxels(self) -> None:
        config = ExperimentConfig(seed=7, width=20, height=20, depth=20, cells=300, steps=20, dt=0.25, vasculature="tree")
        from cancer_sim.experiments import build_runner
        runner = build_runner(schedule_name="none", config=config)
        runner.run(steps=20, dt=0.25)
        world = runner.automata.world
        self.assertTrue(world.blocked)
        self.assertFalse(any(site in world.blocked for site in world._cells))

    def test_gefitinib_selects_t790m_in_a_volume(self) -> None:
        history = self._run("continuous-gefitinib", steps=60)
        self.assertLess(history[-1].egfr, 0.2 * history[0].egfr)
        self.assertGreater(history[-1].t790m, history[0].t790m)

    def test_volume_fields_are_converged_and_bounded(self) -> None:
        config = ExperimentConfig(seed=2, width=16, height=16, depth=16, cells=150, steps=3, dt=0.25, vasculature="tree")
        from cancer_sim.experiments import build_runner
        runner = build_runner(schedule_name="continuous-gefitinib", config=config)
        for _ in range(3):
            runner.step(dt=0.25)
        automata = runner.automata
        self.assertTrue(automata.last_oxygen_solve.converged)
        self.assertTrue(automata.last_drug_solve.converged)
        for field in (automata.world.oxygen.array, automata.world.drug.array):
            self.assertEqual(field.shape, (16, 16, 16))
            self.assertTrue(((field >= 0) & (field <= 1)).all())
