# Results: kiln model evaluation and the October 2026 scan

Pre-registration: `docs/PREREG.md` (targets fixed before any data was downloaded). Every number
below comes from a run in this repository; the command that produced it is given next to it.

## Deviations (written before any test-set number was computed)

D1. **Ground truth per patch is rebuilt from one global kiln table.** The published labels only
include kilns fully inside a patch, so a kiln cut by the patch edge is visible but unlabelled. We
project every label to lon/lat, merge copies from overlapping patches (centroids within 30 m), and
rebuild each patch's labels: kilns at least half visible are targets; kilns less than half visible
are "ignore" (a detection on them is neither TP nor FP). Check: 18,290 fully visible rebuilt labels,
36 without a published counterpart in that patch (0.2%).
Also not specified by PREREG and fixed by us before training: 15% of the train blocks (seed
20261025) are held out as "val" for early stopping and for choosing the detector confidence
threshold (max F1 at IoU 0.3), so calibration blocks are never used for model selection; the
classifier uses one crop per unique kiln (the copy most central in its patch).

D2. **A second classifier arm is trained with kilns from outside Pakistan.** PREREG says only
Pakistan patches are used. The pre-registered Pakistan-only classifier reached AUC 0.77 on the
calibration blocks, and no probability threshold gave a {Zigzag} precision above 0.57 there
(numbers in "Calibration diagnostics" below). This was seen on calibration data, before any test
look. We therefore trained a second arm on Pakistan train blocks plus 48,505 SentinelKilnDB kilns
from outside Pakistan (the dataset also covers India, Bangladesh and Afghanistan; 24,098 Zigzag), all assigned to training only; an external
kiln within 3 km of any Pakistan calibration or test patch centre is dropped. Calibration and test
remain Pakistan-only. The arm used by the product is chosen on the Pakistan train-block "val"
hold-out, never on calibration or test, by AUC of p(Zigzag) with 8-view TTA (the certificate floor
depends on ranking). This criterion was fixed after seeing the per-epoch training logs (which print
val AUC without TTA) and before the arms were compared with TTA or any test number existed.
All arms run, on Pakistan val (n = 947: 841 FCBK, 106 Zigzag), 8-view TTA:

| Arm | Training data | Val AUC | Val NLL | Val acc | Weights |
|---|---|---|---|---|---|
| pk (pre-registered) | Pakistan fit blocks, ResNet18, 32 px crop at 96 px, 30 epochs | **0.856** | 0.297 | 0.861 | `ml/weights/classifier_pk.pt` |
| pk+ext | + 48,505 non-Pakistan kilns, class-balanced, Pakistan crops sampled as much as external, ResNet18, 10 epochs | 0.834 | 0.354 | 0.845 | `ml/weights/classifier_pkext.pt` |
| pk+ext then pk fine-tune | pk+ext weights fine-tuned on Pakistan fit, lr 1e-4, 10 epochs | 0.848 | 0.282 | 0.890 | `ml/weights/classifier_pkext_ft.pt` |
| ResNet50, 36 px crop at 128 px, pk+ext | aborted after 2 of 8 epochs (8 min per epoch while the detector trained; val NLL 0.321 then 0.341, val balanced accuracy 0.59 then 0.57, no TTA) | n/a | n/a | n/a | none |

Outcome: the external South Asia kilns did not improve the Pakistan classifier on held-out
Pakistan data. **The product uses the pre-registered pk arm** (`classifier.pt` is a copy of
`classifier_pk.pt`). Commands: `ml/train_classifier.py --epochs 30 --out classifier_pk.pt`;
`--external --arch resnet18 --input 96 --crop 32 --balanced --pk-weight 1.0 --epochs 10 --batch 256 --out classifier_pkext.pt`;
`--init classifier_pkext.pt --epochs 10 --lr 1e-4 --out classifier_pkext_ft.pt`.

D3. **Product set rule differs from the pre-registered one, and both are reported.** T4 to T6 are
reported for the pre-registered rule (marginal split conformal, alpha 0.10, score 1 - softmax of
the true class). The product uses (a) Mondrian, class-conditional split conformal (one qhat per true
class, so each class gets at least 90% coverage, which bounds false {FCBK} accusations against
Zigzag kilns), and (b) the pre-registered T6 remedy, made rigorous: a floor on p(Zigzag) for a
{Zigzag} certificate chosen on calibration data by Learn-then-Test (Angelopoulos et al., 2021):
Bonferroni over 20 floors (0.50 to 0.975), exact binomial p-value for "false-certificate rate >
0.05", delta 0.10. If no floor passes, the product never certifies Zigzag.

D4. **Rendering of the live imagery.** The dataset scripts (`data_scripts/sentinel_tile_bulk_download.py`)
take GEE `COPERNICUS/S2_SR_HARMONIZED` images with CLOUDY_PIXEL_PERCENTAGE < 1 and keep the median
composite unless the single least-cloudy image has strictly more valid pixels, so most dataset
patches are median composites. The scan uses single-date Earth Search L2A scenes (per pixel, the first valid
scene in the order given in D6). Bands (B4, B3, B2), grid (EPSG:4326 at 10/111319.49 deg), nearest resampling,
128 px patches with 30 px overlap and per-patch per-band min-max scaling are reproduced exactly.
The date range in the dataset is inconsistent across sources (script: 2024-01-01 to 2025-02-28; HF
card: Nov 2023 to Feb 2024; PREREG and GitHub README: Sep 2023 to Feb 2024); the baseline period
in `kilns.json` follows the brief ("2023-09/2024-02").

D5. **Image-to-label alignment in the scan.** Each 2023-24 kiln's SentinelKilnDB patch is matched
to the October 2026 mosaic by normalised cross-correlation (search +-20 px; a shift is used only if
the peak correlation is >= 0.3 and beats zero shift by >= 0.05). In a first scan with the newest
scenes (21 and 23 October), 44 of 142 aligned Lahore kilns needed a shift of about 7 px east-west and
11 px north-south (about 60 m and 110 m). With the 18 October scenes the same 142 kilns needed no
shift beyond 1 px. The dataset and the 18 October scenes agree, so we read the large shift as a
misregistration of some October 2026 scenes, not of the dataset. The scan therefore (a) moves a
2023-24 kiln to where it appears in the image only for matching and chips, (b) gives kilns whose own
alignment is not possible the median shift of the scene that imaged them (scenes with at least 5
aligned kilns), (c) moves new detections back by their scene's shift, and (d) writes the dataset
coordinates for 2023-24 kilns in `kilns.json` (`lat`/`lon` = 2023-24 label centroid; `id` = its
geohash). Scene shifts found are listed per district in `data/summary.json`. The model evaluation is
unaffected (labels and pixels agree within each dataset patch).

D6. **Scene choice for the scan.** The brief asks for the most recent low-cloud scenes. Late October
is smog season in Punjab: chips from the 21 and 23 October scenes were visibly hazy and many known
kilns were not detected in them. The scan therefore takes, per MGRS tile, the cloud-free (< 1%,
as the dataset) October 2026 scenes ranked by the median Sen2Cor aerosol optical thickness (clearest
first, newest as tie-break), keeps three per tile, and fills each pixel from the first valid one.
Scene ids and dates per kiln are in `kilns.json`; all scenes used are in `data/summary.json`.

D7. **Stricter threshold for new kilns.** A detection more than 150 m from every 2023-24 kiln is
reported as a new kiln only if its confidence is >= 0.60 (val precision 0.937, recall 0.721 at that
threshold, n = 1,556 val boxes; at 0.30: precision 0.850). A first full scan of Lahore at 0.30
reported 218 new kilns, most of them visibly buildings in the urban area. Precision in open
country, outside the kiln-rich dataset patches, is not measured and is likely lower than 0.937.
Known kilns count as detected at the evaluated threshold of 0.30.

<!-- numbers below are filled from data/split_counts.json, data/conformal.json, data/eval_results.json and data/summary.json -->

## Data and split (`ml/.venv/bin/python ml/prepare.py`, output `data/split_counts.json`)

Pakistan filter: patch centre inside Natural Earth 10m admin-0 "Pakistan"
(https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson,
public domain). 18,117 of 114,300 published patches are in Pakistan (train 11,449, val 3,810, test
2,858 of the published splits, all pooled). 11,761 unique kilns after merging copies (FCBK 10,079,
Zigzag 1,679, CFCBK 3; CFCBK folded into FCBK). 165 blocks of 0.5 degrees: 99 train (15 of them
held out as "val"), 33 calibration, 33 test. 967 patches dropped by the 1.3 km edge buffer; after
it, no kiln is visible in more than one of train/cal/test.

| Split | Patches | Patches with a kiln | Unique kilns FCBK | Unique kilns Zigzag | Unique kilns CFCBK | Classifier crops |
|---|---|---|---|---|---|---|
| fit (train blocks) | 8,635 | 6,784 | 4,940 | 900 | 1 | 5,840 |
| val (train blocks, early stopping only) | 1,843 | 1,071 | 841 | 106 | 0 | 947 |
| cal | 3,469 | 2,616 | 1,865 | 276 | 0 | 2,139 |
| test | 3,203 | 2,816 | 1,991 | 329 | 1 | 2,320 |
| dropped by edge buffer | 967 | | 442 | 68 | 1 | |

Detector boxes per split (kiln instances at least half visible, counted per patch, so a kiln in two
overlapping patches counts twice): fit 10,009, val 1,556, cal 3,652, test 3,947.

## Models

| Model | File | Size | sha256 |
|---|---|---|---|
| Detector, YOLO11n-OBB, imgsz 256, 40 epochs, 1.00 h on MPS | `ml/weights/detector.pt` (gitignored) | 5.6 MB | `e429b251b9728a7ca7796287ffc829e204f4899eff680df5e8dfdbdf1d673243` |
| Classifier, ResNet18, pk arm (product) | `ml/weights/classifier.pt` (gitignored) | 44.8 MB | `4d07730005a33adf76e315d3a6ffe8b8686822215d58c2dfa145f2d02cbf154a` |
| Classifier, pk+ext arm | `ml/weights/classifier_pkext.pt` | 44.8 MB | `6cc86e80f4cf57b8c0d60bc486e7be241e260c8fbb00d2cb69f810fc96839d3e` |
| Classifier, pk+ext fine-tuned | `ml/weights/classifier_pkext_ft.pt` | 44.8 MB | `724ef771e5568bc4486185d67636c88d6a311a4acdbcbaa5473283657c37fef1` |

Detector confidence threshold, chosen on the val hold-out (max F1 at IoU 0.3): **0.30** (val:
precision 0.850, recall 0.888, n = 1,556 boxes).

Conformal (`ml/.venv/bin/python ml/conformal.py`, `data/conformal.json`), calibration n = 2,139
(1,863 FCBK, 276 Zigzag): marginal **qhat = 0.6005** (alpha 0.10). Mondrian qhat: FCBK 0.4659,
Zigzag 0.9871. Learn-then-Test Zigzag floor: **none valid** (at every floor from 0.50 to 0.875 the
false-certificate share on calibration was 0.29 to 0.56; above 0.875 no kiln qualifies), so the
product never issues a {Zigzag} certificate.

Calibration diagnostics (the reason for D2 and D3), pk arm on calibration kilns: AUC of p(Zigzag)
0.772; kilns with p(Zigzag) >= 0.5: 289, of which 44% are Zigzag; >= 0.7: 84, 54%; >= 0.8: 21, 57%;
>= 0.9: none.

## T1 to T6 on test blocks (`ml/.venv/bin/python ml/evaluate.py`, `data/eval_results.json`)

Run once, after D1 to D3 were fixed and the classifier arm chosen.

| ID | Metric | Target | Result | n | Verdict |
|---|---|---|---|---|---|
| T1 | Detector recall, IoU 0.3, conf 0.30 | >= 0.80 | **0.880** (3,473 of 3,947 boxes) | 3,203 test patches | **HIT** |
| T2 | Detector precision, IoU 0.3, conf 0.30 | >= 0.75 | **0.881** (3,473 TP, 469 FP) | 3,942 detections | **HIT** |
| T3 | Classifier accuracy, FCBK vs Zigzag, true kilns | >= 0.85 | **0.793** (balanced 0.657, AUC 0.759) | 2,320 kilns (1,991 FCBK, 329 Zigzag) | **MISS** |
| T4 | Conformal coverage, pre-registered marginal rule | 0.87 to 0.93 | **0.863** (2,002 of 2,320) | 2,320 | **MISS** |
| T5 | Share given a single-class set | >= 0.70 | **0.856** (1,985 of 2,320) | 2,320 | **HIT** |
| T6 | Of {Zigzag} sets, share truly FCBK | <= 0.05 | **0.619** (174 of 281) | 281 | **MISS** |

Supporting numbers. Kiln-level detector recall (a unique test kiln found in at least one patch):
0.909 (2,109 of 2,321). Classifier confusion on test (rows true, columns predicted, FCBK then
Zigzag): [[1,686, 305], [175, 154]]. Coverage by class under the pre-registered rule: FCBK 0.913,
Zigzag 0.562; the rule covers the average while missing Zigzag kilns. Calibration coverage was 0.901
and test coverage 0.863: the calibration and test blocks are not exchangeable (spatial shift between
regions), which is the most likely reason T4 misses.

T6 fallbacks, both computed on calibration data and then applied to test, labelled **post-hoc**:
* the simple floor from PREREG's remedy ("widen until T6 passes on calibration"): p(Zigzag) >= 0.89
  gives 1 certificate on calibration (0 false); on test it gives 3 {Zigzag} sets, 2 of them truly
  FCBK (0.667). It does not pass on test.
* the Learn-then-Test floor (D3): no floor is valid, so no {Zigzag} certificates are issued; T6 is
  then vacuous (0 certificates, 0 false).

## The product rule on test (D3: Mondrian sets, no {Zigzag} certificate)

| Measure | Result | n |
|---|---|---|
| Coverage, all | 0.991 (2,299 of 2,320) | 2,320 |
| Coverage, true FCBK | 1.000 | 1,991 |
| Coverage, true Zigzag | 0.936 | 329 |
| Certified Zigzag ({Zigzag}) | 0 | 2,320 |
| Called FCBK ({FCBK}) | 573 (24.7%); 21 of them truly Zigzag (3.7% of the FCBK calls; 6.4% of all Zigzag kilns) | 2,320 |
| Refused ({FCBK, Zigzag}: needs an inspector) | 1,747 (75.3%) | 2,320 |

Mondrian sets without the certificate floor, for reference: 517 {Zigzag} sets of which 353 are
truly FCBK (0.683); this is why the floor exists.

End to end (detected test kilns, crop around the detected box rather than the hand label):
n = 2,109, accuracy 0.785; product rule: 493 {FCBK}, 18 of them truly Zigzag; 1,616 refused; 0
{Zigzag}.

**Plain reading.** At 10 m, Sentinel-2 finds Pakistani kilns well (T1, T2 hit) but cannot tell a
Zigzag kiln from an FCBK reliably enough to certify a conversion (T3, T6 miss; best calibration
precision for Zigzag about 0.57). The product therefore never certifies a conversion from imagery.
It marks about a quarter of kilns as still FCBK (with a 3.7% false-accusation share among those
calls on test) and sends the rest to an inspector. That is the honest output of these models.
