import unittest

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

    def test_episode_truncates_at_horizon(self) -> None:
        env = self.make_env()
        env.reset(seed=11)

        truncated = False
        for _ in range(env.max_steps):
            _, _, _, truncated, _ = env.step(0)

        self.assertTrue(truncated)

    def test_invalid_action_is_rejected(self) -> None:
        env = self.make_env()
        env.reset(seed=11)

        with self.assertRaises(ValueError):
            env.step(len(ACTION_TABLE))


if __name__ == "__main__":
    unittest.main()
