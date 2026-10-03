"""Export a validated-engine run in the viewer's recorded-run format.

Writes, into one folder:
    rules.json       the viewer's data file for this run (grid, time, clones, drugs,
                     mutations, causes/states, treatment markers, vessel segments)
    run.events       16-byte event records, non-decreasing tick order
    run.keyframes    IKF1 keyframes (tick 0 plus one per ``keyframe_every_days``)
    history.csv      the engine's per-step record (same as the CLI)
    summary.json     provenance of the run and the URL to open it with

The engine runs untouched (``experiments.build_runner`` with ``record_events=True``);
this module only translates the engine's event log into the viewer's vocabulary,
looking cause and state ids up by role in ``rules.json`` as the format document
asks (``ids_by_role``), never by hard-coded number.

Open in the viewer (``npm run dev`` in the repository root):
    /?source=file&rules=/runs/<name>/rules.json&events=/runs/<name>/run.events&keyframes=/runs/<name>/run.keyframes
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))

from iressa_format import (  # noqa: E402  (the viewer's own format module)
    NO_DRUG,
    EventWriter,
    Keyframe,
    KeyframeNode,
    encode_keyframe,
    ids_by_role,
)

from cancer_sim.automata import DEFAULT_CALIBRATED_CLONE_DATA, DEFAULT_RESISTANCE_GRAPH  # noqa: E402
from cancer_sim.experiments import ExperimentConfig, build_runner  # noqa: E402
from cancer_sim.simulation import write_history_csv  # noqa: E402
from cancer_sim.vasculature import DEFAULT_SPEC  # noqa: E402

TEMPLATE_RULES = ROOT / "data" / "rules.json"
RUNS_DIR = ROOT / "data" / "runs"

CLONE_IDS = {"EGFR": 0, "T790M": 1, "C797S": 2, "MET_AMP": 3}
CLONE_LABELS = {
    "EGFR": "EGFR-mutant (sensitive)",
    "T790M": "EGFR + T790M",
    "C797S": "EGFR + T790M + C797S",
    "MET_AMP": "EGFR + MET amplification"
}
DRUG_IDS = {"gefitinib": 0, "osimertinib": 1, "capmatinib": 2}
DRUG_DISPLAY = {"gefitinib": "Gefitinib (Iressa)", "osimertinib": "Osimertinib (Tagrisso)", "capmatinib": "Capmatinib (Tabrecta)"}
# plasma elimination half-lives, hours (prescribing information); only informational for the viewer
DRUG_HALF_LIFE_H = {"gefitinib": 41.0, "osimertinib": 48.0, "capmatinib": 6.5}
# default 3D tree, denser than the viewer's template so the mean distance to a lumen
# (~120 um at 48^3 x 20 um) sits inside the 100-200 um intercapillary range used in 2D
DEFAULT_3D_TREE = {**DEFAULT_SPEC, "trunks": 10, "maxDepth": 6}

STATE_FOR_CELL = {"proliferating": "cycling", "quiescent": "arrested", "necrotic": "dying"}


def export_run(
    config: ExperimentConfig,
    schedule: str,
    *,
    name: str,
    out_root: Path = RUNS_DIR,
    tick_minutes: float = 30.0,
    keyframe_every_days: float = 1.0,
    template_rules: Path = TEMPLATE_RULES,
    vasculature_spec: dict | None = None,
    microenvironment_args=None,
    progress=None
) -> dict[str, Any]:
    out = out_root / name
    out.mkdir(parents=True, exist_ok=True)
    template = json.load(open(template_rules))

    ticks_per_day = 24.0 * 60.0 / tick_minutes
    ticks_per_step = config.dt * ticks_per_day
    if abs(ticks_per_step - round(ticks_per_step)) > 1e-9 or ticks_per_step < 1:
        raise ValueError(f"dt {config.dt} days is not a whole number of {tick_minutes}-minute ticks")
    ticks_per_step = int(round(ticks_per_step))
    keyframe_every_steps = max(1, int(round(keyframe_every_days / config.dt)))

    if vasculature_spec:
        config = replace(config, vasculature_trunks=int(vasculature_spec.get("trunks", config.vasculature_trunks)),
                         vasculature_max_depth=int(vasculature_spec.get("maxDepth", config.vasculature_max_depth)))
    runner = build_runner(
        schedule_name=schedule,
        config=config,
        microenvironment_args=microenvironment_args,
        record_events=True
    )
    automata = runner.automata
    world = automata.world

    cause = ids_by_role(template, "causes")
    state = ids_by_role(template, "states")
    state_code = {k: state[v] for k, v in STATE_FOR_CELL.items()}
    # The viewer needs nz >= 3. A 2D section is exported as the middle plane (z = 1) of a 3-deep box.
    nz = world.config.depth if world.config.depth > 1 else 3
    z_offset = 0 if world.config.depth > 1 else 1
    plane = world.config.width * world.config.height

    def node_of(engine_node: int) -> int:
        return engine_node + z_offset * plane

    def node_cause(cell) -> int:
        if cell.state != "necrotic":
            return cause["normalCycle"]
        return cause["hypoxicNecrosis"] if cell.death_cause == "hypoxia" else cause["drugApoptosis"]

    def keyframe(tick: int) -> bytes:
        nodes = [
            KeyframeNode(node=node_of(world.config.node_index(x, y, z)), clone=CLONE_IDS[cell.clone_id],
                         state=state_code[cell.state], cause=node_cause(cell))
            for (x, y, z), cell in sorted(world._cells.items(), key=lambda kv: (kv[0][2], kv[0][1], kv[0][0]))
        ]
        return encode_keyframe(Keyframe(tick=tick, nx=world.config.width, ny=world.config.height, nz=nz, nodes=nodes))

    writer = EventWriter()
    keyframes = [keyframe(0)]
    counts = {"divide": 0, "mutate": 0, "death": 0, "removed": 0, "state": 0}
    for step in range(1, config.steps + 1):
        runner.step(dt=config.dt, step_number=step)
        tick = step * ticks_per_step
        for event in automata.events:
            kind = event[0]
            counts[kind] += 1
            if kind == "divide":
                _, parent, daughter, clone = event
                writer.divide(tick, cause["normalCycle"], CLONE_IDS[clone], node_of(parent), node_of(daughter))
            elif kind == "mutate":
                _, node, old, new = event
                writer.mutate(tick, cause["mutation"], CLONE_IDS[old], node_of(node), CLONE_IDS[new])
            elif kind == "death":
                _, node, role, drug, clone = event
                writer.death_start(tick, cause[role], CLONE_IDS[clone], node_of(node), NO_DRUG if drug is None else DRUG_IDS[drug])
            elif kind == "removed":
                _, node, role, drug, clone = event
                writer.removed(tick, cause[role], CLONE_IDS[clone], node_of(node), NO_DRUG if drug is None else DRUG_IDS[drug])
            elif kind == "state":
                _, node, new_state, role, clone = event
                writer.state_change(tick, cause[role], CLONE_IDS[clone], node_of(node), state_code[new_state], NO_DRUG)
        if step % keyframe_every_steps == 0:
            keyframes.append(keyframe(tick + 1))      # a tick with no events: state after this step
        if progress and (step % 10 == 0 or step == config.steps):
            progress(step, config.steps, runner.history[-1])

    (out / "run.events").write_bytes(writer.bytes())
    (out / "run.keyframes").write_bytes(b"".join(keyframes))
    write_history_csv(out / "history.csv", runner.history)

    rules = build_rules(template, config, runner, tick_minutes, ticks_per_step, keyframe_every_steps, vasculature_spec, nz, z_offset)
    (out / "rules.json").write_text(json.dumps(rules, indent=2) + "\n")

    rel = out.relative_to(ROOT / "data") if (ROOT / "data") in out.parents else out
    url = f"/?source=file&rules=/{rel}/rules.json&events=/{rel}/run.events&keyframes=/{rel}/run.keyframes"
    summary = {
        "name": name, "schedule": schedule, "config": {k: (list(v) if isinstance(v, tuple) else v) for k, v in config.__dict__.items()},
        "ticks_per_step": ticks_per_step, "tick_minutes": tick_minutes, "events": len(writer), "event_counts": counts,
        "keyframes": len(keyframes), "final_burden": runner.history[-1].burden,
        "final_clones": runner.clone_counts(), "viewer_url": url,
        "engine": "cancer_sim (validated 2D rules extended to 3D; see docs/validation)",
        "disclaimer": "Educational/research simulation on an in-vitro growth timescale; not a clinical prediction."
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def build_rules(template: dict, config: ExperimentConfig, runner, tick_minutes: float, ticks_per_step: int,
                keyframe_every_steps: int, vasculature_spec: dict | None, nz: int | None = None, z_offset: int = 0) -> dict:
    """The viewer's rules.json for this run: its own vocabulary, our run's facts."""
    clones = {c["clone_id"]: c for c in json.load(open(DEFAULT_CALIBRATED_CLONE_DATA))}
    graph = json.load(open(DEFAULT_RESISTANCE_GRAPH))
    world = runner.automata.world
    acfg = runner.automata.config
    rules = json.loads(json.dumps(template))   # deep copy
    rules["seed"] = int(config.seed)
    rules["time"] = {"tickMinutes": tick_minutes, "maxTicks": int(config.steps * ticks_per_step + 2),
                     "keyframeEveryTicks": int(keyframe_every_steps * ticks_per_step)}
    nz = nz or world.config.depth
    rules["grid"] = {"nx": world.config.width, "ny": world.config.height, "nz": nz,
                     "voxelMicrons": world.config.cell_size_um, "neighborhood": 26}
    rules["seeding"] = {"clone": 0, "radiusVoxels": 3.5, "snapToVessel": False,
                        "center": [world.config.width // 2, world.config.height // 2, world.config.depth // 2 + z_offset]}

    network = getattr(world, "vessel_network", None)
    vasc = dict(template.get("vasculature") or DEFAULT_SPEC)
    vasc.update({"trunks": config.vasculature_trunks, "maxDepth": config.vasculature_max_depth})
    vasc.update(vasculature_spec or {})
    if network is not None:
        vasc["segments"] = [s.as_dict() for s in network.segments]
    else:
        # point / line capillaries: express each as a short segment so the viewer draws them
        vasc["segments"] = _segments_from_point_vessels(world, z_offset)
    rules["vasculature"] = vasc

    rules["drugs"] = []
    for drug, drug_id in DRUG_IDS.items():
        rules["drugs"].append({
            "id": drug_id, "name": drug, "displayName": DRUG_DISPLAY[drug],
            "pk": {"absorptionPerHour": 1.2, "eliminationHalfLifeHours": DRUG_HALF_LIFE_H[drug], "bioavailability": 0.6, "volumeOfDistribution": 1.0},
            "penetration": {"diffusion": 0.1, "uptakePerCell": 0.0015, "relaxSweepsPerTick": 6},
            "arrestThreshold": 0.35
        })

    def cycle_hours(clone_id: str) -> float:
        growth = float(clones[clone_id]["growth_rate_per_day"]["value"]) * (1.0 - float(clones[clone_id]["fitness_cost"]["value"]))
        return round(24.0 * math.log(2) / growth, 2)

    parents = {"T790M": 0, "C797S": 1, "MET_AMP": 0}
    rules["clones"] = []
    for clone_id, cid in CLONE_IDS.items():
        c = clones[clone_id]
        entry = {
            "id": cid, "name": CLONE_LABELS[clone_id], "cycleHours": cycle_hours(clone_id),
            "baselineDeathPerHour": 0.0, "fitnessCost": float(c["fitness_cost"]["value"]), "immuneVisibility": 1.0,
            "drugSensitivity": [
                {"drug": DRUG_IDS[d], "ic50": float(c["drug_response"][d]["value"]) / 1000.0, "hill": float(c["hill_coefficient"]["value"]),
                 "killMaxPerHour": round(float(c["max_drug_death_rate_per_day"]["value"]) / 24.0, 5)}
                for d in DRUG_IDS
            ],
            "provenance": {
                "growth_rate_per_day": c["growth_rate_per_day"], "fitness_cost": c["fitness_cost"],
                "ic50_nM": {d: c["drug_response"][d] for d in DRUG_IDS},
                "max_drug_death_rate_per_day": c["max_drug_death_rate_per_day"],
                "note": "ic50 above is in uM (viewer units); status fields say which values are measured, inferred or assumed"
            }
        }
        if clone_id in parents:
            entry["derivesFrom"] = parents[clone_id]
        rules["clones"].append(entry)

    rules["mutations"] = []
    for i, edge in enumerate(graph):
        rules["mutations"].append({
            "id": i, "name": edge["alteration"].replace("_", " "), "fromClone": CLONE_IDS[edge["from"]], "toClone": CLONE_IDS[edge["to"]],
            "ratePerDivision": float(edge["simulation_probability"]) * float(acfg.mutation_probability_scale),
            "provenance": {"base_probability": edge["simulation_probability"], "status": edge["probability_status"],
                           "demo_scale": acfg.mutation_probability_scale}
        })

    rules["treatment"] = {"schedule": _schedule_entries(runner.history, config.dt), "radiation": []}
    rules.pop("immune", None)
    rules["provenance"] = {
        "engine": "cancer_sim validated engine; this file carries the run's facts in the viewer's vocabulary",
        "timescale": "simulated days follow in-vitro cell-line doubling times (40-100 h); not patient time",
        "biology_source": "data/processed/calibrated_clone_parameters.json and docs/validation/VALIDATION_REPORT.md",
        "unused_blocks": "oxygen/radiation/clearance blocks are the viewer template's stand-in parameters and are not what produced this run"
    }
    return rules


def _segments_from_point_vessels(world, z_offset: int = 0) -> list[dict]:
    """Grid capillaries (points in 2D, z-lines in 3D) as segments the viewer can draw."""
    by_xy: dict[tuple[int, int], list[int]] = {}
    for v in world.vessels:
        by_xy.setdefault((v.x, v.y), []).append(v.z + z_offset)
    segments = []
    for (x, y), zs in sorted(by_xy.items()):
        z0, z1 = min(zs), max(zs)
        if z0 == z1:
            segments.append({"ax": x, "ay": y, "az": z0 - 0.5, "bx": x, "by": y, "bz": z0 + 0.5, "ra": 0.5, "rb": 0.5, "depth": 0, "parent": -1})
        else:
            segments.append({"ax": x, "ay": y, "az": z0, "bx": x, "by": y, "bz": z1, "ra": 0.5, "rb": 0.5, "depth": 0, "parent": -1})
    return segments


def _schedule_entries(history, dt_days: float) -> list[dict]:
    """Treatment markers for the viewer's chart: one entry per contiguous block of a drug."""
    entries = []
    if not history:
        return entries
    start = history[0].time - dt_days
    current = (history[0].drug, history[0].dose)
    for i in range(1, len(history) + 1):
        nxt = (history[i].drug, history[i].dose) if i < len(history) else None
        if nxt != current:
            drug, dose = current
            end = history[i - 1].time
            if drug != "none" and dose > 0:
                days = max(1, int(round(end - start)))
                entries.append({"drug": DRUG_IDS[drug], "startHour": round(start * 24.0, 1), "everyHours": 24.0, "doses": days, "amount": float(dose)})
            start = end
            current = nxt
    return entries
