"""Prepare Pakistan-only SentinelKilnDB data with the pre-registered spatial-block split.

Steps
1. For each published parquet (test, val, train): download if missing, keep only patches whose
   centre lies inside Pakistan (Natural Earth 10m admin-0, public domain), write
   data/raw/pk_<split>.parquet, delete the full parquet.
2. Pool all Pakistan patches (the published split is discarded, see docs/PREREG.md).
3. Rebuild one global kiln table: every label is projected to lon/lat and duplicates from
   overlapping patches are merged (centroids within 30 m).
4. Assign 0.5 degree blocks to train/cal/test (60/20/20) with seed 20261024. Drop patches within
   1.3 km of a neighbouring block that belongs to a different split. Within train, 15% of the
   train blocks (same seed) are held out as "val" for early stopping only, so the calibration
   blocks are never used for model selection.
5. Write the YOLO-OBB dataset (class-agnostic "kiln") to ml/work/yolo and FCBK/Zigzag crops to
   ml/work/crops. Ground truth in each patch is rebuilt from the global kiln table so that kilns
   cut by the patch edge (which the published labels omit) are labelled when at least half is
   visible and marked "ignore" otherwise.

Usage: ml/.venv/bin/python ml/prepare.py [--keep-full]
"""
from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
from collections import Counter

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image
from shapely.geometry import Point, Polygon, box, shape
from shapely.prepared import prep

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
from common import (BLOCK_DEG, CLASS_NAMES_SRC, CROP, DATA, EDGE_BUFFER_KM, PATCH, RAW, SEED,
                    WORK, block_of, dist_point_rect_km, km_xy, lonlat_to_norm, norm_to_lonlat,
                    parse_name, patch_bounds, geohash)

HF = "https://huggingface.co/datasets/SustainabilityLabIITGN/SentinelKilnDB/resolve/main"
NE_PATH = RAW / "boundaries" / "ne_10m_admin_0_countries.geojson"
NE_URL = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson"


def pakistan_polygon():
    if not NE_PATH.exists():
        NE_PATH.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-sL", "-o", str(NE_PATH), NE_URL], check=True)
    d = json.load(open(NE_PATH))
    for f in d["features"]:
        if f["properties"].get("ADM0_A3") == "PAK":
            return shape(f["geometry"])
    raise RuntimeError("Pakistan not found in Natural Earth file")


def filter_split(split: str, pak, keep_full: bool):
    out = RAW / f"pk_{split}.parquet"
    if out.exists():
        print(f"[filter] {out.name} exists, skipping")
        return
    full = RAW / f"{split}.parquet"
    if not full.exists():
        print(f"[filter] downloading {split}.parquet")
        subprocess.run(["curl", "-sL", "-o", str(full), f"{HF}/{split}/{split}.parquet"], check=True)
    pp = prep(pak)
    f = pq.ParquetFile(full)
    writer, n_in, n_out = None, 0, 0
    for batch in f.iter_batches(batch_size=2000):
        t = pa.Table.from_batches([batch])
        names = t.column("image_name").to_pylist()
        keep = []
        for i, nm in enumerate(names):
            lat, lon = parse_name(nm)
            if pp.contains(Point(lon, lat)):
                keep.append(i)
        n_in += len(names)
        n_out += len(keep)
        if keep:
            sub = t.take(pa.array(keep))
            sub = sub.append_column("src_split", pa.array([split] * len(keep)))
            if writer is None:
                writer = pq.ParquetWriter(out, sub.schema)
            writer.write_table(sub)
    if writer:
        writer.close()
    print(f"[filter] {split}: {n_in} patches in, {n_out} in Pakistan")
    if not keep_full:
        full.unlink()
        print(f"[filter] deleted {full.name}")


def load_pk():
    dfs = [pq.read_table(RAW / f"pk_{s}.parquet", columns=["image_name", "yolo_obb_label", "src_split"]).to_pandas()
           for s in ("train", "val", "test")]
    df = pd.concat(dfs, ignore_index=True)
    before = len(df)
    df = df.drop_duplicates("image_name").reset_index(drop=True)
    print(f"[pool] {before} rows, {len(df)} unique patches")
    ll = df.image_name.map(parse_name)
    df["lat"] = [a for a, _ in ll]
    df["lon"] = [b for _, b in ll]
    return df


def build_kilns(df: pd.DataFrame) -> pd.DataFrame:
    """Global kiln table from per-patch labels, duplicates merged."""
    rows = []
    for _, r in df.iterrows():
        for line in r.yolo_obb_label:
            p = line.split()
            c = int(float(p[0]))
            xy = np.array([float(x) for x in p[1:9]]).reshape(4, 2)
            lon, lat = norm_to_lonlat(xy[:, 0], xy[:, 1], r.lat, r.lon)
            # distance of kiln centre from patch centre, in normalised units, to pick the most central copy
            cdist = float(np.hypot(xy[:, 0].mean() - 0.5, xy[:, 1].mean() - 0.5))
            rows.append(dict(cls_src=CLASS_NAMES_SRC[c], lon=lon.mean(), lat=lat.mean(),
                             poly=list(zip(lon.tolist(), lat.tolist())), patch=r.image_name, cdist=cdist))
    inst = pd.DataFrame(rows)
    print(f"[kilns] {len(inst)} label instances")
    from scipy.sparse.csgraph import connected_components
    from scipy.sparse import coo_matrix
    from scipy.spatial import cKDTree
    x, y = km_xy(inst.lon.values, inst.lat.values)
    pts = np.c_[x, y]
    pairs = cKDTree(pts).query_pairs(r=0.030, output_type="ndarray")
    n = len(inst)
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n)) if len(pairs) else coo_matrix((n, n))
    _, lab = connected_components(g, directed=False)
    inst["kid"] = lab
    kilns = []
    conflicts = 0
    for kid, grp in inst.groupby("kid"):
        cls_counts = Counter(grp.cls_src)
        if len(cls_counts) > 1:
            conflicts += 1
        best = grp.sort_values("cdist").iloc[0]
        kilns.append(dict(kid=int(kid), cls_src=cls_counts.most_common(1)[0][0], lat=float(grp.lat.mean()),
                          lon=float(grp.lon.mean()), poly=best.poly, n_copies=len(grp)))
    k = pd.DataFrame(kilns)
    k["cls2"] = np.where(k.cls_src == "Zigzag", "Zigzag", "FCBK")
    print(f"[kilns] {len(k)} unique kilns after merging copies within 30 m; class conflicts merged: {conflicts}")
    print(f"[kilns] classes: {dict(Counter(k.cls_src))}")
    return k


def assign_blocks(df: pd.DataFrame):
    df["block"] = [block_of(a, b) for a, b in zip(df.lat, df.lon)]
    blocks = sorted(set(df.block))
    rng = np.random.default_rng(SEED)
    order = rng.permutation(len(blocks))
    n = len(blocks)
    n_tr, n_cal = int(round(0.6 * n)), int(round(0.2 * n))
    split_of = {}
    for rank, idx in enumerate(order):
        split_of[blocks[idx]] = "train" if rank < n_tr else ("cal" if rank < n_tr + n_cal else "test")
    # early-stopping hold-out inside train blocks
    tr_blocks = sorted(b for b, s in split_of.items() if s == "train")
    rng2 = np.random.default_rng(SEED + 1)
    n_val = max(1, int(round(0.15 * len(tr_blocks))))
    val_blocks = set(tr_blocks[i] for i in rng2.permutation(len(tr_blocks))[:n_val])
    df["split"] = [split_of[b] for b in df.block]
    df["subsplit"] = [("val" if b in val_blocks else "fit") if split_of[b] == "train" else split_of[b] for b in df.block]
    # edge buffer
    drop = []
    for lat, lon, b, s in zip(df.lat, df.lon, df.block, df.split):
        d = False
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                if di == 0 and dj == 0:
                    continue
                nb = (b[0] + di, b[1] + dj)
                if nb in split_of and split_of[nb] != s:
                    rect = (nb[1] * BLOCK_DEG, nb[0] * BLOCK_DEG, (nb[1] + 1) * BLOCK_DEG, (nb[0] + 1) * BLOCK_DEG)
                    if dist_point_rect_km(lat, lon, rect) < EDGE_BUFFER_KM:
                        d = True
        drop.append(d)
    df["dropped_edge"] = drop
    print(f"[split] {n} blocks: {Counter(split_of.values())}; train blocks held out as val: {len(val_blocks)}")
    print(f"[split] patches dropped by the {EDGE_BUFFER_KM} km edge buffer: {int(np.sum(drop))}")
    return split_of


def patch_gt(df: pd.DataFrame, kilns: pd.DataFrame):
    """For each kept patch, kilns with visible fraction >= 0.5 (labels) and 0 < f < 0.5 (ignore)."""
    from scipy.spatial import cKDTree
    kx, ky = km_xy(kilns.lon.values, kilns.lat.values)
    tree = cKDTree(np.c_[kx, ky])
    polys = [Polygon(p) for p in kilns.poly]
    gt = {}
    for _, r in df.iterrows():
        px, py = km_xy([r.lon], [r.lat])
        cand = tree.query_ball_point([px[0], py[0]], r=1.2)
        pb = box(*patch_bounds(r.lat, r.lon))
        labels, ignore = [], []
        for ci in cand:
            poly = polys[ci]
            inter = poly.intersection(pb)
            if inter.is_empty:
                continue
            frac = inter.area / poly.area
            # polygon in normalised patch coordinates
            if frac >= 0.999:
                ring = np.array(poly.exterior.coords)[:4]
            else:
                rect = inter.minimum_rotated_rectangle
                ring = np.array(rect.exterior.coords)[:4]
            u, v = lonlat_to_norm(ring[:, 0], ring[:, 1], r.lat, r.lon)
            uv = np.clip(np.c_[u, v], 0, 1)
            entry = dict(kid=int(kilns.kid.iloc[ci]), cls2=kilns.cls2.iloc[ci], frac=float(frac), uv=uv.tolist())
            (labels if frac >= 0.5 else ignore).append(entry)
        gt[r.image_name] = dict(labels=labels, ignore=ignore)
    return gt


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-full", action="store_true")
    args = ap.parse_args()
    pak = pakistan_polygon()
    for s in ("test", "val", "train"):
        filter_split(s, pak, args.keep_full)

    df = load_pk()
    kilns = build_kilns(df)
    split_of = assign_blocks(df)
    kept = df[~df.dropped_edge].reset_index(drop=True)
    gt = patch_gt(kept, kilns)

    # kiln split membership: kiln belongs to the split of kept patches where it is >= 50% visible
    kiln_split, kiln_best = {}, {}
    for _, r in kept.iterrows():
        for e in gt[r.image_name]["labels"]:
            u = np.array(e["uv"])[:, 0].mean(); v = np.array(e["uv"])[:, 1].mean()
            c = float(np.hypot(u - 0.5, v - 0.5))
            kiln_split.setdefault(e["kid"], set()).add(r.subsplit)
            if e["frac"] >= 0.999 and (e["kid"] not in kiln_best or c < kiln_best[e["kid"]][1]):
                kiln_best[e["kid"]] = (r.image_name, c)
    multi = sum(1 for v in kiln_split.values() if len({x if x in ("cal", "test") else "train" for x in v}) > 1)
    print(f"[check] kilns visible in more than one of train/cal/test after buffer: {multi}")
    kilns["subsplit"] = kilns.kid.map(lambda k: sorted(kiln_split[k])[0] if k in kiln_split else "dropped")
    kilns["split"] = kilns.subsplit.map(lambda s: "train" if s in ("fit", "val") else s)
    kilns["best_patch"] = kilns.kid.map(lambda k: kiln_best[k][0] if k in kiln_best else None)
    kilns["id"] = [f"PK-{geohash(a, b)}" for a, b in zip(kilns.lat, kilns.lon)]

    # images: write YOLO dataset and crops
    names_needed = set(kept.image_name)
    yolo = WORK / "yolo"
    crops = WORK / "crops"
    for d in (yolo, crops):
        if d.exists():
            import shutil
            shutil.rmtree(d)
    sub_of = dict(zip(kept.image_name, kept.subsplit))
    for s in ("fit", "val", "cal", "test"):
        (yolo / "images" / s).mkdir(parents=True, exist_ok=True)
        (yolo / "labels" / s).mkdir(parents=True, exist_ok=True)
    crop_rows = []
    best_of_patch = {}
    for kid, (nm, _) in kiln_best.items():
        best_of_patch.setdefault(nm, []).append(kid)
    kidx = kilns.set_index("kid")
    for s in ("train", "val", "test"):
        f = pq.ParquetFile(RAW / f"pk_{s}.parquet")
        for batch in f.iter_batches(batch_size=1000, columns=["image_name", "image"]):
            for nm, img in zip(batch.column(0).to_pylist(), batch.column(1).to_pylist()):
                if nm not in names_needed or nm not in sub_of:
                    continue
                ss = sub_of.pop(nm)
                stem = nm[:-4]
                (yolo / "images" / ss / nm).write_bytes(img)
                with open(yolo / "labels" / ss / f"{stem}.txt", "w") as fh:
                    for e in gt[nm]["labels"]:
                        fh.write("0 " + " ".join(f"{x:.6f}" for x in np.array(e["uv"]).ravel()) + "\n")
                if nm in best_of_patch:
                    arr = np.array(Image.open(io.BytesIO(img)).convert("RGB"))
                    pad = np.pad(arr, ((CROP, CROP), (CROP, CROP), (0, 0)), mode="reflect")
                    for kid in best_of_patch[nm]:
                        e = next(x for x in gt[nm]["labels"] if x["kid"] == kid)
                        uv = np.array(e["uv"])
                        cx, cy = uv[:, 0].mean() * PATCH, uv[:, 1].mean() * PATCH
                        cs = CROP + 8  # saved with a 4 px margin for shift augmentation
                        x0, y0 = int(round(cx - cs / 2)) + CROP, int(round(cy - cs / 2)) + CROP
                        crop = pad[y0:y0 + cs, x0:x0 + cs]
                        k = kidx.loc[kid]
                        out = crops / k.subsplit / k.cls2
                        out.mkdir(parents=True, exist_ok=True)
                        Image.fromarray(crop).save(out / f"{k.id}_{kid}.png")
                        crop_rows.append(dict(kid=kid, id=k.id, subsplit=k.subsplit, cls2=k.cls2, cls_src=k.cls_src,
                                              patch=nm, cx=cx, cy=cy))
    # dataset yaml
    (yolo / "data.yaml").write_text(
        f"path: {yolo}\ntrain: images/fit\nval: images/val\ntest: images/test\ncal: images/cal\nnames:\n  0: kiln\n")
    with open(WORK / "gt.json", "w") as fh:
        json.dump(gt, fh)

    # small, committed outputs
    split_csv = df[["image_name", "lat", "lon", "src_split", "split", "subsplit", "dropped_edge"]].copy()
    split_csv["block"] = df.block.map(lambda b: f"{b[0]}_{b[1]}")
    split_csv["n_labels_published"] = df.yolo_obb_label.map(len)
    split_csv.to_csv(DATA / "splits.csv", index=False)
    kilns_out = kilns[["id", "kid", "lat", "lon", "cls_src", "cls2", "split", "subsplit", "best_patch", "n_copies"]].copy()
    kilns_out["poly"] = kilns.poly.map(lambda p: json.dumps([[round(a, 6), round(b, 6)] for a, b in p]))
    kilns_out.to_csv(DATA / "pk_kilns_2023.csv", index=False)
    pd.DataFrame(crop_rows).to_csv(WORK / "crops.csv", index=False)

    # counts
    counts = {"patches": {}, "kilns_unique": {}, "patch_label_instances": {}, "crops": {}}
    for ss in ("fit", "val", "cal", "test"):
        sp = kept[kept.subsplit == ss]
        counts["patches"][ss] = dict(total=int(len(sp)),
                                     with_kiln=int(sum(1 for n in sp.image_name if gt[n]["labels"])))
        inst = Counter(e["cls2"] for n in sp.image_name for e in gt[n]["labels"])
        counts["patch_label_instances"][ss] = dict(inst)
        kk = kilns[kilns.subsplit == ss]
        counts["kilns_unique"][ss] = dict(Counter(kk.cls_src))
        cr = [c for c in crop_rows if c["subsplit"] == ss]
        counts["crops"][ss] = dict(Counter(c["cls2"] for c in cr))
    counts["kilns_unique"]["dropped_by_buffer"] = dict(Counter(kilns[kilns.subsplit == "dropped"].cls_src))
    counts["blocks"] = dict(Counter(split_of.values()))
    counts["patches_dropped_edge"] = int(df.dropped_edge.sum())
    counts["patches_pakistan_total"] = int(len(df))
    counts["kilns_unique_total"] = dict(Counter(kilns.cls_src))
    counts["block_assignment"] = {f"{b[0]}_{b[1]}": s for b, s in sorted(split_of.items())}
    with open(DATA / "split_counts.json", "w") as fh:
        json.dump(counts, fh, indent=1)
    print(json.dumps({k: v for k, v in counts.items() if k != "block_assignment"}, indent=1))


if __name__ == "__main__":
    main()
