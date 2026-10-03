import tempfile
import unittest
from pathlib import Path

from cancer_sim.experiments import ExperimentConfig, calculate_metrics, run_experiment_panel
from cancer_sim.simulation import SimulationRecord


def record(time: float, burden: int, t790m: int = 0, c797s: int = 0, met: int = 0) -> SimulationRecord:
    return SimulationRecord(
        step=int(time),
        time=time,
        drug="none",
        dose=0.0,
        burden=burden,
        births=1,
        mutations=0,
        drug_deaths=0,
        hypoxic_deaths=0,
        proliferating=burden,
        quiescent=0,
        necrotic=0,
        mean_oxygen=0.5,
        mean_drug=0.0,
        egfr=max(burden - t790m - c797s - met, 0),
        t790m=t790m,
        c797s=c797s,
        met_amp=met
    )


class ExperimentMetricsTest(unittest.TestCase):
    def test_calculate_metrics_tracks_progression_and_resistance(self) -> None:
        history = [
            record(1, 100, t790m=10),
            record(2, 50, t790m=20),
            record(3, 70, t790m=40)
        ]

        metrics = calculate_metrics("demo", 7, history)

        self.assertEqual(metrics.minimum_burden, 50)
        self.assertEqual(metrics.time_to_progression, 3)
        self.assertGreater(metrics.final_resistant_fraction, 0.5)
        self.assertEqual(metrics.time_to_resistant_dominance, 3)

    def test_run_experiment_panel_writes_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            metrics = run_experiment_panel(
                config=ExperimentConfig(width=12, height=10, cells=30, steps=3),
                schedules=("none", "continuous-gefitinib"),
                output_dir=Path(tmp)
            )

            self.assertEqual(len(metrics), 2)
            self.assertTrue((Path(tmp) / "experiment_metrics.csv").exists())


if __name__ == "__main__":
    unittest.main()

