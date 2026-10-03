import type { ColorBy, CutMode } from '../render/viewer.js';
import type { Visuals } from '../render/visuals.js';
import type { ResolvedRules } from '../sim/rules.js';
import { el } from './dom.js';
import { Slider } from './slider.js';

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
  onSkipDay(): void;
}

const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

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
  private cutSlider!: Slider;

  constructor(
    private root: HTMLElement,
    private visuals: Visuals,
    rules: ResolvedRules,
    private handlers: ControlHandlers,
    initial: Partial<ControlState> = {},
  ) {
    this.state = {
      playing: true,
      ticksPerSecond: 8,
      view: visuals.defaultViewName,
      colorBy: 'clone',
      cutMode: 'octant',
      cutFraction: 0,
      presentation: false,
      ...initial,
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
    this.cutSlider = new Slider({
      min: -0.6, max: 1, step: 0.02, value: 0,
      label: 'Where the cut falls',
      ticks: [-0.6, -0.3, 0, 0.5, 1],
      /* Stated in micrometres from the centre of the specimen, because that is
         a distance a person can picture - unlike a fraction of a half-span. */
      format: (v) => {
        const microns = Math.round((v * Math.max(rules.raw.grid.nx, rules.raw.grid.nz)) / 2 * rules.raw.grid.voxelMicrons);
        if (Math.abs(microns) < rules.raw.grid.voxelMicrons) return 'through the centre';
        return microns > 0 ? `${microns} µm out` : `${Math.abs(microns)} µm in`;
      },
      onInput: (v) => {
        this.state.cutFraction = v;
        this.handlers.onChange(this.state, 'cutFraction');
      },
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

    const speed = new Slider({
      min: 0, max: SPEEDS.length - 1, step: 1,
      value: SPEEDS.indexOf(this.state.ticksPerSecond),
      label: 'Speed',
      ticks: SPEEDS.map((_, i) => i),
      format: (v) => `${SPEEDS[v]}× real time`,
      onInput: (v) => {
        this.state.ticksPerSecond = SPEEDS[v];
        this.handlers.onChange(this.state, 'ticksPerSecond');
      },
    });

    const skipBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Skip a day' });
    skipBtn.style.flex = '1';
    skipBtn.title = 'Run a whole simulated day at once, without drawing every frame of it';
    skipBtn.addEventListener('click', () => handlers.onSkipDay());

    const resetBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Start over' });
    resetBtn.style.flex = '1';
    resetBtn.addEventListener('click', () => handlers.onReset());

    this.root.append(
      el('div', { class: 'block' }, [
        el('div', { class: 'muted', style: 'margin-bottom:var(--s2)', text: 'Cut away' }),
        cutRow,
        el('div', { style: 'margin-top:var(--s3)' }, [this.cutSlider.node]),
        el('div', { style: 'display:flex;gap:var(--s2);margin-top:var(--s3)' }, [frameBtn, presentBtn]),
        el('div', { class: 'muted', style: 'margin:var(--s5) 0 var(--s2)', text: 'Colour the cells' }),
        colorRow,
        el('div', { style: 'margin-top:var(--s5)' }, [speed.node]),
        el('div', { style: 'display:flex;gap:var(--s2);margin-top:var(--s4)' }, [skipBtn, resetBtn]),
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
    this.cutSlider?.setDisabled(this.state.cutMode === 'none');
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
