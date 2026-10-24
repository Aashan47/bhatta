"""Regenerate only the 2023-24 baseline chips (data/chips/*_2023.png) with
scan.baseline_chip_central: most central dataset patch, flat grey fill instead of reflection.
Touches no 2026 chip and no field of data/kilns.json.

Usage: ml/.venv/bin/python ml/regen_baseline_chips.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import DATA
from scan import baseline_chip_central, save_png


def main():
    recs = json.load(open(DATA / "kilns.json"))
    known = pd.read_csv(DATA / "pk_kilns_2023.csv").set_index("id")
    n = changed = 0
    for r in recs:
        rel = r["observation"]["baseline_chip"]
        if not rel:
            continue
        assert rel.endswith("_2023.png"), rel
        k = known.loc[r["id"]]
        chip = baseline_chip_central(k)
        assert chip is not None and chip.shape == (64, 64, 3), r["id"]
        path = DATA / rel
        before = path.read_bytes() if path.exists() else None
        save_png(chip, path)
        n += 1
        changed += path.read_bytes() != before
    print(f"baseline chips written: {n}; changed bytes: {changed}")


if __name__ == "__main__":
    main()
