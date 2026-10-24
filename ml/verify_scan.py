"""Recompute one district of the live scan from data/manifest.json and diff it against data/kilns.json.

Checks: weights sha256 match the manifest; the recomputed records (same fixed scene ids, same
rendering, CPU deterministic inference) are identical to the published records for that district,
field by field; the recomputed chips are byte-identical to the published chips.

Usage: ml/.venv/bin/python ml/verify_scan.py --district Lahore [--work /tmp/bhatta_verify]
Exit code 0 when identical, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA, sha256


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--district", default="Lahore")
    ap.add_argument("--work", default=None)
    args = ap.parse_args()
    work = Path(args.work or tempfile.mkdtemp(prefix="bhatta_verify_"))
    man = json.load(open(DATA / "manifest.json"))
    wd = Path(__file__).resolve().parent / "weights"
    ok = True
    for name, key in (("detector.pt", "detector_sha256"), ("classifier.pt", "classifier_sha256")):
        h = sha256(wd / name)
        print(f"{name}: {'OK' if h == man[key] else 'MISMATCH'} {h}")
        ok &= h == man[key]
    cmd = [sys.executable, str(Path(__file__).resolve().parent / "scan.py"), "--districts", args.district,
           "--from-manifest", str(DATA / "manifest.json"), "--out-dir", str(work), "--chip-root", str(work), "--no-cache"]
    print("running:", " ".join(cmd))
    subprocess.run(cmd, check=True)
    new = json.load(open(work / "districts" / f"{args.district}.json"))["records"]
    pub = [r for r in json.load(open(DATA / "kilns.json")) if r["district"] == args.district]
    new_by, pub_by = {r["id"]: r for r in new}, {r["id"]: r for r in pub}
    only_new, only_pub = sorted(set(new_by) - set(pub_by)), sorted(set(pub_by) - set(new_by))
    diff = [i for i in sorted(set(new_by) & set(pub_by)) if json.dumps(new_by[i], sort_keys=True) != json.dumps(pub_by[i], sort_keys=True)]
    chip_diff, chips = [], 0
    for r in new:
        for k in ("chip", "baseline_chip"):
            rel = r["observation"][k]
            if rel:
                chips += 1
                a, b = work / rel, DATA / rel
                if not b.exists() or sha256(a) != sha256(b):
                    chip_diff.append(rel)
    print(f"district {args.district}: recomputed {len(new)} records, published {len(pub)}")
    print(f"ids only in recomputed: {len(only_new)}; only in published: {len(only_pub)}; differing records: {len(diff)}")
    print(f"chips compared: {chips}; differing chips: {len(chip_diff)}")
    for i in diff[:5]:
        print("DIFF", i, json.dumps(new_by[i])[:300], "\n     ", json.dumps(pub_by[i])[:300])
    ok &= not (only_new or only_pub or diff or chip_diff)
    print("RESULT:", "IDENTICAL" if ok else "DIFFERENT")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
