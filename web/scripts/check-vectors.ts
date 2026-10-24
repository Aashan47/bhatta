// Checks the browser encoding (src/lib/encoding.ts) against the cross-language vectors written by
// contracts/scripts/build-merkle. Run: node scripts/check-vectors.ts   (Node 23.6+ strips types)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeLeaf,
  evidenceCanonical,
  evidenceHashOf,
  kilnIdBytes32,
  processProof,
  pZigzagBp,
  quantise4,
} from "../src/lib/encoding.ts";

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] ?? join(here, "..", "..", "data", "merkle", "test-vectors.json");
const v = JSON.parse(readFileSync(path, "utf8"));
let fails = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fails++;
    console.log(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};

for (const k of v.kilns) {
  const o = k.input.observation;
  const ev = { ...k.evidence };
  check(`${k.input.id} canonical`, evidenceCanonical({ ...ev, probs: o.probs, set: o.set }), k.evidence_canonical);
  check(`${k.input.id} evidence hash`, evidenceHashOf({ ...ev, probs: o.probs, set: o.set }), k.evidence_hash);
  check(`${k.input.id} kilnId`, kilnIdBytes32(k.input.id), k.kiln_id_bytes32);
  check(`${k.input.id} bp`, pZigzagBp(o.probs), k.p_zigzag_bp);
  const leaf = computeLeaf(k.input.id, k.season, k.status_code, k.p_zigzag_bp, k.evidence_hash);
  check(`${k.input.id} leaf`, leaf, k.leaf);
  check(`${k.input.id} proof to root`, processProof(leaf, k.proof), v.root);
}
const rows: { input: number; output: number; units_1e4: number }[] = v.quantise4;
for (const r of rows) {
  check(`quantise4(${r.input})`, quantise4(r.input), r.units_1e4);
  check(`canonical number ${r.input}`, JSON.stringify(quantise4(r.input) / 10000), JSON.stringify(r.output));
}
console.log(fails ? `${fails} check(s) failed` : `all vectors pass (${v.kilns.length} kilns, ${rows.length} quantise rows)`);
process.exit(fails ? 1 : 0);
