import { EventType, forEachEvent } from '../format/events.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { TickPacket } from '../source/types.js';
import type { World } from './world.js';

const CAUSE_SLOTS = 256;

export interface CauseBucket {
  /** First tick of the bucket. */
  tick: number;
  hours: number;
  /** Deaths in this bucket, indexed by cause id. */
  deaths: Int32Array;
  living: number;
}

/**
 * Deaths by cause: a rolling tally over the last simulated day, and a bucketed
 * series over the whole run for the chart.
 *
 * Counted straight off the event stream, so it works the same whether the
 * events come from the stand-in simulator or from the Python one.
 */
export class CauseStats {
  /** Cumulative deaths per cause id. */
  readonly total = new Int32Array(CAUSE_SLOTS);
  /** Deaths per cause id within the last `windowTicks`. */
  readonly window = new Int32Array(CAUSE_SLOTS);
  /** Current state changes per cause id - how many cells are arrested for each reason. */
  readonly stateChanges = new Int32Array(CAUSE_SLOTS);
  readonly buckets: CauseBucket[] = [];
  readonly windowTicks: number;

  private ring: Int32Array;
  private ringTicks: number;
  private bucket: CauseBucket | undefined;
  private aliveByState = new Uint8Array(CAUSE_SLOTS);

  constructor(
    private rules: ResolvedRules,
    /** How many ticks a chart bucket spans. */
    readonly bucketTicks = Math.max(1, Math.round(rules.ticksPerDay / 4)),
  ) {
    this.windowTicks = rules.ticksPerDay;
    this.ringTicks = this.windowTicks;
    this.ring = new Int32Array(this.ringTicks * CAUSE_SLOTS);
    for (const s of rules.raw.states) this.aliveByState[s.id] = (s.alive ?? true) ? 1 : 0;
  }

  reset(): void {
    this.total.fill(0);
    this.window.fill(0);
    this.stateChanges.fill(0);
    this.ring.fill(0);
    this.buckets.length = 0;
    this.bucket = undefined;
  }

  ingest(packet: TickPacket, world: World): void {
    const tick = packet.tick;

    // Roll the window: drop the slot this tick is about to reuse.
    const slot = tick % this.ringTicks;
    const base = slot * CAUSE_SLOTS;
    for (let c = 0; c < CAUSE_SLOTS; c++) {
      const old = this.ring[base + c];
      if (old) {
        this.window[c] -= old;
        this.ring[base + c] = 0;
      }
    }

    const bucketStart = tick - (tick % this.bucketTicks);
    if (!this.bucket || this.bucket.tick !== bucketStart) {
      this.bucket = {
        tick: bucketStart,
        hours: bucketStart * this.rules.hoursPerTick,
        deaths: new Int32Array(CAUSE_SLOTS),
        living: 0,
      };
      this.buckets.push(this.bucket);
    }

    forEachEvent(packet.events, (e) => {
      if (e.type === EventType.DeathStart) {
        this.total[e.cause]++;
        this.window[e.cause]++;
        this.ring[base + e.cause]++;
        this.bucket!.deaths[e.cause]++;
      }
    });

    // Living count and the current arrest mix, recomputed once per bucket.
    if (tick % this.bucketTicks === this.bucketTicks - 1 || this.buckets.length === 1) {
      this.stateChanges.fill(0);
      let living = 0;
      for (let s = 0; s < world.count; s++) {
        if (this.aliveByState[world.state[s]]) living++;
        this.stateChanges[world.cause[s]]++;
      }
      this.bucket!.living = living;
    }
  }

  /** Cause ids that have ever been seen, in the order the rules declare them. */
  activeCauses(kind?: 'death'): number[] {
    return this.rules.raw.causes
      .filter((c) => (kind ? c.kind === kind : true))
      .map((c) => c.id)
      .filter((id) => this.total[id] > 0 || !kind);
  }
}
