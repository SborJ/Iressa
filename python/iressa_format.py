"""
The Iressa wire format, for the simulation that will replace the stand-in.

Write these bytes and the renderer works unchanged. Nothing in this module
knows any biology; it only knows the record layout, which is the whole contract.

    from iressa_format import EventWriter, EventType, pack_state_change

    w = EventWriter()
    w.divide(tick=10, cause=0, clone=0, node=4242, daughter=4243)
    w.death_start(tick=11, cause=2, clone=0, node=4242, drug=0)
    w.state_change(tick=12, cause=7, clone=0, node=4300, new_state=1, drug=0)
    Path("run.events").write_bytes(w.bytes())

A run is three things:

    rules.json      the same file the stand-in reads, validated against
                    data/schema/rules.schema.json
    run.keyframes   one or more keyframes; the tick-0 keyframe is required,
                    because it is what establishes the starting population
    run.events      the events, in non-decreasing tick order

or the same records streamed over a WebSocket, one frame per tick.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from typing import Iterable, Iterator, Sequence

# <  little-endian
# I  tick       u32
# B  type       u8
# B  cause      u8
# H  clone      u16
# I  a          u32
# I  b          u32
EVENT_STRUCT = struct.Struct("<IBBHII")
EVENT_SIZE = EVENT_STRUCT.size
assert EVENT_SIZE == 16

NO_VALUE = 0xFFFFFFFF
NO_DRUG = 0xFF


class EventType:
    DIVIDE = 1
    DEATH_START = 2
    REMOVED = 3
    MUTATE = 4
    STATE_CHANGE = 5


@dataclass(frozen=True, slots=True)
class Event:
    tick: int
    type: int
    cause: int
    clone: int
    a: int
    b: int


def pack_state_change(new_state: int, drug: int = NO_DRUG) -> int:
    """`b` for a state change: the new state in the low byte, the drug above it."""
    return (new_state & 0xFF) | ((drug & 0xFF) << 8)


def state_of(b: int) -> int:
    return b & 0xFF


def drug_of_state_change(b: int) -> int:
    return (b >> 8) & 0xFF


def encode_event(e: Event) -> bytes:
    return EVENT_STRUCT.pack(e.tick, e.type, e.cause, e.clone, e.a, e.b)


def decode_events(data: bytes) -> Iterator[Event]:
    if len(data) % EVENT_SIZE:
        raise ValueError(f"{len(data)} bytes is not a whole number of {EVENT_SIZE}-byte records")
    for offset in range(0, len(data), EVENT_SIZE):
        yield Event(*EVENT_STRUCT.unpack_from(data, offset))


class EventWriter:
    """Collects events in tick order. One helper per event type, so the meaning
    of `a` and `b` is stated once here rather than at every call site."""

    def __init__(self) -> None:
        self._parts: list[bytes] = []
        self._count = 0

    def __len__(self) -> int:
        return self._count

    def emit(self, tick: int, type: int, cause: int, clone: int, a: int, b: int = NO_VALUE) -> None:
        self._parts.append(EVENT_STRUCT.pack(tick, type, cause, clone, a, b))
        self._count += 1

    def divide(self, tick: int, cause: int, clone: int, node: int, daughter: int) -> None:
        self.emit(tick, EventType.DIVIDE, cause, clone, node, daughter)

    def death_start(self, tick: int, cause: int, clone: int, node: int, drug: int = NO_DRUG) -> None:
        self.emit(tick, EventType.DEATH_START, cause, clone, node,
                  NO_VALUE if drug == NO_DRUG else drug)

    def removed(self, tick: int, cause: int, clone: int, node: int, drug: int = NO_DRUG) -> None:
        self.emit(tick, EventType.REMOVED, cause, clone, node,
                  NO_VALUE if drug == NO_DRUG else drug)

    def mutate(self, tick: int, cause: int, from_clone: int, node: int, to_clone: int) -> None:
        self.emit(tick, EventType.MUTATE, cause, from_clone, node, to_clone)

    def state_change(self, tick: int, cause: int, clone: int, node: int,
                     new_state: int, drug: int = NO_DRUG) -> None:
        self.emit(tick, EventType.STATE_CHANGE, cause, clone, node,
                  pack_state_change(new_state, drug))

    def bytes(self) -> bytes:
        return b"".join(self._parts)

    def clear(self) -> None:
        self._parts.clear()
        self._count = 0


# --------------------------------------------------------------------------- #
# Keyframes
# --------------------------------------------------------------------------- #

KEYFRAME_MAGIC = 0x314B4649  # 'IKF1'
KEYFRAME_HEADER = struct.Struct("<IIIIII8x")
KEYFRAME_NODE = struct.Struct("<IHBB")
KEYFRAME_HEADER_SIZE = KEYFRAME_HEADER.size
assert KEYFRAME_HEADER_SIZE == 32
assert KEYFRAME_NODE.size == 8


@dataclass(frozen=True, slots=True)
class KeyframeNode:
    node: int
    clone: int
    state: int
    cause: int


@dataclass(frozen=True, slots=True)
class Keyframe:
    tick: int
    nx: int
    ny: int
    nz: int
    nodes: Sequence[KeyframeNode]


def encode_keyframe(kf: Keyframe) -> bytes:
    out = bytearray(
        KEYFRAME_HEADER.pack(KEYFRAME_MAGIC, kf.tick, len(kf.nodes), kf.nx, kf.ny, kf.nz)
    )
    for n in kf.nodes:
        out += KEYFRAME_NODE.pack(n.node, n.clone, n.state, n.cause)
    return bytes(out)


def decode_keyframe(data: bytes) -> Keyframe:
    magic, tick, count, nx, ny, nz = KEYFRAME_HEADER.unpack_from(data, 0)
    if magic != KEYFRAME_MAGIC:
        raise ValueError(f"not a keyframe: magic 0x{magic:08x}")
    nodes = [
        KeyframeNode(*KEYFRAME_NODE.unpack_from(data, KEYFRAME_HEADER_SIZE + i * KEYFRAME_NODE.size))
        for i in range(count)
    ]
    return Keyframe(tick=tick, nx=nx, ny=ny, nz=nz, nodes=nodes)


# --------------------------------------------------------------------------- #
# Reading the cause and state tables out of rules.json
#
# A simulation looks its ids up by role, exactly as the stand-in does, so the
# numbers stay in the data file.
# --------------------------------------------------------------------------- #

def ids_by_role(rules: dict, table: str) -> dict[str, int]:
    """{'drugApoptosis': 2, ...} from rules['causes'] or rules['states']."""
    return {entry["role"]: entry["id"] for entry in rules[table] if "role" in entry}


def grid_index(rules: dict, x: int, y: int, z: int) -> int:
    g = rules["grid"]
    return x + y * g["nx"] + z * g["nx"] * g["ny"]
