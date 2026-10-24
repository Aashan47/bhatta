// Chain reads and EIP-712 typed data for KilnLedger (contracts/README.md, "On-chain encoding").
// Pure encoding lives in ./encoding so it can be checked against data/merkle/test-vectors.json.

import { createPublicClient, http, type Abi } from "viem";
import abiFile from "../abi/KilnLedger.json";
import type { Hex, KilnRecord } from "../types";
import { evidenceCanonical, evidenceHashOf, kilnIdBytes32, sha256HexBare, type EvidenceInput } from "./encoding";

export { computeLeaf, processProof, hashPair, kilnIdBytes32, pZigzagBp, quantise4 } from "./encoding";

export const DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
/** Real ABI from contracts/ (copied from data/abi/KilnLedger.json). /api/ledger may override it. */
export const LEDGER_ABI = abiFile.abi as Abi;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_HASH = ("0x" + "00".repeat(32)) as Hex;

export const CHAIN_NAMES: Record<number, string> = {
  11155111: "Ethereum Sepolia",
  84532: "Base Sepolia",
  31337: "Local Hardhat node",
};

function client(rpc?: string) {
  return createPublicClient({ transport: http(rpc ?? DEFAULT_RPC, { timeout: 15_000 }) });
}

export function evidenceInputFor(rec: KilnRecord, chipShaBare: string, modelShaBare: string | undefined): EvidenceInput {
  const o = rec.observation;
  return {
    scene_id: o.scene_id,
    date: o.date,
    probs: o.probs,
    set: o.set,
    chip_sha256: chipShaBare,
    model_sha256: modelShaBare ?? "none",
  };
}

export function recomputeEvidence(rec: KilnRecord, chipBytes: Uint8Array | null, modelSha: string | undefined) {
  const chipSha = chipBytes ? sha256HexBare(chipBytes) : "none";
  const input = evidenceInputFor(rec, chipSha, modelSha);
  return { chipSha, canonical: evidenceCanonical(input), hash: evidenceHashOf(input) };
}

export async function readCurrentRoot(opts: { contract: Hex; season: number; rpc?: string; abi?: Abi }): Promise<Hex> {
  return (await client(opts.rpc).readContract({
    address: opts.contract,
    abi: opts.abi ?? LEDGER_ABI,
    functionName: "currentRoot",
    args: [opts.season],
  })) as Hex;
}

export async function readNonce(opts: { contract: Hex; inspector: Hex; rpc?: string; abi?: Abi }): Promise<bigint | null> {
  try {
    return (await client(opts.rpc).readContract({
      address: opts.contract,
      abi: opts.abi ?? LEDGER_ABI,
      functionName: "nonces",
      args: [opts.inspector],
    })) as bigint;
  } catch {
    return null;
  }
}

export async function readEip712Domain(opts: { contract: Hex; rpc?: string }): Promise<{ name: string; version: string } | null> {
  try {
    const r = (await client(opts.rpc).readContract({
      address: opts.contract,
      abi: LEDGER_ABI,
      functionName: "eip712Domain",
    })) as readonly [string, string, string, bigint, Hex, Hex, readonly bigint[]];
    return { name: r[1], version: r[2] };
  } catch {
    return null;
  }
}

export interface OnchainCertificate {
  certified: boolean;
  hash: Hex;
}

export async function readCertificate(opts: { contract: Hex; id: string; season: number; rpc?: string }): Promise<OnchainCertificate> {
  const c = client(opts.rpc);
  const args = [kilnIdBytes32(opts.id), opts.season] as const;
  const [certified, hash] = await Promise.all([
    c.readContract({ address: opts.contract, abi: LEDGER_ABI, functionName: "certified", args }),
    c.readContract({ address: opts.contract, abi: LEDGER_ABI, functionName: "certificateHash", args }),
  ]);
  return { certified: certified as boolean, hash: hash as Hex };
}

/** EIP-712 typed data for an inspector finding (KilnLedger FINDING_TYPEHASH). */
export const FINDING_TYPES = {
  Finding: [
    { name: "kilnId", type: "bytes32" },
    { name: "season", type: "uint32" },
    { name: "finding", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function findingDomain(chainId: number, contract: Hex | null, eip712?: { name: string; version: string } | null) {
  return {
    name: eip712?.name ?? "Bhatta KilnLedger",
    version: eip712?.version ?? "1",
    chainId,
    verifyingContract: (contract ?? ZERO_ADDRESS) as Hex,
  };
}

export function sha256Bytes(bytes: Uint8Array): Hex {
  return ("0x" + sha256HexBare(bytes)) as Hex;
}

export function shortHex(h: string, head = 6, tail = 4): string {
  if (h.length <= head + tail + 2) return h;
  return `${h.slice(0, head + 2)}…${h.slice(-tail)}`;
}

/** bytes32 kiln id back to its string, for events that carry only kilnId. */
export function bytes32ToId(b: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(b)) return null;
  let s = "";
  for (let i = 2; i < 66; i += 2) {
    const c = parseInt(b.slice(i, i + 2), 16);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s || null;
}
