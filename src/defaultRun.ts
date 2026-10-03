/**
 * Which run the viewer opens with.
 *
 * With no ?source the viewer plays the calibrated Python engine's committed demo run
 * (data/runs/demo48, written by scripts/export_iressa_run.py). The TypeScript stand-in
 * simulator is still available with ?source=local, a streamed run with ?source=socket,
 * and any other recorded run with ?source=file&rules=…&events=…&keyframes=….
 */
export const DEFAULT_RUN = '/runs/demo48';

export type SourceKind = 'local' | 'socket' | 'file';

export function sourceKind(q: URLSearchParams): SourceKind {
  const kind = q.get('source');
  if (kind === 'local' || kind === 'socket' || kind === 'file') return kind;
  return 'file';
}

/** True when the viewer should fall back to the default run's files. */
export function usesDefaultRun(q: URLSearchParams): boolean {
  return sourceKind(q) === 'file' && !q.get('events');
}

export function rulesUrl(q: URLSearchParams): string {
  const explicit = q.get('rules');
  if (explicit) return explicit;
  return usesDefaultRun(q) ? `${DEFAULT_RUN}/rules.json` : '/rules.json';
}

export function eventsUrl(q: URLSearchParams): string {
  return q.get('events') ?? `${DEFAULT_RUN}/run.events`;
}

export function keyframesUrl(q: URLSearchParams): string | null {
  const explicit = q.get('keyframes');
  if (explicit) return explicit;
  return usesDefaultRun(q) ? `${DEFAULT_RUN}/run.keyframes` : null;
}
