"""The live two-way session and the plain-language decision labels."""

import json
import unittest

from cancer_sim.cancers import load_cancer_model
from cancer_sim.live import LiveRequest, LiveSession
from cancer_sim.narration import describe_decision, describe_exposures

BREAST = load_cancer_model("breast_er_her2neg")


def small_session(**kw) -> LiveSession:
    request = LiveRequest(cancer="breast_er_her2neg", size=16, depth=1, cells=60, days=6, seed=3, mutation_scale=0.0, **kw)
    return LiveSession(request)


class NarrationTest(unittest.TestCase):
    def test_labels_read_as_sentences(self) -> None:
        first = {"endocrine": 1.0, "palbociclib": 1.0}
        self.assertEqual(describe_decision(BREAST, None, first), "starting endocrine suppression 100% + palbociclib 100%")
        self.assertEqual(describe_decision(BREAST, first, first), "held endocrine suppression 100% + palbociclib 100%")
        switched = describe_decision(BREAST, first, {"fulvestrant": 1.0, "palbociclib": 1.0}, resistant_fraction=0.102)
        self.assertEqual(switched, "switched the endocrine drug from endocrine suppression to fulvestrant 100%, kept palbociclib (resistant share 10%)")
        self.assertEqual(describe_decision(BREAST, first, {}), "treatment holiday: all agents stopped")
        self.assertEqual(describe_decision(BREAST, {}, {"elacestrant": 0.75}, actor="AI"), "AI: started elacestrant 75%")
        self.assertEqual(describe_decision(BREAST, {"palbociclib": 0.5}, {"palbociclib": 1.0}), "raised palbociclib to 100%")
        self.assertEqual(describe_exposures(BREAST, {}), "no treatment")

    def test_labels_never_use_forbidden_words(self) -> None:
        text = " ".join([
            describe_decision(BREAST, None, {"endocrine": 1.0}),
            describe_decision(BREAST, {"endocrine": 1.0}, {}, resistant_fraction=0.3),
        ]).lower()
        for word in ("cure", "incurable", "optimal treatment"):
            self.assertNotIn(word, text)


class LiveSessionTest(unittest.TestCase):
    def test_request_validation(self) -> None:
        req = LiveRequest.from_json({"cancer": "breast_er_her2neg", "size": 24, "cells": 300, "days": 30, "randomize": True})
        self.assertEqual((req.size, req.cells, req.days, req.randomize), (24, 300, 30.0, True))
        with self.assertRaises(ValueError):
            LiveRequest.from_json({"size": 4})
        with self.assertRaises(ValueError):
            LiveRequest.from_json({"days": 0})

    def test_hello_carries_rules_presets_and_drugs(self) -> None:
        session = small_session()
        hello = session.hello()
        json.dumps(hello)   # must be serialisable as a text frame
        self.assertEqual(hello["cancer"]["id"], "breast_er_her2neg")
        self.assertEqual([d["id"] for d in hello["drugs"]], list(BREAST.drug_ids))
        self.assertEqual(hello["presets"][0], {"id": "none", "label": "no treatment", "exposures": {}})
        self.assertTrue(any(p["exposures"] == {"endocrine": 1.0, "palbociclib": 1.0} for p in hello["presets"]))
        rules = hello["rules"]
        self.assertEqual([c["name"] for c in rules["clones"]][0], "ER-sensitive (ESR1 wild type)")
        self.assertEqual(rules["treatment"]["schedule"], [], "the schedule is decided live")
        self.assertEqual(rules["provenance"]["live"]["mode"], "two-way")
        self.assertIsNone(hello["policy"])

    def test_advance_applies_the_viewer_s_treatment_and_labels_it(self) -> None:
        session = small_session()
        self.assertGreater(len(session.keyframe()), 16)
        first = session.advance()
        self.assertFalse(first["done"])
        self.assertEqual(first["reading"]["action"], "no treatment")
        self.assertEqual(first["reading"]["label"], "no treatment")
        session.set_exposures({"endocrine": 1.0, "palbociclib": 0.5})
        second = session.advance()
        self.assertEqual(second["reading"]["exposures"], {"endocrine": 1.0, "palbociclib": 0.5})
        self.assertEqual(second["reading"]["label"], "started endocrine suppression 100% + palbociclib 50%")
        self.assertIsInstance(second["keyframe"], bytes)
        self.assertTrue(all(len(f) % 16 == 0 and len(f) > 0 for f in second["events"]))
        self.assertEqual(second["reading"]["day"], 2.0)
        self.assertIn("clones", second["reading"])
        with self.assertRaises(ValueError):
            session.set_exposures({"gefitinib": 1.0})
        with self.assertRaises(ValueError):
            session.set_auto(True)   # no policy loaded

    def test_session_ends_at_the_horizon(self) -> None:
        session = small_session()
        for _ in range(6):
            result = session.advance()
        self.assertTrue(result["done"])
        self.assertTrue(session.finished)
        self.assertEqual(session.advance()["reading"], None)


class LiveProtocolTest(unittest.TestCase):
    def test_websocket_round_trip(self) -> None:
        import asyncio
        try:
            import websockets
        except ImportError:  # pragma: no cover
            self.skipTest("websockets not installed")
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
        import serve_live

        async def run() -> dict:
            server_task = asyncio.create_task(serve_live.serve("127.0.0.1", 8799, None, None))
            await asyncio.sleep(0.3)
            try:
                async with websockets.connect("ws://127.0.0.1:8799", max_size=None) as ws:
                    await ws.send(json.dumps({"type": "start", "cancer": "breast_er_her2neg", "size": 16, "depth": 1, "cells": 60, "days": 3, "mutation_scale": 0}))
                    hello = json.loads(await ws.recv())
                    keyframe0 = await ws.recv()
                    await ws.send(json.dumps({"type": "set_exposures", "exposures": {"palbociclib": 1.0}}))
                    ack = json.loads(await ws.recv())
                    await ws.send(json.dumps({"type": "advance"}))
                    frames = []
                    while True:
                        msg = await ws.recv()
                        if isinstance(msg, (bytes, bytearray)):
                            frames.append(msg)
                        else:
                            day = json.loads(msg)
                            break
                    await ws.send(json.dumps({"type": "auto", "auto": True}))
                    err = json.loads(await ws.recv())
                    return {"hello": hello["type"], "keyframe0": isinstance(keyframe0, (bytes, bytearray)), "ack": ack,
                            "frames": len(frames), "day": day, "err": err}
            finally:
                server_task.cancel()

        result = asyncio.run(run())
        self.assertEqual(result["hello"], "hello")
        self.assertTrue(result["keyframe0"])
        self.assertEqual(result["ack"], {"type": "treatment", "exposures": {"palbociclib": 1.0}, "auto": False})
        self.assertGreaterEqual(result["frames"], 1, "events and/or the day's keyframe")
        self.assertEqual(result["day"]["type"], "day")
        self.assertTrue(result["day"]["reading"]["label"].startswith("starting palbociclib 100%"), result["day"]["reading"]["label"])
        self.assertEqual(result["err"]["type"], "error")


if __name__ == "__main__":
    unittest.main()
