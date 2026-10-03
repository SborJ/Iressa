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

export class Controls {
  readonly state: ControlState;

  private playBtn = el('button', { type: 'button' });
  private speedLabel = el('span', { class: 'val' });
  private viewButtons = new Map<string, HTMLButtonElement>();
  private colorButtons = new Map<ColorBy, HTMLButtonElement>();
  private cutButtons = new Map<CutMode, HTMLButtonElement>();
  private presentBtn = el('button', { type: 'button', text: 'Presentation' });

  constructor(
    private root: HTMLElement,
    visuals: Visuals,
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

    this.playBtn.addEventListener('click', () => {
      this.state.playing = !this.state.playing;
      this.syncPlay();
      this.emit('playing');
    });
    const stepBtn = el('button', { type: 'button', text: 'Step' });
    stepBtn.addEventListener('click', () => {
      this.state.playing = false;
      this.syncPlay();
      this.emit('playing');
      this.handlers.onStep();
    });
    const resetBtn = el('button', { type: 'button', text: 'Reset' });
    resetBtn.addEventListener('click', () => this.handlers.onReset());

    const speed = el('input', {
      type: 'range', min: '0', max: String(SPEEDS.length - 1), step: '1',
      value: String(SPEEDS.indexOf(this.state.ticksPerSecond)),
      'aria-label': 'Ticks per second',
    }) as HTMLInputElement;
    speed.addEventListener('input', () => {
      this.state.ticksPerSecond = SPEEDS[Number(speed.value)];
      this.speedLabel.textContent = `${this.state.ticksPerSecond}/s`;
      this.emit('ticksPerSecond');
    });
    this.speedLabel.textContent = `${this.state.ticksPerSecond}/s`;

    /* Imaging view: the three looks are declared in visuals.json. */
    const viewRow = el('div', { class: 'btnrow wrap' });
    for (const name of visuals.viewNames) {
      const spec = visuals.view(name);
      const b = el('button', { type: 'button', text: spec.label, title: spec.description ?? '' });
      b.addEventListener('click', () => {
        this.state.view = name;
        this.syncView();
        this.emit('view');
      });
      this.viewButtons.set(name, b);
      viewRow.append(b);
    }

    const colorRow = el('div', { class: 'btnrow' });
    for (const [mode, label] of [['clone', 'Clone'], ['cause', 'Cause']] as [ColorBy, string][]) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', () => {
        if (b.disabled) return;
        this.state.colorBy = mode;
        this.syncColor();
        this.emit('colorBy');
      });
      this.colorButtons.set(mode, b);
      colorRow.append(b);
    }

    const cutRow = el('div', { class: 'btnrow' });
    for (const [mode, label] of [
      ['octant', 'Quarter'],
      ['plane', 'Half'],
      ['none', 'Whole'],
    ] as [CutMode, string][]) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', () => {
        this.state.cutMode = mode;
        this.syncCut();
        this.emit('cutMode');
      });
      this.cutButtons.set(mode, b);
      cutRow.append(b);
    }
    const cutSlider = el('input', {
      type: 'range', min: '-0.6', max: '1', step: '0.02', value: '0',
      'aria-label': 'Cut depth',
    }) as HTMLInputElement;
    cutSlider.addEventListener('input', () => {
      this.state.cutFraction = Number(cutSlider.value);
      this.emit('cutFraction');
    });

    const frameBtn = el('button', { type: 'button', text: 'Frame cut' });
    frameBtn.addEventListener('click', () => this.handlers.onFrame());
    this.presentBtn.addEventListener('click', () => {
      this.state.presentation = !this.state.presentation;
      this.presentBtn.setAttribute('aria-pressed', String(this.state.presentation));
      this.emit('presentation');
    });

    this.root.replaceChildren(
      el('h2', { text: 'Controls' }),
      el('div', { class: 'ctl' }, [el('label', { text: 'Imaging' }), viewRow]),
      el('div', { class: 'ctl' }, [
        el('label', { text: 'Cut' }), cutRow, cutSlider,
        el('div', { class: 'btnrow' }, [frameBtn, this.presentBtn]),
      ]),
      el('div', { class: 'ctl' }, [el('label', { text: 'Colour by' }), colorRow]),
      el('div', { class: 'rule' }),
      el('div', { class: 'ctl' }, [
        el('div', { class: 'btnrow' }, [this.playBtn, stepBtn, resetBtn]),
      ]),
      el('div', { class: 'ctl' }, [
        el('label', {}, [document.createTextNode('Speed'), this.speedLabel]), speed,
      ]),
    );

    this.syncPlay();
    this.syncView();
    this.syncColor();
    this.syncCut();
    this.presentBtn.setAttribute('aria-pressed', 'false');
  }

  private syncPlay(): void {
    this.playBtn.textContent = this.state.playing ? 'Pause' : 'Play';
  }

  private syncView(): void {
    for (const [name, b] of this.viewButtons) {
      b.setAttribute('aria-pressed', String(name === this.state.view));
    }
    /* H&E is a two-dye stain, not a per-cause channel: colouring by cause would
       stop it being a histology image at all. */
    const histology = this.state.view === 'histology';
    const causeBtn = this.colorButtons.get('cause');
    if (causeBtn) {
      causeBtn.disabled = histology;
      causeBtn.title = histology
        ? 'H&E is a two-dye stain, not a per-cause channel'
        : 'Tint every cell by the cause of its current state';
    }
    if (histology && this.state.colorBy === 'cause') {
      this.state.colorBy = 'clone';
      this.syncColor();
    }
  }

  private syncColor(): void {
    for (const [mode, b] of this.colorButtons) {
      b.setAttribute('aria-pressed', String(mode === this.state.colorBy));
    }
  }

  private syncCut(): void {
    for (const [mode, b] of this.cutButtons) {
      b.setAttribute('aria-pressed', String(mode === this.state.cutMode));
    }
  }

  setPlaying(playing: boolean): void {
    this.state.playing = playing;
    this.syncPlay();
  }

  private emit(changed: keyof ControlState | 'init'): void {
    this.handlers.onChange(this.state, changed);
  }
}
