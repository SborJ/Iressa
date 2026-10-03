"""The ER+/HER2- breast model: the biology checks a controller must pass before RL.

These follow the validation list in docs/breast_er_positive.md (endocrine
sensitivity, ESR1 selection and its release, Y537S > D538G resistance, CDK
escape fold-change) on the small 2D section the lung engine was validated on.
Numbers are cell-model calibration values, so the tests assert directions and
orderings, not clinical quantities.
"""

import random
import unittest
from dataclasses import replace

from cancer_sim.automata import CellularAutomataPhysics, load_clone_model
from cancer_sim.cancers import load_cancer_model
from cancer_sim.controllability import evaluate_tumor_controllability, model_actions
from cancer_sim.experiments import ExperimentConfig, build_runner, run_single_experiment
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig
from cancer_sim.simulation import CloneTriggeredSwitchTreatment, TreatmentAction, build_schedule
from cancer_sim.world_seed import build_seeded_world

BREAST = load_cancer_model("breast_er_her2neg")
WT, Y537S, D538G, CDK = BREAST.clone_ids


def breast_config(**overrides) -> ExperimentConfig:
    base = ExperimentConfig(cancer="breast_er_her2neg", seed=5, steps=30, dose=1.0, mutation_scale=0.0,
                            clone_weights=(100.0, 0.0, 0.0, 0.0))
    return replace(base, **overrides)


def fraction(record, clone_id: str) -> float:
    return record.count(clone_id) / max(record.burden, 1)


class BreastModelDefinitionTest(unittest.TestCase):
    def test_model_has_the_mvp_clones_and_drugs(self) -> None:
        self.assertEqual(BREAST.clone_ids, ("ESR1_WT", "ESR1_Y537S", "ESR1_D538G", "CDK_ESCAPE"))
        self.assertEqual(BREAST.drug_ids, ("endocrine", "palbociclib", "fulvestrant", "elacestrant"))
        self.assertFalse(BREAST.drug("endocrine").diffusing, "aromatase inhibition is a global environment, not a field")
        self.assertTrue(BREAST.drug("palbociclib").diffusing)
        self.assertEqual(BREAST.resistant_clones, ("ESR1_Y537S", "ESR1_D538G", "CDK_ESCAPE"))

    def test_every_parameter_carries_an_evidence_level(self) -> None:
        levels = set(BREAST.parameters["evidence_levels"])
        for clone in BREAST.parameters["clones"]:
            for key in ("growth_rate_per_day", "fitness_cost", "hill_coefficient", "max_drug_death_rate_per_day"):
                self.assertIn(clone[key]["evidence"], levels, f"{clone['id']}.{key}")
            for drug, response in clone["drug_response"].items():
                for key, entry in response.items():
                    self.assertIn(entry["evidence"], levels, f"{clone['id']}.{drug}.{key}")
        for edge in BREAST.parameters["transitions"]:
            self.assertEqual(edge["simulation_probability"]["evidence"], "ASSUMPTION")

    def test_y537s_is_more_fulvestrant_resistant_than_d538g_than_wild_type(self) -> None:
        responses, _ = load_clone_model(model=BREAST)
        self.assertLess(responses[WT].ic50("fulvestrant"), responses[D538G].ic50("fulvestrant"))
        self.assertLess(responses[D538G].ic50("fulvestrant"), responses[Y537S].ic50("fulvestrant"))
        # the published fold changes: ~19x and ~50x the wild-type IC50
        self.assertAlmostEqual(responses[D538G].ic50("fulvestrant") / responses[WT].ic50("fulvestrant"), 15.0, delta=5.0)
        self.assertAlmostEqual(responses[Y537S].ic50("fulvestrant") / responses[WT].ic50("fulvestrant"), 50.0, delta=12.0)

    def test_cdk_escape_is_3_to_15_fold_less_palbociclib_sensitive(self) -> None:
        responses, _ = load_clone_model(model=BREAST)
        ratio = responses[CDK].ic50("palbociclib") / responses[WT].ic50("palbociclib")
        self.assertGreaterEqual(ratio, 3.0)
        self.assertLessEqual(ratio, 15.0)

    def test_esr1_mutants_carry_the_2_7x_palbociclib_cross_resistance(self) -> None:
        responses, _ = load_clone_model(model=BREAST)
        for clone in (Y537S, D538G):
            self.assertAlmostEqual(responses[clone].ic50("palbociclib") / responses[WT].ic50("palbociclib"), 2.7, delta=0.05)


class BreastDynamicsTest(unittest.TestCase):
    def test_1_endocrine_pressure_slows_a_wild_type_tumour(self) -> None:
        untreated = run_single_experiment(schedule_name="none", config=breast_config())
        treated = run_single_experiment(schedule_name="continuous-endocrine", config=breast_config())
        self.assertGreater(untreated[-1].burden, untreated[0].burden)
        self.assertLess(treated[-1].burden, 0.7 * untreated[-1].burden)

    def test_combination_controls_more_than_endocrine_alone(self) -> None:
        endocrine = run_single_experiment(schedule_name="continuous-endocrine", config=breast_config())
        combo = run_single_experiment(schedule_name="continuous-endocrine-cdk", config=breast_config())
        self.assertLess(combo[-1].burden, endocrine[-1].burden)
        self.assertEqual(set(combo[-1].exposures), {"endocrine", "palbociclib"})

    def test_2_endocrine_pressure_selects_esr1_mutants(self) -> None:
        config = breast_config(clone_weights=(95.0, 5.0, 0.0, 0.0), steps=40)
        history = run_single_experiment(schedule_name="continuous-endocrine", config=config)
        self.assertGreater(fraction(history[-1], Y537S), 2.0 * fraction(history[0], Y537S))

    def test_3_releasing_selection_does_not_let_the_mutant_take_over(self) -> None:
        config = breast_config(clone_weights=(90.0, 10.0, 0.0, 0.0), steps=40)
        history = run_single_experiment(schedule_name="none", config=config)
        self.assertLess(fraction(history[-1], Y537S), fraction(history[0], Y537S) + 0.05)

    def test_4_and_5_serd_resistance_ordering_in_the_running_engine(self) -> None:
        rng = random.Random(1)
        world = build_seeded_world(20, 20, 60, rng, clone_weights=(1.0, 1.0, 1.0, 0.0), clones=BREAST.clone_ids)
        automata = CellularAutomataPhysics(world, rng=rng, model=BREAST)
        exposure_nm = automata.reference_concentration_nm("fulvestrant")
        wt = automata.drug_effect(WT, "fulvestrant", exposure_nm)
        d538g = automata.drug_effect(D538G, "fulvestrant", exposure_nm)
        y537s = automata.drug_effect(Y537S, "fulvestrant", exposure_nm)
        self.assertGreater(wt, d538g)
        self.assertGreater(d538g, y537s)
        self.assertGreater(wt, 0.95)

    def test_switch_to_serd_adds_a_second_diffusing_field(self) -> None:
        runner = build_runner(schedule_name="endocrine-cdk-then-serd-cdk",
                              config=breast_config(switch_time=3.0, steps=6))
        runner.run(steps=3)
        self.assertEqual(set(runner.automata.drug_fields), {"palbociclib"})
        runner.run(steps=3)
        self.assertEqual(set(runner.automata.drug_fields), {"fulvestrant", "palbociclib"})
        self.assertEqual(set(runner.history[-1].exposures), {"fulvestrant", "palbociclib"})
        self.assertGreater(runner.automata.drug_fields["fulvestrant"].array.max(), 0.0)

    def test_unknown_or_foreign_drugs_are_rejected(self) -> None:
        rng = random.Random(2)
        world = build_seeded_world(12, 12, 20, rng, clone_weights=(1.0, 0.0, 0.0, 0.0), clones=BREAST.clone_ids)
        automata = CellularAutomataPhysics(world, rng=rng, model=BREAST)
        with self.assertRaises(ValueError):
            automata.step(drug="gefitinib", vessel_drug_dose=1.0)
        with self.assertRaises(ValueError):
            automata.step(exposures={"palbociclib": -0.1})
        lung_world = build_seeded_world(12, 12, 20, random.Random(3))
        lung = CellularAutomataPhysics(lung_world, rng=random.Random(3))
        with self.assertRaises(ValueError):
            lung.step(drug="palbociclib", vessel_drug_dose=1.0)

    def test_clone_triggered_switch_fires_on_the_mutant_share(self) -> None:
        schedule = build_schedule("early-switch-esr1-10", model=BREAST)
        self.assertIsInstance(schedule, CloneTriggeredSwitchTreatment)
        before = schedule.action(time=1.0, burden=100, initial_burden=100, clone_counts={WT: 95, Y537S: 5})
        self.assertEqual(set(before.exposures), {"endocrine", "palbociclib"})
        after = schedule.action(time=2.0, burden=100, initial_burden=100, clone_counts={WT: 88, Y537S: 12})
        self.assertEqual(set(after.exposures), {"fulvestrant", "palbociclib"})
        self.assertEqual(schedule.switch_time, 2.0)
        # one-way: the mutant share falling again does not switch back
        later = schedule.action(time=3.0, burden=100, initial_burden=100, clone_counts={WT: 99, Y537S: 1})
        self.assertEqual(set(later.exposures), {"fulvestrant", "palbociclib"})


class BreastControlTest(unittest.TestCase):
    def test_controllability_sees_the_mutants_as_the_escape_route(self) -> None:
        runner = build_runner(schedule_name="none", config=breast_config(clone_weights=(98.0, 1.0, 1.0, 0.0)))
        automata = runner.automata
        control = evaluate_tumor_controllability(
            record=None, initial_burden=runner.initial_burden,
            clone_responses=automata.clone_responses, transitions=automata.transitions,
            allowed_actions=model_actions(BREAST),
            vessel_concentration_nm={d: automata.reference_concentration_nm(d) for d in BREAST.drug_ids},
            clone_ids=BREAST.clone_ids,
        )
        # Sensitive cells are controllable (M > 0) by a CDK4/6-containing combination.
        self.assertGreater(control.margin(WT), 0.0)
        self.assertIn("palbociclib", control.clones[WT].best_action.exposures)
        self.assertEqual(len(control.clones[WT].best_action.exposures), 2)
        # The ESR1 mutants and the CDK escape are worse off than wild type under every
        # represented action; Y537S (strong fulvestrant resistance) is worse than D538G.
        self.assertGreater(control.margin(WT), control.margin(D538G))
        self.assertGreater(control.margin(D538G), control.margin(Y537S))
        self.assertGreater(control.margin(WT), control.margin(CDK))
        serds = {"fulvestrant", "elacestrant"}
        self.assertTrue(serds & set(control.clones[Y537S].best_action.exposures),
                        "a SERD is the best represented answer to an ESR1 mutant")
        self.assertIn("elacestrant", control.clones[D538G].best_action.exposures,
                      "the oral SERD is what brings D538G to the controllability boundary")
        # A treatment-exhausted clone exists, so an escape distance is defined for wild type.
        self.assertTrue(any(c.treatment_exhausted for c in control.clones.values()))
        self.assertTrue(0.0 < control.clones[WT].escape_distance < float("inf"))

    def test_rl_environment_runs_on_the_breast_model(self) -> None:
        env = CancerTreatmentEnv(RLConfig(experiment=breast_config(steps=5, clone_weights=(98.0, 1.0, 1.0, 0.0)),
                                          horizon_days=5.0))
        self.assertEqual(len(env.action_table), 65)   # 5 levels x (1 + 3 x 4) after the exclusive-group mask
        self.assertEqual(env.action_table[0], TreatmentAction("none", 0.0))
        obs, info = env.reset(seed=5)
        self.assertEqual(obs.shape, (len(env.observation_names),))
        self.assertIn("ESR1_Y537S_control_margin", env.observation_names)
        self.assertIn("cumulative_fulvestrant", env.observation_names)
        combo = next(i for i, a in enumerate(env.action_table) if set(a.exposures) == {"endocrine", "palbociclib"})
        obs, reward, terminated, truncated, info = env.step(combo)
        self.assertEqual(info["cancer"], "breast_er_her2neg")
        self.assertEqual(obs.shape, (len(env.observation_names),))
        self.assertGreater(info["cumulative_dose"]["endocrine"], 0.0)
        self.assertGreater(info["cumulative_dose"]["palbociclib"], 0.0)


if __name__ == "__main__":
    unittest.main()
