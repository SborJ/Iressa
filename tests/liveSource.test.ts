import { describe, expect, it } from 'vitest';
import { LiveSource } from '../src/source/liveSource.js';
import { encodeKeyframe } from '../src/format/keyframes.js';
import { EVENT_SIZE } from '../src/format/events.js';

function eventFrame(tick: number, count = 2): Uint8Array {
  const bytes = new Uint8Array(EVENT_SIZE * count);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) view.setUint32(i * EVENT_SIZE, tick, true);
  return bytes;
}

function keyframe(tick: number): Uint8Array {
  return encodeKeyframe({ tick, grid: { nx: 4, ny: 4, nz: 3 }, nodes: [{ node: 0, clone: 0, state: 0, cause: 0 }] });
}

describe('live source', () => {
  it('emits the opening keyframe at once and buffers a day behind it', () => {
    const live = new LiveSource('ws://test');
    const got: number[] = [];
    live.onPacket((p) => got.push(p.tick));
    live.handleFrame(keyframe(0).buffer);
    expect(got).toEqual([0]);
    live.handleFrame(eventFrame(48).buffer);
    live.handleFrame(eventFrame(49).buffer);
    live.handleFrame(keyframe(49).buffer);
    live.handleFrame(JSON.stringify({ type: 'day', reading: { day: 1, eci: 0.2, exposures: {}, clones: {} }, done: false }));
    expect(got).toEqual([0]);
    live.pump(1);
    expect(got).toEqual([0, 48]);
    live.pump(5);
    expect(got).toEqual([0, 48, 49, 49]);
    expect(live.tick).toBe(49);
  });

  it('delivers readings and treatment acknowledgements to listeners', () => {
    const live = new LiveSource('ws://test');
    const readings: number[] = [];
    const treatments: Record<string, number>[] = [];
    live.onReading((r) => readings.push(r.day));
    live.onTreatment((e) => treatments.push(e));
    live.handleFrame(JSON.stringify({ type: 'day', reading: { day: 3, eci: 0.1, exposures: { palbociclib: 1 }, clones: {} }, done: false }));
    live.handleFrame(JSON.stringify({ type: 'treatment', exposures: { palbociclib: 0.5 }, auto: false }));
    expect(readings).toEqual([3]);
    expect(treatments).toEqual([{ palbociclib: 0.5 }]);
  });

  it('finishes when the server says the session is done and the buffer is drained', () => {
    const live = new LiveSource('ws://test');
    live.handleFrame(eventFrame(10).buffer);
    live.handleFrame(JSON.stringify({ type: 'day', reading: null, done: true }));
    expect(live.done).toBe(false);
    live.pump(1);
    expect(live.done).toBe(true);
  });

  it('drops frames that are neither keyframes nor whole records', () => {
    const live = new LiveSource('ws://test');
    const got: number[] = [];
    live.onPacket((p) => got.push(p.tick));
    live.handleFrame(new Uint8Array(7).buffer);
    live.pump(1);
    expect(got).toEqual([]);
  });
});
