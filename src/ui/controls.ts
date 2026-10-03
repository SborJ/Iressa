import type { ViewMode } from '../render/cellMesh.js';
import type { ClipAxis } from '../render/viewer.js';
import { el } from './dom.js';

export interface ControlState {
  playing: boolean;
  ticksPerSecond: number;
  viewMode: ViewMode;
  clipAxis: ClipAxis;
  clipFraction: number;
}

export interface ControlHandlers {
  onChange(state: ControlState): void;
  onStep(): void;
  onReset(): void;
}

const SPEEDS = [1, 2, 4, 8, 16, 32, 64];

export class Controls {
  readonly state: ControlState = {
    playing: true,
    ticksPerSecond: 8,
    viewMode: 'clone',
    clipAxis: 'none',
    clipFraction: 1,
  };

  private playBtn = el('button', { type: 'button' });
  private speedLabel = el('span', { class: 'val' });
  private modeButtons = new Map<ViewMode, HTMLButtonElement>();
  private clipButtons = new Map<ClipAxis, HTMLButtonElement>();

  constructor(private root: HTMLElement, private handlers: ControlHandlers) {
    this.playBtn.addEventListener('click', () => {
      this.state.playing = !this.state.playing;
      this.syncPlay();
      this.emit();
    });
    const stepBtn = el('button', { type: 'button', text: 'Step' });
    stepBtn.addEventListener('click', () => {
      this.state.playing = false;
      this.syncPlay();
      this.emit();
      this.handlers.onStep();
    });
    const resetBtn = el('button', { type: 'button', text: 'Reset' });
    resetBtn.addEventListener('click', () => this.handlers.onReset());

    const speed = el('input', {
      type: 'range',
      min: '0',
      max: String(SPEEDS.length - 1),
      step: '1',
      value: String(SPEEDS.indexOf(this.state.ticksPerSecond)),
      'aria-label': 'Ticks per second',
    }) as HTMLInputElement;
    speed.addEventListener('input', () => {
      this.state.ticksPerSecond = SPEEDS[Number(speed.value)];
      this.speedLabel.textContent = `${this.state.ticksPerSecond}/s`;
      this.emit();
    });
    this.speedLabel.textContent = `${this.state.ticksPerSecond}/s`;

    const modeRow = el('div', { class: 'btnrow' });
    for (const [mode, label] of [
      ['clone', 'Clone'],
      ['cause', 'Cause'],
    ] as [ViewMode, string][]) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', () => {
        this.state.viewMode = mode;
        this.syncMode();
        this.emit();
      });
      this.modeButtons.set(mode, b);
      modeRow.append(b);
    }

    const clipRow = el('div', { class: 'btnrow' });
    for (const [axis, label] of [
      ['none', 'Off'],
      ['x', 'X'],
      ['y', 'Y'],
      ['z', 'Z'],
    ] as [ClipAxis, string][]) {
      const b = el('button', { type: 'button', text: label });
      b.addEventListener('click', () => {
        this.state.clipAxis = axis;
        this.syncClip();
        this.emit();
      });
      this.clipButtons.set(axis, b);
      clipRow.append(b);
    }
    const clipSlider = el('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      value: '1',
      'aria-label': 'Cutaway depth',
    }) as HTMLInputElement;
    clipSlider.addEventListener('input', () => {
      this.state.clipFraction = Number(clipSlider.value);
      this.emit();
    });

    this.root.replaceChildren(
      el('h2', { text: 'Controls' }),
      el('div', { class: 'ctl' }, [el('div', { class: 'btnrow' }, [this.playBtn, stepBtn, resetBtn])]),
      el('div', { class: 'ctl' }, [
        el('label', {}, [document.createTextNode('Speed'), this.speedLabel]),
        speed,
      ]),
      el('div', { class: 'ctl' }, [el('label', { text: 'Colour by' }), modeRow]),
      el('div', { class: 'ctl' }, [el('label', { text: 'Cutaway' }), clipRow, clipSlider]),
    );

    this.syncPlay();
    this.syncMode();
    this.syncClip();
  }

  private syncPlay(): void {
    this.playBtn.textContent = this.state.playing ? 'Pause' : 'Play';
  }

  private syncMode(): void {
    for (const [mode, b] of this.modeButtons) {
      b.setAttribute('aria-pressed', String(mode === this.state.viewMode));
    }
  }

  private syncClip(): void {
    for (const [axis, b] of this.clipButtons) {
      b.setAttribute('aria-pressed', String(axis === this.state.clipAxis));
    }
  }

  setPlaying(playing: boolean): void {
    this.state.playing = playing;
    this.syncPlay();
  }

  private emit(): void {
    this.handlers.onChange(this.state);
  }
}
