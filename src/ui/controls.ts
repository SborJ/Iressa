import type { ColorBy, CutMode } from '../render/viewer.js';
import type { Visuals } from '../render/visuals.js';
import {
  experimentParamsFromQuery,
  oxygenPreset,
  type ExperimentParams,
  type ExperimentSchedule,
  type OxygenMode,
} from '../experimentParams.js';
import { el } from './dom.js';

export interface ControlState {
  playing: boolean;
  ticksPerSecond: number;
  view: string;
  colorBy: ColorBy;
  cutMode: CutMode;
  cutFraction: number;
  presentation: boolean;
  experiment: ExperimentParams;
}

export interface ControlHandlers {
  onChange(state: ControlState, changed: keyof ControlState | 'init'): void;
  onStep(): void;
  onReset(): void;
  onFrame(): void;
  onRunExperiment(params: ExperimentParams): void;
  onFastForwardDay(): void;
}

const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const PPO_TRAIN_COMMAND =
  'python3 scripts/train_ppo.py --days 120 --total-timesteps 50000 --output-dir outputs/rl';
const PPO_EVALUATE_COMMAND =
  'python3 scripts/evaluate_policy.py --days 120 --seeds 1001,1002,1003 --output-dir outputs/rl_eval';

export class Controls {
  readonly state: ControlState;

  private playBtn = el('button', { type: 'button' });
  private speedLabel = el('span', { class: 'val' });
  private viewButtons = new Map<string, HTMLButtonElement>();
  private colorButtons = new Map<ColorBy, HTMLButtonElement>();
  private cutButtons = new Map<CutMode, HTMLButtonElement>();
  private oxygenButtons = new Map<OxygenMode, HTMLButtonElement>();
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
      experiment: experimentParamsFromQuery(),
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
    const skipDayBtn = el('button', {
      type: 'button',
      text: 'Skip day',
      title: 'Fast-forward one simulated day without refreshing the page.',
    });
    skipDayBtn.addEventListener('click', () => this.handlers.onFastForwardDay());

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

    const experimentPanel = this.buildExperimentPanel();

    this.root.replaceChildren(
      el('h2', { text: 'Controls' }),
      experimentPanel,
      el('div', { class: 'rule' }),
      el('div', { class: 'ctl' }, [el('label', { text: 'Imaging' }), viewRow]),
      el('div', { class: 'ctl' }, [
        el('label', { text: 'Cut' }), cutRow, cutSlider,
        el('div', { class: 'btnrow' }, [frameBtn, this.presentBtn]),
      ]),
      el('div', { class: 'ctl' }, [el('label', { text: 'Colour by' }), colorRow]),
      el('div', { class: 'rule' }),
      el('div', { class: 'ctl' }, [
        el('div', { class: 'btnrow wrap' }, [this.playBtn, stepBtn, skipDayBtn, resetBtn]),
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
    this.syncExperiment();
  }

  private buildExperimentPanel(): HTMLElement {
    const days = this.numberInput('days', 1, 365, 1, this.state.experiment.days);
    days.addEventListener('input', () => {
      this.state.experiment.days = Number(days.value);
      this.syncExperiment();
    });

    const dose = this.numberInput('dose', 0, 5, 0.05, this.state.experiment.dose);
    dose.addEventListener('input', () => {
      this.state.experiment.dose = Number(dose.value);
      this.syncExperiment();
    });

    const switchDay = this.numberInput('switchDay', 0, 365, 1, this.state.experiment.switchDay);
    switchDay.addEventListener('input', () => {
      this.state.experiment.switchDay = Number(switchDay.value);
      this.syncExperiment();
    });

    const schedule = el('select', { 'aria-label': 'Treatment algorithm' }) as HTMLSelectElement;
    for (const [value, label] of [
      ['none', 'None'],
      ['continuous-gefitinib', 'Continuous gefitinib'],
      ['gefitinib-osimertinib', 'Gefitinib -> osimertinib'],
      ['adaptive-gefitinib', 'Adaptive gefitinib'],
    ] as [ExperimentSchedule, string][]) {
      const option = el('option', { value, text: label }) as HTMLOptionElement;
      schedule.append(option);
    }
    schedule.value = this.state.experiment.schedule;
    schedule.addEventListener('change', () => {
      this.state.experiment.schedule = schedule.value as ExperimentSchedule;
      this.syncExperiment();
    });

    const oxygenRow = el('div', { class: 'btnrow wrap' });
    for (const [mode, label] of [
      ['default', 'Default'],
      ['vascular', 'More flow'],
      ['hypoxic', 'Low flow'],
      ['necrotic', 'Starved'],
    ] as [OxygenMode, string][]) {
      const b = el('button', { type: 'button', text: label, title: oxygenModeHelp(mode) });
      b.addEventListener('click', () => {
        const preset = oxygenPreset(mode);
        this.state.experiment.oxygenMode = mode;
        this.state.experiment.oxygenSupply = preset.oxygenSupply;
        this.state.experiment.oxygenUptake = preset.oxygenUptake;
        supply.value = String(preset.oxygenSupply);
        uptake.value = String(preset.oxygenUptake);
        this.syncExperiment();
      });
      this.oxygenButtons.set(mode, b);
      oxygenRow.append(b);
    }

    const supplyLabel = el('span', { class: 'val' });
    const supply = el('input', {
      type: 'range', min: '0.05', max: '2', step: '0.05',
      value: String(this.state.experiment.oxygenSupply),
      'aria-label': 'Blood oxygen delivery',
      title: 'Higher values mean vessels deliver more oxygen into nearby tissue.',
    }) as HTMLInputElement;
    supply.addEventListener('input', () => {
      this.state.experiment.oxygenSupply = Number(supply.value);
      supplyLabel.textContent = this.state.experiment.oxygenSupply.toFixed(2);
      this.syncExperiment();
    });

    const uptakeLabel = el('span', { class: 'val' });
    const uptake = el('input', {
      type: 'range', min: '0.001', max: '0.08', step: '0.001',
      value: String(this.state.experiment.oxygenUptake),
      'aria-label': 'Cell oxygen consumption',
      title: 'Higher values mean living cells consume oxygen faster, creating stronger hypoxia.',
    }) as HTMLInputElement;
    uptake.addEventListener('input', () => {
      this.state.experiment.oxygenUptake = Number(uptake.value);
      uptakeLabel.textContent = this.state.experiment.oxygenUptake.toFixed(3);
      this.syncExperiment();
    });

    const applyBtn = el('button', { type: 'button', text: 'Run experiment' });
    applyBtn.addEventListener('click', () => {
      this.handlers.onRunExperiment({ ...this.state.experiment });
    });

    supplyLabel.textContent = this.state.experiment.oxygenSupply.toFixed(2);
    uptakeLabel.textContent = this.state.experiment.oxygenUptake.toFixed(3);

    return el('div', { class: 'experiment' }, [
      el('div', { class: 'ctl' }, [
        el('label', { text: 'Experiment' }),
        el('div', { class: 'grid2' }, [
          this.field('Days', days),
          this.field('Dose', dose),
          this.field('Switch day', switchDay),
          this.field('Algorithm', schedule),
        ]),
      ]),
      el('div', { class: 'ctl' }, [el('label', { text: 'Oxygen environment' }), oxygenRow]),
      el('div', { class: 'ctl' }, [
        el('label', {}, [document.createTextNode('Blood delivery'), supplyLabel]), supply,
      ]),
      el('div', { class: 'ctl' }, [
        el('label', {}, [document.createTextNode('Cell consumption'), uptakeLabel]), uptake,
      ]),
      el('p', { class: 'note oxygen-note', text: '' }),
      el('p', { class: 'note run-note', text: '' }),
      el('div', { class: 'btnrow' }, [applyBtn]),
      this.buildRlPanel(),
    ]);
  }

  private buildRlPanel(): HTMLElement {
    const trainBtn = el('button', {
      type: 'button',
      text: 'Copy train',
      title: 'Copy the PPO training command for the Python RL environment.',
    });
    trainBtn.addEventListener('click', () => this.copyText(PPO_TRAIN_COMMAND));

    const evalBtn = el('button', {
      type: 'button',
      text: 'Copy eval',
      title: 'Copy the PPO policy evaluation command.',
    });
    evalBtn.addEventListener('click', () => this.copyText(PPO_EVALUATE_COMMAND));

    return el('div', { class: 'rl-panel' }, [
      el('div', { class: 'ctl' }, [
        el('label', { text: 'RL / PPO baseline' }),
        el('p', {
          class: 'note',
          text: 'Python RL is wired: Gymnasium-style environment, PPO training, and policy evaluation.',
        }),
        el('div', { class: 'rl-status' }, [
          el('span', { class: 'status-dot' }),
          el('span', { text: 'Available for offline experiments' }),
        ]),
        el('div', { class: 'control-metrics' }, [
          el('div', {}, [
            el('strong', { text: 'M_i' }),
            document.createTextNode(' clone control margins'),
          ]),
          el('div', {}, [
            el('strong', { text: 'D_i' }),
            document.createTextNode(' distance to modeled treatment exhaustion'),
          ]),
          el('div', {}, [
            el('strong', { text: 'ECI' }),
            document.createTextNode(' reward and episode-stop signal'),
          ]),
        ]),
        el('div', { class: 'rl-command' }, [
          el('span', { text: 'train' }),
          el('code', { text: PPO_TRAIN_COMMAND }),
        ]),
        el('div', { class: 'rl-command' }, [
          el('span', { text: 'eval' }),
          el('code', { text: PPO_EVALUATE_COMMAND }),
        ]),
        el('div', { class: 'btnrow' }, [trainBtn, evalBtn]),
        el('p', {
          class: 'note',
          text: 'The browser viewer runs fixed/adaptive schedules; PPO uses these metrics during Python training and evaluation.',
        }),
      ]),
    ]);
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

  private syncExperiment(): void {
    for (const [mode, b] of this.oxygenButtons) {
      b.setAttribute('aria-pressed', String(mode === this.state.experiment.oxygenMode));
    }
    const note = this.root.querySelector('.experiment .run-note');
    const oxygenNote = this.root.querySelector('.experiment .oxygen-note');
    if (oxygenNote) {
      oxygenNote.textContent = oxygenExperimentHelp(this.state.experiment.oxygenMode);
    }
    if (note) {
      note.textContent =
        'Runs a fresh browser experiment immediately with fixed or adaptive schedule logic.';
    }
  }

  setPlaying(playing: boolean): void {
    this.state.playing = playing;
    this.syncPlay();
  }

  private numberInput(name: string, min: number, max: number, step: number, value: number): HTMLInputElement {
    return el('input', {
      name,
      type: 'number',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    }) as HTMLInputElement;
  }

  private field(label: string, input: HTMLElement): HTMLElement {
    return el('label', { class: 'field' }, [
      el('span', { text: label }),
      input,
    ]);
  }

  private copyText(text: string): void {
    void navigator.clipboard?.writeText(text);
  }

  private emit(changed: keyof ControlState | 'init'): void {
    this.handlers.onChange(this.state, changed);
  }
}

function oxygenModeHelp(mode: OxygenMode): string {
  return {
    default: 'Balanced vessel oxygen and cell consumption.',
    vascular: 'More oxygen reaches the tumor; fewer cells become hypoxic.',
    hypoxic: 'Less oxygen delivery and more consumption; growth slows and hypoxia increases.',
    necrotic: 'Severe oxygen starvation; sustained hypoxia can kill cells.',
  }[mode];
}

function oxygenExperimentHelp(mode: OxygenMode): string {
  return {
    default: 'Oxygen is a resource: vessels add it, cells consume it, and low oxygen slows or kills cells.',
    vascular: 'More flow means vessels refill oxygen faster, usually keeping cells proliferative for longer.',
    hypoxic: 'Low flow means the tumor can outrun oxygen delivery, creating quiescent/hypoxic regions.',
    necrotic: 'Starved conditions push cells below the necrosis threshold after sustained oxygen stress.',
  }[mode];
}
