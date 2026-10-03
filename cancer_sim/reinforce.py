"""A lightweight REINFORCE trainer for treatment patterns.

Small enough to train in under a minute and simple enough to read:

* **actions**: a handful of clinically shaped regimens per cancer
  (``reinforce_actions`` in the model file), chosen every few days;
* **policy**: a linear softmax over a few scale-free features (tumour size
  relative to the start, the resistant share, each resistant clone's share,
  time, and the previous regimen), so the learned weights can be read;
* **episodes**: the calibrated engine run directly through the simulation
  runner, without the RL environment's per-day controllability metrics,
  which dominate its cost;
* **training**: REINFORCE with a per-decision baseline, normalised advantages,
  an entropy bonus and Adam, on episodes simulated in parallel processes, with
  the uncertain biology redrawn every episode when the model declares a range;
* **evaluation**: the greedy policy against the model's own fixed strategies
  and against every regimen held constant, on held-out seeds, with the same
  metrics, and the learned pattern narrated in words.

Research simulation only. A learned pattern is what keeps *this model's*
simulated tumour controllable with *these* represented drugs; it is not a
treatment recommendation.
"""

from __future__ import annotations

import json
import math
import random
import statistics
import time
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

import numpy as np

from cancer_sim.cancers import CancerModel, load_cancer_model
from cancer_sim.experiments import ExperimentConfig, build_runner
from cancer_sim.narration import describe_decision, describe_exposures
from cancer_sim.simulation import TreatmentAction, build_schedule

PROGRESSION = 1.2   # burden at or above this multiple of the start counts as loss of control


# ------------------------------------------------------------------ configuration
@dataclass(frozen=True)
class ReinforceConfig:
    cancer: str = "breast_er_her2neg"
    days: int = 60
    decision_days: int = 10
    width: int = 40
    height: int = 30
    depth: int = 1
    cells: int = 250
    mutation_scale: float = 50.0
    randomize: bool = True
    seconds: float = 45.0
    batch: int = 24
    repeats: int = 3          # rollouts per simulated tumour in a batch; their mean is the baseline
    learning_rate: float = 0.15
    entropy: float = 0.01
    dose_weight: float = 0.05
    resistance_weight: float = 0.5
    switch_weight: float = 0.05
    workers: int = 8
    seed: int = 7
    eval_seeds: tuple[int, ...] = (9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008)

    @property
    def model(self) -> CancerModel:
        return load_cancer_model(self.cancer)

    def experiment(self, seed: int) -> ExperimentConfig:
        return ExperimentConfig(
            cancer=self.cancer, seed=seed, width=self.width, height=self.height, depth=self.depth,
            cells=self.cells, steps=self.days, dt=1.0, mutation_scale=self.mutation_scale,
            vasculature="tree" if self.depth > 1 else "grid",
        )


def action_set(model: CancerModel) -> list[dict[str, float]]:
    """The regimens the policy chooses between: the model's ``reinforce_actions``,
    or, failing that, no treatment plus the first regimen of each declared schedule."""
    declared = model.raw.get("reinforce_actions")
    if declared:
        return [{str(k): float(v) for k, v in dict(a).items() if float(v) > 0} for a in declared]
    out: list[dict[str, float]] = [{}]
    for spec in model.schedules.values():
        agents = spec.get("agents") or spec.get("first") or ({spec["drug"]: 1.0} if "drug" in spec else None)
        if agents:
            exposures = {str(k): float(v) for k, v in dict(agents).items()}
            if exposures not in out:
                out.append(exposures)
    return out


# ------------------------------------------------------------------ the policy
def feature_names(model: CancerModel, k: int) -> list[str]:
    return (["bias", "size_change", "log_size", "resistant_share"]
            + [f"share_{c}" for c in model.resistant_clones] + ["time"]
            + [f"previous_{i}" for i in range(k)])


def features(model: CancerModel, *, day: float, horizon: float, burden: int, initial: int,
             counts: Mapping[str, int], previous: int | None, k: int) -> np.ndarray:
    ratio = burden / max(1, initial)
    living = max(1, burden)
    shares = [counts.get(c, 0) / living for c in model.resistant_clones]
    prev = [0.0] * k
    if previous is not None:
        prev[previous] = 1.0
    return np.array([1.0, ratio - 1.0, math.log(max(ratio, 1e-3)), sum(shares), *shares, day / horizon, *prev], dtype=float)


def softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


@dataclass
class LinearPolicy:
    """logits = phi . W; one column per regimen."""

    weights: np.ndarray
    actions: list[dict[str, float]]
    feature_names: list[str]
    decision_days: int
    cancer: str

    def probabilities(self, phi: np.ndarray) -> np.ndarray:
        return softmax(phi @ self.weights)

    def choose(self, phi: np.ndarray, rng: random.Random | None = None) -> int:
        p = self.probabilities(phi)
        if rng is None:
            return int(np.argmax(p))
        return int(np.searchsorted(np.cumsum(p), rng.random() * p.sum()).clip(0, len(p) - 1))

    def to_json(self) -> dict:
        return {"algorithm": "REINFORCE", "cancer": self.cancer, "decision_days": self.decision_days,
                "actions": self.actions, "feature_names": self.feature_names, "weights": self.weights.tolist()}

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> "LinearPolicy":
        return cls(weights=np.array(data["weights"], dtype=float), actions=[dict(a) for a in data["actions"]],
                   feature_names=list(data["feature_names"]), decision_days=int(data["decision_days"]),
                   cancer=str(data["cancer"]))

    @classmethod
    def load(cls, path: str | Path) -> "LinearPolicy":
        return cls.from_json(json.loads(Path(path).read_text()))


class PolicySchedule:
    """The policy as a treatment schedule the simulation runner (and the exporter) can drive."""

    def __init__(self, policy: LinearPolicy, model: CancerModel, horizon: float, rng: random.Random | None = None) -> None:
        self.policy, self.model, self.horizon, self.rng = policy, model, horizon, rng
        self.current = 0
        self.decisions: list[tuple[np.ndarray, int, float]] = []   # (phi, action, day)
        self.next_decision = 0.0

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        if time + 1e-9 >= self.next_decision:
            phi = features(self.model, day=time, horizon=self.horizon, burden=burden, initial=initial_burden,
                           counts=clone_counts or {}, previous=self.current if self.decisions else None,
                           k=len(self.policy.actions))
            self.current = self.policy.choose(phi, self.rng)
            self.decisions.append((phi, self.current, time))
            self.next_decision = time + self.policy.decision_days
        return TreatmentAction.combination(self.policy.actions[self.current])


# ------------------------------------------------------------------ episodes
@dataclass
class Episode:
    seed: int
    rewards: list[float]                  # one per decision block
    decisions: list[tuple[list[float], int, float]]
    control_days: int
    loss_of_control_day: float | None
    resistant_dominance_day: float | None
    final_ratio: float
    final_resistant: float
    burden_auc: float
    dose: float
    switches: int
    initial: int
    final_burden: int
    daily: list[dict] = field(default_factory=list)

    @property
    def total(self) -> float:
        return float(sum(self.rewards))


def _build(cfg: ReinforceConfig, seed: int):
    from cancer_sim.rl_env import apply_domain, sample_domain
    model = cfg.model
    experiment = cfg.experiment(seed)
    theta: dict[str, float] = {}
    if cfg.randomize and model.raw.get("randomization"):
        experiment, theta = sample_domain(model, experiment, random.Random(seed ^ 0x5EED))
    runner = build_runner(schedule_name="none", config=experiment)
    if theta:
        apply_domain(model, runner.automata, theta)
    return runner


def run_episode(cfg: ReinforceConfig, schedule, seed: int, *, keep_daily: bool = False) -> Episode:
    """Simulate one episode under ``schedule`` (a PolicySchedule or any treatment schedule)."""
    model = cfg.model
    runner = _build(cfg, seed)
    runner.schedule = schedule
    runner._passes_clone_counts = True   # every schedule used here accepts clone_counts
    initial = max(1, runner.initial_burden)
    resistant = model.resistant_clones
    rewards: list[float] = []
    block = 0.0
    control_days = 0
    loss = dominance = None
    auc = dose = 0.0
    switches = 0
    previous: dict[str, float] | None = None
    daily = []
    for day in range(cfg.days):
        record = runner.step(dt=1.0, step_number=day + 1)
        ratio = record.burden / initial
        share = record.resistant_count(resistant) / max(1, record.burden)
        exposures = dict(record.exposures)
        given = sum(exposures.values())
        changed = previous is not None and exposures != previous
        switches += int(changed)
        r = -ratio - cfg.resistance_weight * share - cfg.dose_weight * given - (cfg.switch_weight if changed else 0.0)
        block += r
        if (day + 1) % cfg.decision_days == 0 or day + 1 == cfg.days:
            rewards.append(block)
            block = 0.0
        auc += ratio
        dose += given
        if ratio < PROGRESSION:
            control_days += 1
        elif loss is None:
            loss = record.time
        if dominance is None and share >= 0.5:
            dominance = record.time
        if keep_daily:
            daily.append({"day": record.time, "burden": record.burden, "ratio": round(ratio, 4),
                          "resistant": round(share, 4), "exposures": exposures})
        previous = exposures
    last = runner.history[-1]
    decisions = [(phi.tolist(), a, d) for phi, a, d in getattr(schedule, "decisions", [])]
    return Episode(seed=seed, rewards=rewards, decisions=decisions, control_days=control_days,
                   loss_of_control_day=loss, resistant_dominance_day=dominance,
                   final_ratio=last.burden / initial, final_resistant=last.resistant_count(resistant) / max(1, last.burden),
                   burden_auc=auc / cfg.days, dose=dose, switches=switches, initial=initial, final_burden=last.burden,
                   daily=daily)


# worker entry points (top level so they pickle)
def _sample(args) -> Episode:
    cfg, policy_json, seed, draw = args
    policy = LinearPolicy.from_json(policy_json)
    schedule = PolicySchedule(policy, cfg.model, float(cfg.days), rng=random.Random(seed * 1009 + draw))
    return run_episode(cfg, schedule, seed)


def _greedy(args) -> Episode:
    cfg, policy_json, seed, keep_daily = args
    policy = LinearPolicy.from_json(policy_json)
    return run_episode(cfg, PolicySchedule(policy, cfg.model, float(cfg.days)), seed, keep_daily=keep_daily)


def _fixed(args) -> tuple[str, Episode]:
    cfg, label, kind, payload, seed = args
    model = cfg.model
    if kind == "schedule":
        schedule = build_schedule(payload, dose=1.0, switch_time=cfg.days / 3, model=model)
    else:
        schedule = _Constant(TreatmentAction.combination(payload))
    return label, run_episode(cfg, schedule, seed)


class _Constant:
    def __init__(self, action: TreatmentAction) -> None:
        self.current = action

    def action(self, *, time: float, burden: int, initial_burden: int, clone_counts=None) -> TreatmentAction:
        return self.current


# ------------------------------------------------------------------ training
class _Adam:
    def __init__(self, shape, lr: float) -> None:
        self.m = np.zeros(shape)
        self.v = np.zeros(shape)
        self.t = 0
        self.lr = lr

    def step(self, grad: np.ndarray) -> np.ndarray:
        self.t += 1
        self.m = 0.9 * self.m + 0.1 * grad
        self.v = 0.999 * self.v + 0.001 * grad * grad
        m = self.m / (1 - 0.9 ** self.t)
        v = self.v / (1 - 0.999 ** self.t)
        return self.lr * m / (np.sqrt(v) + 1e-8)


def policy_gradient(policy: LinearPolicy, episodes: Sequence[Episode], entropy: float) -> tuple[np.ndarray, float]:
    """REINFORCE with normalised advantages and an entropy bonus.

    The baseline for each decision is the mean reward-to-go of the *other*
    rollouts of the same simulated tumour (same seed) at the same decision,
    so the spread between tumours (some grow, some do not, whatever is given)
    does not drown the effect of the choices; with a single rollout per seed
    it falls back to the batch mean at that decision."""
    steps = max(len(e.rewards) for e in episodes)
    returns = []
    for e in episodes:
        r = e.rewards + [0.0] * (steps - len(e.rewards))
        returns.append(np.cumsum(r[::-1])[::-1])
    returns = np.array(returns)
    advantages = np.empty_like(returns)
    seeds = np.array([e.seed for e in episodes])
    for seed in set(seeds.tolist()):
        rows = np.flatnonzero(seeds == seed)
        if len(rows) > 1:
            total = returns[rows].sum(axis=0, keepdims=True)
            advantages[rows] = returns[rows] - (total - returns[rows]) / (len(rows) - 1)
        else:
            advantages[rows] = returns[rows] - returns.mean(axis=0, keepdims=True)
    advantages /= advantages.std() + 1e-8
    grad = np.zeros_like(policy.weights)
    count = 0
    mean_entropy = 0.0
    for i, e in enumerate(episodes):
        for t, (phi, action, _day) in enumerate(e.decisions):
            if t >= steps:
                break
            phi = np.asarray(phi)
            p = policy.probabilities(phi)
            onehot = np.zeros_like(p)
            onehot[action] = 1.0
            grad += np.outer(phi, (onehot - p) * advantages[i, t])
            logp = np.log(p + 1e-12)
            h = -float((p * logp).sum())
            mean_entropy += h
            grad += entropy * np.outer(phi, -p * (logp + h))
            count += 1
    return grad / max(1, count), mean_entropy / max(1, count)


def train(cfg: ReinforceConfig, emit: Callable[[dict], None] | None = None, pool=None,
          after_update: Callable[[LinearPolicy, int, int], None] | None = None) -> tuple[LinearPolicy, dict]:
    """Train until ``cfg.seconds`` have passed; returns the policy and the learning curve.

    ``after_update(policy, update, episodes)`` is called after every update (the
    browser uses it to show the agent's latest practice run in the 3D world)."""
    emit = emit or (lambda _: None)
    model = cfg.model
    actions = action_set(model)
    names = feature_names(model, len(actions))
    rng = np.random.default_rng(cfg.seed)
    policy = LinearPolicy(weights=rng.normal(0, 0.01, (len(names), len(actions))), actions=actions,
                          feature_names=names, decision_days=cfg.decision_days, cancer=cfg.cancer)
    adam = _Adam(policy.weights.shape, cfg.learning_rate)
    started = time.time()
    curve: list[dict] = []
    episode_count = 0
    seed = cfg.seed * 100_000
    update = 0
    estimated_total = None
    emit({"type": "start", "regimens": [describe_exposures(model, a) for a in actions], "features": names,
          "decision_days": cfg.decision_days, "days": cfg.days, "seconds": cfg.seconds})
    while True:
        elapsed = time.time() - started
        if update > 0 and elapsed >= cfg.seconds:
            break
        tumours = max(1, cfg.batch // max(1, cfg.repeats))
        payload = [(cfg, policy.to_json(), seed + i, draw) for i in range(tumours) for draw in range(max(1, cfg.repeats))]
        seed += tumours
        episodes = pool.map(_sample, payload) if pool is not None else [_sample(p) for p in payload]
        grad, mean_h = policy_gradient(policy, episodes, cfg.entropy)
        policy.weights += adam.step(grad)
        update += 1
        totals = [e.total for e in episodes]
        point = {
            "update": update, "episodes": episode_count + len(episodes), "seconds": round(time.time() - started, 2),
            "mean_return": round(statistics.fmean(totals), 3), "best_return": round(max(totals), 3),
            "control_days": round(statistics.fmean(e.control_days for e in episodes), 2),
            "final_resistant": round(statistics.fmean(e.final_resistant for e in episodes), 4),
            "final_ratio": round(statistics.fmean(e.final_ratio for e in episodes), 3),
            "entropy": round(mean_h, 3),
        }
        curve.append(point)
        for e in episodes:
            episode_count += 1
            counts = np.bincount([a for _, a, _ in e.decisions], minlength=len(actions))
            top = int(counts.argmax())
            emit({"type": "episode", "episode": episode_count, "steps": episode_count, "reward": round(e.total, 3),
                  "days": cfg.days, "final_burden": e.final_burden, "initial_burden": e.initial,
                  "resistant_fraction": round(e.final_resistant, 4), "eci": 0.0, "distinct_actions": int((counts > 0).sum()),
                  "switches": e.switches, "main_action": describe_exposures(model, actions[top]),
                  "main_action_share": round(float(counts[top] / max(1, counts.sum())), 3)})
        if estimated_total is None:
            per_episode = (time.time() - started) / max(1, episode_count)
            estimated_total = max(episode_count, int(cfg.seconds / max(per_episode, 1e-3)))
        start_state = np.asarray(episodes[0].decisions[0][0])
        probs = policy.probabilities(start_state)
        greedy_now = describe_exposures(model, actions[int(np.argmax(probs))])
        # what the agent now prefers at the start, and in the middle of a run (from a sampled episode)
        middle = episodes[0].decisions[len(episodes[0].decisions) // 2][0]
        emit({"type": "update", "update": update, "episodes": episode_count, "seconds": point["seconds"],
              "mean_return": point["mean_return"], "best_return": point["best_return"],
              "control_days": point["control_days"], "final_ratio": point["final_ratio"],
              "final_resistant": point["final_resistant"], "entropy": point["entropy"],
              "probs_start": [round(float(x), 4) for x in probs],
              "probs_middle": [round(float(x), 4) for x in policy.probabilities(np.asarray(middle))],
              "weights": [[round(float(w), 3) for w in row] for row in policy.weights]})
        if after_update is not None:
            after_update(policy, update, episode_count)
        emit({"type": "progress", "steps": episode_count, "total": max(estimated_total, episode_count), "episode": episode_count,
              "episode_reward": point["mean_return"], "burden": episodes[-1].final_burden, "eci": 0.0,
              "resistant_fraction": point["final_resistant"], "action": 0, "action_label": f"now prefers {greedy_now} at the start",
              "update": update})
    return policy, {"curve": curve, "episodes": episode_count, "updates": update, "seconds": round(time.time() - started, 2)}


# ------------------------------------------------------------------ evaluation
def _summary(label: str, episodes: Sequence[Episode], days: int) -> dict:
    control_time = [e.loss_of_control_day if e.loss_of_control_day is not None else float(days) for e in episodes]
    dominated = [e.resistant_dominance_day for e in episodes if e.resistant_dominance_day is not None]
    ordered = sorted(control_time)
    worst = ordered[: max(1, round(0.25 * len(ordered)))]
    return {
        "policy": label, "n": len(episodes),
        "control_days_median": statistics.median(control_time),
        "control_days_worst25": statistics.fmean(worst),
        "lost_control": sum(e.loss_of_control_day is not None for e in episodes) / len(episodes),
        "resistant_dominance_fraction": len(dominated) / len(episodes),
        "final_burden_ratio_median": round(statistics.median(e.final_ratio for e in episodes), 3),
        "final_resistant_median": round(statistics.median(e.final_resistant for e in episodes), 4),
        "burden_auc_median": round(statistics.median(e.burden_auc for e in episodes), 3),
        "dose_median": round(statistics.median(e.dose for e in episodes), 1),
        "switches_median": statistics.median(e.switches for e in episodes),
        "return_median": round(statistics.median(e.total for e in episodes), 2),
        # the panel's field names
        "total_reward_median": round(statistics.median(e.total for e in episodes), 2),
        "final_burden_median": statistics.median(e.final_burden for e in episodes),
        "final_resistant_fraction_median": round(statistics.median(e.final_resistant for e in episodes), 4),
        "cumulative_dose_median": round(statistics.median(e.dose for e in episodes), 1),
        "steps_median": days,
        "progression_fraction": sum(e.loss_of_control_day is not None for e in episodes) / len(episodes),
        "progression_day_median": (statistics.median(e.loss_of_control_day for e in episodes if e.loss_of_control_day is not None)
                                   if any(e.loss_of_control_day is not None for e in episodes) else None),
    }


def narrate(model: CancerModel, episode: Episode, actions: list[dict[str, float]]) -> list[str]:
    """The pattern of one greedy episode, one line per change of regimen."""
    lines = []
    previous: dict[str, float] | None = None
    for phi, a, day in episode.decisions:
        regimen = actions[a]
        if previous is not None and regimen == previous:
            continue
        share = phi[3]   # resistant share at the decision
        lines.append(f"day {int(day)}: " + describe_decision(model, previous, regimen, resistant_fraction=share))
        previous = regimen
    return lines


def evaluate(cfg: ReinforceConfig, policy: LinearPolicy, pool=None) -> dict:
    """Greedy policy vs the model's fixed strategies and every regimen held constant, on held-out seeds."""
    model = cfg.model
    actions = policy.actions
    seeds = list(cfg.eval_seeds)
    jobs = []
    for name in model.default_panel:
        jobs += [(cfg, name, "schedule", name, s) for s in seeds]
    for regimen in actions:
        label = "constant: " + describe_exposures(model, regimen)
        if any(j[1] == label for j in jobs):
            continue
        jobs += [(cfg, label, "constant", regimen, s) for s in seeds]
    fixed = pool.map(_fixed, jobs) if pool is not None else [_fixed(j) for j in jobs]
    greedy_jobs = [(cfg, policy.to_json(), s, True) for s in seeds]
    learned = pool.map(_greedy, greedy_jobs) if pool is not None else [_greedy(j) for j in greedy_jobs]

    groups: dict[str, list[Episode]] = {}
    for label, ep in fixed:
        groups.setdefault(label, []).append(ep)
    rows = [_summary(label, eps, cfg.days) for label, eps in groups.items()]
    learned_row = _summary("REINFORCE", learned, cfg.days)
    rows.append(learned_row)
    rows.sort(key=lambda r: (-r["control_days_median"], r["burden_auc_median"]))

    constants = [r for r in rows if r["policy"].startswith("constant: ")]
    best_constant = min(constants, key=lambda r: r["burden_auc_median"]) if constants else None
    schedules = [r for r in rows if not r["policy"].startswith("constant: ") and r["policy"] != "REINFORCE"]
    best_schedule = min(schedules, key=lambda r: r["burden_auc_median"]) if schedules else None

    # the pattern: narrated greedy episode for the median seed, and how much the seeds agree
    by_auc = sorted(learned, key=lambda e: e.burden_auc)
    median_episode = by_auc[len(by_auc) // 2]
    sequences = ["|".join(str(a) for _, a, _ in e.decisions) for e in learned]
    distinct = len(set(sequences))
    used = sorted({a for e in learned for _, a, _ in e.decisions})
    counts: dict[int, int] = {}
    for e in learned:
        for _, a, _ in e.decisions:
            counts[a] = counts.get(a, 0) + 1
    pattern = narrate(model, median_episode, actions)
    adaptive = distinct > 1 or len(pattern) > 1
    verdict = _verdict(learned_row, best_constant, best_schedule)
    return {
        "cancer": cfg.cancer, "seeds": seeds, "summary": rows, "learned": learned_row,
        "best_constant": best_constant, "best_schedule": best_schedule, "verdict": verdict,
        "pattern": pattern, "adaptive": adaptive, "distinct_patterns": distinct,
        "regimens_used": [describe_exposures(model, actions[a]) for a in used],
        "decisions": [{"day": d["day"], "drug": describe_exposures(model, d["exposures"]), "dose": round(sum(d["exposures"].values()), 2),
                       "burden": d["burden"], "resistant_fraction": d["resistant"], "eci": 0.0} for d in median_episode.daily],
        "action_counts": [{"drug": describe_exposures(model, actions[a]), "dose": round(sum(actions[a].values()), 2), "count": n}
                          for a, n in sorted(counts.items())],
        "viewer_seed": median_episode.seed,
    }


def _verdict(learned: dict, best_constant: dict | None, best_schedule: dict | None) -> str:
    def cmp(other: dict | None, what: str) -> str:
        if not other:
            return ""
        a, b = learned["burden_auc_median"], other["burden_auc_median"]
        rel = (b - a) / max(abs(b), 1e-9)
        if rel > 0.05:
            return f"smaller tumour than {what} ({other['policy']}): burden AUC {a:.2f} vs {b:.2f}"
        if rel < -0.05:
            return f"larger tumour than {what} ({other['policy']}): burden AUC {a:.2f} vs {b:.2f}"
        return f"about the same tumour size as {what} ({other['policy']})"
    parts = [p for p in (cmp(best_schedule, "the best fixed strategy"), cmp(best_constant, "the best single regimen")) if p]
    return "; ".join(parts)


# ------------------------------------------------------------------ persistence
def save(path: Path, policy: LinearPolicy, cfg: ReinforceConfig, training: dict, evaluation: dict | None) -> None:
    data = policy.to_json()
    data["training"] = {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(cfg).items()}
    data["learning"] = training
    if evaluation:
        data["evaluation"] = evaluation
    data["note"] = "A treatment pattern learned on this simulator's represented drugs; not a treatment recommendation."
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1) + "\n")


def record_run(cfg: ReinforceConfig, policy: LinearPolicy, seed: int, *, name: str, sample: bool = False) -> dict:
    """Record the policy on one tumour in the viewer's format.

    Greedy by default; ``sample=True`` draws each choice as training does, so a
    run recorded early in training shows the agent exploring. Returns the
    exporter's summary plus the run's narrated decisions and outcome."""
    from cancer_sim.iressa_export import export_run
    from cancer_sim.rl_env import apply_domain, sample_domain
    model = cfg.model
    experiment = cfg.experiment(seed)
    theta: dict[str, float] = {}
    if cfg.randomize and model.raw.get("randomization"):
        experiment, theta = sample_domain(model, experiment, random.Random(seed ^ 0x5EED))
    runner = build_runner(schedule_name="none", config=experiment, record_events=True)
    if theta:
        apply_domain(model, runner.automata, theta)
    schedule = PolicySchedule(policy, model, float(cfg.days), rng=random.Random(seed) if sample else None)
    runner.schedule = schedule
    runner._passes_clone_counts = True
    summary = export_run(replace(experiment, steps=cfg.days), "none", name=name, runner_override=runner, keyframe_every_days=1.0)
    initial = max(1, runner.initial_burden)
    last = runner.history[-1]
    lines = []
    previous = None
    for phi, a, day in schedule.decisions:
        if previous is not None and a == previous:
            continue
        lines.append({"day": int(day), "regimen": describe_exposures(model, policy.actions[a]), "action": a,
                      "text": describe_decision(model, policy.actions[previous] if previous is not None else None,
                                                policy.actions[a], resistant_fraction=float(phi[3]))})
        previous = a
    summary["decisions"] = lines
    summary["choices"] = [int(a) for _, a, _ in schedule.decisions]
    summary["final_ratio"] = round(last.burden / initial, 3)
    summary["final_resistant"] = round(last.resistant_count(model.resistant_clones) / max(1, last.burden), 4)
    summary["burden"] = [round(r.burden / initial, 3) for r in runner.history]
    return summary
