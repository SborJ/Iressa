import type { ResolvedRules } from '../sim/rules.js';
import type { WorldCounts } from './counts.js';
import type { History } from './history.js';
import { cloneName } from './labels.js';

export type Phase =
  | 'seeding'
  | 'growing'
  | 'treated'
  | 'responding'
  | 'resisting'
  | 'relapsing'
  | 'cleared'
  | 'irradiated';

export interface Story {
  phase: Phase;
  /** What is happening, in one short clause. */
  say: string;
  /** Why that is happening, or what it implies. */
  because: string;
  /** Which semantic colour the state belongs to. */
  tone: 'grow' | 'respond' | 'resist' | 'danger' | 'neutral';
  /**
   * A share worth watching, drawn as a filling ring rather than spelled out in
   * the sentence. A number inside a clause changes every tick and drags the
   * whole line with it; a ring carries the same reading at a glance and leaves
   * the words still.
   */
  meter?: { value: number; label: string };
}

/**
 * What is happening, in words.
 *
 * Every number in this interface is true and almost none of it is legible on
 * its own: "1,586" is not an answer to anything, and neither is "T790M 985".
 * This turns the same data into the sentence a person actually wants - which
 * phase the experiment is in, and what is driving it - by reading the schedule
 * out of rules.json, the composition out of the world and the trend out of the
 * interface's own history.
 *
 * It states no biology of its own. Which clone counts as resistant is decided
 * by comparing each clone's IC50 for the drug being given against the clone the
 * tumour was seeded with, both from rules.json.
 */
export class Narrative {
  private readonly resistant: Set<number>;

  constructor(private rules: ResolvedRules) {
    this.resistant = this.findResistantClones();
  }

  /**
   * A clone is resistant if the drug has to be several times more concentrated
   * to touch it than to touch the founder. The factor is a reading threshold,
   * not biology: the biology is the IC50s it compares.
   */
  private findResistantClones(): Set<number> {
    const out = new Set<number>();
    const founder = this.rules.clones[this.rules.raw.seeding.clone];
    if (!founder) return out;
    for (const spec of this.rules.raw.clones) {
      const clone = this.rules.clones[spec.id];
      if (!clone || clone.id === founder.id) continue;
      for (const drug of this.rules.raw.drugs ?? []) {
        const mine = clone.drug[drug.id]?.ic50;
        const theirs = founder.drug[drug.id]?.ic50;
        if (mine !== undefined && theirs !== undefined && mine >= theirs * 3) {
          out.add(clone.id);
          break;
        }
      }
    }
    return out;
  }

  /** Drugs whose dosing window covers this moment. */
  activeDrugs(hours: number): string[] {
    const out: string[] = [];
    for (const s of this.rules.raw.treatment?.schedule ?? []) {
      const end = s.startHour + s.everyHours * s.doses;
      if (hours >= s.startHour && hours <= end) {
        const d = this.rules.drugById.get(s.drug);
        out.push(d?.name ?? `drug ${s.drug}`);
      }
    }
    return out;
  }

  /** A radiation fraction within the last day. */
  private recentRadiation(hours: number): boolean {
    return (this.rules.raw.treatment?.radiation ?? []).some(
      (r) => hours >= r.hour && hours - r.hour < 24,
    );
  }

  /** The share of living cells belonging to a clone that resists the treatment. */
  resistantShare(counts: WorldCounts): { share: number; cloneId: number; n: number } {
    let best = { share: 0, cloneId: -1, n: 0 };
    if (!counts.living) return best;
    for (const id of this.resistant) {
      const n = counts.byClone.get(id) ?? 0;
      const share = n / counts.living;
      if (share > best.share) best = { share, cloneId: id, n };
    }
    return best;
  }

  isResistant(cloneId: number): boolean {
    return this.resistant.has(cloneId);
  }

  read(counts: WorldCounts, history: History, tick: number): Story {
    const hours = tick * this.rules.hoursPerTick;
    const day = hours / 24;
    const drugs = this.activeDrugs(hours);
    const change = history.changePerDay('living');
    const resistant = this.resistantShare(counts);
    const pct = (f: number) => `${Math.round(f * 100)}%`;

    if (counts.living === 0) {
      return {
        phase: 'cleared',
        say: 'No tumour cells left',
        because: counts.dying > 0 ? `${counts.dying.toLocaleString()} still clearing` : 'the run is over',
        tone: 'respond',
      };
    }
    if (tick < 4) {
      return {
        phase: 'seeding',
        say: 'Seeding',
        because: `${counts.living.toLocaleString()} cells placed beside a vessel`,
        tone: 'neutral',
      };
    }
    if (this.recentRadiation(hours)) {
      return {
        phase: 'irradiated',
        say: 'Irradiated',
        because: 'cells hit this fraction die at their next attempt to divide',
        tone: 'danger',
      };
    }

    const growing = change !== undefined && change > counts.living * 0.01;
    const shrinking = change !== undefined && change < -counts.living * 0.01;

    /* Resistance is the headline as soon as it is most of what is left: that is
       the moment the treatment has stopped working, and it is invisible in any
       single number on screen. */
    if (drugs.length && resistant.share > 0.5) {
      return {
        phase: growing ? 'relapsing' : 'resisting',
        say: growing ? 'Relapsing' : 'Resistance established',
        because: `of the tumour is ${cloneName(this.rules, resistant.cloneId)}, which ${drugs[0]} no longer reaches`,
        tone: 'resist',
        meter: {
          value: resistant.share,
          label: `${cloneName(this.rules, resistant.cloneId)} is ${pct(resistant.share)} of living cells`,
        },
      };
    }
    if (drugs.length && resistant.share > 0.05) {
      return {
        phase: 'resisting',
        say: 'Resistance emerging',
        because: `of the tumour is now ${cloneName(this.rules, resistant.cloneId)}`,
        tone: 'resist',
        meter: {
          value: resistant.share,
          label: `${cloneName(this.rules, resistant.cloneId)} is ${pct(resistant.share)} of living cells`,
        },
      };
    }
    if (drugs.length && shrinking) {
      const lost = Math.abs(change!);
      const fraction = Math.min(1, lost / Math.max(1, counts.living + lost));
      return {
        phase: 'responding',
        say: `Responding to ${drugs[0]}`,
        because: 'of the tumour was lost in the last day',
        tone: 'respond',
        meter: { value: fraction, label: `${pct(fraction)} fewer cells than a day ago` },
      };
    }
    if (drugs.length) {
      return {
        phase: 'treated',
        say: `On ${drugs.join(' + ')}`,
        because: growing
          ? 'the tumour is still gaining ground'
          : 'holding steady under treatment',
        tone: growing ? 'resist' : 'respond',
      };
    }

    const doubling = this.doublingDays(history);
    return {
      phase: 'growing',
      say: 'Growing, untreated',
      because: doubling
        ? `doubling about every ${doubling.toFixed(1)} days`
        : `day ${day.toFixed(1)}, before the first dose`,
      tone: 'grow',
    };
  }

  /** Doubling time from the population trace, when the trace shows growth. */
  private doublingDays(history: History): number | undefined {
    const living = history.values('living');
    const ticks = history.tickValues();
    if (living.length < 8 || ticks.length !== living.length) return undefined;
    const last = living[living.length - 1];
    const span = Math.min(living.length - 1, this.rules.ticksPerDay * 3);
    const first = living[living.length - 1 - span];
    if (first <= 0 || last <= first) return undefined;
    const days = ((ticks[ticks.length - 1] - ticks[ticks.length - 1 - span]) * this.rules.hoursPerTick) / 24;
    const growth = Math.log2(last / first);
    return growth > 0.05 ? days / growth : undefined;
  }

  /**
   * The run as named phases for the timeline: one per stretch in which the set
   * of drugs being given is constant. Drugs given together ("endocrine +
   * palbociclib") form one phase, so overlapping schedule entries never draw on
   * top of each other; sequential single drugs come out one phase each.
   */
  phases(): { from: number; to: number; label: string; tone: Story['tone'] }[] {
    const out: { from: number; to: number; label: string; tone: Story['tone'] }[] = [];
    const maxHours = this.rules.maxTicks * this.rules.hoursPerTick;
    const schedule = (this.rules.raw.treatment?.schedule ?? []).map((s) => ({
      from: s.startHour,
      to: Math.min(maxHours, s.startHour + s.everyHours * s.doses),
      drug: s.drug,
    }));
    if (!schedule.length) {
      return [{ from: 0, to: maxHours, label: 'Growth', tone: 'grow' }];
    }
    const edges = [...new Set([0, maxHours, ...schedule.flatMap((s) => [s.from, s.to])])]
      .filter((h) => h >= 0 && h <= maxHours)
      .sort((a, b) => a - b);
    const lastTreated = Math.max(...schedule.map((s) => s.to));
    for (let i = 0; i + 1 < edges.length; i++) {
      const from = edges[i];
      const to = edges[i + 1];
      if (to <= from) continue;
      const active = schedule.filter((s) => s.from <= from && s.to >= to).map((s) => s.drug);
      let label: string;
      let tone: Story['tone'];
      if (active.length) {
        const names = [...new Set(active)].sort((a, b) => a - b).map((id) => this.rules.drugById.get(id)?.name ?? 'treatment');
        label = names.join(' + ');
        tone = 'respond';
      } else if (from >= lastTreated) {
        label = 'Off treatment';
        tone = 'resist';
      } else {
        label = 'Untreated growth';
        tone = 'grow';
      }
      const previous = out[out.length - 1];
      if (previous && previous.label === label && previous.to === from) previous.to = to;
      else out.push({ from, to, label, tone });
    }
    return out;
  }
}
