#!/usr/bin/env python3
"""Run the validated engine and write a viewer-ready recorded run into data/runs/<name>/.

    python3 scripts/export_iressa_run.py --name demo --schedule gefitinib-osimertinib --days 60
    python3 scripts/export_iressa_run.py --name flat2d --depth 1 --width 50 --height 40 --cells 350
    python3 scripts/export_iressa_run.py --cancer breast_er_her2neg --name breast48 --schedule early-switch-esr1-10

Then: npm run dev  and open the printed URL.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.cancers import DEFAULT_CANCER, available_cancers, load_cancer_model  # noqa: E402
from cancer_sim.experiments import ExperimentConfig  # noqa: E402
from cancer_sim.iressa_export import DEFAULT_3D_TREE, export_policy_run, export_run  # noqa: E402
from cancer_sim.config_controls import OXYGEN_PRESETS  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cancer", choices=available_cancers(), default=DEFAULT_CANCER,
                   help="cancer model (cancer_sim/cancers/<id>.json)")
    p.add_argument("--name", default="demo")
    p.add_argument("--schedule", default=None, help="a schedule declared by the cancer model (default: its first switch schedule)")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--size", type=int, default=48, help="lattice edge for a cubic 3D run")
    p.add_argument("--width", type=int, default=None)
    p.add_argument("--height", type=int, default=None)
    p.add_argument("--depth", type=int, default=None, help="1 for the validated 2D section")
    p.add_argument("--cells", type=int, default=1500)
    p.add_argument("--days", type=float, default=60.0)
    p.add_argument("--dt-days", type=float, default=0.25, help="engine step; must be a whole number of ticks")
    p.add_argument("--tick-minutes", type=float, default=30.0)
    p.add_argument("--keyframe-every-days", type=float, default=1.0)
    p.add_argument("--dose", type=float, default=0.9)
    p.add_argument("--switch-time", type=float, default=20.0)
    p.add_argument("--mutation-scale", type=float, default=50.0)
    p.add_argument("--resistant-fraction", type=float, default=None,
                   help="lung model: initial T790M fraction (0-1; default 0.08). Other models: use --clone-weights")
    p.add_argument("--clone-weights", default=None,
                   help="comma-separated seeding weights, one per clone of the model (default: the model's own mix)")
    p.add_argument("--policy", type=Path, default=None, help="record a run driven by this Stable-Baselines3 PPO .zip instead of a schedule")
    p.add_argument("--policy-name", default="PPO", help="how the viewer names the policy")
    p.add_argument("--randomize", action="store_true", help="with --policy: draw the uncertain biology for this episode")
    p.add_argument("--policy-trained-randomized", action="store_true", help="with --policy: the policy was trained with domain randomisation (shown in the viewer)")
    p.add_argument("--eci-min", type=float, default=0.02, help="with --policy: the controllability cut-off the policy was trained with")
    p.add_argument("--vasculature", choices=("tree", "grid"), default="tree")
    p.add_argument("--vessel-spacing-um", type=float, default=150.0)
    p.add_argument("--voxel-um", type=float, default=20.0)
    p.add_argument("--trunks", type=int, default=DEFAULT_3D_TREE["trunks"])
    p.add_argument("--max-depth", type=int, default=DEFAULT_3D_TREE["maxDepth"])
    p.add_argument("--oxygen-mode", choices=OXYGEN_PRESETS, default="default")
    p.add_argument("--oxygen-source", type=float, default=None)
    p.add_argument("--oxygen-uptake", type=float, default=None)
    p.add_argument("--oxygen-vmax", type=float, default=None)
    p.add_argument("--oxygen-prolif-threshold", type=float, default=None)
    p.add_argument("--oxygen-necrosis-threshold", type=float, default=None)
    p.add_argument("--necrosis-exposure-time", type=float, default=None)
    p.add_argument("--hypoxic-death-rate", type=float, default=None)
    args = p.parse_args()

    model = load_cancer_model(args.cancer)
    schedule = args.schedule or ("gefitinib-osimertinib" if args.cancer == DEFAULT_CANCER else model.default_panel[2])
    if schedule not in model.schedules:
        p.error(f"--schedule must be one of {', '.join(model.schedules)} for {args.cancer}")

    width = args.width or args.size
    height = args.height or args.size
    depth = args.depth if args.depth is not None else args.size
    if args.clone_weights:
        clone_weights = tuple(float(w) for w in args.clone_weights.split(","))
    elif args.cancer == DEFAULT_CANCER:
        frac = min(max(0.08 if args.resistant_fraction is None else args.resistant_fraction, 0.0), 0.95)
        clone_weights = (100.0 * (1 - frac), 100.0 * frac, 0.0, 0.0)
    else:
        if args.resistant_fraction is not None:
            p.error("--resistant-fraction is specific to the lung model; use --clone-weights")
        clone_weights = None
    config = ExperimentConfig(
        cancer=args.cancer,
        seed=args.seed, width=width, height=height, depth=depth, cells=args.cells,
        steps=int(round(args.days / args.dt_days)), dt=args.dt_days, dose=args.dose, switch_time=args.switch_time,
        mutation_scale=args.mutation_scale, clone_weights=clone_weights,
        vessel_spacing_um=args.vessel_spacing_um, vasculature=args.vasculature if depth > 1 else "grid",
        cell_size_um=args.voxel_um
    )
    spec = {**DEFAULT_3D_TREE, "trunks": args.trunks, "maxDepth": args.max_depth}
    t0 = time.time()

    def progress(step, total, rec):
        counts = " ".join(f"{clone} {rec.count(clone)}" for clone in model.clone_ids)
        agents = "+".join(rec.exposures) or "none"
        print(f"  step {step}/{total}  day {rec.time:.1f}  {agents:24s} burden {rec.burden:6d}  {counts}  ({time.time() - t0:.0f}s)", flush=True)

    microenvironment_args = Namespace(
        oxygen_mode=args.oxygen_mode,
        oxygen_source=args.oxygen_source,
        oxygen_uptake=args.oxygen_uptake,
        oxygen_vmax=args.oxygen_vmax,
        oxygen_prolif_threshold=args.oxygen_prolif_threshold,
        oxygen_necrosis_threshold=args.oxygen_necrosis_threshold,
        necrosis_exposure_time=args.necrosis_exposure_time,
        hypoxic_death_rate=args.hypoxic_death_rate,
        field_substep_minutes=None,
        drug_solver=None,
        necrotic_clearance_rate=None,
        vessel_spacing_um=None
    )
    if args.policy is not None:
        from stable_baselines3 import PPO
        from cancer_sim.rl_eval import ppo_policy
        from cancer_sim.rl_env import RLConfig
        rl_config = RLConfig(experiment=config, horizon_days=args.days, decision_interval_days=args.dt_days,
                             randomize=args.randomize, eci_min=args.eci_min)
        summary = export_policy_run(rl_config, ppo_policy(PPO.load(str(args.policy))), policy_name=args.policy_name, name=args.name,
                                    seed=args.seed, tick_minutes=args.tick_minutes, keyframe_every_days=args.keyframe_every_days,
                                    vasculature_spec=spec if depth > 1 else None, progress=progress,
                                    trained_randomized=args.policy_trained_randomized or None)
        print(json.dumps(summary, indent=2, default=str))
        print(f"\nopen: http://localhost:5173{summary['viewer_url']}")
        return 0
    summary = export_run(config, schedule, name=args.name, tick_minutes=args.tick_minutes,
                         keyframe_every_days=args.keyframe_every_days, vasculature_spec=spec,
                         microenvironment_args=microenvironment_args, progress=progress)
    print(json.dumps({k: v for k, v in summary.items() if k not in ("config",)}, indent=2))
    print(f"\nopen: http://localhost:5173{summary['viewer_url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
