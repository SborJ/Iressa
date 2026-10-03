import { el } from './dom.js';

interface Evaluation {
  seeds: number[];
  viewer_url: string;
  viewer_seed: number;
  summary: { policy: string; n: number; total_reward_median: number; final_burden_median: number;
    final_resistant_fraction_median: number; cumulative_dose_median: number; steps_median: number;
    progression_fraction: number; progression_day_median: number | null; switches_median: number }[];
  decisions: { day: number; drug: string; dose: number; burden: number; resistant_fraction: number; eci: number }[];
  action_counts: { drug: string; dose: number; count: number }[];
}

interface TrainingPoint {
  steps: number;
  total: number;
  episode: number;
  episode_reward: number | null;
  burden: number;
  eci: number;
  resistant_fraction: number;
  action: number;
}

interface TrainingStatus {
  state: 'idle' | 'running' | 'completed' | 'stopped' | 'failed';
  points: TrainingPoint[];
  message: string;
  checkpoint?: string;
  evaluation?: Evaluation;
  config?: { days: number; timesteps: number };
}

const ACTIONS = ['No drug', 'Gefitinib 50%', 'Gefitinib 100%', 'Osimertinib 50%',
  'Osimertinib 100%', 'Capmatinib 50%', 'Capmatinib 100%'];

export class RLTraining {
  readonly node = el('section', { class: 'rl-training' });
  private state = el('span', { class: 'rl-state', text: 'Ready' });
  private detail = el('div', { class: 'muted rl-detail', text: 'Train a PPO treatment policy in this browser session.' });
  private progress = el('progress', { max: '100', value: '0' }) as HTMLProgressElement;
  private reward = el('strong', { text: '—' });
  private burden = el('strong', { text: '—' });
  private eci = el('strong', { text: '—' });
  private action = el('span', { class: 'muted', text: 'No action yet' });
  private result = el('div', { class: 'rl-result' });
  private start = el('button', { class: 'btn primary', type: 'button', text: 'Train PPO' }) as HTMLButtonElement;
  private stop = el('button', { class: 'btn ghost', type: 'button', text: 'Stop' }) as HTMLButtonElement;
  private days = el('input', { type: 'number', min: '2', max: '240', step: '1', value: '30' }) as HTMLInputElement;
  private timesteps = el('input', { type: 'number', min: '32', max: '20000', step: '1', value: '1024' }) as HTMLInputElement;
  private polling?: number;
  private shownConfig = '';

  constructor(private onLoadRun: (url: string) => void) {
    const field = (label: string, input: HTMLInputElement) => el('label', { class: 'rl-field' }, [
      el('span', { text: label }), input,
    ]);
    const metric = (label: string, value: HTMLElement) => el('div', { class: 'rl-metric' }, [
      el('span', { text: label }), value,
    ]);
    this.stop.disabled = true;
    this.node.append(
      el('div', { class: 'rl-head' }, [el('h2', { text: 'PPO training' }), this.state]),
      this.detail,
      el('div', { class: 'rl-fields' }, [field('Episode days', this.days), field('Training steps', this.timesteps)]),
      el('div', { class: 'rl-actions' }, [this.start, this.stop]),
      this.progress,
      el('div', { class: 'rl-metrics' }, [metric('Episode reward', this.reward), metric('Living cells', this.burden), metric('ECI', this.eci)]),
      this.action,
      this.result,
    );
    this.start.addEventListener('click', () => void this.begin());
    this.stop.addEventListener('click', () => void this.request('/api/rl/stop', {}).then(() => this.refresh()));
    void this.refresh();
    this.polling = window.setInterval(() => void this.refresh(), 800);
    window.addEventListener('pagehide', () => window.clearInterval(this.polling), { once: true });
  }

  dispose(): void {
    window.clearInterval(this.polling);
  }

  private async request(url: string, body: object): Promise<TrainingStatus> {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json() as TrainingStatus & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
    return data;
  }

  private async begin(): Promise<void> {
    const days = Number(this.days.value);
    const timesteps = Number(this.timesteps.value);
    if (!Number.isInteger(days) || days < 2 || days > 240 || !Number.isInteger(timesteps) || timesteps < 32 || timesteps > 20000) {
      this.detail.textContent = 'Use 2–240 days and 32–20,000 training steps.';
      return;
    }
    this.start.disabled = true;
    try {
      this.render(await this.request('/api/rl/start', { days, timesteps }));
    } catch (error) {
      this.detail.textContent = error instanceof Error ? error.message : String(error);
      this.start.disabled = false;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const response = await fetch('/api/rl/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('Training API unavailable');
      this.render(await response.json() as TrainingStatus);
    } catch {
      this.state.textContent = 'Unavailable';
      this.detail.textContent = 'Start the local Vite server to train PPO here.';
      this.start.disabled = true;
      this.stop.disabled = true;
    }
  }

  private render(status: TrainingStatus): void {
    if (status.config) {
      const key = `${status.config.days}:${status.config.timesteps}`;
      if (key !== this.shownConfig) {
        this.shownConfig = key;
        this.days.value = String(status.config.days);
        this.timesteps.value = String(status.config.timesteps);
      }
    }
    this.state.textContent = status.state === 'running' ? 'Training' : status.state === 'completed' ? 'Complete' :
      status.state === 'failed' ? 'Failed' : status.state === 'stopped' ? 'Stopped' : 'Ready';
    this.state.dataset.state = status.state;
    this.start.disabled = status.state === 'running';
    this.stop.disabled = status.state !== 'running';
    this.detail.textContent = status.message || 'Train a PPO treatment policy in this browser session.';
    const last = status.points.at(-1);
    this.progress.value = last ? Math.min(100, 100 * last.steps / last.total) : 0;
    this.reward.textContent = last?.episode_reward == null ? '—' : last.episode_reward.toFixed(2);
    this.burden.textContent = last ? last.burden.toLocaleString() : '—';
    this.eci.textContent = last ? last.eci.toFixed(2) : '—';
    this.action.textContent = last ? `Episode ${last.episode} · ${ACTIONS[last.action] ?? 'Unknown action'} · resistant ${(last.resistant_fraction * 100).toFixed(0)}%` : 'No action yet';
    this.renderEvaluation(status.evaluation);
  }

  private renderEvaluation(evaluation?: Evaluation): void {
    if (!evaluation) {
      this.result.replaceChildren();
      return;
    }
    const signature = evaluation.viewer_url;
    if (this.result.dataset.run === signature) return;
    this.result.dataset.run = signature;
    const button = el('button', { class: 'btn primary', type: 'button', text: 'Play PPO experiment' });
    button.addEventListener('click', () => this.onLoadRun(evaluation.viewer_url));
    const comparison = el('div', { class: 'rl-comparison' });
    for (const row of evaluation.summary) {
      const label = row.policy === 'ppo' ? 'PPO' : row.policy.replace('continuous-', '').replace('gefitinib-osimertinib', 'gefitinib → osimertinib').replace('adaptive-', 'adaptive ');
      const metric = (name: string, value: string) => el('span', {}, [el('span', { text: `${name} ` }), el('strong', { text: value })]);
      comparison.append(el('div', { class: `rl-policy${row.policy === 'ppo' ? ' rl-ppo-row' : ''}` }, [
        el('div', { class: 'rl-policy-head' }, [el('strong', { text: label }), el('strong', { text: `${row.final_burden_median.toFixed(0)} cells` })]),
        el('div', { class: 'rl-policy-metrics' }, [
          metric('Days', row.steps_median.toFixed(0)),
          metric('Progressed', row.progression_day_median == null ? `0/${row.n}` :
            `${Math.round(row.progression_fraction * row.n)}/${row.n} · day ${row.progression_day_median.toFixed(0)}`),
          metric('Resistant', `${(row.final_resistant_fraction_median * 100).toFixed(0)}%`),
          metric('Dose', row.cumulative_dose_median.toFixed(1)),
          metric('Switches', row.switches_median.toFixed(0)),
          metric('Reward', row.total_reward_median.toFixed(1)),
        ]),
      ]));
    }
    const choices = evaluation.action_counts.sort((a, b) => b.count - a.count)
      .map(item => `${item.drug} ${Math.round(item.dose * 100)}%: ${item.count}`).join(' · ');
    const repeated = evaluation.action_counts.find(item => item.count === evaluation.decisions.length);
    const repeatedStrategy = repeated && evaluation.decisions.length > 0
      ? `On the replayed seed, PPO selected ${repeated.drug} ${Math.round(repeated.dose * 100)}% on every day.`
      : '';
    const ppo = evaluation.summary.find(row => row.policy === 'ppo');
    const conclusion = ppo
      ? `PPO: ${ppo.final_burden_median.toFixed(0)} living cells at day ${ppo.steps_median.toFixed(0)} (median); ` +
        `${Math.round(ppo.progression_fraction * ppo.n)}/${ppo.n} runs crossed the progression threshold; ` +
        `${ppo.switches_median.toFixed(0)} drug switches (median).`
      : '';
    const strategy = el('details', { class: 'rl-strategy' }, [el('summary', { text: 'See each PPO decision' })]);
    const decisions = el('div', { class: 'rl-decisions' });
    for (const choice of evaluation.decisions) {
      decisions.append(el('div', { text: `Day ${choice.day}: ${choice.drug} ${Math.round(choice.dose * 100)}% · ${choice.burden} cells · ECI ${choice.eci}` }));
    }
    strategy.append(decisions);
    this.result.replaceChildren(
      el('div', { class: 'rl-result-title', text: 'Held-out comparison' }),
      el('div', { class: 'muted', text: `Same simulated horizon; medians across ${evaluation.seeds.length} held-out seeds (${evaluation.seeds.join(', ')})` }),
      el('div', { class: 'rl-conclusion', text: conclusion }),
      comparison,
      el('div', { class: 'rl-result-title', text: `What PPO chose on seed ${evaluation.viewer_seed}` }),
      ...(repeatedStrategy ? [el('div', { class: 'rl-conclusion', text: repeatedStrategy })] : []),
      el('div', { class: 'muted', text: choices || 'No treatment decisions recorded' }),
      strategy,
      button,
    );
  }
}
