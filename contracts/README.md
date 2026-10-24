# KilnLedger

The on-chain half of Bhatta. One contract, `contracts/KilnLedger.sol`, about 690 lines including NatSpec.
It has no upgradeability and no admin path that edits records.

What it stores:

- **Season roots.** One Merkle root per season over every kiln's satellite finding, together with
  the classifier hash, the manifest hash and alpha. A root is never edited. It can only be
  superseded by a correction that carries a public reason, and every version stays readable.
- **Satellite records.** Anyone can prove one kiln's leaf against the current root, and the
  contract then stores that kiln's status.
- **Inspector findings.** EIP-712 signatures, relayable by anyone, with a nonce and a deadline.
  An inspector files one finding per kiln per season; any change is a revision that keeps the
  earlier finding.
- **Conflicts.** The contract emits one whenever a proven satellite status and an inspector's
  finding disagree, in whichever order they arrive. Conflicts cannot be removed.
- **Disputes.** Anyone can file one with an evidence hash and a note of at most 280 bytes.
- **Certificates.** `certified(kilnId, season)` is true only when both sources agree, and
  `certificateHash` returns a value an owner can print as a QR code.

## Why a blockchain

The party whose claim is in doubt (the regulator, "8,000 kilns converted") and the party who pays
for a wrong answer (the owner whose kiln is sealed) will not accept a database the other controls.
The contract therefore holds no data that one side could edit. It holds commitments and signatures
that either side, or a journalist, can check without trusting the other, and without trusting us.

## Threat model

### Who can do what

| Actor | Can | Cannot |
|---|---|---|
| **Steward** (`DEFAULT_ADMIN_ROLE`) | Grant and revoke `ORACLE_ROLE` and `INSPECTOR_ROLE`; set the committee threshold k for future versions. | Edit, delete or reorder any root, satellite record, finding, conflict or dispute. Change k for a version already proposed (k is snapshotted per version). |
| **Oracle key** (`ORACLE_ROLE`) | Propose a season root once; propose corrections; confirm other oracles' proposals. | Overwrite a root, hide a version, backdate one, or touch inspector findings. Activate a root alone when k > 1. |
| **Inspector key** (`INSPECTOR_ROLE`) | Sign findings under its own address, for any kiln and season; revise its own findings. | Sign for another inspector; replay a signature (per-inspector nonce); reuse it on another chain or contract (EIP-712 domain); reuse a Finding as a Revision or the other way round (distinct type names); act after its deadline; delete its history. |
| **Relayer** (the API, or anyone) | Submit any valid signature and pay its gas; it is recorded as `relayer` / `submitter`. | Alter a signed field (any change breaks the signature). It can refuse to relay, but the signature stays valid for anyone else to submit until its deadline. |
| **Anyone** | Prove a satellite leaf; file a dispute; run `verify-season.ts`. | Prove a leaf that is not in the current root. |

### What a compromised oracle key can and cannot do

- **It can publish a wrong root.** It might commit a root that marks FCBK kilns as Zigzag, or a
  random root. The contract cannot know what is true.
- **It cannot do that quietly.** A root is stored with `manifestHash` (sha256 of
  `data/manifest.json`, which carries the scene ids, code commit, model hashes, alpha, qhat and
  `kilns_json_sha256`). `scripts/verify-season.ts` rebuilds the root from the published
  `kilns.json` and checks it against the chain. A root that nobody can reproduce from the published
  data is public evidence against whoever published it.
- **It cannot edit or erase a root afterwards.** A correction appends a new version with a reason
  string. Satellite records proven against the old version become stale (`satelliteCurrent =
  false`), so certificates resting on them lapse until the record is re-proven. Every one of these
  steps is a visible event.
- **It cannot give one kiln two answers.** If a root holds two different leaves for the same kiln,
  the first proof wins and the second emits `Conflict(..., ROOT_EQUIVOCATION = 3)`.
  `verify-season.ts` also rejects duplicate ids off chain.
- **What the k-of-n committee buys.** With `oracleThreshold = k`, a version becomes current only
  after k distinct oracle keys confirm it. One stolen key can propose a root but not activate it.
  With 2-of-3, losing one key does not stop the season from being published. The independence is
  only as real as the key holders, though: k keys held by one office are one key. The intended
  holders are separate parties, for example EPA Punjab, a university remote-sensing lab, and a
  civil-society group.

### What a compromised inspector key can and cannot do

- **It can sign false findings under its own name.** For example, it can sign `FCBK_FOUND` to
  block a certificate, or `ZIGZAG_CONFIRMED` to support one.
- **It cannot create a certificate alone.** A certificate also needs a satellite ZIGZAG record
  proven against the current root. One false `ZIGZAG_CONFIRMED` against a satellite FCBK record
  produces a permanent `Conflict` instead.
- **Revocation discounts its findings without rewriting history.** Once the steward revokes the
  key, `certified()` stops counting that key's findings. The findings, their conflicts and their
  history all remain readable. A signature the key made before revocation can no longer be
  relayed, because the role is checked at submission time.
- **It cannot sign for anyone else or replay anything** (see the table).

### What is NOT protected

- **ECDSA (secp256k1) is not post-quantum.** A cryptographically relevant quantum computer could
  recover inspector, oracle and steward private keys from their public keys and forge findings.
  The Merkle commitments (keccak256, sha256) only lose to Grover/BHT-style speed-ups and would stay
  meaningful long after the signatures fail.
  Migration path: `attest` verifies signatures with OpenZeppelin `SignatureChecker`, which accepts
  ERC-1271 contract accounts. An inspector can therefore be a smart account that verifies a
  post-quantum scheme (for example an ML-DSA or SLH-DSA verifier contract) without any change to
  KilnLedger. The chain's own consensus signatures are outside our control.
- **The ledger proves who said what and when. It does not prove that it is true.** The satellite
  model can be wrong (see `docs/PREREG.md` and the results), and an inspector can lie. The design
  makes disagreement public; it cannot remove it.
- **Data availability.** Only the root is on chain. If the oracle withholds `kilns.json`, nobody
  can verify the root. That inability is visible, but the contract cannot enforce publication.
- **Steward compromise is the largest single risk.** A stolen steward key can grant itself k oracle
  roles and an inspector role and then manufacture a certificate. Every step emits an event
  (`RoleGranted`, `SeasonPublished` / `CorrectionPublished`, `FindingAttested`), so monitoring
  catches it, but `certified()` would read true until roles are cleaned up. In production the
  steward should be a multisig held by the same independent parties as the committee, or it should
  renounce the role once the roles are set up. The demo uses a single throwaway key.
- **Censorship by the official relayer.** The API can refuse to relay, but the signature stays
  valid, and the inspector or anyone else can submit it directly until the deadline. Nonces are
  sequential, so a withheld nonce n blocks n+1 until someone submits n or n expires. After it
  expires, the inspector re-signs nonce n.
- **Dispute spam.** Disputes are permissionless and cost only gas. Notes are capped at 280 bytes
  and live in logs only. The UI should rank disputes, not trust them.
- **Timestamps** are block timestamps, accurate to seconds and set by validators.
- **Testnet.** Sepolia has no economic finality guarantees. A production deployment would sit on a
  public L2 or mainnet.

## On-chain encoding (shared with the API in Python and the browser in TypeScript)

Reference implementation: `scripts/lib/encoding.ts`. Reference outputs:
`data/merkle/test-vectors.json`. These are checked in the test suite, and were re-derived
independently in Python (`json`, `hashlib`, `eth_abi`) on 24 Oct 2026.

- `kilnId`: `encodeBytes32String(id)`, the UTF-8 bytes right-padded with zeros to 32 (max 31 bytes).
- `season`: `uint32` yyyymm of the scene month (e.g. `202610`). It is taken from the record's
  `season` if present, else from `observation.date`. Records with no date use `SEASON` from the
  environment, else the most common season in the file.
- `status`: `uint8`. `NOT_DETECTED`=0, `FCBK`=1, `ZIGZAG`=2, `UNDETERMINED`=3. String statuses are
  matched case-insensitively.
- `pZigzagBp`: `uint16`, the quantised Zigzag probability times 10000 (exact integer), or 0 when
  `probs` is null.
- `evidenceHash`: `0x` + sha256 over the UTF-8 bytes of the canonical JSON of exactly six keys,
  `{scene_id, date, probs, set, chip_sha256, model_sha256}`, taken from `observation`:
  - Keys are sorted at every depth. Separators are `,` and `:` with no whitespace. Strings are
    standard JSON with non-ASCII left unescaped. In Python:
    `json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
  - **Floats.** Each probability is `round(float(p), 4)`: round-half-to-even on the exact binary
    value, which is Python's built-in `round`. The TypeScript code reproduces it exactly with
    BigInt, and the vectors include the tie cases 0.03125 -> 0.0312 and 0.96875 -> 0.9688. The
    value is written as the shortest round-trip decimal, and an integral value carries no decimal
    point, so 1.0 is written `1` and 0.0 is written `0`. In Python:
    `r = round(float(p), 4); r = int(r) if r == int(r) else r`.
  - `probs`: object or `null`, with keys kept as given (`FCBK`, `Zigzag`).
  - `set`: list of strings sorted ascending; `null` becomes `[]`.
  - `chip_sha256`: lowercase hex sha256 of the chip PNG bytes at `data/<observation.chip>`, or the
    string `none` if the file is missing.
  - `model_sha256`: `summary.json` `models.classifier_sha256` (or `model_sha256`), else `none`.
  - `scene_id` and `date`: copied as strings, or `null`.
- Leaf: the OpenZeppelin StandardMerkleTree leaf,
  `keccak256(bytes.concat(keccak256(abi.encode(kilnId, season, status, pZigzagBp, evidenceHash))))`.
  Leaves are sorted and pairs hashed commutatively, as in `@openzeppelin/merkle-tree` 1.0.8.
- EIP-712 domain: `{name: "Bhatta KilnLedger", version: "1", chainId, verifyingContract}`.
  Types:
  - `Finding(bytes32 kilnId,uint32 season,uint8 finding,bytes32 evidenceHash,uint256 nonce,uint256 deadline)`
  - `Revision(...)`, with the same fields
  - Finding codes: 1 `ZIGZAG_CONFIRMED`, 2 `FCBK_FOUND`, 3 `NOT_OPERATING`, 4 `DEMOLISHED`
  - `nonce` is `nonces(inspector)` at signing time; `deadline` is in unix seconds.
- Conflict reason codes: 1 = satellite ZIGZAG vs FCBK_FOUND, 2 = satellite FCBK vs
  ZIGZAG_CONFIRMED, 3 = two leaves for one kiln in one root.
- `certificateHash(kilnId, season)`, zero unless certified:
  `keccak256(abi.encode(keccak256("Bhatta.KilnCertificate.v1"), chainId, contract, kilnId, season, currentRoot, satelliteEvidenceHash))`.
  The QR code links to the kiln page with `?season=<season>&cert=<hash>`. The page re-reads
  `certificateHash` from the chain and shows "valid" only if the two match. A printed code goes
  stale on its own if the certificate lapses or the season root is corrected.

## Files written

| File | By | Contents |
|---|---|---|
| `data/merkle/season-<season>.json` | build-merkle | `{season, root, count, source, fixture, manifest_sha256, model_sha256, encoding, leaves:{<id>:{leaf, proof, status_code, p_zigzag_bp, evidence_hash, kiln_id_bytes32, evidence_canonical}}}` |
| `data/merkle/test-vectors.json` | build-merkle | 3 kilns: input record, evidence object, canonical string, evidence hash, leaf, proof, root; plus a quantisation table |
| `contracts/deployments/<network>.json` | deploy and later scripts | address, ABI, deploy tx and block, roles, season txs, demo activity with gas |
| `data/chain.json` | deploy and later scripts, **sepolia only** (or `CHAIN_JSON=1`) | `{chain_id, network, contract, explorer_base, rpc, deploy_tx, deploy_block, season_txs, eip712, oracle_threshold, abi_path}` |
| `data/abi/KilnLedger.json` | deploy, **sepolia only** (or `CHAIN_JSON=1`) | `{contractName, abi}` |

## Commands

```sh
cd contracts
npm install
npm test                                     # 46 tests
npm run gas                                  # same, with the gas table in gas-report.txt
npm run merkle                               # build data/merkle/* from data/kilns.json (or a fixture)

npx hardhat node                             # terminal 1
npx hardhat run scripts/deploy.ts          --network localhost
npx hardhat run scripts/publish-season.ts  --network localhost   # SEASON=202610 optional
npx hardhat run scripts/grant-inspector.ts --network localhost   # INSPECTOR_ADDRESS optional
npx hardhat run scripts/demo-activity.ts   --network localhost
npx hardhat run scripts/verify-season.ts   --network localhost   # PASS/FAIL, exit 1 on FAIL
```

For Sepolia or Base Sepolia, fund the deployer address from `.env` and run the same scripts with
`--network sepolia` or `--network baseSepolia`. Corrections: `CORRECTION_REASON="..." npx hardhat
run scripts/publish-season.ts --network <net>`. Committee deploy: `ORACLE_ADDRESSES=0xA,0xB,0xC
ORACLE_THRESHOLD=2`.

Keys live in `contracts/.env` (gitignored; template in `.env.example`). The deployer acts as
steward, oracle and relayer in the demo. The demo inspector only signs typed data and never holds
gas.

### Toolchain notes

- Hardhat 2.29.1 with `@nomicfoundation/hardhat-toolbox` 6.1.2, OpenZeppelin Contracts 5.6.1 and
  `@openzeppelin/merkle-tree` 1.0.8. Solidity 0.8.28 with the optimizer on (200 runs), viaIR and
  EVM cancun.
- It runs on Node 26.3 as installed.
- TypeScript is pinned to 5.9. TypeScript 7 (the npm default since 2026) breaks `ts-node`, which
  Hardhat 2 uses to load the config.

## Deviations from docs/PRODUCT.md and the brief

- `publishSeason(season, root, modelHash, manifestHash, alphaBp, manifestURI)` adds `manifestHash`.
- `publishCorrection(season, newRoot, modelHash, manifestHash, alphaBp, manifestURI, reason)`
  carries a full commitment, not only `(season, newRoot, reason)`, because a corrected root also
  needs its own manifest to be reproducible.
- `attest` and `revise` take an explicit `inspector` address, matching the API relay body. Revisions
  use a separate EIP-712 type, `Revision`, with the same fields as `Finding`.
- `certified()` counts only findings from keys that still hold `INSPECTOR_ROLE`, and only a
  satellite record proven against the current root version.
- An inspector finding costs 145k to 214k gas, above the 60k to 120k estimate (see `GAS.md`).
