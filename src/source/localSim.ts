import type { ResolvedRules } from '../sim/rules.js';
import { Simulator, type ProbeReading, type SimStats } from '../sim/simulator.js';
import type { SimulationSource, TickPacket } from './types.js';

/** The stand-in simulator behind the source interface. */
export class LocalSimSource implements SimulationSource {
  readonly kind = 'local' as const;
  private sim: Simulator;
  private listeners = new Set<(p: TickPacket) => void>();
  private finished = false;

  constructor(readonly rules: ResolvedRules) {
    this.sim = new Simulator(rules);
  }

  get tick(): number {
    return this.sim.tick;
  }

  get done(): boolean {
    return this.finished;
  }

  onPacket(cb: (p: TickPacket) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  pump(n: number): void {
    for (let k = 0; k < n && !this.finished; k++) {
      const packet = this.sim.step();
      if (packet.done) this.finished = true;
      for (const cb of this.listeners) cb(packet);
    }
  }

  reset(): void {
    this.sim.reset();
    this.finished = false;
  }

  probe(node: number): ProbeReading[] {
    return this.sim.probe(node);
  }

  field(name: string): Float32Array | undefined {
    return this.sim.field(name as 'oxygen');
  }

  stats(): SimStats {
    return this.sim.stats();
  }
}
