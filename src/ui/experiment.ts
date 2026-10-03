import {
  experimentParamsFromQuery,
  MAX_DAYS,
  oxygenPreset,
  type ExperimentParams,
  type ExperimentSchedule,
  type OxygenMode,
} from '../experimentParams.js';
import type { ResolvedRules } from '../sim/rules.js';
import { copyText } from './exporters.js';
import { el } from './dom.js';
import { Choice, NumberField } from './fields.js';
import { Slider } from './slider.js';

const PPO_TRAIN =
  'python3 scripts/train_ppo.py --days 120 --total-timesteps 50000 --output-dir outputs/rl';
const PPO_EVALUATE =
  'python3 scripts/evaluate_policy.py --days 120 --seeds 1001,1002,1003 --output-dir outputs/rl_eval';

const SCHEDULE_HELP: Record<ExperimentSchedule, string> = {
  'none': 'No drug at all — the tumour grows against oxygen alone.',
  'continuous-gefitinib': 'Gefitinib every day for the whole run. The resistant lineage is free to take over.',
  'gefitinib-osimertinib': 'Gefitinib, then switch to osimertinib, which reaches T790M.',
  'adaptive-gefitinib': 'Gefitinib every other day: less pressure, so sensitive cells keep competing with resistant ones.',
};

const OXYGEN_HELP: Record<OxygenMode, string> = {
  default: 'The vasculature as the rules describe it.',
  vascular: 'Vessels deliver more and cells burn less — a well-perfused tumour with little hypoxia.',
  hypoxic: 'Less delivery, faster consumption. Hypoxic ground opens up between vessels.',
  necrotic: 'Starved: most of the tissue beyond a vessel cuff dies of hypoxia.',
};

export interface ExperimentHandlers {
  onRun(params: ExperimentParams): void;
}

/**
 * The experiment: what treatment, in what environment, for how long.
 *
 * These are the only controls that change what is being simulated rather than
 * how it is drawn, so they are kept together, they state what each option will
 * do before it is chosen, and nothing is applied until the run is started -
 * half-changed parameters would simulate a scenario nobody asked for.
 */
export class ExperimentPanel {
  readonly node: HTMLElement;
  private params: ExperimentParams;
  private days: NumberField;
  private dose: NumberField;
  private switchDay: NumberField;
  private scheduleChoice: Choice<ExperimentSchedule>;
  private oxygenChoice: Choice<OxygenMode>;
  private supply: Slider;
  private uptake: Slider;
  private scheduleNote = el('p', { class: 'note' });
  private oxygenNote = el('p', { class: 'note' });
  private switchWrap: HTMLElement;
  private dirty = false;
  private runBtn: HTMLButtonElement;
  private secondDrug: { id: number; name: string } | undefined;

  constructor(
    private rules: ResolvedRules,
    private handlers: ExperimentHandlers,
  ) {
    this.params = experimentParamsFromQuery();

    /* A switch needs somewhere to switch to. Some rules files name one drug,
       and offering the option there would silently run a single course while
       claiming to run two. */
    const drugs = this.rules.raw.drugs ?? [];
    const second = drugs[1];
    this.secondDrug = second;
    if (!second && this.params.schedule === 'gefitinib-osimertinib') {
      this.params = { ...this.params, schedule: 'continuous-gefitinib' };
    }

    this.days = new NumberField({
      label: 'Run for', min: 1, max: MAX_DAYS, step: 1, value: this.params.days, unit: 'days',
      title: `How long the simulated experiment lasts, up to ${MAX_DAYS} days.`,
      onInput: (v) => this.change({ days: v }),
    });
    this.dose = new NumberField({
      label: 'Daily dose', min: 0, max: 5, step: 0.05, value: this.params.dose, unit: '× IC50',
      title: 'Each dose, relative to the concentration that halves a sensitive population.',
      onInput: (v) => this.change({ dose: v }),
    });
    this.switchDay = new NumberField({
      label: 'Switch on day', min: 0, max: MAX_DAYS, step: 1, value: this.params.switchDay,
      title: 'The day the first drug is replaced by the second.',
      onInput: (v) => this.change({ switchDay: v }),
    });
    this.switchWrap = el('div', {}, [this.switchDay.node]);

    this.scheduleChoice = new Choice<ExperimentSchedule>(
      'Treatment',
      [
        { value: 'none', label: 'None', title: SCHEDULE_HELP.none },
        { value: 'continuous-gefitinib', label: 'Gefitinib', title: SCHEDULE_HELP['continuous-gefitinib'] },
        {
          value: 'gefitinib-osimertinib',
          label: second ? `Then ${second.name}` : 'Then switch',
          title: second
            ? SCHEDULE_HELP['gefitinib-osimertinib']
            : 'This run names only one drug, so there is nothing to switch to.',
        },
        { value: 'adaptive-gefitinib', label: 'Adaptive', title: SCHEDULE_HELP['adaptive-gefitinib'] },
      ],
      this.params.schedule,
      (v) => this.change({ schedule: v }),
      { wrap: true },
    );

    this.oxygenChoice = new Choice<OxygenMode>(
      'Blood supply',
      [
        { value: 'default', label: 'As given', title: OXYGEN_HELP.default },
        { value: 'vascular', label: 'Rich', title: OXYGEN_HELP.vascular },
        { value: 'hypoxic', label: 'Poor', title: OXYGEN_HELP.hypoxic },
        { value: 'necrotic', label: 'Starved', title: OXYGEN_HELP.necrotic },
      ],
      this.params.oxygenMode,
      (v) => {
        const preset = oxygenPreset(v);
        this.supply.setValue(preset.oxygenSupply);
        this.uptake.setValue(preset.oxygenUptake);
        this.change({ oxygenMode: v, ...preset });
      },
      { wrap: true },
    );

    this.supply = new Slider({
      min: 0.05, max: 2, step: 0.05, value: this.params.oxygenSupply,
      label: 'Oxygen delivered',
      format: (v) => `${v.toFixed(2)}×`,
      onInput: (v) => this.change({ oxygenSupply: v }),
    });
    this.uptake = new Slider({
      min: 0.001, max: 0.08, step: 0.001, value: this.params.oxygenUptake,
      label: 'Oxygen burned by cells',
      format: (v) => v.toFixed(3),
      onInput: (v) => this.change({ oxygenUptake: v }),
    });

    this.runBtn = el('button', { class: 'btn primary', type: 'button' }) as HTMLButtonElement;
    this.runBtn.addEventListener('click', () => {
      this.dirty = false;
      this.syncRun();
      this.handlers.onRun({ ...this.params });
    });

    this.node = el('div', {}, [
      el('div', { class: 'grid2' }, [this.days.node, this.dose.node]),
      el('div', { style: 'margin-top:var(--s4)' }, [this.scheduleChoice.node]),
      this.scheduleNote,
      el('div', { style: 'margin-top:var(--s3)' }, [this.switchWrap]),
      el('div', { style: 'margin-top:var(--s5)' }, [this.oxygenChoice.node]),
      this.oxygenNote,
      el('div', { style: 'margin-top:var(--s4)' }, [this.supply.node]),
      el('div', { style: 'margin-top:var(--s4)' }, [this.uptake.node]),
      el('div', { class: 'run-row' }, [this.runBtn]),
      this.rlSection(),
    ]);

    if (!this.secondDrug) {
      const b = this.scheduleChoice.node.querySelector<HTMLButtonElement>('button:nth-of-type(3)');
      if (b) b.disabled = true;
    }

    this.sync();
    this.syncRun();
  }

  /** The Python side, reachable without leaving the viewer. */
  private rlSection(): HTMLElement {
    const cmd = (text: string) => {
      const b = el('button', { class: 'cmd', type: 'button', text, title: 'Click to copy' });
      b.addEventListener('click', async () => {
        if (await copyText(text)) {
          b.classList.add('copied');
          window.setTimeout(() => b.classList.remove('copied'), 1200);
        }
      });
      return b;
    };
    return el('div', { style: 'margin-top:var(--s5)' }, [
      el('div', { class: 'muted', style: 'margin-bottom:var(--s2)', text: 'Learned schedules' }),
      el('p', { class: 'note' }, [
        document.createTextNode(
          'The viewer runs fixed and adaptive schedules. A policy that works out its own schedule is trained in Python against the same simulator — copy a command to run it.',
        ),
      ]),
      cmd(PPO_TRAIN),
      cmd(PPO_EVALUATE),
    ]);
  }

  private change(patch: Partial<ExperimentParams>): void {
    this.params = { ...this.params, ...patch };
    // Touching a slider or a field leaves the preset it came from.
    if (patch.oxygenSupply !== undefined || patch.oxygenUptake !== undefined) {
      if (patch.oxygenMode === undefined) this.oxygenChoice.set('default', true);
    }
    this.dirty = true;
    if (!this.secondDrug) {
      const b = this.scheduleChoice.node.querySelector<HTMLButtonElement>('button:nth-of-type(3)');
      if (b) b.disabled = true;
    }

    this.sync();
    this.syncRun();
  }

  private sync(): void {
    this.scheduleNote.textContent = SCHEDULE_HELP[this.params.schedule];
    this.oxygenNote.textContent = OXYGEN_HELP[this.params.oxygenMode];
    // The switch day only means anything when there are two drugs in play.
    this.switchWrap.hidden = this.params.schedule !== 'gefitinib-osimertinib';
    const noDrug = this.params.schedule === 'none' || this.params.dose <= 0;
    this.dose.node.classList.toggle('dim', noDrug && this.params.schedule !== 'none');
  }

  private syncRun(): void {
    this.runBtn.textContent = this.dirty ? 'Run this experiment' : 'Run again';
    this.runBtn.classList.toggle('primary', this.dirty);
  }

  /** The summary shown on the closed fold. */
  summary(): string {
    const p = this.params;
    if (p.schedule === 'none' || p.dose <= 0) return `${p.days} d · no drug`;
    const name =
      p.schedule === 'gefitinib-osimertinib' ? `switch on d${p.switchDay}`
      : p.schedule === 'adaptive-gefitinib' ? 'adaptive'
      : 'continuous';
    return `${p.days} d · ${name}`;
  }

  get current(): ExperimentParams {
    return { ...this.params };
  }
}
