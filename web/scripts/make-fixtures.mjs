// Generates SAMPLE fixtures for the web app's fixture mode (VITE_FIXTURE=1).
// Nothing here is a measurement. Scene ids, transaction hashes, model hashes and every number are
// synthetic and are shown in the UI under a "Sample data" banner.
// What IS real: the Merkle tree (built with @openzeppelin/merkle-tree, so the in-browser verifier is
// tested against the reference implementation), the leaf encoding, and the evidence hashes, which are
// computed over the exact bytes of the generated chip PNGs.
//
// Run: node scripts/make-fixtures.mjs

import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { encodeAbiParameters, keccak256, stringToHex } from "viem";
import { evidenceHashOf, pZigzagBp, sha256HexBare } from "../src/lib/encoding.ts";
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src", "fixtures");
const CHIPS = join(here, "..", "public", "fixtures", "chips");
mkdirSync(SRC, { recursive: true });
mkdirSync(CHIPS, { recursive: true });

// Deterministic PRNG (mulberry32) so fixtures are stable across runs.
let seed = 20261024;
function rnd() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + (b - a) * rnd();
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const hex32 = () => {
  let s = "0x";
  for (let i = 0; i < 64; i++) s += Math.floor(rnd() * 16).toString(16);
  return s;
};
const hex20 = () => "0x" + hex32().slice(2, 42);
const r4 = (x) => Math.round(x * 10000) / 10000;

// ---------- geohash (location-derived ids) ----------
const B32 = "0123456789bcdefghjkmnpqrstuvwxyz";
function geohash(lat, lon, len = 8) {
  let latR = [-90, 90], lonR = [-180, 180], bit = 0, ch = 0, even = true, out = "";
  while (out.length < len) {
    const r = even ? lonR : latR;
    const v = even ? lon : lat;
    const mid = (r[0] + r[1]) / 2;
    if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch = ch << 1; r[1] = mid; }
    even = !even;
    if (++bit === 5) { out += B32[ch]; bit = 0; ch = 0; }
  }
  return out;
}

// ---------- tiny PNG encoder ----------
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A synthetic 64 x 64 "chip" (10 m pixels, 640 m across). Fields in strips, and a kiln drawn as an
// oval ring (FCBK) or a rectangle ring (Zigzag), or nothing (not seen). Not satellite imagery.
function chip(kind, variant) {
  const W = 64, H = 64, buf = Buffer.alloc(W * H * 3);
  const angle = between(-0.6, 0.6);
  const stripW = between(5, 9);
  const palette = [[118, 128, 84], [142, 136, 96], [104, 118, 78], [160, 146, 112], [128, 120, 90]];
  const strips = Array.from({ length: 30 }, () => pick(palette));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x * Math.cos(angle) + y * Math.sin(angle) + 40;
    const c = strips[Math.floor(u / stripW) % strips.length];
    const n = (rnd() - 0.5) * 18;
    const i = (y * W + x) * 3;
    buf[i] = Math.max(0, Math.min(255, c[0] + n));
    buf[i + 1] = Math.max(0, Math.min(255, c[1] + n));
    buf[i + 2] = Math.max(0, Math.min(255, c[2] + n));
  }
  const set = (x, y, c, a = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) buf[i + k] = Math.round(buf[i + k] * (1 - a) + c[k] * a);
  };
  const cx = 32 + between(-3, 3), cy = 32 + between(-3, 3);
  // clay yard around any kiln site
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, (y - cy) * 1.2);
    if (d < 17) set(x, y, [176, 150, 122], 0.55 + rnd() * 0.2);
  }
  const brick = [150, 74, 52], soot = [48, 40, 36];
  const rot = variant * 0.9;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  if (kind === "FCBK") {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const ux = dx * cs + dy * sn, uy = -dx * sn + dy * cs;
      const e = Math.hypot(ux / 11, uy / 6.5);
      if (e > 0.72 && e < 1.05) set(x, y, brick, 0.85);
      else if (e <= 0.72 && e > 0.25) set(x, y, [118, 96, 80], 0.6);
    }
    set(Math.round(cx), Math.round(cy), soot); set(Math.round(cx) + 1, Math.round(cy), soot);
  } else if (kind === "Zigzag") {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const ux = dx * cs + dy * sn, uy = -dx * sn + dy * cs;
      const inOuter = Math.abs(ux) < 12 && Math.abs(uy) < 7;
      const inInner = Math.abs(ux) < 8.5 && Math.abs(uy) < 3.6;
      if (inOuter && !inInner) set(x, y, brick, 0.85);
      else if (inInner) set(x, y, [112, 92, 78], 0.6);
    }
    set(Math.round(cx + 13 * cs), Math.round(cy + 13 * sn), soot);
  } else {
    // not seen: bare scraped ground where a kiln stood
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < 9) set(x, y, [168, 146, 120], 0.35);
    }
  }
  return png(W, H, buf);
}

// ---------- kilns ----------
const DISTRICTS = [
  { name: "Kasur", s: 30.9, n: 31.25, w: 73.98, e: 74.55, n_k: 46 },
  { name: "Lahore", s: 31.32, n: 31.68, w: 74.12, e: 74.55, n_k: 34 },
  { name: "Sheikhupura", s: 31.58, n: 31.88, w: 73.78, e: 74.12, n_k: 38 },
  { name: "Nankana Sahib", s: 31.3, n: 31.55, w: 73.58, e: 73.9, n_k: 26 },
];
const SEASON = 202610;
const QHAT = 0.8123; // include class c in the set when 1 - p_c <= qhat
const ALPHA = 0.1;
const MODEL_SHA = "5a".repeat(4) + hex32().slice(10); // bare lowercase hex, as summary.models.classifier_sha256
const DETECTOR_SHA = hex32();
const SCENES = [
  { id: "SAMPLE-S2-20261019-A", date: "2026-10-19", cloud_pct: 3.1 },
  { id: "SAMPLE-S2-20261019-B", date: "2026-10-19", cloud_pct: 6.4 },
  { id: "SAMPLE-S2-20261014-C", date: "2026-10-14", cloud_pct: 1.8 },
];
const CODE = { NOT_DETECTED: 0, FCBK: 1, ZIGZAG: 2, UNDETERMINED: 3 };

const kilns = [];
for (const d of DISTRICTS) {
  for (let i = 0; i < d.n_k; i++) {
    let lat, lon;
    do {
      lat = between(d.s, d.n); lon = between(d.w, d.e);
    } while (d.name === "Lahore" && Math.hypot(lat - 31.52, lon - 74.34) < 0.11);
    lat = r4(lat); lon = r4(lon);
    const baselineClass = rnd() < 0.72 ? "FCBK" : "Zigzag";
    const u = rnd();
    let status;
    if (baselineClass === "Zigzag") status = u < 0.85 ? "ZIGZAG" : u < 0.95 ? "UNDETERMINED" : "NOT_DETECTED";
    else status = u < 0.38 ? "ZIGZAG" : u < 0.66 ? "FCBK" : u < 0.9 ? "UNDETERMINED" : "NOT_DETECTED";
    kilns.push({ id: "PK-" + geohash(lat, lon, 8), lat, lon, district: d.name, baselineClass, status });
  }
}

const values = [];
const records = [];
for (const k of kilns) {
  const scene = pick(SCENES);
  let pZ = null, detected = true, detConf = null;
  if (k.status === "ZIGZAG") pZ = between(0.83, 0.99);
  else if (k.status === "FCBK") pZ = between(0.01, 0.17);
  else if (k.status === "UNDETERMINED") pZ = between(0.24, 0.76);
  else detected = false;
  let probs = null, set = [];
  if (detected) {
    pZ = r4(pZ);
    if (Number.isInteger(pZ)) pZ = 0.9999;
    const pF = r4(1 - pZ);
    probs = { FCBK: pF, Zigzag: pZ };
    if (1 - pF <= QHAT) set.push("FCBK");
    if (1 - pZ <= QHAT) set.push("Zigzag");
    detConf = r4(between(0.62, 0.97));
  }
  const variant = rnd();
  const baseChipName = `${k.id}_2023.png`;
  const nowChipName = `${k.id}_2026.png`;
  const baseBytes = chip(k.baselineClass, variant);
  const nowKind = k.status === "ZIGZAG" ? "Zigzag" : k.status === "FCBK" ? "FCBK" :
    k.status === "UNDETERMINED" ? (rnd() < 0.5 ? "Zigzag" : "FCBK") : "none";
  const nowBytes = chip(nowKind, variant);
  writeFileSync(join(CHIPS, baseChipName), baseBytes);
  writeFileSync(join(CHIPS, nowChipName), nowBytes);
  const chipSha = sha256HexBare(nowBytes);
  const evidenceHash = evidenceHashOf({ scene_id: scene.id, date: scene.date, probs, set, chip_sha256: chipSha, model_sha256: MODEL_SHA });
  const kilnId = stringToHex(k.id, { size: 32 });
  const pBp = pZigzagBp(probs);
  const v = [kilnId, SEASON, CODE[k.status], pBp, evidenceHash];
  values.push(v);
  records.push({
    id: k.id, lat: k.lat, lon: k.lon, district: k.district,
    baseline: { source: "SentinelKilnDB hand label", period: "2023-09/2024-02", class: k.baselineClass },
    observation: {
      scene_id: scene.id, date: scene.date, detected, det_conf: detConf, probs, set,
      chip: `chips/${nowChipName}`, baseline_chip: `chips/${baseChipName}`,
    },
    status: k.status,
    chain: { season: SEASON, leaf: "", proof: [], evidence_hash: evidenceHash, status_code: CODE[k.status], p_zigzag_bp: pBp },
    events: [],
  });
}

const tree = StandardMerkleTree.of(values, ["bytes32", "uint32", "uint8", "uint16", "bytes32"]);
// sanity check: our hand-rolled leaf matches the reference implementation
{
  const enc = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint32" }, { type: "uint8" }, { type: "uint16" }, { type: "bytes32" }],
    values[0],
  );
  const leaf = keccak256(keccak256(enc));
  if (leaf !== tree.leafHash(values[0])) throw new Error("leaf mismatch vs OpenZeppelin");
}
const root = tree.root;
const seasonTx = hex32();
const seasonBlock = 9480211;
const seasonTime = "2026-10-21T09:14:36Z";
const INSPECTORS = [hex20(), hex20(), hex20()];

const ledgerEvents = [];
let block = seasonBlock;
let t0 = Date.parse(seasonTime);
const later = () => {
  block += Math.floor(between(40, 900));
  t0 += Math.floor(between(20, 240)) * 60000;
  return { block, time: new Date(t0).toISOString().replace(".000", "") };
};

ledgerEvents.push({ type: "SeasonPublished", kiln_id: null, season: SEASON, tx: seasonTx, block: seasonBlock, time: seasonTime, detail: { root, kilns: records.length, model_sha256: MODEL_SHA } });

for (const [i, v] of tree.entries()) {
  const rec = records[i];
  rec.chain.leaf = tree.leafHash(v);
  rec.chain.proof = tree.getProof(i);
  rec.events.push({ type: "SeasonPublished", tx: seasonTx, block: seasonBlock, time: seasonTime, detail: { season: SEASON, version: 1, root } });
}

// a handful of on-chain stories, so every event type appears
const byStatus = (s) => records.filter((r) => r.status === s);
const push = (rec, ev) => { rec.events.push(ev); ledgerEvents.push({ ...ev, kiln_id: rec.id, season: SEASON }); };
for (const rec of byStatus("ZIGZAG").slice(0, 9)) {
  const a = later();
  push(rec, { type: "SatelliteProven", tx: hex32(), ...a, detail: { kilnId: stringToHex(rec.id, { size: 32 }), status: 2, pZigzagBp: rec.chain.p_zigzag_bp, evidenceHash: rec.chain.evidence_hash, rootVersion: 1 } });
}
for (const rec of byStatus("ZIGZAG").slice(0, 5)) {
  const a = later();
  push(rec, { type: "FindingAttested", tx: hex32(), ...a, detail: { finding: 1, inspector: pick(INSPECTORS), evidenceHash: hex32() } });
}
for (const rec of byStatus("FCBK").slice(0, 3)) {
  const a = later();
  const tx = hex32();
  const insp = pick(INSPECTORS);
  push(rec, { type: "FindingAttested", tx, ...a, detail: { finding: 1, inspector: insp, evidenceHash: hex32() } });
  push(rec, { type: "Conflict", tx, ...a, detail: { reasonCode: 2, inspector: insp } });
}
for (const rec of byStatus("FCBK").slice(3, 5)) {
  const a = later();
  push(rec, { type: "FindingAttested", tx: hex32(), ...a, detail: { finding: 2, inspector: pick(INSPECTORS), evidenceHash: hex32() } });
}
for (const rec of [...byStatus("FCBK").slice(5, 6), ...byStatus("NOT_DETECTED").slice(0, 1)]) {
  const a = later();
  push(rec, { type: "Disputed", tx: hex32(), ...a, detail: { submitter: hex20(), evidenceHash: hex32(), note: rec.status === "FCBK" ? "Kiln rebuilt as zigzag in August; photos and invoice hashed." : "Kiln still operating; chimney visible from road." } });
}
for (const rec of byStatus("UNDETERMINED").slice(0, 2)) {
  const a = later();
  push(rec, { type: "FindingAttested", tx: hex32(), ...a, detail: { finding: 3, inspector: pick(INSPECTORS), evidenceHash: hex32() } });
}

// ---------- derived views ----------
const counts = { ZIGZAG: 0, FCBK: 0, UNDETERMINED: 0, NOT_DETECTED: 0 };
for (const r of records) counts[r.status]++;

const kilnList = records.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, district: r.district, status: r.status, baseline_class: r.baseline.class }));

const conflictIds = new Set(ledgerEvents.filter((e) => e.type === "Conflict").map((e) => e.kiln_id));
const queue = [];
const fc = byStatus("FCBK").sort((a, b) => (conflictIds.has(b.id) - conflictIds.has(a.id)) || a.chain.p_zigzag_bp - b.chain.p_zigzag_bp);
for (const r of fc) queue.push({ r, code: conflictIds.has(r.id) ? "CONFLICT" : "SAT_FCBK" });
for (const r of byStatus("UNDETERMINED").sort((a, b) => a.chain.p_zigzag_bp - b.chain.p_zigzag_bp)) queue.push({ r, code: "UNDETERMINED" });
for (const r of byStatus("NOT_DETECTED")) queue.push({ r, code: "NOT_SEEN" });
const REASON = {
  CONFLICT: (r) => `Satellite says FCBK (P(Zigzag) ${(r.chain.p_zigzag_bp / 100).toFixed(1)}%) but an inspector signed Zigzag confirmed. Public conflict on the ledger.`,
  SAT_FCBK: (r) => `Satellite supports only FCBK at 90%. P(Zigzag) ${(r.chain.p_zigzag_bp / 100).toFixed(1)}%. The conversion claim is contradicted.`,
  UNDETERMINED: (r) => `The image cannot separate Zigzag from FCBK at 10 m. P(Zigzag) ${(r.chain.p_zigzag_bp / 100).toFixed(1)}%.`,
  NOT_SEEN: () => "Labelled in 2023-24 but not seen this season. Demolished, dismantled or missed.",
};
const inspectQueue = queue.map(({ r, code }, i) => ({
  rank: i + 1, id: r.id, district: r.district, lat: r.lat, lon: r.lon, status: r.status,
  baseline_class: r.baseline.class, p_zigzag: r.observation.probs ? r.observation.probs.Zigzag : null,
  reason_code: code, reason: REASON[code](r),
}));

// Same shape as the real API's summary.impact. The percentages here are placeholders for layout and
// are marked as sample data in the UI; the real API supplies verified figures and sources.
const IMPACT = {
  sample: true,
  per_conversion: [
    { key: "coal", reduction_pct: 20, source: { title: "Sample source (the API supplies the verified citation)", url: "", quote: "" } },
    { key: "co2", reduction_pct: 15, source: { title: "Sample source (the API supplies the verified citation)", url: "", quote: "" } },
    { key: "pm", reduction_pct: 40, source: { title: "Sample source (the API supplies the verified citation)", url: "", quote: "" } },
    { key: "black_carbon", reduction_pct: 60, source: { title: "Sample source (the API supplies the verified citation)", url: "", quote: "" } },
  ],
  note: "Sample note: reductions are per kiln converted from FCBK to Zigzag, as measured in field studies; the API supplies the real note.",
};

const summary = {
  fixture: true,
  data_version: "sample-2026-10-24",
  season: SEASON,
  counts,
  total: records.length,
  aoi: { name: "Lahore, Kasur, Sheikhupura and Nankana Sahib (sample area)", bbox: [73.55, 30.88, 74.58, 31.9], districts: DISTRICTS.map((d) => d.name) },
  scenes: SCENES,
  models: { detector_sha256: DETECTOR_SHA, classifier_sha256: MODEL_SHA },
  model_sha256: MODEL_SHA,
  alpha: ALPHA,
  qhat: QHAT,
  claim: {
    quote: "around 8,000 brick kilns across Punjab had been converted to zigzag technology, with QR codes assigned to all kilns",
    who: "Punjab minister, as reported by ProPakistani",
    date: "2026-10-10",
    url: "https://propakistani.pk/2026/10/10/punjab-provides-10000-super-seeders-converts-8000-brick-kilns-to-zigzag-technology/",
    claimed_converted: 8000,
    province_total: 10394,
    province_total_source: { title: "Express Tribune, Aug 2026", url: "https://tribune.com.pk/story/2621873/brick-kiln-crackdown-raises-livelihood-concerns" },
  },
  impact: IMPACT,
};

const ledger = {
  fixture: true,
  mock_chain: true,
  chain_id: 11155111,
  chain_name: "Ethereum Sepolia",
  contract: null,
  explorer: "https://sepolia.etherscan.io",
  rpc: "https://ethereum-sepolia-rpc.publicnode.com",
  seasons: [{ season: SEASON, root, tx: seasonTx, block: seasonBlock, time: seasonTime, model_hash: MODEL_SHA, kilns: records.length }],
  events: ledgerEvents.slice().sort((a, b) => b.block - a.block),
};

const results = {
  fixture: true,
  prereg_url: "docs/PREREG.md",
  split: "Spatial blocks of 0.5 degrees; 60/20/20 train/calibration/test; seed 20261024",
  targets: [
    { id: "T1", metric: "Detector recall at IoU 0.3", target: ">= 0.80", op: ">=", threshold: 0.8, value: 0.84, n: 412, hit: true },
    { id: "T2", metric: "Detector precision at IoU 0.3", target: ">= 0.75", op: ">=", threshold: 0.75, value: 0.71, n: 488, hit: false },
    { id: "T3", metric: "Classifier accuracy, FCBK vs Zigzag", target: ">= 0.85", op: ">=", threshold: 0.85, value: 0.88, n: 346, hit: true },
    { id: "T4", metric: "Conformal empirical coverage", target: "0.87 to 0.93", op: "between", low: 0.87, high: 0.93, value: 0.905, n: 346, hit: true },
    { id: "T5", metric: "Share of kilns given a single-class set", target: ">= 0.70", op: ">=", threshold: 0.7, value: 0.66, n: 346, hit: false },
    { id: "T6", metric: "Of single-set {Zigzag} kilns, share truly FCBK", target: "<= 0.05", op: "<=", threshold: 0.05, value: 0.031, n: 161, hit: true },
  ],
};

const audit = { fixture: true, n: 0, agreed: 0, disagreed: 0, unsure: 0, rows: [], status: "Not yet run" };

const health = { ok: true, fixture: true, data_version: summary.data_version, chain: { id: 11155111, contract: null } };

const w = (name, obj) => writeFileSync(join(SRC, name), JSON.stringify(obj, null, 1) + "\n");
w("health.json", health);
w("summary.json", summary);
w("kilns.json", kilnList);
w("records.json", Object.fromEntries(records.map((r) => [r.id, r])));
w("queue.json", inspectQueue);
w("ledger.json", ledger);
w("results.json", results);
w("audit.json", audit);
console.log(`wrote ${records.length} sample kilns, root ${root}`, counts);
