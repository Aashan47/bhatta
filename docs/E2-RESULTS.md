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

## Calibration (cal blocks, n = 2,139: 1,863 FCBK, 276 Zigzag; `ml/e2/evaluate.py`)

Early arm on calibration: AUC of p(Zigzag) 0.755 (pk arm: 0.772). Mondrian qhat (alpha 0.10):
FCBK 0.6153, Zigzag 0.8078. Learn-then-Test Zigzag floor (Bonferroni over 20 floors 0.50 to
0.975, exact binomial p-value for a false-certificate rate above 0.05, delta 0.10): **no floor is
valid**. From 0.50 to 0.875 the false share among {Zigzag} sets on calibration was 0.25 to 0.61
(0.50: 184 of 301; 0.80: 28 of 66; 0.85: 9 of 24; 0.875: 2 of 8, p = 0.994); at 0.90 one kiln
qualifies and it is FCBK; above that none. The best raw precision for Zigzag on calibration is
again about 0.58 (p(Zigzag) >= 0.8: 66 kilns, 57.6% Zigzag), the same ceiling as the RGB model.

## E2a to E2d on test blocks (run once, 19:23 PKT, `data/e2/e2_results.json`)

| ID | Metric | Target | Result | n | Verdict |
|---|---|---|---|---|---|
| E2a | AUC of p(Zigzag), FCBK vs Zigzag | >= 0.85 | **0.736** (pk arm on the same 2,320 kilns: 0.759) | 2,320 (1,991 FCBK, 329 Zigzag) | **MISS** |
| E2b | A valid Learn-then-Test Zigzag floor on calibration | yes | **none** | 2,139 cal kilns | **MISS** |
| E2c | Share of true Zigzag test kilns certified at that floor | >= 0.15 | **0.000** (0 of 329; no floor, so no certificate) | 329 | **MISS** |
| E2d | Share of {Zigzag} test sets that are truly FCBK | <= 0.05 | **no {Zigzag} set issued** (0 of 0); vacuous, counted as a miss because it rests on E2b | 0 | **MISS** |

The product switches to E2 only if E2a to E2d all hold. **None holds. The product does not switch.**

## The product rule on test with E2 (Mondrian sets, no {Zigzag} certificate since no floor is valid)

| Measure | E2 early arm | pk arm (product, `docs/RESULTS.md`) | n |
|---|---|---|---|
| Coverage, all | 0.990 (2,296 of 2,320) | 0.991 | 2,320 |
| Coverage, true FCBK / true Zigzag | 1.000 / 0.927 | 1.000 / 0.936 | 1,991 / 329 |
| Certified Zigzag ({Zigzag}) | 0 | 0 | 2,320 |
| Called FCBK ({FCBK}) | 758 (32.7%); 24 of them truly Zigzag (3.2% of the FCBK calls; 7.3% of all Zigzag kilns) | 573 (24.7%); 21 truly Zigzag (3.7%; 6.4% of Zigzag kilns) | 2,320 |
| Refused ({FCBK, Zigzag}) | 1,562 (67.3%) | 1,747 (75.3%) | 2,320 |

Mondrian sets without a floor, for reference: 393 {Zigzag} sets on test, 272 of them truly FCBK
(0.692).

**Post hoc, not used for any decision** (computed after the test look, to report every arm run):
AUC of p(Zigzag) on cal / test: early 0.755 / 0.736, shared 0.735 / 0.738, hgb 0.719 / 0.694,
ens 0.757 / 0.736. No arm reaches the pk arm's 0.759 on test; the arm choice did not cost E2a.

## Plain reading

E2 fails all four targets. Ten Sentinel-2 bands from two clear winter dates did not separate
Zigzag from FCBK kilns any better than the RGB median composite: test AUC 0.736 against 0.759, and
on calibration 25% to 61% of the {Zigzag} calls are FCBK at every floor that issues any
certificate, so no Zigzag certificate is possible. The one honest gain is small and on the FCBK side: the E2
sets call 758 test kilns FCBK instead of 573 (3.2% of those calls wrong instead of 3.7%), and
refuse 67% instead of 75%. That is not what E2 was registered to test, it was not a target, and
it does not justify replacing a model the rest of the product (scan, API, web) is built around.
**Decision: do not switch. The product rule stays as it is: never certify Zigzag from imagery,
call FCBK only under the Mondrian set, send the rest to an inspector.**

Limits of this test, stated so nobody over-reads the miss: two dates rather than the registered
up-to-four (E2-D3), most of them November and December; Planetary Computer rather than Earth
Search pixels (E2-D1, same product); a small CNN at 10 m. What it does show is that the spectral
bands and a second date are not the missing signal at 10 m: val looked better (0.874 against
0.856), and calibration and test did not follow, the same val-to-test drop the RGB model had. Our
reading (not tested here) is that the limit is spatial resolution, not the band set.

## Files

- Code: `ml/e2/fetch.py`, `ml/e2/align_check.py`, `ml/e2/train.py`, `ml/e2/evaluate.py`
- Per-kiln metadata and scene ids: `data/e2/chips_meta.csv`; alignment: `data/e2/alignment_check.json`
- Val arms: `data/e2/val_arms.json`, `data/e2/train.log`; results: `data/e2/e2_results.json`
- Chips (gitignored): `data/e2/raw/X.npy` (11,246 x 4 x 10 x 24 x 24 uint16; dates 3 and 4 are zero),
  per-tile `data/e2/raw/tiles/*.npz` (with the SCL windows), STAC item lists `data/e2/raw/items*.json`
- Weights (gitignored), sha256: `e2_early_s0.pt` 90b4f11f6ab9b5372ac1a3bb891e2f6c02b69c20433c966582c1e0a13755d810,
  `e2_early_s1.pt` b13bb6f90eb1cd9cb2afd82ac603c7573592d6c7508fc9464bb9a0e8d9bd88c6,
  `e2_early_s2.pt` c23a1281bdffc79ecd45bffb1c0e4292c40e812efb88f1c29bebc816e193ac66;
  the other arms' hashes are in `data/e2/e2_results.json`.
