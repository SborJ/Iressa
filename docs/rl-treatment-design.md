# Reinforcement Learning Treatment Design

Status: design only. The simulator has fixed/adaptive treatment schedules and
viewer controls, but it does not yet include a runnable Gymnasium environment,
PPO training script, policy checkpoint, or RL-driven simulation source.

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

## Reward

Use a reward that explicitly separates tumor control from treatment cost and
resistance.

```text
reward_t =
  - w_burden      * normalized_burden
  - w_growth      * positive_burden_slope
  - w_resistance  * resistant_fraction
  - w_dose        * dose_today
  - w_switch      * drug_switch_event
  - w_necrosis    * hypoxic_necrotic_fraction
  + w_control     * burden_reduction
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
```

Track every reward component separately in `info`. A single scalar reward is not
enough to understand why the policy learned a behavior.

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

1. Add a `cancer_sim.rl_env` Gymnasium environment around the existing engine.
2. Add deterministic fixed-policy wrappers so schedules and PPO use the same action interface.
3. Add `scripts/train_ppo.py`.
4. Add `scripts/evaluate_policy.py`.
5. Save policy checkpoints and evaluation CSVs under `outputs/rl/`.
6. Add viewer export for PPO policy runs, so learned policies can be inspected visually.
7. Add tests for action validation, observation shape, reward components, deterministic reset, and fixed-policy parity.

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
