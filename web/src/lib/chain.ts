// On-chain encoding shared with the contract and the API (docs/PRODUCT.md, "On-chain encoding").
// Everything here runs in the browser so a reader does not have to trust the API.

import {
  bytesToHex,
  concat,
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  sha256,
  stringToHex,
  type Abi,
} from "viem";
import { sepolia } from "viem/chains";
import abiFile from "../abi/KilnLedger.json";
import type { Hex, KilnRecord } from "../types";

export const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
export const STUB_ABI = abiFile.abi as Abi;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** kilnId = bytes32 of the id string (ethers encodeBytes32String equivalent). */
export function kilnIdBytes32(id: string): Hex {
  return stringToHex(id, { size: 32 });
}

/** OpenZeppelin StandardMerkleTree leaf: keccak256(bytes.concat(keccak256(abi.encode(...)))). */
export function computeLeaf(id: string, season: number, statusCode: number, pZigzagBp: number, evidenceHash: Hex): Hex {
  const encoded = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint32" }, { type: "uint8" }, { type: "uint16" }, { type: "bytes32" }],
    [kilnIdBytes32(id), season, statusCode, pZigzagBp, evidenceHash],
  );
  return keccak256(keccak256(encoded));
}

/** Commutative pair hash, as in OpenZeppelin MerkleProof (sorted pair). */
export function hashPair(a: Hex, b: Hex): Hex {
  const [x, y] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return keccak256(concat([x, y]));
}

export function processProof(leaf: Hex, proof: Hex[]): { root: Hex; path: Hex[] } {
  let h = leaf;
  const path: Hex[] = [leaf];
  for (const p of proof) {
    h = hashPair(h, p);
    path.push(h);
  }
  return { root: h, path };
}

/** Canonical JSON: sorted keys, no spaces (Python json.dumps(sort_keys=True, separators=(",", ":"))). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
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

export function sha256Bytes(bytes: Uint8Array): Hex {
  return sha256(bytesToHex(bytes));
}

export function evidencePreimage(rec: KilnRecord, chipSha: Hex, modelSha: Hex) {
  const o = rec.observation;
  return { scene_id: o.scene_id, date: o.date, probs: o.probs, set: o.set, chip_sha256: chipSha, model_sha256: modelSha };
}

export function evidenceHash(rec: KilnRecord, chipSha: Hex, modelSha: Hex): Hex {
  return sha256(stringToHex(canonicalJson(evidencePreimage(rec, chipSha, modelSha))));
}

export async function readCurrentRoot(opts: { contract: Hex; season: number; rpc?: string; abi?: Abi }): Promise<Hex> {
  const client = createPublicClient({ chain: sepolia, transport: http(opts.rpc ?? DEFAULT_RPC) });
  const root = await client.readContract({
    address: opts.contract,
    abi: opts.abi ?? STUB_ABI,
    functionName: "currentRoot",
    args: [opts.season],
  });
  return root as Hex;
}

export async function readNonce(opts: { contract: Hex; inspector: Hex; rpc?: string; abi?: Abi }): Promise<bigint | null> {
  try {
    const client = createPublicClient({ chain: sepolia, transport: http(opts.rpc ?? DEFAULT_RPC) });
    const n = await client.readContract({
      address: opts.contract,
      abi: opts.abi ?? STUB_ABI,
      functionName: "nonces",
      args: [opts.inspector],
    });
    return n as bigint;
  } catch {
    return null;
  }
}

/** EIP-712 typed data for an inspector finding. Must match KilnLedger's ATTEST_TYPEHASH. */
export const FINDING_TYPES = {
  Finding: [
    { name: "kilnId", type: "bytes32" },
    { name: "season", type: "uint32" },
    { name: "finding", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "inspector", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function findingDomain(chainId: number, contract: Hex | null, eip712?: { name: string; version: string }) {
  return {
    name: eip712?.name ?? "KilnLedger",
    version: eip712?.version ?? "1",
    chainId,
    verifyingContract: (contract ?? ZERO_ADDRESS) as Hex,
  };
}

export function shortHex(h: string, head = 6, tail = 4): string {
  if (h.length <= head + tail + 2) return h;
  return `${h.slice(0, head + 2)}…${h.slice(-tail)}`;
}
