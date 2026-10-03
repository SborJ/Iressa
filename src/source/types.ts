import type { ProbeReading, SimStats } from '../sim/simulator.js';
import type { ResolvedRules } from '../sim/rules.js';

/**
 * One tick's worth of data. Exactly what a WebSocket frame carries, and
 * exactly what the stand-in simulator returns, so the two are interchangeable.
 */
export interface TickPacket {
  tick: number;
  events: Uint8Array;
  keyframe?: Uint8Array;
  done: boolean;
}

/**
 * The seam between a simulation and everything that draws it.
 *
 * The renderer and the UI only ever talk to this. Swapping the stand-in
 * simulator for the Python one means supplying a different implementation of
 * this interface - nothing downstream changes.
 */
export interface SimulationSource {
  readonly kind: 'local' | 'file' | 'socket' | 'live';
  readonly rules: ResolvedRules;
  readonly tick: number;
  readonly done: boolean;

  /** Called for every tick the source produces, in order. */
  onPacket(cb: (packet: TickPacket) => void): () => void;

  /**
   * Ask for up to `n` further ticks. A pull source (stand-in simulator, replay
   * from a file) produces them immediately; a push source (socket) ignores
   * this and delivers whatever the server sends.
   */
  pump(n: number): void;

  reset?(): void;

  /** Optional read-outs. Already labelled, so the UI displays them without interpreting them. */
  probe?(node: number): ProbeReading[];
  field?(name: string): Float32Array | undefined;
  stats?(): SimStats;
  dispose?(): void;
}
