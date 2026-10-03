import tempfile
import unittest
from pathlib import Path

from cancer_sim.calibration.physics import diffusion_grid_coefficient
from cancer_sim.calibration.pipeline import run_calibration


class CalibrationTest(unittest.TestCase):
    def test_diffusion_grid_coefficient_converts_physical_units(self) -> None:
        value = diffusion_grid_coefficient(
            diffusion_um2_s=500,
            dt_seconds=300,
            dx_um=20
        )

        self.assertEqual(value, 375)

    def test_pipeline_writes_calibrated_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manifest = run_calibration(processed_dir=Path(tmp))

            self.assertIn("calibrated_clone_parameters_json", manifest["outputs"])
            self.assertTrue((Path(tmp) / "calibrated_clone_parameters.json").exists())
            self.assertTrue((Path(tmp) / "calibration_report.md").exists())


if __name__ == "__main__":
    unittest.main()

