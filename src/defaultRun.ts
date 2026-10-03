/**
 * Which run the viewer opens with.
 *
 * With no ?source the viewer plays a committed demo run recorded from the calibrated
 * Python engine (data/runs/<name>, written by scripts/export_iressa_run.py). There is
 * one per cancer model; ?cancer=<id> picks it. The TypeScript stand-in simulator is
 * still available with ?source=local, a streamed run with ?source=socket, and any
 * other recorded run with ?source=file&rules=…&events=…&keyframes=….
 */
export interface CancerChoice {
  /** The cancer model id, as in cancer_sim/cancers/<id>.json. */
  id: string;
  /** Short label for the switch in the top bar. */
  label: string;
  /** The committed demo run folder under data/runs. */
  run: string;
}

export const CANCERS: readonly CancerChoice[] = [
  { id: 'lung_egfr', label: 'Lung · EGFR', run: 'demo48' },
  { id: 'breast_er_her2neg', label: 'Breast · ER+', run: 'breast48' },
];

export const DEFAULT_CANCER = CANCERS[0];

export function cancerChoice(q: URLSearchParams): CancerChoice {
  const id = q.get('cancer');
  return CANCERS.find((c) => c.id === id) ?? DEFAULT_CANCER;
}

/** ?run=<folder> plays another committed recording of the chosen cancer (e.g. a policy-driven run). */
export function defaultRun(q: URLSearchParams): string {
  const run = q.get('run');
  if (run && /^[A-Za-z0-9_-]+$/.test(run)) return `/runs/${run}`;
  return `/runs/${cancerChoice(q).run}`;
}

/** The lung demo, for callers that only know one run. */
export const DEFAULT_RUN = `/runs/${DEFAULT_CANCER.run}`;

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
  return usesDefaultRun(q) ? `${defaultRun(q)}/rules.json` : '/rules.json';
}

export function eventsUrl(q: URLSearchParams): string {
  return q.get('events') ?? `${defaultRun(q)}/run.events`;
}

export function keyframesUrl(q: URLSearchParams): string | null {
  const explicit = q.get('keyframes');
  if (explicit) return explicit;
  return usesDefaultRun(q) ? `${defaultRun(q)}/run.keyframes` : null;
}

/** The same page with another cancer's demo run, keeping unrelated query parameters. */
export function cancerUrl(id: string, q = new URLSearchParams(location.search)): string {
  const next = new URLSearchParams(q);
  for (const key of ['rules', 'events', 'keyframes', 'source', 'run']) next.delete(key);
  next.set('cancer', id);
  return `${location.pathname}?${next.toString()}`;
}
