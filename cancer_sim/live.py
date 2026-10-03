"""A live, two-way simulation session for the 3D viewer.

The viewer connects over a WebSocket, says which cancer and lattice it wants,
and then asks for one simulated day at a time. Each day the session applies
whatever treatment the viewer set (or, in AI mode, what the loaded policy
chooses), steps the calibrated engine through the RL environment so the same
controllability metrics are available, and returns the day's event records,
a keyframe, and a reading in the viewer's vocabulary.

Nothing here changes the physics: it is :class:`CancerTreatmentEnv` with a
schedule the viewer controls, plus the exporter's event translation.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Mapping

from cancer_sim.cancers import CancerModel, load_cancer_model
from cancer_sim.controllability import model_actions
from cancer_sim.experiments import ExperimentConfig
from cancer_sim.iressa_export import (
    ROOT, STATE_FOR_CELL, TEMPLATE_RULES, _controllability_row, build_rules, viewer_ids,
)
from cancer_sim.narration import describe_decision, describe_exposures
from cancer_sim.rl_env import CancerTreatmentEnv, RLConfig
from cancer_sim.simulation import TreatmentAction

import sys
sys.path.insert(0, str(ROOT / "python"))
from iressa_format import NO_DRUG, EventWriter, Keyframe, KeyframeNode, encode_keyframe, ids_by_role  # noqa: E402

PolicyFn = Callable[[CancerTreatmentEnv, dict], int]


@dataclass(frozen=True)
class LiveRequest:
    """What the viewer asks for when it opens a session."""

    cancer: str = "lung_egfr"
    size: int = 32
    depth: int | None = None
    cells: int = 600
    days: float = 120.0
    seed: int = 7
    mutation_scale: float = 50.0
    tick_minutes: float = 30.0
    clone_weights: tuple[float, ...] | None = None
    randomize: bool = False
    eci_min: float = 0.02

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "LiveRequest":
        kw: dict[str, Any] = {}
        for key in ("cancer",):
            if key in data:
                kw[key] = str(data[key])
        for key in ("size", "depth", "cells", "seed"):
            if data.get(key) is not None:
                kw[key] = int(data[key])
        for key in ("days", "mutation_scale", "tick_minutes", "eci_min"):
            if data.get(key) is not None:
                kw[key] = float(data[key])
        if data.get("clone_weights"):
            kw["clone_weights"] = tuple(float(w) for w in data["clone_weights"])
        if "randomize" in data:
            kw["randomize"] = bool(data["randomize"])
        req = cls(**kw)
        if not 8 <= req.size <= 64:
            raise ValueError("size must be between 8 and 64")
        if req.depth is not None and not 1 <= req.depth <= 64:
            raise ValueError("depth must be between 1 and 64")
        if not 10 <= req.cells <= 20000:
            raise ValueError("cells must be between 10 and 20000")
        if not 1 <= req.days <= 730:
            raise ValueError("days must be between 1 and 730")
        return req


@dataclass
class LiveSession:
    """One viewer's running simulation."""

    request: LiveRequest
    policy: PolicyFn | None = None
    policy_name: str = ""
    template_rules: Path = TEMPLATE_RULES
    auto: bool = False
    exposures: dict[str, float] = field(default_factory=dict)
    env: CancerTreatmentEnv = field(init=False)
    info: dict = field(init=False)
    day: int = 0
    ticks_per_day: int = field(init=False)
    no_policy_reason: str | None = None
    _last_exposures: dict[str, float] | None = field(default=None, init=False)
    _finished: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        req = self.request
        depth = req.depth if req.depth is not None else req.size
        experiment = ExperimentConfig(
            cancer=req.cancer, seed=req.seed, width=req.size, height=req.size, depth=depth, cells=req.cells,
            steps=int(round(req.days)), dt=1.0, mutation_scale=req.mutation_scale, clone_weights=req.clone_weights,
            vasculature="tree" if depth > 1 else "grid",
        )
        self.env = CancerTreatmentEnv(RLConfig(
            experiment=experiment, horizon_days=float(req.days), decision_interval_days=1.0,
            eci_min=req.eci_min, randomize=req.randomize, record_events=True, stop_on_progression=False,
        ))
        observation, self.info = self.env.reset(seed=req.seed)
        self.env.last_observation = observation
        self.ticks_per_day = int(round(24.0 * 60.0 / req.tick_minutes))
        self.template = json.load(open(self.template_rules))
        self._translator = _Translator(self.env, self.template)
        self._actions = model_actions(self.model)
        self._concentrations = {d: self.automata.reference_concentration_nm(d) for d in self.model.drug_ids}

    # ---- identity ------------------------------------------------------------
    @property
    def model(self) -> CancerModel:
        return self.env.model

    @property
    def runner(self):
        return self.env.runner

    @property
    def automata(self):
        return self.runner.automata

    @property
    def finished(self) -> bool:
        return self._finished or self.day >= self.env.max_steps

    # ---- what the viewer needs to start --------------------------------------
    def rules(self) -> dict:
        """The viewer's rules.json for this session, with the live session described in provenance."""
        config = replace(self.env.config.experiment, steps=self.env.max_steps, dt=1.0)
        rules = build_rules(self.template, config, self.runner, self.request.tick_minutes, self.ticks_per_day,
                            1, None, self._translator.nz, self._translator.z_offset)
        rules["provenance"]["controllability"] = self.reading(None)
        rules["provenance"]["live"] = {
            "mode": "two-way", "policy": self.policy_name or None, "auto": self.auto,
            "note": "A live session: the viewer sets the treatment each simulated day, or lets the policy choose.",
        }
        if self.policy is not None:
            rules["provenance"]["policy"] = {
                "name": self.policy_name, "training_cancer": self.model.id, "training_cancer_name": self.model.name,
                "training_uncertainty": "see the policy's training run", "objective": "maximise durable controllability",
                "actions": len(self.env.action_table), "note": "An explanation of simulator-policy behaviour, not a clinical rationale.",
            }
        # the treatment schedule is unknown in advance; the viewer draws it from the readings
        rules["treatment"] = {"schedule": [], "radiation": []}
        return rules

    def presets(self) -> list[dict]:
        """Treatment presets from the model's schedules: the first combination each one gives."""
        seen: list[dict] = []
        for name, spec in self.model.schedules.items():
            agents = None
            for key in ("agents", "first"):
                if key in spec:
                    agents = spec[key]
                    break
            if agents is None and "drug" in spec:
                agents = {spec["drug"]: 1.0}
            if agents is None:
                continue
            exposures = {str(k): float(v) for k, v in dict(agents).items()}
            if any(p["exposures"] == exposures for p in seen):
                continue
            seen.append({"id": name, "label": describe_exposures(self.model, exposures), "exposures": exposures})
        seen.insert(0, {"id": "none", "label": "no treatment", "exposures": {}})
        return seen

    def hello(self) -> dict:
        return {
            "type": "hello",
            "cancer": {"id": self.model.id, "name": self.model.name},
            "drugs": [{"id": d.id, "label": d.label, "exposure": d.exposure, "mechanism": d.mechanism} for d in self.model.drugs],
            "presets": self.presets(),
            "policy": self.policy_name or None,
            "no_policy_reason": None if self.policy else self.no_policy_reason,
            "auto": self.auto,
            "exposures": dict(self.exposures),
            "days": self.env.max_steps,
            "ticks_per_day": self.ticks_per_day,
            "rules": self.rules(),
        }

    def keyframe(self) -> bytes:
        return self._translator.keyframe(self.day * self.ticks_per_day + (1 if self.day else 0))

    # ---- control -------------------------------------------------------------
    def set_exposures(self, exposures: Mapping[str, float]) -> dict[str, float]:
        clean: dict[str, float] = {}
        for drug, value in exposures.items():
            if not self.model.has_drug(str(drug)):
                raise ValueError(f"unknown drug {drug!r}")
            level = float(value)
            if not 0.0 <= level <= 1.5:
                raise ValueError("exposure must be between 0 and 1.5")
            if level > 0:
                clean[str(drug)] = level
        self.exposures = clean
        return dict(clean)

    def set_auto(self, auto: bool) -> bool:
        if auto and self.policy is None:
            raise ValueError("no policy is loaded for this session")
        self.auto = bool(auto)
        return self.auto

    # ---- one simulated day ---------------------------------------------------
    def advance(self) -> dict[str, Any]:
        """Apply today's treatment, step one day, and return the viewer's frames and reading."""
        if self.finished:
            return {"events": [], "keyframe": None, "reading": None, "done": True}
        if self.auto and self.policy is not None:
            index = int(self.policy(self.env, self.info))
            action = self.env.action_table[index]
            actor = self.policy_name or "AI"
        else:
            action = TreatmentAction.combination(self.exposures)
            actor = ""
        before = self._last_exposures
        observation, reward, terminated, truncated, self.info = self.env.step_action(action)
        self.env.last_observation = observation
        self.day += 1
        tick = self.day * self.ticks_per_day
        frames = self._translator.translate(self.automata.events, tick)
        record = self.runner.history[-1]
        reading = self.reading(record)
        reading["label"] = describe_decision(
            self.model, before, action.exposures, resistant_fraction=self.info["resistant_fraction"], day=float(self.day), actor=actor,
        )
        reading["action"] = describe_exposures(self.model, action.exposures)
        reading["resistant_fraction"] = round(float(self.info["resistant_fraction"]), 4)
        reading["reward"] = round(float(reward), 4)
        reading["auto"] = self.auto
        # The RL episode may "end" (progression, or the controllability index under
        # its cut-off); a live session keeps going to its horizon so the viewer can
        # change course. The flag is reported, not acted on.
        reading["control_lost"] = bool(terminated)
        self._last_exposures = dict(action.exposures)
        if truncated:
            self._finished = True
        return {"events": frames, "keyframe": self._translator.keyframe(tick + 1), "reading": reading, "done": self.finished}

    def reading(self, record) -> dict:
        row = _controllability_row(self.runner, record, float(self.day), self._actions, self._concentrations)
        row["day"] = float(self.day)
        return row


class _Translator:
    """The exporter's event translation, for a running session."""

    def __init__(self, env: CancerTreatmentEnv, template: dict) -> None:
        self.world = env.runner.automata.world
        model = env.model
        self.clone_ids, self.drug_ids = viewer_ids(model)
        self.cause = ids_by_role(template, "causes")
        state = ids_by_role(template, "states")
        self.state_code = {k: state[v] for k, v in STATE_FOR_CELL.items()}
        depth = self.world.config.depth
        self.nz = depth if depth > 1 else 3
        self.z_offset = 0 if depth > 1 else 1
        self.plane = self.world.config.width * self.world.config.height

    def node_of(self, node: int) -> int:
        return node + self.z_offset * self.plane

    def keyframe(self, tick: int) -> bytes:
        world = self.world

        def node_cause(cell) -> int:
            if cell.state != "necrotic":
                return self.cause["normalCycle"]
            return self.cause["hypoxicNecrosis"] if cell.death_cause == "hypoxia" else self.cause["drugApoptosis"]

        nodes = [
            KeyframeNode(node=self.node_of(world.config.node_index(x, y, z)), clone=self.clone_ids[cell.clone_id],
                         state=self.state_code[cell.state], cause=node_cause(cell))
            for (x, y, z), cell in sorted(world._cells.items(), key=lambda kv: (kv[0][2], kv[0][1], kv[0][0]))
        ]
        return encode_keyframe(Keyframe(tick=tick, nx=world.config.width, ny=world.config.height, nz=self.nz, nodes=nodes))

    def translate(self, events, tick: int) -> list[bytes]:
        """The day's engine events as event-record frames, one frame per tick (all carry ``tick``)."""
        writer = EventWriter()
        c, ids, drugs, state = self.cause, self.clone_ids, self.drug_ids, self.state_code
        for event in events:
            kind = event[0]
            if kind == "divide":
                _, parent, daughter, clone = event
                writer.divide(tick, c["normalCycle"], ids[clone], self.node_of(parent), self.node_of(daughter))
            elif kind == "mutate":
                _, node, old, new = event
                writer.mutate(tick, c["mutation"], ids[old], self.node_of(node), ids[new])
            elif kind == "death":
                _, node, role, drug, clone = event
                writer.death_start(tick, c[role], ids[clone], self.node_of(node), NO_DRUG if drug is None else drugs[drug])
            elif kind == "removed":
                _, node, role, drug, clone = event
                writer.removed(tick, c[role], ids[clone], self.node_of(node), NO_DRUG if drug is None else drugs[drug])
            elif kind == "state":
                _, node, new_state, role, clone = event
                writer.state_change(tick, c[role], ids[clone], self.node_of(node), state[new_state], NO_DRUG)
        data = writer.bytes()
        return [data] if data else []


def load_policy(path: str | Path | None) -> tuple[PolicyFn | None, str]:
    if not path:
        return None, ""
    from stable_baselines3 import PPO
    from cancer_sim.rl_eval import ppo_policy
    return ppo_policy(PPO.load(str(path))), f"PPO ({Path(path).stem})"


class PolicyLibrary:
    """Finds the trained policy for a session's cancer and loads it once.

    Looks for ``outputs/rl/ppo_<cancer>.zip`` (what the training panel writes),
    then the older fixed paths, then an explicit ``--policy``. A file that has
    changed on disk is reloaded, so a policy trained while the server runs
    becomes the AI of the next session. A policy whose action or observation
    space does not match the session (another cancer's) is skipped.
    """

    def __init__(self, root: Path = ROOT, explicit: Path | None = None) -> None:
        self.root = root
        self.explicit = explicit
        self._cache: dict[Path, tuple[float, Any]] = {}

    def candidates(self, cancer: str) -> list[Path]:
        paths = [self.root / "outputs" / "rl" / f"ppo_{cancer}.zip"]
        if cancer == "breast_er_her2neg":
            paths.append(self.root / "outputs" / "rl_breast" / "ppo_breast.zip")
        if cancer == "lung_egfr":
            paths.append(self.root / "outputs" / "rl" / "ppo_iressa.zip")
        if self.explicit:
            paths.append(Path(self.explicit))
        return paths

    def _load(self, path: Path):
        mtime = path.stat().st_mtime
        cached = self._cache.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        from stable_baselines3 import PPO
        model = PPO.load(str(path), device="cpu")
        self._cache[path] = (mtime, model)
        return model

    def for_session(self, env: CancerTreatmentEnv) -> tuple[PolicyFn | None, str, str | None]:
        """(policy, display name, why none) for this session's environment."""
        from cancer_sim.rl_eval import ppo_policy
        skipped = []
        for path in self.candidates(env.model.id):
            if not path.exists():
                continue
            try:
                model = self._load(path)
            except Exception as exc:  # a corrupt or incompatible file must not stop the session
                skipped.append(f"{path.name}: {exc}")
                continue
            actions = getattr(model.action_space, "n", None)
            shape = tuple(getattr(model.observation_space, "shape", ()) or ())
            if actions != len(env.action_table) or shape != (len(env.observation_names),):
                skipped.append(f"{path.name} was trained for another action set")
                continue
            return ppo_policy(model), f"PPO ({path.stem})", None
        return None, "", "; ".join(skipped) or "no trained policy for this cancer yet"
