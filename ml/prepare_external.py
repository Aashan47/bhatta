"""Extra classifier training crops from SentinelKilnDB kilns OUTSIDE Pakistan (deviation D2 in
docs/RESULTS.md). Only used to train the classifier arm "pk+ext"; calibration and test stay
Pakistan-only, exactly as pre-registered.

Leakage guard: an external kiln is dropped if it lies within 3 km of any Pakistan calibration or
test patch centre (the India-Pakistan border runs next to some of them).

Usage: ml/.venv/bin/python ml/prepare_external.py
"""
from __future__ import annotations

import io
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from PIL import Image
from shapely.geometry import Point
from shapely.prepared import prep

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CLASS_NAMES_SRC, CROP, DATA, PATCH, RAW, WORK, km_xy, norm_to_lonlat, parse_name
from prepare import HF, pakistan_polygon


def main():
    pak = prep(pakistan_polygon())
    sp = pd.read_csv(DATA / "splits.csv")
    guard = sp[sp.split.isin(["cal", "test"])]
    from scipy.spatial import cKDTree
    gx, gy = km_xy(guard.lon.values, guard.lat.values)
    gtree = cKDTree(np.c_[gx, gy])
    rows, crops = [], []
    cs = CROP + 8
    for split in ("test", "val", "train"):
        full = RAW / f"{split}.parquet"
        if not full.exists():
            print(f"downloading {split}", flush=True)
            subprocess.run(["curl", "-sL", "-o", str(full), f"{HF}/{split}/{split}.parquet"], check=True)
        f = pq.ParquetFile(full)
        for batch in f.iter_batches(batch_size=1000, columns=["image_name", "image", "yolo_obb_label"]):
            for nm, img, labs in zip(batch.column(0).to_pylist(), batch.column(1).to_pylist(), batch.column(2).to_pylist()):
                if not labs:
                    continue
                lat, lon = parse_name(nm)
                if pak.contains(Point(lon, lat)):
                    continue
                arr = None
                for line in labs:
                    p = line.split()
                    c = CLASS_NAMES_SRC[int(float(p[0]))]
                    xy = np.array([float(x) for x in p[1:9]]).reshape(4, 2)
                    u, v = xy[:, 0].mean(), xy[:, 1].mean()
                    klon, klat = norm_to_lonlat(np.array([u]), np.array([v]), lat, lon)
                    kx, ky = km_xy(klon, klat)
                    if gtree.query_ball_point([kx[0], ky[0]], r=3.0):
                        continue
                    if arr is None:
                        arr = np.array(Image.open(io.BytesIO(img)).convert("RGB"))
                        pad = np.pad(arr, ((CROP, CROP), (CROP, CROP), (0, 0)), mode="reflect")
                    cx, cy = u * PATCH, v * PATCH
                    x0, y0 = int(round(cx - cs / 2)) + CROP, int(round(cy - cs / 2)) + CROP
                    crops.append(pad[y0:y0 + cs, x0:x0 + cs].copy())
                    rows.append(dict(lat=float(klat[0]), lon=float(klon[0]), cls_src=c,
                                     cdist=float(np.hypot(u - 0.5, v - 0.5)), patch=nm, src_split=split))
        full.unlink()
        print(f"{split}: {len(rows)} external instances so far; deleted {full.name}", flush=True)
    df = pd.DataFrame(rows)
    # merge copies from overlapping patches, keep the most central crop
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    x, y = km_xy(df.lon.values, df.lat.values)
    pairs = cKDTree(np.c_[x, y]).query_pairs(r=0.030, output_type="ndarray")
    n = len(df)
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n))
    _, lab = connected_components(g, directed=False)
    df["kid"] = lab
    keep = df.sort_values(["kid", "cdist"]).groupby("kid").head(1)
    out = WORK / "crops" / "ext"
    recs = []
    for r in keep.itertuples():
        cls2 = "Zigzag" if r.cls_src == "Zigzag" else "FCBK"
        d = out / cls2
        d.mkdir(parents=True, exist_ok=True)
        kid = f"EXT{r.kid}"
        Image.fromarray(crops[r.Index]).save(d / f"{kid}_{r.kid}.png")
        recs.append(dict(kid=r.kid, id=kid, subsplit="ext", cls2=cls2, cls_src=r.cls_src, patch=r.patch,
                         lat=r.lat, lon=r.lon))
    ext = pd.DataFrame(recs)
    ext.to_csv(WORK / "crops_ext.csv", index=False)
    print(f"external unique kilns: {len(ext)}; by class {ext.cls_src.value_counts().to_dict()}")


if __name__ == "__main__":
    main()
