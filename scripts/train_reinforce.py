"""Train a treatment pattern with lightweight REINFORCE in under a minute.

    python scripts/train_reinforce.py --cancer breast_er_her2neg --seconds 45

Writes outputs/rl/reinforce_<cancer>.json (weights, learning curve, held-out
comparison and the narrated pattern). With ``--live`` it prints the
``RL_PROGRESS {json}`` lines the viewer's AI add-on reads and, while it trains,
records the agent's latest practice run on a 3D tumour for the viewer to play
(data/runs/ai-<session>-<n>), finishing with the learned policy on a held-out
tumour.
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import shutil
import sys
import time
from dataclasses import replace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.iressa_export import RUNS_DIR  # noqa: E402
from cancer_sim.reinforce import LinearPolicy, ReinforceConfig, evaluate, record_run, save, train  # noqa: E402

# the 3D tumour the viewer shows; the policy's features are scale-free, so it
# acts on this one exactly as on the 2D sections it practises on
SHOWCASE = {"width": 16, "height": 16, "depth": 16, "cells": 300}


def _showcase(args) -> dict:
    cfg, policy_json, seed, name, sample = args
    return record_run(cfg, LinearPolicy.from_json(policy_json), seed, name=name, sample=sample)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cancer", default="breast_er_her2neg")
    parser.add_argument("--seconds", type=float, default=45.0, help="training time budget (evaluation comes after)")
    parser.add_argument("--days", type=int, default=60)
    parser.add_argument("--workers", type=int, default=max(1, min(8, (mp.cpu_count() or 2) - 1)))
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--no-randomize", action="store_true", help="keep the model's central biology every episode")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs" / "rl")
    parser.add_argument("--live", action="store_true", help="emit RL_PROGRESS lines and record runs for the viewer")
    args = parser.parse_args(argv)

    def emit(event: dict) -> None:
        if args.live:
            print("RL_PROGRESS " + json.dumps(event), flush=True)

    cfg = ReinforceConfig(cancer=args.cancer, seconds=args.seconds, days=args.days, workers=args.workers,
                          seed=args.seed, randomize=not args.no_randomize)
    shown = replace(cfg, **SHOWCASE)
    session = f"ai-{int(time.time())}"
    if args.live:   # earlier sessions' practice runs are not worth keeping
        for old in RUNS_DIR.glob("ai-*"):
            shutil.rmtree(old, ignore_errors=True)
    started = time.time()
    with mp.get_context("spawn").Pool(cfg.workers) as pool:
        pending: list = []   # at most one practice run being recorded at a time

        def collect(block: bool = False) -> None:
            while pending and (block or pending[0][0].ready()):
                job, update, episodes = pending.pop(0)
                try:
                    run = job.get()
                except Exception as error:   # a failed recording must not stop training
                    print(f"showcase failed: {error}", file=sys.stderr, flush=True)
                    continue
                emit({"type": "showcase", "kind": "practice", "update": update, "episodes": episodes, **_brief(run)})

        def after_update(policy, update: int, episodes: int) -> None:
            if not args.live:
                return
            collect()
            if not pending:
                name = f"{session}-{update:03d}"
                job = pool.apply_async(_showcase, ((shown, policy.to_json(), 50_000 + update, name, True),))
                pending.append((job, update, episodes))

        policy, training = train(cfg, emit=emit, pool=pool, after_update=after_update)
        collect(block=True)
        emit({"type": "stage", "stage": "evaluating"})
        evaluation = evaluate(cfg, policy, pool=pool)
        if args.live:
            final = _showcase((shown, policy.to_json(), evaluation["viewer_seed"], f"{session}-final", False))
            evaluation["viewer_url"] = final["viewer_url"]
            emit({"type": "showcase", "kind": "final", "update": training["updates"], "episodes": training["episodes"], **_brief(final)})
    path = args.output_dir / f"reinforce_{args.cancer}.json"
    save(path, policy, cfg, training, evaluation)
    emit({"type": "evaluation", "result": evaluation})
    emit({"type": "complete", "checkpoint": str(path.relative_to(ROOT) if path.is_relative_to(ROOT) else path)})
    if not args.live:
        print(f"{training['episodes']} practice runs, {training['updates']} updates in {training['seconds']} s "
              f"(total {time.time() - started:.1f} s)")
        for row in evaluation["summary"]:
            print(f"  {row['policy'][:48]:48s} burden AUC {row['burden_auc_median']:6.3f}  "
                  f"control {row['control_days_median']:5.1f} d  resistant {row['final_resistant_median']:.2f}")
        print(evaluation["verdict"])
        print("\n".join("  " + line for line in evaluation["pattern"]))
        print(f"Saved {path}")
    return 0


def _brief(run: dict) -> dict:
    return {k: run[k] for k in ("viewer_url", "decisions", "choices", "final_ratio", "final_resistant", "burden") if k in run}


if __name__ == "__main__":
    raise SystemExit(main())
