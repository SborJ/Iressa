# Reinforcement Learning Treatment Design

Status: first PPO implementation with evolutionary-controllability
features. The simulator has a Gymnasium-style environment in
`cancer_sim/rl_env.py`, a PPO entrypoint in `scripts/train_ppo.py`, policy
evaluation in `scripts/evaluate_policy.py`, and clone/tumor controllability
metrics in `cancer_sim/controllability.py`. The local Vite UI starts PPO
training, compares it with fixed schedules on held-out seeds, and loads a
PPO-driven recorded run into the main viewer.

This project is not a clinical treatment optimizer. The RL layer is an experimental
research scaffold for comparing simulated treatment policies inside the calibrated
EGFR-resistance engine.

## Goal

The first RL milestone is to learn a dosing policy that chooses treatment actions
from simulator state and compare it against fixed schedules:

- no treatment,
- continuous gefitinib,
- gefitinib then osimertinib,
- adaptive gefitinib,
- osimertinib then capmatinib.

The baseline algorithm should be PPO because it is stable, well supported, and
works with continuous or discrete action spaces. PPO is not the scientific claim;
it is the first reproducible learning baseline.

Run a dependency-free smoke test:

```bash
python3 scripts/train_ppo.py --smoke --days 10 --smoke-steps 5
```

The smoke test writes both a CSV and a PNG trace:

```text
outputs/rl/ppo_smoke.csv
outputs/rl/ppo_smoke.png
```

Install PPO dependencies and start a small training run:

```bash
pip install -r requirements-rl.txt
python3 scripts/train_ppo.py --days 120 --dt-days 1 --total-timesteps 10000
```

Training saves the policy plus a deterministic rollout trace:

```text
outputs/rl/ppo_iressa.zip
outputs/rl/ppo_training_trace.csv
outputs/rl/ppo_training_trace.png
```

## Train In The UI

Start the local app with `npm run dev`, then open the **PPO training** panel.
Choose episode days and training steps, then click **Train PPO**. The panel
updates as Python trains: completed steps, episode reward, living cells, ECI,
and the latest action. **Stop** terminates the current process. At completion,
the panel shows median reward, burden, resistant fraction, and dose for PPO
and fixed policies over held-out seeds 1001–1003. It also lists the actions
PPO chose on seed 1001. The UI uses a compact 14 × 10 × 8 3D capillary-grid scenario for
both training and held-out comparison. **Play PPO experiment** loads that exact recorded
Python run into the main scene without a page reload. The checkpoint is saved
at `outputs/rl/ppo_iressa.zip`; the UI does not open generated plot files.

The UI training API is local to the Vite development server. It requires the
dependencies in `requirements-rl.txt`. Repeated episodes use a reproducible
sequence of distinct simulator seeds.

Evaluate fixed baselines, and optionally a saved PPO checkpoint:

```bash
python3 scripts/evaluate_policy.py --days 120 --seeds 1001,1002,1003
python3 scripts/evaluate_policy.py --policy outputs/rl/ppo_iressa.zip --days 120 --seeds 1001,1002,1003
```

## Environment

One RL episode is one tumor simulation run.

```text
reset(seed, scenario)
  -> initial tumor world

step(action)
  -> advance simulator by one decision interval
  -> observation, reward, done, info
```

Recommended first settings:

| Item | Initial value |
| --- | --- |
| episode horizon | 120-240 days |
| biological simulator dt | 0.25-1 day |
| RL decision interval | 1 day |
| stochastic repeats | 20-100 seeds for evaluation |
| training randomization | mutation scale, oxygen mode, starting resistant fraction, dose-response uncertainty |

The RL step should not replace the physics timestep. The simulator still owns
oxygen/drug transport, cell state updates, division, mutation, and death.

## Observation Space

Start with summary features, not the full lattice.

```text
time_fraction
tumor_burden / initial_burden
recent_burden_slope
EGFR_fraction
T790M_fraction
C797S_fraction
MET_AMP_fraction
necrotic_fraction
mean_oxygen
low_oxygen_fraction
mean_drug
current_drug_id
current_dose
cumulative_gefitinib
cumulative_osimertinib
cumulative_capmatinib
days_since_last_switch
EGFR_control_margin
T790M_control_margin
C797S_control_margin
MET_AMP_control_margin
EGFR_escape_distance
T790M_escape_distance
C797S_escape_distance
MET_AMP_escape_distance
evolutionary_controllability_index
treatment_exhausted_fraction
```

Later, add image/field observations:

```text
downsampled clone lattice
downsampled oxygen field
downsampled drug field
vessel mask
```

Do not start with full 3D observations. That makes debugging the policy much
harder before the reward and controls are validated.

## Action Space

Use a discrete baseline first.

```text
0 = no drug
1 = gefitinib low dose
2 = gefitinib full dose
3 = osimertinib low dose
4 = osimertinib full dose
5 = capmatinib low dose
6 = capmatinib full dose
```

For a smaller first version:

```text
0 = no drug
1 = gefitinib
2 = osimertinib
```

Continuous dosing can come later:

```text
gefitinib_dose in [0, 1]
osimertinib_dose in [0, 1]
capmatinib_dose in [0, 1]
```

The simulator should enforce constraints even if the policy proposes nonsense.

## Evolutionary Controllability Metrics

The first controllability implementation is deterministic and lightweight. It
does not claim clinical curability.

For clone `i`, the environment estimates a net growth rate under each available
treatment action:

```text
lambda_i = effective_growth_i - treatment_kill_i
```

`effective_growth_i` uses calibrated clone growth, fitness cost, and the current
proliferative fraction. `treatment_kill_i` uses the clone's IC50, Hill
coefficient, max drug death rate, dose, and vessel concentration.

The clone-level control margin is:

```text
M_i = - min_a(lambda_i)
```

Interpretation:

```text
M_i > 0  at least one modeled treatment can push the clone into negative growth
M_i = 0  near the boundary of modeled control
M_i < 0  treatment-exhausted under the simulator's represented drugs/actions
```

The module also computes a resistance-graph distance to treatment exhaustion.
Edges use:

```text
weight_ij = -log(mu_ij * expected_divisions_i * P_establish + epsilon)
```

The tumor-level `evolutionary_controllability_index` is currently a bounded
proxy that combines burden safety, treatment-exhausted fraction, clone margins,
and graph distance. A future version can replace this proxy with Monte Carlo
rollouts over policies and domain-randomized biology.

## Reward

Use a reward that explicitly separates tumor control from treatment cost and
resistance. The current environment adds controllability terms to the original
burden-based scaffold.

```text
reward_t =
  + controlled_day_reward if burden < progression threshold and ECI >= ECI_min
  - w_burden      * normalized_burden
  - w_growth      * positive_burden_slope
  - w_resistance  * resistant_fraction
  - w_dose        * dose_today
  - w_switch      * drug_switch_event
  - w_necrosis    * hypoxic_necrotic_fraction
  + w_control     * burden_reduction
  + w_eci         * ECI
  - w_exhaustion  * treatment_exhausted_fraction
```

Suggested first weights:

```text
w_burden     = 1.0
w_growth     = 0.5
w_resistance = 0.5
w_dose       = 0.05
w_switch     = 0.02
w_necrosis   = 0.1
w_control    = 0.5
w_eci        = 0.5
w_exhaustion = 0.5
```

Track every reward component separately in `info`. A single scalar reward is not
enough to understand why the policy learned a behavior.

Episodes terminate when:

```text
burden == 0
burden >= progression_multiplier * initial_burden
ECI < ECI_min
```

The interactive UI uses a fixed experiment horizon for training and held-out
comparison: it records the first progression day but does not stop at that
threshold, and it disables ECI-based early stopping. Extinction can still end
an episode. This keeps final burden and reward comparisons from favoring a
policy merely because it progressed sooner.

## Constraints

The RL policy must be bounded by rules:

- maximum daily dose per drug,
- maximum cumulative dose,
- no unsupported drug combinations in the first PPO baseline,
- minimum switch interval unless explicitly testing rapid switching,
- optional treatment holidays allowed,
- no clinical recommendation language in outputs.

These are simulator constraints, not learned preferences.

## PPO Baseline

Recommended implementation stack:

```text
Gymnasium-compatible environment
Stable-Baselines3 PPO baseline
vectorized environments over random seeds
CSV/JSON episode metrics
fixed evaluation seeds
```

Initial PPO configuration:

```text
policy            = MlpPolicy
n_steps           = 512-2048
batch_size        = 64-256
gamma             = 0.99
gae_lambda        = 0.95
clip_range        = 0.2
ent_coef          = 0.01 initially, then tune down
learning_rate     = 3e-4
normalize_obs     = true
normalize_reward  = true during training only
```

Use PPO only after fixed schedule experiments and sensitivity analysis can be
reproduced. Otherwise the RL agent will optimize artifacts.

## Evaluation

Compare PPO against fixed schedules on held-out seeds and scenarios.

Metrics:

- time to progression,
- final burden,
- minimum burden,
- final resistant fraction,
- time to resistant dominance,
- cumulative dose,
- number of switches,
- total drug deaths,
- total hypoxic deaths,
- reward components.

Report median and IQR over seeds, not a single run.

## Oxygen In The RL State

Oxygen should not be hidden from the policy. The RL agent needs at least:

```text
mean_oxygen
fraction_below_quiescence_threshold
fraction_below_necrosis_threshold
hypoxic_death_count_recent
```

Plain interpretation:

```text
vessels add oxygen
cells consume oxygen
low oxygen slows growth
very low oxygen for long enough causes hypoxic necrosis
```

The oxygen controls in the viewer map to:

| UI term | Simulator meaning |
| --- | --- |
| Blood delivery | oxygen source strength at vessels |
| Cell consumption | oxygen uptake by living tumor cells |
| More flow | higher source, lower uptake |
| Low flow | lower source, higher uptake |
| Starved | severe low source / high uptake, more necrosis pressure |

## Implementation Milestones

1. Add a `cancer_sim.rl_env` Gymnasium environment around the existing engine. Done.
2. Add deterministic fixed-policy wrappers so schedules and PPO use the same action interface. Done.
3. Add `scripts/train_ppo.py`. Done.
4. Add `scripts/evaluate_policy.py`. Done.
5. Add controllability metrics to observations and reward. Done.
6. Save policy checkpoints and evaluation CSVs under `outputs/rl/`. Done.
7. Add viewer export for PPO policy runs, so learned policies can be inspected visually.
8. Add combination-dose actions once the simulator supports simultaneous drug fields.
9. Replace the ECI proxy with rollout-based viability estimation.

## First PPO Experiment

```text
horizon: 120 days
decision interval: 1 day
actions: none, gefitinib, osimertinib
training seeds: 1-200
evaluation seeds: 1001-1100
oxygen modes: default, hypoxic
starting resistant fraction: randomized 0-10%
```

Baseline comparison:

```text
PPO vs continuous gefitinib
PPO vs gefitinib -> osimertinib
PPO vs adaptive gefitinib
```

Only if PPO beats or matches these baselines across held-out seeds should we
expand the action space to capmatinib or continuous dosing.
