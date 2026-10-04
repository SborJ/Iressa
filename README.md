<div align="center">

# Iressa

### Watch a tumour outsmart its treatment, one cell at a time.

A 3D simulator of how cancers evolve drug resistance, calibrated on public lab data,<br>
where every cell that divides, mutates or dies can tell you why.

### [**▶ Open the live simulator at iressa.quicx.dev**](https://iressa.quicx.dev/)

[![Live demo](https://img.shields.io/badge/live%20demo-iressa.quicx.dev-e8590c)](https://iressa.quicx.dev/)
[![CI](https://github.com/SborJ/Iressa/actions/workflows/ci.yml/badge.svg)](https://github.com/SborJ/Iressa/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10+-3776ab?logo=python&logoColor=white)
![three.js](https://img.shields.io/badge/three.js-WebGL2-000000?logo=threedotjs&logoColor=white)

<img src="docs/images/timelapse.gif" alt="Sixty simulated days in a few seconds: a grey drug-sensitive tumour is overtaken by an orange resistant clone, the treatment switches, and tan and purple clones take over in turn" width="760">

<sub>Sixty simulated days. Grey cells are drug-sensitive. Orange carries T790M and shrugs off gefitinib.<br>The treatment switches on day 20, and tan (C797S) and purple (MET-amplified) clones take over.</sub>

[**Live demo**](#try-it-live) ·
[**Quick start**](#quick-start) ·
[**What you can do**](#what-you-can-do) ·
[**How it works**](#how-it-works) ·
[**The science**](#the-science) ·
[**Docs**](#documentation)

</div>

---

## The pill works. Then it doesn't.

Targeted cancer drugs can melt a tumour in weeks. Then, months later, it comes
back, and the drug that worked no longer does. Nothing new arrived from
outside: a handful of cells already carried, or picked up while dividing, the
one mutation that makes them immune. The treatment killed their competition
and handed them the tissue.

Iressa makes that process something you can watch, pause, cut open and
question. This is one recorded run of the calibrated engine, start to finish:

<table>
<tr>
<td width="25%"><img src="docs/images/story-1.jpg" alt="Day 2: a small, mostly grey tumour among blood vessels"></td>
<td width="25%"><img src="docs/images/story-2.jpg" alt="Day 19: an orange tumour with a dark dead core"></td>
<td width="25%"><img src="docs/images/story-3.jpg" alt="Day 36: orange cells thinning, tan and purple patches appearing"></td>
<td width="25%"><img src="docs/images/story-4.jpg" alt="Day 58: a large tan tumour with a purple region"></td>
</tr>
<tr>
<td valign="top"><b>Day 2 · Gefitinib</b><br>The tumour is drug-sensitive (grey). A few T790M cells (orange) are already there.</td>
<td valign="top"><b>Day 19 · Relapse</b><br>The sensitive cells are gone. T790M owns the tumour, and its core is starving.</td>
<td valign="top"><b>Day 36 · Osimertinib</b><br>The switch on day 20 hits T790M hard. Two new clones survive it.</td>
<td valign="top"><b>Day 58 · Relapse again</b><br>C797S (tan) and MET amplification (purple) rebuild the tumour.</td>
</tr>
</table>

None of that sequence is scripted. It falls out of growth rates, drug
sensitivities, oxygen supply and mutation odds, all of which live in data
files you can edit.

## Try it live

Iressa is running at **[iressa.quicx.dev](https://iressa.quicx.dev/)**. Nothing to install.

| | |
|---|---|
| [iressa.quicx.dev](https://iressa.quicx.dev/) | The landing page: the idea in a minute, open to everyone |
| [iressa.quicx.dev/simulation/](https://iressa.quicx.dev/simulation/) | The simulator. Create a free researcher account or sign in, then explore |
| [iressa.quicx.dev/simulation/?cancer=breast_er_her2neg](https://iressa.quicx.dev/simulation/?cancer=breast_er_her2neg) | The same, opening on the breast cancer model |

It needs a desktop browser with WebGL2. Everything below, including the AI
agent, works on the hosted version.

## What you can do

<img src="docs/images/simulator.jpg" alt="The Iressa simulator: a quarter-cut 3D tumour threaded by blood vessels, with cell counts by lineage on the left, a treatment timeline at the bottom and a plain-language status line at the top">

### See it three ways

The same cells, drawn the way three different lab techniques would show them.
Press <kbd>1</kbd>, <kbd>2</kbd> or <kbd>3</kbd> to switch.

<table>
<tr>
<td width="33%"><img src="docs/images/view-tissue.jpg" alt="Tissue view: solid packed cells in warm colours, brown vessels"></td>
<td width="33%"><img src="docs/images/view-fluorescence.jpg" alt="Fluorescence view: glowing red cells against teal vessels on black"></td>
<td width="33%"><img src="docs/images/view-histology.jpg" alt="Histology view: pink and purple cells on a pale background with red vessels"></td>
</tr>
<tr>
<td valign="top"><b>Tissue</b><br>A cleared sample: packed cells, membranes, nuclei, and necrosis deep inside.</td>
<td valign="top"><b>Fluorescence</b><br>A lineage-tracing experiment: every clone glows in its own colour.</td>
<td valign="top"><b>Histology</b><br>An H&amp;E section: pink cytoplasm, purple nuclei, red cells in the vessels.</td>
</tr>
</table>

### Ask any cell what happened to it

<table>
<tr>
<td width="50%"><img src="docs/images/hover-card.jpg" alt="A hover card on a dying cell reading: Dying. Apoptosis: Osimertinib (Tagrisso). EGFR + T790M, resistant"></td>
<td width="50%"><img src="docs/images/colour-by-outcome.jpg" alt="The tumour coloured by outcome: most cells grey, with orange cells dying of drug-induced apoptosis"></td>
</tr>
<tr>
<td valign="top"><b>Hover a cell</b> for its state, its lineage and the cause behind it: <i>"Apoptosis: Osimertinib"</i>, <i>"Necrosis: hypoxia"</i>.</td>
<td valign="top"><b>Colour by outcome</b> to tint every cell by why it is in its current state. Here, four days after the switch to osimertinib.</td>
</tr>
</table>

Cut a quarter or a half away and slide the cut through the mass. The cut faces
are individual cells; the rest of the tumour is a smooth surface.

### Read the evidence and run your own experiment

<table>
<tr>
<td width="25%"><img src="docs/images/panel-deaths.png" alt="Deaths by cause in the last day, and a chart of deaths over the run that spikes when osimertinib starts"></td>
<td width="25%"><img src="docs/images/panel-evidence.png" alt="A list of model parameters, each tagged DIRECT, INFERRED or ASSUMPTION"></td>
<td width="25%"><img src="docs/images/panel-resistance-graph.png" alt="The resistance graph for the breast model: each clone with its control margin and best treatment"></td>
<td width="25%"><img src="docs/images/panel-experiment.png" alt="Experiment controls: run length, dose, treatment, switch day, blood supply and oxygen sliders"></td>
</tr>
<tr>
<td valign="top"><b>Why cells are dying</b><br>Deaths by cause, last day and whole run, with treatment changes marked.</td>
<td valign="top"><b>Parameters &amp; evidence</b><br>Every value labelled as measured, inferred or assumed.</td>
<td valign="top"><b>Resistance graph</b><br>Which clones the represented drugs can still control.</td>
<td valign="top"><b>Set up an experiment</b><br>Change the dose, schedule or blood supply and run again.</td>
</tr>
</table>

### Two cancers, one engine

The physics knows only clones, transitions, drugs and exposures. Each cancer
is a single JSON file in [cancer_sim/cancers/](cancer_sim/cancers/), and the
top bar switches between them.

| | Lung · EGFR | Breast · ER+ |
|---|---|---|
| Disease | EGFR-mutant lung adenocarcinoma | ER+/HER2− breast cancer |
| Clones | EGFR, T790M, C797S, MET amplification | ESR1 wild type, ESR1 Y537S, ESR1 D538G, CDK4/6 escape |
| Treatments | gefitinib, osimertinib, capmatinib | endocrine suppression, palbociclib, fulvestrant, elacestrant |
| Open with | [`/simulation/`](https://iressa.quicx.dev/simulation/) | [`/simulation/?cancer=breast_er_her2neg`](https://iressa.quicx.dev/simulation/?cancer=breast_er_her2neg) |

<img src="docs/images/breast-model.jpg" alt="The breast cancer model on day 47: ESR1 Y537S cells in orange overtaking grey ER-sensitive cells under palbociclib plus fulvestrant">

### Watch an AI agent learn a treatment pattern

Press **AI agent**, give it 15 to 60 seconds, and a small REINFORCE agent
practises on hundreds of simulated tumours of the cancer on screen, choosing a
regimen every 10 days. While it learns, the 3D view plays its latest practice
run and the panel draws its "brain": what it looks at, what it now prefers,
and its learning curve. At the end it plays the learned pattern on a tumour it
never practised on and ranks it against fixed strategies on held-out seeds.

<img src="docs/images/ai-agent.jpg" alt="The AI agent panel mid-training: 480 practice runs, a diagram linking tumour size, resistance, time and last drug to six regimens, preference bars and a rising learning curve">

The policy is a linear softmax over a handful of readable features, written in
plain numpy ([cancer_sim/reinforce.py](cancer_sim/reinforce.py)), so its
weights can be read rather than guessed at. A half-minute of practice is a
demonstration of learning, and its result is often a poor schedule. A heavier
PPO pipeline with domain randomisation lives in
[scripts/train_ppo.py](scripts/train_ppo.py); see
[docs/rl-treatment-design.md](docs/rl-treatment-design.md).

> [!IMPORTANT]
> A learned pattern is whatever keeps *this model's* simulated tumour
> controlled with *its* represented drugs. It is not treatment advice.

## Quick start

To run your own copy you need Node 20+ and Python 3.10+.

```bash
git clone https://github.com/SborJ/Iressa.git
cd Iressa
cp .env.example .env.local    # then add your Supabase URL and anon key
npm start                     # installs what is missing, then serves http://localhost:5173
```

`npm start` installs the Node packages, creates the Python environment the AI
agent needs, and starts the server. The landing page is at `/` and the
simulator at `/simulation/`.

The simulator asks researchers to sign in, so it needs a Supabase project
before it will open: [docs/research-access.md](docs/research-access.md) walks
through it, including ORCID sign-in. The landing page is public.

To work on the Python engine and run its tests:

```bash
.venv/bin/pip install -r requirements-dev.txt

# simulate a tumour and export it for the 3D viewer
.venv/bin/python scripts/export_iressa_run.py --name demo48 --schedule gefitinib-osimertinib --size 48 --days 60

# train the AI agent from a terminal
.venv/bin/python scripts/train_reinforce.py --cancer lung_egfr --seconds 45
```

| Command | What it does |
|---|---|
| `npm start` | Set up anything missing (Node packages, the Python `.venv`), then start the server |
| `npm run dev` | Start the server only, when everything is already installed |
| `npm test` | 91 viewer tests |
| `npm run build` | Typecheck and production build |
| `npm run sim` | The TypeScript stand-in simulator, headless, with a cause breakdown |
| `npm run record` | Write `run.events` and `run.keyframes` for replay |
| `.venv/bin/python -m pytest -q` | 141 engine, calibration and export tests |

<details>
<summary><b>Keyboard shortcuts and URL parameters</b></summary>

| Key | Action |
|---|---|
| <kbd>Space</kbd> | Play or pause |
| <kbd>.</kbd> | Step |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> | Tissue, Fluorescence, Histology |
| <kbd>F</kbd> | Frame the tumour |
| <kbd>R</kbd> | Start the run over |

| URL | Opens |
|---|---|
| `/` | The landing page |
| `/simulation/` | The lung model's recorded run |
| `/simulation/?cancer=breast_er_her2neg` | The breast model's recorded run |
| `/simulation/?cancer=breast_er_her2neg&run=breast48-ppo` | The same tumour treated by a trained PPO policy |
| `/simulation/?source=local` | The TypeScript stand-in simulator, live |
| `/simulation/?source=file&rules=…&events=…&keyframes=…` | Any recorded run |
| `/simulation/?source=socket&host=…&port=…` | A run streamed over a WebSocket |

</details>

## Deploying

### How the live site is hosted

[iressa.quicx.dev](https://iressa.quicx.dev/) is self-hosted. It runs on our
own Ubuntu (Debian-based) server, published through a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```
visitor ──HTTPS──▶ Cloudflare ──encrypted tunnel──▶ our server ──▶ npm start (localhost:5173)
```

That setup is what keeps it secure:

- **No open ports.** The server makes an outbound connection to Cloudflare and
  accepts no inbound traffic. The app listens on `localhost` only, so it cannot
  be reached except through the tunnel.
- **HTTPS everywhere.** Cloudflare terminates TLS for the domain and the tunnel
  to the server is encrypted, so nothing travels in the clear.
- **The server's address stays private.** Visitors only ever see Cloudflare,
  which also absorbs denial-of-service traffic before it reaches the machine.
- **No passwords on the server.** Sign-in is handled by Supabase Auth; the
  server stores no credentials, and researcher profiles sit behind row level
  security.
- **Only the expected hostname is served.** Requests for any other host are
  rejected (`server.allowedHosts`).

### Hosting your own

1. On the server: clone the repository, add `.env.local`, run `npm start`.
   On Debian or Ubuntu, install `python3-venv` first; the script names the
   exact package if it is missing.
2. Add your domain to `server.allowedHosts` in [vite.config.ts](vite.config.ts),
   or the server answers "Blocked request".
3. Point your tunnel or reverse proxy at `http://localhost:5173`.
4. In Supabase, set the Site URL and Redirect URLs to your domain
   ([docs/research-access.md](docs/research-access.md)).

To update a running site: `git pull`, then `npm start` again.

> [!NOTE]
> The AI agent needs the Node server, because pressing **Start learning** runs
> a Python trainer on the host. A static build (`npm run build`, then serve
> `dist/`) hosts everything else, with the AI agent button inactive. On a
> public server, anyone can start a training run; only one runs at a time and
> each is capped at two minutes.

## How it works

```mermaid
flowchart LR
    subgraph data["Public lab data"]
        A["GDSC · Cell Model Passports<br>CIViC · cBioPortal"]
    end
    subgraph engine["Python engine · cancer_sim/"]
        B["Calibration<br>clones, IC50s, growth"]
        C["Cellular automaton<br>oxygen + drug fields"]
        D["RL agents<br>REINFORCE · PPO"]
    end
    subgraph contract["The contract"]
        E["rules.json<br>16-byte events<br>keyframes"]
    end
    subgraph viewer["Browser viewer · src/"]
        F["World<br>rebuilt from events"]
        G["WebGL renderer<br>+ panels"]
    end
    A --> B --> C --> E --> F --> G
    D <--> C
    V["visuals.json"] --> G
```

**The engine** ([cancer_sim/](cancer_sim/)) is a 3D cellular automaton, one
cell per voxel. Blood vessels supply oxygen and drug, which diffuse through
the tissue and are consumed along the way. Each cell reads its local oxygen
and drug level, then cycles, arrests, dies or divides, and each division is a
chance to mutate into the next clone on the resistance graph.

**The contract** ([docs/format.md](docs/format.md)) is deliberately tiny: a
`rules.json`, a stream of 16-byte event records (divide, die, mutate, change
state, each with its cause) and periodic keyframes. The Python and TypeScript
implementations are tested against each other byte for byte.

**The viewer** ([src/](src/)) knows no biology. It rebuilds the tissue from
the event stream and reads what a cause means from `rules.json` and how it
looks from `visuals.json`. There is not a rate, a threshold or a probability
anywhere in the renderer. The whole scene is five draw calls: only the cells
the cut exposes are drawn individually, and the rest is an isosurface.

That split is the point of the project. Change a number in a data file and the
behaviour changes, with no code edits and no rebuild. Adding a new cause of
death takes [a JSON edit and nothing else](docs/adding-a-cause.md).

<details>
<summary><b>Repository layout</b></summary>

```
cancer_sim/              the Python engine
  cancers/               one JSON per cancer: clones, drugs, schedules, RL actions
  calibration/           public data -> clone parameters, with provenance
  automata.py fields.py  the cellular automaton and its oxygen/drug solvers
  reinforce.py rl_env.py the REINFORCE agent and the Gymnasium environment
src/
  format/                the 16-byte event record and the keyframe. No biology.
  sim/                   the stand-in simulator. All the biology, none of the numbers.
  source/                the seam: local simulator | recorded file | WebSocket
  world/                 the tissue rebuilt from the event stream, plus the tallies
  render/                instanced cells, isosurface, vessels, one parameterised shader
  ui/                    hover card, panels, timeline, AI agent
  auth/                  Supabase sign-in
data/
  rules.json             every rate, threshold, probability and schedule
  visuals.json           every colour, animation preset and duration
  schema/                both files are validated against these at startup
  raw/ processed/        public datasets and the calibrated parameters built from them
  runs/                  recorded runs the viewer opens
scripts/                 CLIs: export runs, train agents, run experiment panels
tests/                   Vitest and pytest suites
docs/                    format, rendering, validation, model notes
index.html               the public landing page (media in landing/)
simulation/index.html    the simulator page
supabase/migrations/     researcher profiles, row level security, verified ORCID iDs
```

</details>

## The science

Iressa is built to be checked. The numbers come from public datasets, every
parameter says where it came from, and the engine was audited before anything
was built on top of it.

| Source | Used for |
|---|---|
| [GDSC](https://www.cancerrxgene.org/) | Drug response: 242,036 dose-response rows, reduced to IC50s for matched cell lines |
| [Cell Model Passports](https://cellmodelpassports.sanger.ac.uk/) | Which cell lines carry which mutations, and how fast they grow |
| [CIViC](https://civicdb.org/) | Curated clinical evidence for each resistance mutation |
| [cBioPortal](https://www.cbioportal.org/) | How often each alteration occurs in a real patient cohort |

**Provenance on every value.** Each parameter is tagged `DIRECT` (measured in
a relevant system), `DERIVED`, `INFERRED` or `ASSUMPTION`, in the data and in
the viewer's evidence panel. Gefitinib's IC50 against the sensitive clone is
measured across five cell lines; C797S's osimertinib resistance is supported
by the literature but its number is an assumption, and the interface says so.

**An audited engine.** The [validation report](docs/validation/VALIDATION_REPORT.md)
covers ingestion, calibration, units, both field solvers and multi-seed
behaviour over 20 seeds of 120 simulated days. It found and fixed real bugs,
including a drug field that never reached the cells and an unconverged oxygen
solver. The overall verdict is *pass with limitations*, and the limitations
are listed.

<img src="docs/validation/figures/multiseed_summary.png" alt="Bar charts over 20 seeds for seven treatment schedules: time to progression, final burden, final resistant fraction and cumulative dose, with interquartile ranges">

**Experiments, not anecdotes.** In the breast model, seven strategies were
compared over 120 days on five seeds. No fixed schedule prevented the ESR1
mutants from taking over; switching earlier only made the tumour smaller. The
[full table and discussion](docs/breast_er_positive.md) include the cases
where the learned policies did better, and the caveats that go with five seeds.

<img src="docs/figures/breast_experiment_trajectories.png" alt="Three line charts over 120 days for each strategy: tumour burden, ESR1-mutant fraction and controllability index">

### What this is not

> [!WARNING]
> Iressa is a research and teaching model. It is not a clinical tool, and
> nothing it shows is a prediction for a patient.

- **Time runs fast.** Growth is calibrated on cell lines that double in 40 to
  100 hours, so events unfold 10 to 30 times faster than in a person.
- **Mutation rates are scaled up.** At real somatic rates no resistant clone
  would appear in a tumour of a few thousand simulated cells, so demo runs
  multiply the rate. The relapse you see is real in kind, not in timing.
- **Some drug responses are assumed.** Every MET-amplification and C797S IC50
  is an assumption, as is capmatinib's. They are labelled, not hidden.
- **Pharmacokinetics is simple.** The calibrated engine holds a constant drug
  concentration at the vessel wall.
- **The stand-in simulator's numbers are placeholders.** `data/rules.json`
  drives the TypeScript simulator used for development. Its structure is
  meant to last; several of its values were chosen so a 60-day run shows
  something, and its immune term is a flat surface hazard, not an immune model.

## Documentation

| Read this | To learn |
|---|---|
| [docs/format.md](docs/format.md) | The event format: the contract between any simulation and the renderer |
| [docs/adding-a-cause.md](docs/adding-a-cause.md) | How to add a cause of death or arrest without touching code |
| [docs/rendering.md](docs/rendering.md) | How the scene is drawn, and what is data versus illustration |
| [docs/physics_world.md](docs/physics_world.md) | The lattice, the fields and the cell rules |
| [docs/python-engine.md](docs/python-engine.md) | The engine's command reference |
| [docs/roadmap.md](docs/roadmap.md) | Known bottlenecks and what comes next |
| [docs/stand-in-simulator.md](docs/stand-in-simulator.md) | The TypeScript simulator, the source seam and how to read `rules.json` |
| [docs/breast_er_positive.md](docs/breast_er_positive.md) | The breast model, its evidence table and its experiments |
| [docs/rl-treatment-design.md](docs/rl-treatment-design.md) | The RL environment, rewards and PPO pipeline |
| [docs/validation/](docs/validation/) | The validation report, parameter provenance and viewer integration |
| [docs/research-access.md](docs/research-access.md) | Setting up sign-in with Supabase and ORCID |
| [docs/references.md](docs/references.md) | The papers and datasets behind the model |
| [Business_plan.md](Business_plan.md) | The commercial hypothesis, clinical and market research used, and evidence limits |

The [business plan](Business_plan.md) draws on the [FLAURA](https://www.nejm.org/doi/full/10.1056/NEJMoa1713137)
and [SERENA-6](https://www.nejm.org/doi/full/10.1056/NEJMoa2502929) trials,
[GLOBOCAN 2022 incidence](https://www.wcrf.org/preventing-cancer/cancer-statistics/worldwide-cancer-data/),
and linked biosimulation market reports. Its market sizing, prices and revenue
are estimates or hypotheses, not clinical validation or proven demand.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
setup, the tests to run and the one rule that matters most here: numbers
belong in data files with a provenance label, never in code. To report a
security problem, see [SECURITY.md](SECURITY.md).

## Citing

If Iressa is useful in your work, please cite it. GitHub's **Cite this
repository** button reads [CITATION.cff](CITATION.cff).

## License

[MIT](LICENSE). The public datasets under [data/raw/](data/raw/) remain under
their own providers' terms; see [docs/references.md](docs/references.md).

<sub>The project takes its name from gefitinib's brand name, the first drug in
the story it simulates. It is an independent research project and is not
affiliated with or endorsed by the drug's manufacturer.</sub>
