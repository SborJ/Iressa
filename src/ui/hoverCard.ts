import { NO_DRUG } from '../format/events.js';
import type { ResolvedRules } from '../sim/rules.js';
import type { ProbeReading } from '../sim/simulator.js';
import type { Visuals } from '../render/visuals.js';
import type { World } from '../world/world.js';
import { chip, el, formatReading } from './dom.js';
import { causeIsNoteworthy, causeLabel, cloneName, stateLabel } from './labels.js';

/**
 * What a cell is, and - when it is dying or arrested - why.
 *
 * Both the wording and the colours come from the data files, so a cause added
 * to rules.json shows up here with its own label and colour and no code change.
 */
export class HoverCard {
  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
  ) {}

  hide(): void {
    this.root.classList.remove('on');
  }

  show(clientX: number, clientY: number, world: World, slot: number, readings: ProbeReading[]): void {
    const info = world.describe(slot);
    if (!info) {
      this.hide();
      return;
    }
    const rules = this.rules;
    const frag = document.createDocumentFragment();

    frag.append(
      el('div', { class: 'hv-state' }, [
        chip(this.visuals.causeCss(info.cause)),
        document.createTextNode(stateLabel(rules, info.state)),
      ]),
    );

    if (causeIsNoteworthy(rules, info.cause)) {
      const drug = info.drug;
      const label = causeLabel(rules, info.cause, drug, info.clone);
      frag.append(
        el('div', { class: 'hv-cause' }, [
          chip(drug === NO_DRUG ? this.visuals.causeCss(info.cause) : this.visuals.drugCss(drug)),
          document.createTextNode(label),
        ]),
      );
    }

    frag.append(
      el('div', { class: 'hv-clone' }, [
        chip(this.visuals.cloneCss(info.clone)),
        document.createTextNode(cloneName(rules, info.clone)),
      ]),
    );

    if (readings.length) {
      frag.append(el('div', { class: 'hv-rule' }));
      const dl = el('dl');
      for (const r of readings) {
        dl.append(
          el('div', { class: 'readout' }, [
            el('dt', { text: r.label }),
            el('dd', { text: formatReading(r.value, r.format) }),
          ]),
        );
      }
      frag.append(dl);
    }

    frag.append(
      el('div', { class: 'hv-rule' }),
      el('div', { class: 'readout' }, [
        el('dt', { text: 'Voxel' }),
        el('dd', { text: `${info.x}, ${info.y}, ${info.z}` }),
      ]),
    );

    this.root.replaceChildren(frag);
    this.root.classList.add('on');

    // Keep the card on screen.
    const pad = 14;
    const rect = this.root.getBoundingClientRect();
    const x = Math.min(clientX + pad, window.innerWidth - rect.width - pad);
    const y = Math.min(clientY + pad, window.innerHeight - rect.height - pad);
    this.root.style.left = `${Math.max(pad, x)}px`;
    this.root.style.top = `${Math.max(pad, y)}px`;
  }
}
