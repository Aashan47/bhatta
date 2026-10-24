/**
 * Bhatta on-chain encoding, shared by build-merkle, verify-season, demo scripts and tests.
 * The Python API and the browser must reproduce these functions byte for byte; the reference
 * outputs live in data/merkle/test-vectors.json. Rules are spelled out in contracts/README.md.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeBytes32String } from "ethers";

export const LEAF_TYPES = ["bytes32", "uint32", "uint8", "uint16", "bytes32"] as const;

export const STATUS = { NOT_DETECTED: 0, FCBK: 1, ZIGZAG: 2, UNDETERMINED: 3 } as const;
export const FINDING = { ZIGZAG_CONFIRMED: 1, FCBK_FOUND: 2, NOT_OPERATING: 3, DEMOLISHED: 4 } as const;

export const EIP712_NAME = "Bhatta KilnLedger";
export const EIP712_VERSION = "1";
export const FINDING_TYPES = {
  Finding: [
    { name: "kilnId", type: "bytes32" },
    { name: "season", type: "uint32" },
    { name: "finding", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
export const REVISION_TYPES = { Revision: FINDING_TYPES.Finding };

const STATUS_WORDS: Record<string, number> = {
  not_detected: 0,
  notdetected: 0,
  not_seen: 0,
  notseen: 0,
  fcbk: 1,
  zigzag: 2,
  undetermined: 3,
};

export function statusCode(s: unknown): number {
  if (typeof s === "number" && Number.isInteger(s) && s >= 0 && s <= 3) return s;
  if (typeof s === "string") {
    const k = s.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (k in STATUS_WORDS) return STATUS_WORDS[k];
  }
  throw new Error(`unknown status ${JSON.stringify(s)}`);
}

/**
 * Exact decimal value of a finite double as int / 10^scale (no rounding at all).
 */
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

/**
 * Quantise a probability to 4 decimal places, round half to even on the EXACT binary value of
 * the double. This is exactly what Python's built-in round(x, 4) does, so Python matches with
 * `round(float(p), 4)`. Returns the integer count of 1e-4 units (equal to basis points).
 */
export function quantise4(p: number): number {
  if (typeof p !== "number" || !Number.isFinite(p)) throw new Error(`probability not finite: ${p}`);
  if (p < 0 || p > 1) throw new Error(`probability out of [0,1]: ${p}`);
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

/** The canonical JSON number for a probability: q/10000, integral values without a decimal point. */
export function canonicalProb(p: number): number {
  return quantise4(p) / 10000;
}

/** Canonical JSON: keys sorted (code-unit order) at every depth, no whitespace. */
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
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(Object.is(v, -0) ? 0 : v);
  }
  return JSON.stringify(v);
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface EvidenceInput {
  scene_id: string | null;
  date: string | null;
  probs: Record<string, number> | null;
  set: string[];
  chip_sha256: string;
  model_sha256: string;
}

/** Builds the six-field evidence object with probabilities quantised and the set sorted. */
export function evidenceObject(e: EvidenceInput): EvidenceInput {
  let probs: Record<string, number> | null = null;
  if (e.probs && typeof e.probs === "object") {
    probs = {};
    for (const [k, val] of Object.entries(e.probs)) probs[k] = canonicalProb(Number(val));
  }
  return {
    scene_id: e.scene_id ?? null,
    date: e.date ?? null,
    probs,
    set: [...(e.set ?? [])].map(String).sort(),
    chip_sha256: (e.chip_sha256 || "none").toLowerCase(),
    model_sha256: (e.model_sha256 || "none").toLowerCase(),
  };
}

export function evidenceCanonical(e: EvidenceInput): string {
  return canonicalJson(evidenceObject(e));
}

export function evidenceHash(e: EvidenceInput): string {
  return "0x" + sha256Hex(Buffer.from(evidenceCanonical(e), "utf8"));
}

/** Zigzag probability in basis points, from the same quantisation as the evidence JSON. */
export function pZigzagBp(probs: Record<string, number> | null | undefined): number {
  if (!probs) return 0;
  const key = Object.keys(probs).find((k) => k.toLowerCase() === "zigzag");
  return key === undefined ? 0 : quantise4(Number(probs[key]));
}

export function kilnIdBytes32(id: string): string {
  return encodeBytes32String(id);
}

/** season = yyyymm of the scene month. */
export function seasonFromDate(date: string): number {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) throw new Error(`cannot derive season from date ${date}`);
  return Number(m[1]) * 100 + Number(m[2]);
}

export type LeafTuple = [string, number, number, number, string];

export function leafHash(t: LeafTuple): string {
  return StandardMerkleTree.of([t], LEAF_TYPES as unknown as string[]).leafHash(t);
}

// -------------------------------------------------------------------------------------------------
// Reading the ML output
// -------------------------------------------------------------------------------------------------

export const CONTRACTS_DIR = path.resolve(__dirname, "..", "..");
export const DATA_DIR = path.resolve(process.env.BHATTA_DATA_DIR || path.join(CONTRACTS_DIR, "..", "data"));
export const FIXTURE_DIR = path.join(CONTRACTS_DIR, "test", "fixtures");

export interface KilnSource {
  kilnsPath: string;
  chipRoot: string; // chip paths are resolved against this directory
  baseDir: string; // where to look for summary/manifest next to kilns
  isFixture: boolean;
}

export function resolveKilnSource(): KilnSource {
  const explicit = process.env.KILNS_JSON;
  if (explicit) {
    const p = path.resolve(explicit);
    return { kilnsPath: p, chipRoot: DATA_DIR, baseDir: path.dirname(p), isFixture: /fixture/i.test(p) };
  }
  const candidates: KilnSource[] = [
    { kilnsPath: path.join(DATA_DIR, "kilns.json"), chipRoot: DATA_DIR, baseDir: DATA_DIR, isFixture: false },
    {
      kilnsPath: path.join(DATA_DIR, "fixtures", "kilns.sample.json"),
      chipRoot: DATA_DIR,
      baseDir: path.join(DATA_DIR, "fixtures"),
      isFixture: true,
    },
    { kilnsPath: path.join(FIXTURE_DIR, "kilns.sample.json"), chipRoot: FIXTURE_DIR, baseDir: FIXTURE_DIR, isFixture: true },
  ];
  for (const c of candidates) if (fs.existsSync(c.kilnsPath)) return c;
  throw new Error("no kilns.json found in data/, data/fixtures/ or contracts/test/fixtures/");
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((p) => fs.existsSync(p));
}

export function readJsonIf(p: string | undefined): any {
  return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined;
}

export function summaryPath(src: KilnSource): string | undefined {
  return firstExisting([
    path.join(src.baseDir, "summary.json"),
    path.join(src.baseDir, "summary.sample.json"),
    path.join(DATA_DIR, "summary.json"),
  ]);
}

export function manifestPath(src: KilnSource): string | undefined {
  return firstExisting([
    path.join(src.baseDir, "manifest.json"),
    path.join(src.baseDir, "manifest.sample.json"),
    path.join(DATA_DIR, "manifest.json"),
  ]);
}

/** sha256 of the manifest file's raw bytes, 0x-prefixed, or zero if absent. */
export function manifestHash(src: KilnSource): { path?: string; hash: string } {
  const p = manifestPath(src);
  if (!p) return { hash: "0x" + "00".repeat(32) };
  return { path: p, hash: "0x" + sha256Hex(fs.readFileSync(p)) };
}

function findModelSha(obj: any): string | undefined {
  if (!obj) return undefined;
  const direct = obj.model_sha256 ?? obj.classifier_sha256 ?? obj.models?.classifier?.sha256 ?? obj.models?.classifier_sha256;
  return typeof direct === "string" && /^[0-9a-fA-F]{64}$/.test(direct) ? direct.toLowerCase() : undefined;
}

export function modelSha256(src: KilnSource): string {
  return findModelSha(readJsonIf(summaryPath(src))) ?? findModelSha(readJsonIf(manifestPath(src))) ?? "none";
}

export interface KilnRecord {
  id: string;
  status: string | number;
  scene_id?: string | null;
  date?: string | null;
  season?: number;
  probs?: Record<string, number> | null;
  set?: string[];
  chip?: string;
  chip_path?: string;
  chips?: Record<string, string>;
  model_sha256?: string;
  [k: string]: unknown;
}

export function readKilns(src: KilnSource): KilnRecord[] {
  const raw = JSON.parse(fs.readFileSync(src.kilnsPath, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.kilns;
  if (!Array.isArray(list)) throw new Error(`${src.kilnsPath}: expected an array or {kilns:[...]}`);
  return list as KilnRecord[];
}

function chipRel(k: KilnRecord): string | undefined {
  return k.chip_path ?? k.chip ?? k.chips?.current ?? k.chips?.season ?? k.chips?.["2026"];
}

export function chipSha256(k: KilnRecord, src: KilnSource): string {
  const rel = chipRel(k);
  if (!rel) return "none";
  const p = path.isAbsolute(rel) ? rel : path.join(src.chipRoot, rel);
  return fs.existsSync(p) ? sha256Hex(fs.readFileSync(p)) : "none";
}

export interface BuiltLeaf {
  id: string;
  season: number;
  kiln_id_bytes32: string;
  status_code: number;
  p_zigzag_bp: number;
  evidence: EvidenceInput;
  evidence_canonical: string;
  evidence_hash: string;
  tuple: LeafTuple;
}

export function buildLeaf(k: KilnRecord, src: KilnSource, modelSha: string): BuiltLeaf {
  const season = k.season ?? (k.date ? seasonFromDate(k.date) : NaN);
  if (!Number.isInteger(season)) throw new Error(`kiln ${k.id}: no season or date`);
  const evidence = evidenceObject({
    scene_id: k.scene_id ?? null,
    date: k.date ?? null,
    probs: k.probs ?? null,
    set: k.set ?? [],
    chip_sha256: chipSha256(k, src),
    model_sha256: (typeof k.model_sha256 === "string" && k.model_sha256) || modelSha,
  });
  const canonical = canonicalJson(evidence);
  const eh = "0x" + sha256Hex(Buffer.from(canonical, "utf8"));
  const idb = kilnIdBytes32(k.id);
  const status = statusCode(k.status);
  const bp = pZigzagBp(k.probs ?? null);
  return {
    id: k.id,
    season,
    kiln_id_bytes32: idb,
    status_code: status,
    p_zigzag_bp: bp,
    evidence,
    evidence_canonical: canonical,
    evidence_hash: eh,
    tuple: [idb, season, status, bp, eh],
  };
}

export interface SeasonTree {
  season: number;
  tree: StandardMerkleTree<LeafTuple>;
  leaves: BuiltLeaf[];
}

/** Groups built leaves by season and builds one StandardMerkleTree per season. */
export function buildSeasonTrees(kilns: KilnRecord[], src: KilnSource): SeasonTree[] {
  const modelSha = modelSha256(src);
  const bySeason = new Map<number, BuiltLeaf[]>();
  for (const k of kilns) {
    const b = buildLeaf(k, src, modelSha);
    if (!bySeason.has(b.season)) bySeason.set(b.season, []);
    bySeason.get(b.season)!.push(b);
  }
  const out: SeasonTree[] = [];
  for (const [season, leaves] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
    const seen = new Set<string>();
    for (const l of leaves) {
      if (seen.has(l.id)) throw new Error(`duplicate kiln id ${l.id} in season ${season}`);
      seen.add(l.id);
    }
    const tree = StandardMerkleTree.of(
      leaves.map((l) => l.tuple),
      LEAF_TYPES as unknown as string[],
    );
    out.push({ season, tree, leaves });
  }
  return out;
}
