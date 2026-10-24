# E2 results: multispectral, multi-date classifier

Pre-registration: `docs/PREREG.md`, Addendum A (targets E2a to E2d fixed before any E2 data was
fetched). Scripts: `ml/e2/fetch.py`, `ml/e2/train.py`, `ml/e2/evaluate.py`. Every number below
comes from a run of those scripts; nothing is estimated.

## Deviations (written before any test-set number was computed)

E2-D1. **Data source: Microsoft Planetary Computer instead of Element84 Earth Search.** Addendum A
does not name the source; the task brief did (Earth Search). Measured from this machine on Sat 24
Oct 2026 (while the live scan was also downloading): Earth Search COGs (AWS us-west-2) gave about
0.2 MB/s per connection and 0.85 MB/s in total with 12 parallel range requests; one 1024 x 1024
block took 11 s. Planetary Computer COGs (Azure West Europe) gave 4.4 MB/s with 16 connections,
and their internal tiles are 512 x 512 at 10 m (Earth Search: 1024 x 1024), so a kiln window pulls
a quarter of the bytes. Reading 10 bands at 1,541 distinct 10 km blocks per date would not have
fitted the time box from Earth Search. The product is the same (Sentinel-2 L2A, Sen2Cor,
processing baselines 05.09 and 05.10, same 10 m and 20 m UTM grids, same DN scaling); Planetary
Computer granules carry Microsoft-produced granule ids. Scene filter unchanged: `eo:cloud_cover`
< 5, 2023-11-01 to 2024-02-29. The Earth Search item list was fetched first and is kept
(`data/e2/raw/items_earthsearch.json`, 2,971 items) for reference.

E2-D2. **Kiln set and coordinates.** Exactly the 11,246 kilns of the pre-registered classifier
(`ml/work/crops.csv`: fit 5,840, val 947, cal 2,139, test 2,320), with their pre-registered block
and split. The chip centre is the label centroid from `data/pk_kilns_2023.csv`, projected to the
tile's UTM zone; the chip is the 24 x 24 window of 10 m pixels starting at round(col) - 12, so the
centroid lies within half a pixel of the chip centre. Each kiln is read from one MGRS tile (the one
whose extent holds it at least 40 px from the edge and whose scenes cover it most often), so all
its dates share one pixel grid.

E2-D3. **Dates per kiln and the local cloud test.** Per tile, scenes are tried in a fixed order
(best scene of each month first, ranked by full coverage then cloud cover; then the second best of
each month; ...). A date is kept for a kiln if the SCL pixels under its chip contain no nodata (0),
saturated (1), cloud shadow (3), cloud medium or high (8, 9) or cirrus (10), and all 10 bands are
non-zero in the chip. Dates were fetched in rounds (first one date for every kiln, then a second).
A round took 55 to 65 minutes at the 4 to 6 MB/s this link sustained, so **the run stops at two
dates per kiln** (decided at 18:25 PKT, before any E2 model was trained on two-date data and before
any test number): rounds 3 and 4 would not have left time to train, calibrate and evaluate inside
the time box. Addendum A says "up to four" dates; E2 therefore tests two dates, which is a weaker
version of the multi-date idea than pre-registered. A preliminary run on the one-date snapshot
(val only) is reported under "Arms on val".

E2-D4. **Kilns with no usable date** cannot be scored by E2. They are left out of training and of
calibration. On test, the product rule refuses them (set {FCBK, Zigzag}); E2a is computed on test
kilns with a chip; E2c uses every pre-registered test Zigzag kiln in the denominator (a kiln with
no chip is not certified), and is also given among kilns with a chip; E2d counts {Zigzag} sets
among all test kilns.

E2-D5. **Model selection details not fixed by Addendum A.** Inputs: reflectance (DN - 1000) / 10000
(the baseline 04.00+ offset), standardised per band with fit-block statistics. Arms (all trained on
fit blocks only): `early` (small CNN, 4 dates x 10 bands stacked as 40 channels, missing dates
filled by repeating present ones), `shared` (the same CNN as a per-date encoder, masked mean and
max pooling over present dates, random date dropout in training), `hgb` (sklearn
HistGradientBoosting on per-band centre, ring and contrast summaries, median and spread over
dates), `ens` (mean of the better CNN arm and `hgb`). CNN arms: 3 seeds averaged, class-balanced
cross-entropy, dihedral augmentation, random 20 px crop in training and the centre 20 px at
evaluation, 8-view TTA; the checkpoint of each seed is the epoch with the best val AUC (no TTA).
The arm used is the one with the highest val AUC of p(Zigzag) with TTA. Calibration blocks are
never used for any of this.

E2-D6. **Pixel alignment check (no correction applied).** The labels come from a GEE grid in
EPSG:4326; the chips are cut from the UTM tiles. `ml/e2/align_check.py` (output
`data/e2/alignment_check.json`) averages the per-chip standardised image of the first date over
all 11,246 kilns and locates the kiln blob. In the bands where the kiln is brighter than its
surroundings (B04, B05, B11, B12: centre minus edge 0.92, 0.98, 1.49, 1.67 standard deviations),
the blob centroid sits 0.22 to 0.29 px east and 0.53 to 0.62 px south of the label centroid
(1 px = 10 m). A per-kiln cross-correlation of B12 with the mean template (search +-4 px) gives a
median shift of (0, 0) px. There is no systematic offset of a pixel or more, so the chips are used
as cut. The model input is the centre 20 px with +-2 px random shifts in training, which absorbs
offsets of this size.

E2-D7. **Training length.** CNN arms were trained for 30 epochs (OneCycle learning rate, AdamW,
batch 128) on MPS, 3 seeds each (seeds 20261024 to 20261026); `train.py` defaults to 40 but the
run used `--epochs 30`, the setting of the one-date preliminary run.

## Data (`ml/e2/fetch.py`, outputs `data/e2/chips_meta.csv`, `data/e2/raw/X.npy`)

Planetary Computer, `sentinel-2-l2a`, 2023-11-01 to 2024-02-29, `eo:cloud_cover` < 5: 3,731 items
over 158 MGRS tiles; kilns fall in 55 tiles. Two fetch rounds (16:47 to 17:54 and 17:54 to 18:50 PKT). Round 1 had
downloaded 15.0 GB of COG blocks by 17:48 (nettop), because each kiln window pulls whole internal
tiles; only the 24 x 24 chips are stored (`data/e2/` is 1.0 GB).

| Split | FCBK kilns with chip | Zigzag kilns with chip | Pre-registered kilns | Dates per kiln |
|---|---|---|---|---|
| fit | 4,940 | 900 | 5,840 | 2 for every kiln |
| val | 841 | 106 | 947 | 2 for every kiln |
| cal | 1,863 | 276 | 2,139 | 2 for every kiln |
| test | 1,991 | 329 | 2,320 | 2 for every kiln |

Every one of the 11,246 kilns got two locally clear dates; none was left without a chip, so E2-D4
never applies. The first date is November 2023 for 10,448 kilns (December 435, February 361,
January 2); the second is December 2023 for 10,384 (February 542, January 310, November 10).
Median gap between the two dates: 20 days. 127 distinct scenes; per-kiln scene ids are in
`data/e2/chips_meta.csv` (`scene0`, `scene1`).

## Arms on val (train-block hold-out, n = 947: 841 FCBK, 106 Zigzag; `ml/e2/train.py`)

AUC of p(Zigzag); CNN arms with 8-view TTA and the mean of 3 seeds. Every arm that was run is listed.

| Arm | Input | Val AUC | Notes |
|---|---|---|---|
| **early** | 2 dates x 10 bands as channels, small CNN | **0.874** | per seed, best epoch without TTA: 0.871, 0.875, 0.871 |
| shared | per-date CNN encoder, mean + max over dates | 0.864 | per seed: 0.861, 0.864, 0.859 |
| hgb | 186 per-band summary features, gradient boosting | 0.846 | |
| ens | mean of early and hgb | 0.874 (0.8737 vs early 0.8743) | |
| preliminary, one date (first fetch round) | same arms, 1 seed, 30 epochs | early 0.868, shared 0.859, hgb 0.816, ens 0.858 | run to check the pipeline; not used |
| reference: pk arm (RGB ResNet18, product) | `docs/RESULTS.md` D2 | 0.856 | same val kilns |

**Chosen arm: early** (highest val AUC). Weights `ml/e2/weights/e2_early_s{0,1,2}.pt` (gitignored;
sha256 in `data/e2/e2_results.json`). Note that on val the pk arm also looked fine (0.856) and then
reached 0.759 on test; val here is 15 train blocks next to the fit blocks, so a val gain this small
(0.874 against 0.856) says little about test.
