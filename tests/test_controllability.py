import math
import unittest

from cancer_sim.automata import ClonePhenotype, ResistanceTransition
from cancer_sim.controllability import evaluate_tumor_controllability, treatment_kill_rate
from cancer_sim.simulation import SimulationRecord, TreatmentAction


def phenotype(
    clone_id: str,
    *,
    growth: float = 0.2,
    gefitinib_ic50: float = 100.0,
    osimertinib_ic50: float = 100.0,
    capmatinib_ic50: float = 100.0,
) -> ClonePhenotype:
    return ClonePhenotype(
        clone_id=clone_id,
        growth_rate=growth,
        fitness_cost=0.0,
        gefitinib_ic50_nm=gefitinib_ic50,
        osimertinib_ic50_nm=osimertinib_ic50,
        capmatinib_ic50_nm=capmatinib_ic50,
        allowed_next_resistance_transitions=(),
        hill_coefficient=1.0,
        max_drug_death_rate=0.5,
    )


def record(**counts) -> SimulationRecord:
    egfr = counts.get("egfr", 50)
    t790m = counts.get("t790m", 0)
    c797s = counts.get("c797s", 0)
    met_amp = counts.get("met_amp", 0)
    burden = egfr + t790m + c797s + met_amp
    return SimulationRecord(
        step=1,
        time=1.0,
        drug="none",
        dose=0.0,
        burden=burden,
        births=0,
        mutations=0,
        drug_deaths=0,
        hypoxic_deaths=0,
        proliferating=burden,
        quiescent=0,
        necrotic=0,
        mean_oxygen=0.8,
        mean_drug=0.0,
        egfr=egfr,
        t790m=t790m,
        c797s=c797s,
        met_amp=met_amp,
    )


class ControllabilityTest(unittest.TestCase):
    def test_treatment_kill_rate_uses_hill_response(self) -> None:
        response = phenotype("EGFR", growth=0.2, gefitinib_ic50=100.0)

        kill = treatment_kill_rate(
            response,
            TreatmentAction("gefitinib", 1.0),
            vessel_concentration_nm={"gefitinib": 100.0},
        )

        self.assertAlmostEqual(kill, 0.25)

    def test_positive_margin_means_some_action_controls_clone(self) -> None:
        responses = {
            "EGFR": phenotype("EGFR", growth=0.1, gefitinib_ic50=20.0),
            "T790M": phenotype("T790M"),
            "C797S": phenotype("C797S"),
            "MET_AMP": phenotype("MET_AMP"),
        }

        control = evaluate_tumor_controllability(
            record=record(egfr=50),
            initial_burden=50,
            clone_responses=responses,
            transitions={},
            allowed_actions=(TreatmentAction("none", 0.0), TreatmentAction("gefitinib", 1.0)),
        )

        self.assertGreater(control.margin("EGFR"), 0)
        self.assertFalse(control.clones["EGFR"].treatment_exhausted)

    def test_negative_margin_marks_modeled_treatment_exhaustion(self) -> None:
        responses = {
            "EGFR": phenotype("EGFR", growth=0.8, gefitinib_ic50=1e9, osimertinib_ic50=1e9, capmatinib_ic50=1e9),
            "T790M": phenotype("T790M"),
            "C797S": phenotype("C797S"),
            "MET_AMP": phenotype("MET_AMP"),
        }

        control = evaluate_tumor_controllability(
            record=record(egfr=50),
            initial_burden=50,
            clone_responses=responses,
            transitions={},
        )

        self.assertLess(control.margin("EGFR"), 0)
        self.assertIn("EGFR", [
            clone_id for clone_id, item in control.clones.items() if item.treatment_exhausted
        ])

    def test_escape_distance_uses_resistance_graph(self) -> None:
        responses = {
            "EGFR": phenotype("EGFR", growth=0.1, gefitinib_ic50=20.0),
            "T790M": phenotype("T790M", growth=0.8, gefitinib_ic50=1e9, osimertinib_ic50=1e9, capmatinib_ic50=1e9),
            "C797S": phenotype("C797S"),
            "MET_AMP": phenotype("MET_AMP"),
        }
        transitions = {
            "EGFR": [
                ResistanceTransition("EGFR", "T790M", "EGFR_T790M", 1e-4),
            ]
        }

        control = evaluate_tumor_controllability(
            record=record(egfr=50),
            initial_burden=50,
            clone_responses=responses,
            transitions=transitions,
            horizon_days=30.0,
        )

        self.assertGreater(control.escape_distance("EGFR"), 0)
        self.assertTrue(math.isfinite(control.escape_distance("EGFR")))
        self.assertEqual(control.escape_distance("T790M"), 0.0)


if __name__ == "__main__":
    unittest.main()
