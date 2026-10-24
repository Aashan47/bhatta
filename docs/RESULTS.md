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
from India, Bangladesh and Afghanistan (24,098 Zigzag), all assigned to training only; an external
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
patches are median composites. The scan uses single-date Earth Search L2A scenes (newest clear
scene per pixel). Bands (B4, B3, B2), grid (EPSG:4326 at 10/111319.49 deg), nearest resampling,
128 px patches with 30 px overlap and per-patch per-band min-max scaling are reproduced exactly.
The date range in the dataset is inconsistent across sources (script: 2024-01-01 to 2025-02-28; HF
card: Nov 2023 to Feb 2024; PREREG and GitHub README: Sep 2023 to Feb 2024); the baseline period
in `kilns.json` follows the brief ("2023-09/2024-02").

D5. **Georeference correction of 2023-24 labels in the scan.** Matching the dataset patches to the
October 2026 mosaic by normalised cross-correlation showed that some dataset patches are displaced
by about 7 px east-west and 11 px north-south (about 60 m and 110 m) from the position their file
names imply, and their kilns with them. The scan estimates the shift per dataset patch (search
+-20 px, applied only if peak correlation >= 0.3 and beats zero shift by >= 0.05) and moves the
2023-24 kiln to its corrected position before matching. `id` stays the geohash of the uncorrected
2023-24 centroid so it traces back to the dataset; `lat`/`lon` in `kilns.json` are corrected.
This does not affect the model evaluation (labels and pixels agree within each patch).

<!-- numbers below are filled from data/split_counts.json, data/conformal.json, data/eval_results.json and data/summary.json -->
