import unittest

from cancer_sim.mutation_flow import MutationFlowGenerator, tree_to_dict


class MutationFlowTest(unittest.TestCase):
    def test_same_seed_produces_same_tree(self) -> None:
        generator = MutationFlowGenerator.from_seed_data()

        first = tree_to_dict(generator.generate(seed=11))
        second = tree_to_dict(generator.generate(seed=11))

        self.assertEqual(first, second)

    def test_different_seeds_can_produce_different_trees(self) -> None:
        generator = MutationFlowGenerator.from_seed_data(branch_chance=0.5)

        first = tree_to_dict(generator.generate(seed=1))
        second = tree_to_dict(generator.generate(seed=2))

        self.assertNotEqual(first, second)

    def test_render_includes_allowed_resistance_clones(self) -> None:
        generator = MutationFlowGenerator.from_seed_data(branch_chance=1.0)
        tree = generator.generate(seed=3)

        output = generator.render_tree(tree)

        self.assertIn("EGFR", output)
        self.assertIn("T790M", output)
        self.assertIn("MET_AMP", output)


if __name__ == "__main__":
    unittest.main()

