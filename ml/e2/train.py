"""E2 arms: train on fit blocks, score on the train-block val hold-out (AUC of p(Zigzag), 8-view TTA).

Input: data/e2/raw/X.npy (N, 4 dates, 10 bands, 24, 24) uint16 L2A DN, data/e2/chips_meta.csv.
Kilns with no usable date are left out of training and scoring (counted in the report).
Reflectance = (DN - 1000) / 10000 (processing baseline >= 04.00 offset; every scene used is 05.09
or 05.10), then per-band standardisation with fit-set statistics.

Arms
  early   : CNN, the 4 dates stacked as 40 channels (missing dates filled by repeating present ones)
  shared  : CNN encoder shared over dates, masked mean + max pooling over present dates
  hgb     : sklearn HistGradientBoosting on per-band summary features (median over dates)
  ens     : mean of the best CNN arm and hgb probabilities
Each CNN arm is 3 seeds averaged. Class-balanced cross-entropy, dihedral augmentation, random
2 px shift (train 20 px random crop, eval centre 20 px), 8-view TTA at evaluation.

Writes data/e2/probs_<arm>.npz holding p(Zigzag) for every kiln with a chip (all splits; test
probabilities are written but not read by this script) and data/e2/val_arms.json.
Usage: ml/.venv/bin/python ml/e2/train.py [--device cpu] [--epochs 40]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[2]
E2 = ROOT / "data" / "e2"
W = Path(__file__).resolve().parent / "weights"
SEED = 20261024
CROP = 20


def load(tag=""):
    meta = pd.read_csv(E2 / f"chips_meta{tag}.csv")
    X = np.load(E2 / "raw" / f"X{tag}.npy", mmap_mode="r")
    keep = meta.ndates.values > 0
    meta = meta[keep].reset_index(drop=True)
    X = np.asarray(X[keep], dtype=np.float32)
    nd = meta.ndates.values
    # fill missing dates by repeating present ones (cyclic), keep a mask
    mask = np.zeros((len(meta), 4), bool)
    for i, n in enumerate(nd):
        mask[i, :n] = True
        for d in range(n, 4):
            X[i, d] = X[i, d % n]
    X = (X - 1000.0) / 10000.0
    y = (meta.cls2.values == "Zigzag").astype(int)
    return meta, X, mask, y


def standardise(X, fit_idx):
    m = X[fit_idx].mean(axis=(0, 1, 3, 4), keepdims=True)
    s = X[fit_idx].std(axis=(0, 1, 3, 4), keepdims=True) + 1e-6
    return ((X - m) / s).astype(np.float32), m.ravel().tolist(), s.ravel().tolist()


def block(cin, cout):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True),
                         nn.Conv2d(cout, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class Encoder(nn.Module):
    def __init__(self, cin, width=64, drop=0.2):
        super().__init__()
        self.f = nn.Sequential(block(cin, width), nn.MaxPool2d(2), block(width, 2 * width), nn.MaxPool2d(2),
                               block(2 * width, 4 * width), nn.AdaptiveAvgPool2d(1), nn.Flatten(), nn.Dropout(drop))
        self.dim = 4 * width

    def forward(self, x):
        return self.f(x)


class EarlyNet(nn.Module):
    def __init__(self, nb=10, nd=4):
        super().__init__()
        self.enc = Encoder(nb * nd)
        self.head = nn.Linear(self.enc.dim, 2)

    def forward(self, x, mask):  # x: B, D, C, H, W
        return self.head(self.enc(x.flatten(1, 2)))


class SharedNet(nn.Module):
    def __init__(self, nb=10):
        super().__init__()
        self.enc = Encoder(nb)
        self.head = nn.Linear(2 * self.enc.dim, 2)

    def forward(self, x, mask):
        B, D = x.shape[:2]
        z = self.enc(x.flatten(0, 1)).view(B, D, -1)
        m = mask.float().unsqueeze(-1)
        mean = (z * m).sum(1) / m.sum(1).clamp(min=1)
        mx = z.masked_fill(~mask.unsqueeze(-1), -1e4).max(1).values
        return self.head(torch.cat([mean, mx], 1))


def dihedral(x, k, flip):
    x = torch.rot90(x, k, dims=(-2, -1))
    return torch.flip(x, dims=(-1,)) if flip else x


def center(x):
    o = (x.shape[-1] - CROP) // 2
    return x[..., o:o + CROP, o:o + CROP]


@torch.no_grad()
def predict(model, X, M, dev, tta=True, bs=512):
    model.eval()
    out = []
    for i in range(0, len(X), bs):
        x = center(torch.from_numpy(X[i:i + bs])).to(dev)
        m = torch.from_numpy(M[i:i + bs]).to(dev)
        views = [(k, f) for k in range(4) for f in (0, 1)] if tta else [(0, 0)]
        p = torch.stack([torch.softmax(model(dihedral(x, k, f), m), 1) for k, f in views]).mean(0)
        out.append(p[:, 1].cpu().numpy())
    return np.concatenate(out)


def train_cnn(kind, X, M, y, fit, val, dev, epochs, seed, lr=1e-3, bs=128, log=print):
    torch.manual_seed(seed); np.random.seed(seed)
    model = (EarlyNet() if kind == "early" else SharedNet()).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-3)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=lr, total_steps=epochs * int(np.ceil(len(fit) / bs)))
    cnt = np.bincount(y[fit], minlength=2)
    lossf = nn.CrossEntropyLoss(weight=torch.tensor(cnt.sum() / (2 * cnt), dtype=torch.float32, device=dev))
    best, best_state, best_ep = -1, None, -1
    Xf, Mf, yf = X[fit], M[fit], y[fit]
    for ep in range(epochs):
        model.train()
        perm = np.random.permutation(len(fit))
        for i in range(0, len(perm), bs):
            b = perm[i:i + bs]
            x = torch.from_numpy(Xf[b]); m = torch.from_numpy(Mf[b].copy())
            ox, oy = np.random.randint(0, x.shape[-1] - CROP + 1, 2)
            x = x[..., oy:oy + CROP, ox:ox + CROP]
            x = dihedral(x, np.random.randint(4), np.random.rand() < 0.5)
            # date dropout: for the shared arm, hide a random date per sample when more than one is present
            if kind == "shared":
                for j in range(len(b)):
                    if m[j].sum() > 1 and np.random.rand() < 0.5:
                        on = torch.where(m[j])[0]
                        m[j, on[np.random.randint(len(on))]] = False
            x, m, t = x.to(dev), m.to(dev), torch.from_numpy(yf[b]).to(dev)
            opt.zero_grad()
            loss = lossf(model(x, m), t)
            loss.backward(); opt.step(); sched.step()
        pv = predict(model, X[val], M[val], dev, tta=False)
        auc = roc_auc_score(y[val], pv)
        if auc > best:
            best, best_ep = auc, ep
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
        if ep % 5 == 4 or ep == epochs - 1:
            log(f"  {kind} seed {seed} ep {ep:02d} val_auc(no TTA) {auc:.4f} best {best:.4f}@{best_ep}")
    model.load_state_dict(best_state)
    return model, best, best_ep


def features(Xraw, M):
    """Per-band summaries per date, then median over present dates. Xraw is reflectance (N,D,C,H,W)."""
    N, D, C, H, Wd = Xraw.shape
    c = H // 2
    yy, xx = np.mgrid[:H, :Wd]
    r = np.hypot(yy - c + 0.5, xx - c + 0.5)
    regions = {"c2": r < 2, "c4": r < 4, "c6": r < 6, "ring": (r >= 7) & (r < 11), "all": r >= 0}
    f = []
    names = []
    for nm, msk in regions.items():
        f.append(Xraw[..., msk].mean(-1)); names += [f"{nm}_b{b}" for b in range(C)]
    f.append(Xraw[..., regions["c6"]].std(-1)); names += [f"c6std_b{b}" for b in range(C)]
    f.append(Xraw[..., regions["c6"]].min(-1)); names += [f"c6min_b{b}" for b in range(C)]
    f.append(Xraw[..., regions["c6"]].max(-1)); names += [f"c6max_b{b}" for b in range(C)]
    F = np.concatenate(f, -1)  # N, D, K
    # contrasts and indices on the centre
    c4 = Xraw[..., regions["c4"]].mean(-1); ring = Xraw[..., regions["ring"]].mean(-1)
    eps = 1e-4
    B = {n: i for i, n in enumerate(["B02", "B03", "B04", "B08", "B05", "B06", "B07", "B8A", "B11", "B12"])}
    extra = [c4 - ring,
             ((c4[..., B["B08"]] - c4[..., B["B04"]]) / (c4[..., B["B08"]] + c4[..., B["B04"]] + eps))[..., None],
             ((c4[..., B["B08"]] - c4[..., B["B12"]]) / (c4[..., B["B08"]] + c4[..., B["B12"]] + eps))[..., None],
             ((c4[..., B["B11"]] - c4[..., B["B08"]]) / (c4[..., B["B11"]] + c4[..., B["B08"]] + eps))[..., None]]
    names += [f"c4mring_b{b}" for b in range(C)] + ["ndvi_c4", "nbr_c4", "ndbi_c4"]
    F = np.concatenate([F] + extra, -1)
    Fm = np.where(M[..., None], F, np.nan)
    med = np.nanmedian(Fm, 1)
    sd = np.nanstd(Fm, 1)
    return np.concatenate([med, sd], 1), names + [f"sd_{n}" for n in names]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--threads", type=int, default=6)
    ap.add_argument("--arms", nargs="*", default=["early", "shared", "hgb"])
    ap.add_argument("--tag", default="", help="data snapshot suffix, e.g. _2d: reads X_2d.npy / chips_meta_2d.csv, writes *_2d outputs")
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    dev = torch.device(args.device)
    W.mkdir(exist_ok=True)
    meta, Xr, M, y = load(args.tag)
    T = args.tag
    sub = meta.subsplit.values
    fit, val = np.where(sub == "fit")[0], np.where(sub == "val")[0]
    print(f"kilns with >= 1 date: {len(meta)}; fit {len(fit)} (Zigzag {y[fit].sum()}), val {len(val)} (Zigzag {y[val].sum()})", flush=True)
    res = {}
    if (E2 / f"val_arms{T}.json").exists():
        res = json.load(open(E2 / f"val_arms{T}.json"))
    if "hgb" in args.arms:
        from sklearn.ensemble import HistGradientBoostingClassifier
        F, names = features(Xr, M)
        clf = HistGradientBoostingClassifier(max_iter=600, learning_rate=0.05, max_leaf_nodes=31, l2_regularization=1.0,
                                             class_weight="balanced", early_stopping=False, random_state=SEED)
        clf.fit(F[fit], y[fit])
        p = clf.predict_proba(F)[:, 1]
        auc = roc_auc_score(y[val], p[val])
        print(f"hgb val AUC {auc:.4f}", flush=True)
        np.savez(E2 / f"probs{T}_hgb.npz", kid=meta.kid.values, p=p)
        import pickle
        pickle.dump(clf, open(W / f"e2{T}_hgb.pkl", "wb"))
        res["hgb"] = dict(val_auc=float(auc), n_features=int(F.shape[1]))
    Xs, mu, sd = standardise(Xr, fit)
    del Xr
    for kind in [a for a in args.arms if a in ("early", "shared")]:
        ps, bests = [], []
        for s in range(args.seeds):
            model, best, ep = train_cnn(kind, Xs, M, y, fit, val, dev, args.epochs, SEED + s)
            torch.save(model.state_dict(), W / f"e2{T}_{kind}_s{s}.pt")
            ps.append(predict(model, Xs, M, dev, tta=True)); bests.append((float(best), int(ep)))
        p = np.mean(ps, 0)
        auc = roc_auc_score(y[val], p[val])
        print(f"{kind}: val AUC with TTA, {args.seeds}-seed mean prob {auc:.4f}; per-seed best no-TTA {bests}", flush=True)
        np.savez(E2 / f"probs{T}_{kind}.npz", kid=meta.kid.values, p=p)
        res[kind] = dict(val_auc=float(auc), seeds=args.seeds, per_seed_best_noTTA=bests, epochs=args.epochs)
    json.dump(dict(norm_mean=mu, norm_std=sd), open(W / f"e2{T}_norm.json", "w"))
    cnn = [a for a in ("early", "shared") if a in res]
    if cnn and "hgb" in res:
        best_cnn = max(cnn, key=lambda a: res[a]["val_auc"])
        pc = np.load(E2 / f"probs{T}_{best_cnn}.npz")["p"]; ph = np.load(E2 / f"probs{T}_hgb.npz")["p"]
        p = (pc + ph) / 2
        auc = roc_auc_score(y[val], p[val])
        np.savez(E2 / f"probs{T}_ens.npz", kid=meta.kid.values, p=p)
        res["ens"] = dict(val_auc=float(auc), members=[best_cnn, "hgb"])
        print(f"ens ({best_cnn}+hgb) val AUC {auc:.4f}", flush=True)
    res["_val_n"] = dict(n=int(len(val)), zigzag=int(y[val].sum()), fcbk=int((y[val] == 0).sum()))
    json.dump(res, open(E2 / f"val_arms{T}.json", "w"), indent=1)


if __name__ == "__main__":
    main()
