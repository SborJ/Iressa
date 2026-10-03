import argparse
import unittest

from cancer_sim.automata import AutomataConfig
from cancer_sim.config_controls import add_microenvironment_args, apply_microenvironment_args


class ConfigControlsTest(unittest.TestCase):
    def parse(self, args: list[str]):
        parser = argparse.ArgumentParser()
        add_microenvironment_args(parser)
        return parser.parse_args(args)

    def test_oxygen_presets_change_supply(self) -> None:
        base = AutomataConfig()

        vascular = apply_microenvironment_args(base, self.parse(["--oxygen-mode", "vascular"]))
        necrotic = apply_microenvironment_args(base, self.parse(["--oxygen-mode", "necrotic"]))

        self.assertGreater(vascular.oxygen_vessel_source, necrotic.oxygen_vessel_source)
        self.assertLess(vascular.necrosis_threshold, necrotic.necrosis_threshold)

    def test_manual_override_wins_over_preset(self) -> None:
        base = AutomataConfig()

        config = apply_microenvironment_args(
            base,
            self.parse(["--oxygen-mode", "hypoxic", "--oxygen-source", "0.77"])
        )

        self.assertEqual(config.oxygen_vessel_source, 0.77)


if __name__ == "__main__":
    unittest.main()

