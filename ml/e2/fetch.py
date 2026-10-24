"""E2 data: multispectral, multi-date Sentinel-2 L2A chips around every labelled Pakistan kiln.

Kilns: exactly the pre-registered classifier set (ml/work/crops.csv: one row per unique kiln in
fit, val, cal, test), coordinates = label centroid from data/pk_kilns_2023.csv.

Per kiln: 24 x 24 px at 10 m centred on the label centroid, bands B2 B3 B4 B8 B5 B6 B7 B8A B11 B12
(20 m bands upsampled bilinear to the 10 m grid), from up to four dates between 2023-11-01 and
2024-02-29 with scene cloud cover < 5% and the kiln's local SCL clear (no nodata, saturated,
cloud shadow, cloud medium/high or cirrus pixel in the chip).

Source: Microsoft Planetary Computer STAC, collection sentinel-2-l2a (anonymous SAS token), windowed
COG reads. The pre-registered source was Element84 Earth Search; from this machine it delivered
about 0.85 MB/s with 12 connections against 4.4 MB/s from Planetary Computer with 16, which would
not fit the time box (docs/E2-RESULTS.md, Deviations). The Earth Search item list is kept in
data/e2/raw/items_earthsearch.json.
Each kiln is assigned one MGRS tile (the one whose full extent holds it with the most scenes
covering it, then the one where it is farthest from the tile edge), so its dates share one grid.
Per tile, scenes are tried in a fixed order (best scene of each month first, then the second best
of each month, ...), so most kilns of a tile share the same scenes and each COG is opened once
per tile.

Outputs (data/e2/raw/, gitignored): tiles/<tile>.npz per tile, then chips.npz merged.
Usage: ml/.venv/bin/python ml/e2/fetch.py [--plan-only] [--workers 6] [--tiles 43RDQ ...]
"""
from __future__ import annotations

import os

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIPLEX", "YES")
os.environ.setdefault("GDAL_HTTP_VERSION", "2")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", str(64 * 1024 * 1024))
os.environ.setdefault("GDAL_CACHEMAX", "1024")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "6")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")

import argparse
import json
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "e2"
RAW = OUT / "raw"
STAC_ES = "https://earth-search.aws.element84.com/v1"  # pre-registered source; too slow from here (Deviations)
STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
SAS = "https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a"
COLLECTION = "sentinel-2-l2a"
DATES = "2023-11-01/2024-02-29"
MAX_CC = 5.0
NDATES = 4
CHIP = 24
BANDS = [("B02", "B02", 10), ("B03", "B03", 10), ("B04", "B04", 10), ("B08", "B08", 10),
         ("B05", "B05", 20), ("B06", "B06", 20), ("B07", "B07", 20), ("B8A", "B8A", 20),
         ("B11", "B11", 20), ("B12", "B12", 20)]
BAD_SCL = {0, 1, 3, 8, 9, 10}  # nodata, saturated/defective, cloud shadow, cloud medium, cloud high, cirrus
MARGIN = 40  # px at 10 m: a kiln must sit this far inside the tile extent

_print_lock = threading.Lock()
_tok = {"t": None, "at": 0.0}
_tok_lock = threading.Lock()


def sign(href: str) -> str:
    """Append a Planetary Computer SAS token (anonymous; refreshed every 20 minutes)."""
    with _tok_lock:
        if _tok["t"] is None or time.time() - _tok["at"] > 1200:
            import urllib.request
            for k in range(5):
                try:
                    _tok["t"] = json.load(urllib.request.urlopen(SAS, timeout=30))["token"]; _tok["at"] = time.time(); break
                except Exception:  # noqa: BLE001
                    time.sleep(3)
        return f"{href}?{_tok['t']}"


def log(*a):
    with _print_lock:
        print(time.strftime("%H:%M:%S"), *a, flush=True)


def load_kilns() -> pd.DataFrame:
    crops = pd.read_csv(ROOT / "ml" / "work" / "crops.csv")
    k = pd.read_csv(ROOT / "data" / "pk_kilns_2023.csv")
    df = crops[["kid", "id", "subsplit", "cls2"]].merge(k[["kid", "lat", "lon", "split"]], on="kid", how="left")
    assert df.lat.notna().all() and len(df) == len(crops)
    return df.sort_values("kid").reset_index(drop=True)


def search_items(kilns: pd.DataFrame) -> list[dict]:
    cache = RAW / "items.json"
    if cache.exists():
        return json.load(open(cache))
    from pystac_client import Client
    c = Client.open(STAC)
    out = []
    # search in 2 x 2 degree cells that hold kilns, to keep requests small
    cells = sorted({(int(np.floor(la / 2)), int(np.floor(lo / 2))) for la, lo in zip(kilns.lat, kilns.lon)})
    seen = set()
    for (a, b) in cells:
        bbox = [b * 2 - 0.1, a * 2 - 0.1, b * 2 + 2.1, a * 2 + 2.1]
        s = c.search(collections=[COLLECTION], bbox=bbox, datetime=DATES,
                     query={"eo:cloud_cover": {"lt": MAX_CC}}, max_items=5000)
        for it in s.items():
            if it.id in seen:
                continue
            seen.add(it.id)
            p = it.properties
            red = it.assets["B04"]
            out.append(dict(id=it.id, tile=p["s2:mgrs_tile"],
                            date=p["datetime"][:10], cloud=p.get("eo:cloud_cover"),
                            nodata=p.get("s2:nodata_pixel_percentage"), epsg=p.get("proj:epsg") or red.extra_fields.get("proj:epsg"),
                            transform=red.extra_fields.get("proj:transform"), shape=red.extra_fields.get("proj:shape"),
                            baseline=p.get("s2:processing_baseline"), geometry=it.geometry,
                            hrefs={k: it.assets[k].href for _, k, _ in BANDS + [("SCL", "SCL", 20)]}))
        log(f"cell {a},{b}: {len(out)} items so far")
    json.dump(out, open(cache, "w"))
    return out


def plan(kilns: pd.DataFrame, items: list[dict]):
    from shapely.geometry import Point, shape
    from shapely.prepared import prep
    by_tile = defaultdict(list)
    for it in items:
        by_tile[it["tile"]].append(it)
    geoms = {it["id"]: prep(shape(it["geometry"])) for it in items}
    pts = [Point(lo, la) for lo, la in zip(kilns.lon, kilns.lat)]
    # pixel coords of every kiln in every tile's grid
    tile_info = {}
    for t, its in by_tile.items():
        it = its[0]
        tr = it["transform"]  # [a, b, c, d, e, f]
        x0, y0 = tr[2], tr[5]
        epsg = it["epsg"] or 32600 + int(t[:2])  # all kiln tiles are northern-hemisphere UTM
        xs, ys = warp_transform("EPSG:4326", f"EPSG:{epsg}", kilns.lon.tolist(), kilns.lat.tolist())
        col = (np.array(xs) - x0) / 10.0
        row = (y0 - np.array(ys)) / 10.0
        H, W = it["shape"][0] * (2 if tr[0] == 20 else 1), it["shape"][1] * (2 if tr[0] == 20 else 1)
        edge = np.minimum.reduce([col, row, W - col, H - row])
        tile_info[t] = dict(col=col, row=row, edge=edge)
    best_tile = []
    for i in range(len(kilns)):
        cands = []
        for t, ti in tile_info.items():
            if ti["edge"][i] < MARGIN:
                continue
            nsc = sum(1 for it in by_tile[t] if geoms[it["id"]].contains(pts[i]))
            cands.append((nsc, ti["edge"][i], t))
        if not cands:
            best_tile.append(None)
            continue
        cands.sort(reverse=True)
        best_tile.append(cands[0][2])
    kilns = kilns.copy()
    kilns["tile"] = best_tile
    kilns["col"] = [tile_info[t]["col"][i] if t else np.nan for i, t in enumerate(best_tile)]
    kilns["row"] = [tile_info[t]["row"][i] if t else np.nan for i, t in enumerate(best_tile)]
    # per-tile scene order: rank within month by (nodata share, cloud), then round-robin over months
    order = {}
    for t, its in by_tile.items():
        months = defaultdict(list)
        for it in its:
            months[it["date"][:7]].append(it)
        for m in months:
            months[m].sort(key=lambda it: ((it["nodata"] or 0) > 5, it["cloud"] or 0, it["nodata"] or 0))
        seq, r = [], 0
        while any(r < len(v) for v in months.values()):
            for m in sorted(months):
                if r < len(months[m]):
                    seq.append(months[m][r])
            r += 1
        order[t] = seq
    return kilns, order, geoms, pts


class Reader:
    """Opens each COG once per (scene, band) and reads many kiln windows from it."""

    def read_scl(self, href, cols, rows):
        """SCL (20 m) under each 10 m chip [c0, c0+24): a 13 x 13 window from (c0//2, r0//2).
        Returns the windows and a clear flag computed only over the 20 m pixels the chip touches
        (12 per axis for an even offset, 13 for an odd one)."""
        n = CHIP // 2 + 1
        out = np.zeros((len(cols), n, n), np.uint8)
        clear = np.zeros(len(cols), bool)
        with rasterio.open(href) as ds:
            for j, (c0, r0) in enumerate(zip(cols, rows)):
                a = ds.read(1, window=Window(c0 // 2, r0 // 2, n, n), boundless=True, fill_value=0)
                out[j] = a
                nc = (c0 + CHIP - 1) // 2 - c0 // 2 + 1
                nr = (r0 + CHIP - 1) // 2 - r0 // 2 + 1
                clear[j] = not np.isin(a[:nr, :nc], list(BAD_SCL)).any()
        return out, clear

    def read_band(self, href, res, cols, rows):
        out = np.zeros((len(cols), CHIP, CHIP), np.uint16)
        with rasterio.open(href) as ds:
            for j, (c0, r0) in enumerate(zip(cols, rows)):
                if res == 10:
                    out[j] = ds.read(1, window=Window(c0, r0, CHIP, CHIP), boundless=True, fill_value=0)
                else:
                    s0c, s0r = c0 // 2 - 1, r0 // 2 - 1
                    n = CHIP // 2 + 3
                    a = ds.read(1, window=Window(s0c, s0r, n, n), out_shape=(2 * n, 2 * n),
                                resampling=Resampling.bilinear, boundless=True, fill_value=0)
                    oc, orr = c0 - 2 * s0c, r0 - 2 * s0r
                    out[j] = a[orr:orr + CHIP, oc:oc + CHIP]
        return out


def fetch_tile(tile, tk: pd.DataFrame, scenes: list[dict], geoms, pts, pool: ThreadPoolExecutor, target: int, chunk=150):
    """Fill up to `target` dates per kiln, resuming from data/e2/raw/tiles/<tile>.npz if present.
    nxt[i] is the first scene index (in the tile's fixed order) not yet considered for kiln i."""
    path = RAW / "tiles" / f"{tile}.npz"
    n = len(tk)
    c0 = (np.round(tk.col.values) - CHIP // 2).astype(int)
    r0 = (np.round(tk.row.values) - CHIP // 2).astype(int)
    if path.exists():
        z = np.load(path)
        assert (z["kid"] == tk.kid.values).all()
        X, S, got, nxt = z["X"], z["S"], z["ndates"].copy(), z["nxt"].copy()
        sid = z["scene_ids"].astype(object)
    else:
        X = np.zeros((n, NDATES, len(BANDS), CHIP, CHIP), np.uint16)
        S = np.zeros((n, NDATES, CHIP // 2 + 1, CHIP // 2 + 1), np.uint8)
        got = np.zeros(n, int); nxt = np.zeros(n, int)
        sid = np.full((n, NDATES), "", dtype=object)
    if (got >= target).all() or (nxt >= len(scenes)).all():
        return tile, "nothing to do"
    kidx = tk.index.values
    inside = np.array([[geoms[sc["id"]].contains(pts[i]) for i in kidx] for sc in scenes])  # scenes x kilns
    rd = Reader()
    n_tried = 0
    for si, sc in enumerate(scenes):
        cand = (got < target) & (nxt <= si)
        if not cand.any():
            if ((got >= target) | (nxt > si)).all() and not ((got < target) & (nxt <= len(scenes) - 1)).any():
                break
            continue
        nxt[cand] = si + 1
        need = np.where(cand & inside[si])[0]
        if len(need) == 0:
            continue
        n_tried += 1
        need = need[np.lexsort((c0[need] // 512, r0[need] // 512))]
        parts = [need[i:i + chunk] for i in range(0, len(need), chunk)]
        try:
            res = list(pool.map(lambda q: rd.read_scl(sign(sc["hrefs"]["SCL"]), c0[q], r0[q]), parts))
        except Exception as e:  # noqa: BLE001
            log(f"{tile} {sc['id']} SCL failed: {e}")
            nxt[need] = si  # retry this scene next run
            continue
        scl = np.concatenate([r[0] for r in res]); clear = np.concatenate([r[1] for r in res])
        ok = need[clear]
        if len(ok) == 0:
            continue
        okparts = [ok[i:i + chunk] for i in range(0, len(ok), chunk)]
        futs = {pool.submit(rd.read_band, sign(sc["hrefs"][key]), res_, c0[q], r0[q]): (bi, pi)
                for bi, (_, key, res_) in enumerate(BANDS) for pi, q in enumerate(okparts)}
        arrs = {}
        failed = False
        for f in as_completed(futs):
            try:
                arrs[futs[f]] = f.result()
            except Exception as e:  # noqa: BLE001
                log(f"{tile} {sc['id']} band {BANDS[futs[f][0]][0]} failed: {e}")
                failed = True
        if failed:
            nxt[ok] = si
            continue
        stack = np.stack([np.concatenate([arrs[(b, pi)] for pi in range(len(okparts))]) for b in range(len(BANDS))], 1)
        valid = (stack > 0).all(axis=(1, 2, 3))
        pos = {k: j for j, k in enumerate(need)}
        for j, i in enumerate(ok):
            if not valid[j]:
                continue
            d = got[i]
            X[i, d] = stack[j]
            S[i, d] = scl[pos[i]]
            sid[i, d] = sc["id"]
            got[i] += 1
        log(f"{tile} [{si}] {sc['id'][:44]}: need {len(need)}, clear {len(ok)}, kept {int(valid.sum())}; "
            f"kilns with >= {target} dates {int((got >= target).sum())}/{n}")
    np.savez(path, kid=tk.kid.values, X=X, S=S, ndates=got, nxt=nxt, scene_ids=sid.astype(str),
             c0=c0, r0=r0, col=tk.col.values, row=tk.row.values)
    return tile, f"target {target}: {n_tried} scenes read, dates per kiln {np.bincount(got, minlength=NDATES + 1).tolist()}"


def merge(kilns: pd.DataFrame):
    parts = sorted((RAW / "tiles").glob("*.npz"))
    kid, X, nd, sids, c0, r0, col, row, tiles = [], [], [], [], [], [], [], [], []
    for p in parts:
        z = np.load(p, allow_pickle=False)
        kid.append(z["kid"]); X.append(z["X"]); nd.append(z["ndates"]); sids.append(z["scene_ids"])
        col.append(z["col"]); row.append(z["row"]); c0.append(z["c0"]); r0.append(z["r0"])
        tiles += [p.stem] * len(z["kid"])
    kid = np.concatenate(kid); o = np.argsort(kid)
    X = np.concatenate(X)[o]; nd = np.concatenate(nd)[o]; sids = np.concatenate(sids)[o]
    col = np.concatenate(col)[o]; row = np.concatenate(row)[o]; tiles = np.array(tiles)[o]
    c0 = np.concatenate(c0)[o]; r0 = np.concatenate(r0)[o]
    np.save(RAW / "X.npy", X)
    meta = kilns.set_index("kid").loc[kid[o]].reset_index()
    meta["tile"] = tiles; meta["ndates"] = nd
    meta["col_frac"] = col - c0 - CHIP // 2; meta["row_frac"] = row - r0 - CHIP // 2
    for d in range(NDATES):
        meta[f"scene{d}"] = sids[:, d]
    meta.to_csv(OUT / "chips_meta.csv", index=False)
    log(f"merged {len(meta)} kilns, X {X.shape} {X.nbytes / 1e6:.0f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--merge-only", action="store_true")
    ap.add_argument("--workers", type=int, default=10, help="tiles in parallel")
    ap.add_argument("--band-workers", type=int, default=48)
    ap.add_argument("--tiles", nargs="*")
    ap.add_argument("--target", type=int, default=NDATES, help="dates per kiln to reach in this run (rounds 1, 2, 4)")
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True); (RAW / "tiles").mkdir(exist_ok=True)
    kilns = load_kilns()
    if args.merge_only:
        merge(kilns); return
    items = search_items(kilns)
    log(f"{len(items)} items, {len({i['tile'] for i in items})} tiles; baselines {sorted({i['baseline'] for i in items})}")
    kilns, order, geoms, pts = plan(kilns, items)
    miss = kilns.tile.isna().sum()
    log(f"kilns without a tile: {miss}")
    counts = kilns.tile.value_counts()
    log("kilns per tile: " + ", ".join(f"{t}:{n}" for t, n in counts.items()))
    kilns.to_csv(RAW / "plan.csv", index=False)
    if args.plan_only:
        return
    tiles = args.tiles or list(counts.index)
    band_pool = ThreadPoolExecutor(args.band_workers)
    with ThreadPoolExecutor(args.workers) as tp:
        futs = [tp.submit(fetch_tile, t, kilns[kilns.tile == t], order[t], geoms, pts, band_pool, args.target) for t in tiles]
        for f in as_completed(futs):
            try:
                t, msg = f.result(); log(f"TILE {t}: {msg}")
            except Exception as e:  # noqa: BLE001
                log(f"TILE failed: {e!r}")
    band_pool.shutdown()
    if not args.tiles:
        merge(kilns)


if __name__ == "__main__":
    main()
