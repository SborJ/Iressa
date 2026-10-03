import { describe, expect, it } from 'vitest';
import {
  EVENT_SIZE,
  EventType,
  EventWriter,
  NO_DRUG,
  NO_VALUE,
  decodeEvents,
  drugOfEvent,
  drugOfStateChange,
  packStateChange,
  readEvent,
  stateOf,
  writeEvent,
} from '../src/format/events.js';
import { decodeKeyframe, encodeKeyframe } from '../src/format/keyframes.js';

describe('event record', () => {
  it('is 16 bytes', () => {
    expect(EVENT_SIZE).toBe(16);
  });

  it('round-trips every field at its maximum', () => {
    const buf = new ArrayBuffer(EVENT_SIZE);
    const view = new DataView(buf);
    const e = { tick: 0xfffffffe, type: 5, cause: 255, clone: 65535, a: 0xfffffffd, b: 0xfffffffc };
    writeEvent(view, 0, e);
    expect(readEvent(view, 0)).toEqual(e);
  });

  it('writes and reads a packed block in order', () => {
    const w = new EventWriter(2);
    for (let i = 0; i < 100; i++) w.emit(i, EventType.Divide, 0, 1, i, i + 1);
    const bytes = w.bytes();
    expect(bytes.byteLength).toBe(100 * EVENT_SIZE);
    const events = decodeEvents(bytes);
    expect(events).toHaveLength(100);
    expect(events[42]).toEqual({ tick: 42, type: 1, cause: 0, clone: 1, a: 42, b: 43 });
  });

  it('packs the new state and the drug into b for a state change', () => {
    const b = packStateChange(3, 7);
    expect(stateOf(b)).toBe(3);
    expect(drugOfStateChange(b)).toBe(7);
    const noDrug = packStateChange(1);
    expect(stateOf(noDrug)).toBe(1);
    expect(drugOfStateChange(noDrug)).toBe(NO_DRUG);
  });

  it('reads the drug out of either carrier', () => {
    expect(
      drugOfEvent({ tick: 0, type: EventType.StateChange, cause: 7, clone: 0, a: 1, b: packStateChange(1, 0) }),
    ).toBe(0);
    expect(drugOfEvent({ tick: 0, type: EventType.DeathStart, cause: 2, clone: 0, a: 1, b: 0 })).toBe(0);
    expect(
      drugOfEvent({ tick: 0, type: EventType.DeathStart, cause: 1, clone: 0, a: 1, b: NO_VALUE }),
    ).toBe(NO_DRUG);
    expect(drugOfEvent({ tick: 0, type: EventType.Divide, cause: 0, clone: 0, a: 1, b: 2 })).toBe(NO_DRUG);
  });
});

describe('keyframe', () => {
  it('round-trips', () => {
    const kf = {
      tick: 1234,
      grid: { nx: 8, ny: 9, nz: 10 },
      nodes: [
        { node: 0, clone: 0, state: 0, cause: 0 },
        { node: 719, clone: 65535, state: 3, cause: 9 },
      ],
    };
    expect(decodeKeyframe(encodeKeyframe(kf))).toEqual(kf);
  });

  it('rejects bytes that are not a keyframe', () => {
    expect(() => decodeKeyframe(new Uint8Array(32))).toThrow(/not a keyframe/);
  });
});
