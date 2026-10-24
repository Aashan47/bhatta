"""Train the FCBK vs Zigzag crop classifier (ResNet18, ImageNet init) on train-block kilns.

Crops are 40 px around each kiln (one crop per unique kiln, from the patch where it is most
central). Training takes a random 32 px window (shift jitter), random flips and 90 degree turns;
evaluation takes the centre 32 px. The 32 px crop is resized to 96 px for the network.
Early stopping on the "val" hold-out inside train blocks (never on calibration blocks).

A JSON sidecar (weights/<name>.json) records arch, input size and crop size; every consumer
loads the model through load_classifier() so the scan uses exactly the trained preprocessing.

Usage:
  ml/.venv/bin/python ml/train_classifier.py --epochs 30 --out classifier_pk.pt          (pre-registered arm)
  ml/.venv/bin/python ml/train_classifier.py --external --arch resnet50 --input 128 \
      --crop 36 --balanced --epochs 8 --out classifier_pkext.pt                         (deviation D2 arm)
"""
from __future__ import annotations

import json

import argparse
import random
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CLS2, CROP, CROP_INPUT, SEED, WORK

MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def seed_all(seed=SEED):
    random.seed(seed); np.random.seed(seed); torch.manual_seed(seed)


DEFAULT_CFG = dict(arch="resnet18", input=CROP_INPUT, crop=CROP)


def build_model(arch: str = "resnet18", pretrained: bool = True):
    import torchvision
    if arch == "resnet18":
        m = torchvision.models.resnet18(weights=torchvision.models.ResNet18_Weights.IMAGENET1K_V1 if pretrained else None)
    elif arch == "resnet50":
        m = torchvision.models.resnet50(weights=torchvision.models.ResNet50_Weights.IMAGENET1K_V2 if pretrained else None)
    else:
        raise ValueError(arch)
    m.fc = nn.Linear(m.fc.in_features, len(CLS2))
    return m


def load_classifier(path: Path, device="cpu"):
    """Return (model, cfg) for a weights file and its JSON sidecar (defaults if absent)."""
    side = Path(path).with_suffix(".json")
    cfg = dict(DEFAULT_CFG)
    if side.exists():
        cfg.update(json.load(open(side)))
    m = build_model(cfg["arch"], pretrained=False)
    m.load_state_dict(torch.load(path, map_location="cpu"))
    m.eval().to(device)
    return m, cfg


def to_tensor(crop: np.ndarray, size: int = CROP_INPUT) -> torch.Tensor:
    """uint8 HxWx3 crop -> normalised 3 x size x size tensor."""
    img = Image.fromarray(crop).resize((size, size), Image.BILINEAR)
    a = (np.asarray(img, dtype=np.float32) / 255.0 - MEAN) / STD
    return torch.from_numpy(a.transpose(2, 0, 1).copy())


def center_crop(a: np.ndarray, c: int = CROP) -> np.ndarray:
    m = (a.shape[0] - c) // 2
    return a[m:m + c, m:m + c]


center32 = center_crop


class CropDS(torch.utils.data.Dataset):
    def __init__(self, rows: pd.DataFrame, train: bool, cfg: dict | None = None):
        self.rows = rows.reset_index(drop=True)
        self.train = train
        self.cfg = cfg or dict(DEFAULT_CFG)
        self.imgs = [np.array(Image.open(WORK / "crops" / r.subsplit / r.cls2 / f"{r.id}_{r.kid}.png").convert("RGB"))
                     for r in self.rows.itertuples()]
        self.y = [CLS2.index(c) for c in self.rows.cls2]

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        a = self.imgs[i]
        c = self.cfg["crop"]
        if self.train:
            m = a.shape[0] - c
            x0, y0 = np.random.randint(0, m + 1), np.random.randint(0, m + 1)
            a = a[y0:y0 + c, x0:x0 + c]
            a = np.rot90(a, np.random.randint(4))
            if np.random.rand() < 0.5:
                a = a[:, ::-1]
            if self.cfg.get("jitter"):
                g = np.random.uniform(0.85, 1.15); b = np.random.uniform(-15, 15)
                a = np.clip(a.astype(np.float32) * g + b, 0, 255).astype(np.uint8)
            a = np.ascontiguousarray(a)
        else:
            a = center_crop(a, c)
        return to_tensor(a, self.cfg["input"]), self.y[i]


@torch.no_grad()
def predict_probs(model, tensors: torch.Tensor, device, tta: bool = True) -> np.ndarray:
    """Softmax probabilities; with tta, averaged over the 8 dihedral views."""
    model.eval()
    out = []
    for i in range(0, len(tensors), 256):
        x = tensors[i:i + 256].to(device)
        if tta:
            ps = []
            for k in range(4):
                xr = torch.rot90(x, k, dims=(2, 3))
                ps.append(torch.softmax(model(xr), 1))
                ps.append(torch.softmax(model(torch.flip(xr, dims=(3,))), 1))
            p = torch.stack(ps).mean(0)
        else:
            p = torch.softmax(model(x), 1)
        out.append(p.float().cpu().numpy())
    return np.concatenate(out) if out else np.zeros((0, len(CLS2)), dtype=np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--device", default="mps")
    ap.add_argument("--external", action="store_true", help="add non-Pakistan crops to training (deviation D2)")
    ap.add_argument("--out", default="classifier.pt")
    ap.add_argument("--arch", default="resnet18")
    ap.add_argument("--input", type=int, default=CROP_INPUT)
    ap.add_argument("--crop", type=int, default=CROP)
    ap.add_argument("--balanced", action="store_true", help="class-balanced sampling and colour jitter")
    ap.add_argument("--pk-weight", type=float, default=1.0, help="sampling weight of Pakistan crops relative to external ones")
    args = ap.parse_args()
    cfg = dict(arch=args.arch, input=args.input, crop=args.crop, jitter=bool(args.balanced))
    seed_all()
    dev = torch.device(args.device)
    rows = pd.read_csv(WORK / "crops.csv")
    fit, val = rows[rows.subsplit == "fit"], rows[rows.subsplit == "val"]
    if args.external:
        ext = pd.read_csv(WORK / "crops_ext.csv")
        fit = pd.concat([fit, ext[["kid", "id", "subsplit", "cls2", "cls_src", "patch"]]], ignore_index=True)
    print(f"fit {fit.cls2.value_counts().to_dict()}  val {val.cls2.value_counts().to_dict()}")
    ds_fit, ds_val = CropDS(fit, True, cfg), CropDS(val, False, cfg)
    counts = np.bincount(ds_fit.y, minlength=2)
    gen = torch.Generator().manual_seed(SEED)
    if args.balanced:
        yy = np.array(ds_fit.y)
        is_pk = (ds_fit.rows.subsplit != "ext").values
        sw = np.zeros(len(yy))
        for grp, gw in ((is_pk, args.pk_weight), (~is_pk, 1.0)):
            for c in range(2):
                m = grp & (yy == c)
                if m.any():
                    sw[m] = gw / m.sum()
        sampler = torch.utils.data.WeightedRandomSampler(sw, num_samples=len(sw), replacement=True, generator=gen)
        dl = torch.utils.data.DataLoader(ds_fit, batch_size=args.batch, sampler=sampler, num_workers=0)
        w = None
    else:
        w = torch.tensor(counts.sum() / (2 * np.maximum(counts, 1)), dtype=torch.float32, device=dev)
        dl = torch.utils.data.DataLoader(ds_fit, batch_size=args.batch, shuffle=True, num_workers=0, generator=gen)
    xv = torch.stack([ds_val[i][0] for i in range(len(ds_val))])
    yv = np.array(ds_val.y)
    model = build_model(args.arch).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    lossf = nn.CrossEntropyLoss(weight=w, label_smoothing=0.0)
    best, best_ep = 1e9, -1
    out = Path(__file__).resolve().parent / "weights"
    out.mkdir(exist_ok=True)
    with open((out / args.out).with_suffix(".json"), "w") as fh:
        json.dump(dict(arch=args.arch, input=args.input, crop=args.crop, external=bool(args.external),
                       balanced=bool(args.balanced), pk_weight=args.pk_weight, epochs=args.epochs, lr=args.lr), fh, indent=1)
    for ep in range(args.epochs):
        model.train()
        tl = 0.0
        for x, y in dl:
            x, y = x.to(dev), y.to(dev)
            opt.zero_grad()
            loss = lossf(model(x), y)
            loss.backward()
            opt.step()
            tl += loss.item() * len(y)
        sched.step()
        pv = predict_probs(model, xv, dev, tta=False)
        nll = float(-np.mean(np.log(pv[np.arange(len(yv)), yv] + 1e-9)))
        acc = float((pv.argmax(1) == yv).mean())
        bal = float(np.mean([(pv.argmax(1)[yv == c] == c).mean() for c in range(2) if (yv == c).any()]))
        from sklearn.metrics import roc_auc_score
        auc = float(roc_auc_score(yv, pv[:, 1]))
        print(f"ep {ep:02d} train_loss {tl / len(ds_fit):.4f} val_nll {nll:.4f} val_acc {acc:.4f} val_bal_acc {bal:.4f} val_auc {auc:.4f}", flush=True)
        if nll < best:
            best, best_ep = nll, ep
            torch.save(model.state_dict(), out / args.out)
    print(f"best val_nll {best:.4f} at epoch {best_ep}; saved {out / args.out}")


if __name__ == "__main__":
    main()
