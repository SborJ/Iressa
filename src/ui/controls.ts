import type { ColorBy, CutMode } from '../render/viewer.js';
import type { Visuals } from '../render/visuals.js';
import { el } from './dom.js';

export interface ControlState {
  playing: boolean;
  ticksPerSecond: number;
  view: string;
  colorBy: ColorBy;
  cutMode: CutMode;
  cutFraction: number;
  presentation: boolean;
}

export interface ControlHandlers {
  onChange(state: ControlState, changed: keyof ControlState | 'init'): void;
  onStep(): void;
  onReset(): void;
  onFrame(): void;
}

const SPEEDS = [1, 2, 4, 8, 16, 32, 64];

/**
 * The controls.
 *
 * The imaging switch lives in the top bar, where it belongs: it changes what
 * the whole screen is. Everything that shapes the view sits in one group under
 * the scene, and the rest - rate, reset - is one disclosure down, because it is
 * reached once a session rather than once a minute.
 */
export class Controls {
  readonly state: ControlState;
  readonly viewSwitch = el('div', { class: 'seg' });

  private viewButtons = new Map<string, HTMLButtonElement>();
  private colorButtons = new Map<ColorBy, HTMLButtonElement>();
  private cutButtons = new Map<CutMode, HTMLButtonElement>();
  private speedLabel = el('span', { class: 'v' });

  constructor(
    private root: HTMLElement,
    private visuals: Visuals,
    private handlers: ControlHandlers,
  ) {
    this.state = {
      playing: true,
      ticksPerSecond: 8,
      view: visuals.defaultViewName,
      colorBy: 'clone',
      cutMode: 'octant',
      cutFraction: 0,
      presentation: false,
    };

    /* ---- imaging, in the top bar ---- */
    for (const name of visuals.viewNames) {
      const spec = visuals.view(name);
      const b = el('button', { type: 'button', text: spec.label, title: spec.description ?? '' });
      b.addEventListener('click', () => this.setView(name));
      this.viewButtons.set(name, b);
      this.viewSwitch.append(b);
    }

    /* ---- section ---- */
    const cutRow = el('div', { class: 'seg full' });
    for (const [mode, label] of [
      ['octant', 'Quarter'],
      ['plane', 'Half'],
      ['none', 'Whole'],
    ] as [CutMode, string][]) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', () => {
        this.state.cutMode = mode;
        this.sync();
        this.handlers.onChange(this.state, 'cutMode');
      });
      this.cutButtons.set(mode, b);
      cutRow.append(b);
    }
    const cutSlider = el('input', {
      type: 'range', min: '-0.6', max: '1', step: '0.02', value: '0',
      'aria-label': 'How deep the cut goes',
      style: 'width:100%;margin-top:10px;accent-color:var(--accent)',
    }) as HTMLInputElement;
    cutSlider.addEventListener('input', () => {
      this.state.cutFraction = Number(cutSlider.value);
      this.handlers.onChange(this.state, 'cutFraction');
    });

    /* ---- colouring ---- */
    const colorRow = el('div', { class: 'seg full' });
    for (const [mode, label] of [
      ['clone', 'By lineage'],
      ['cause', 'By outcome'],
    ] as [ColorBy, string][]) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this.state.colorBy = mode;
        this.sync();
        this.handlers.onChange(this.state, 'colorBy');
      });
      this.colorButtons.set(mode, b);
      colorRow.append(b);
    }

    const frameBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Recentre' });
    frameBtn.style.flex = '1';
    frameBtn.addEventListener('click', () => handlers.onFrame());
    const presentBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Cinematic' });
    presentBtn.style.flex = '1';
    presentBtn.title = 'Focus the cut face and blur the depth behind it';
    presentBtn.addEventListener('click', () => {
      this.state.presentation = !this.state.presentation;
      presentBtn.classList.toggle('primary', this.state.presentation);
      this.handlers.onChange(this.state, 'presentation');
    });

    const speed = el('input', {
      type: 'range', min: '0', max: String(SPEEDS.length - 1), step: '1',
      value: String(SPEEDS.indexOf(this.state.ticksPerSecond)),
      'aria-label': 'How fast time runs',
      style: 'width:100%;accent-color:var(--accent)',
    }) as HTMLInputElement;
    speed.addEventListener('input', () => {
      this.state.ticksPerSecond = SPEEDS[Number(speed.value)];
      this.speedLabel.textContent = `${this.state.ticksPerSecond}× `;
      this.handlers.onChange(this.state, 'ticksPerSecond');
    });
    this.speedLabel.textContent = `${this.state.ticksPerSecond}× `;

    const resetBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Start over' });
    resetBtn.style.width = '100%';
    resetBtn.addEventListener('click', () => handlers.onReset());

    this.root.append(
      el('div', { class: 'block' }, [
        el('div', { class: 'muted', style: 'margin-bottom:8px', text: 'Cut away' }),
        cutRow,
        cutSlider,
        el('div', { style: 'display:flex;gap:6px;margin-top:10px' }, [frameBtn, presentBtn]),
        el('div', { class: 'muted', style: 'margin:16px 0 8px', text: 'Colour the cells' }),
        colorRow,
        el('div', { class: 'r', style: 'margin-top:16px' }, [
          el('span', { class: 'k', text: 'Speed' }),
          this.speedLabel,
        ]),
        speed,
        el('div', { style: 'margin-top:12px' }, [resetBtn]),
      ]),
    );

    this.sync();
  }

  togglePlay(): void {
    this.state.playing = !this.state.playing;
    this.handlers.onChange(this.state, 'playing');
  }

  step(): void {
    this.state.playing = false;
    this.handlers.onChange(this.state, 'playing');
    this.handlers.onStep();
  }

  setView(name: string): void {
    if (!this.viewButtons.has(name)) return;
    this.state.view = name;
    this.sync();
    this.handlers.onChange(this.state, 'view');
  }

  setPlaying(playing: boolean): void {
    this.state.playing = playing;
  }

  get viewNames(): string[] {
    return this.visuals.viewNames;
  }

  private sync(): void {
    for (const [name, b] of this.viewButtons) {
      b.setAttribute('aria-pressed', String(name === this.state.view));
    }
    for (const [mode, b] of this.cutButtons) {
      b.setAttribute('aria-pressed', String(mode === this.state.cutMode));
    }
    /* H&E is a two-dye stain, not a per-cause channel: colouring by cause would
       stop it being a histology image at all. */
    const histology = this.state.view === 'histology';
    const causeBtn = this.colorButtons.get('cause');
    if (causeBtn) {
      causeBtn.disabled = histology;
      causeBtn.title = histology
        ? 'Not available in Histology — H&E is a two-dye stain, not a per-cause channel'
        : 'Tint every cell by why it is in the state it is in';
    }
    if (histology && this.state.colorBy === 'cause') this.state.colorBy = 'clone';
    for (const [mode, b] of this.colorButtons) {
      b.setAttribute('aria-pressed', String(mode === this.state.colorBy));
    }
  }
}
