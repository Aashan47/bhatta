"""Bhatta API. Serves the kiln records, their Merkle proofs, the ledger events and the web app."""

from __future__ import annotations

import os
import re
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .chain import Chain, Relay, RelayRejected
from .store import CLAIM, IMPACT, Store, default_dirs

FIXTURE = os.environ.get("BHATTA_FIXTURE", "0") == "1"
DATA_DIR, DOCS_DIR = default_dirs()
WEB_DIST = Path(os.environ.get("BHATTA_WEB_DIST", Path(__file__).resolve().parents[2] / "web" / "dist"))

store = Store.load(DATA_DIR, DOCS_DIR, FIXTURE)
chain = Chain(DATA_DIR, store.chain, FIXTURE)
relay = Relay(chain)

app = FastAPI(title="Bhatta API", docs_url="/api/docs", openapi_url="/api/openapi.json")

_SAFE_CHIP = re.compile(r"^[A-Za-z0-9_\-]+\.png$")
_hits: dict[str, deque] = defaultdict(deque)


def _rate_limit(request: Request, limit: int, window: float) -> None:
    ip = request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")
    q = _hits[ip]
    now = time.time()
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(429, "Too many requests from this address. Try again later.")
    q.append(now)


@app.get("/api/health")
def health():
    return {
        "ok": bool(store.kilns),
        "fixture": FIXTURE,
        "data_version": store.version,
        "kilns": len(store.kilns),
        "chain": {"id": store.chain.get("chain_id"), "contract": store.chain.get("contract"), "configured": chain.configured},
    }


@app.get("/api/summary")
def summary():
    s = dict(store.summary)
    s.update({"counts": store.counts(), "total": len(store.kilns), "claim": CLAIM, "impact": IMPACT, "fixture": FIXTURE})
    return s


@app.get("/api/kilns")
def kilns(status: str | None = None, district: str | None = None):
    return [store.light(k) for k in store.filtered(status, district)]


@app.get("/api/kilns/{kiln_id}")
def kiln(kiln_id: str):
    k = store.by_id.get(kiln_id)
    if not k:
        raise HTTPException(404, "No kiln with that id.")
    rec = store.chain_record(kiln_id)
    return {**k, "chain": rec, "events": chain.events_for((rec or {}).get("kiln_id_bytes32"))}


@app.get("/api/chips/{name}")
def chip(name: str):
    if not _SAFE_CHIP.match(name):
        raise HTTPException(400, "Bad chip name.")
    p = DATA_DIR / "chips" / name
    if not p.exists():
        raise HTTPException(404, "No such chip.")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/inspect/queue")
def inspect_queue(district: str | None = None):
    return store.queue(district, chain.conflict_kilns())


@app.get("/api/ledger")
def ledger():
    c = store.chain
    seasons = []
    for season, m in sorted(store.merkle.items(), reverse=True):
        seasons.append(
            {
                "season": season,
                "root": m["root"],
                "tx": (c.get("season_txs") or {}).get(str(season)),
                "model_hash": store.summary.get("model_sha256") or store.summary.get("model_hashes"),
                "kilns": len(m.get("leaves", {})),
            }
        )
    return {
        "chain_id": c.get("chain_id"),
        "contract": c.get("contract"),
        "explorer": c.get("explorer_base"),
        "deploy_tx": c.get("deploy_tx"),
        "rpc": chain.rpc,
        "eip712": c.get("eip712"),
        "seasons": seasons,
        "events": chain.events()[:200],
        "fixture": FIXTURE,
    }


def _product_metrics() -> dict | None:
    """The product rule's measured behaviour on held-out test blocks, from the ML evaluation file."""
    import json

    p = DATA_DIR / "eval_results.json"
    if not p.exists():
        return None
    e = json.loads(p.read_text(encoding="utf-8"))
    prod = e.get("conformal_test_product") or {}
    n = prod.get("n") or 0
    calls = prod.get("n_set_fcbk")
    wrong = prod.get("n_set_fcbk_true_zigzag")
    det = e.get("detector_test") or {}
    by_class = e.get("coverage_by_class_product") or prod.get("coverage_by_class") or {}
    return {
        "n_test": n,
        "fcbk_calls": calls,
        "fcbk_calls_wrong": wrong,
        "fcbk_wrong_share": (wrong / calls) if calls else None,
        "refused_share": (prod.get("n_set_both", 0) / n) if n else None,
        "zigzag_certified": prod.get("n_set_zigzag"),
        "coverage": prod.get("coverage"),
        "coverage_fcbk": by_class.get("FCBK"),
        "coverage_zigzag": by_class.get("Zigzag"),
        "detector_recall": det.get("recall"),
        "detector_precision": det.get("precision"),
        "ltt_zigzag_floor": e.get("ltt_zig_min"),
    }


@app.get("/api/results")
def results():
    return {"targets": store.results, "product": _product_metrics(), "source": "docs/RESULTS.md", "prereg": "docs/PREREG.md"}


_FINDING_FIELDS = ("kiln_id", "season", "finding", "evidence_hash", "inspector", "nonce", "deadline", "signature")


def _relay(request_body: dict, action) -> dict:
    if not relay.configured:
        raise HTTPException(503, "The relay is not configured on this server.")
    try:
        return {"tx": action(request_body), "explorer": store.chain.get("explorer_base")}
    except RelayRejected as exc:
        raise HTTPException(400, f"The contract rejected this: {exc}")
    except (KeyError, ValueError, TypeError) as exc:
        raise HTTPException(422, f"Malformed request: {exc}")


@app.get("/api/audit")
def audit():
    """The human visual audit of a stratified sample, once Aashan has labelled it."""
    p = DATA_DIR / "audit" / "labels.json"
    if not p.exists():
        return {"n": 0, "agreed": 0, "disagreed": 0, "unsure": 0, "rows": [], "status": "Not yet run"}
    import json

    rows = json.loads(p.read_text(encoding="utf-8"))
    tally = {"agree": 0, "disagree": 0, "unsure": 0}
    out = []
    for r in rows:
        v = r.get("verdict", "unsure")
        tally[v] = tally.get(v, 0) + 1
        out.append({"id": r["id"], "model": r.get("model"), "human": r.get("human"), "agree": v == "agree" if v != "unsure" else None, "note": r.get("note")})
    return {"n": len(out), "agreed": tally["agree"], "disagreed": tally["disagree"], "unsure": tally["unsure"], "rows": out, "status": "Done"}


@app.post("/api/relay/attest")
async def relay_attest(request: Request):
    _rate_limit(request, limit=10, window=3600)
    body = await request.json()
    missing = [f for f in _FINDING_FIELDS if f not in body]
    if missing:
        raise HTTPException(422, f"Missing fields: {', '.join(missing)}")
    return _relay(body, lambda b: relay.attest(b, revise=bool(b.get("revise"))))


@app.post("/api/relay/dispute")
async def relay_dispute(request: Request):
    _rate_limit(request, limit=10, window=3600)
    body = await request.json() if await request.body() else {}
    missing = [f for f in ("kiln_id", "season", "evidence_hash") if f not in body]
    if missing:
        raise HTTPException(422, f"Missing fields: {', '.join(missing)}")
    return _relay(body, relay.dispute)


@app.exception_handler(HTTPException)
async def _http_error(_request: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "Not found.")
        f = WEB_DIST / path
        if path and f.is_file() and WEB_DIST.resolve() in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(WEB_DIST / "index.html", headers={"Cache-Control": "no-cache"})
