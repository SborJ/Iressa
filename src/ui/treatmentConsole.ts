import type { LiveDrug, LivePreset, LiveReading, LiveSource } from '../source/liveSource.js';
import { el } from './dom.js';

/**
 * The treatment console for a live session: one slider per agent, the model's
 * presets, and an "AI decides" switch when the server has a policy. Changes
 * apply from the next simulated day; the card under the controls says, in
 * words, what happened each day.
 *
 * Vocabulary: treatments keep or lose control of the tumour. Nothing here is a
 * cure, and nothing is advice.
 */
export class TreatmentConsole {
  readonly node = el('div', { class: 'console' });
  private sliders = new Map<string, { input: HTMLInputElement; value: HTMLElement }>();
  private auto: HTMLInputElement | undefined;
  private status = el('div', { class: 'console-status muted', text: 'Treatment applies from the next simulated day.' });
  private today = el('div', { class: 'console-today' });
  private computing = el('span', { class: 'console-computing', text: '' });
  private pending: number | undefined;
  private autoOn = false;

  constructor(
    private source: LiveSource,
    drugs: LiveDrug[],
    presets: LivePreset[],
    policy: string | null,
    initial: Record<string, number>,
    initialAuto: boolean,
  ) {
    const head = el('div', { class: 'console-head' }, [
      el('span', { class: 'label', text: 'Treatment' }),
      el('span', { class: 'console-live', text: 'live' }),
      this.computing,
    ]);
    this.node.append(head);

    const sliders = el('div', { class: 'console-sliders' });
    for (const drug of drugs) {
      const input = el('input', { type: 'range', min: '0', max: '100', step: '25', value: String(Math.round((initial[drug.id] ?? 0) * 100)) }) as HTMLInputElement;
      const value = el('span', { class: 'console-val mono', text: `${input.value}%` });
      const kind = drug.exposure === 'global' ? 'systemic' : 'into the tissue';
      const row = el('label', { class: 'console-row', title: `${drug.label}: ${kind}. Exposure relative to the model's reference level.` }, [
        el('span', { class: 'console-name', text: drug.label.replace(/\s*\(.*\)\s*$/, '') }),
        input,
        value,
      ]);
      input.addEventListener('input', () => {
        value.textContent = `${input.value}%`;
        this.scheduleSend();
      });
      this.sliders.set(drug.id, { input, value });
      sliders.append(row);
    }
    this.node.append(sliders);

    const presetRow = el('div', { class: 'console-presets' });
    for (const preset of presets) {
      const b = el('button', { class: 'btn ghost', type: 'button', text: preset.label, title: `Set the sliders to: ${preset.label}` });
      b.addEventListener('click', () => this.apply(preset.exposures));
      presetRow.append(b);
    }
    this.node.append(el('div', { class: 'muted console-sub', text: 'Presets from the model' }), presetRow);

    if (policy) {
      const auto = el('input', { type: 'checkbox' }) as HTMLInputElement;
      auto.checked = initialAuto;
      this.auto = auto;
      const wrap = el('label', { class: 'console-auto' }, [
        auto,
        el('span', {}, [el('b', { text: 'Let the AI decide ' }), el('span', { class: 'muted', text: `(${policy})` })]),
      ]);
      auto.addEventListener('change', () => {
        this.source.setAuto(auto.checked);
        this.setAutoState(auto.checked);
      });
      this.node.append(wrap);
      this.setAutoState(initialAuto);
    }
    this.node.append(this.status, this.today);

    this.source.onTreatment((exposures, isAuto) => {
      for (const [id, s] of this.sliders) {
        const v = Math.round((exposures[id] ?? 0) * 100);
        s.input.value = String(v);
        s.value.textContent = `${v}%`;
      }
      if (this.auto) this.auto.checked = isAuto;
      this.setAutoState(isAuto);
      this.status.textContent = isAuto ? 'The policy chooses each day; sliders show its choice.' : 'Set. Applies from the next simulated day.';
    });
    this.source.onReading((reading) => this.showReading(reading));
    this.source.onError((message) => {
      this.status.textContent = message;
    });
  }

  /** Called from the viewer's frame loop so "computing day N…" shows while the engine works. */
  tick(): void {
    this.computing.textContent = this.source.computing ? '· computing the next day…' : '';
  }

  private setAutoState(on: boolean): void {
    this.autoOn = on;
    for (const s of this.sliders.values()) s.input.disabled = on;
    this.node.classList.toggle('console-auto-on', on);
  }

  private apply(exposures: Record<string, number>): void {
    if (this.autoOn) return;
    for (const [id, s] of this.sliders) {
      const v = Math.round((exposures[id] ?? 0) * 100);
      s.input.value = String(v);
      s.value.textContent = `${v}%`;
    }
    this.send();
  }

  private scheduleSend(): void {
    if (this.pending) window.clearTimeout(this.pending);
    this.pending = window.setTimeout(() => this.send(), 250);
  }

  private send(): void {
    const exposures: Record<string, number> = {};
    for (const [id, s] of this.sliders) {
      const v = Number(s.input.value) / 100;
      if (v > 0) exposures[id] = v;
    }
    this.source.setExposures(exposures);
    this.status.textContent = 'Sending…';
  }

  private showReading(reading: LiveReading): void {
    const label = reading.label ?? reading.action ?? '';
    const esr1 = reading.resistant_fraction;
    this.today.replaceChildren(
      el('div', { class: 'label', text: `Day ${Math.round(reading.day)}` }),
      el('div', { class: 'act', text: label || 'no treatment' }),
      el('div', { class: 'mono muted', text: `ECI ${reading.eci.toFixed(2)}${esr1 !== undefined ? ` · resistant ${(100 * esr1).toFixed(1)}%` : ''}` }),
    );
  }
}
