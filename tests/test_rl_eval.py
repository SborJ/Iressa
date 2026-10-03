import unittest

from cancer_sim.experiments import ExperimentConfig
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig
from cancer_sim.rl_eval import evaluate_policy, fixed_policy_factory, summarize


class RLEvaluationTest(unittest.TestCase):
    def make_env(self, seed: int) -> CancerTreatmentEnv:
        config = RLConfig(
            experiment=ExperimentConfig(
                seed=seed,
                width=12,
                height=10,
                cells=30,
                mutation_scale=1.0,
                depth=1,
                vasculature_trunks=3,
                vasculature_max_depth=3,
            ),
            horizon_days=3,
            decision_interval_days=1.0,
        )
        return CancerTreatmentEnv(config)

    def test_evaluate_fixed_policy_across_seeds(self) -> None:
        metrics = evaluate_policy(
            name="continuous-gefitinib",
            env_factory=self.make_env,
            policy_factory=fixed_policy_factory("continuous-gefitinib"),
            seeds=[1, 2],
        )

        self.assertEqual(len(metrics), 2)
        self.assertEqual({item.policy for item in metrics}, {"continuous-gefitinib"})
        self.assertTrue(all(item.steps == 3 for item in metrics))

    def test_summary_groups_by_policy(self) -> None:
        metrics = evaluate_policy(
            name="none",
            env_factory=self.make_env,
            policy_factory=fixed_policy_factory("none"),
            seeds=[1, 2],
        )

        rows = summarize(metrics)

        self.assertEqual(rows[0]["policy"], "none")
        self.assertEqual(rows[0]["n"], 2)
        self.assertIn("progression_fraction", rows[0])
        self.assertIn("progression_day_median", rows[0])


if __name__ == "__main__":
    unittest.main()
