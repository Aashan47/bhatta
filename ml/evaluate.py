"""Evaluate T1 to T6 on test blocks (docs/PREREG.md). Writes data/eval_results.json.

Detector: oriented-box IoU >= 0.3 with greedy matching by confidence. Ground truth per patch is
rebuilt from the global kiln table (prepare.py): kilns at least half visible are targets, kilns
less than half visible are "ignore" (a detection on them is neither TP nor FP). The confidence
threshold is chosen on the train-block "val" hold-out (max F1) and then frozen for test.

Classifier and conformal: one crop per unique test kiln (hand-label box centre), TTA softmax.

Usage: ml/.venv/bin/python ml/evaluate.py [--device mps]
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from PIL import Image
from shapely.geometry import Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ALPHA, CLS2, CROP, DATA, PATCH, WORK, sha256
from conformal import crop_probs, predict_sets, set_metrics

IOU = 0.3
WDIR = Path(__file__).resolve().parent / "weights"


def poly_iou(a: Polygon, b: Polygon) -> float:
    if not a.is_valid:
        a = a.buffer(0)
    if not b.is_valid:
        b = b.buffer(0)
    inter = a.intersection(b).area
    u = a.area + b.area - inter
    return inter / u if u > 0 else 0.0


def run_detector(subsplit: str, device: str, imgsz: int):
    from ultralytics import YOLO
    model = YOLO(str(WDIR / "detector.pt"))
    files = sorted((WORK / "yolo" / "images" / subsplit).glob("*.png"))
    preds = {}
    for i in range(0, len(files), 256):
        chunk = files[i:i + 256]
        res = model.predict([str(f) for f in chunk], imgsz=imgsz, conf=0.01, iou=0.5, device=device, verbose=False)
        for f, r in zip(chunk, res):
            if r.obb is None or len(r.obb) == 0:
                preds[f.name] = []
                continue
            pts = r.obb.xyxyxyxyn.cpu().numpy()
            conf = r.obb.conf.cpu().numpy()
            preds[f.name] = [(pts[j].tolist(), float(conf[j])) for j in range(len(conf))]
    return preds


def match_patch(preds, gt, thr):
    labels = [Polygon(e["uv"]) for e in gt["labels"]]
    ignore = [Polygon(e["uv"]) for e in gt["ignore"]]
    used = [False] * len(labels)
    tp = fp = 0
    tp_info = []
    for pts, c in sorted([p for p in preds if p[1] >= thr], key=lambda x: -x[1]):
        pp = Polygon(pts)
        best, bi = 0.0, -1
        for j, g in enumerate(labels):
            if used[j]:
                continue
            v = poly_iou(pp, g)
            if v > best:
                best, bi = v, j
        if best >= IOU:
            used[bi] = True
            tp += 1
            tp_info.append((bi, pts, c))
        elif any(poly_iou(pp, g) >= IOU for g in ignore):
            continue
        else:
            fp += 1
    fn = used.count(False)
    return tp, fp, fn, tp_info, used


def det_metrics(preds, gt, thr):
    TP = FP = FN = 0
    for nm, p in preds.items():
        tp, fp, fn, _, _ = match_patch(p, gt[nm], thr)
        TP += tp; FP += fp; FN += fn
    prec = TP / (TP + FP) if TP + FP else None
    rec = TP / (TP + FN) if TP + FN else None
    f1 = 2 * prec * rec / (prec + rec) if prec and rec else 0.0
    return dict(threshold=thr, tp=TP, fp=FP, fn=FN, precision=prec, recall=rec, f1=f1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="mps")
    ap.add_argument("--imgsz", type=int, default=256)
    args = ap.parse_args()
    gt = json.load(open(WORK / "gt.json"))
    out = {"iou": IOU, "alpha": ALPHA}

    # ---- detector
    pv = run_detector("val", args.device, args.imgsz)
    grid = [round(t, 2) for t in np.arange(0.05, 0.96, 0.05)]
    val_curve = [det_metrics(pv, gt, t) for t in grid]
    best = max(val_curve, key=lambda m: m["f1"])
    thr = best["threshold"]
    out["detector_threshold"] = thr
    out["detector_val_at_threshold"] = best
    pt = run_detector("test", args.device, args.imgsz)
    out["detector_test"] = det_metrics(pt, gt, thr)
    out["detector_test_curve"] = [det_metrics(pt, gt, t) for t in grid]
    out["n_test_patches"] = len(pt)
    out["n_test_patches_with_kiln"] = sum(1 for n in pt if gt[n]["labels"])

    # kiln-level recall: a unique test kiln counts as found if any test patch finds it
    found, seen = {}, {}
    e2e = {}  # kid -> (centrality, patch, det centre px)
    for nm, p in pt.items():
        tp, fp, fn, tp_info, used = match_patch(p, gt[nm], thr)
        for j, e in enumerate(gt[nm]["labels"]):
            seen[e["kid"]] = True
            if used[j]:
                found[e["kid"]] = True
        for bi, pts, c in tp_info:
            e = gt[nm]["labels"][bi]
            a = np.array(pts)
            cx, cy = a[:, 0].mean(), a[:, 1].mean()
            cen = float(np.hypot(cx - 0.5, cy - 0.5))
            if e["kid"] not in e2e or cen < e2e[e["kid"]][0]:
                e2e[e["kid"]] = (cen, nm, cx * PATCH, cy * PATCH, e["cls2"])
    out["detector_test_kiln_level"] = dict(n_kilns=len(seen), n_found=len(found),
                                           recall=len(found) / len(seen) if seen else None)

    # ---- classifier on true kilns (hand-label crops)
    dev = torch.device(args.device)
    p, y, rows = crop_probs("test", dev)
    pred = p.argmax(1)
    conf_m = [[int(((y == i) & (pred == j)).sum()) for j in range(2)] for i in range(2)]
    out["classifier_test"] = dict(n=int(len(y)), n_by_class={c: int((y == i).sum()) for i, c in enumerate(CLS2)},
                                  accuracy=float((pred == y).mean()),
                                  balanced_accuracy=float(np.mean([(pred[y == c] == c).mean() for c in range(2) if (y == c).any()])),
                                  confusion_rows_true_cols_pred=conf_m, classes=CLS2)

    # ---- conformal
    cj = json.load(open(DATA / "conformal.json"))
    qhat = cj["qhat"]
    out["qhat"] = qhat
    out["conformal_test"] = set_metrics(predict_sets(p, qhat), y)
    if cj.get("posthoc_zigzag_min_prob") is not None:
        out["conformal_test_posthoc"] = set_metrics(predict_sets(p, qhat, zig_min=cj["posthoc_zigzag_min_prob"]), y)
        out["posthoc_zigzag_min_prob"] = cj["posthoc_zigzag_min_prob"]
    # class-conditional coverage
    out["conformal_test_coverage_by_class"] = {
        c: set_metrics(predict_sets(p[y == i], qhat), y[y == i])["coverage"] for i, c in enumerate(CLS2)}
    # product rule (deviation D3 + pre-registered T6 remedy): Mondrian qhat per class, then the
    # LTT p(Zigzag) floor for the {Zigzag} certificate
    qm = cj["mondrian_qhat"]
    zt = cj["ltt"]["zig_min"]
    zt_eff = zt if zt is not None else 1.01  # no valid floor: never certify Zigzag
    out["mondrian_qhat"] = qm
    out["ltt_zig_min"] = zt
    out["conformal_test_mondrian"] = set_metrics(predict_sets(p, qm), y)
    out["conformal_test_product"] = set_metrics(predict_sets(p, qm, zig_min=zt_eff), y)
    for key, q, zm in (("marginal", qhat, None), ("mondrian", qm, None), ("product", qm, zt_eff)):
        out[f"coverage_by_class_{key}"] = {c: set_metrics(predict_sets(p[y == i], q, zig_min=zm), y[y == i])["coverage"]
                                           for i, c in enumerate(CLS2)}
    from sklearn.metrics import roc_auc_score
    out["classifier_test"]["auc_zigzag"] = float(roc_auc_score(y, p[:, 1]))

    # ---- end to end: classify detected test kilns from the detected box centre (secondary)
    from train_classifier import load_classifier, predict_probs, to_tensor
    model, ccfg = load_classifier(WDIR / "classifier.pt", dev)
    cc = ccfg["crop"]
    need = {v[1] for v in e2e.values()}
    imgs = {}
    for f in (WORK / "yolo" / "images" / "test").glob("*.png"):
        if f.name in need:
            imgs[f.name] = np.array(Image.open(f).convert("RGB"))
    xs, ys = [], []
    for kid, (_, nm, cx, cy, c) in sorted(e2e.items()):
        a = np.pad(imgs[nm], ((CROP, CROP), (CROP, CROP), (0, 0)), mode="reflect")
        x0, y0 = int(round(cx - cc / 2)) + CROP, int(round(cy - cc / 2)) + CROP
        xs.append(to_tensor(np.ascontiguousarray(a[y0:y0 + cc, x0:x0 + cc]), ccfg["input"]))
        ys.append(CLS2.index(c))
    if xs:
        pe = predict_probs(model, torch.stack(xs), dev, tta=True)
        ye = np.array(ys)
        out["end_to_end_test"] = dict(n=int(len(ye)), accuracy=float((pe.argmax(1) == ye).mean()),
                                      **{f"sets_{k}": v for k, v in set_metrics(predict_sets(pe, qhat), ye).items()},
                                      **{f"product_{k}": v for k, v in set_metrics(predict_sets(pe, qm, zig_min=zt_eff), ye).items()})

    out["detector_sha256"] = sha256(WDIR / "detector.pt")
    out["classifier_sha256"] = sha256(WDIR / "classifier.pt")
    with open(DATA / "eval_results.json", "w") as fh:
        json.dump(out, fh, indent=1)
    print(json.dumps({k: v for k, v in out.items() if k != "detector_test_curve"}, indent=1))


if __name__ == "__main__":
    main()
