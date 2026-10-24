"""Live scan: October 2026 Sentinel-2 L2A over Pakistan kiln districts.

For each district (geoBoundaries ADM2 PAK):
* scenes: Element84 Earth Search STAC, collection sentinel-2-l2a, October 2026. Per MGRS tile the
  most recent scene with eo:cloud_cover < 1 (the dataset used CLOUDY_PIXEL_PERCENTAGE < 1), else
  the least cloudy one. Pixels are filled from scenes in priority order (newest first) wherever
  the scene is valid (bands non-zero and SCL not no-data, saturated, cloud shadow, cloud or cirrus).
* rendering: exactly as SentinelKilnDB. Bands B04, B03, B02 reprojected with nearest neighbour to
  EPSG:4326 at 10/111319.49 degrees per pixel, 128 px patches on a fixed global grid with a 98 px
  stride (30 px overlap), each patch min-max scaled per band to uint8.
* mode "full": every patch whose centre lies in the district (buffered 0.012 deg) is scanned, so
  new kilns can be found. Mode "known": only patches holding a 2023-24 hand-labelled kiln, so every
  known kiln is checked and new kilns are only found next to known ones.
* detector (YOLO OBB) then classifier crop (32 px around the detection, 8-view TTA) then split
  conformal set with the calibrated qhat (and the post-hoc Zigzag floor if T6 missed).
* detections are merged across overlapping patches (centres within 30 m) and matched one-to-one to
  2023-24 kilns within 100 m, greedy by distance.

Everything runs on CPU with deterministic torch settings so the output can be recomputed.

Usage:
  ml/.venv/bin/python ml/scan.py --districts Lahore Kasur Sheikhpura --mode full
  ml/.venv/bin/python ml/scan.py --all-known            # every other district with kilns, known mode
  ml/.venv/bin/python ml/scan.py --merge                # write data/kilns.json, summary, manifest, sample
  ml/.venv/bin/python ml/scan.py --districts Lahore --from-manifest data/manifest.json --out-dir /tmp/x
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ALPHA, CLS2, CROP, DATA, PATCH, PIX_DEG, RAW, ROOT, SEED, geohash, render_rgb, sha256

os.environ.setdefault("AWS_NO_SIGN_REQUEST", "YES")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif")
os.environ.setdefault("GDAL_HTTP_MULTIRANGE", "YES")
os.environ.setdefault("GDAL_HTTP_MERGE_CONSECUTIVE_RANGES", "YES")
os.environ.setdefault("VSI_CACHE", "TRUE")
os.environ.setdefault("VSI_CACHE_SIZE", str(512 * 1024 * 1024))
os.environ.setdefault("GDAL_CACHEMAX", "2048")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "5")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "2")
os.environ.setdefault("CPL_VSIL_CURL_CACHE_SIZE", str(1536 * 1024 * 1024))  # shared block cache across handles

STAC = "https://earth-search.aws.element84.com/v1"
COLLECTION = "sentinel-2-l2a"
DATE_RANGE = "2026-10-01/2026-10-31"
STRIDE = 98
CHUNK_P = 12                      # patches per chunk side
CHUNK_PX = STRIDE * CHUNK_P       # 1176 px
MARGIN = 64
CHUNK_W = STRIDE * (CHUNK_P - 1) + PATCH + 2 * MARGIN  # 1334
BAD_SCL = {0, 1, 3, 8, 9, 10}
MAX_INVALID_FRAC = 0.02
MERGE_KM = 0.050
NEW_MIN_CONF = 0.60  # stricter confidence for a kiln not in the 2023-24 labels (val precision 0.937 at 0.60)
NEW_MIN_KM = 0.150  # an unmatched detection counts as a new kiln only this far from every 2023-24 kiln
MATCH_KM = 0.100
CHIP = 64
SCENES_PER_TILE = 3
READ_THREADS = 20
CACHE_DIR = RAW / "mosaics"   # local cache of fetched chunks, keyed by the scene list (gitignored)
USE_CACHE = True
TORCH_THREADS = 4
SCAN_DIR = DATA / "scan"
WDIR = Path(__file__).resolve().parent / "weights"
ADM2 = RAW / "boundaries" / "pak_adm2.geojson"
ADM2_URL = "https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/PAK/ADM2/geoBoundaries-PAK-ADM2.geojson"


# ----------------------------------------------------------------------------- grid helpers
def col_of(lon):
    return np.floor(np.asarray(lon) / PIX_DEG).astype(np.int64)


def row_of(lat):
    return np.floor(-np.asarray(lat) / PIX_DEG).astype(np.int64)


def lon_of(col):
    return np.asarray(col, dtype=np.float64) * PIX_DEG


def lat_of(row):
    return -np.asarray(row, dtype=np.float64) * PIX_DEG


def km_dist(lat1, lon1, lat2, lon2):
    return math.hypot((lon1 - lon2) * 111.32 * math.cos(math.radians((lat1 + lat2) / 2)), (lat1 - lat2) * 111.32)


def chunk_origin(a, b):
    """Global (col, row) of the top-left pixel of chunk (a, b) raster, margin included."""
    return a * CHUNK_PX - MARGIN, b * CHUNK_PX - MARGIN


# ----------------------------------------------------------------------------- inputs
def load_districts():
    from shapely.geometry import shape
    if not ADM2.exists():
        subprocess.run(["curl", "-sL", "-o", str(ADM2), ADM2_URL], check=True)
    d = json.load(open(ADM2))
    return {f["properties"]["shapeName"]: shape(f["geometry"]) for f in d["features"]}


def assign_district(lats, lons, districts):
    from shapely import STRtree, points
    names = sorted(districts)
    geoms = [districts[n] for n in names]
    tree = STRtree(geoms)
    pts = points(np.c_[lons, lats])
    res = [None] * len(pts)
    idx = tree.query(pts, predicate="within")
    for pi, gi in zip(*idx):
        if res[pi] is None:
            res[pi] = names[gi]
    return res


def load_known():
    k = pd.read_csv(DATA / "pk_kilns_2023.csv")
    return k.sort_values("id").reset_index(drop=True)


# ----------------------------------------------------------------------------- scenes
def select_scenes(bbox):
    from pystac_client import Client
    c = Client.open(STAC)
    items = list(c.search(collections=[COLLECTION], bbox=list(bbox), datetime=DATE_RANGE, max_items=2000).items())
    by_tile = defaultdict(list)
    for it in items:
        by_tile[it.properties.get("grid:code")].append(it)
    chosen = []
    for tile, its in sorted(by_tile.items()):
        # cloud-free (< 1%, as the dataset) October scenes; late October is smog season, so rank
        # them by Sen2Cor aerosol optical thickness (clearest first, newest as tie-break). An
        # acquisition can cover only part of a tile (swath edge), so keep a few per tile; pixels
        # are filled in priority order and later scenes only fill gaps.
        clear = [i for i in its if (i.properties.get("eo:cloud_cover") if i.properties.get("eo:cloud_cover") is not None else 100) < 1]
        if not clear:
            clear = sorted(its, key=lambda i: (i.properties.get("eo:cloud_cover") or 100, i.id))[:SCENES_PER_TILE]
        recs = [scene_record(i) for i in clear]
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(8) as ex:
            aots = list(ex.map(scene_aot, recs))
        for r, a in zip(recs, aots):
            r["aot_median"] = a
        recs.sort(key=lambda r: (r["aot_median"] if r["aot_median"] is not None else 9e9, tuple(-ord(c) for c in r["datetime"]), r["id"]))
        chosen.extend(recs[:SCENES_PER_TILE])
    return order_scenes(chosen)


def scene_aot(rec):
    """Median Sen2Cor AOT (scaled x1000) over the valid part of the scene, from a 128 px overview read."""
    import rasterio
    href = rec["assets"]["red"].rsplit("/", 1)[0] + "/AOT.tif"
    try:
        with rasterio.open(href) as src:
            a = src.read(1, out_shape=(128, 128))
        a = a[a > 0]
        return float(np.median(a)) if a.size else None
    except Exception:
        return None


def scene_record(it):
    return dict(id=it.id, datetime=it.properties["datetime"], date=it.properties["datetime"][:10],
                cloud_cover=it.properties.get("eo:cloud_cover"), tile=it.properties.get("grid:code"),
                bbox=list(it.bbox), boa_offset_applied=it.properties.get("earthsearch:boa_offset_applied"),
                processing_baseline=it.properties.get("s2:processing_baseline"),
                assets={k: it.assets[k].href for k in ("red", "green", "blue", "scl")})


def order_scenes(scenes):
    # fixed per-pixel fill priority: lowest AOT first, then newest, then id
    return sorted(scenes, key=lambda s: (s.get("aot_median") if s.get("aot_median") is not None else 9e9,
                                         tuple(-ord(c) for c in s["datetime"]), s["id"]))


# ----------------------------------------------------------------------------- mosaic
class Reader:
    def __init__(self):
        self.open = {}

    def ds(self, href):
        import rasterio
        if href not in self.open:
            self.open[href] = rasterio.open(href)
        return self.open[href]

    def read_chunk(self, a, b, scenes, need=None):
        """Return rgb uint16 (3,H,W), scene index uint8 (255 = no valid pixel). Only the local
        pixel box need = (x0, y0, x1, y1) is filled (whole chunk if None)."""
        from affine import Affine
        from rasterio.enums import Resampling
        from rasterio.vrt import WarpedVRT
        from rasterio.windows import Window
        want = np.zeros((CHUNK_W, CHUNK_W), bool)
        if need is None:
            want[:] = True
        else:
            want[need[1]:need[3], need[0]:need[2]] = True
        c0, r0 = chunk_origin(a, b)
        lon0, lat0 = float(lon_of(c0)), float(lat_of(r0))
        lon1, lat1 = float(lon_of(c0 + CHUNK_W)), float(lat_of(r0 + CHUNK_W))
        tr = Affine(PIX_DEG, 0.0, lon0, 0.0, -PIX_DEG, lat0)
        rgb = np.zeros((3, CHUNK_W, CHUNK_W), np.uint16)
        sidx = np.full((CHUNK_W, CHUNK_W), 255, np.uint8)
        for si, s in enumerate(scenes):
            bx = s["bbox"]
            if bx[0] > lon1 or bx[2] < lon0 or bx[1] > lat0 or bx[3] < lat1:
                continue
            todo = (sidx == 255) & want
            if not todo.any():
                break
            rows = np.flatnonzero(todo.any(1)); cols = np.flatnonzero(todo.any(0))
            y0, y1, x0, x1 = int(rows[0]), int(rows[-1]) + 1, int(cols[0]), int(cols[-1]) + 1
            win = Window(x0, y0, x1 - x0, y1 - y0)
            bands = []
            for key in ("red", "green", "blue", "scl"):
                src = self.ds(s["assets"][key])
                with WarpedVRT(src, crs="EPSG:4326", transform=tr, width=CHUNK_W, height=CHUNK_W,
                               resampling=Resampling.nearest, nodata=0) as vrt:
                    bands.append(vrt.read(1, window=win))
            r, g, bl, scl = bands
            ok = ((r > 0) | (g > 0) | (bl > 0)) & ~np.isin(scl, list(BAD_SCL)) & todo[y0:y1, x0:x1]
            for ch, arr in enumerate((r, g, bl)):
                rgb[ch, y0:y1, x0:x1][ok] = arr[ok]
            sidx[y0:y1, x0:x1][ok] = si
        return rgb, sidx


# ----------------------------------------------------------------------------- models
def load_models():
    import torch
    torch.use_deterministic_algorithms(True)
    torch.set_num_threads(TORCH_THREADS)
    torch.manual_seed(SEED)
    from ultralytics import YOLO
    from train_classifier import load_classifier
    det = YOLO(str(WDIR / "detector.pt"))
    clf = load_classifier(WDIR / "classifier.pt", "cpu")  # (model, cfg)
    return det, clf


def model_params():
    """Product rule: Mondrian (per-class) qhat, plus the Learn-then-Test p(Zigzag) floor for a
    {Zigzag} certificate (1.01, i.e. never certify, if no floor passed on calibration)."""
    ev = json.load(open(DATA / "eval_results.json"))
    cj = json.load(open(DATA / "conformal.json"))
    zig_min = cj["ltt"]["zig_min"] if cj["ltt"]["zig_min"] is not None else 1.01
    return dict(det_conf=ev["detector_threshold"], qhat=cj["mondrian_qhat"], qhat_marginal=cj["qhat"], alpha=ALPHA, zig_min=zig_min,
                imgsz=256, detector_sha256=sha256(WDIR / "detector.pt"),
                classifier_sha256=sha256(WDIR / "classifier.pt"))


# ----------------------------------------------------------------------------- district scan
def patches_for(dname, mode, districts, known):
    """Global patch indices (i, j) to scan: top-left col = 98 i, row = 98 j."""
    P = set()
    kd = known[known.district == dname]
    kc, kr = col_of(kd.lon.values), row_of(kd.lat.values)
    for c, r in zip(kc, kr):
        P.update(kiln_patches(int(c), int(r)))
    if mode == "full":
        from shapely import contains_xy
        poly = districts[dname].buffer(0.012)
        x0, y0, x1, y1 = poly.bounds
        i0, i1 = int(col_of(x0) // STRIDE) - 1, int(col_of(x1) // STRIDE) + 1
        j0, j1 = int(row_of(y1) // STRIDE) - 1, int(row_of(y0) // STRIDE) + 1
        ii, jj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        ii, jj = ii.ravel(), jj.ravel()
        lon_c = lon_of(ii * STRIDE + PATCH / 2)
        lat_c = lat_of(jj * STRIDE + PATCH / 2)
        m = contains_xy(poly, lon_c, lat_c)
        P.update(zip(ii[m].tolist(), jj[m].tolist()))
    return sorted(P)


def classify(clf, crops):
    import torch
    from train_classifier import predict_probs, to_tensor
    if not crops:
        return np.zeros((0, 2), np.float32)
    model, cfg = clf
    x = torch.stack([to_tensor(c, cfg["input"]) for c in crops])
    return predict_probs(model, x, torch.device("cpu"), tta=True)


def conformal_set(p, qhat, zig_min):
    qd = qhat if isinstance(qhat, dict) else {c: qhat for c in CLS2}
    s = [CLS2[c] for c in range(2) if 1.0 - p[c] <= qd[CLS2[c]]]
    if zig_min is not None and s == ["Zigzag"] and p[1] < zig_min:
        s = ["FCBK", "Zigzag"]
    return s


def chip_from(rgb, c0, r0, col, row):
    """Render a 128 px window centred on (col,row) like a dataset patch and return the centre CHIP."""
    lc, lr = int(col - c0), int(row - r0)
    w = rgb[:, lr - 64:lr + 64, lc - 64:lc + 64]
    if w.shape[1:] != (128, 128):
        return None
    img = render_rgb(w[0], w[1], w[2])
    h = CHIP // 2
    return img[64 - h:64 + h, 64 - h:64 + h]


_baseline_imgs = {}


def _load_baseline_imgs():
    if not _baseline_imgs:
        import pyarrow.parquet as pq
        for s in ("train", "val", "test"):
            t = pq.read_table(RAW / f"pk_{s}.parquet", columns=["image_name", "image"])
            for a, b in zip(t.column(0).to_pylist(), t.column(1).to_pylist()):
                _baseline_imgs[a] = b


def baseline_chip(row):
    """CHIP crop around the kiln from its 2023-24 SentinelKilnDB patch."""
    from common import lonlat_to_norm, parse_name
    nm = row.best_patch
    if not isinstance(nm, str):
        return None
    _load_baseline_imgs()
    arr = np.array(Image.open(io.BytesIO(_baseline_imgs[nm])).convert("RGB"))
    lat_c, lon_c = parse_name(nm)
    u, v = lonlat_to_norm(np.array([row.lon]), np.array([row.lat]), lat_c, lon_c)
    cx, cy = int(round(u[0] * PATCH)), int(round(v[0] * PATCH))
    h = CHIP // 2
    pad = np.pad(arr, ((h, h), (h, h), (0, 0)), mode="reflect")
    return pad[cy:cy + CHIP, cx:cx + CHIP]


def save_png(arr, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr).save(path, optimize=False, compress_level=6)


def scan_district(dname, mode, scenes, params, districts, known, det, clf, out_dir: Path, chip_root: Path, log=print,
                  fetch_only=False):
    t0 = time.time()
    P = patches_for(dname, mode, districts, known)
    chunks = defaultdict(list)
    for i, j in P:
        chunks[(i // CHUNK_P, j // CHUNK_P)].append((i, j))
    log(f"[{dname}] mode={mode} patches={len(P)} chunks={len(chunks)} scenes={[s['id'] for s in scenes]}")
    import threading
    from concurrent.futures import ThreadPoolExecutor
    tl = threading.local()

    import hashlib
    skey = hashlib.sha256(json.dumps([sc["id"] for sc in scenes]).encode()).hexdigest()[:16]
    cdir = CACHE_DIR / skey

    def need_box(ab):
        c0, r0 = chunk_origin(*ab)
        xs = [i * STRIDE - c0 for i, _ in chunks[ab]]
        ys = [j * STRIDE - r0 for _, j in chunks[ab]]
        return (max(min(xs) - 64, 0), max(min(ys) - 64, 0), min(max(xs) + PATCH + 64, CHUNK_W), min(max(ys) + PATCH + 64, CHUNK_W))

    def read(ab):
        f = cdir / f"{ab[0]}_{ab[1]}.npz"
        nb = need_box(ab)
        if USE_CACHE and f.exists():
            z = np.load(f)
            cb = tuple(z["need"]) if "need" in z else (0, 0, CHUNK_W, CHUNK_W)
            if cb[0] <= nb[0] and cb[1] <= nb[1] and cb[2] >= nb[2] and cb[3] >= nb[3]:
                rgb, sidx = z["rgb"], z["sidx"].copy()
                # use exactly the requested box so cached and network runs see the same pixels
                mask = np.ones_like(sidx, bool); mask[nb[1]:nb[3], nb[0]:nb[2]] = False
                sidx[mask] = 255
                return rgb, sidx
        if not hasattr(tl, "reader"):
            tl.reader = Reader()
        rgb, sidx = tl.reader.read_chunk(ab[0], ab[1], scenes, need=nb)
        if USE_CACHE:
            cdir.mkdir(parents=True, exist_ok=True)
            tmp = cdir / f"{ab[0]}_{ab[1]}.tmp.npz"
            np.savez_compressed(tmp, rgb=rgb, sidx=sidx, need=np.array(nb))
            tmp.rename(f)
        return rgb, sidx

    pool = ThreadPoolExecutor(READ_THREADS)
    futs = {ab: pool.submit(read, ab) for ab in sorted(chunks)}
    if fetch_only:
        for i, ab in enumerate(sorted(chunks)):
            futs[ab].result()
            if (i + 1) % 20 == 0:
                log(f"[{dname}] fetched {i + 1}/{len(chunks)} ({time.time() - t0:.0f}s)")
        pool.shutdown()
        log(f"[{dname}] fetch done {len(chunks)} chunks ({time.time() - t0:.0f}s)")
        return None
    mosaics = {}
    dets = []  # global detections
    n_skipped = 0
    scanned = set()
    for ci, (a, b) in enumerate(sorted(chunks)):
        rgb, sidx = futs.pop((a, b)).result()
        mosaics[(a, b)] = (rgb, sidx)
        c0, r0 = chunk_origin(a, b)
        imgs, metas = [], []
        for i, j in sorted(chunks[(a, b)]):
            lc, lr = i * STRIDE - c0, j * STRIDE - r0
            inv = sidx[lr:lr + PATCH, lc:lc + PATCH] == 255
            if inv.mean() > MAX_INVALID_FRAC:
                n_skipped += 1
                continue
            w = rgb[:, lr:lr + PATCH, lc:lc + PATCH]
            img = render_rgb(w[0], w[1], w[2])
            scanned.add((i, j))
            imgs.append(img)
            metas.append((i, j))
        if imgs:
            res = det.predict([im[..., ::-1].copy() for im in imgs], imgsz=params["imgsz"], conf=params["det_conf"],
                              iou=0.5, device="cpu", verbose=False, half=False, batch=64)
            for img, (i, j), r in zip(imgs, metas, res):
                if r.obb is None or len(r.obb) == 0:
                    continue
                pts = r.obb.xyxyxyxy.cpu().numpy().astype(np.float64)
                conf = r.obb.conf.cpu().numpy().astype(np.float64)
                for k in range(len(conf)):
                    cx, cy = pts[k][:, 0].mean(), pts[k][:, 1].mean()
                    gcol, grow = i * STRIDE + cx, j * STRIDE + cy
                    dets.append(dict(lon=float(lon_of(gcol)), lat=float(lat_of(grow)), conf=float(conf[k]),
                                     cen=float(math.hypot(cx - 64, cy - 64)), img=img, cx=cx, cy=cy,
                                     gcol=gcol, grow=grow, chunk=(a, b)))
        if (ci + 1) % 10 == 0 or ci + 1 == len(chunks):
            log(f"[{dname}] chunk {ci + 1}/{len(chunks)} dets so far {len(dets)} ({time.time() - t0:.0f}s)")

    pool.shutdown()
    # merge detections across overlapping patches
    merged = []
    if dets:
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        from scipy.spatial import cKDTree
        xy = np.c_[[d["lon"] * 111.32 * math.cos(math.radians(d["lat"])) for d in dets], [d["lat"] * 111.32 for d in dets]]
        pairs = cKDTree(xy).query_pairs(r=MERGE_KM, output_type="ndarray")
        n = len(dets)
        g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n)) if len(pairs) else coo_matrix((n, n))
        _, lab = connected_components(g, directed=False)
        groups = defaultdict(list)
        for idx, l in enumerate(lab):
            groups[l].append(idx)
        for l, idxs in groups.items():
            rep = min(idxs, key=lambda q: (dets[q]["cen"], -dets[q]["conf"], dets[q]["lon"], dets[q]["lat"]))
            d = dict(dets[rep])
            d["conf"] = max(dets[q]["conf"] for q in idxs)
            merged.append(d)
        merged.sort(key=lambda d: (round(d["lat"], 7), round(d["lon"], 7)))
    # classify from the most central copy
    crops = []
    for d in merged:
        pad = np.pad(d["img"], ((CROP, CROP), (CROP, CROP), (0, 0)), mode="reflect")
        cc = clf[1]["crop"]
        x0, y0 = int(round(d["cx"] - cc / 2)) + CROP, int(round(d["cy"] - cc / 2)) + CROP
        crops.append(np.ascontiguousarray(pad[y0:y0 + cc, x0:x0 + cc]))
    probs = classify(clf, crops)

    # per-patch georeference check of the 2023-24 labels against the October 2026 mosaic
    kl = known.reset_index(drop=True).copy()
    kl["lon0"], kl["lat0"] = kl.lon, kl.lat
    offs = align_known(kl, mosaics)
    # a shift shared by many kilns imaged by the same scene is a scene misregistration; use the
    # per-scene median shift for kilns whose own alignment was not possible, and to put new
    # detections back on the dataset's frame
    by_scene = defaultdict(list)
    for ki, o in offs.items():
        if o[4] != 255:
            by_scene[o[4]].append((o[0], o[1]))
    scene_shift = {}
    for si, v in by_scene.items():
        if len(v) >= 5:
            a = np.array(v)
            scene_shift[si] = (int(np.median(a[:, 0])), int(np.median(a[:, 1])))

    def sidx_at(col, row):
        ab = find_chunk(col, row, mosaics, need=1)
        if ab is None:
            return 255
        c0_, r0_ = chunk_origin(*ab)
        return int(mosaics[ab][1][row - r0_, col - c0_])

    applied = {}
    for ki in kl.index:
        if ki in offs:
            dx, dy = offs[ki][0], offs[ki][1]
        else:
            si = sidx_at(int(col_of(kl.lon0[ki])), int(row_of(kl.lat0[ki])))
            dx, dy = scene_shift.get(si, (0, 0))
        if dx or dy:
            applied[ki] = (dx, dy)
            kl.loc[ki, "lon"] = kl.lon0[ki] + dx * PIX_DEG
            kl.loc[ki, "lat"] = kl.lat0[ki] - dy * PIX_DEG
    # match to ALL 2023-24 kilns within 100 m, greedy by distance
    match_of_det, match_of_kiln = {}, {}
    if merged:
        from scipy.spatial import cKDTree
        kxy = np.c_[kl.lon.values * 111.32 * np.cos(np.radians(kl.lat.values)), kl.lat.values * 111.32]
        dxy = np.c_[[d["lon"] * 111.32 * math.cos(math.radians(d["lat"])) for d in merged], [d["lat"] * 111.32 for d in merged]]
        sdm = cKDTree(dxy).sparse_distance_matrix(cKDTree(kxy), MATCH_KM, output_type="ndarray")
        for di, ki, dist in sorted(sdm.tolist(), key=lambda t: (t[2], t[0], t[1])):
            di, ki = int(di), int(ki)
            if di in match_of_det or ki in match_of_kiln:
                continue
            match_of_det[di], match_of_kiln[ki] = ki, di

    def scene_at(col, row):
        ab = find_chunk(col, row, mosaics, need=3)
        if ab is None:
            return None, None
        a, b = ab
        rgb, sidx = mosaics[(a, b)]
        c0, r0 = chunk_origin(a, b)
        lc, lr = int(col - c0), int(row - r0)
        win = sidx[lr - 2:lr + 3, lc - 2:lc + 3]
        if win.size == 0 or (win == 255).any():
            return None, (a, b)
        return scenes[int(sidx[lr, lc])], (a, b)

    records = []
    year_now = "2026"

    def obs_chip(kid, col, row):
        ab = find_chunk(col, row, mosaics, need=64)
        if ab is None:
            return None
        a, b = ab
        c0, r0 = chunk_origin(a, b)
        ch = chip_from(mosaics[(a, b)][0], c0, r0, int(col), int(row))
        if ch is None:
            return None
        rel = f"chips/{kid}_{year_now}.png"
        save_png(ch, chip_root / rel)
        return rel

    # 2023-24 kilns in this district
    kd_idx = kl.index[kl.district == dname].tolist()
    for ki in kd_idx:
        k = kl.loc[ki]
        col, row = int(col_of(k.lon)), int(row_of(k.lat))
        bchip = baseline_chip(k.rename({"lon": "lon_c", "lat": "lat_c", "lon0": "lon", "lat0": "lat"}))
        brel = None
        if bchip is not None:
            brel = f"chips/{k.id}_2023.png"
            save_png(bchip, chip_root / brel)
        if ki in match_of_kiln:
            d = merged[match_of_kiln[ki]]
            p = probs[match_of_kiln[ki]]
            s = conformal_set(p, params["qhat"], params["zig_min"])
            sc, _ = scene_at(int(d["gcol"]), int(d["grow"]))
            if sc is None:
                sc, _ = scene_at(col, row)
            obs = dict(scene_id=sc["id"] if sc else None, date=sc["date"] if sc else None, detected=True,
                       det_conf=round(d["conf"], 3), probs={"FCBK": round(float(p[0]), 4), "Zigzag": round(float(p[1]), 4)},
                       set=s, chip=obs_chip(k.id, col, row), baseline_chip=brel)
            status = status_of(s)
        else:
            sc, ch = scene_at(col, row)
            usable = sc is not None and any(pp in scanned for pp in kiln_patches(col, row))
            obs = dict(scene_id=sc["id"] if sc else None, date=sc["date"] if sc else None, detected=False,
                       det_conf=None, probs=None, set=None, chip=obs_chip(k.id, col, row), baseline_chip=brel)
            status = "NOT_DETECTED" if usable else "UNDETERMINED"
        records.append(dict(id=k.id, lat=round(float(k.lat0), 6), lon=round(float(k.lon0), 6), district=dname,
                            baseline=dict(source="SentinelKilnDB hand label", period="2023-09/2024-02", **{"class": k.cls_src}),
                            observation=obs, status=status))
    # new detections located in this district
    new_idx = [di for di in range(len(merged)) if di not in match_of_det]
    if new_idx:
        from scipy.spatial import cKDTree
        ktree = cKDTree(np.c_[kl.lon.values * 111.32 * np.cos(np.radians(kl.lat.values)), kl.lat.values * 111.32])
        far = []
        for di in new_idx:
            d = merged[di]
            dist, _ = ktree.query([d["lon"] * 111.32 * math.cos(math.radians(d["lat"])), d["lat"] * 111.32])
            if dist >= NEW_MIN_KM and d["conf"] >= NEW_MIN_CONF:
                far.append(di)
        n_dup_near_known = len(new_idx) - len(far)  # near a known kiln, or below NEW_MIN_CONF
        new_idx = far
    else:
        n_dup_near_known = 0
    for di in new_idx:  # back to the dataset frame
        d = merged[di]
        dx, dy = scene_shift.get(sidx_at(int(d["gcol"]), int(d["grow"])), (0, 0))
        d["lat_true"], d["lon_true"] = d["lat"] + dy * PIX_DEG, d["lon"] - dx * PIX_DEG
    if new_idx:
        dd = assign_district([merged[di]["lat_true"] for di in new_idx], [merged[di]["lon_true"] for di in new_idx], districts)
        existing = set(kl.id)
        for di, dn in zip(new_idx, dd):
            if dn != dname:
                continue
            d = merged[di]
            p = probs[di]
            s = conformal_set(p, params["qhat"], params["zig_min"])
            kid = f"PK-{geohash(d['lat_true'], d['lon_true'])}"
            while kid in existing:
                kid += "x"
            existing.add(kid)
            sc, _ = scene_at(int(d["gcol"]), int(d["grow"]))
            obs = dict(scene_id=sc["id"] if sc else None, date=sc["date"] if sc else None, detected=True,
                       det_conf=round(d["conf"], 3), probs={"FCBK": round(float(p[0]), 4), "Zigzag": round(float(p[1]), 4)},
                       set=s, chip=obs_chip(kid, int(d["gcol"]), int(d["grow"])), baseline_chip=None)
            records.append(dict(id=kid, lat=round(d["lat_true"], 6), lon=round(d["lon_true"], 6), district=dname,
                                baseline=None, observation=obs, status=status_of(s)))
    records.sort(key=lambda r: r["id"])
    stats = dict(district=dname, mode=mode, patches_planned=len(P), patches_skipped_invalid=n_skipped,
                 chunks=len(chunks), detections_raw=len(dets), detections_merged=len(merged),
                 known_kilns=len(kd_idx), known_kilns_aligned=sum(1 for ki in kd_idx if ki in offs),
                 known_kilns_shifted=sum(1 for ki in kd_idx if ki in offs and (offs[ki][0] or offs[ki][1])),
                 scene_shift_px={scenes[si]["id"]: list(v) for si, v in sorted(scene_shift.items()) if v != (0, 0)},
                 known_kilns_moved_for_matching=sum(1 for ki in kd_idx if ki in applied),
                 shift_px_counts=dict(Counter(f"{offs[ki][0]},{offs[ki][1]}" for ki in kd_idx if ki in offs).most_common(8)),
                 status=dict(Counter(r["status"] for r in records)),
                 unmatched_dropped_near_known_or_low_conf=n_dup_near_known,
                 new_detections=sum(1 for r in records if r["baseline"] is None), seconds=round(time.time() - t0, 1))
    with open(out_dir / "districts" / f"{dname}.json", "w") as fh:
        json.dump(dict(stats=stats, scenes=[s["id"] for s in scenes], records=records), fh, indent=1)
    log(f"[{dname}] done {stats}")
    return stats


ALIGN_S = 20


def align_known(kl, mosaics):
    """For each 2023-24 kiln whose SentinelKilnDB patch lies inside the loaded mosaics, find the
    pixel shift that best aligns the dataset patch with the October 2026 mosaic (normalised
    cross-correlation over +-20 px). Some dataset patches are displaced by about 7 px E-W and
    11 px N-S from the position their file name implies; their kilns inherit the displacement.
    A shift is applied only if the peak correlation is >= 0.3 and beats the zero shift by >= 0.05.
    Returns {kiln index: (dx, dy, peak, corr_at_zero)}."""
    import cv2
    from common import parse_name
    _load_baseline_imgs()
    cache, out = {}, {}
    S = ALIGN_S
    for ki in kl.index:
        nm = kl.best_patch[ki]
        if not isinstance(nm, str):
            continue
        if nm not in cache:
            cache[nm] = None
            lat_c, lon_c = parse_name(nm)
            col, row = int(col_of(lon_c)), int(row_of(lat_c))
            ab = find_chunk(col, row, mosaics, need=64 + S)
            if ab is None:
                continue
            rgb, sidx = mosaics[ab]
            c0, r0 = chunk_origin(*ab)
            lc, lr = col - c0, row - r0
            if (sidx[lr - 64 - S:lr + 64 + S, lc - 64 - S:lc + 64 + S] == 255).mean() > MAX_INVALID_FRAC:
                continue
            win = rgb[:, lr - 64 - S:lr + 64 + S, lc - 64 - S:lc + 64 + S].astype(np.float32).mean(0)
            tpl = np.array(Image.open(io.BytesIO(_baseline_imgs[nm])).convert("RGB"), dtype=np.float32).mean(2)
            res = cv2.matchTemplate(win, tpl, cv2.TM_CCOEFF_NORMED)
            y, x = np.unravel_index(int(np.argmax(res)), res.shape)
            pk, cz = float(res[y, x]), float(res[S, S])
            dx, dy = int(x - S), int(y - S)
            if not (pk >= 0.3 and pk - cz >= 0.05):
                dx = dy = 0
            cache[nm] = (dx, dy, round(pk, 4), round(cz, 4), int(sidx[lr, lc]))
        if cache[nm] is not None:
            out[ki] = cache[nm]
    return out


def find_chunk(col, row, mosaics, need=64):
    """A loaded chunk whose raster holds a +-need window around (col, row), deterministic order."""
    fa, fb = int(col // CHUNK_PX), int(row // CHUNK_PX)
    for a in (fa, fa - 1, fa + 1):
        for b in (fb, fb - 1, fb + 1):
            if (a, b) not in mosaics:
                continue
            c0, r0 = chunk_origin(a, b)
            lc, lr = col - c0, row - r0
            if need <= lc < CHUNK_W - need and need <= lr < CHUNK_W - need:
                return a, b
    return None


def kiln_patches(c, r):
    """Global patches holding pixel (c, r) at least 14 px inside the patch."""
    return [(int(i), int(j)) for i in range((c - 114) // STRIDE + 1, (c - 14) // STRIDE + 1)
            for j in range((r - 114) // STRIDE + 1, (r - 14) // STRIDE + 1)]


def status_of(s):
    if s == ["Zigzag"]:
        return "ZIGZAG"
    if s == ["FCBK"]:
        return "FCBK"
    return "UNDETERMINED"


# ----------------------------------------------------------------------------- merge outputs
def git_commit():
    try:
        return subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    except Exception:
        return None


def merge(out_dir: Path, plan: dict):
    recs, stats = [], []
    for f in sorted((out_dir / "districts").glob("*.json")):
        d = json.load(open(f))
        recs.extend(d["records"])
        stats.append(d["stats"])
    recs.sort(key=lambda r: r["id"])
    with open(DATA / "kilns.json", "w") as fh:
        json.dump(recs, fh, indent=1)
    # fixture: 200 kilns, seeded, stratified-ish by status
    rng = np.random.default_rng(SEED)
    by = defaultdict(list)
    for r in recs:
        by[r["status"]].append(r)
    fixture = []
    for st in sorted(by):
        take = min(len(by[st]), 50)
        idx = sorted(rng.choice(len(by[st]), size=take, replace=False).tolist())
        fixture.extend(by[st][q] for q in idx)
    rest = [r for r in recs if r not in fixture]
    if len(fixture) < 200 and rest:
        idx = sorted(rng.choice(len(rest), size=min(200 - len(fixture), len(rest)), replace=False).tolist())
        fixture.extend(rest[q] for q in idx)
    fixture.sort(key=lambda r: r["id"])
    (DATA / "fixtures").mkdir(exist_ok=True)
    with open(DATA / "fixtures" / "kilns.sample.json", "w") as fh:
        json.dump(fixture[:200], fh, indent=1)
    # audit sample: 10 per status, seeded, no labels
    rng = np.random.default_rng(SEED + 7)
    audit = []
    for st in ("FCBK", "NOT_DETECTED", "UNDETERMINED", "ZIGZAG"):
        pool = by.get(st, [])
        idx = sorted(rng.choice(len(pool), size=min(10, len(pool)), replace=False).tolist()) if pool else []
        for q in idx:
            r = pool[q]
            audit.append(dict(id=r["id"], status=r["status"], lat=r["lat"], lon=r["lon"], district=r["district"],
                              baseline_class=(r["baseline"] or {}).get("class"),
                              chip=r["observation"]["chip"], baseline_chip=r["observation"]["baseline_chip"],
                              scene_id=r["observation"]["scene_id"], date=r["observation"]["date"],
                              human_label=None, human_notes=None))
    (DATA / "audit").mkdir(exist_ok=True)
    with open(DATA / "audit" / "sample.json", "w") as fh:
        json.dump(dict(seed=SEED + 7, rule="10 random kilns per status from data/kilns.json, numpy default_rng",
                       instructions="Look at both chips. Fill human_label with FCBK, Zigzag, no kiln, or cannot tell. Do not edit other fields.",
                       kilns=audit), fh, indent=1)
    params = model_params()
    scenes_all = {}
    for d in plan["districts"].values():
        for s in d["scenes"]:
            scenes_all[s["id"]] = s["date"]
    summary = dict(
        generated_from="ml/scan.py", counts_by_status=dict(sorted(Counter(r["status"] for r in recs).items())),
        n_kilns=len(recs), n_baseline_kilns_checked=sum(1 for r in recs if r["baseline"]),
        n_new_detections=sum(1 for r in recs if r["baseline"] is None),
        districts={s["district"]: {k: v for k, v in s.items() if k != "district"} for s in stats},
        aoi=dict(full_scan_districts=sorted(n for n, d in plan["districts"].items() if d["mode"] == "full"),
                 known_kiln_districts=sorted(n for n, d in plan["districts"].items() if d["mode"] == "known")),
        scenes=dict(sorted(scenes_all.items())),
        models=dict(detector="YOLO11n-OBB, ml/weights/detector.pt", detector_sha256=params["detector_sha256"],
                    classifier="ResNet18 crop classifier, ml/weights/classifier.pt", classifier_sha256=params["classifier_sha256"]),
        qhat=params["qhat"], alpha=params["alpha"], det_conf=params["det_conf"], posthoc_zigzag_min_prob=params["zig_min"],
        caveats=["Most 2023-24 kilns in these districts were in the model's training blocks; the scan is a product run, not an evaluation.",
                 "NOT_DETECTED means not seen by the detector in October 2026: demolished, dismantled or missed.",
                 "October imagery differs in season from the Nov-Feb imagery the models were trained on."])
    with open(DATA / "summary.json", "w") as fh:
        json.dump(summary, fh, indent=1)
    manifest = dict(
        purpose="Recompute data/kilns.json: run ml/scan.py --from-manifest data/manifest.json --districts <name> for each district, then --merge.",
        code_commit=plan.get("code_commit"), stac=STAC, collection=COLLECTION, date_range=DATE_RANGE,
        rendering=dict(bands=["B04", "B03", "B02"], crs="EPSG:4326", pixel_deg=PIX_DEG, resampling="nearest",
                       patch_px=PATCH, stride_px=STRIDE, grid_origin="lon 0, lat 0", norm="per patch per band min-max to uint8",
                       invalid_scl=sorted(BAD_SCL), max_invalid_frac=MAX_INVALID_FRAC),
        inference=dict(device="cpu", torch_threads=TORCH_THREADS, deterministic=True, imgsz=params["imgsz"],
                       det_conf=params["det_conf"], tta="8 dihedral views", merge_km=MERGE_KM, match_km=MATCH_KM),
        detector_sha256=params["detector_sha256"], classifier_sha256=params["classifier_sha256"],
        alpha=params["alpha"], qhat=params["qhat"], posthoc_zigzag_min_prob=params["zig_min"],
        kilns_json_sha256=sha256(DATA / "kilns.json"),
        districts=plan["districts"])
    with open(DATA / "manifest.json", "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(json.dumps({k: summary[k] for k in ("counts_by_status", "n_kilns", "n_baseline_kilns_checked", "n_new_detections")}, indent=1))


# ----------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--districts", nargs="*", default=[])
    ap.add_argument("--mode", default="full", choices=["full", "known"])
    ap.add_argument("--all-known", action="store_true", help="every district with 2023-24 kilns not yet scanned, known mode")
    ap.add_argument("--merge", action="store_true")
    ap.add_argument("--from-manifest", default=None)
    ap.add_argument("--out-dir", default=str(SCAN_DIR))
    ap.add_argument("--chip-root", default=str(DATA), help="chips are written to <chip-root>/chips/")
    ap.add_argument("--fetch-only", action="store_true", help="only download and cache the mosaics")
    ap.add_argument("--no-cache", action="store_true", help="always read imagery from the network")
    ap.add_argument("--only-fetched", action="store_true", help="with --all-known: only districts already in fetched.json")
    args = ap.parse_args()
    out_dir = Path(args.out_dir)
    (out_dir / "districts").mkdir(parents=True, exist_ok=True)
    plan_path = out_dir / "plan.json"
    plan = json.load(open(plan_path)) if plan_path.exists() else {"districts": {}}
    if args.merge:
        merge(out_dir, plan)
        return
    districts = load_districts()
    known = load_known()
    known["district"] = assign_district(known.lat.values, known.lon.values, districts)
    params = model_params()
    manifest = json.load(open(args.from_manifest)) if args.from_manifest else None
    fetched_prev = json.load(open(out_dir / "fetched.json")) if (out_dir / "fetched.json").exists() and not args.fetch_only else {}
    todo = [(d, args.mode) for d in args.districts]
    if args.all_known:
        counts = known.district.value_counts()
        done_fetch = json.load(open(out_dir / "fetched.json")) if (args.fetch_only and (out_dir / "fetched.json").exists()) else {}
        todo += [(d, "known") for d in counts.index if isinstance(d, str) and d not in plan["districts"]
                 and d not in args.districts and d not in done_fetch]
    global USE_CACHE
    USE_CACHE = not args.no_cache
    if args.only_fetched:
        todo = [(d, m) for d, m in todo if d in fetched_prev]
    if not todo:
        print("nothing to do")
        return
    det, clf = (None, None) if args.fetch_only else load_models()
    logf = open(out_dir / "scan.log", "a")

    def log(msg):
        print(msg, flush=True)
        logf.write(msg + "\n"); logf.flush()

    log(f"params {params}" if not args.fetch_only else "fetch only")
    for dname, mode in todo:
        if manifest:
            ent = manifest["districts"][dname]
            mode, scenes = ent["mode"], ent["scenes"]
            assert manifest["detector_sha256"] == params["detector_sha256"], "detector weights differ from manifest"
            assert manifest["classifier_sha256"] == params["classifier_sha256"], "classifier weights differ from manifest"
        elif dname in fetched_prev:
            mode, scenes = fetched_prev[dname]["mode"], fetched_prev[dname]["scenes"]
        else:
            kd = known[known.district == dname]
            g = districts[dname]
            if mode == "known":
                bb = (kd.lon.min() - 0.03, kd.lat.min() - 0.03, kd.lon.max() + 0.03, kd.lat.max() + 0.03)
            else:
                b = g.buffer(0.03).bounds
                bb = b
            scenes = select_scenes(bb)
        try:
            r = scan_district(dname, mode, scenes, params, districts, known, det, clf, out_dir, Path(args.chip_root), log,
                              fetch_only=args.fetch_only)
        except Exception as e:  # keep going district by district
            import traceback
            log(f"[{dname}] FAILED: {e!r}\n{traceback.format_exc()}")
            continue
        if args.fetch_only:
            fetched = json.load(open(out_dir / "fetched.json")) if (out_dir / "fetched.json").exists() else {}
            fetched[dname] = dict(mode=mode, scenes=scenes)
            with open(out_dir / "fetched.tmp.json", "w") as fh:
                json.dump(fetched, fh, indent=1)
            os.replace(out_dir / "fetched.tmp.json", out_dir / "fetched.json")
            continue
        plan["districts"][dname] = dict(mode=mode, scenes=scenes)
        plan["code_commit"] = git_commit()
        with open(plan_path, "w") as fh:
            json.dump(plan, fh, indent=1)


if __name__ == "__main__":
    main()
