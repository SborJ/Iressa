import { el, svg } from './dom.js';
import { move, swapText } from './motion.js';
import type { Story } from './narrative.js';
import { TONE } from './tone.js';

const R = 7;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * A share, as a ring that fills.
 *
 * The value it carries moves every tick. Spelled out inside the sentence it
 * made the whole line re-flow and re-fade continuously; as a ring it is read at
 * a glance, and only the ring moves.
 */
class Ring {
  readonly node: HTMLElement;
  private arc = svg('circle', {
    cx: 9, cy: 9, r: R,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 2.5,
    'stroke-linecap': 'round',
    'stroke-dasharray': CIRCUMFERENCE.toFixed(2),
    'stroke-dashoffset': CIRCUMFERENCE.toFixed(2),
    transform: 'rotate(-90 9 9)',
  });
  private readout = el('span', { class: 'ring-value' });
  private value = -1;

  constructor() {
    const s = svg('svg', { width: 18, height: 18, viewBox: '0 0 18 18', 'aria-hidden': 'true' });
    s.append(
      svg('circle', {
        cx: 9, cy: 9, r: R,
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2.5,
        'stroke-opacity': 0.22,
      }),
      this.arc,
    );
    this.node = el('span', { class: 'ring', role: 'img' }, [s, this.readout]);
  }

  set(value: number, label: string): void {
    const clamped = Math.max(0, Math.min(1, value));
    if (Math.abs(clamped - this.value) > 0.0005) {
      this.value = clamped;
      this.arc.setAttribute('stroke-dashoffset', (CIRCUMFERENCE * (1 - clamped)).toFixed(2));
      this.readout.textContent = `${Math.round(clamped * 100)}%`;
    }
    this.node.setAttribute('aria-label', label);
    this.node.title = label;
  }
}

/**
 * The sentence across the top: what is happening, and why.
 *
 * Only a change of phase animates. The supporting clause carries live values,
 * and crossfading those on every update is a flicker rather than an animation.
 */
export class Headline {
  private dot: HTMLElement;
  private say: HTMLElement;
  private because: HTMLElement;
  private ring = new Ring();
  private phase = '';

  constructor(root: HTMLElement) {
    this.dot = root.querySelector('.dot') as HTMLElement;
    this.say = root.querySelector('.say') as HTMLElement;
    this.because = root.querySelector('.because') as HTMLElement;
    this.because.before(this.ring.node);
    this.ring.node.hidden = true;
  }

  update(story: Story): void {
    const tone = TONE[story.tone];
    const phaseChanged = story.phase !== this.phase;

    if (phaseChanged) {
      this.phase = story.phase;
      this.dot.style.background = tone;
      this.say.style.color = story.tone === 'neutral' ? 'var(--fg)' : tone;
      this.ring.node.style.color = tone;
      swapText(this.say, story.say);
      // One pulse when the experiment enters a new phase, and never otherwise.
      move(this.dot, { transform: ['scale(1)', 'scale(1.6)', 'scale(1)'] }, 0.45);
    }

    if (story.meter) {
      this.ring.node.hidden = false;
      this.ring.set(story.meter.value, story.meter.label);
    } else {
      this.ring.node.hidden = true;
    }

    // Set in place: this clause tracks live values and must not fade.
    if (this.because.textContent !== story.because) {
      this.because.textContent = story.because;
    }
  }
}

/** Small stage labels: the view you are in, and what the section shows. */
export class StageTags {
  private viewPill = el('span', { class: 'pill' });
  private cutPill = el('span', { class: 'pill' });

  constructor(root: HTMLElement) {
    root.append(this.viewPill, this.cutPill);
  }

  update(opts: {
    viewLabel: string;
    description: string;
    cutMode: string;
    colorBy: string;
  }): void {
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
