# Bhatta ML: reproduce

Everything runs on a laptop (tested on an Apple M5 Pro, 24 GB, MPS for training, CPU for the scan).
Public data only. Commands are run from the repository root.

## 0. Environment

```bash
uv venv --python 3.12 ml/.venv
uv pip install --python ml/.venv/bin/python -r ml/requirements.txt
```

## 1. Data and the pre-registered split

```bash
ml/.venv/bin/python ml/prepare.py
```

Downloads the three SentinelKilnDB parquets from Hugging Face one at a time, keeps Pakistan patches
(Natural Earth 10m admin-0, public domain) in `data/raw/pk_*.parquet`, deletes each full parquet,
assigns 0.5 degree blocks (seed 20261024) to train/cal/test, applies the 1.3 km edge buffer, and
writes the YOLO dataset (`ml/work/yolo`), the classifier crops (`ml/work/crops`),
`data/splits.csv`, `data/pk_kilns_2023.csv` and `data/split_counts.json`.

Optional, classifier arm "pk+ext" (deviation D2 in `docs/RESULTS.md`):

```bash
ml/.venv/bin/python ml/prepare_external.py     # non-Pakistan kiln crops, re-downloads the parquets
```

## 2. Models

```bash
ml/.venv/bin/python ml/train_detector.py --epochs 40            # YOLO11n-OBB, imgsz 256 -> ml/weights/detector.pt
ml/.venv/bin/python ml/train_classifier.py --epochs 30 --out classifier_pk.pt
ml/.venv/bin/python ml/train_classifier.py --external --balanced --pk-weight 1.0 --epochs 10 \
    --batch 256 --out classifier_pkext.pt
cp ml/weights/<chosen arm>.pt ml/weights/classifier.pt && cp ml/weights/<chosen arm>.json ml/weights/classifier.json
```

The arm is chosen on the Pakistan train-block "val" hold-out (see `docs/RESULTS.md`).

## 3. Conformal calibration and evaluation (T1 to T6)

```bash
ml/.venv/bin/python ml/conformal.py      # data/conformal.json: qhat, Mondrian qhats, LTT Zigzag floor
ml/.venv/bin/python ml/evaluate.py       # data/eval_results.json: test-block metrics
```

## 4. Live scan (October 2026 Sentinel-2 L2A, Element84 Earth Search, no key)

```bash
# full scan of the core districts (finds new kilns too)
ml/.venv/bin/python ml/scan.py --districts Lahore Kasur Sheikhpura --mode full
# every other district with 2023-24 kilns: patches around known kilns only
ml/.venv/bin/python ml/scan.py --all-known
# write data/kilns.json, data/fixtures/kilns.sample.json, data/summary.json, data/manifest.json, data/audit/sample.json
ml/.venv/bin/python ml/scan.py --merge
```

`--fetch-only` downloads and caches the mosaics (`data/raw/mosaics/`) without running models.
District outputs are written one district at a time to `data/scan/districts/`, chips to `data/chips/`.

## 5. Recompute and check

```bash
ml/.venv/bin/python ml/verify_scan.py --district Lahore
```

Re-runs one district from `data/manifest.json` (fixed scene ids, rendering, CPU deterministic
inference, imagery read again from the network) and diffs the records and chips against
`data/kilns.json`. It needs the same weights (sha256 in the manifest) and `data/raw/pk_*.parquet`
(from step 1) for the baseline chips.
