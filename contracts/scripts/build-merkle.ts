/**
 * Builds the season Merkle tree(s) from the ML output and writes:
 *   data/merkle/season-<season>.json   root, and per kiln: leaf, proof, encoded fields
 *   data/merkle/test-vectors.json      3-kiln cross-language vectors for the API and browser
 *
 * Input: data/kilns.json, else data/fixtures/kilns.sample.json, else contracts/test/fixtures/kilns.sample.json
 * (override with KILNS_JSON=path). Run: npx hardhat run scripts/build-merkle.ts
 */
import * as fs from "fs";
import * as path from "path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import {
  DATA_DIR,
  LEAF_TYPES,
  LeafTuple,
  buildSeasonTrees,
  canonicalProb,
  manifestHash,
  modelSha256,
  quantise4,
  readKilns,
  resolveKilnSource,
} from "./lib/encoding";

const ENCODING_NOTE = {
  leaf_types: LEAF_TYPES,
  leaf: "keccak256(bytes.concat(keccak256(abi.encode(kilnId, season, status, pZigzagBp, evidenceHash)))) (OpenZeppelin StandardMerkleTree, sorted leaves, commutative pair hash)",
  kiln_id: "ethers encodeBytes32String(id): UTF-8 bytes, right-padded with zeros to 32, max 31 bytes",
  evidence_hash:
    "0x + sha256(utf8(canonical JSON of {scene_id, date, probs, set, chip_sha256, model_sha256})); keys sorted at every depth; separators ',' and ':' with no whitespace; strings as JSON with non-ASCII left unescaped",
  probs: "each probability = round(p, 4) with round-half-even on the exact double (Python round(float(p), 4)); written as the shortest round-trip number; integral values have no decimal point (1, 0); null when the kiln has no probabilities",
  set: "array of class names sorted ascending",
  chip_sha256: "lowercase hex sha256 of the chip PNG bytes, or the string 'none' if the file is missing",
  model_sha256: "lowercase hex from summary.json model_sha256, or 'none'",
  p_zigzag_bp: "the quantised zigzag probability times 10000 (an exact integer), 0 when probs is null",
  status: { NOT_DETECTED: 0, FCBK: 1, ZIGZAG: 2, UNDETERMINED: 3 },
};

function main() {
  const src = resolveKilnSource();
  const kilns = readKilns(src);
  const trees = buildSeasonTrees(kilns, src);
  const outDir = path.join(DATA_DIR, "merkle");
  fs.mkdirSync(outDir, { recursive: true });
  const man = manifestHash(src);
  const rel = (p?: string) => (p ? path.relative(path.join(DATA_DIR, ".."), p) : null);

  for (const { season, tree, leaves } of trees) {
    const byLeaf = new Map<string, number>();
    for (const [i, v] of tree.entries()) byLeaf.set(tree.leafHash(v), i);
    const out: Record<string, unknown> = {};
    for (const l of leaves) {
      const leaf = tree.leafHash(l.tuple);
      out[l.id] = {
        leaf,
        proof: tree.getProof(byLeaf.get(leaf)!),
        status_code: l.status_code,
        p_zigzag_bp: l.p_zigzag_bp,
        evidence_hash: l.evidence_hash,
        kiln_id_bytes32: l.kiln_id_bytes32,
        evidence_canonical: l.evidence_canonical,
      };
    }
    const file = path.join(outDir, `season-${season}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          season,
          root: tree.root,
          count: leaves.length,
          source: rel(src.kilnsPath),
          fixture: src.isFixture,
          manifest_path: rel(man.path),
          manifest_sha256: man.hash,
          model_sha256: modelSha256(src),
          built_at: new Date().toISOString(),
          encoding: ENCODING_NOTE,
          leaves: out,
        },
        null,
        2,
      ) + "\n",
    );
    console.log(`season ${season}: ${leaves.length} kilns, root ${tree.root} -> ${path.relative(process.cwd(), file)}`);
  }

  // Cross-language test vectors: three kilns from the first season, chosen to cover a chip hash,
  // a missing chip, an exact rounding tie, integral probabilities, and a kiln with no probabilities.
  const first = trees[0];
  const pick = ["PK-fx000001", "PK-fx000002", "PK-fx000006"]
    .map((id) => first.leaves.find((l) => l.id === id))
    .filter((x) => x !== undefined);
  const chosen = pick.length === 3 ? pick : first.leaves.slice(0, 3);
  const vt = StandardMerkleTree.of(
    chosen.map((l) => l.tuple),
    LEAF_TYPES as unknown as string[],
  );
  const raw = readKilns(src);
  const vectors = {
    description:
      "Bhatta cross-language vectors. A conforming implementation reproduces evidence_canonical, evidence_hash, leaf, the root of a StandardMerkleTree over exactly these three leaves, and every quantise4 row.",
    source: rel(src.kilnsPath),
    fixture: src.isFixture,
    encoding: ENCODING_NOTE,
    quantise4: [0.03125, 0.96875, 1.0, 0.0, 0.08123456, 0.87005, 0.12995, 0.0001, 0.00005, 0.00015, 0.5179, 0.33333333]
      .map((x) => ({ input: x, output: canonicalProb(x), units_1e4: quantise4(x) })),
    kilns: chosen.map((l) => ({
      input: raw.find((k) => k.id === l.id),
      season: l.season,
      evidence: l.evidence,
      evidence_canonical: l.evidence_canonical,
      evidence_hash: l.evidence_hash,
      kiln_id_bytes32: l.kiln_id_bytes32,
      status_code: l.status_code,
      p_zigzag_bp: l.p_zigzag_bp,
      leaf_values: l.tuple,
      leaf: vt.leafHash(l.tuple as LeafTuple),
      proof: vt.getProof(l.tuple as LeafTuple),
    })),
    root: vt.root,
  };
  const vf = path.join(outDir, "test-vectors.json");
  fs.writeFileSync(vf, JSON.stringify(vectors, null, 2) + "\n");
  console.log(`test vectors: root ${vt.root} -> ${path.relative(process.cwd(), vf)}`);
}

main();
