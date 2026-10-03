# The event format

This is the contract between a simulation and everything that draws it. A
simulation that writes these bytes works with the renderer unchanged.

A run is three things:

| | |
|---|---|
| `rules.json` | validated against `data/schema/rules.schema.json` |
| keyframes | full snapshots. **The tick-0 keyframe is required** — it is what establishes the starting population |
| events | 16-byte records in non-decreasing tick order |

or the same records streamed, one frame per tick.

## The record

16 bytes, little-endian:

| offset | size | field | |
|---|---|---|---|
| 0 | 4 | `tick` | u32 |
| 4 | 1 | `type` | u8 |
| 5 | 1 | `cause` | u8 — an id from the cause table in `rules.json` |
| 6 | 2 | `clone` | u16 — the clone the node belonged to when the event fired |
| 8 | 4 | `a` | u32 — the node |
| 12 | 4 | `b` | u32 — see below |

`type`:

| | | `b` holds |
|---|---|---|
| 1 | divide | the daughter node |
| 2 | death start | the drug id for a drug cause, else `0xffffffff` |
| 3 | removed | the drug id for a drug cause, else `0xffffffff` |
| 4 | mutate | the new clone (`clone` holds the old one) |
| 5 | state change | the new state, packed with the drug (below) |

A node index is `x + y·nx + z·nx·ny`.

### `b` for a state change

A drug-caused state change has to carry both the state the cell moved to and
which drug moved it, so they share the field:

```
bits 0–7    the new state id
bits 8–15   the drug id, or 0xff for none
```

`packStateChange` / `pack_state_change` build it; `stateOf` / `state_of` and
`drugOfStateChange` / `drug_of_state_change` read it back. `drugOfEvent` reads
the drug out of either carrier, so callers do not have to branch on type.

## Keyframes

Header, little-endian:

| offset | size | field |
|---|---|---|
| 0 | 4 | magic `IKF1` (`0x314b4649`) |
| 4 | 4 | tick, u32 |
| 8 | 4 | node count, u32 |
| 12 | 12 | grid nx, ny, nz, u32 each |
| 24 | 8 | reserved |

then 8 bytes per node: node u32, clone u16, state u8, cause u8.

**A keyframe is the state at the start of its tick**, so a consumer applies the
keyframe and then that tick's events without double-counting. A keyframe is a
packet in its own right: a tick can carry a keyframe and no events at all, and
tick 0 routinely does.

## Streaming

One WebSocket, binary frames:

- a frame beginning with the keyframe magic is a keyframe
- any other binary frame is a whole number of event records that all carry the
  same tick
- a text frame is JSON; `{"done": true}` ends the run

`python/serve.py` is a working example. `src/source/socketSource.ts` is the
client.

## Where the ids come from

Nothing in the format fixes what cause 3 means. The cause table in `rules.json`
does:

```json
{ "id": 3, "name": "hypoxic necrosis", "role": "hypoxicNecrosis",
  "kind": "death", "animation": "necrosis",
  "label": "Necrosis: hypoxia", "dyingTicks": 48 }
```

- `role` is how a **simulator** finds the id it should emit. Ask for the cause
  whose role is `hypoxicNecrosis`; never write `3`. `ids_by_role` in
  `python/iressa_format.py` does this for the Python side.
- `animation` is how the **renderer** finds the preset in `visuals.json`.
- `label` is what the **hover card** shows; `{drug}` and `{clone}` are
  substituted from the event.
- `kind` groups it for the tally and the chart.

A cause with no `role` is one the stand-in simulator never emits — it is there
for a simulation that does. Causes the stand-in cannot run without are checked
at startup, and a missing one is a named error rather than a silent default.

## What a consumer must do

Replaying the stream must reproduce the matrix exactly. `tests/simulator.test.ts`
and `tests/sources.test.ts` assert this both for the live simulator and for a
recorded run, node by node.

- **divide**: the daughter at `b` is new, in the cycling state, with clone `clone`
- **mutate**: the node's clone becomes `b`
- **death start**: the node moves to the dying state with this cause
- **removed**: the node is gone
- **state change**: the node moves to `stateOf(b)` with this cause
