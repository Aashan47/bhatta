// Bhatta on-chain encoding, browser side. Must match contracts/scripts/lib/encoding.ts byte for byte;
// scripts/check-vectors.ts checks this file against data/merkle/test-vectors.json.
// Only depends on viem so it also runs under plain Node (type stripping).

import { concat, encodeAbiParameters, keccak256, sha256, stringToHex, toBytes } from "viem";

type Hex = `0x${string}`;

export const STATUS_CODES = { NOT_DETECTED: 0, FCBK: 1, ZIGZAG: 2, UNDETERMINED: 3 } as const;

/** Exact decimal value of a finite double as int / 10^scale. */
function exactDecimal(x: number): { int: bigint; scale: number } {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const neg = bits >> 63n === 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e: number;
  if (expBits === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  let int: bigint;
  let scale: number;
  if (e >= 0) {
    int = mant << BigInt(e);
    scale = 0;
  } else {
    int = mant * 5n ** BigInt(-e);
    scale = -e;
  }
  return { int: neg ? -int : int, scale };
}

/** Python round(float(p), 4) as an integer count of 1e-4 (round half to even on the exact double). */
export function quantise4(p: number): number {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Error(`probability out of range: ${p}`);
  const { int, scale } = exactDecimal(p);
  let q: bigint;
  if (scale <= 4) q = int * 10n ** BigInt(4 - scale);
  else {
    const d = 10n ** BigInt(scale - 4);
    q = int / d;
    const r = int % d;
    if (2n * r > d || (2n * r === d && q % 2n === 1n)) q += 1n;
  }
  return Number(q);
}

/** Canonical JSON: keys sorted at every depth, no whitespace, non-ASCII left as is. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k]))
        .join(",") +
      "}"
    );
  }
  if (typeof v === "number") return JSON.stringify(Object.is(v, -0) ? 0 : v);
  return JSON.stringify(v);
}

export interface EvidenceInput {
  scene_id: string | null | undefined;
  date: string | null | undefined;
  probs: Record<string, number> | null | undefined;
  set: string[] | null | undefined;
  /** lowercase hex without 0x, or "none" */
  chip_sha256: string | null | undefined;
  /** lowercase hex without 0x, or "none" */
  model_sha256: string | null | undefined;
}

const bare = (h: string | null | undefined) => (h ? h.toLowerCase().replace(/^0x/, "") : "none");

export function evidenceObject(e: EvidenceInput) {
  let probs: Record<string, number> | null = null;
  if (e.probs && typeof e.probs === "object") {
    probs = {};
    for (const [k, val] of Object.entries(e.probs)) probs[k] = quantise4(Number(val)) / 10000;
  }
  return {
    scene_id: e.scene_id ?? null,
    date: e.date ?? null,
    probs,
    set: [...(e.set ?? [])].map(String).sort(),
    chip_sha256: bare(e.chip_sha256),
    model_sha256: bare(e.model_sha256),
  };
}

export function evidenceCanonical(e: EvidenceInput): string {
  return canonicalJson(evidenceObject(e));
}

export function evidenceHashOf(e: EvidenceInput): Hex {
  return sha256(toBytes(evidenceCanonical(e)));
}

export function sha256HexBare(bytes: Uint8Array): string {
  return sha256(bytes).slice(2);
}

export function pZigzagBp(probs: Record<string, number> | null | undefined): number {
  if (!probs) return 0;
  const key = Object.keys(probs).find((k) => k.toLowerCase() === "zigzag");
  return key === undefined ? 0 : quantise4(Number(probs[key]));
}

/** kilnId = bytes32 of the id string (ethers encodeBytes32String). */
export function kilnIdBytes32(id: string): Hex {
  return stringToHex(id, { size: 32 });
}

export function computeLeaf(id: string, season: number, statusCode: number, bp: number, evidenceHash: Hex): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint32" }, { type: "uint8" }, { type: "uint16" }, { type: "bytes32" }],
    [kilnIdBytes32(id), season, statusCode, bp, evidenceHash],
  );
  return keccak256(keccak256(encoded));
}

/** Commutative pair hash, as in OpenZeppelin MerkleProof. */
export function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(concat([x, y]));
}

export function processProof(leaf: Hex, proof: Hex[]): Hex {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h;
}
