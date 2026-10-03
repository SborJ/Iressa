"""An exported run must replay in the viewer's format to exactly the engine's final matrix,
and its rules.json must satisfy the viewer's schema and cross-checks."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

import jsonschema  # noqa: E402
from iressa_format import EventType, decode_events, decode_keyframe, state_of  # noqa: E402

from cancer_sim.experiments import ExperimentConfig, build_runner  # noqa: E402
from cancer_sim.iressa_export import CLONE_IDS, STATE_FOR_CELL, export_run  # noqa: E402

SCHEMA = json.load(open(ROOT / "data" / "schema" / "rules.schema.json"))


def _keyframes(data: bytes):
    out, offset = [], 0
    while offset < len(data):
        kf = decode_keyframe(data[offset:])
        out.append(kf)
        offset += 32 + 8 * len(kf.nodes)
    return out


def _replay(initial, events, rules):
    """Apply the viewer's replay semantics (docs/format.md) to a {node: (clone, state)} matrix."""
    dying = next(s["id"] for s in rules["states"] if s.get("role") == "dying")
    cycling = next(s["id"] for s in rules["states"] if s.get("role") == "cycling")
    m = {n.node: (n.clone, n.state) for n in initial.nodes}
    for e in events:
        if e.type == EventType.DIVIDE:
            assert e.b not in m, f"tick {e.tick}: divide into occupied node {e.b}"
            m[e.b] = (e.clone, cycling)
        elif e.type == EventType.DEATH_START:
            m[e.a] = (m[e.a][0], dying)
        elif e.type == EventType.REMOVED:
            del m[e.a]
        elif e.type == EventType.MUTATE:
            m[e.a] = (e.b, m[e.a][1])
        elif e.type == EventType.STATE_CHANGE:
            m[e.a] = (m[e.a][0], state_of(e.b))
    return m


def _engine_matrix(world, rules):
    state_id = {k: next(s["id"] for s in rules["states"] if s.get("role") == v) for k, v in STATE_FOR_CELL.items()}
    offset = 0 if world.config.depth > 1 else world.config.width * world.config.height   # 2D sections sit at z = 1
    return {world.config.node_index(x, y, z) + offset: (CLONE_IDS[c.clone_id], state_id[c.state]) for (x, y, z), c in world._cells.items()}


class ExportTest(unittest.TestCase):
    def _check(self, config, schedule, name):
        with tempfile.TemporaryDirectory() as tmp:
            summary = export_run(config, schedule, name=name, out_root=Path(tmp), keyframe_every_days=2.0)
            out = Path(tmp) / name
            rules = json.load(open(out / "rules.json"))
            jsonschema.validate(rules, SCHEMA)
            events = list(decode_events((out / "run.events").read_bytes()))
            keyframes = _keyframes((out / "run.keyframes").read_bytes())
            self.assertEqual(keyframes[0].tick, 0)
            nz = config.depth if config.depth > 1 else 3
            self.assertEqual((keyframes[0].nx, keyframes[0].ny, keyframes[0].nz), (config.width, config.height, nz))
            self.assertEqual(rules["grid"]["nz"], nz)
            ticks = [e.tick for e in events]
            self.assertEqual(ticks, sorted(ticks))
            # an identical engine run gives the matrix the replay must reach
            runner = build_runner(schedule_name=schedule, config=config)
            runner.run(steps=config.steps, dt=config.dt)
            final = _engine_matrix(runner.automata.world, rules)
            replayed = _replay(keyframes[0], events, rules)
            self.assertEqual(replayed, final)
            # every later keyframe equals the replay up to its tick
            for kf in keyframes[1:]:
                upto = [e for e in events if e.tick < kf.tick]
                self.assertEqual(_replay(keyframes[0], upto, rules), {n.node: (n.clone, n.state) for n in kf.nodes}, f"keyframe tick {kf.tick}")
            self.assertEqual(summary["events"], len(events))
            # ids are the viewer's roles, not hard-coded numbers
            roles = {c["role"] for c in rules["causes"] if "role" in c}
            self.assertTrue({"normalCycle", "drugApoptosis", "hypoxicNecrosis", "crowdingArrest", "hypoxiaArrest", "mutation"} <= roles)
            self.assertEqual(len(rules["clones"]), 4)
            self.assertEqual(len(rules["drugs"]), 3)
            self.assertTrue(rules["vasculature"]["segments"])
            return rules, events

    def test_3d_tree_run_replays_exactly(self):
        config = ExperimentConfig(seed=3, width=20, height=20, depth=20, cells=300, steps=24, dt=0.25,
                                  vasculature="tree", switch_time=3.0, clone_weights=(90, 8, 1, 1))
        rules, events = self._check(config, "gefitinib-osimertinib", "t3d")
        self.assertTrue(any(e.type == EventType.DEATH_START for e in events))
        self.assertTrue(any(e.type == EventType.DIVIDE for e in events))
        self.assertEqual([s["drug"] for s in rules["treatment"]["schedule"]], [0, 1])

    def test_2d_section_run_replays_exactly(self):
        config = ExperimentConfig(seed=5, width=30, height=24, depth=1, cells=150, steps=10, dt=1.0)
        self._check(config, "continuous-gefitinib", "t2d")

    def test_dt_must_be_whole_ticks(self):
        with self.assertRaises(ValueError):
            with tempfile.TemporaryDirectory() as tmp:
                export_run(ExperimentConfig(seed=1, width=10, height=10, cells=20, steps=2, dt=0.3), "none", name="bad", out_root=Path(tmp))


if __name__ == "__main__":
    unittest.main()
