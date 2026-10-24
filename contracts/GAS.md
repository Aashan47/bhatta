# KilnLedger gas

Measured 24 Oct 2026, after the certificate-rule change (inspector threshold, satellite veto).
Solidity 0.8.28, optimizer on (200 runs), viaIR, EVM cancun. All figures are total transaction gas
(receipt `gasUsed`, including the 21,000 base cost).

## From the test suite (hardhat-gas-reporter, 52 tests, `npm run gas`)

| Function | Min | Max | Avg | Calls |
|---|---:|---:|---:|---:|
| deploy KilnLedger | 3,400,239 | 3,540,258 | 3,530,923 | (5.9% of block limit) |
| publishSeason (k=1, activates) | 263,065 | 287,385 | 280,232 | 17 |
| publishCorrection | 270,781 | 278,145 | 275,668 | 6 |
| confirmSeason (k=2 or 3) | 59,319 | 83,639 | 75,378 | 5 |
| proveSatellite | 48,042 | 132,359 | 94,325 | 39 |
| attest (EIP-712, relayed) | 159,630 | 210,813 | 191,215 | 56 |
| revise (EIP-712, relayed) | 102,336 | 147,393 | 125,921 | 7 |
| refreshCertificate | 48,005 | 77,614 | 55,513 | 10 |
| dispute | 32,371 | 55,891 | 45,192 | 5 |
| grantRole (inspector) | 101,238 | 118,338 | 110,358 | 15 |
| revokeRole | 40,676 | 40,676 | 40,676 | 3 |
| setInspectorThreshold | 32,315 | 32,315 | 32,315 | 5 |
| setOracleThreshold | 33,155 | 33,155 | 33,155 | 5 |

Ranges come from the test inputs. proveSatellite's minimum is the root-equivocation path, which
stores nothing and only emits a Conflict. Its maximum is a proof that also emits a Conflict and
withdraws a certificate.

## From a localhost run (`scripts/demo-activity.ts`, real receipts, 10-kiln fixture)

| Step | Gas | Events |
|---|---:|---|
| deploy | 3,400,215 | |
| publishSeason 202610 | 266,957 | SeasonPublished, SeasonConfirmed, SeasonActivated |
| grantRole inspector A / B | 118,338 / 101,238 | RoleGranted |
| proveSatellite (UNDETERMINED) | 87,731 | SatelliteProven |
| attest ZIGZAG_CONFIRMED, inspector A (first finding, nonce 0) | 210,832 | FindingAttested, Certified |
| attest ZIGZAG_CONFIRMED, inspector B on the same kiln | 181,730 | FindingAttested |
| proveSatellite (FCBK) | 85,720 | SatelliteProven |
| attest ZIGZAG_CONFIRMED on that FCBK kiln | 187,718 | FindingAttested, Conflict |
| attest ZIGZAG_CONFIRMED on an unproven kiln | 193,165 | FindingAttested, Certified |
| proveSatellite FCBK on it afterwards (the veto) | 120,856 | SatelliteProven, Conflict, CertificateWithdrawn |
| attest FCBK_FOUND | 166,430 | FindingAttested |
| revise -> NOT_OPERATING | 110,816 | FindingRevised |
| dispute (89-byte note) | 34,075 | Disputed |

## Reading it

- **A season costs one transaction whatever the kiln count.** About 263k to 287k gas. Proof length
  grows with log2(n), so 2,754 kilns means 12 sibling hashes.
- **An inspector finding costs 160k to 211k gas, more than the 60k to 120k estimate in
  `docs/PRODUCT.md`.** The cost comes from storing history rather than only emitting it: a new
  inspector-list entry, a 2-slot finding record plus the array length, the first nonce write (zero
  to non-zero, 20k), and the certificate hash slot when a certificate is issued. The signature
  check itself is about 3k. A revision writes no new list entry, so it costs 102k to 147k. The
  relayer pays, so inspectors never need gas.
- **A dispute costs 32k to 56k gas.** It is a counter bump plus an event; the note lives in the log
  only, never in storage.

## Measured on Ethereum Sepolia

Current deployment `0xD5ED8D10aD23bAc601C065D4179d488037070baC`, deployed 24 Oct 2026 with
inspectorThreshold 1. The effective gas price was 0.0012 gwei.

| Transaction | Block | Gas used (receipt) | Sepolia ETH |
|---|---:|---:|---:|
| Deploy KilnLedger, tx `0xdcbfad7a...fedb6` | 11983523 | 23,445,629 | 0.0000281 |
| Grant INSPECTOR_ROLE to inspector A, tx `0x86ee95f4...1c93` | 11983524 | 464,418 | 0.0000006 |
| Grant INSPECTOR_ROLE to inspector B, tx `0xeeebebf5...14ac` | 11983525 | 366,498 | 0.0000004 |

Superseded deployment, same day, under the earlier certificate rule:
`0x23FaFEC94D038C3A8DE12dB4CA6b38cB3DfB8c1a`. It was deployed in tx `0x28d68cde...6faf` (block
11983278, 22,848,158 gas), and INSPECTOR_ROLE was granted in tx `0x569fb722...9a35` (464,396 gas).

Sepolia charged about 6.9 times the local Hardhat figure for the deploy, and 3.6 to 3.9 times for
role grants. The likely cause is a newer fork on Sepolia that reprices state creation; this is an
assumption, not verified. The cost is still negligible on a testnet.
