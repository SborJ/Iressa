import unittest
from dataclasses import replace
from unittest.mock import patch

import numpy as np

from cancer_sim.experiments import ExperimentConfig
from cancer_sim.rl_env import ACTION_TABLE, OBSERVATION_NAMES, CancerTreatmentEnv, RLConfig


class CancerTreatmentEnvTest(unittest.TestCase):
    def make_env(self) -> CancerTreatmentEnv:
        config = RLConfig(
            experiment=ExperimentConfig(
                seed=3,
                width=12,
                height=10,
                cells=30,
                steps=4,
                dt=1.0,
                mutation_scale=1.0,
                depth=1,
                vasculature_trunks=3,
                vasculature_max_depth=3,
            ),
            horizon_days=4,
            decision_interval_days=1.0,
            eci_min=0.0,
        )
        return CancerTreatmentEnv(config)

    def test_reset_returns_summary_observation(self) -> None:
        env = self.make_env()

        obs, info = env.reset(seed=11)

        self.assertEqual(obs.shape, (len(OBSERVATION_NAMES),))
        self.assertEqual(info["step"], 0)
        self.assertGreater(info["initial_burden"], 0)

    def test_step_applies_action_and_returns_reward_components(self) -> None:
        env = self.make_env()
        env.reset(seed=11)

        obs, reward, terminated, truncated, info = env.step(2)

        self.assertIsInstance(obs, np.ndarray)
        self.assertIsInstance(reward, float)
        self.assertFalse(terminated)
        self.assertFalse(truncated)
        self.assertEqual(info["step"], 1)
        self.assertEqual(env.action_meaning(2), ACTION_TABLE[2])
        self.assertIn("burden", info["reward_components"])
        self.assertIn("controlled_day", info["reward_components"])
        self.assertIn("eci", info)
        self.assertIn("control_margins", info)
        self.assertIn("escape_distances", info)

    def test_observation_includes_controllability_features(self) -> None:
        env = self.make_env()
        obs, info = env.reset(seed=11)

        names = list(info["observation_names"])
        self.assertEqual(obs.shape, (len(OBSERVATION_NAMES),))
        self.assertIn("EGFR_control_margin", names)
        self.assertIn("EGFR_escape_distance", names)
        self.assertIn("evolutionary_controllability_index", names)
        self.assertIn("treatment_exhausted_fraction", names)

    def test_episode_truncates_at_horizon(self) -> None:
        env = self.make_env()
        env.reset(seed=11)

        truncated = False
        for _ in range(env.max_steps):
            _, _, _, truncated, _ = env.step(0)

        self.assertTrue(truncated)

    def test_ui_episode_records_progression_but_runs_to_horizon(self) -> None:
        baseline = self.make_env().config
        env = CancerTreatmentEnv(replace(baseline, progression_multiplier=0.01, stop_on_progression=False))
        env.reset(seed=11)

        for step in range(1, env.max_steps + 1):
            _, _, terminated, truncated, info = env.step(0)
            self.assertFalse(terminated)
            self.assertEqual(info["first_progression_day"], 1.0)
            self.assertEqual(info["reward_components"]["controlled_day"], 0.0)
            self.assertEqual(truncated, step == env.max_steps)

    def test_invalid_action_is_rejected(self) -> None:
        env = self.make_env()
        env.reset(seed=11)

        with self.assertRaises(ValueError):
            env.step(len(ACTION_TABLE))

    def test_training_episodes_get_distinct_reproducible_seeds(self) -> None:
        from cancer_sim.experiments import build_runner

        observed = []

        def capture(*, schedule_name, config, record_events=False):
            observed.append(config.seed)
            return build_runner(schedule_name=schedule_name, config=config, record_events=record_events)

        with patch('cancer_sim.rl_env.build_runner', side_effect=capture):
            env = self.make_env()
            env.reset(seed=17)
            env.reset()
            env.reset()
            first = observed[:]
            env.reset(seed=17)
            env.reset()
            env.reset()

        self.assertEqual(first, observed[3:])
        self.assertEqual(len(set(first)), 3)


if __name__ == "__main__":
    unittest.main()
