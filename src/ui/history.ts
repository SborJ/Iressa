import type { ResolvedRules } from '../sim/rules.js';
import type { SimulationSource } from '../source/types.js';
import type { World } from '../world/world.js';
import { countWorld, type WorldCounts } from './counts.js';

const CAPACITY = 900;

/**
 * What the read-outs have been, so a number can be shown with its trend.
 *
 * The world carries only the present, and a count with no history is not
 * information: 8,738 cells means one thing while the tumour is doubling and
 * the opposite while it is being treated. Sampled on the interface's own clock
 * and kept here rather than in the world, which the interface does not own.
 */
export class History {
  private ticks: number[] = [];
  private series = new Map<string, number[]>();
  private lastTick = -1;
  latest: WorldCounts | undefined;

  constructor(private rules: ResolvedRules) {}

  reset(): void {
    this.ticks.length = 0;
    this.series.clear();
    this.lastTick = -1;
    this.latest = undefined;
  }

  /** One sample per simulated tick at most, however often the interface redraws. */
  record(world: World, source: SimulationSource): WorldCounts {
    const counts = countWorld(world, this.rules);
    this.latest = counts;
    if (world.tick === this.lastTick) return counts;
    this.lastTick = world.tick;

    this.push('tick', world.tick);
    this.push('living', counts.living);
    this.push('dying', counts.dying);
    const stats = source.stats?.();
    if (stats) {
      for (const [drug, conc] of stats.plasma) this.push(`plasma:${drug}`, conc);
    }
    return counts;
  }

  private push(key: string, value: number): void {
    if (key === 'tick') {
      this.ticks.push(value);
      if (this.ticks.length > CAPACITY) this.ticks.shift();
      return;
    }
    let s = this.series.get(key);
    if (!s) {
      s = [];
      this.series.set(key, s);
    }
    s.push(value);
    if (s.length > CAPACITY) s.shift();
  }

  /** The tick each sample was taken at, so a series can be plotted against time. */
  tickValues(): number[] {
    return this.ticks;
  }

  values(key: string): number[] {
    return this.series.get(key) ?? [];
  }

  current(key: string): number | undefined {
    const s = this.series.get(key);
    return s?.length ? s[s.length - 1] : undefined;
  }

  /**
   * Change over the last simulated day. Undefined until a day has elapsed,
   * because an extrapolated rate from four hours of history is a guess.
   */
  changePerDay(key: string): number | undefined {
    const s = this.series.get(key);
    if (!s || s.length < 2 || !this.ticks.length) return undefined;
    const now = this.ticks[this.ticks.length - 1];
    const want = now - this.rules.ticksPerDay;
    if (this.ticks[0] > want) return undefined;
    let i = this.ticks.length - 1;
    while (i > 0 && this.ticks[i] > want) i--;
    return s[s.length - 1] - s[i];
  }

  get sampleCount(): number {
    return this.ticks.length;
  }
}
