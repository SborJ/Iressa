import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  EventType,
  NO_DRUG,
  NO_VALUE,
  decodeEvents,
  drugOfEvent,
  packStateChange,
  stateOf,
  EventWriter,
} from '../src/format/events.js';
import { decodeKeyframe, encodeKeyframe } from '../src/format/keyframes.js';

function python(code: string): Buffer | undefined {
  try {
    return execFileSync('python3', ['-c', code], {
      cwd: new URL('..', import.meta.url).pathname,
      maxBuffer: 1 << 24,
    });
  } catch {
    return undefined;
  }
}

const available = python('print(1)') !== undefined;

/**
 * The format is the whole contract with the Python simulation, so both ends
 * are checked against each other rather than each against its own idea of it.
 */
describe.skipIf(!available)('python/iressa_format.py agrees with the TypeScript reader', () => {
  it('events written by Python decode here field for field', () => {
    const out = python(`
import sys, os
sys.path.insert(0, 'python')
from iressa_format import EventWriter
w = EventWriter()
w.divide(tick=10, cause=0, clone=0, node=4242, daughter=4243)
w.death_start(tick=11, cause=2, clone=0, node=4242, drug=0)
w.death_start(tick=11, cause=1, clone=3, node=99)
w.removed(tick=21, cause=1, clone=3, node=99)
w.mutate(tick=13, cause=9, from_clone=0, node=4243, to_clone=1)
w.state_change(tick=14, cause=7, clone=0, node=4300, new_state=1, drug=0)
w.state_change(tick=15, cause=5, clone=0, node=4301, new_state=1)
os.write(1, w.bytes())
`)!;
    const events = decodeEvents(new Uint8Array(out));
    expect(events).toHaveLength(7);

    expect(events[0]).toEqual({ tick: 10, type: EventType.Divide, cause: 0, clone: 0, a: 4242, b: 4243 });
    // A drug death carries the drug id in b.
    expect(drugOfEvent(events[1])).toBe(0);
    // A death with no drug carries the sentinel.
    expect(events[2].b).toBe(NO_VALUE);
    expect(drugOfEvent(events[2])).toBe(NO_DRUG);
    expect(events[3].type).toBe(EventType.Removed);
    // A mutation carries the new clone in b and the old one in clone.
    expect(events[4]).toEqual({ tick: 13, type: EventType.Mutate, cause: 9, clone: 0, a: 4243, b: 1 });
    // A state change packs the new state and the drug together.
    expect(stateOf(events[5].b)).toBe(1);
    expect(drugOfEvent(events[5])).toBe(0);
    expect(stateOf(events[6].b)).toBe(1);
    expect(drugOfEvent(events[6])).toBe(NO_DRUG);
  });

  it('events written here decode in Python field for field', () => {
    const w = new EventWriter();
    w.emit(7, EventType.Divide, 0, 2, 1000, 1001);
    w.emit(8, EventType.StateChange, 7, 2, 1000, packStateChange(1, 0));
    w.emit(9, EventType.DeathStart, 2, 2, 1000, 0);
    const hex = Buffer.from(w.bytes()).toString('hex');
    const out = python(`
import sys
sys.path.insert(0, 'python')
from iressa_format import decode_events, state_of, drug_of_state_change
data = bytes.fromhex("${hex}")
for e in decode_events(data):
    extra = ""
    if e.type == 5:
        extra = f" state={state_of(e.b)} drug={drug_of_state_change(e.b)}"
    print(f"{e.tick} {e.type} {e.cause} {e.clone} {e.a} {e.b}{extra}")
`)!;
    expect(out.toString().trim().split('\n')).toEqual([
      '7 1 0 2 1000 1001',
      '8 5 7 2 1000 1 state=1 drug=0',
      '9 2 2 2 1000 0',
    ]);
  });

  it('keyframes round-trip across both implementations', () => {
    const kf = {
      tick: 480,
      grid: { nx: 36, ny: 36, nz: 36 },
      nodes: [
        { node: 0, clone: 0, state: 0, cause: 0 },
        { node: 23310, clone: 1, state: 3, cause: 3 },
        { node: 46655, clone: 2, state: 1, cause: 6 },
      ],
    };
    const hex = Buffer.from(encodeKeyframe(kf)).toString('hex');
    const out = python(`
import sys, os
sys.path.insert(0, 'python')
from iressa_format import decode_keyframe, encode_keyframe
kf = decode_keyframe(bytes.fromhex("${hex}"))
print(f"{kf.tick} {kf.nx} {kf.ny} {kf.nz} {len(kf.nodes)}", file=sys.stderr)
for n in kf.nodes:
    print(f"{n.node} {n.clone} {n.state} {n.cause}", file=sys.stderr)
os.write(1, encode_keyframe(kf))
`)!;
    // Python re-encoded it; it must come back byte-identical.
    expect(decodeKeyframe(new Uint8Array(out))).toEqual(kf);
    expect(Buffer.from(encodeKeyframe(kf)).equals(out)).toBe(true);
  });

  it('resolves cause and state ids from rules.json by role, as the renderer does', () => {
    const out = python(`
import json, sys
sys.path.insert(0, 'python')
from iressa_format import ids_by_role, grid_index
rules = json.load(open('data/rules.json'))
causes = ids_by_role(rules, 'causes')
states = ids_by_role(rules, 'states')
print(causes['drugApoptosis'], causes['hypoxicNecrosis'], states['dying'])
print(grid_index(rules, 1, 2, 3))
`)!;
    const [roles, index] = out.toString().trim().split('\n');
    expect(roles).toBe('2 3 3');
    const g = { nx: 64, ny: 64 };
    expect(Number(index)).toBe(1 + 2 * g.nx + 3 * g.nx * g.ny);
  });
});
