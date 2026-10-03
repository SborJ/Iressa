import type { ResolvedRules } from '../sim/rules.js';
import type { World } from '../world/world.js';

export interface WorldCounts {
  living: number;
  dying: number;
  total: number;
  /** Living cells per clone id. */
  byClone: Map<number, number>;
  /** Every cell per state id. */
  byState: Map<number, number>;
  /** Every cell by the cause of its current state. */
  byCause: Map<number, number>;
}

/**
 * Counted off the world rather than asked of the source, so it works the same
 * for the stand-in simulator, a recorded run and a stream.
 */
export function countWorld(world: World, rules: ResolvedRules): WorldCounts {
  const alive = new Uint8Array(256);
  for (const s of rules.raw.states) alive[s.id] = (s.alive ?? true) ? 1 : 0;

  const byClone = new Map<number, number>();
  const byState = new Map<number, number>();
  const byCause = new Map<number, number>();
  let living = 0;
  let dying = 0;

  for (let s = 0; s < world.count; s++) {
    const st = world.state[s];
    byState.set(st, (byState.get(st) ?? 0) + 1);
    byCause.set(world.cause[s], (byCause.get(world.cause[s]) ?? 0) + 1);
    if (alive[st]) {
      living++;
      const c = world.clone[s];
      byClone.set(c, (byClone.get(c) ?? 0) + 1);
    } else {
      dying++;
    }
  }
  return { living, dying, total: world.count, byClone, byState, byCause };
}
