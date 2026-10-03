import { el } from './dom.js';
import { TONE } from './tone.js';
import type { Story } from './narrative.js';

/**
 * The sentence across the top: what is happening, and why.
 *
 * It is the first thing read and the only thing that has to be read. Everything
 * else on screen supports it.
 */
export class Headline {
  private dot: HTMLElement;
  private say: HTMLElement;
  private because: HTMLElement;
  private last = '';

  constructor(root: HTMLElement) {
    this.dot = root.querySelector('.dot') as HTMLElement;
    this.say = root.querySelector('.say') as HTMLElement;
    this.because = root.querySelector('.because') as HTMLElement;
  }

  update(story: Story): void {
    const key = `${story.say}|${story.because}`;
    if (key === this.last) return;
    this.last = key;
    this.dot.style.background = TONE[story.tone];
    this.say.textContent = story.say;
    this.say.style.color = story.tone === 'neutral' ? 'var(--fg)' : TONE[story.tone];
    this.because.textContent = story.because;
  }
}

/** Small stage labels: the view you are in, and what the section shows. */
export class StageTags {
  private viewPill = el('span', { class: 'pill' });
  private cutPill = el('span', { class: 'pill' });

  constructor(root: HTMLElement) {
    root.append(this.viewPill, this.cutPill);
  }

  update(opts: { viewLabel: string; description: string; cutMode: string; colorBy: string; cloneSwatch?: string }): void {
    this.viewPill.replaceChildren(
      el('b', { text: opts.viewLabel }),
      document.createTextNode(opts.description),
    );
    const cut =
      opts.cutMode === 'octant' ? 'Quarter cut away'
      : opts.cutMode === 'plane' ? 'Half cut away'
      : 'Whole tumour';
    this.cutPill.replaceChildren(
      el('b', { text: cut }),
      document.createTextNode(
        opts.colorBy === 'cause' ? 'coloured by why each cell is in its state' : 'coloured by lineage',
      ),
    );
  }
}
