/**
 * The wire format. Nothing in here knows any biology.
 *
 * One event is 16 bytes, little-endian:
 *
 *   offset  size  field
 *   0       4     tick    u32
 *   4       1     type    u8   see EventType
 *   5       1     cause   u8   id from the cause table in rules.json
 *   6       2     clone   u16  the clone the node belonged to when the event fired
 *   8       4     a       u32  the node
 *   12      4     b       u32  daughter node (divide) | new state (state change)
 *                              | new clone (mutate) | drug id (drug causes) | NO_VALUE
 *
 * The stand-in simulator writes this. The Python simulation will write exactly
 * this, either as a file or streamed over a WebSocket, and nothing downstream
 * changes.
 */

export const EVENT_SIZE = 16;

/** Sentinel for an unused `b`. */
export const NO_VALUE = 0xffffffff;

export const EventType = {
  Divide: 1,
  DeathStart: 2,
  Removed: 3,
  Mutate: 4,
  StateChange: 5,
} as const;

export type EventTypeId = (typeof EventType)[keyof typeof EventType];

export const EVENT_TYPE_NAMES: Record<number, string> = {
  1: 'divide',
  2: 'death start',
  3: 'removed',
  4: 'mutate',
  5: 'state change',
};

export interface SimEvent {
  tick: number;
  type: number;
  cause: number;
  clone: number;
  a: number;
  b: number;
}

export function writeEvent(view: DataView, offset: number, e: SimEvent): void {
  view.setUint32(offset, e.tick, true);
  view.setUint8(offset + 4, e.type);
  view.setUint8(offset + 5, e.cause);
  view.setUint16(offset + 6, e.clone, true);
  view.setUint32(offset + 8, e.a, true);
  view.setUint32(offset + 12, e.b, true);
}

export function readEvent(view: DataView, offset: number, into?: SimEvent): SimEvent {
  const e = into ?? ({} as SimEvent);
  e.tick = view.getUint32(offset, true);
  e.type = view.getUint8(offset + 4);
  e.cause = view.getUint8(offset + 5);
  e.clone = view.getUint16(offset + 6, true);
  e.a = view.getUint32(offset + 8, true);
  e.b = view.getUint32(offset + 12, true);
  return e;
}

/** Growable writer. `bytes()` hands back a copy sized to the events written. */
export class EventWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private count = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new ArrayBuffer(Math.max(1, initialCapacity) * EVENT_SIZE);
    this.view = new DataView(this.buf);
  }

  get length(): number {
    return this.count;
  }

  push(e: SimEvent): void {
    if ((this.count + 1) * EVENT_SIZE > this.buf.byteLength) {
      const grown = new ArrayBuffer(this.buf.byteLength * 2);
      new Uint8Array(grown).set(new Uint8Array(this.buf));
      this.buf = grown;
      this.view = new DataView(grown);
    }
    writeEvent(this.view, this.count * EVENT_SIZE, e);
    this.count++;
  }

  emit(tick: number, type: number, cause: number, clone: number, a: number, b: number = NO_VALUE): void {
    this.push({ tick, type, cause, clone, a, b });
  }

  bytes(): Uint8Array {
    return new Uint8Array(this.buf, 0, this.count * EVENT_SIZE).slice();
  }

  clear(): void {
    this.count = 0;
  }
}

/** Reads a packed event block without allocating one object per event. */
export function forEachEvent(
  bytes: ArrayBuffer | Uint8Array,
  fn: (e: SimEvent, index: number) => void,
): number {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = Math.floor(u8.byteLength / EVENT_SIZE);
  const scratch: SimEvent = { tick: 0, type: 0, cause: 0, clone: 0, a: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    readEvent(view, i * EVENT_SIZE, scratch);
    fn(scratch, i);
  }
  return n;
}

export function decodeEvents(bytes: ArrayBuffer | Uint8Array): SimEvent[] {
  const out: SimEvent[] = [];
  forEachEvent(bytes, (e) => out.push({ ...e }));
  return out;
}

/* ------------------------------------------------------------------ *
 * `b` for a state change carries two things: the state the node moved to,
 * and - when a drug caused the move - which drug. They are packed so the
 * record stays 16 bytes.
 *
 *   bits 0-7    new state id
 *   bits 8-15   drug id, or NO_DRUG when no drug is involved
 * ------------------------------------------------------------------ */

export const NO_DRUG = 0xff;

export function packStateChange(newState: number, drug: number = NO_DRUG): number {
  return (newState & 0xff) | ((drug & 0xff) << 8);
}

export function stateOf(b: number): number {
  return b & 0xff;
}

export function drugOfStateChange(b: number): number {
  return (b >>> 8) & 0xff;
}

/**
 * The drug an event refers to, or NO_DRUG. Death events put the drug id
 * straight into `b`; state changes pack it alongside the new state.
 */
export function drugOfEvent(e: SimEvent): number {
  if (e.type === EventType.StateChange) return drugOfStateChange(e.b);
  if (e.type === EventType.DeathStart || e.type === EventType.Removed) {
    return e.b === NO_VALUE ? NO_DRUG : e.b & 0xff;
  }
  return NO_DRUG;
}
