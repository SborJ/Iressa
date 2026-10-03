"""Phase 2 guard: the validated scientific engine must not change during UI integration."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import engine_freeze  # noqa: E402


class EngineFreezeTest(unittest.TestCase):
    def test_protected_engine_files_match_the_freeze_manifest(self) -> None:
        problems = engine_freeze.verify()
        self.assertEqual(problems, [], "\n".join(problems))


if __name__ == "__main__":
    unittest.main()
