# Pre-registration: kiln model evaluation

Written Sat 24 Oct 2026, 14:45 PKT, before any data was downloaded or any model trained. The targets
below are fixed. Results are reported against them whatever they turn out to be, misses next to hits.

## Data

SentinelKilnDB (NeurIPS 2025 Datasets and Benchmarks), Hugging Face
`SustainabilityLabIITGN/SentinelKilnDB`. Sentinel-2, 10 m, 128 x 128 RGB patches, Sep 2023 to Feb
2024, hand-validated oriented boxes, classes FCBK, CFCBK, Zigzag. Licence: the dataset card says
CC BY-NC 4.0 and the GitHub README says CC BY-NC-SA 4.0; we follow the stricter one (BY-NC-SA) for
everything derived from it.

Only patches inside Pakistan are used.

## The split, and why it is not the dataset's own

The published split is class-stratified at random, and patches overlap by 30 pixels, so the same kiln
can sit in a training patch and a test patch. That would inflate every number. **We discard the
published split** and re-split Pakistan by **spatial blocks of 0.5 degrees** latitude and longitude:
60% of blocks train, 20% calibration, 20% test, assigned by a fixed seed (20261024) before any model
sees a pixel. A patch belongs to the block holding its centre. A kiln whose box crosses a block edge
stays with its patch's block; patches within 1.3 km (one patch width) of a block edge in a different
split are dropped to remove overlap.

## The two models

1. **Detector** (class-agnostic "kiln"): YOLO oriented-box model, trained on train blocks.
2. **Classifier** (FCBK, Zigzag; CFCBK folded into FCBK because it is the same chimney technology and
   Pakistan has almost none): small CNN on a crop around each box, trained on train blocks.
3. **Conformal sets** on the classifier: split conformal, calibrated on calibration blocks, target
   coverage 90% (alpha = 0.10), score = 1 minus the softmax of the true class.

## Targets, fixed now

| ID | Metric, on test blocks only | Target |
|---|---|---|
| T1 | Detector recall at IoU 0.3 (kiln found at all) | **at least 0.80** |
| T2 | Detector precision at IoU 0.3 | **at least 0.75** |
| T3 | Classifier accuracy, FCBK vs Zigzag, on true kilns | **at least 0.85** |
| T4 | Conformal empirical coverage | **between 0.87 and 0.93** |
| T5 | Share of kilns given a single-class set (a decision, not a refusal) | **at least 0.70** |
| T6 | Of kilns given the single set {Zigzag}, share that are truly FCBK (the costly error: a polluting kiln certified as converted) | **at most 0.05** |

T6 is the one that matters most to the product: a false "converted" certificate is the error that
would let a polluting kiln off. If T6 misses, the product must widen the set (refuse more) until it
passes on calibration data, and say so.

## What would change the product

- T1 or T2 miss: the live map says "kilns we found", never "all kilns", and the miss is shown.
- T3 or T5 miss: more kilns go to "cannot be determined from 10 m imagery; needs an inspector".
- T4 miss: the calibration is wrong and the sets are not trusted until fixed. Reported as a miss.
