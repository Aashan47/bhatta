"""Split conformal prediction sets for the FCBK vs Zigzag classifier.

Score = 1 - softmax probability of the true class (PREREG). Calibrated on calibration-block kilns
(true kilns, crops from hand labels), alpha = 0.10. Writes data/conformal.json.

Also computes the pre-registered fallback for T6 (used only if T6 misses on test): a minimum
Zigzag probability t such that, on CALIBRATION data, at most 5% of kilns given the single set
{Zigzag} are truly FCBK. Kilns that would get {Zigzag} with p_Zigzag < t get {FCBK, Zigzag}
instead (refusal). This fallback is post-hoc and is labelled so wherever it is reported.

Usage: ml/.venv/bin/python ml/conformal.py [--device mps]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ALPHA, CLS2, DATA, SEED, WORK, sha256

ZIG = CLS2.index("Zigzag")
FCBK = CLS2.index("FCBK")


def calibrate(probs: np.ndarray, y: np.ndarray, alpha: float = ALPHA) -> float:
    n = len(y)
    scores = 1.0 - probs[np.arange(n), y]
    level = min(1.0, math.ceil((n + 1) * (1 - alpha)) / n)
    return float(np.quantile(scores, level, method="higher"))


def calibrate_mondrian(probs: np.ndarray, y: np.ndarray, alpha: float = ALPHA) -> dict:
    """Class-conditional (Mondrian) split conformal: one qhat per true class."""
    return {CLS2[c]: calibrate(probs[y == c], np.full(int((y == c).sum()), c), alpha)
            for c in range(len(CLS2))}


def predict_sets(probs: np.ndarray, qhat, zig_min: float | None = None) -> list[list[str]]:
    """qhat is a float (marginal) or a dict class -> qhat (Mondrian)."""
    qd = qhat if isinstance(qhat, dict) else {c: qhat for c in CLS2}
    sets = []
    for p in probs:
        s = [CLS2[c] for c in range(len(CLS2)) if 1.0 - p[c] <= qd[CLS2[c]]]
        if zig_min is not None and s == ["Zigzag"] and p[ZIG] < zig_min:
            s = ["FCBK", "Zigzag"]
        sets.append(s)
    return sets


def set_metrics(sets: list[list[str]], y: np.ndarray) -> dict:
    n = len(y)
    cover = np.array([CLS2[t] in s for s, t in zip(sets, y)])
    single = np.array([len(s) == 1 for s in sets])
    zig_single = np.array([s == ["Zigzag"] for s in sets])
    fcbk_single = np.array([s == ["FCBK"] for s in sets])
    empty = np.array([len(s) == 0 for s in sets])
    n_zs = int(zig_single.sum())
    false_zig = int((zig_single & (y == FCBK)).sum())
    return dict(n=n, coverage=float(cover.mean()) if n else None, n_covered=int(cover.sum()),
                singleton_share=float(single.mean()) if n else None, n_singleton=int(single.sum()),
                n_set_zigzag=n_zs, n_set_zigzag_true_fcbk=false_zig,
                set_zigzag_false_rate=(false_zig / n_zs) if n_zs else None,
                n_set_fcbk=int(fcbk_single.sum()),
                n_set_fcbk_true_zigzag=int((fcbk_single & (y == ZIG)).sum()),
                n_set_both=int(np.array([len(s) == 2 for s in sets]).sum()), n_set_empty=int(empty.sum()))


def zig_threshold(probs: np.ndarray, y: np.ndarray, qhat: float, max_rate: float = 0.05) -> float | None:
    """Smallest t with false-{Zigzag} rate <= max_rate on the given (calibration) data."""
    for t in np.round(np.arange(0.50, 1.0001, 0.005), 3):
        m = set_metrics(predict_sets(probs, qhat, zig_min=float(t)), y)
        r = m["set_zigzag_false_rate"]
        if r is None or r <= max_rate:
            return float(t)
    return None


def clopper_pearson_upper(k: int, n: int, delta: float) -> float:
    from scipy.stats import beta
    if n == 0:
        return 1.0
    if k >= n:
        return 1.0
    return float(beta.ppf(1 - delta, k + 1, n - k))


def ltt_zig_threshold(probs, y, qhat, max_rate=0.05, delta=0.10):
    """Learn-then-Test (Angelopoulos et al., 2021) with a Bonferroni correction over a fixed grid of
    p(Zigzag) floors t in {0.50, 0.525, ..., 0.975}. For each t, the null 'false-{Zigzag}
    certificate rate > max_rate' is tested with the exact binomial p-value of the false
    certificates among the certified calibration kilns; t is valid if p <= delta / len(grid).
    Returns the loosest valid t (most certificates), or None if no t is valid, plus the trace."""
    from scipy.stats import binom
    grid = np.round(np.arange(0.50, 0.976, 0.025), 3)
    level = delta / len(grid)
    trace, valid = [], []
    for t in grid:
        sets = predict_sets(probs, qhat, zig_min=float(t))
        zs = np.array([s == ["Zigzag"] for s in sets])
        n = int(zs.sum()); k = int((zs & (y == FCBK)).sum())
        pval = float(binom.cdf(k, n, max_rate)) if n else 1.0
        trace.append(dict(t=float(t), n_cert=n, n_false=k, pval=pval, cp_upper=clopper_pearson_upper(k, n, level)))
        if n and pval <= level:
            valid.append(float(t))
    return (min(valid) if valid else None), trace


def crop_probs(subsplit: str, device, weights: str = "classifier.pt") -> tuple[np.ndarray, np.ndarray, pd.DataFrame]:
    from train_classifier import CropDS, load_classifier, predict_probs
    rows = pd.read_csv(WORK / "crops.csv")
    rows = rows[rows.subsplit == subsplit].sort_values("kid").reset_index(drop=True)
    model, cfg = load_classifier(Path(__file__).resolve().parent / "weights" / weights, device)
    ds = CropDS(rows, train=False, cfg=cfg)
    x = torch.stack([ds[i][0] for i in range(len(ds))])
    return predict_probs(model, x, device, tta=True), np.array(ds.y), rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="mps")
    args = ap.parse_args()
    torch.manual_seed(SEED)
    dev = torch.device(args.device)
    p, y, _ = crop_probs("cal", dev)
    qhat = calibrate(p, y)
    m = set_metrics(predict_sets(p, qhat), y)
    t = zig_threshold(p, y, qhat)
    mt = set_metrics(predict_sets(p, qhat, zig_min=t), y) if t is not None else None
    qm = calibrate_mondrian(p, y)
    mm = set_metrics(predict_sets(p, qm), y)
    t_ltt, trace = ltt_zig_threshold(p, y, qm)
    mltt = set_metrics(predict_sets(p, qm, zig_min=t_ltt if t_ltt is not None else 1.01), y)
    out = dict(alpha=ALPHA, score="1 - softmax(true class)", qhat=qhat, n_cal=int(len(y)),
               mondrian_qhat=qm, cal_metrics_mondrian=mm,
               ltt=dict(method="Learn-then-Test, Bonferroni over 20 p(Zigzag) floors 0.50..0.975, exact binomial p-value, max false-certificate rate 0.05, delta 0.10",
                        zig_min=t_ltt, cal_metrics=mltt, trace=trace),
               n_cal_by_class={c: int((y == i).sum()) for i, c in enumerate(CLS2)},
               cal_metrics=m, posthoc_zigzag_min_prob=t, cal_metrics_with_posthoc=mt,
               classifier_sha256=sha256(Path(__file__).resolve().parent / "weights" / "classifier.pt"),
               tta="mean softmax over 8 dihedral views")
    with open(DATA / "conformal.json", "w") as fh:
        json.dump(out, fh, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
