# Bhatta: product design

Written 24 Oct 2026 before any product code. "Bhatta" is the Urdu and Punjabi word for a brick kiln.

## The person, the problem, the number

- **Who:** EPA Punjab field inspectors and the officers who send them out; and the kiln owners whose
  kilns get sealed or demolished on the result. Secondary: Lahore residents, journalists, the courts.
- **The problem, in the government's and the industry's own words:**
  - The minister, 10 Oct 2026: "around 8,000 brick kilns across Punjab had been converted to zigzag
    technology, with QR codes assigned to all kilns" (ProPakistani,
    https://propakistani.pk/2026/10/10/punjab-provides-10000-super-seeders-converts-8000-brick-kilns-to-zigzag-technology/).
  - EPA Punjab and the Urban Unit count "approximately 10,394 brick kilns operating across the
    province"; "1,912 kilns have so far been demolished for failing to adopt zig-zag technology";
    "from January 1 to July 25, 2026, authorities inspected 45,736 brick kilns" (Express Tribune,
    Aug 2026, https://tribune.com.pk/story/2621873/brick-kiln-crackdown-raises-livelihood-concerns).
  - The owners' side, same article: each kiln employs "around 15 families, involving approximately
    100 to 150 people".
- **Why existing tools fail them:** the conversion record is a government list with a QR code per
  kiln. Nobody outside the EPA can check it, a kiln owner cannot prove compliance independently, and
  45,736 inspections in seven months are spent without a way to point inspectors at the kilns most
  likely to be non-compliant. Prior research on this exists (SentinelKilnDB, NeurIPS 2025; "Space to
  Policy", arXiv 2412.04065) but no tool that an inspector, an owner and a citizen can all check.
- **Would someone use it next month with no prize?** Yes: smog season runs November to January, and
  the inspection queue alone is useful to an EPA district office from the first week.

## The one job

**For every brick kiln, say what free satellite imagery can and cannot support about its technology
this season, and keep that statement, and every inspector's finding about it, in a public record
nobody can quietly rewrite.**

## Why a blockchain, answered plainly

The party whose claim is in doubt is the regulator itself, and the party who pays for a wrong answer
is the owner. Neither will accept a database the other controls. The ledger gives:
1. **Append-only season roots.** The satellite sweep for a season is committed as one Merkle root; it
   can be superseded only by a new, visible correction with a reason, never edited.
2. **Signed field findings (EIP-712).** An inspector signs a finding offline; anyone can relay it.
   Signatures are bound to chain id and contract (domain separation) and carry a nonce (no replay).
3. **Conflicts are public.** If the satellite says FCBK at 90% confidence and an inspector signs
   "Zigzag confirmed", the contract emits a Conflict that cannot be deleted. That is the point.
4. **Owners and citizens can file disputes** with an evidence hash, also permanent.
5. **A certificate exists only when both agree:** satellite set {Zigzag} proven against the root
   AND an inspector's "Zigzag confirmed", with no "FCBK found" finding outstanding.

## What the AI does, and where it stops

- Detector: finds kilns in 10 m Sentinel-2 imagery. Classifier: FCBK vs Zigzag from the kiln's shape.
- **Conformal sets at 90%**: the product states a technology only when the calibrated set has one
  member; otherwise it says "cannot be determined from 10 m imagery: send an inspector".
- A 2023-24 kiln not seen now is "not seen", never "demolished": the product cannot tell demolished
  from dismantled from missed.
- Pre-registered targets T1 to T6 (`build/bhatta/docs/PREREG.md`), results shown in the app.

## Design direction

Grounded in the subject: fired brick, clay, soot, ash, and the zigzag of the kiln's air path.
- Colour tokens (light): `--clay-50 #FBF6F1` page, `--clay-100 #F3E7DB` surface, `--brick-600
  #A8432A` primary, `--brick-700 #86331F`, `--soot-900 #1F1B18` text, `--soot-600 #5B524B` muted text,
  `--ash-300 #CFC6BD` borders. Status: `--zigzag #1F7A5A` (green, converted), `--fcbk #B3261E` (red,
  old technology), `--undetermined #B7791F` (amber), `--notseen #6B6F76` (grey). Dark mode: page
  `#14110F`, surface `#1F1A17`, text `#F3E7DB`, primary `#E07A5F`; status colours lightened to keep
  4.5:1 contrast. Every status also carries an icon and a word, never colour alone.
- Type: Public Sans (Latin UI), IBM Plex Mono (hashes, ids), Noto Nastaliq Urdu (Urdu, RTL).
- Motif: a thin zigzag rule as the section divider and in the logo mark; no stock imagery.
- Phone first; keyboard reachable; `prefers-reduced-motion` respected; English and Urdu.
- Basemap: OpenFreeMap vector tiles (no key, OSM attribution) with a Sentinel-2 cloudless (EOX,
  attribution shown) satellite toggle.

## Interactive centrepiece and WOW moment (added 24 Oct, his request; build standard part 5)

- **3D kiln explainer** on `/` and `/method`: rotatable procedural FCBK (oval, central chimney) and Zigzag
  (rectangle, end chimney) kilns; "Fire" animates the straight vs zigzag air path and chimney smoke,
  density labelled "illustrative; scaled to ICIMOD's measured 60% less black carbon".
- **WOW moment: "See it at 10 m" slider.** The camera goes top-down and the render pixelates to the true
  Sentinel-2 grid; the two kilns blur into the same few pixels. It shows why the model refuses
  (T3 and T6 missed) in two seconds. First 90 seconds of the video.
- **3D map mode** with extruded kiln columns by status and a guided fly-through of the districts.
- **Animated Merkle proof** on Verify on chain: the path folds level by level to the Sepolia root.
- Reduced motion gets stills, no WebGL gets pre-rendered images, the 3D chunk is lazy-loaded.

## Screens and routes

1. `/` **Overview.** The claim ("8,000 converted", quoted and linked) next to what the satellite sees
   in the scanned area: counts by status, the map, the season, and one line on what it cannot see.
2. `/map` **Map.** Every kiln, coloured by status, filter by status and district; tap opens a drawer.
3. `/kiln/:id` **Kiln record.** 2023-24 and October 2026 image chips side by side; the model's
   probabilities and its set in words; status; the record's timeline (season root, inspector
   findings, disputes, conflicts); **Verify on chain**: the browser recomputes the leaf, reads the root
   from the contract over a public RPC, checks the Merkle proof, and links the transaction. Actions:
   "Sign an inspection finding" and "File a dispute".
4. `/inspect` **Inspection queue.** Kilns ranked for a visit: satellite FCBK first (the claim is
   contradicted), then undetermined, then not seen. Exportable as CSV for a district office.
5. `/ledger` **Ledger.** Contract address and chain, season roots with transactions, recent events.
6. `/method` **How it decides.** Data and licences, the two models, the conformal rule, the
   pre-registered results table with misses, and the limits.

## API contract (FastAPI, `build/bhatta/api/`)

All responses JSON. `BHATTA_FIXTURE=1` serves `data/fixtures/` and a mock chain, no network.

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ok, fixture, data_version, chain:{id, contract}}` |
| GET | `/api/summary` | counts by status, AOI, scenes, model hashes, alpha, qhat, the claim quote and URL |
| GET | `/api/kilns?status=&district=` | `[{id, lat, lon, district, status, baseline_class}]` |
| GET | `/api/kilns/{id}` | full kiln record (schema in the ML brief) + `chain:{season, leaf, proof[], evidence_hash, status_code, p_zigzag_bp}` + `events[]` |
| GET | `/api/chips/{file}` | PNG |
| GET | `/api/inspect/queue?district=` | ranked list with a reason per kiln |
| GET | `/api/ledger` | `{chain_id, contract, explorer, seasons:[{season, root, tx, model_hash}], events:[...]}` |
| GET | `/api/results` | the T1 to T6 table from `docs/RESULTS.md` as JSON |
| POST | `/api/relay/attest` | body `{kiln_id, season, finding, evidence_hash, inspector, nonce, deadline, signature}`; relays the signed finding; returns `{tx}`. Rate-limited. |
| POST | `/api/relay/dispute` | body `{kiln_id, season, evidence_hash, note}`; returns `{tx}`. Rate-limited. |

## On-chain encoding (shared by contract, API and browser)

- `kilnId` = `bytes32` of the id string (e.g. `PK-ttnf2b3c`), `encodeBytes32String`.
- `season` = `uint32` yyyymm of the scene month, e.g. `202610`.
- `status` = `uint8`: 0 NOT_DETECTED, 1 FCBK, 2 ZIGZAG, 3 UNDETERMINED.
- `pZigzagBp` = `uint16`, the Zigzag probability in basis points.
- `evidenceHash` = `bytes32` sha256 of the canonical JSON (sorted keys, no spaces) of
  `{scene_id, date, probs, set, chip_sha256, model_sha256}`.
- Leaf = OpenZeppelin StandardMerkleTree leaf: `keccak256(bytes.concat(keccak256(abi.encode(kilnId,
  season, status, pZigzagBp, evidenceHash))))`.
- Inspector findings: 1 ZIGZAG_CONFIRMED, 2 FCBK_FOUND, 3 NOT_OPERATING, 4 DEMOLISHED.

## Cost of one use

- Reading a kiln record: zero marginal cost (static data and a public RPC read).
- The season sweep: one transaction per season for any number of kilns (one root).
- An inspector finding or a dispute: one relayed transaction, about 60,000 to 120,000 gas
  (estimate; measured at deploy and recorded in `06-BUILD-PLAN.md`). On a testnet, free.
- The model scan: runs on a laptop, about minutes per district; no paid API anywhere.

## Privacy

No personal data. Kilns are identified by location-derived ids, not owner names. Inspector identity on
chain is a key, not a name. Disputes carry a hash and a short note; the UI warns against personal data.
