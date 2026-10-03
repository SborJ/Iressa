import { describe, expect, it } from 'vitest';
import { EventType } from '../src/format/events.js';
import { VisualsError } from '../src/render/visuals.js';
import { projectRules, projectVisuals } from './helpers.js';

/** The new cause the tests add, declared only in data. */
const NEW_CAUSE = {
  id: 10,
  name: 'ferroptosis',
  kind: 'death',
  animation: 'ferroptosis',
  label: 'Ferroptosis: iron overload',
  dyingTicks: 12,
};

const NEW_PRESET = {
  durationTicks: 12,
  scaleTarget: 0.6,
  bleb: 0.1,
  fragments: 2,
  fragmentSpread: 0.5,
  tint: '#c98500',
  tintAmount: 0.6,
  alphaTarget: 0,
  emissive: 0.5,
  flashTicks: 2,
};

describe('visuals.json', () => {
  it('validates and covers every cause and clone the rules declare', () => {
    const rules = projectRules();
    expect(() => projectVisuals(rules)).not.toThrow();
  });

  it('resolves the preset a cause names in rules.json', () => {
    const rules = projectRules();
    const visuals = projectVisuals(rules);
    const necrosis = rules.causeByRole.get('hypoxicNecrosis')!.id;
    const idx = visuals.presetFor(EventType.DeathStart, necrosis);
    expect(visuals.presetNames[idx]).toBe('necrosis');
  });

  it('lets byEvent override the cause for one event type', () => {
    const rules = projectRules();
    const visuals = projectVisuals(rules);
    const radiation = rules.causeByRole.get('radiation')!.id;
    // The same cause, two different animations: becoming multinucleated, then dying.
    expect(visuals.presetNames[visuals.presetFor(EventType.StateChange, radiation)]).toBe(
      'radiation_damage',
    );
    expect(visuals.presetNames[visuals.presetFor(EventType.DeathStart, radiation)]).toBe(
      'mitotic_catastrophe',
    );
  });

  it('prefers byEvent over byCause over the rules animation', () => {
    const rules = projectRules();
    const baseline = rules.causeByRole.get('baselineApoptosis')!.id;
    const byRules = projectVisuals(rules);
    expect(byRules.presetNames[byRules.presetFor(EventType.DeathStart, baseline)]).toBe('apoptosis');

    const byCause = projectVisuals(rules, (v) => {
      v.byCause = { ...(v.byCause ?? {}), [String(baseline)]: 'immune_kill' };
    });
    expect(byCause.presetNames[byCause.presetFor(EventType.DeathStart, baseline)]).toBe('immune_kill');

    const byEvent = projectVisuals(rules, (v) => {
      v.byCause = { ...(v.byCause ?? {}), [String(baseline)]: 'immune_kill' };
      v.byEvent = { ...(v.byEvent ?? {}), [`${EventType.DeathStart}:${baseline}`]: 'necrosis' };
    });
    expect(byEvent.presetNames[byEvent.presetFor(EventType.DeathStart, baseline)]).toBe('necrosis');
  });

  it('adding a cause needs only new entries in the two data files', () => {
    const rules = projectRules((r) => r.causes.push({ ...NEW_CAUSE }));
    const visuals = projectVisuals(rules, (v) => {
      v.presets.ferroptosis = { ...NEW_PRESET };
      v.causeColors['10'] = '#d55181';
    });
    const idx = visuals.presetFor(EventType.DeathStart, NEW_CAUSE.id);
    expect(visuals.presetNames[idx]).toBe('ferroptosis');
    expect(rules.dyingTicksByCause.get(NEW_CAUSE.id)).toBe(12);
    expect(visuals.causeCss(NEW_CAUSE.id)).toBe('#d55181');
    // Its parameters reached the shader payload.
    const params = visuals.presetParams.subarray(idx * 20, idx * 20 + 20);
    expect(params[0]).toBe(12);
    expect(params[1]).toBeCloseTo(0.6);
    expect(params[8]).toBe(2);
  });

  it('says so when a new cause has no preset', () => {
    const rules = projectRules((r) => r.causes.push({ ...NEW_CAUSE }));
    try {
      projectVisuals(rules, (v) => {
        v.causeColors['10'] = '#d55181';
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(VisualsError);
      expect((err as VisualsError).problems.join(' ')).toMatch(/animation "ferroptosis"/);
    }
  });

  it('says so when a new cause has no colour', () => {
    const rules = projectRules((r) => r.causes.push({ ...NEW_CAUSE }));
    try {
      projectVisuals(rules, (v) => {
        v.presets.ferroptosis = { ...NEW_PRESET };
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as VisualsError).problems.join(' ')).toMatch(/causeColors/);
    }
  });

  it('says so when a preset names a cause the rules do not declare', () => {
    const rules = projectRules();
    expect(() =>
      projectVisuals(rules, (v) => {
        v.byCause = { '77': 'apoptosis' };
      }),
    ).toThrow(VisualsError);
  });

  it('says so when a preset tints but states no colour', () => {
    const rules = projectRules();
    expect(() =>
      projectVisuals(rules, (v) => {
        delete v.presets.apoptosis.tint;
      }),
    ).toThrow(VisualsError);
  });

  it('records which source each preset takes its tint from', () => {
    const rules = projectRules();
    const v = projectVisuals(rules);
    const fixed = v.presetIndex.get('apoptosis')!;
    const fromDrug = v.presetIndex.get('apoptosis_drug')!;
    const fromClone = v.presetIndex.get('mutation')!;
    expect(v.presetTintFrom[fixed]).toBe(0);
    expect(v.presetTintFrom[fromDrug]).toBe(1);
    expect(v.presetTintFrom[fromClone]).toBe(2);
  });
});
