import { EVENT_SIZE } from '../format/events.js';
import { decodeKeyframe } from '../format/keyframes.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { SimulationSource, TickPacket } from './types.js';

/**
 * Replay from a recorded run: one packed event file plus its keyframes.
 *
 * This is the path a finished Python run takes - it writes rules.json plus the
 * same records, and this plays them back with no simulator present at all.
 *
 * Keyframes are packets in their own right, delivered in tick order ahead of
 * the events of the same tick. A tick can carry a keyframe and no events (the
 * tick-0 keyframe routinely does, since it is what establishes the starting
 * population) so they cannot be attached to event packets alone.
 */
export class FileSource implements SimulationSource {
  readonly kind = 'file' as const;
  private listeners = new Set<(p: TickPacket) => void>();
  private cursor = 0;
  private readonly total: number;
  private view: DataView;
  private keyframes: { tick: number; bytes: Uint8Array }[];
  private keyframeCursor = 0;
  private current = 0;

  constructor(
    readonly rules: ResolvedRules,
    private events: Uint8Array,
    keyframes: Uint8Array[] = [],
  ) {
    this.view = new DataView(events.buffer, events.byteOffset, events.byteLength);
    this.total = Math.floor(events.byteLength / EVENT_SIZE);
    this.keyframes = keyframes
      .map((bytes) => ({ tick: decodeKeyframe(bytes).tick, bytes }))
      .sort((a, b) => a.tick - b.tick);
  }

  get tick(): number {
    return this.current;
  }

  get done(): boolean {
    return this.cursor >= this.total && this.keyframeCursor >= this.keyframes.length;
  }

  onPacket(cb: (p: TickPacket) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Emits one packet per distinct tick present in the file. */
  pump(n: number): void {
    for (let k = 0; k < n; k++) {
      const nextEventTick =
        this.cursor < this.total ? this.view.getUint32(this.cursor * EVENT_SIZE, true) : Infinity;
      const nextKeyframe =
        this.keyframeCursor < this.keyframes.length ? this.keyframes[this.keyframeCursor] : undefined;

      if (nextEventTick === Infinity && !nextKeyframe) {
        this.emit({ tick: this.current, events: new Uint8Array(0), done: true });
        return;
      }

      // A keyframe for this tick, or for a tick with no events at all, goes first.
      const keyframe = nextKeyframe && nextKeyframe.tick <= nextEventTick ? nextKeyframe : undefined;
      if (keyframe) this.keyframeCursor++;

      if (keyframe && keyframe.tick < nextEventTick) {
        this.current = keyframe.tick;
        this.emit({
          tick: keyframe.tick,
          events: new Uint8Array(0),
          keyframe: keyframe.bytes,
          done: this.done,
        });
        continue;
      }

      let end = this.cursor;
      while (end < this.total && this.view.getUint32(end * EVENT_SIZE, true) === nextEventTick) end++;
      const slice = this.events.subarray(this.cursor * EVENT_SIZE, end * EVENT_SIZE);
      this.cursor = end;
      this.current = nextEventTick;
      this.emit({
        tick: nextEventTick,
        events: slice,
        keyframe: keyframe?.bytes,
        done: this.done,
      });
    }
  }

  private emit(p: TickPacket): void {
    for (const cb of this.listeners) cb(p);
  }
}
