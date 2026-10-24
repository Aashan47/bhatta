# Bhatta

**Punjab's brick kiln claims, checked from space and kept on a public ledger.**

Live: https://bhatta.aashanjaved.com · Contract (Ethereum Sepolia):
[`0xD5ED8D10aD23bAc601C065D4179d488037070baC`](https://sepolia.etherscan.io/address/0xD5ED8D10aD23bAc601C065D4179d488037070baC)
· IEEE ClimateChain Global Hackathon 2026, Track 4: Climate Data & Environmental Monitoring.

"Bhatta" is the Urdu and Punjabi word for a brick kiln.

## The problem

On 10 October 2026 Punjab's Senior Provincial Minister said "around 8,000 brick kilns across Punjab had
been converted to zigzag technology, with QR codes assigned to all kilns"
([ProPakistani](https://propakistani.pk/2026/10/10/punjab-provides-10000-super-seeders-converts-8000-brick-kilns-to-zigzag-technology/)).
A joint EPA Punjab and Urban Unit survey counts "approximately 10,394 brick kilns" in the province, and
"1,912 kilns have so far been demolished for failing to adopt zig-zag technology"; EPA inspected 45,736
kilns between 1 January and 25 July 2026
([Express Tribune](https://tribune.com.pk/story/2621873/brick-kiln-crackdown-raises-livelihood-concerns)).
Zigzag firing matters for Punjab's smog: emission measurements in Pakistan found a 15% cut in CO2, 40%
in particulate matter and 60% in black carbon ([ICIMOD](https://www.icimod.org/?p=33152)).

The conversion record is a government list. Nobody outside the EPA can check it, a kiln owner cannot
prove compliance independently, and inspectors have no public way to see which kilns most need a visit.

## What Bhatta does

1. **Finds kilns** in free 10 m Sentinel-2 imagery (October 2026) with an oriented-box detector trained
   on SentinelKilnDB's hand-validated Pakistani kilns.
2. **Classifies each kiln** as old FCBK or Zigzag, with **class-conditional conformal sets at 90%**.
   It states a technology only when the calibrated set has one member; otherwise it says the image
   cannot decide and sends an inspector.
3. **Commits the season to Ethereum Sepolia** as one Merkle root, bound to a manifest of scene ids,
   code commit and model hashes. Anyone can rebuild the root from the published data.
4. **Records inspectors' findings** as EIP-712 signed messages (domain-separated, nonced, with
   deadlines), relayed so inspectors need no funds. A disagreement between the satellite and an
   inspector is a permanent public `Conflict`.
5. **Certifies a kiln only when an inspector confirms Zigzag and the satellite does not contradict
   it.** A later satellite FCBK record withdraws the certificate in public.

## Results, including the misses

Targets were fixed in [`docs/PREREG.md`](docs/PREREG.md) before any data was downloaded, on a spatial
block split (the dataset's own random split leaks overlapping patches). Full detail in
[`docs/RESULTS.md`](docs/RESULTS.md).

| ID | Metric (held-out test blocks) | Target | Result | |
|---|---|---|---|---|
| T1 | Kiln detection recall | at least 0.80 | 0.880 | HIT |
| T2 | Kiln detection precision | at least 0.75 | 0.881 | HIT |
| T3 | FCBK vs Zigzag accuracy | at least 0.85 | 0.793 | MISS |
| T4 | Conformal coverage | 0.87 to 0.93 | 0.863 | MISS |
| T5 | Single-class share | at least 0.70 | 0.856 | HIT |
| T6 | False Zigzag certificates | at most 0.05 | 0.619 | MISS |

At 10 m the satellite finds kilns well but cannot tell a Zigzag from an FCBK reliably. So the product
**never certifies a conversion from imagery**. On held-out kilns it called 24.7% FCBK (3.7% of those
calls were wrong) and refused the other 75.3%. Certification needs a signed inspector finding.

A second pre-registered experiment (E2, [`docs/E2-RESULTS.md`](docs/E2-RESULTS.md)) tried ten Sentinel-2
bands from two winter dates per kiln. It missed all four of its targets (test AUC 0.736 against 0.759
for RGB, and still no safe Zigzag threshold), so the product rule did not change.

**The October 2026 scan:** 22 Punjab districts, 105 Sentinel-2 scenes from 1 to 24 October 2026, 8,879
kilns. 1,316 still show the FCBK shape, 5,255 cannot be decided from 10 m, 2,308 were not seen this
season (demolished, dismantled or missed: the product cannot tell which), and none is certified from
the image alone. Re-running the Lahore scan from the manifest reproduced all 211 records and 368 chips
byte for byte.

## On chain

| | |
|---|---|
| Contract | `KilnLedger`, [`0xD5ED8D10aD23bAc601C065D4179d488037070baC`](https://sepolia.etherscan.io/address/0xD5ED8D10aD23bAc601C065D4179d488037070baC) |
| Season 202610 root | `0x3dbf8264d85963448289834dd3afb2cb1734c46dcb079d06152244556011a989`, [tx](https://sepolia.etherscan.io/tx/0x4f3bb557dc1e2e007cea00a4ac724e1f21529eb1cdb9cc394ad87667a826a104) |
| Check it yourself | `cd contracts && npm ci && npx hardhat run scripts/verify-season.ts --network sepolia` (rebuilds the root from `data/kilns.json`, checks the manifest and model hashes) |
| Demonstration activity | Two **demonstration** inspector keys held by the team signed findings on a few kilns to show certificates, conflicts, a withdrawal and a dispute. **They are not inspections by EPA Punjab.** The app labels them as such. |

Threat model, encoding and gas: [`contracts/README.md`](contracts/README.md), [`contracts/GAS.md`](contracts/GAS.md).

## Run it

Requirements: Python 3.12 with `uv`, Node 20 or later.

```bash
git clone https://github.com/Aashan47/bhatta && cd bhatta

# API (serves the published data and the built web app)
uv venv --python 3.12 api/.venv
uv pip install --python api/.venv/bin/python -r api/requirements.txt
(cd web && npm ci && npm run build)
cd api && .venv/bin/python -m uvicorn bhatta_api.app:app --port 8787
# open http://127.0.0.1:8787

# tests
.venv/bin/python -m pytest -q tests                 # API
(cd ../contracts && npm ci && npx hardhat test)     # contract
```

Fixture mode with no network: `BHATTA_FIXTURE=1`. Reproducing the models and the scan:
[`ml/README.md`](ml/README.md) (the product weights are in `ml/weights/`, sha256 recorded on chain).

## Layout

| Path | What |
|---|---|
| `ml/` | data preparation, detector, classifier, conformal calibration, evaluation, the scan |
| `contracts/` | `KilnLedger` (Solidity, OpenZeppelin), tests, Merkle builder, deploy and verify scripts |
| `api/` | FastAPI: kiln records, proofs, inspection queue, ledger events, relay |
| `web/` | React + TypeScript app, English and Urdu, MapLibre, three.js kiln explainer, viem |
| `data/` | the published season: `kilns.json`, `manifest.json`, chips, Merkle proofs, chain info |
| `docs/` | pre-registration, results, product design |

## Licences and data

- Code: AGPL-3.0 (the ML code uses Ultralytics YOLO, which is AGPL-3.0). See `LICENSE`.
- Kiln labels and everything derived from them, including `data/` and the model weights:
  SentinelKilnDB, **CC BY-NC-SA 4.0**, non-commercial.
- Imagery: contains modified Copernicus Sentinel data (2026), via Element84 Earth Search.
- Boundaries: Natural Earth (public domain), geoBoundaries ADM2 (public domain per its metadata).
- Basemaps: OpenFreeMap / OpenStreetMap contributors; Sentinel-2 cloudless by EOX IT Services GmbH.
- No personal data: kilns are identified by location-derived ids, inspectors by keys.

The Urdu interface has not yet been reviewed by a native reader; the app says so.
