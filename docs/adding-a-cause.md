# Adding a cause

Two entries in two data files. No code, no shader, no rebuild.

Say you want ferroptosis — iron-dependent death, which should look like a
shrinking cell that breaks into a couple of pieces with a rusty flash.

## 1. `data/rules.json` — what it is

Add to `causes`:

```json
{
  "id": 10,
  "name": "ferroptosis",
  "role": "ferroptosis",
  "kind": "death",
  "animation": "ferroptosis",
  "label": "Ferroptosis: iron overload",
  "dyingTicks": 12
}
```

`id` is what goes in the event's `cause` byte. `kind: "death"` puts it in the
deaths tally and gives it a band in the chart. `dyingTicks` is how long the cell
lingers before it is removed. `label` is the hover card text; `{drug}` and
`{clone}` are substituted from the event.

`role` is only needed if a simulator has to look the id up — the stand-in
resolves the mechanisms it implements by role, and a role it does not know is
simply never emitted by it.

## 2. `data/visuals.json` — what it looks like

Add the preset the cause named, and its colour:

```json
"presets": {
  "ferroptosis": {
    "durationTicks": 12,
    "scaleTarget": 0.55, "scaleCurve": "easeIn",
    "alphaTarget": 0,
    "bleb": 0.1, "blebFrequency": 5,
    "fragments": 2, "fragmentSpread": 0.5,
    "tint": "#c98500", "tintAmount": 0.6,
    "emissive": 0.9, "flashTicks": 2
  }
},
"causeColors": { "10": "#d55181" }
```

Reload. That is the whole change.

## The effects a preset combines

The shader implements six generic effects; a preset is a set of numbers that
combines them. There is no per-cause code anywhere.

| | |
|---|---|
| **scale curve** | `scaleTarget`, `scaleCurve`, `swell` |
| **colour curve** | `tint`, `tintFrom`, `tintAmount`, `tintCurve`, `desaturate` |
| **blebbing** | `bleb`, `blebFrequency`, `blebDrift` |
| **fragmenting** | `fragments`, `fragmentSpread` |
| **transparency** | `alphaTarget`, `alphaCurve` |
| **emissive** | `emissive`, `flashTicks` |
| **nuclei** | `nuclei`, `nucleiBulge` — smooth internal lobes |

Curves: `linear`, `easeIn`, `easeOut`, `easeInOut`, `pulse`, `step`.

Phase runs 0 → 1 over `durationTicks` and clamps there, so **a preset's phase-1
appearance is its resting appearance**. An effect that should come and go is
written with the `pulse` curve, `swell`, or `flashTicks`, all of which return to
rest on their own — which is how `divide` is a swell that ends where it started.

`tintFrom` picks where the tint colour comes from: `fixed` uses `tint`, `drug`
uses `drugColors[the event's drug]` (so a drug-induced death carries that drug's
colour), and `clone` uses `cloneColors[the new clone]` (so a mutation
cross-fades into the clone it became).

## One cause, two animations

The renderer picks a preset by **type and cause**, so the same cause can look
different depending on what happened. Radiation uses this: a cell hit by
radiation becomes multinucleated and then dies at its next division attempt.

```json
"byEvent": {
  "5:4": "radiation_damage",
  "2:4": "mitotic_catastrophe"
}
```

Resolution order, most specific first:

1. `visuals.byEvent["<type>:<cause>"]`
2. `visuals.byCause["<cause>"]`
3. the `animation` the cause names in `rules.json`

## If you forget half of it

Startup validates both files against their schemas and then against each other,
and reports every problem at once:

```
visuals.json and rules.json disagree
  - cause 10 ("ferroptosis") names animation "ferroptosis", which visuals.json does not define
  - cause 10 ("ferroptosis") has no entry in causeColors
```

`tests/visuals.test.ts` adds exactly this cause from data alone and checks it
resolves, that its parameters reach the shader payload, and that leaving out
either half is reported.
