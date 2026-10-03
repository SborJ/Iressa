"""
Stream a recorded run over a WebSocket, one frame per tick.

    pip install websockets
    python python/serve.py run.events run.keyframes

Then open the viewer at:

    http://localhost:5173/?source=socket&url=ws://localhost:8787

This exists to pin down the streaming half of the contract. The real simulation
sends the same frames as it computes them instead of reading them from a file.

The protocol is as small as it looks:
  * a binary frame starting with the keyframe magic is a keyframe
  * any other binary frame is a whole number of 16-byte event records that all
    carry the same tick
  * a text frame is JSON; {"done": true} ends the run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from itertools import groupby
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from iressa_format import EVENT_SIZE, KEYFRAME_MAGIC, decode_events, decode_keyframe, encode_event

try:
    import websockets
except ImportError:  # pragma: no cover - the example needs one dependency
    sys.exit("this example needs `pip install websockets`")


def load_run(events_path: Path, keyframes_path: Path | None):
    events = list(decode_events(events_path.read_bytes()))
    keyframes: dict[int, bytes] = {}
    if keyframes_path and keyframes_path.exists():
        data = keyframes_path.read_bytes()
        offset = 0
        while offset < len(data):
            kf = decode_keyframe(data[offset:])
            size = 32 + len(kf.nodes) * 8
            keyframes[kf.tick] = data[offset : offset + size]
            offset += size
    return events, keyframes


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("events", type=Path)
    ap.add_argument("keyframes", type=Path, nargs="?")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--ticks-per-second", type=float, default=8.0)
    args = ap.parse_args()

    events, keyframes = load_run(args.events, args.keyframes)
    by_tick = [(tick, list(group)) for tick, group in groupby(events, key=lambda e: e.tick)]
    delay = 1.0 / args.ticks_per_second
    print(f"{len(events)} events over {len(by_tick)} ticks, {len(keyframes)} keyframes")

    async def handler(ws):
        sent_keyframes: set[int] = set()
        for tick, group in by_tick:
            for kf_tick in sorted(t for t in keyframes if t <= tick and t not in sent_keyframes):
                sent_keyframes.add(kf_tick)
                await ws.send(keyframes[kf_tick])
            await ws.send(b"".join(encode_event(e) for e in group))
            await asyncio.sleep(delay)
        await ws.send(json.dumps({"done": True}))

    async with websockets.serve(handler, "localhost", args.port, max_size=None):
        print(f"serving ws://localhost:{args.port} at {args.ticks_per_second} ticks/s")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
