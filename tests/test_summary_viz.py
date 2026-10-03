import tempfile
import unittest
from pathlib import Path

from cancer_sim.summary_viz import read_history_csv


class SummaryVizTest(unittest.TestCase):
    def test_read_history_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "history.csv"
            path.write_text("time,burden,EGFR,T790M,C797S,MET_AMP,drug\n1,10,8,1,0,1,gefitinib\n")

            rows = read_history_csv(path)

            self.assertEqual(rows[0]["drug"], "gefitinib")
            self.assertEqual(rows[0]["MET_AMP"], "1")


if __name__ == "__main__":
    unittest.main()

