/**
 * Counter-based PRNG.
 *
 * Every random decision is a pure hash of (seed, tick, node, channel), so a run
 * is reproducible no matter what order nodes are visited in, and adding a new
 * kind of roll on a new channel does not shift any existing stream.
 */

export const Channel = {
  DivideJitter: 1,
  DaughterPick: 2,
  DeathRoll: 3,
  DeathPick: 4,
  MutationRoll: 5,
  MutationPick: 6,
  RadiationRoll: 7,
  RadiationCatastrophe: 8,
  Seeding: 9,
} as const;

export type ChannelId = (typeof Channel)[keyof typeof Channel];

function mix32(h: number): number {
  h = h | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return h >>> 0;
}

/** Deterministic 32-bit hash of four integers. */
export function hash4(seed: number, tick: number, node: number, channel: number): number {
  let h = seed | 0;
  h = mix32(h ^ Math.imul(tick | 0, 0x9e3779b1));
  h = mix32(h ^ Math.imul(node | 0, 0x85ebca6b));
  h = mix32(h ^ Math.imul(channel | 0, 0xc2b2ae35));
  return h;
}

/** Uniform in [0, 1). 24 bits of mantissa, which is plenty for hazard rolls. */
export function uniform(seed: number, tick: number, node: number, channel: number): number {
  return (hash4(seed, tick, node, channel) >>> 8) / 0x1000000;
}

/** Uniform integer in [0, n). */
export function uniformInt(
  seed: number,
  tick: number,
  node: number,
  channel: number,
  n: number,
): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.floor(uniform(seed, tick, node, channel) * n));
}

/** Sequential generator, for setup work that is not per-node-per-tick. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
