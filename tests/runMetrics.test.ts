import { describe, expect, it } from 'vitest';
import { evidenceLevel, readingAfter, readingAt, type RunMetrics } from '../src/ui/runMetrics.js';

const metrics: RunMetrics = {
  note: '',
  clone_ids: { A: 0, B: 1 },
  rows: [
    { day: 0, eci: 0.1, exposures: {}, clones: {} },
    { day: 1, eci: 0.2, exposures: { endocrine: 1 }, clones: {} },
    { day: 2, eci: 0.3, exposures: { endocrine: 1 }, clones: {} },
  ],
};

describe('run metrics readings', () => {
  it('returns the latest reading at or before the day', () => {
    expect(readingAt(metrics, 0.5)?.day).toBe(0);
    expect(readingAt(metrics, 1)?.day).toBe(1);
    expect(readingAt(metrics, 1.99)?.day).toBe(1);
    expect(readingAt(metrics, 50)?.day).toBe(2);
  });

  it('falls back to the first reading before the run starts', () => {
    expect(readingAt(metrics, -3)?.day).toBe(0);
  });

  it('finds the following reading for deltas', () => {
    const row = readingAt(metrics, 1)!;
    expect(readingAfter(metrics, row)?.eci).toBe(0.3);
    expect(readingAfter(metrics, metrics.rows[2])).toBeUndefined();
  });

  it('maps evidence levels from both provenance vocabularies', () => {
    expect(evidenceLevel({ evidence: 'DIRECT' })).toBe('DIRECT');
    expect(evidenceLevel({ evidence: 'DERIVED_CLINICAL' })).toBe('DERIVED');
    expect(evidenceLevel({ status: 'measured' })).toBe('DIRECT');
    expect(evidenceLevel({ status: 'literature_derived' })).toBe('DERIVED');
    expect(evidenceLevel({ status: 'assumed' })).toBe('ASSUMPTION');
    expect(evidenceLevel(undefined)).toBe('');
  });
});
