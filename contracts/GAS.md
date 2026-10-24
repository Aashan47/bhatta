# KilnLedger gas

Measured 24 Oct 2026. Solidity 0.8.28, optimizer on (200 runs), viaIR, EVM cancun.
All figures are total transaction gas (receipt `gasUsed`, including the 21,000 base cost).

## From the test suite (hardhat-gas-reporter, 46 tests, `npm run gas`)

| Function | Min | Max | Avg | Calls |
|---|---:|---:|---:|---:|
| deploy KilnLedger | 3,314,890 | 3,454,909 | 3,442,180 | (5.7% of block limit) |
| publishSeason (k=1, activates) | 263,021 | 287,341 | 279,234 | 15 |
| publishCorrection | 270,781 | 278,145 | 275,678 | 6 |
| confirmSeason (k=2 or 3) | 59,297 | 83,617 | 75,356 | 5 |
| proveSatellite | 47,633 | 119,817 | 85,560 | 36 |
| attest (EIP-712, relayed) | 145,387 | 213,979 | 185,767 | 41 |
| revise (EIP-712, relayed) | 100,425 | 135,929 | 117,640 | 6 |
| dispute | 32,313 | 55,869 | 41,750 | 5 |
| grantRole (inspector) | 101,216 | 118,316 | 110,543 | 11 |
| revokeRole | 40,641 | 40,641 | 40,641 | 2 |
| setOracleThreshold | 33,051 | 33,051 | 33,051 | 5 |

Ranges come from the test inputs. proveSatellite's minimum is the root-equivocation path, which
stores nothing and only emits a Conflict. Its maximum is a proof that also emits a Conflict.

## From the live localhost run (`scripts/demo-activity.ts`, real receipts)

| Step | Gas | Events |
|---|---:|---|
| deploy | 3,314,866 | |
| publishSeason 202610 (10-kiln fixture root) | 266,913 | SeasonPublished, SeasonConfirmed, SeasonActivated |
| grantRole INSPECTOR | 118,316 | RoleGranted |
| proveSatellite (ZIGZAG) | 85,911 | SatelliteProven |
| attest ZIGZAG_CONFIRMED (inspector's first, nonce 0) | 214,039 | FindingAttested, Certified |
| proveSatellite (FCBK) | 85,311 | SatelliteProven |
| attest ZIGZAG_CONFIRMED on an FCBK kiln | 185,114 | FindingAttested, Conflict |
| attest FCBK_FOUND | 159,941 | FindingAttested |
| proveSatellite after FCBK_FOUND | 121,228 | SatelliteProven, Conflict |
| revise -> NOT_OPERATING | 109,480 | FindingRevised |
| dispute (89-byte note) | 34,053 | Disputed |

## Reading it

- **A season costs one transaction whatever the kiln count.** About 267k to 287k gas for 10 kilns or 10,000.
  Proof length grows with log2(n), so 10,000 kilns means about 14 sibling hashes.
- **An inspector finding costs 145k to 214k gas, more than the 60k to 120k estimate in
  `docs/PRODUCT.md`.** The cost comes from storing history rather than only emitting it: a new
  inspector-list entry, a 2-slot finding record plus the array length, and the first nonce write
  (zero to non-zero, 20k). The signature check itself is about 3k. A revision writes no new list
  entry, so it costs 100k to 136k. On a testnet the relayer pays, so all of this is free to inspectors.
- **A dispute costs 32k to 56k gas.** It is a counter bump plus an event; the note lives in the log
  only, never in storage.

## Measured on Ethereum Sepolia, 24 Oct 2026

| Transaction | Gas used (receipt) | Sepolia ETH at 0.0012 gwei |
|---|---:|---:|
| Deploy KilnLedger, tx `0x28d68cde...6faf`, block 11983278 | 22,848,158 | 0.0000274 |
| Grant INSPECTOR_ROLE, tx `0x569fb722...9a35`, block 11983279 | 464,396 | 0.0000006 |

Sepolia charged about 6.6 times the local Hardhat figures above for both transactions. The likely cause
is a newer fork on Sepolia that reprices state creation; this is an assumption, not verified. Cost is
still negligible on a testnet.
