import tempfile
import unittest
from pathlib import Path

from cancer_sim.metrics_viz import read_metrics_csv


class MetricsVizTest(unittest.TestCase):
    def test_read_metrics_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "experiment_metrics.csv"
            path.write_text(
                "experiment,time_to_progression,cumulative_dose,final_resistant_fraction,minimum_burden,final_burden\n"
                "none,10,0,0.2,50,100\n"
            )

            rows = read_metrics_csv(path)

            self.assertEqual(rows[0]["experiment"], "none")
            self.assertEqual(rows[0]["final_burden"], "100")


if __name__ == "__main__":
    unittest.main()

