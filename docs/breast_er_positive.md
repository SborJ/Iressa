# ER+/HER2− breast cancer model

The second cancer in the simulator: ER-positive, HER2-negative breast cancer
evolving under endocrine suppression, CDK4/6 inhibition and a switch to a
selective estrogen receptor degrader (SERD). It runs on the same engine, oxygen
and drug physics, 3D renderer, controllability metrics and RL environment as
the EGFR lung model. Only the cancer model file differs:
`cancer_sim/cancers/breast_er_her2neg.json`.

This is a **research model**, not a treatment recommendation system. The
vocabulary is deliberate: clones are *treatment-controllable* or
*treatment-exhausted under the modelled therapeutic set*; the tumour shows
*evolutionary escape*, *durable control* or *simulated eradication*. Nothing
here is a prediction for a patient.

## Why this subtype first

ER+/HER2− disease is the cleanest analogue of EGFR-mutant lung cancer: one
dominant dependency (estrogen receptor signalling), a targeted first-line
treatment, well-measured acquired resistance (ESR1 mutations) with isogenic
cell-line IC50 data, and further targeted options after resistance. HER2+
disease needs antibody and antibody–drug-conjugate pharmacology that the
small-molecule diffusion model does not represent; triple-negative disease has
no comparable targeted dependency.

## The evolutionary graph

```
                     ┌── ESR1 Y537S    ligand-independent ER; strongly SERD-resistant
ER-sensitive ────────┼── ESR1 D538G    ligand-independent ER; intermediate
(ESR1 wild type)     └── CDK4/6 escape aggregate RB1-loss / CCNE1-high phenotype
```

Resistance is not a single deterministic path. Two processes feed it, as the
clinical evidence suggests: rare **pre-existing** subclones (the seeding mix)
and **mutation on division** (the transitions). Both are uncertain and labelled
as assumptions; demo runs scale the mutation rate with `mutation_scale`, as the
lung demo does, because a lattice of ~1500 cells cannot show a 10⁻⁶ event.

Combinations (for example Y537S plus CDK escape) are deliberately left for
Stage 2, as are FGFR1 bypass and the PI3K/AKT branch.

## Treatments

| Drug id | Agent | How it is modelled |
|---|---|---|
| `endocrine` | aromatase inhibitor | a **global** estrogen-deprivation level (1.0 = maximal pressure), not a diffusing field, because aromatase inhibitors act systemically |
| `palbociclib` | CDK4/6 inhibitor | a diffusing drug field; exposure 1.0 = 1500 nM at the vessel |
| `fulvestrant` | SERD (injected) | a diffusing drug field; exposure 1.0 = 25 nM at the vessel |
| `elacestrant` | oral SERD | a diffusing drug field; exposure 1.0 = 150 nM at the vessel (ASSUMPTION, randomised 50–300 nM) |

Endocrine and CDK4/6 agents are mostly **cytostatic**, so every response has a
growth-inhibition term as well as a (small) kill rate. Several agents act at
once: kill hazards add, and growth inhibitions multiply (independent action,
no synergy assumed).

Three mechanics the brief asks for and the lung engine never needed:

- **Fitness reversal with the environment** (section 20). An ESR1 mutant pays
  its fitness cost only while estrogen is available; under deprivation the cost
  is relieved in proportion to how far the environment has shifted (measured on
  the sensitive founding clone). Relative fitness flips from below 1 without
  pressure to about 2 under it.
- **Clone establishment** (section 23). A new mutant founds a clone with
  probability `base × (its division rate / its parent's) at that site under the
  current exposures`, clipped to [0, 1]. Without pressure a costly mutant
  establishes less often than the base (0.5, ASSUMPTION); under a drug its
  parent is sensitive to, it always does. The lung model has no establishment
  block, so its random draws are untouched.
- **Treatment-dependent escape distance** (section 36). `D_i(s, a)` uses each
  parent's division rate and each child's establishment chance under the
  treatment given that day, so the route to the ESR1 mutants is shorter under
  endocrine pressure than under a SERD.

Schedules declared by the model (`python3 scripts/run_experiment_panel.py` style
names, also usable as RL baselines):

| Schedule | What it does |
|---|---|
| `continuous-endocrine-cdk` | aromatase inhibition + palbociclib throughout |
| `endocrine-cdk-then-serd-cdk` | the same, then fulvestrant + palbociclib after `switch_time` |
| `early-switch-esr1-10` / `-1` | switch the endocrine component when the ESR1 mutants reach 10 % / 1 % of living cells (the molecular early-switch strategy) |
| `adaptive-endocrine-cdk` | AT50 holidays on the combination |
| `continuous-endocrine`, `continuous-palbociclib`, `continuous-fulvestrant`, `continuous-serd-cdk` | single agents and the second-line pair |

## Control, actions, reward

- **Actions** (section 41): the model declares an action grid, five exposure
  levels (0, 25, 50, 75, 100 %) for each of the four agents, masked so that at
  most one endocrine agent (aromatase inhibition or one SERD) is given at a
  time: 65 actions. The same set defines the "represented interventions" the
  controllability margin minimises over.
- **Reward** (section 42): controlled day, minus burden, growth, resistant
  fraction, dose, switches and necrosis, plus the controllability index and
  its **improvement**, minus a **toxicity** penalty on days whose total
  exposure reaches 1.75 (two agents near full dose). Every weight is an
  ablation knob in `RLConfig`, not a biological constant.
- **Domain randomisation** (section 45): with `randomize=True` each episode
  draws the pre-existing resistant fraction, the mutation multiplier, the
  resistant clones' fitness cost, a global IC50 multiplier, the CDK-escape
  fold change (5–12×), oxygen consumption, drug penetration and the oral
  SERD's reference exposure from the model's `randomization` block. Every
  range is labelled ASSUMPTION; the draw is seeded and recorded with the
  episode.
- **Risk** (section 46): evaluations report the median and the mean of the
  worst 10 % of seeds (CVaR₁₀) of the control time, and the minimum. Training
  itself still maximises the expected reward; a CVaR-optimising learner is not
  implemented.
- **Observation ablation**: `observation_mode="fractions_only"` zeroes the
  controllability features so a policy sees only burden, fractions, oxygen and
  dosing.

### Baselines (section 47)

| Strategy | Schedule id | Rule |
|---|---|---|
| A continuous | `continuous-endocrine-cdk` | endocrine + palbociclib throughout |
| B progression-triggered | `late-switch-regrowth` | switch to fulvestrant + palbociclib after the tumour has responded (< 80 % of start) and regrown to 1.2 × its nadir |
| C molecular early switch | `early-switch-esr1-10` | switch when the ESR1 mutants reach 10 % of living cells |
| D earlier molecular switch | `early-switch-esr1-1` | switch at 1 % |
| adaptive | `adaptive-endocrine-cdk`, `adaptive-holiday-30-60` | treatment off below 50 % (or 30 %) of the start, on again at 100 % (or 60 %) |
| E random | `random` | a uniformly random action each day |
| F model-predictive control | `mpc` | copy the simulator, hold each candidate action for 6 days, take the one with the best rollout score (low burden and resistance, small dose). Slow: one full engine rollout per candidate per day |
| PPO | `scripts/train_ppo.py --cancer breast_er_her2neg` | Stable-Baselines3 PPO on the 65-action environment |

Every schedule is declared in the model file and replayed through the same
action table the RL policy uses, so all strategies share one environment and
one set of metrics: time to loss of control (controllability index below the
cut-off or burden above 1.2 × start), time to resistant-clone dominance (≥ 50 %
of living cells), burden AUC, cumulative dose, mean controllability, switches,
toxic days, simulated eradication, and the worst case over seeds.

## Parameters and evidence

Every number in the model file carries an evidence level:

| Level | Meaning |
|---|---|
| DIRECT | measured in a relevant experimental system |
| DERIVED | calculated or combined from direct measurements |
| INFERRED | biologically supported, not measured for this exact system |
| ASSUMPTION | model parameter without direct evidence; randomise it |

| Parameter | Value | Evidence |
|---|---:|---|
| ESR1 WT intrinsic division rate | 0.385 /day (MCF-7 doubling ≈ 1.8 d) | DIRECT, in vitro |
| Fulvestrant IC50, ESR1 WT | 0.4 nM | DIRECT |
| Fulvestrant IC50, D538G | 6 nM (≈ 15–19×) | DIRECT |
| Fulvestrant IC50, Y537S | 20 nM (≈ 50×; 16–25 nM across studies) | DERIVED |
| Palbociclib IC50, sensitive | 750 nM (MCF-7; study-specific) | DIRECT |
| Palbociclib fold-change, CDK escape | 8× (range 3–15×) | DERIVED |
| Palbociclib fold-change, ESR1 mutants | 2.7× | DIRECT (relative) |
| Palbociclib half-life | 29 h | DIRECT (label) |
| Fulvestrant half-life | ≈ 40 d | DIRECT (label) |
| Endocrine EC50 (normalised), WT | 0.3 | ASSUMPTION |
| Endocrine EC50, Y537S / D538G | 20× / 8× WT | ASSUMPTION |
| Growth inhibition at saturation | 0.7–0.8 (sensitive), lower for CDK escape | INFERRED / ASSUMPTION |
| Kill rates | 0.02–0.08 /day | ASSUMPTION |
| Fitness costs (Y537S, D538G, CDK escape) | 0.05, 0.03, 0.08 | INFERRED / ASSUMPTION |
| Elacestrant IC50, ESR1 WT / D538G | 12 / 28 nM | DIRECT |
| Elacestrant IC50, Y537S | 35 nM, left uncertain (20–50 nM) | ASSUMPTION, not interpolated |
| Elacestrant reference exposure | 150 nM (50–300) | ASSUMPTION |
| Fitness cost relief under deprivation (ESR1 mutants) | 1.0 | INFERRED |
| Establishment base probability | 0.5 | ASSUMPTION |
| Pre-existing ESR1 mutant fraction | 0.5 % each in demos (prior 10⁻⁵–10⁻³) | ASSUMPTION |
| Mutation per division | 10⁻⁶ (ESR1), 5·10⁻⁷ (CDK escape); prior 10⁻⁹–10⁻⁶ | ASSUMPTION |

The reference exposures (what 1.0 means) are calibration choices, documented in
the model file. Plasma concentration is not tumour concentration, and in-vitro
IC50 scales are not clinical doses; the model never converts mg to µM.

### Explicit unknowns

Not calibrated facts, and shown as such: per-division ESR1 mutation
probabilities, clone establishment probability, resistant-clone fitness costs,
absolute tumour drug concentrations, drug diffusion in breast tissue, cellular
oxygen consumption, hypoxic thresholds, and the CDK-resistance transition rate.
Dates and approvals quoted in the original research brief after mid-2026 were
not verified here.

## What the model does, and does not, say

With these parameters the first-line combination keeps the sensitive clone
near zero net growth, endocrine pressure selects the ESR1 mutants (their
fraction grows several-fold in 40 simulated days when they are present), and
releasing the pressure lets the wild type win back. Fulvestrant plus
palbociclib **slows** the ESR1 mutants by roughly 2–3× compared with staying on
the aromatase inhibitor but does not reverse them. The oral SERD changes that
picture: under elacestrant plus palbociclib, D538G becomes controllable
(margin +0.005) and Y537S sits on the controllability boundary (−0.004). The
CDK4/6 escape remains treatment-exhausted under every represented action, so
an escape route always exists and the tumour's controllability index starts
low (≈ 0.05, against ≈ 0.09 for the lung model). The RL cut-off is therefore
0.02 for the breast experiments (`eci_min`), lower than the lung default.

### The section-69 experiment

`scripts/run_breast_experiment.py` seeds 99 % ER-sensitive cells with 0.5 % of
each ESR1 mutant (the brief's 0.05 % cannot be resolved on a 350-cell section)
and compares the strategies over 120 days on five seeds.

| Policy | n | Control (d, median) | Control (d, worst 10%) | Lost control | Resistant dominance (d) | Dominated | Burden AUC | Final resistant | Mean ECI | Dose | Switches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A_continuous | 5 | 120 | 120 | 0.00 | 59.50 | 0.80 | 46.56 | 0.88 | 0.28 | 240 | 1.00 |
| B_late_switch | 5 | 120 | 120 | 0.00 | 58.50 | 0.80 | 31.37 | 0.91 | 0.28 | 240 | 2.00 |
| C_early_switch_10 | 5 | 120 | 119 | 0.20 | 58.00 | 0.80 | 31.11 | 1.00 | 0.28 | 240 | 2.00 |
| D_early_switch_1 | 5 | 120 | 84.00 | 0.20 | 58.00 | 0.60 | 13.63 | 1.00 | 0.30 | 240 | 2.00 |
| E_ppo | 5 | 120 | 120 | 0.00 | 83.00 | 0.20 | 17.32 | 0.00 | 0.32 | 180 | 1.00 |
| F_mpc | 5 | 120 | 120 | 0.00 | — | 0.00 | 9.39 | 0.00 | 0.34 | 110 | 21.00 |
| random | 5 | 120 | 120 | 0.00 | — | 0.00 | 54.99 | 0.38 | 0.21 | 124 | 95.00 |

![Median burden, ESR1-mutant fraction and controllability index over 120 days for each strategy](figures/breast_experiment_trajectories.png)

Reading the table (five seeds; a research model on the in-vitro timescale):

- **No fixed strategy prevents ESR1 takeover.** Under A to D the ESR1 mutants
  dominate the living cells around day 58 in most seeds, because fulvestrant
  at the modelled exposure slows them but cannot reverse them. What the
  switches change is the burden: switching at a 1 % mutant share (D) gives
  the smallest tumour of the fixed strategies (burden AUC 14 against 47 for
  continuous treatment), at the price of one seed losing control at day 84.
- **The learned policy chose the oral SERD up front.** With 65 actions to
  pick from, PPO converged on palbociclib plus elacestrant from day one at
  less than full exposure. That avoids selecting the ESR1 mutants in the
  first place: dominance in one seed of five (day 83), a median final
  resistant fraction of 0, a lower dose than any fixed strategy (180 against
  240) and the second-highest controllability. In the model's terms it keeps
  the tumour treatment-controllable for longer, which is the brief's question
  (section 68). It is a statement about this simulator's represented drug
  set, not about patients.
- **Model-predictive control did best on burden** (AUC 9, no dominance, dose
  110) by switching agents 21 times, which is the behaviour the toxicity and
  switch penalties in the RL reward are meant to discourage; it also costs one
  full engine rollout per candidate per day.
- **Random dosing** never lost control either, because it leaves the tumour
  largely untreated (highest burden AUC) while its constant switching never
  gives the mutants a steady selective environment. It is the floor every
  strategy must clear on burden, and all except the untreated control do.
- **Worst case.** The worst-10 % column is the single worst seed here; only C
  and D have a seed that lost control before day 120.

The committed 3D recordings show the early-switch strategy (`breast48`) and
the PPO policy (`breast48-ppo`, opened with `?cancer=breast_er_her2neg&run=breast48-ppo`).


### Ablations (section 50)

`scripts/run_ablations.py` removes one ingredient at a time: the
controllability terms of the reward, the controllability features of the
observation, the oxygen field, the fixed biology (vs domain randomisation) and
the CDK-escape branch (ESR1 only).

Three seeds, 60 days, controllability cut-off 0.02. The PPO arms are short
runs (8 000 training steps each) and should be read as a smoke test of the
ablation machinery, not as trained policies; the fixed strategies do not read
the reward or the observation, so their rows are identical across the first
two ablations by construction.

#### Reward without the controllability terms (`eci`)

| Policy | n | Control (d, median) | Control (d, worst 10%) | Lost control | Resistant dominance (d) | Dominated | Burden AUC | Final resistant | Mean ECI | Dose | Switches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| with_eci/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.70 | 0.02 | 0.18 | 82.00 | 5.00 |
| with_eci/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 47.50 | 0.67 | 23.25 | 0.57 | 0.25 | 120 | 1.00 |
| with_eci/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 56.00 | 1.00 | 17.34 | 0.53 | 0.25 | 120 | 2.00 |
| with_eci/ppo | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 24.93 | 0.04 | 0.23 | 54.75 | 37.00 |
| without_eci/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.70 | 0.02 | 0.18 | 82.00 | 5.00 |
| without_eci/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 47.50 | 0.67 | 23.25 | 0.57 | 0.25 | 120 | 1.00 |
| without_eci/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 56.00 | 1.00 | 17.34 | 0.53 | 0.25 | 120 | 2.00 |
| without_eci/ppo | 3 | 60.00 | 60.00 | 0.00 | 55.00 | 0.33 | 20.21 | 0.00 | 0.25 | 77.50 | 3.00 |

#### Observation without the controllability features (`spatial`)

| Policy | n | Control (d, median) | Control (d, worst 10%) | Lost control | Resistant dominance (d) | Dominated | Burden AUC | Final resistant | Mean ECI | Dose | Switches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| fractions_only/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.70 | 0.02 | 0.18 | 82.00 | 5.00 |
| fractions_only/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 47.50 | 0.67 | 23.25 | 0.57 | 0.25 | 120 | 1.00 |
| fractions_only/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 56.00 | 1.00 | 17.34 | 0.53 | 0.25 | 120 | 2.00 |
| fractions_only/ppo | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 18.64 | 0.22 | 0.25 | 51.25 | 5.00 |
| full_state/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.70 | 0.02 | 0.18 | 82.00 | 5.00 |
| full_state/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 47.50 | 0.67 | 23.25 | 0.57 | 0.25 | 120 | 1.00 |
| full_state/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 56.00 | 1.00 | 17.34 | 0.53 | 0.25 | 120 | 2.00 |
| full_state/ppo | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 24.93 | 0.04 | 0.23 | 54.75 | 37.00 |

#### Uniform oxygen instead of the diffusing field (`oxygen`)

| Policy | n | Control (d, median) | Control (d, worst 10%) | Lost control | Resistant dominance (d) | Dominated | Burden AUC | Final resistant | Mean ECI | Dose | Switches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| oxygen_field/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.70 | 0.02 | 0.18 | 82.00 | 5.00 |
| oxygen_field/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 47.50 | 0.67 | 23.25 | 0.57 | 0.25 | 120 | 1.00 |
| oxygen_field/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 56.00 | 1.00 | 17.34 | 0.53 | 0.25 | 120 | 2.00 |
| uniform_oxygen/adaptive-endocrine-cdk | 3 | 48.00 | 41.00 | 1.00 | 42.00 | 1.00 | 40.38 | 0.57 | 0.08 | 96.00 | 1.00 |
| uniform_oxygen/continuous-endocrine-cdk | 3 | 48.00 | 41.00 | 1.00 | 42.00 | 1.00 | 40.38 | 0.57 | 0.08 | 96.00 | 1.00 |
| uniform_oxygen/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 41.00 | 1.00 | 31.23 | 0.88 | 0.17 | 120 | 2.00 |

#### Fixed biology vs domain-randomised episodes (`uncertainty`)

| Policy | n | Control (d, median) | Control (d, worst 10%) | Lost control | Resistant dominance (d) | Dominated | Burden AUC | Final resistant | Mean ECI | Dose | Switches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| domain_randomised/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.55 | 0.00 | 0.22 | 18.00 | 2.00 |
| domain_randomised/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 50.00 | 0.33 | 16.66 | 0.00 | 0.30 | 120 | 1.00 |
| domain_randomised/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 16.66 | 0.00 | 0.30 | 120 | 1.00 |
| fixed_biology/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.70 | 0.02 | 0.18 | 82.00 | 5.00 |
| fixed_biology/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 47.50 | 0.67 | 23.25 | 0.57 | 0.25 | 120 | 1.00 |
| fixed_biology/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 56.00 | 1.00 | 17.34 | 0.53 | 0.25 | 120 | 2.00 |

#### ESR1 only vs ESR1 + CDK escape (`evolution`)

| Policy | n | Control (d, median) | Control (d, worst 10%) | Lost control | Resistant dominance (d) | Dominated | Burden AUC | Final resistant | Mean ECI | Dose | Switches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| esr1_and_cdk_escape/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.70 | 0.02 | 0.18 | 82.00 | 5.00 |
| esr1_and_cdk_escape/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | 47.50 | 0.67 | 23.25 | 0.57 | 0.25 | 120 | 1.00 |
| esr1_and_cdk_escape/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 56.00 | 1.00 | 17.34 | 0.53 | 0.25 | 120 | 2.00 |
| esr1_only/adaptive-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 43.43 | 0.07 | 0.22 | 86.00 | 5.00 |
| esr1_only/continuous-endocrine-cdk | 3 | 60.00 | 60.00 | 0.00 | — | 0.00 | 25.35 | 0.36 | 0.34 | 120 | 1.00 |
| esr1_only/early-switch-esr1-10 | 3 | 60.00 | 60.00 | 0.00 | 48.00 | 1.00 | 18.08 | 0.71 | 0.32 | 120 | 2.00 |

What the ablations say, at this size:

- **Oxygen matters.** With a flat oxygen field the tumour grows faster, the
  continuous and adaptive strategies lose control around day 48, and the mean
  controllability index halves. Hypoxia-limited growth is part of what keeps
  the simulated tumour controllable.
- **The CDK-escape branch is the uncontrollable one.** With ESR1 mutants only,
  the mean controllability index rises (0.32–0.34 against 0.25) because the
  oral SERD can bring the ESR1 mutants to the boundary, while nothing in the
  modelled set reaches the CDK escape.
- **Randomising the biology changes the answer.** With the prior draws the
  tumours in these three seeds carry fewer established mutants, so every
  strategy keeps control and the early switch never fires. Conclusions drawn
  at fixed nominal parameters do not automatically transfer.
- **The controllability terms shape PPO's behaviour.** The arm trained with
  them switches far more often (37 vs 3 switches) and ends with a smaller
  resistant fraction in two of three seeds; a longer training run is needed
  before reading more into it.


## In the viewer

The 3D viewer's panel gains three folds for recorded runs:

- **Resistance graph** (section 62): the clone tree with live abundance, the
  control margin `M`, the escape distance `D` under that day's treatment and
  the best represented action, read per day from the run's `metrics.json`.
- **Parameters & evidence** (section 63): every clone's division rate, fitness
  cost and per-drug IC50, growth inhibition and kill rate with a DIRECT /
  DERIVED / INFERRED / ASSUMPTION badge; the source appears on hover. The lung
  run's calibration statuses map onto the same four levels.
- **Controller** (section 64): the policy (name, training cancer, training
  uncertainty, objective, action count) or the fixed strategy that drove the
  run, and for the current day the action taken, the controllability index
  and its next value, and the resistant fraction. The card says what the
  simulator policy did; it is not a clinical rationale.

A policy-driven run is recorded with `scripts/export_iressa_run.py --policy
outputs/rl_breast/ppo_breast.zip` and opened with `?cancer=breast_er_her2neg&run=<name>`.

Two more pieces make the controller legible:

- **Treatment pattern strip** above the timeline: one row per drug, one cell
  per day filled at the exposure level, a tick wherever the treatment changed
  and, on hover, the change in words. Recorded runs carry the words in their
  `metrics.json` (`cancer_sim/narration.py`); older recordings fall back to the
  schedule in `rules.json`.
- **Live mode** (`?source=live`, or the Recording / Live switch): the Python
  engine runs behind the 3D view one day at a time, with a treatment console
  (a slider per drug, the model's presets, "Let the AI decide" when a policy is
  loaded) and a narrated day card. The RL environment's episode rules do not end
  a live session; the day card reports when control was lost by that definition
  and the session runs to its horizon so the course can be changed.

## Validation

`tests/test_breast_model.py` and `tests/test_breast_control.py` run the pre-RL
checks on the 2D section the lung engine was validated on:

1. endocrine pressure slows a wild-type tumour;
2. the combination controls more than endocrine suppression alone;
3. endocrine pressure selects ESR1 mutants;
4. releasing the pressure does not let the mutant take over;
5. SERD resistance orders Y537S > D538G > wild type in the running engine;
6. CDK escape is 3–15× less palbociclib-sensitive;
7. a second diffusing field appears when the SERD is added to palbociclib;
8. the clone-triggered early switch fires on the mutant share and is one-way;
9. controllability margins rank the clones, and an escape distance is defined;
10. the RL environment runs with the model's 65 actions;
11. (test 7) oxygen falls away from the vessels, cells next to them cycle,
    cells between them arrest, the farthest die;
12. (test 8) the population doubles far slower than its cells could and stalls
    as the section fills, **but the clinical 150–500-day doubling time is not
    reproduced**: the engine runs on the in-vitro timescale and the model file
    records the target as NOT REPRODUCED;
13. fitness reversal, establishment, the dynamic escape distance, the masked
    action grid, the reward terms, seeded domain randomisation within the
    declared ranges, every baseline (including random and MPC) and the
    comparison metrics.

## Running it

```
# experiment panel (2D section)
python3 -c "from pathlib import Path; from cancer_sim.experiments import ExperimentConfig, run_experiment_panel; \
run_experiment_panel(config=ExperimentConfig(cancer='breast_er_her2neg', steps=60, mutation_scale=50.0), output_dir=Path('outputs/breast'))"

# 3D run for the viewer (data/runs/breast48; the viewer's Breast · ER+ switch opens it)
python3 scripts/export_iressa_run.py --cancer breast_er_her2neg --name breast48 --schedule early-switch-esr1-10 --size 48 --days 60

# RL baselines and PPO
python3 scripts/evaluate_policy.py --cancer breast_er_her2neg --days 120 --eci-min 0.02 --policies continuous-endocrine-cdk,early-switch-esr1-10,random,mpc
python3 scripts/train_ppo.py --cancer breast_er_her2neg --days 120 --randomize --eci-min 0.02 --total-timesteps 60000 --model-name ppo_breast --output-dir outputs/rl_breast

# the section-69 comparison, with the trained policy as strategy E, and the ablations
python3 scripts/run_breast_experiment.py --seeds 1001,1002,1003,1004,1005 --days 120 --with-random --with-mpc --policy outputs/rl_breast/ppo_breast.zip
python3 scripts/run_ablations.py --seeds 1001,1002,1003 --days 60 --train-steps 8000

# record a policy-driven 3D run for the viewer
python3 scripts/export_iressa_run.py --cancer breast_er_her2neg --name breast48-ppo --policy outputs/rl_breast/ppo_breast.zip --policy-trained-randomized --size 48 --days 60 --dt-days 1
```

## Coverage of the research brief

| Brief section | Status |
|---|---|
| 1–10 subtype, clones, treatment graph, MVP drug set | done (fulvestrant and elacestrant; camizestrant and the PI3K/FGFR agents are Stage 2) |
| 11–19 pharmacology and growth calibration | done with evidence levels; clinical-scale growth target recorded as not reproduced |
| 20–23 fitness reversal, two-process resistance, establishment | done |
| 24–27 oxygen | reused from the lung engine; oxygen-gradient check added; consumption randomised |
| 28–31 drug transport, normalised exposure, combination | done (global vs diffusing agents, independent action) |
| 32–37 controllability metrics, dynamic distance, ECI | done (ECI is the existing proxy, not a policy-maximised probability) |
| 38 phenotypic resistance states | not done (quiescence exists in the physics; no EMT / ER-low states) |
| 39–46 RL environment, action grid, reward, randomisation, risk | done, except a CVaR-optimising learner (CVaR is reported, not optimised) |
| 47–49 baselines and metrics | done |
| 50 ablations | script and runs done; PPO arms are short runs |
| 51–59 architecture and schemas | done as JSON models with evidence records (not YAML; no folder split of the physics) |
| 60–64 viewer: cancer selector, breast legend, resistance graph, provenance, controller | done |
| 65–66 evidence table, explicit unknowns | done |
| 67–69 MVP and the headline experiment | done |
| 70–72 Stage 2–4 | not started, by design |


## How the engine was generalised

The physics (`cancer_sim/automata.py`) knows only clones, transitions, drugs
and exposures. A `CancerModel` (`cancer_sim/cancers/`) names them: clone ids and
labels, drugs with their exposure type (diffusing field or global level) and
reference concentration, where the calibrated parameters live (files for lung,
inline with evidence levels for breast), the treatment schedules, the RL action
set and the demo run. `ExperimentConfig(cancer=...)` selects it everywhere:
the runner, metrics, controllability, the RL environment and the viewer
exporter. The lung model's recorded runs are byte-identical before and after
this change (checked on 15 histories across 2D, 3D, switch and adaptive
schedules).
