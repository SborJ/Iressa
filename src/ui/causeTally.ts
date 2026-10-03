import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { CauseStats } from '../world/causeStats.js';
import { chip, el } from './dom.js';
import { causeName } from './labels.js';

/**
 * The live tally: deaths by cause over the last simulated day, and how many
 * cells are arrested for each reason right now.
 *
 * Rows are driven by the cause table in rules.json, so a new cause appears
 * here as soon as it fires.
 */
export class CauseTally {
  private deathBody = el('div');
  private arrestBody = el('div');
  private deathHead = el('h2');

  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
  ) {
    this.deathHead.textContent = 'Deaths — last 24 h';
    this.root.replaceChildren(
      this.deathHead,
      this.deathBody,
      el('div', { class: 'rule' }),
      el('h2', { text: 'Arrested now' }),
      this.arrestBody,
    );
  }

  update(stats: CauseStats): void {
    this.renderRows(
      this.deathBody,
      this.rules.raw.causes.filter((c) => c.kind === 'death').map((c) => c.id),
      stats.window,
      'No deaths in the last day',
    );
    this.renderRows(
      this.arrestBody,
      this.rules.raw.causes.filter((c) => c.kind === 'arrest').map((c) => c.id),
      stats.stateChanges,
      'No cells arrested',
    );
  }

  private renderRows(host: HTMLElement, causeIds: number[], counts: Int32Array, emptyText: string): void {
    const rows = causeIds
      .map((id) => ({ id, n: counts[id] }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);

    if (!rows.length) {
      host.replaceChildren(el('div', { class: 'empty', text: emptyText }));
      return;
    }
    const max = rows[0].n;
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const color = this.visuals.causeCss(r.id);
      const bar = el('div', { class: 'tally-bar' });
      const fill = el('i');
      fill.style.width = `${Math.max(2, (100 * r.n) / max)}%`;
      fill.style.background = color;
      bar.append(fill);
      frag.append(
        el('div', { class: 'tally-row' }, [
          chip(color),
          el('span', { class: 'name', text: causeName(this.rules, r.id) }),
          el('span', { class: 'num', text: r.n.toLocaleString() }),
        ]),
        el('div', { class: 'tally-row' }, [bar]),
      );
    }
    host.replaceChildren(frag);
  }
}
