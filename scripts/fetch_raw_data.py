#!/usr/bin/env python3
"""Create/fetch versioned raw-data inputs for calibration.

Default behavior is a safe acquisition plan. Provide --allow-network to fetch
resources whose URLs have been filled in data/config/raw_sources.json.
"""

from __future__ import annotations

import argparse
import json
import shutil
import ssl
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cancer_sim.calibration.schema import file_sha256


CONFIG_PATH = ROOT / "data" / "config" / "raw_sources.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=CONFIG_PATH)
    parser.add_argument("--allow-network", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = json.loads(args.config.read_text())
    manifest = {
        "retrieval_date": datetime.now(timezone.utc).isoformat(),
        "allow_network": args.allow_network,
        "sources": []
    }

    for source_name, source in config.items():
        target_dir = ROOT / source["target_dir"]
        target_dir.mkdir(parents=True, exist_ok=True)
        source_entry = {
            "source": source_name,
            "version": source["version"],
            "target_dir": str(target_dir),
            "license_note": source["license_note"],
            "resources": []
        }
        print(f"{source_name}: {source['version']}")
        for resource in source["resources"]:
            output_path = target_dir / resource["output"]
            url = resource.get("url", "")
            if args.allow_network and url:
                print(f"  fetching {resource['name']} -> {output_path}")
                download_url(url, output_path)
                flat_path = ROOT / "data" / "raw" / resource["output"]
                shutil.copyfile(output_path, flat_path)
            else:
                print(f"  plan {resource['name']}: {resource.get('note', '')}")
                if not url:
                    print("    no URL configured; place file manually or edit data/config/raw_sources.json")
            source_entry["resources"].append(
                {
                    "name": resource["name"],
                    "url": url,
                    "output": str(output_path),
                    "present": output_path.exists(),
                    "sha256": file_sha256(output_path)
                }
            )
        manifest["sources"].append(source_entry)

    manifest_path = ROOT / "data" / "raw" / "raw_acquisition_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {manifest_path}")
    return 0


def download_url(url: str, output_path: Path) -> None:
    context = ssl._create_unverified_context()
    with urllib.request.urlopen(url, timeout=120, context=context) as response:
        output_path.write_bytes(response.read())


if __name__ == "__main__":
    raise SystemExit(main())
