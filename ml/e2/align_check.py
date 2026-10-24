"""Alignment check: are kilns at the chip centre? For each band, average the per-chip standardised
image over kilns (date 0) and locate the peak of the mean anomaly by a weighted centroid of its
positive part (negative part for bands where the kiln is darker than its surroundings) inside the central 16 x 16 px; compare with the expected centroid position
(12 + sub-pixel offset of the label, in chip pixel coordinates where pixel i spans [i, i+1)).
Also cross-correlates each chip's B12 with the mean template to estimate a per-kiln shift.
Usage: ml/.venv/bin/python ml/e2/align_check.py [tile ...]
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
NAMES = ["B02", "B03", "B04", "B08", "B05", "B06", "B07", "B8A", "B11", "B12"]


def main():
    tiles = sys.argv[1:] or [p.stem for p in (ROOT / "data/e2/raw/tiles").glob("*.npz")]
    Xs, fr = [], []
    for t in tiles:
        z = np.load(ROOT / f"data/e2/raw/tiles/{t}.npz")
        ok = z["ndates"] > 0
        Xs.append(z["X"][ok, 0].astype(np.float32))
        fr.append(np.stack([z["col"][ok] - z["c0"][ok], z["row"][ok] - z["r0"][ok]], 1))
    X = np.concatenate(Xs); fr = np.concatenate(fr)
    expected = fr.mean(0)  # mean label centroid position in chip px (x, y); chip centre is 12.0
    out = dict(n=int(len(X)), tiles=tiles, expected_centroid_xy=expected.tolist(), bands={})
    yy, xx = np.mgrid[:24, :24] + 0.5  # pixel centres
    for b, nm in enumerate(NAMES):
        a = X[:, b]
        a = (a - a.mean((1, 2), keepdims=True)) / (a.std((1, 2), keepdims=True) + 1e-6)
        m = a.mean(0)
        sign = 1.0 if m[9:15, 9:15].mean() >= m[[0, 1, 22, 23]].mean() else -1.0  # kiln brighter or darker than its surroundings
        w = np.clip(sign * (m - np.median(m)), 0, None)
        w[:4] = 0; w[-4:] = 0; w[:, :4] = 0; w[:, -4:] = 0
        cx, cy = (w * xx).sum() / w.sum(), (w * yy).sum() / w.sum()
        out["bands"][nm] = dict(peak_centroid_xy=[float(cx), float(cy)],
                                offset_px_xy=[float(cx - expected[0]), float(cy - expected[1])],
                                kiln_is="brighter" if sign > 0 else "darker",
                                centre_minus_ring=float(m[9:15, 9:15].mean() - m[[0, 1, 22, 23]].mean()))
    # per-kiln shift of B12 by cross-correlation with the mean template, +-4 px
    a = X[:, 9]
    a = (a - a.mean((1, 2), keepdims=True)) / (a.std((1, 2), keepdims=True) + 1e-6)
    tpl = a.mean(0)[6:18, 6:18]
    sh = []
    for img in a:
        best, bs = -9, (0, 0)
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                c = (img[6 + dy:18 + dy, 6 + dx:18 + dx] * tpl).mean()
                if c > best:
                    best, bs = c, (dx, dy)
        sh.append(bs)
    sh = np.array(sh)
    out["b12_xcorr_shift_px"] = dict(median_xy=np.median(sh, 0).tolist(), mean_xy=sh.mean(0).tolist(),
                                     share_within_1px=float((np.abs(sh).max(1) <= 1).mean()))
    print(json.dumps(out, indent=1))
    json.dump(out, open(ROOT / "data/e2/alignment_check.json", "w"), indent=1)


if __name__ == "__main__":
    main()
