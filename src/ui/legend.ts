import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import { chip, el } from './dom.js';
import { cloneName } from './labels.js';

/**
 * What the colours mean in the active view, and - kept separate and labelled -
 * which parts of the picture are illustration rather than data.
 */
export class Legend {
  private body = el('div');

  constructor(
    private root: HTMLElement,
    private rules: ResolvedRules,
    private visuals: Visuals,
  ) {
    this.root.replaceChildren(el('h2', { text: 'Legend' }), this.body);
  }

  update(viewName: string): void {
    const v = this.visuals.view(viewName);
    const frag = document.createDocumentFragment();

    for (const clone of this.rules.raw.clones) {
      frag.append(
        el('div', { class: 'legend-row' }, [
          chip(v.cloneColors[String(clone.id)] ?? '#888888'),
          el('span', { class: 'name', text: cloneName(this.rules, clone.id) }),
        ]),
      );
    }
    const extras: [string | undefined, string][] = [
      [v.nucleus, 'Nucleus'],
      [v.blood, 'Red blood cells'],
      [v.vesselWall, 'Vessel wall'],
      [v.surface, 'Tumour surface'],
    ];
    for (const [color, label] of extras) {
      if (!color) continue;
      frag.append(
        el('div', { class: 'legend-row' }, [
          chip(color),
          el('span', { class: 'name', text: label }),
        ]),
      );
    }

    /* Everything on screen is a real node in its real place with its real
       state, except these. They are styling and motion, and say so. */
    frag.append(
      el('div', { class: 'rule' }),
      el('p', { class: 'note' }, [
        el('strong', { text: 'Illustrative: ' }),
        document.createTextNode(
          'membrane line styling, the cell texture on the distant surface, and red blood cell flow. ' +
            'Everything else is one rendered cell per occupied node, in its own voxel, with its own state.',
        ),
      ]),
    );
    this.body.replaceChildren(frag);
  }
}
