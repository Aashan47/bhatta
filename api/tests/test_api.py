import importlib
import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _kiln(i, status, baseline="FCBK", p_fcbk=0.5):
    return {
        "id": f"PK-test{i:04d}",
        "lat": 31.0 + i / 1000,
        "lon": 74.0 + i / 1000,
        "district": "Kasur" if i % 2 else "Lahore",
        "baseline": {"source": "SentinelKilnDB hand label", "period": "2023-09/2024-02", "class": baseline},
        "observation": {
            "scene_id": "S2A_TEST",
            "date": "2026-10-19",
            "detected": status != "NOT_DETECTED",
            "det_conf": 0.9,
            "probs": {"FCBK": p_fcbk, "Zigzag": round(1 - p_fcbk, 4)},
            "set": ["FCBK"] if status == "FCBK" else ["Zigzag"] if status == "ZIGZAG" else ["FCBK", "Zigzag"],
            "chip": f"chips/PK-test{i:04d}_2026.png",
            "baseline_chip": None,
        },
        "status": status,
    }


@pytest.fixture()
def client(tmp_path, monkeypatch):
    data = tmp_path / "data"
    docs = tmp_path / "docs"
    (data / "fixtures").mkdir(parents=True)
    (data / "chips").mkdir()
    docs.mkdir()
    kilns = [
        _kiln(1, "ZIGZAG", p_fcbk=0.05),
        _kiln(2, "FCBK", p_fcbk=0.80),
        _kiln(3, "FCBK", p_fcbk=0.95),
        _kiln(4, "UNDETERMINED", p_fcbk=0.5),
        _kiln(5, "NOT_DETECTED", p_fcbk=0.0),
    ]
    (data / "kilns.json").write_text(json.dumps(kilns))
    (data / "chips" / "PK-test0001_2026.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    (docs / "RESULTS.md").write_text(
        "| ID | Metric | Target | Result | Verdict |\n|---|---|---|---|---|\n"
        "| T1 | recall | 0.80 | 0.84 | HIT |\n| T6 | false zigzag | 0.05 | 0.07 | MISS |\n"
    )
    monkeypatch.setenv("BHATTA_DATA_DIR", str(data))
    monkeypatch.setenv("BHATTA_DOCS_DIR", str(docs))
    monkeypatch.setenv("BHATTA_FIXTURE", "0")
    monkeypatch.setenv("BHATTA_WEB_DIST", str(tmp_path / "no-dist"))
    for m in [m for m in sys.modules if m.startswith("bhatta_api")]:
        del sys.modules[m]
    app_mod = importlib.import_module("bhatta_api.app")
    return TestClient(app_mod.app)


def test_health_and_summary(client):
    h = client.get("/api/health").json()
    assert h["ok"] is True and h["kilns"] == 5
    s = client.get("/api/summary").json()
    assert s["counts"] == {"NOT_DETECTED": 1, "FCBK": 2, "ZIGZAG": 1, "UNDETERMINED": 1}
    assert "8,000" in s["claim"]["quote"]


def test_filters(client):
    assert len(client.get("/api/kilns?status=FCBK").json()) == 2
    assert len(client.get("/api/kilns?status=fcbk,zigzag").json()) == 3
    assert {k["district"] for k in client.get("/api/kilns?district=kasur").json()} == {"Kasur"}


def test_kiln_detail_and_404(client):
    k = client.get("/api/kilns/PK-test0002").json()
    assert k["status"] == "FCBK" and k["chain"] is None and k["events"] == []
    r = client.get("/api/kilns/nope")
    assert r.status_code == 404 and "error" in r.json()


def test_queue_puts_contradicted_claims_first(client):
    q = client.get("/api/inspect/queue").json()
    assert [r["status"] for r in q] == ["FCBK", "FCBK", "UNDETERMINED", "NOT_DETECTED", "ZIGZAG"]
    assert q[0]["id"] == "PK-test0003"  # the more confident FCBK first
    assert [r["priority"] for r in q] == [1, 2, 3, 4, 5]


def test_chip_names_cannot_escape(client):
    assert client.get("/api/chips/PK-test0001_2026.png").status_code == 200
    assert client.get("/api/chips/..%2Fkilns.json").status_code in (400, 404)
    assert client.get("/api/chips/kilns.json").status_code == 400


def test_results_table(client):
    r = client.get("/api/results").json()["targets"]
    assert [(x["id"], x["hit"]) for x in r] == [("T1", True), ("T6", False)]


def test_relay_is_rate_limited(client):
    codes = [client.post("/api/relay/dispute", json={}).status_code for _ in range(12)]
    assert codes[-1] == 429
