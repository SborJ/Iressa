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
from cancer_sim.cancers import CancerModel, load_cancer_model  # noqa: E402
from cancer_sim.controllability import evaluate_tumor_controllability, model_actions  # noqa: E402
from cancer_sim.experiments import ExperimentConfig, build_runner  # noqa: E402
from cancer_sim.simulation import TreatmentAction, write_history_csv  # noqa: E402
from cancer_sim.vasculature import DEFAULT_SPEC  # noqa: E402

TEMPLATE_RULES = ROOT / "data" / "rules.json"
RUNS_DIR = ROOT / "data" / "runs"

# The default (lung) model's viewer ids, kept for callers that import them. The
# exporter derives the ids for whichever cancer model the run uses.
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


def viewer_ids(model: CancerModel) -> tuple[dict[str, int], dict[str, int]]:
    """Viewer clone and drug ids for a model: positions in its clone and drug lists."""
    return (
        {clone_id: index for index, clone_id in enumerate(model.clone_ids)},
        {drug_id: index for index, drug_id in enumerate(model.drug_ids)},
    )
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
    model = automata.model
    clone_ids, drug_ids = viewer_ids(model)

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
            KeyframeNode(node=node_of(world.config.node_index(x, y, z)), clone=clone_ids[cell.clone_id],
                         state=state_code[cell.state], cause=node_cause(cell))
            for (x, y, z), cell in sorted(world._cells.items(), key=lambda kv: (kv[0][2], kv[0][1], kv[0][0]))
        ]
        return encode_keyframe(Keyframe(tick=tick, nx=world.config.width, ny=world.config.height, nz=nz, nodes=nodes))

    recording = _record(
        runner, steps=config.steps, dt=config.dt, ticks_per_step=ticks_per_step, keyframe_every_steps=keyframe_every_steps,
        keyframe=keyframe, node_of=node_of, cause=cause, state_code=state_code, clone_ids=clone_ids, drug_ids=drug_ids,
        advance=lambda step: runner.step(dt=config.dt, step_number=step), progress=progress,
    )
    return _write_recording(out, name, schedule, config, runner, recording, template, tick_minutes, ticks_per_step,
                            keyframe_every_steps, vasculature_spec, nz, z_offset, policy=None)


def _record(runner, *, steps, dt, ticks_per_step, keyframe_every_steps, keyframe, node_of, cause, state_code,
            clone_ids, drug_ids, advance, progress=None) -> dict[str, Any]:
    """Advance the run with ``advance(step)`` and translate the engine's event log
    into the viewer's records, with one keyframe per day and one controllability
    reading per keyframe (the metrics the panels show over time)."""
    automata = runner.automata
    model = automata.model
    actions = model_actions(model)
    concentrations = {d: automata.reference_concentration_nm(d) for d in model.drug_ids}
    writer = EventWriter()
    keyframes = [keyframe(0)]
    counts = {"divide": 0, "mutate": 0, "death": 0, "removed": 0, "state": 0}
    metrics = [_controllability_row(runner, None, 0.0, actions, concentrations)]
    for step in range(1, steps + 1):
        advance(step)
        tick = step * ticks_per_step
        for event in automata.events:
            kind = event[0]
            counts[kind] += 1
            if kind == "divide":
                _, parent, daughter, clone = event
                writer.divide(tick, cause["normalCycle"], clone_ids[clone], node_of(parent), node_of(daughter))
            elif kind == "mutate":
                _, node, old, new = event
                writer.mutate(tick, cause["mutation"], clone_ids[old], node_of(node), clone_ids[new])
            elif kind == "death":
                _, node, role, drug, clone = event
                writer.death_start(tick, cause[role], clone_ids[clone], node_of(node), NO_DRUG if drug is None else drug_ids[drug])
            elif kind == "removed":
                _, node, role, drug, clone = event
                writer.removed(tick, cause[role], clone_ids[clone], node_of(node), NO_DRUG if drug is None else drug_ids[drug])
            elif kind == "state":
                _, node, new_state, role, clone = event
                writer.state_change(tick, cause[role], clone_ids[clone], node_of(node), state_code[new_state], NO_DRUG)
        if step % keyframe_every_steps == 0:
            keyframes.append(keyframe(tick + 1))      # a tick with no events: state after this step
            record = runner.history[-1]
            metrics.append(_controllability_row(runner, record, record.time, actions, concentrations))
        if progress and (step % 10 == 0 or step == steps):
            progress(step, steps, runner.history[-1])
    return {"writer": writer, "keyframes": keyframes, "counts": counts, "metrics": metrics}


def _controllability_row(runner, record, day: float, actions, concentrations) -> dict[str, Any]:
    automata = runner.automata
    current = None if record is None else TreatmentAction.combination(record.exposures)
    control = evaluate_tumor_controllability(
        record=record, initial_burden=max(1, runner.initial_burden), clone_responses=automata.clone_responses,
        transitions=automata.transitions, allowed_actions=actions, vessel_concentration_nm=concentrations,
        clone_ids=automata.model.clone_ids, current_action=current, establishment_base=automata.establishment_base,
    )
    clone_ids, _ = viewer_ids(automata.model)
    return {
        "day": round(day, 3),
        "eci": round(control.eci, 4),
        "exposures": {} if record is None else dict(record.exposures),
        "clones": {
            str(clone_ids[c]): {
                "count": item.count, "margin": round(item.margin, 4), "net_growth": round(item.best_net_growth_rate, 4),
                "escape_distance": None if item.escape_distance == float("inf") else round(item.escape_distance, 3),
                "exhausted": item.treatment_exhausted, "best_action": item.best_action.label,
                "best_exposures": item.best_action.exposures,
            }
            for c, item in control.clones.items()
        },
    }


def _write_recording(out, name, schedule, config, runner, recording, template, tick_minutes, ticks_per_step,
                     keyframe_every_steps, vasculature_spec, nz, z_offset, policy: dict | None) -> dict[str, Any]:
    model = runner.automata.model
    writer, keyframes, counts = recording["writer"], recording["keyframes"], recording["counts"]
    (out / "run.events").write_bytes(writer.bytes())
    (out / "run.keyframes").write_bytes(b"".join(keyframes))
    write_history_csv(out / "history.csv", runner.history)
    (out / "metrics.json").write_text(json.dumps({
        "note": "Per-day evolutionary-control readings of this recorded run: the controllability index proxy, and per clone "
                "the control margin M_i (best represented action's negative net growth), the escape distance D_i under the "
                "treatment given that day, and the best represented action. Model-scoped; not clinical quantities.",
        "clone_ids": {c: i for c, i in viewer_ids(model)[0].items()},
        "rows": recording["metrics"],
    }, indent=1) + "\n")

    rules = build_rules(template, config, runner, tick_minutes, ticks_per_step, keyframe_every_steps, vasculature_spec, nz, z_offset)
    rules["provenance"]["controllability"] = recording["metrics"][0]
    if policy:
        rules["provenance"]["policy"] = policy
    else:
        rules["provenance"]["strategy"] = {"schedule": schedule, "declared_in": f"cancer_sim/cancers/{model.id}.json",
                                           "spec": model.schedules.get(schedule, {})}
    (out / "rules.json").write_text(json.dumps(rules, indent=2) + "\n")

    rel = out.relative_to(ROOT / "data") if (ROOT / "data") in out.parents else out
    url = f"/?source=file&rules=/{rel}/rules.json&events=/{rel}/run.events&keyframes=/{rel}/run.keyframes"
    summary = {
        "name": name, "schedule": schedule, "config": {k: (list(v) if isinstance(v, tuple) else v) for k, v in config.__dict__.items()},
        "ticks_per_step": ticks_per_step, "tick_minutes": tick_minutes, "events": len(writer), "event_counts": counts,
        "keyframes": len(keyframes), "final_burden": runner.history[-1].burden,
        "final_clones": runner.clone_counts(), "viewer_url": url,
        "cancer": model.id, "cancer_name": model.name, "policy": policy,
        "engine": "cancer_sim (validated 2D rules extended to 3D; see docs/validation)",
        "disclaimer": "Educational/research simulation on an in-vitro growth timescale; not a clinical prediction."
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


def export_policy_run(
    rl_config,
    policy,
    *,
    policy_name: str,
    name: str,
    seed: int | None = None,
    out_root: Path = RUNS_DIR,
    tick_minutes: float = 30.0,
    keyframe_every_days: float = 1.0,
    template_rules: Path = TEMPLATE_RULES,
    vasculature_spec: dict | None = None,
    objective: str = "maximise durable controllability: controlled days, low burden and resistant fraction, modest dosing, improving ECI",
    trained_randomized: bool | None = None,
    progress=None,
) -> dict[str, Any]:
    """Record a run driven by an RL policy (``policy(env, info) -> action index``)
    through :class:`cancer_sim.rl_env.CancerTreatmentEnv`, in the same format as
    :func:`export_run`, with the policy's identity in ``rules.json`` and the
    decision each day in ``metrics.json``."""
    from dataclasses import replace as _replace
    from cancer_sim.rl_env import CancerTreatmentEnv

    out = out_root / name
    out.mkdir(parents=True, exist_ok=True)
    template = json.load(open(template_rules))
    config = rl_config.experiment
    dt = rl_config.decision_interval_days
    ticks_per_day = 24.0 * 60.0 / tick_minutes
    ticks_per_step = dt * ticks_per_day
    if abs(ticks_per_step - round(ticks_per_step)) > 1e-9 or ticks_per_step < 1:
        raise ValueError(f"decision interval {dt} days is not a whole number of {tick_minutes}-minute ticks")
    ticks_per_step = int(round(ticks_per_step))
    keyframe_every_steps = max(1, int(round(keyframe_every_days / dt)))
    if vasculature_spec:
        config = _replace(config, vasculature_trunks=int(vasculature_spec.get("trunks", config.vasculature_trunks)),
                          vasculature_max_depth=int(vasculature_spec.get("maxDepth", config.vasculature_max_depth)))
    env = CancerTreatmentEnv(_replace(rl_config, experiment=config, record_events=True))
    observation, info = env.reset(seed=seed)
    env.last_observation = observation
    runner = env._runner
    automata = runner.automata
    world = automata.world
    model = automata.model
    clone_ids, drug_ids = viewer_ids(model)
    cause = ids_by_role(template, "causes")
    state = ids_by_role(template, "states")
    state_code = {k: state[v] for k, v in STATE_FOR_CELL.items()}
    nz = world.config.depth if world.config.depth > 1 else 3
    z_offset = 0 if world.config.depth > 1 else 1
    plane = world.config.width * world.config.height
    node_of = lambda engine_node: engine_node + z_offset * plane

    def node_cause(cell) -> int:
        if cell.state != "necrotic":
            return cause["normalCycle"]
        return cause["hypoxicNecrosis"] if cell.death_cause == "hypoxia" else cause["drugApoptosis"]

    def keyframe(tick: int) -> bytes:
        nodes = [
            KeyframeNode(node=node_of(world.config.node_index(x, y, z)), clone=clone_ids[cell.clone_id],
                         state=state_code[cell.state], cause=node_cause(cell))
            for (x, y, z), cell in sorted(world._cells.items(), key=lambda kv: (kv[0][2], kv[0][1], kv[0][0]))
        ]
        return encode_keyframe(Keyframe(tick=tick, nx=world.config.width, ny=world.config.height, nz=nz, nodes=nodes))

    decisions: list[dict] = []
    done = {"flag": False}

    def advance(step: int) -> None:
        nonlocal observation, info
        if done["flag"]:
            # the episode ended (progression / exhaustion): keep recording untreated days so the run is complete
            env._schedule.set(TreatmentAction("none", 0.0))
            runner.step(dt=dt, step_number=step)
            decisions.append({"day": runner.history[-1].time, "action": "none", "episode_over": True})
            return
        action = policy(env, info)
        observation, reward, terminated, truncated, info = env.step(int(action))
        env.last_observation = observation
        decisions.append({"day": info["time_days"], "action": env.action_table[int(action)].label,
                          "exposures": env.action_table[int(action)].exposures, "reward": round(float(reward), 4),
                          "eci": round(info["eci"], 4), "resistant_fraction": round(info["resistant_fraction"], 4)})
        if terminated or truncated:
            done["flag"] = True

    recording = _record(
        runner, steps=env.max_steps, dt=dt, ticks_per_step=ticks_per_step, keyframe_every_steps=keyframe_every_steps,
        keyframe=keyframe, node_of=node_of, cause=cause, state_code=state_code, clone_ids=clone_ids, drug_ids=drug_ids,
        advance=advance, progress=progress,
    )
    recording["metrics"] = _merge_decisions(recording["metrics"], decisions)
    policy_record = {
        "name": policy_name, "training_cancer": model.id, "training_cancer_name": model.name,
        "training_uncertainty": "domain randomised" if (rl_config.randomize if trained_randomized is None else trained_randomized) else "fixed nominal biology",
        "episode_biology": "domain-randomised draw" if rl_config.randomize else "nominal parameters",
        "objective": objective, "decision_interval_days": dt, "horizon_days": rl_config.horizon_days,
        "actions": len(env.action_table), "randomization_draw": dict(info.get("randomization") or {}),
        "note": "An explanation of simulator-policy behaviour, not a clinical rationale.",
    }
    summary = _write_recording(out, name, f"policy:{policy_name}", _replace(config, steps=env.max_steps, dt=dt), runner, recording,
                               template, tick_minutes, ticks_per_step, keyframe_every_steps, vasculature_spec, nz, z_offset, policy=policy_record)
    (out / "decisions.json").write_text(json.dumps(decisions, indent=1) + "\n")
    return summary


def _merge_decisions(metrics: list[dict], decisions: list[dict]) -> list[dict]:
    by_day = {round(float(d["day"]), 3): d for d in decisions}
    for row in metrics:
        decision = by_day.get(round(float(row["day"]), 3))
        if decision:
            row["action"] = decision.get("action")
            row["reward"] = decision.get("reward")
            row["resistant_fraction"] = decision.get("resistant_fraction")
    return metrics


def build_rules(template: dict, config: ExperimentConfig, runner, tick_minutes: float, ticks_per_step: int,
                keyframe_every_steps: int, vasculature_spec: dict | None, nz: int | None = None, z_offset: int = 0) -> dict:
    """The viewer's rules.json for this run: its own vocabulary, our run's facts."""
    model = runner.automata.model
    clone_ids, drug_ids = viewer_ids(model)
    clones = clone_parameter_records(model)
    graph = resistance_graph_records(model, runner.automata.transitions)
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
    for drug, drug_id in drug_ids.items():
        spec = model.drug(drug)
        rules["drugs"].append({
            "id": drug_id, "name": drug, "displayName": spec.label,
            "pk": {"absorptionPerHour": 1.2, "eliminationHalfLifeHours": spec.half_life_hours, "bioavailability": 0.6, "volumeOfDistribution": 1.0},
            "penetration": {"diffusion": 0.1, "uptakePerCell": 0.0015, "relaxSweepsPerTick": 6},
            "arrestThreshold": 0.35
        })

    def cycle_hours(clone_id: str) -> float:
        growth = float(clones[clone_id]["growth_rate_per_day"]["value"]) * (1.0 - float(clones[clone_id]["fitness_cost"]["value"]))
        return round(24.0 * math.log(2) / growth, 2)

    def viewer_ic50(drug: str, value: float) -> float:
        # nM -> uM for diffusing drugs; a global agent's normalised level is kept as is
        return value / 1000.0 if model.drug(drug).diffusing else value

    rules["clones"] = []
    for clone_id, cid in clone_ids.items():
        c = clones[clone_id]
        spec = model.clone(clone_id)
        entry = {
            "id": cid, "name": spec.label, "cycleHours": cycle_hours(clone_id),
            "baselineDeathPerHour": 0.0, "fitnessCost": float(c["fitness_cost"]["value"]), "immuneVisibility": 1.0,
            "drugSensitivity": [
                {"drug": drug_ids[d], "ic50": viewer_ic50(d, float(c["drug_response"][d]["value"])),
                 "hill": float(c["drug_response"][d].get("hill", c["hill_coefficient"])["value"]),
                 "killMaxPerHour": round(float(c["drug_response"][d].get("max_death_rate_per_day", c["max_drug_death_rate_per_day"])["value"]) / 24.0, 5)}
                for d in drug_ids if d in c["drug_response"]
            ],
            "provenance": {
                "growth_rate_per_day": c["growth_rate_per_day"], "fitness_cost": c["fitness_cost"],
                "ic50_nM": {d: c["drug_response"][d] for d in drug_ids if d in c["drug_response"]},
                "max_drug_death_rate_per_day": c["max_drug_death_rate_per_day"],
                "note": "ic50 above is in uM (viewer units) for diffusing drugs; status/evidence fields say which values are measured, derived, inferred or assumed"
            }
        }
        if spec.parent is not None:
            entry["derivesFrom"] = clone_ids[spec.parent]
        rules["clones"].append(entry)

    rules["mutations"] = []
    for i, edge in enumerate(graph):
        rules["mutations"].append({
            "id": i, "name": edge["alteration"].replace("_", " "), "fromClone": clone_ids[edge["from"]], "toClone": clone_ids[edge["to"]],
            "ratePerDivision": float(edge["simulation_probability"]) * float(acfg.mutation_probability_scale),
            "provenance": {"base_probability": edge["simulation_probability"], "status": edge["probability_status"],
                           "demo_scale": acfg.mutation_probability_scale}
        })

    rules["treatment"] = {"schedule": _schedule_entries(runner.history, config.dt, drug_ids), "radiation": []}
    rules.pop("immune", None)
    rules["provenance"] = {
        "engine": "cancer_sim validated engine; this file carries the run's facts in the viewer's vocabulary",
        "cancer": {"id": model.id, "name": model.name, "description": model.description,
                   "model_file": f"cancer_sim/cancers/{model.id}.json"},
        "timescale": "simulated days follow in-vitro cell-line doubling times (40-100 h); not patient time",
        "biology_source": _biology_source(model),
        "unused_blocks": "oxygen/radiation/clearance blocks are the viewer template's stand-in parameters and are not what produced this run"
    }
    return rules


def _biology_source(model: CancerModel) -> str:
    if model.parameters.get("source") == "inline":
        return f"cancer_sim/cancers/{model.id}.json (inline parameters with evidence levels)"
    return "data/processed/calibrated_clone_parameters.json and docs/validation/VALIDATION_REPORT.md"


def clone_parameter_records(model: CancerModel) -> dict[str, dict]:
    """Per-clone parameter records with provenance, in the calibrated-file layout
    (``growth_rate_per_day``, ``fitness_cost``, ``hill_coefficient``,
    ``max_drug_death_rate_per_day``, ``drug_response[drug] -> {value, ...}``)."""
    source = model.parameters.get("source", "calibrated_files")
    if source != "inline":
        path = model.path("clones") if "clones" in model.parameters else DEFAULT_CALIBRATED_CLONE_DATA
        return {c["clone_id"]: c for c in json.load(open(path))}
    records: dict[str, dict] = {}
    for clone in model.parameters["clones"]:
        response = {}
        for drug, entry in clone["drug_response"].items():
            record = dict(entry["ic50"])
            record.setdefault("status", record.get("evidence", "assumed").lower())
            for key in ("hill", "max_death_rate_per_day", "growth_inhibition"):
                if key in entry:
                    record[key] = entry[key]
            response[drug] = record
        records[clone["id"]] = {
            "clone_id": clone["id"], "label": model.clone(clone["id"]).label,
            "growth_rate_per_day": clone["growth_rate_per_day"], "fitness_cost": clone.get("fitness_cost", {"value": 0.0}),
            "hill_coefficient": clone.get("hill_coefficient", {"value": 1.2}),
            "max_drug_death_rate_per_day": clone.get("max_drug_death_rate_per_day", {"value": 0.18}),
            "drug_response": response, "allowed_transitions": list(clone.get("allowed_transitions", [])),
        }
    return records


def resistance_graph_records(model: CancerModel, transitions) -> list[dict]:
    """Edges with ``from``/``to``/``alteration``/``simulation_probability``/``probability_status``."""
    source = model.parameters.get("source", "calibrated_files")
    if source != "inline":
        path = model.path("resistance_graph") if "resistance_graph" in model.parameters else DEFAULT_RESISTANCE_GRAPH
        return json.load(open(path))
    edges = []
    for edge in model.parameters.get("transitions", []):
        probability = edge["simulation_probability"]
        edges.append({
            "from": edge["from"], "to": edge["to"], "alteration": edge.get("alteration", f"{edge['from']}->{edge['to']}"),
            "simulation_probability": float(probability["value"] if isinstance(probability, dict) else probability),
            "probability_status": str(probability.get("evidence", "assumed")).lower() if isinstance(probability, dict) else "assumed",
            "evidence": probability if isinstance(probability, dict) else None,
        })
    return edges


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


def _schedule_entries(history, dt_days: float, drug_ids: dict[str, int] | None = None) -> list[dict]:
    """Treatment markers for the viewer's chart: one entry per contiguous block of each
    drug's exposure, so a combination yields one marker series per agent."""
    drug_ids = DRUG_IDS if drug_ids is None else drug_ids
    entries: list[dict] = []
    if not history:
        return entries
    for drug, drug_id in drug_ids.items():
        start = history[0].time - dt_days
        current = float(history[0].exposures.get(drug, 0.0))
        for i in range(1, len(history) + 1):
            nxt = float(history[i].exposures.get(drug, 0.0)) if i < len(history) else None
            if nxt != current:
                end = history[i - 1].time
                if current > 0:
                    days = max(1, int(round(end - start)))
                    entries.append({"drug": drug_id, "startHour": round(start * 24.0, 1), "everyHours": 24.0, "doses": days, "amount": current})
                start = end
                current = nxt if nxt is not None else 0.0
    entries.sort(key=lambda e: (e["startHour"], e["drug"]))
    return entries
