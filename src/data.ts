import { loadRules, RulesError, type ResolvedRules, type RulesFile } from './sim/rules.js';
import { loadVisuals, VisualsError, type Visuals } from './render/visuals.js';
import { rulesUrl, sourceKind } from './defaultRun.js';
import { applyLocalExperimentOverrides, experimentParamsFromQuery } from './experimentParams.js';

export interface LoadedData {
  rules: ResolvedRules;
  visuals: Visuals;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`cannot load ${url} (${res.status})`);
  return res.json();
}

/**
 * Both data files and both schemas are fetched at startup and validated before
 * anything is built. Edit a number in data/rules.json and reload - there is no
 * build step and no code to change.
 *
 * ?rules= and ?visuals= point at different files, which is how a Python run is
 * viewed: it writes its own rules.json next to its events, and the viewer is
 * aimed at that one.
 */
export async function loadData(): Promise<LoadedData> {
  const q = new URLSearchParams(location.search);
  const [rulesRaw, rulesSchema, visualsRaw, visualsSchema] = await Promise.all([
    fetchJson(rulesUrl(q)),
    fetchJson('/schema/rules.schema.json'),
    fetchJson(q.get('visuals') ?? '/visuals.json'),
    fetchJson('/schema/visuals.schema.json'),
  ]);
  const experimentRules = sourceKind(q) === 'local'
    ? applyLocalExperimentOverrides(rulesRaw as RulesFile, experimentParamsFromQuery(q))
    : rulesRaw;
  const rules = loadRules(experimentRules, rulesSchema as object);
  const visuals = loadVisuals(visualsRaw, visualsSchema as object, rules);
  return { rules, visuals };
}

export function describeLoadError(err: unknown): { title: string; note: string; problems: string[] } {
  if (err instanceof RulesError) {
    return {
      title: err.message,
      note: 'data/rules.json is the only place rates, thresholds and probabilities live. Fix the entries below and reload.',
      problems: err.problems,
    };
  }
  if (err instanceof VisualsError) {
    return {
      title: err.message,
      note: 'data/visuals.json holds every colour and animation preset. A cause needs an entry in both files.',
      problems: err.problems,
    };
  }
  return {
    title: 'Could not start',
    note: '',
    problems: [err instanceof Error ? err.message : String(err)],
  };
}
