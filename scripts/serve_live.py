#!/usr/bin/env python3
"""Serve live, two-way simulation sessions to the 3D viewer over a WebSocket.

    python3 scripts/serve_live.py                         # ws://localhost:8788
    python3 scripts/serve_live.py --policy outputs/rl_breast/ppo_breast.zip

Each connection is one session. The viewer sends JSON text frames:

    {"type": "start", "cancer": "breast_er_her2neg", "size": 32, "cells": 600, "days": 120, ...}
    {"type": "advance"}                       one simulated day, please
    {"type": "set_exposures", "exposures": {"endocrine": 1.0, "palbociclib": 0.5}}
    {"type": "auto", "auto": true}            let the loaded policy choose
    {"type": "reset"}

and receives the viewer's own stream: binary event-record frames and keyframes
(exactly what a recorded run holds), plus JSON frames:

    {"type": "hello", "rules": {...}, "drugs": [...], "presets": [...], "policy": ..., "auto": ...}
    {"type": "day", "reading": {...}, "done": false}      after each day's frames
    {"type": "treatment", "exposures": {...}, "auto": ...}
    {"type": "error", "message": "..."}

The dev server starts this on demand (see vite.config.ts); it can also be run
by hand. Research simulation only; nothing here is clinical advice.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.live import LiveRequest, LiveSession, PolicyLibrary  # noqa: E402


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8788)
    p.add_argument("--policy", type=Path, default=None,
                   help="an extra PPO .zip to try when outputs/rl/ppo_<cancer>.zip does not exist")
    p.add_argument("--policy-name", default=None)
    return p.parse_args()


async def serve(host: str, port: int, policy_path: Path | None, policy_name: str | None, policy_root: Path = ROOT) -> None:
    try:
        import websockets
    except ImportError:  # pragma: no cover
        sys.exit("the live server needs `pip install websockets`")

    library = PolicyLibrary(root=policy_root, explicit=policy_path)

    def build(request: LiveRequest) -> LiveSession:
        session = LiveSession(request)
        policy, found, reason = library.for_session(session.env)
        session.policy = policy
        session.policy_name = (policy_name or found) if policy else ""
        session.no_policy_reason = reason
        return session

    async def handler(ws):
        session: LiveSession | None = None
        loop = asyncio.get_running_loop()

        async def send_json(payload: dict) -> None:
            await ws.send(json.dumps(payload))

        async def send_session_start(s: LiveSession) -> None:
            await send_json(s.hello())
            await ws.send(s.keyframe())

        async for raw in ws:
            if isinstance(raw, (bytes, bytearray)):
                continue
            try:
                msg = json.loads(raw)
                kind = msg.get("type")
                if kind == "start":
                    request = LiveRequest.from_json(msg)
                    # building a 3D session takes a moment; keep the event loop free
                    session = await loop.run_in_executor(None, lambda: build(request))
                    if msg.get("auto") and session.policy is not None:
                        session.set_auto(True)
                    await send_session_start(session)
                elif session is None:
                    await send_json({"type": "error", "message": "send a start message first"})
                elif kind == "advance":
                    result = await loop.run_in_executor(None, session.advance)
                    for frame in result["events"]:
                        await ws.send(frame)
                    if result["keyframe"] is not None:
                        await ws.send(result["keyframe"])
                    await send_json({"type": "day", "reading": result["reading"], "done": result["done"]})
                elif kind == "set_exposures":
                    exposures = session.set_exposures(msg.get("exposures") or {})
                    await send_json({"type": "treatment", "exposures": exposures, "auto": session.auto})
                elif kind == "auto":
                    auto = session.set_auto(bool(msg.get("auto")))
                    await send_json({"type": "treatment", "exposures": dict(session.exposures), "auto": auto})
                elif kind == "reset":
                    request = session.request
                    keep = (dict(session.exposures), session.auto)
                    session = await loop.run_in_executor(None, lambda: build(request))
                    session.exposures, session.auto = keep[0], keep[1] and session.policy is not None
                    await send_session_start(session)
                else:
                    await send_json({"type": "error", "message": f"unknown message type {kind!r}"})
            except (ValueError, KeyError, TypeError) as exc:
                await send_json({"type": "error", "message": str(exc)})

    async with websockets.serve(handler, host, port, max_size=None):
        print(f"iressa live simulator on ws://{host}:{port} (policies: outputs/rl/ppo_<cancer>.zip)", flush=True)
        await asyncio.Future()


def main() -> int:
    args = parse_args()
    try:
        asyncio.run(serve(args.host, args.port, args.policy, args.policy_name))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
