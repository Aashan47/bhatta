"""Train the class-agnostic kiln detector (YOLO oriented boxes) on train blocks.

Early stopping uses the "val" hold-out carved from train blocks; calibration and test blocks are
never seen here.

Usage: ml/.venv/bin/python ml/train_detector.py [--epochs 40] [--imgsz 256] [--device mps]
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import RUNS, SEED, WORK


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="yolo11n-obb.pt")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--imgsz", type=int, default=256)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--device", default="mps")
    ap.add_argument("--patience", type=int, default=10)
    ap.add_argument("--fraction", type=float, default=1.0)
    ap.add_argument("--name", default="detector")
    args = ap.parse_args()

    from ultralytics import YOLO
    model = YOLO(args.model)
    model.train(
        data=str(WORK / "yolo" / "data.yaml"),
        epochs=args.epochs, imgsz=args.imgsz, batch=args.batch, device=args.device,
        patience=args.patience, seed=SEED, deterministic=False, workers=4,
        project=str(RUNS), name=args.name, exist_ok=True, fraction=args.fraction,
        # nadir imagery: any rotation or flip is a valid view
        fliplr=0.5, flipud=0.5, degrees=90.0, mosaic=1.0, scale=0.3, translate=0.1,
        hsv_h=0.0, hsv_s=0.3, hsv_v=0.3, plots=False, verbose=True,
    )
    best = RUNS / args.name / "weights" / "best.pt"
    out = Path(__file__).resolve().parent / "weights"
    out.mkdir(exist_ok=True)
    shutil.copy(best, out / "detector.pt")
    print(f"saved {out / 'detector.pt'}")


if __name__ == "__main__":
    main()
