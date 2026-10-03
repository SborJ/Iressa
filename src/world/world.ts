import {
  EventType,
  NO_DRUG,
  drugOfEvent,
  forEachEvent,
  stateOf,
} from '../format/events.js';
import { decodeKeyframe } from '../format/keyframes.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { TickPacket } from '../source/types.js';

/**
 * The matrix as the renderer sees it, rebuilt purely from the event stream.
 *
 * It holds no rates, thresholds or probabilities - only what each node is and
 * which event put it in that state, so the renderer can choose an animation by
 * type and cause.
 */
export class World {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly nodeCount: number;

  /** node -> slot, or -1. */
  private readonly slotOf: Int32Array;

  /* Per-slot, dense and swap-compacted. These are what the mesh reads. */
  nodeOfSlot: Int32Array;
  clone: Uint16Array;
  state: Uint8Array;
  cause: Uint8Array;
  drug: Uint8Array;
  /** Event type that started the current animation; with `cause` it picks the preset. */
  animType: Uint8Array;
  animCause: Uint8Array;
  /**
   * During a mutation the cell must read as its old colour and cross-fade to
   * the new one. `clone` is already the new clone (it is what the hover card
   * and the tallies should report), so the colour to start from is kept here.
   * 0xffff when no cross-fade is running.
   */
  animFromClone: Uint16Array;
  animStart: Float32Array;
  seed: Float32Array;
  count = 0;

  /** Slots whose attributes changed since the last flush. */
  readonly dirty = new Set<number>();
  /** Set when the slot table was rebuilt wholesale, e.g. from a keyframe. */
  rebuilt = false;

  tick = 0;

  private capacity: number;
  private readonly cyclingState: number;

  constructor(private rules: ResolvedRules, initialCapacity = 1 << 16) {
    const g = rules.raw.grid;
    this.nx = g.nx;
    this.ny = g.ny;
    this.nz = g.nz;
    this.nodeCount = g.nx * g.ny * g.nz;
    this.slotOf = new Int32Array(this.nodeCount).fill(-1);
    this.capacity = Math.min(initialCapacity, this.nodeCount);
    this.nodeOfSlot = new Int32Array(this.capacity);
    this.clone = new Uint16Array(this.capacity);
    this.state = new Uint8Array(this.capacity);
    this.cause = new Uint8Array(this.capacity);
    this.drug = new Uint8Array(this.capacity).fill(NO_DRUG);
    this.animType = new Uint8Array(this.capacity);
    this.animCause = new Uint8Array(this.capacity);
    this.animFromClone = new Uint16Array(this.capacity).fill(0xffff);
    this.animStart = new Float32Array(this.capacity);
    this.seed = new Float32Array(this.capacity);
    this.cyclingState = rules.stateByRole.get('cycling')?.id ?? 0;
  }

  clear(): void {
    this.slotOf.fill(-1);
    this.count = 0;
    this.dirty.clear();
    this.rebuilt = true;
  }

  slotForNode(node: number): number {
    return node >= 0 && node < this.nodeCount ? this.slotOf[node] : -1;
  }

  private grow(): void {
    const next = Math.min(this.nodeCount, this.capacity * 2);
    if (next === this.capacity) throw new Error('world capacity exhausted');
    const copy = <T extends { length: number }>(src: T, make: (n: number) => T): T => {
      const dst = make(next);
      (dst as unknown as { set(s: unknown): void }).set(src);
      return dst;
    };
    this.nodeOfSlot = copy(this.nodeOfSlot, (n) => new Int32Array(n));
    this.clone = copy(this.clone, (n) => new Uint16Array(n));
    this.state = copy(this.state, (n) => new Uint8Array(n));
    this.cause = copy(this.cause, (n) => new Uint8Array(n));
    this.drug = copy(this.drug, (n) => new Uint8Array(n));
    this.animType = copy(this.animType, (n) => new Uint8Array(n));
    this.animCause = copy(this.animCause, (n) => new Uint8Array(n));
    this.animFromClone = copy(this.animFromClone, (n) => new Uint16Array(n));
    this.animStart = copy(this.animStart, (n) => new Float32Array(n));
    this.seed = copy(this.seed, (n) => new Float32Array(n));
    this.capacity = next;
    this.rebuilt = true;
  }

  private add(
    node: number,
    cloneId: number,
    stateId: number,
    causeId: number,
    drugId: number,
    type: number,
    tick: number,
  ): number {
    let slot = this.slotOf[node];
    if (slot < 0) {
      if (this.count >= this.capacity) this.grow();
      slot = this.count++;
      this.slotOf[node] = slot;
      this.nodeOfSlot[slot] = node;
      // A stable per-node value, so blebbing and fragmenting differ cell to cell.
      this.seed[slot] = ((Math.imul(node ^ 0x9e3779b9, 0x85ebca6b) >>> 8) & 0xffff) / 0xffff;
    }
    this.clone[slot] = cloneId;
    this.state[slot] = stateId;
    this.cause[slot] = causeId;
    this.drug[slot] = drugId;
    this.animType[slot] = type;
    this.animCause[slot] = causeId;
    this.animFromClone[slot] = 0xffff;
    this.animStart[slot] = tick;
    this.dirty.add(slot);
    return slot;
  }

  private remove(node: number): void {
    const slot = this.slotOf[node];
    if (slot < 0) return;
    const last = --this.count;
    if (slot !== last) {
      const movedNode = this.nodeOfSlot[last];
      this.nodeOfSlot[slot] = movedNode;
      this.clone[slot] = this.clone[last];
      this.state[slot] = this.state[last];
      this.cause[slot] = this.cause[last];
      this.drug[slot] = this.drug[last];
      this.animType[slot] = this.animType[last];
      this.animCause[slot] = this.animCause[last];
      this.animFromClone[slot] = this.animFromClone[last];
      this.animStart[slot] = this.animStart[last];
      this.seed[slot] = this.seed[last];
      this.slotOf[movedNode] = slot;
      this.dirty.add(slot);
    }
    this.slotOf[node] = -1;
    this.dirty.add(last);
  }

  /** Applies one tick. Keyframes, when present, are authoritative. */
  apply(packet: TickPacket): void {
    if (packet.keyframe) this.applyKeyframe(packet.keyframe);
    this.tick = packet.tick;
    forEachEvent(packet.events, (e) => {
      switch (e.type) {
        case EventType.Divide: {
          // The parent replays the division animation; the daughter is new.
          const parent = this.slotOf[e.a];
          if (parent >= 0) {
            this.animType[parent] = e.type;
            this.animCause[parent] = e.cause;
            this.animFromClone[parent] = 0xffff;
            this.animStart[parent] = e.tick;
            this.dirty.add(parent);
          }
          this.add(e.b, e.clone, this.cyclingState, e.cause, NO_DRUG, e.type, e.tick);
          break;
        }
        case EventType.DeathStart: {
          const slot = this.slotOf[e.a];
          if (slot < 0) break;
          this.state[slot] = this.dyingState;
          this.cause[slot] = e.cause;
          this.drug[slot] = drugOfEvent(e);
          this.animType[slot] = e.type;
          this.animCause[slot] = e.cause;
          this.animFromClone[slot] = 0xffff;
          this.animStart[slot] = e.tick;
          this.dirty.add(slot);
          break;
        }
        case EventType.Removed:
          this.remove(e.a);
          break;
        case EventType.Mutate: {
          const slot = this.slotOf[e.a];
          if (slot < 0) break;
          this.animType[slot] = e.type;
          this.animCause[slot] = e.cause;
          // Start from the clone it was, cross-fade to the clone it became.
          this.animFromClone[slot] = e.clone;
          this.animStart[slot] = e.tick;
          this.clone[slot] = e.b;
          this.dirty.add(slot);
          break;
        }
        case EventType.StateChange: {
          const slot = this.slotOf[e.a];
          if (slot < 0) break;
          this.state[slot] = stateOf(e.b);
          this.cause[slot] = e.cause;
          this.drug[slot] = drugOfEvent(e);
          this.animType[slot] = e.type;
          this.animCause[slot] = e.cause;
          this.animFromClone[slot] = 0xffff;
          this.animStart[slot] = e.tick;
          this.dirty.add(slot);
          break;
        }
        default:
          break;
      }
    });
  }

  private get dyingState(): number {
    return this.rules.stateByRole.get('dying')?.id ?? this.cyclingState;
  }

  applyKeyframe(bytes: Uint8Array): void {
    const kf = decodeKeyframe(bytes);
    this.clear();
    for (const n of kf.nodes) {
      this.add(n.node, n.clone, n.state, n.cause, NO_DRUG, EventType.StateChange, kf.tick);
    }
    this.tick = kf.tick;
  }

  /** What the hover card needs. */
  describe(slot: number): {
    node: number;
    clone: number;
    state: number;
    cause: number;
    drug: number;
    x: number;
    y: number;
    z: number;
  } | undefined {
    if (slot < 0 || slot >= this.count) return undefined;
    const node = this.nodeOfSlot[slot];
    return {
      node,
      clone: this.clone[slot],
      state: this.state[slot],
      cause: this.cause[slot],
      drug: this.drug[slot],
      x: node % this.nx,
      y: Math.floor(node / this.nx) % this.ny,
      z: Math.floor(node / (this.nx * this.ny)),
    };
  }
}
