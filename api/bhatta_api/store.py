"""Loads the files the ML and chain steps write, and answers questions about them.

Everything here is read-only and in memory. The data is small (thousands of kilns), so a reload on
file change is cheaper than any database.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

STATUS_CODES = {"NOT_DETECTED": 0, "FCBK": 1, "ZIGZAG": 2, "UNDETERMINED": 3}

# Order an inspector should visit in: a contradicted claim first, then the kilns the image could not
# decide, then the ones not seen at all. Converted kilns come last.
QUEUE_RANK = {"CONFLICT": -1, "FCBK": 0, "UNDETERMINED": 1, "NOT_DETECTED": 2, "ZIGZAG": 3}
REASON_CODE = {"FCBK": "SAT_FCBK", "UNDETERMINED": "UNDETERMINED", "NOT_DETECTED": "NOT_SEEN", "ZIGZAG": "SAT_ZIGZAG"}
QUEUE_REASON = {
    "CONFLICT": "The satellite and a signed inspector finding disagree on the public record.",
    "FCBK": "Satellite shows the old oval FCBK shape at 90% confidence.",
    "UNDETERMINED": "The 10 m image cannot separate Zigzag from FCBK here.",
    "NOT_DETECTED": "Kiln mapped in 2023-24 but not seen this season.",
    "ZIGZAG": "Satellite shows the Zigzag shape; a field check would complete the certificate.",
}

CLAIM = {
    "quote": "around 8,000 brick kilns across Punjab had been converted to zigzag technology, "
    "with QR codes assigned to all kilns",
    "who": "Senior Provincial Minister, Punjab, 10 Oct 2026",
    "url": "https://propakistani.pk/2026/10/10/punjab-provides-10000-super-seeders-converts-8000-brick-kilns-to-zigzag-technology/",
    "survey_count": 10394,
    "survey_source": "EPA Punjab and The Urban Unit joint survey, reported by the Express Tribune, Aug 2026",
    "survey_url": "https://tribune.com.pk/story/2621873/brick-kiln-crackdown-raises-livelihood-concerns",
}


# What converting one FCBK kiln to Zigzag changes, as measured in Pakistan and reported by ICIMOD. Only
# percentages: we found no verified per-kiln coal tonnage, so the app never multiplies these into tonnes.
_ICIMOD_PK = {
    "title": "Towards cleaner brick production in Pakistan (ICIMOD)",
    "url": "https://www.icimod.org/?p=33152",
    "quote": "Emission measurement studies show that there has been a 15% reduction in CO2, 40% reduction in "
    "particulate matter, and 60% reduction in black carbon as a result of the switch",
}
_ICIMOD_SS = {
    "title": "South-South business partnerships towards energy-efficient and low-emission brick production "
    "in Pakistan (ICIMOD)",
    "url": "https://www.icimod.org/south-south-business-partnerships-towards-energy-efficient-and-low-emission-brick-production-in-pakistan",
    "quote": "The zig-zag technology reduces emissions by 50% and coal consumption by 20%",
}
IMPACT = {
    "per_conversion": [
        {"key": "coal", "reduction_pct": 20, "source": _ICIMOD_SS},
        {"key": "co2", "reduction_pct": 15, "source": _ICIMOD_PK},
        {"key": "pm", "reduction_pct": 40, "source": _ICIMOD_PK},
        {"key": "black_carbon", "reduction_pct": 60, "source": _ICIMOD_PK},
    ],
    "note": "Reductions for one kiln switching from FCBK to Zigzag, from emission measurements in Pakistan. "
    "Not multiplied into tonnes: no verified per-kiln coal figure was found.",
}


def _read_json(path: Path):
    with path.open(encoding="utf-8") as f:
        return json.load(f)


@dataclass
class Store:
    data_dir: Path
    docs_dir: Path
    fixture: bool
    kilns: list[dict] = field(default_factory=list)
    by_id: dict[str, dict] = field(default_factory=dict)
    merkle: dict[int, dict] = field(default_factory=dict)
    chain: dict = field(default_factory=dict)
    summary: dict = field(default_factory=dict)
    results: list[dict] = field(default_factory=list)
    version: str = ""

    @classmethod
    def load(cls, data_dir: Path, docs_dir: Path, fixture: bool) -> "Store":
        s = cls(data_dir=data_dir, docs_dir=docs_dir, fixture=fixture)
        s.reload()
        return s

    def _kiln_file(self) -> Path:
        real = self.data_dir / "kilns.json"
        sample = self.data_dir / "fixtures" / "kilns.sample.json"
        if self.fixture or not real.exists():
            return sample
        return real

    def reload(self) -> None:
        kf = self._kiln_file()
        raw = _read_json(kf) if kf.exists() else []
        self.kilns = raw["kilns"] if isinstance(raw, dict) and "kilns" in raw else raw
        self.by_id = {k["id"]: k for k in self.kilns}
        self.merkle = {}
        mdir = self.data_dir / "merkle"
        if mdir.exists():
            for p in sorted(mdir.glob("season-*.json")):
                m = _read_json(p)
                self.merkle[int(m["season"])] = m
        cf = self.data_dir / "chain.json"
        self.chain = _read_json(cf) if cf.exists() else {}
        sf = self.data_dir / "summary.json"
        self.summary = _read_json(sf) if sf.exists() else {}
        self.results = parse_results(self.docs_dir / "RESULTS.md")
        stamp = [str(int(kf.stat().st_mtime))] if kf.exists() else ["none"]
        self.version = f"{kf.name}@{stamp[0]}"

    def counts(self) -> dict[str, int]:
        out = {k: 0 for k in STATUS_CODES}
        for k in self.kilns:
            out[k.get("status", "UNDETERMINED")] = out.get(k.get("status", "UNDETERMINED"), 0) + 1
        return out

    def chain_record(self, kiln_id: str) -> dict | None:
        for season in sorted(self.merkle, reverse=True):
            leaf = self.merkle[season].get("leaves", {}).get(kiln_id)
            if leaf:
                return {
                    "season": season,
                    "root": self.merkle[season]["root"],
                    "leaf": leaf["leaf"],
                    "proof": leaf["proof"],
                    "evidence_hash": leaf["evidence_hash"],
                    "status_code": leaf["status_code"],
                    "p_zigzag_bp": leaf["p_zigzag_bp"],
                    "kiln_id_bytes32": leaf.get("kiln_id_bytes32"),
                }
        return None

    def light(self, k: dict) -> dict:
        return {
            "id": k["id"],
            "lat": k["lat"],
            "lon": k["lon"],
            "district": k.get("district"),
            "status": k["status"],
            "baseline_class": (k.get("baseline") or {}).get("class"),
        }

    def filtered(self, status: str | None, district: str | None) -> list[dict]:
        out = self.kilns
        if status:
            wanted = {s.strip().upper() for s in status.split(",")}
            out = [k for k in out if k.get("status") in wanted]
        if district:
            out = [k for k in out if (k.get("district") or "").lower() == district.lower()]
        return out

    def queue(self, district: str | None, conflicts: set[str] | None = None) -> list[dict]:
        conflicts = conflicts or set()
        rows = []
        for k in self.filtered(None, district):
            st = k.get("status", "UNDETERMINED")
            probs = (k.get("observation") or {}).get("probs") or {}
            key = "CONFLICT" if k["id"] in conflicts else st
            p_fcbk = probs.get("FCBK")
            rows.append(
                {
                    **self.light(k),
                    "reason_code": "CONFLICT" if key == "CONFLICT" else REASON_CODE.get(st, "UNDETERMINED"),
                    "reason": QUEUE_REASON.get(key, ""),
                    "p_fcbk": p_fcbk,
                    "p_zigzag": probs.get("Zigzag"),
                    "_rank": (QUEUE_RANK.get(key, 9), -(p_fcbk or 0.0), k["id"]),
                }
            )
        rows.sort(key=lambda r: r["_rank"])
        for i, r in enumerate(rows, 1):
            r["priority"] = i
            del r["_rank"]
        return rows


_ROW = re.compile(r"^\|\s*(T[1-6])\s*\|(.+)\|\s*$")


def parse_results(path: Path) -> list[dict]:
    """Reads the T1 to T6 rows of the results table, whatever the middle columns are called."""
    if not path.exists():
        return []
    rows = []
    header: list[str] | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if header is None and cells and cells[0].upper() in {"ID", "TARGET ID", "T"} and len(cells) > 2:
            header = [c.lower() for c in cells]
            continue
        m = _ROW.match(line.strip())
        if m:
            row = {"id": m.group(1)}
            if header and len(header) == len(cells):
                for h, c in zip(header[1:], cells[1:]):
                    row[h] = c
            else:
                row["cells"] = cells[1:]
            verdict = " ".join(cells).upper()
            row["hit"] = True if "HIT" in verdict else False if "MISS" in verdict else None
            rows.append(_normalise_result(row))
    return rows


_RESULT_KEYS = {
    "metric": ("metric", "metric, on test blocks only", "what", "measure"),
    "target": ("target",),
    "value": ("result", "value", "test result", "measured"),
    "n": ("n", "count", "sample"),
}


def _normalise_result(row: dict) -> dict:
    out = {"id": row["id"], "hit": row.get("hit")}
    for key, names in _RESULT_KEYS.items():
        out[key] = next((row[n] for n in names if n in row), None)
    out["raw"] = {k: v for k, v in row.items() if k not in ("id", "hit")}
    return out


def kiln_id_from_bytes32(v) -> str | None:
    if not isinstance(v, str) or not v.startswith("0x"):
        return None
    try:
        return bytes.fromhex(v[2:]).rstrip(b"\0").decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def default_dirs() -> tuple[Path, Path]:
    root = Path(__file__).resolve().parents[2]
    data = Path(os.environ.get("BHATTA_DATA_DIR", root / "data"))
    docs = Path(os.environ.get("BHATTA_DOCS_DIR", root / "docs"))
    return data, docs
