# Iressa

A 3D tumour simulation and renderer in which **no cell event is hardcoded**.
Cells divide, arrest, mutate and die for biological reasons, and every reason —
every rate, threshold, probability and schedule — lives in `data/rules.json`.
Every colour, animation and duration lives in `data/visuals.json`. Changing a
number in either file changes the behaviour, with no code edits and no rebuild.

A stand-in simulator currently generates the events. A Python simulation will
later produce the same events from real models, writing the same files or
streaming the same records. Nothing downstream changes when that happens.

```
npm install
npm run dev          # http://localhost:5173 opens the calibrated engine's demo run (data/runs/demo48)
                     # add ?source=local for the TypeScript stand-in simulator
npm test             # viewer tests
npm run sim          # the stand-in simulator, headless, with a cause breakdown
npm run record       # write run.events + run.keyframes for replay
```

The public landing page is `landing/index.html` (`/landing/` on the dev
server). The simulator itself asks researchers to sign in first; see
[Research access](#research-access) to configure it.

## Research access

Sign-in uses [Supabase Auth](https://supabase.com/docs/guides/auth) (email and
password, email confirmation, password reset). The landing page stays public;
the simulator is only built after a session exists.

1. **Keys.** Copy `.env.example` to `.env.local` and fill in the project URL
   and the public **anon** key (Supabase → Project Settings → API). Never use
   the service-role key: anything prefixed `VITE_` ships to the browser, and
   the app refuses to start with a secret key.
2. **Database.** Apply `supabase/migrations/` (Supabase → SQL Editor, paste the
   file and run it; or `supabase link` then `supabase db push`). It creates
   `public.profiles`, a trigger that gives every new user a profile, and
   owner-only row level security.
3. **Redirects.** Supabase → Authentication → URL Configuration: set the Site
   URL to where the simulator is hosted, and add `http://localhost:5173/**`
   (plus the hosted URL with `/**`) to Redirect URLs, so confirmation and reset
   emails can return to the app.
4. **Password policy.** Authentication → Providers → Email: set the minimum
   password length to 8 to match the form. "Confirm email" may be on or off;
   both paths are handled.

### Sign in with ORCID

Researchers can also sign in with their [ORCID iD](https://orcid.org). There is
no separate registration: the first ORCID sign-in creates the account. Supabase
runs the OpenID Connect exchange and verifies ORCID's signed token; a database
trigger then records the iD on the profile with `orcid_verified_at`. Nobody can
type an iD in or mark themselves verified, so a verified iD always means ORCID
authenticated that person. ORCID never shares an email, so these accounts show
the researcher's name and a link to their ORCID record instead.

1. Create ORCID public API credentials at <https://orcid.org/developer-tools>
   with the redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Enable custom OAuth providers for the project in the Supabase dashboard
   (Authentication → Sign In / Providers).
3. Register the provider, from your own machine (the service-role key stays there):

   ```
   SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
   ORCID_CLIENT_ID=APP-… ORCID_CLIENT_SECRET=… npm run setup:orcid
   ```

4. Set `VITE_ORCID_ENABLED=true` in `.env.local`. Until then the button is hidden.

The sign-in screen is the experience, not the security boundary: the static
simulator files are served to anyone. Anything that must stay private belongs
in Supabase behind row level security, as `profiles` does.

## The calibrated Python engine

`cancer_sim/` is the validated EGFR-resistance engine (GDSC/Cell Model Passports/CIViC-calibrated
clones, oxygen and drug fields, division, mutation on division, treatment schedules). It writes
runs in this viewer's format:

```
pip install -r requirements.txt
python3 scripts/export_iressa_run.py --name demo48 --schedule gefitinib-osimertinib --size 48 --days 60
npm run dev   # then open the URL the exporter prints
python3 -m pytest -q          # engine, calibration and export tests
```

See `docs/validation/VIEWER_INTEGRATION.md` (how the two halves connect),
`docs/validation/VALIDATION_REPORT.md` (what was audited and fixed in the engine) and
`docs/python-engine.md` (the engine's command reference).

## What you see

A 64³ voxel lattice at 15 µm - one cell per voxel. A vascular tree runs through
it; its lumen is where oxygen and drug enter the tissue, and no cell may occupy
a vessel. A seeded clone grows in perfused tissue, outruns the supply between
vessels and develops hypoxic, necrotic ground with living cuffs around the
vessels. Gefitinib starts on day 20; most of the tumour dies of drug-induced
apoptosis and the rest arrests. A T790M subclone acquired at some division
survives and relapses. Two radiation fractions land on day 50. Every one of
those is a consequence of numbers in `rules.json`, not of a branch in the code.

It opens on a quarter-cut tumour: the cut faces are individual cells, and
outside them the mass is a smooth isosurface.

- **Three imaging views.** *Tissue* is a cleared sample: packed cells with
  visible membranes and nuclei, vessels running through, darker necrosis deep
  inside. *Fluorescence* is a light-sheet volume of a lineage-tracing
  experiment: nuclear stain in blue, each clone in its own fluorescent protein.
  *Histology* is an H&E section: eosin cytoplasm, haematoxylin nuclei, pale
  necrosis, red cells in the vessels.
- **Hover a cell** for its state and, when it is dying or arrested, the cause —
  "Necrosis: hypoxia", "Apoptosis: Gefitinib (Iressa)" — plus the local oxygen
  and drug concentration it is responding to.
- **Colour by** clone or cause. Colour-by-cause tints every cell by the cause of
  its current state.
- **Cut** a quarter or a half away, and slide the cut through the mass.
- **Deaths — last 24 h** tallies deaths by cause over the last simulated day;
  the chart below it shows deaths by cause over the whole run, with the
  treatment schedule marked from `rules.json`.

## Layout

```
data/
  rules.json             every rate, threshold, probability and schedule
  visuals.json           every colour, animation preset and duration
  schema/*.schema.json   both files are validated against these at startup
src/
  format/                the 16-byte event record and the keyframe. No biology.
  sim/                   the stand-in simulator. All the biology, none of the numbers.
  source/                the seam: local simulator | recorded file | WebSocket
  world/                 the matrix rebuilt from the event stream, plus the tallies
  render/                instanced mesh, one parameterised shader, visuals.json
  ui/                    hover card, tally, chart, controls
  auth/                  Supabase sign-in: client, service, screens, account menu
supabase/
  migrations/            database schema (researcher profiles, RLS, verified ORCID iDs)
landing/                 the public landing page
python/
  iressa_format.py       the wire format for the Python simulation
  serve.py               example: stream a recorded run over a WebSocket
docs/
  format.md              the contract between a simulation and the renderer
  adding-a-cause.md      how to add one, without touching any code
  rendering.md           how it is drawn, and what is data vs illustration
screenshots/             the captured views, described in VISUAL_REPORT.md
```

## The two halves

**`src/sim/` knows the biology but not the numbers.** It grows a vascular tree
from the rules, perfuses the lattice from its lumen, then reads each living
node's local situation out of the matrix — oxygen, drug concentration, free
neighbours, its clone profile, how long it has been in its state — turns that
into per-cause hazards using the rules, and emits the event with the cause that
fired. It resolves cause and state ids by *role* (`drugApoptosis`,
`hypoxicNecrosis`, …) so even the ids live in the data file. Rolls are hashed
from `(seed, tick, node, channel)`, so a run is reproducible and does not depend
on the order nodes are visited in.

**`src/render/` and `src/ui/` know neither.** They read the meaning of a cause
from the cause table in `rules.json` and its appearance from `visuals.json`.
There is not a rate, a threshold or a probability anywhere in them. The shader
implements six generic effects — scale curve, colour curve, blebbing,
fragmenting, transparency, emissive — and a preset is a set of numbers that
combines them.

## Swapping in the real simulation

`SimulationSource` (`src/source/types.ts`) is the only thing the renderer talks
to. Three implementations ship:

| Source | How to use it |
|---|---|
| the stand-in simulator | the default |
| a recorded run | `?source=file&events=/run.events&keyframes=/run.keyframes` |
| a stream | `?source=socket&url=ws://localhost:8787` |

A Python run supplies its own `rules.json` alongside its events; point the
viewer at it with `?rules=/path/to/rules.json`.

`docs/format.md` is the contract. `python/iressa_format.py` implements it, and
`tests/pythonFormat.test.ts` checks the two implementations against each other
byte for byte rather than each against its own idea of the format.

## Reading the numbers

The *structure* of `rules.json` is meant to survive contact with the real
simulation; several of the *values* in it were chosen so that a 60-day run shows
something, and should be replaced rather than cited.

- **Mutation rates** (`2e-5` and `8e-6` per division) are orders of magnitude
  above real somatic rates. At a realistic rate no resistant clone would appear
  in 44 000 divisions, and the relapse — the thing worth looking at — would
  never happen. This is the number to change first when real models arrive.
- **The fields are in normalised lattice units.** `oxygen.diffusion` is a
  per-sweep lattice coefficient (above 1/6 the 6-point Laplacian goes unstable,
  which the schema enforces), oxygen runs 0–1 against the boundary supply, and
  drug concentrations are on whatever scale the IC50s are. A plasma reading of
  1.48 means "1.48 of the same units as the IC50s", not ng/mL.
- **`immune.killPerHour`** is a flat surface-only hazard, not an immune model.
  It exists so the immune-kill cause is exercised; it is the most obviously
  placeholder parameter in the file.
- **Pharmacokinetics** is one compartment with first-order absorption. The
  half-life is gefitinib's; the dose is normalised.

What is meant to be taken seriously is that none of these live in code: the
hypoxic core, the treatment response, the relapse and the radiation effect are
all consequences of this file, and replacing a value changes them.

## Performance

Five draw calls for the whole scene: one G-buffer pass over the isosurface,
the cells, the nuclei and the vessels, then one pass that turns it into the
image. Only the cells the cut exposes are instanced - a few thousand of them -
and the rest of the mass is the isosurface, which is both what makes it
affordable and what stops a distant tumour reading as a cloud of dots. Preset
parameters ride along as per-instance attributes, so an event touches only the
slots it changed. The oxygen and drug fields are relaxed only inside a box
around the tumour.

The knobs that matter if you change the grid: `cell.detail` (0 is 20 triangles
per cell, 1 is 80, 2 is 320), `cell.slabVoxels` and each view's own
`slabVoxels`, and `oxygen.relaxSweepsPerTick`. `docs/rendering.md` explains the
architecture; `VISUAL_REPORT.md` records measured frame times.
