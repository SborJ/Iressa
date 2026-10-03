import { rulesUrl } from '../defaultRun.js';

/**
 * The evolutionary-control readings a recorded run carries next to its
 * rules.json (``metrics.json``, written by cancer_sim/iressa_export.py): per
 * day, the controllability index proxy and per clone its control margin M_i,
 * escape distance D_i under that day's treatment, and the best represented
 * action. For policy-driven runs each day also carries the decision taken.
 *
 * These are model-scoped quantities about the simulator, never clinical ones.
 */
export interface CloneReading {
  count: number;
  margin: number;
  net_growth: number;
  escape_distance: number | null;
  exhausted: boolean;
  best_action: string;
  best_exposures: Record<string, number>;
}

export interface MetricsRow {
  day: number;
  eci: number;
  exposures: Record<string, number>;
  clones: Record<string, CloneReading>;
  action?: string;
  reward?: number;
  resistant_fraction?: number;
}

export interface RunMetrics {
  note: string;
  clone_ids: Record<string, number>;
  rows: MetricsRow[];
}

/** The provenance block a recorded run's rules.json carries (free-form in the schema). */
export interface RunProvenance {
  cancer?: { id: string; name: string; description?: string; model_file?: string };
  controllability?: MetricsRow;
  policy?: {
    name: string;
    training_cancer: string;
    training_cancer_name?: string;
    training_uncertainty: string;
    objective: string;
    decision_interval_days?: number;
    horizon_days?: number;
    actions?: number;
    note?: string;
  };
  strategy?: { schedule: string; declared_in?: string; spec?: Record<string, unknown> };
  timescale?: string;
  biology_source?: string;
}

/** metrics.json lives next to rules.json; absent for the stand-in simulator and older runs. */
export async function loadRunMetrics(q = new URLSearchParams(location.search)): Promise<RunMetrics | undefined> {
  const rules = rulesUrl(q);
  if (!/\/rules\.json$/.test(rules)) return undefined;
  const url = rules.replace(/rules\.json$/, 'metrics.json');
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const data = (await res.json()) as RunMetrics;
    if (!Array.isArray(data.rows)) return undefined;
    data.rows.sort((a, b) => a.day - b.day);
    return data;
  } catch {
    return undefined;
  }
}

/** The latest reading at or before ``day`` (the first one before the run starts). */
export function readingAt(metrics: RunMetrics, day: number): MetricsRow | undefined {
  const rows = metrics.rows;
  if (!rows.length) return undefined;
  let lo = 0;
  let hi = rows.length - 1;
  if (rows[0].day > day) return rows[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].day <= day) lo = mid;
    else hi = mid - 1;
  }
  return rows[lo];
}

/** The reading that follows ``row``, for "ECI x → y" style deltas. */
export function readingAfter(metrics: RunMetrics, row: MetricsRow): MetricsRow | undefined {
  const i = metrics.rows.indexOf(row);
  return i >= 0 && i + 1 < metrics.rows.length ? metrics.rows[i + 1] : undefined;
}

/** Evidence level of a provenance record: the breast model's explicit levels, or the lung calibration's status words. */
export function evidenceLevel(record: { evidence?: string; status?: string } | undefined): string {
  if (!record) return '';
  const explicit = record.evidence?.toUpperCase();
  if (explicit && ['DIRECT', 'DERIVED', 'INFERRED', 'ASSUMPTION'].some((l) => explicit.startsWith(l))) {
    return explicit.split('_')[0];
  }
  switch (record.status) {
    case 'measured': return 'DIRECT';
    case 'literature_derived': return 'DERIVED';
    case 'inferred': return 'INFERRED';
    case 'assumed': case 'demo_assumption': return 'ASSUMPTION';
    default: return record.status ? record.status.toUpperCase() : '';
  }
}
