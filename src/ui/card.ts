import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { ProbeReading } from '../sim/simulator.js';
import type { SimulationSource } from '../source/types.js';
import type { World } from '../world/world.js';
import { el, fixed, percent } from './dom.js';
import { causeIsNoteworthy, causeLabel, cloneName, stateLabel } from './labels.js';
import type { Narrative } from './narrative.js';

/**
 * The cell under the pointer.
 *
 * Offset from the cursor so it never covers the thing being inspected, and
 * written as a sentence first and numbers second: what this cell is, what is
 * happening to it, and the one condition that explains why.
 */
export class Card {
  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
    private narrative: Narrative,
  ) {}

  hide(): void {
    this.root.classList.remove('on');
  }

  show(
    x: number,
    y: number,
    world: World,
    slot: number,
    readings: ProbeReading[],
    source: SimulationSource,
  ): void {
    const info = world.describe(slot);
    if (!info) {
      this.hide();
      return;
    }
    const frag = document.createDocumentFragment();
    const sw = el('span', { class: 'sw', style: 'width:9px;height:9px;border-radius:2.5px;flex:none' });
    sw.style.background = this.visuals.cloneCss(info.clone);

    frag.append(
      el('div', { class: 'ttl' }, [sw, document.createTextNode(stateLabel(this.rules, info.state))]),
    );

    if (causeIsNoteworthy(this.rules, info.cause)) {
      frag.append(
        el('div', { class: 'why', text: causeLabel(this.rules, info.cause, info.drug, info.clone) }),
      );
    }

    const resistant = this.narrative.isResistant(info.clone);
    frag.append(
      el('div', { class: 'why' }, [
        document.createTextNode(cloneName(this.rules, info.clone)),
        ...(resistant
          ? [el('span', { style: 'color:var(--resist)', text: ' · resistant' })]
          : []),
      ]),
    );

    const oxygen = source.field?.('oxygen')?.[info.node];
    const extras = readings.filter((r) => !/oxygen/i.test(r.label));
    if (oxygen !== undefined || extras.length) frag.append(el('hr'));

    if (oxygen !== undefined) frag.append(this.oxygen(oxygen));
    for (const r of extras) {
      frag.append(
        el('div', { class: 'r' }, [
          el('span', { class: 'k', text: r.label }),
          el('span', {
            class: 'v',
            text: r.format === 'fraction' ? `${percent(r.value)}%` : fixed(r.value, r.value >= 100 ? 0 : 2),
          }),
        ]),
      );
    }

    this.root.replaceChildren(frag);
    this.root.classList.add('on');

    // Offset from the pointer, and flipped when it would run off the edge.
    const pad = 18;
    const rect = this.root.getBoundingClientRect();
    const left = x + pad + rect.width > window.innerWidth ? x - pad - rect.width : x + pad;
    const top = Math.min(y + pad, window.innerHeight - rect.height - 12);
    this.root.style.left = `${Math.max(12, left)}px`;
    this.root.style.top = `${Math.max(12, top)}px`;
  }

  /**
   * Oxygen against the two thresholds that decide this cell's fate, both read
   * from rules.json. A bare percentage explains nothing on its own.
   */
  private oxygen(value: number): HTMLElement {
    const ox = this.rules.raw.oxygen;
    const max = ox.maximum ?? Math.max(1, ox.boundary);
    const at = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;

    let verdict = 'enough to divide';
    let color = 'var(--grow)';
    if (value < ox.necrosisThreshold) {
      verdict = 'too low to survive';
      color = 'var(--danger)';
    } else if (value < ox.arrestThreshold) {
      verdict = 'too low to divide';
      color = 'var(--resist)';
    }

    const fill = el('div', { class: 'fl' });
    fill.style.width = at(value);
    fill.style.background = color;
    const t1 = el('div', { class: 'tk' });
    t1.style.left = at(ox.necrosisThreshold);
    const t2 = el('div', { class: 'tk' });
    t2.style.left = at(ox.arrestThreshold);

    return el('div', { class: 'gauge' }, [
      el('div', { class: 'r' }, [
        el('span', { class: 'k', text: 'Oxygen here' }),
        el('span', { class: 'v', text: `${percent(value)}%` }),
      ]),
      el('div', { class: 'tr' }, [fill, t1, t2]),
      el('div', { class: 'cap' }, [
        el('span', { text: verdict }),
        el('span', { text: 'ticks mark the thresholds' }),
      ]),
    ]);
  }
}

/** The scale bar: computed from the voxel size and the camera, never placed. */
export class ScaleBar {
  private bar: HTMLElement;
  private label: HTMLElement;
  private last = '';

  constructor(root: HTMLElement, private voxelMicrons: number) {
    this.bar = root.querySelector('.bar') as HTMLElement;
    this.label = root.querySelector('.lab') as HTMLElement;
  }

  update(worldPerPixel: number): void {
    const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
    const perPx = worldPerPixel * this.voxelMicrons;
    const wanted = perPx * 110;
    let best = steps[0];
    for (const s of steps) {
      if (Math.abs(Math.log(s / wanted)) < Math.abs(Math.log(best / wanted))) best = s;
    }
    const text = best >= 1000 ? `${best / 1000} mm` : `${best} µm`;
    this.bar.style.width = `${Math.round(best / perPx)}px`;
    if (text !== this.last) {
      this.label.textContent = text;
      this.last = text;
    }
  }
}
