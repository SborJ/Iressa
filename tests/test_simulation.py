import random
import unittest

from cancer_sim.automata import AutomataConfig, CellularAutomataPhysics
from cancer_sim.simulation import (
    AdaptiveAT50Treatment,
    ContinuousTreatment,
    SimulationRunner,
    SwitchTreatment
)
from cancer_sim.world import ScalarField, Vessel, WorldConfig, WorldPhysics


class SimulationTest(unittest.TestCase):
    def make_runner(self, schedule) -> SimulationRunner:
        world = WorldPhysics(WorldConfig(width=6, height=6), vessels=[Vessel(0, 0)])
        world.oxygen = ScalarField(6, 6, default=0.9)
        world.drug = ScalarField(6, 6, default=0.0)
        world.place_clone(3, 3, "EGFR")
        automata = CellularAutomataPhysics(
            world,
            config=AutomataConfig(
                oxygen_diffusion=0.0,
                oxygen_uptake_rate=0.0,
                oxygen_vessel_source=0.0,
                drug_diffusion=0.0,
                drug_vessel_source=0.0
            ),
            rng=random.Random(1)
        )
        return SimulationRunner(automata, schedule)

    def test_continuous_treatment_records_history(self) -> None:
        runner = self.make_runner(ContinuousTreatment("gefitinib", dose=0.5))

        history = runner.run(steps=3)

        self.assertEqual(len(history), 3)
        self.assertEqual(history[0].drug, "gefitinib")
        self.assertEqual(history[0].dose, 0.5)

    def test_switch_treatment_changes_drug_after_switch_time(self) -> None:
        runner = self.make_runner(SwitchTreatment(switch_time=1.0))

        history = runner.run(steps=3)

        self.assertEqual(history[0].drug, "gefitinib")
        self.assertEqual(history[1].drug, "osimertinib")

    def test_switch_treatment_uses_time_days_not_step_number(self) -> None:
        runner = self.make_runner(SwitchTreatment(switch_time=1.0))

        history = runner.run(steps=3, dt=0.5)

        self.assertEqual([record.time for record in history], [0.5, 1.0, 1.5])
        self.assertEqual([record.drug for record in history], ["gefitinib", "gefitinib", "osimertinib"])

    def test_adaptive_treatment_can_turn_off_at_50_percent(self) -> None:
        schedule = AdaptiveAT50Treatment("gefitinib", dose=1.0)

        first = schedule.action(time=0, burden=10, initial_burden=10)
        second = schedule.action(time=1, burden=5, initial_burden=10)

        self.assertEqual(first.drug, "gefitinib")
        self.assertEqual(second.drug, "none")


if __name__ == "__main__":
    unittest.main()
