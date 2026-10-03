"""Spec sections 20-23, 36, 41-49: fitness reversal, establishment, dynamic
escape distance, the masked action grid, reward terms, domain randomisation,
baselines (regrowth switch, adaptive holiday, random, MPC) and the comparison
metrics, on the ER+/HER2- model."""

import random
import unittest
from dataclasses import replace

from cancer_sim.automata import CellularAutomataPhysics
from cancer_sim.cancers import load_cancer_model
from cancer_sim.controllability import action_grid, evaluate_tumor_controllability, model_actions
from cancer_sim.experiments import ExperimentConfig, build_runner, run_single_experiment
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig, sample_domain
from cancer_sim.rl_eval import (
    EpisodeMetrics, cvar, fixed_policy_factory, mpc_policy_factory, random_policy_factory, run_episode, summarize, summary_markdown,
)
from cancer_sim.simulation import RegrowthTriggeredSwitchTreatment, TreatmentAction, build_schedule
from cancer_sim.world_seed import build_seeded_world

BREAST = load_cancer_model("breast_er_her2neg")
WT, Y537S, D538G, CDK = BREAST.clone_ids


def cfg(**overrides) -> ExperimentConfig:
    base = ExperimentConfig(cancer="breast_er_her2neg", seed=5, steps=20, dose=1.0, mutation_scale=0.0,
                            clone_weights=(98.0, 1.0, 1.0, 0.0))
    return replace(base, **overrides)


def env_for(steps=6, **overrides) -> CancerTreatmentEnv:
    return CancerTreatmentEnv(RLConfig(experiment=cfg(steps=steps, **overrides), horizon_days=float(steps)))


class FitnessReversalTest(unittest.TestCase):
    def test_mutant_fitness_cost_vanishes_under_estrogen_deprivation(self) -> None:
        rng = random.Random(1)
        world = build_seeded_world(16, 16, 40, rng, clone_weights=(1.0, 1.0, 0.0, 0.0), clones=BREAST.clone_ids)
        automata = CellularAutomataPhysics(world, rng=rng, model=BREAST)
        x, y, z = next(iter(world.occupied_sites()))
        automata.step(dt=0.1)                                    # no drug: the mutant pays its cost
        self.assertLess(automata.fitness_multiplier(Y537S, x, y, z), 1.0)
        unpressured = automata.local_growth_rate(Y537S, x, y, z) / automata.local_growth_rate(WT, x, y, z)
        automata.step(dt=0.1, exposures={"endocrine": 1.0})     # deprivation: the cost is relieved, WT is held back
        self.assertGreater(automata.fitness_multiplier(Y537S, x, y, z), 0.985)
        pressured = automata.local_growth_rate(Y537S, x, y, z) / automata.local_growth_rate(WT, x, y, z)
        self.assertLess(unpressured, 1.0)
        self.assertGreater(pressured, 1.5, "relative fitness reverses with the estrogen environment")

    def test_lung_phenotypes_are_untouched_by_the_new_terms(self) -> None:
        lung = CellularAutomataPhysics(build_seeded_world(12, 12, 20, random.Random(2)), rng=random.Random(2))
        self.assertIsNone(lung.establishment_base)
        for response in lung.clone_responses.values():
            self.assertFalse(response.environment_dependent)


class EstablishmentTest(unittest.TestCase):
    def test_establishment_follows_relative_fitness_under_the_current_drug(self) -> None:
        rng = random.Random(3)
        world = build_seeded_world(16, 16, 40, rng, clone_weights=(1.0, 0.0, 0.0, 0.0), clones=BREAST.clone_ids)
        automata = CellularAutomataPhysics(world, rng=rng, model=BREAST)
        x, y, z = next(iter(world.occupied_sites()))
        self.assertAlmostEqual(automata.establishment_base, 0.5)
        automata.step(dt=0.1)
        without = automata.establishment_probability(WT, Y537S, x, y, z)
        automata.step(dt=0.1, exposures={"endocrine": 1.0})
        with_pressure = automata.establishment_probability(WT, Y537S, x, y, z)
        self.assertLess(without, 0.5, "a costly mutant establishes less often than the base without pressure")
        self.assertEqual(with_pressure, 1.0, "under deprivation the mutant out-divides its parent and always establishes")


class DynamicEscapeDistanceTest(unittest.TestCase):
    def test_escape_route_shortens_under_endocrine_pressure(self) -> None:
        runner = build_runner(schedule_name="none", config=cfg())
        automata = runner.automata
        conc = {d: automata.reference_concentration_nm(d) for d in BREAST.drug_ids}
        actions = model_actions(BREAST)
        endocrine = next(a for a in actions if a.exposures == {"endocrine": 1.0, "palbociclib": 1.0})
        serd = next(a for a in actions if a.exposures == {"elacestrant": 1.0, "palbociclib": 1.0})
        def distance(action):
            control = evaluate_tumor_controllability(
                record=None, initial_burden=runner.initial_burden, clone_responses=automata.clone_responses,
                transitions=automata.transitions, allowed_actions=actions, vessel_concentration_nm=conc,
                clone_ids=BREAST.clone_ids, current_action=action, establishment_base=automata.establishment_base)
            return control.escape_distance(WT)
        static, under_endocrine, under_serd = distance(None), distance(endocrine), distance(serd)
        self.assertTrue(0 < under_endocrine < static, f"{under_endocrine} vs static {static}")
        self.assertGreater(under_serd, under_endocrine, "the SERD does not favour the ESR1 mutants the way deprivation does")


class ActionGridTest(unittest.TestCase):
    def test_grid_has_65_masked_actions_with_no_treatment_first(self) -> None:
        actions = model_actions(BREAST)
        self.assertEqual(len(actions), 65)
        self.assertEqual(actions[0], TreatmentAction("none", 0.0))
        endocrine_agents = {"endocrine", "fulvestrant", "elacestrant"}
        for action in actions:
            self.assertLessEqual(len(endocrine_agents & set(action.exposures)), 1, action.label)
            for dose in action.exposures.values():
                self.assertIn(dose, (0.25, 0.5, 0.75, 1.0))
        self.assertEqual(len({frozenset(a.exposures.items()) for a in actions}), 65, "no duplicates")

    def test_grid_respects_a_max_agents_rule(self) -> None:
        actions = action_grid({"levels": [0, 1], "agents": ["a", "b", "c"], "max_simultaneous_agents": 1})
        self.assertEqual(len(actions), 4)


class RewardAndRandomisationTest(unittest.TestCase):
    def test_reward_has_eci_improvement_and_toxicity_terms(self) -> None:
        env = env_for()
        env.reset(seed=5)
        heavy = next(i for i, a in enumerate(env.action_table) if a.total_dose >= 2.0)
        _, _, _, _, info = env.step(heavy)
        components = info["reward_components"]
        self.assertIn("eci_improvement", components)
        self.assertLess(components["toxicity"], 0.0, "two agents at full exposure count as a toxic day")
        self.assertEqual(info["toxic_days"], 1)
        _, _, _, _, info = env.step(0)
        self.assertEqual(info["reward_components"]["toxicity"], 0.0)
        self.assertEqual(info["toxic_days"], 1)

    def test_fractions_only_observation_zeroes_the_controllability_features(self) -> None:
        full = CancerTreatmentEnv(RLConfig(experiment=cfg(steps=3), horizon_days=3.0))
        bare = CancerTreatmentEnv(RLConfig(experiment=cfg(steps=3), horizon_days=3.0, observation_mode="fractions_only"))
        obs_full, _ = full.reset(seed=5)
        obs_bare, _ = bare.reset(seed=5)
        self.assertEqual(obs_full.shape, obs_bare.shape)
        names = full.observation_names
        for i, name in enumerate(names):
            if "margin" in name or "escape" in name or name in ("evolutionary_controllability_index", "treatment_exhausted_fraction"):
                self.assertEqual(obs_bare[i], 0.0, name)
            else:
                self.assertEqual(obs_full[i], obs_bare[i], name)
        self.assertTrue(any(obs_full[i] != 0.0 for i, n in enumerate(names) if "margin" in n))

    def test_domain_randomisation_is_seeded_and_within_the_declared_ranges(self) -> None:
        block = BREAST.raw["randomization"]
        a, theta_a = sample_domain(BREAST, cfg(), random.Random(11))
        b, theta_b = sample_domain(BREAST, cfg(), random.Random(11))
        c, theta_c = sample_domain(BREAST, cfg(), random.Random(12))
        self.assertEqual(theta_a, theta_b)
        self.assertNotEqual(theta_a, theta_c)
        for key, value in theta_a.items():
            self.assertTrue(block[key]["min"] <= value <= block[key]["max"], key)
        self.assertAlmostEqual(sum(a.clone_weights), 100.0)
        self.assertEqual(a.clone_weights[3], 0.0, "CDK escape is not seeded; it arises by transition")
        self.assertEqual(a.mutation_scale, theta_a["mutation_scale"])

    def test_randomised_episodes_apply_the_draw_to_the_running_engine(self) -> None:
        env = CancerTreatmentEnv(RLConfig(experiment=cfg(steps=3), horizon_days=3.0, randomize=True))
        _, info = env.reset(seed=21)
        theta = info["randomization"]
        self.assertTrue(theta)
        responses = env._runner.automata.clone_responses
        self.assertAlmostEqual(responses[Y537S].fitness_cost, theta["resistant_fitness_cost"])
        self.assertAlmostEqual(responses[WT].fitness_cost, 0.0)
        self.assertAlmostEqual(responses[CDK].ic50("palbociclib") / responses[WT].ic50("palbociclib"), theta["cdk_resistance_multiplier"], places=6)
        self.assertAlmostEqual(responses[WT].ic50("fulvestrant"), 0.4 * theta["ic50_multiplier"])
        self.assertAlmostEqual(env._runner.automata.reference_concentration_nm("elacestrant"),
                               theta["reference_concentration_nm"] * theta["vessel_concentration_scale"], places=6)
        plain = CancerTreatmentEnv(RLConfig(experiment=cfg(steps=3), horizon_days=3.0))
        _, plain_info = plain.reset(seed=21)
        self.assertEqual(plain_info["randomization"], {})


class BaselineTest(unittest.TestCase):
    def test_regrowth_triggered_switch_waits_for_response_then_regrowth(self) -> None:
        schedule = build_schedule("late-switch-regrowth", model=BREAST)
        self.assertIsInstance(schedule, RegrowthTriggeredSwitchTreatment)
        first = set(schedule.action(time=0, burden=100, initial_burden=100).exposures)
        self.assertEqual(first, {"endocrine", "palbociclib"})
        schedule.action(time=1, burden=70, initial_burden=100)      # responded, nadir 70
        schedule.action(time=2, burden=60, initial_burden=100)      # nadir 60
        still = set(schedule.action(time=3, burden=70, initial_burden=100).exposures)
        self.assertEqual(still, {"endocrine", "palbociclib"}, "70 < 1.2 x 60")
        after = set(schedule.action(time=4, burden=73, initial_burden=100).exposures)
        self.assertEqual(after, {"fulvestrant", "palbociclib"})
        self.assertEqual(schedule.switch_time, 4)

    def test_adaptive_holiday_uses_the_declared_thresholds(self) -> None:
        schedule = build_schedule("adaptive-holiday-30-60", model=BREAST)
        self.assertEqual(schedule.stop_fraction, 0.3)
        self.assertEqual(schedule.restart_fraction, 0.6)
        self.assertEqual(schedule.action(time=0, burden=100, initial_burden=100).label, "endocrine+palbociclib")
        self.assertEqual(schedule.action(time=1, burden=29, initial_burden=100).label, "none")
        self.assertEqual(schedule.action(time=2, burden=50, initial_burden=100).label, "none")
        self.assertEqual(schedule.action(time=3, burden=61, initial_burden=100).label, "endocrine+palbociclib")

    def test_every_panel_schedule_replays_through_the_action_table(self) -> None:
        for name in BREAST.default_panel:
            env = env_for(steps=3)
            metrics = run_episode(name=name, env=env, policy=fixed_policy_factory(name, cancer=BREAST)(), seed=5)
            self.assertEqual(metrics.steps, 3, name)

    def test_random_and_mpc_baselines_run(self) -> None:
        env = env_for(steps=3)
        rnd = run_episode(name="random", env=env, policy=random_policy_factory(1)(), seed=5)
        self.assertEqual(rnd.steps, 3)
        env = env_for(steps=2)
        mpc = run_episode(name="mpc", env=env, policy=mpc_policy_factory(BREAST, horizon_steps=2)(), seed=5)
        self.assertEqual(mpc.steps, 2)
        self.assertGreater(mpc.cumulative_dose, 0.0, "MPC prefers treating to not treating on a growing tumour")

    def test_mpc_does_not_disturb_the_real_episode(self) -> None:
        env = env_for(steps=2)
        obs, info = env.reset(seed=7)
        before = env._runner.automata.living_cell_count()
        mpc_policy_factory(BREAST, horizon_steps=2)()(env, info)
        self.assertEqual(env._runner.automata.living_cell_count(), before)
        self.assertEqual(env._runner.automata.time, 0.0)


class MetricsTest(unittest.TestCase):
    def test_episode_metrics_carry_the_comparison_quantities(self) -> None:
        env = env_for(steps=4)
        metrics = run_episode(name="continuous-endocrine-cdk", env=env,
                              policy=fixed_policy_factory("continuous-endocrine-cdk", cancer=BREAST)(), seed=5)
        self.assertEqual(metrics.horizon_days, 4.0)
        self.assertGreater(metrics.burden_auc, 0.0)
        self.assertGreaterEqual(metrics.controlled_days, 0.0)
        self.assertTrue(0.0 <= metrics.mean_eci <= 1.0)
        self.assertLessEqual(metrics.control_time, metrics.horizon_days)

    def test_cvar_is_the_lower_tail(self) -> None:
        self.assertEqual(cvar([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.10), 10.0)
        self.assertEqual(cvar([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.20), 15.0)
        self.assertEqual(cvar([5.0], 0.10), 5.0)

    def test_summary_and_markdown(self) -> None:
        def m(policy, seed, loss):
            return EpisodeMetrics(policy=policy, seed=seed, total_reward=1.0, initial_burden=100, final_burden=50, minimum_burden=40,
                                  max_resistant_fraction=0.2, final_resistant_fraction=0.1, cumulative_dose=10.0, switches=1, steps=10,
                                  horizon_days=10.0, time_to_loss_of_control=loss, controlled_days=8.0, burden_auc=7.0, mean_eci=0.3, final_eci=0.2)
        rows = summarize([m("a", 1, None), m("a", 2, 4.0), m("b", 1, 2.0)])
        by = {r["policy"]: r for r in rows}
        self.assertEqual(by["a"]["control_time_median"], 7.0)
        self.assertEqual(by["a"]["control_time_min"], 4.0)
        self.assertEqual(by["a"]["lost_control_fraction"], 0.5)
        self.assertEqual(by["b"]["control_time_median"], 2.0)
        table = summary_markdown(rows, "t")
        self.assertIn("| a |", table)
        self.assertIn("Control (d, worst 10%)", table)


class PhysicsChecksTest(unittest.TestCase):
    """Spec section 48, tests 7 and 8: the shared physics, run on the breast model."""

    def test_7_oxygen_gradient_rim_interior_core(self) -> None:
        # Vessels 300 um apart on a dense 2D section: next to a vessel oxygen is high and
        # cells cycle; between vessels oxygen falls, cells arrest, and the farthest die.
        config = cfg(width=40, height=40, cells=1100, steps=25, vessel_spacing_um=300.0, oxygen_mm_vmax=0.05,
                     clone_weights=(100.0, 0.0, 0.0, 0.0))
        runner = build_runner(schedule_name="none", config=config)
        runner.run(steps=25)
        world = runner.automata.world
        vessels = [(v.x, v.y) for v in world.vessels]
        near: list[tuple[float, str]] = []
        far: list[tuple[float, str]] = []
        for (x, y, z), cell in world._cells.items():
            d = min(((x - vx) ** 2 + (y - vy) ** 2) ** 0.5 for vx, vy in vessels)
            (near if d <= 2.0 else far if d >= 5.0 else []).append((world.oxygen.get(x, y, z), cell.state))
        self.assertGreaterEqual(len(near), 20)
        self.assertGreaterEqual(len(far), 20)
        mean_o2 = lambda group: sum(o for o, _ in group) / len(group)
        frac = lambda group, *states: sum(1 for _, st in group if st in states) / len(group)
        self.assertGreater(mean_o2(near), mean_o2(far), "oxygen falls away from the vessels")
        self.assertGreater(frac(near, "proliferating"), frac(far, "proliferating"), "the oxygenated rim cycles more")
        self.assertGreater(frac(far, "quiescent", "necrotic"), frac(near, "quiescent", "necrotic"), "the interior is arrested or dead")
        self.assertGreater(runner.history[-1].necrotic, 0, "a necrotic core exists far from every vessel")

    def test_8_population_growth_is_space_limited_but_not_at_clinical_scale(self) -> None:
        # The population doubling time emerges from crowding and oxygen, much slower than
        # the 1.8-day cell cycle, and growth stalls once the lattice is full. The clinical
        # 150-500 d target is NOT reached, and the model file says so.
        import math
        config = cfg(width=40, height=40, cells=120, steps=60, clone_weights=(100.0, 0.0, 0.0, 0.0))
        history = run_single_experiment(schedule_name="none", config=config)
        third = len(history) // 3
        early, mid, late = history[0].burden, history[third].burden, history[2 * third].burden
        self.assertGreater(mid, early)
        doublings = math.log2(max(mid, 1) / max(early, 1))
        effective_doubling = (history[third].time - history[0].time) / max(doublings, 1e-9)
        self.assertGreater(effective_doubling, 3 * 1.8, "the population doubles far slower than its cells could")
        self.assertLess(history[-1].burden, 1.15 * late, "growth stalls as the section fills")
        target = BREAST.raw["growth"]["effective_tumor_doubling_target_days"]
        self.assertIn("NOT REPRODUCED", target["status"])
        self.assertLess(effective_doubling, target["min"], "the in-vitro-timescale engine does not reach clinical doubling times")


if __name__ == "__main__":
    unittest.main()
