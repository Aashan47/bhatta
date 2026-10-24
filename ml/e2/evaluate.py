"""E2: choose the arm on val, calibrate on cal blocks, evaluate ONCE on test blocks.

Arm choice: highest val AUC of p(Zigzag) (8-view TTA for CNN arms) in data/e2/val_arms.json.
Calibration: Mondrian split conformal (alpha 0.10) and the Learn-then-Test Zigzag floor, using the
same functions as the pk arm (ml/conformal.py: calibrate_mondrian, ltt_zig_threshold, predict_sets).

Kilns without any usable Sentinel-2 date cannot be scored by E2. They are left out of calibration;
on test the product refuses them ({FCBK, Zigzag}), and E2c is reported with all pre-registered test
Zigzag kilns in the denominator (a kiln without a chip is not certified) and, separately, among
kilns with a chip.

Usage: ml/.venv/bin/python ml/e2/evaluate.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT / "ml"))
from common import ALPHA, CLS2, sha256  # noqa: E402
from conformal import calibrate_mondrian, ltt_zig_threshold, predict_sets, set_metrics  # noqa: E402

E2 = ROOT / "data" / "e2"
ZIG = CLS2.index("Zigzag")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="", help="data snapshot chosen on val (e.g. _2d)")
    T = ap.parse_args().tag
    val = json.load(open(E2 / f"val_arms{T}.json"))
    arms = {k: v for k, v in val.items() if not k.startswith("_")}
    arm = max(arms, key=lambda a: arms[a]["val_auc"])
    z = np.load(E2 / f"probs{T}_{arm}.npz")
    pz = pd.Series(z["p"], index=z["kid"])
    crops = pd.read_csv(ROOT / "ml" / "work" / "crops.csv")
    meta = pd.read_csv(E2 / f"chips_meta{T}.csv").set_index("kid")

    def split(name):
        r = crops[crops.subsplit == name].sort_values("kid")
        has = r.kid.isin(pz.index).values
        y = (r.cls2.values == "Zigzag").astype(int)
        p = np.where(has, pz.reindex(r.kid).fillna(np.nan).values, np.nan)
        return r, y, p, has

    rc, yc, pc, hc = split("cal")
    probs_c = np.stack([1 - pc[hc], pc[hc]], 1)
    qm = calibrate_mondrian(probs_c, yc[hc], ALPHA)
    t_ltt, trace = ltt_zig_threshold(probs_c, yc[hc], qm)
    cal_sets = predict_sets(probs_c, qm, zig_min=t_ltt if t_ltt is not None else 1.01)
    cal_m = set_metrics(cal_sets, yc[hc])

    # ---- the single test look ----
    rt, yt, pt, ht = split("test")
    probs_t = np.stack([1 - pt[ht], pt[ht]], 1)
    auc = float(roc_auc_score(yt[ht], pt[ht]))
    sets_chip = predict_sets(probs_t, qm, zig_min=t_ltt if t_ltt is not None else 1.01)
    sets_all = []
    it = iter(sets_chip)
    for h in ht:
        sets_all.append(next(it) if h else ["FCBK", "Zigzag"])
    m_all = set_metrics(sets_all, yt)
    m_chip = set_metrics(sets_chip, yt[ht])
    zig_all = int((yt == ZIG).sum()); zig_chip = int((yt[ht] == ZIG).sum())
    cert_true_zig = int(sum(1 for s, t in zip(sets_all, yt) if s == ["Zigzag"] and t == ZIG))
    e2c_all = cert_true_zig / zig_all
    e2c_chip = cert_true_zig / zig_chip if zig_chip else None
    n_cert = m_all["n_set_zigzag"]
    e2d = m_all["set_zigzag_false_rate"]
    cov_by_class = {CLS2[c]: float(np.mean([CLS2[c] in s for s, t in zip(sets_all, yt) if t == c])) for c in range(2)}
    pmondrian_nofloor = set_metrics(predict_sets(probs_t, qm), yt[ht])

    # reference: the pre-registered pk arm (RGB ResNet18) on exactly the same test kilns
    ref = None
    try:
        import torch
        from conformal import crop_probs
        pk, ypk, rows = crop_probs("test", torch.device("cpu"))
        pk = pd.Series(pk[:, 1], index=rows.kid.values)
        sub = rt.kid.values[ht]
        ref = dict(pk_auc_same_kilns=float(roc_auc_score(yt[ht], pk.reindex(sub).values)), n=int(ht.sum()),
                   pk_auc_all_test=float(roc_auc_score(ypk, pk.values)))
    except Exception as e:  # noqa: BLE001
        ref = dict(error=repr(e))

    hit = lambda ok: "HIT" if ok else "MISS"  # noqa: E731
    table = dict(
        E2a=dict(metric="AUC of p(Zigzag), test kilns with a chip", target=">= 0.85", result=auc, n=int(ht.sum()),
                 n_zigzag=zig_chip, verdict=hit(auc >= 0.85)),
        E2b=dict(metric="valid Learn-then-Test Zigzag floor on calibration", target="yes", result=t_ltt,
                 verdict=hit(t_ltt is not None)),
        E2c=dict(metric="share of true Zigzag test kilns certified at that floor", target=">= 0.15",
                 result=e2c_all, n=zig_all, result_among_kilns_with_chip=e2c_chip, n_with_chip=zig_chip,
                 n_certified_true_zigzag=cert_true_zig, verdict=hit(t_ltt is not None and e2c_all >= 0.15)),
        E2d=dict(metric="share of {Zigzag} test sets that are truly FCBK", target="<= 0.05", result=e2d,
                 n=n_cert, n_false=m_all["n_set_zigzag_true_fcbk"],
                 verdict=hit(t_ltt is not None and n_cert > 0 and e2d is not None and e2d <= 0.05)),
    )
    out = dict(data_tag=T, arm=arm, val_arms=val, alpha=ALPHA, mondrian_qhat=qm, ltt_zig_min=t_ltt, ltt_trace=trace,
               n_cal_with_chip=int(hc.sum()), n_cal=int(len(rc)), cal_by_class={CLS2[c]: int((yc[hc] == c).sum()) for c in range(2)},
               cal_metrics_product=cal_m, n_test=int(len(rt)), n_test_with_chip=int(ht.sum()),
               test_auc=auc, table=table, product_test_all=m_all, product_test_with_chip=m_chip,
               coverage_by_class_product=cov_by_class, mondrian_no_floor_test_with_chip=pmondrian_nofloor,
               reference_pk_arm=ref, switch=all(v["verdict"] == "HIT" for v in table.values()))
    w = HERE / "weights"
    out["weights_sha256"] = {p.name: sha256(p) for p in sorted(w.glob(f"e2{T}_*")) if p.is_file()}
    json.dump(out, open(E2 / "e2_results.json", "w"), indent=1)
    print(json.dumps({k: out[k] for k in ("arm", "ltt_zig_min", "test_auc", "table", "product_test_all",
                                          "coverage_by_class_product", "reference_pk_arm", "switch")}, indent=1))


if __name__ == "__main__":
    main()
