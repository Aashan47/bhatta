// Typed client for the Bhatta API (api/bhatta_api, contract in docs/PRODUCT.md). Every response goes
// through a normaliser so pages see one shape whether the data came from the real API or from the
// sample fixtures. With VITE_FIXTURE=1 every call is answered from src/fixtures/ (no network) and the
// UI shows a "Sample data" banner.

import { bytes32ToId, CHAIN_NAMES, DEFAULT_RPC } from "./lib/chain";
import type {
  AttestBody,
  Audit,
  ChainEvent,
  DisputeBody,
  EventType,
  Health,
  Hex,
  KilnClass,
  KilnListItem,
  KilnRecord,
  Ledger,
  QueueItem,
  ReasonCode,
  RelayResult,
  ResultRow,
  Results,
  Scene,
  Status,
  Summary,
} from "./types";

export const FIXTURE = import.meta.env.VITE_FIXTURE === "1";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

async function fixtures() {
  return (await import("./fixtures")).default;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(path: string): Promise<Raw> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { headers: { Accept: "application/json" } });
  } catch {
    throw new ApiError(0, "NetworkError: the API could not be reached.");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new ApiError(res.status === 200 ? 502 : res.status, `The API did not answer /api${path} with JSON.`);
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? data?.detail ?? `${res.status} for /api${path}`);
  return data;
}

async function post(path: string, body: unknown): Promise<Raw> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? data.detail ?? `${res.status} ${res.statusText}`);
  return data;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

// ------------------------------------------------------------------ normalisers

const STATUSES: Status[] = ["ZIGZAG", "FCBK", "UNDETERMINED", "NOT_DETECTED"];

function normStatus(s: Raw): Status {
  const k = String(s ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (k === "NOT_SEEN" || k === "NOTDETECTED") return "NOT_DETECTED";
  return (STATUSES as string[]).includes(k) ? (k as Status) : "UNDETERMINED";
}

function normClass(c: Raw): KilnClass | null {
  if (!c) return null;
  const s = String(c).toLowerCase();
  if (s.startsWith("zig")) return "Zigzag";
  if (s.includes("fcbk")) return "FCBK";
  return null;
}

function seasonFromDate(d: string | null | undefined): number | null {
  const m = d ? /^(\d{4})-(\d{2})/.exec(d) : null;
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

function normScenes(s: Raw): Scene[] {
  if (Array.isArray(s)) return s.map((x) => (typeof x === "string" ? { id: x, date: "" } : { id: x.id, date: x.date ?? "", cloud_pct: x.cloud_pct }));
  if (s && typeof s === "object") return Object.entries(s).map(([id, date]) => ({ id, date: String(date ?? "") }));
  return [];
}

function normSummary(raw: Raw): Summary {
  const c = raw.counts ?? raw.counts_by_status ?? {};
  const counts = Object.fromEntries(STATUSES.map((s) => [s, Number(c[s] ?? 0)])) as Record<Status, number>;
  const total = Number(raw.total ?? raw.n_kilns ?? STATUSES.reduce((a, s) => a + counts[s], 0));
  const scenes = normScenes(raw.scenes);
  const latest = scenes.map((x) => x.date).filter(Boolean).sort().pop();
  const aoi = raw.aoi ?? {};
  const districts: string[] = aoi.districts ?? [...(aoi.full_scan_districts ?? []), ...(aoi.known_kiln_districts ?? [])];
  const claim = raw.claim ?? {};
  const fromQuote = /([\d,]{3,})\s+brick kilns/i.exec(claim.quote ?? "");
  return {
    fixture: Boolean(raw.fixture) || FIXTURE,
    data_version: raw.data_version,
    season: raw.season ?? seasonFromDate(latest),
    counts,
    total,
    aoi: { name: aoi.name ?? districts.join(", "), bbox: aoi.bbox, districts },
    scenes,
    models: raw.models ?? {},
    model_sha256: raw.model_sha256 ?? raw.models?.classifier_sha256,
    alpha: Number(raw.alpha ?? 0.1),
    qhat: raw.qhat === undefined ? undefined : Number(raw.qhat),
    claim: {
      quote: claim.quote ?? "",
      who: claim.who ?? "",
      date: claim.date,
      url: claim.url ?? "",
      claimed_converted: claim.claimed_converted ?? (fromQuote ? Number(fromQuote[1]!.replace(/,/g, "")) : undefined),
      province_total: claim.province_total ?? claim.survey_count,
      province_total_source:
        claim.province_total_source ?? (claim.survey_url ? { title: claim.survey_source ?? claim.survey_url, url: claim.survey_url } : undefined),
    },
    caveats: Array.isArray(raw.caveats) ? raw.caveats : [],
    impact: raw.impact && Array.isArray(raw.impact.per_conversion) ? raw.impact : undefined,
  };
}

function normKiln(k: Raw): KilnListItem {
  return {
    id: k.id,
    lat: Number(k.lat),
    lon: Number(k.lon),
    district: k.district ?? "",
    status: normStatus(k.status),
    baseline_class: normClass(k.baseline_class ?? k.baseline?.class),
  };
}

const EVENT_ALIASES: Record<string, EventType> = { FindingAttested: "Finding" };
const KNOWN_EVENTS: EventType[] = [
  "SeasonPublished",
  "SeasonConfirmed",
  "SeasonActivated",
  "CorrectionPublished",
  "SatelliteProven",
  "Finding",
  "FindingRevised",
  "Conflict",
  "Disputed",
  "Certified",
  "CertificateWithdrawn",
  "RpcError",
];

function normEvent(e: Raw): ChainEvent | null {
  const type = (EVENT_ALIASES[e.type] ?? e.type) as EventType;
  if (!KNOWN_EVENTS.includes(type)) return null;
  const d = { ...(e.detail ?? {}) };
  if (d.submitter && !d.by) d.by = d.submitter;
  return {
    type,
    tx: e.tx ?? null,
    block: Number(e.block ?? 0),
    time: e.time,
    kiln_id: e.kiln_id ?? (typeof d.kilnId === "string" ? bytes32ToId(d.kilnId) : null),
    season: e.season ?? (d.season !== undefined ? Number(d.season) : undefined),
    detail: d,
  };
}

const normEvents = (list: Raw): ChainEvent[] => (Array.isArray(list) ? list.map(normEvent).filter((x): x is ChainEvent => !!x) : []);

function normRecord(r: Raw): KilnRecord {
  const o = r.observation ?? {};
  const probs = o.probs && typeof o.probs === "object" && o.probs.Zigzag !== undefined ? { FCBK: Number(o.probs.FCBK), Zigzag: Number(o.probs.Zigzag) } : null;
  const set = (Array.isArray(o.set) ? o.set : []).map(normClass).filter((x: KilnClass | null): x is KilnClass => !!x);
  const b = r.baseline;
  return {
    id: r.id,
    lat: Number(r.lat),
    lon: Number(r.lon),
    district: r.district ?? "",
    baseline: b ? { source: b.source ?? "", period: b.period ?? "", class: normClass(b.class) ?? "FCBK" } : null,
    observation: {
      scene_id: o.scene_id ?? null,
      date: o.date ?? null,
      detected: Boolean(o.detected),
      det_conf: o.det_conf ?? null,
      probs,
      set,
      chip: o.chip ?? null,
      baseline_chip: o.baseline_chip ?? null,
      model_sha256: o.model_sha256 ?? r.model_sha256,
    },
    status: normStatus(r.status),
    chain: r.chain
      ? {
          season: Number(r.chain.season),
          root: r.chain.root,
          leaf: r.chain.leaf,
          proof: r.chain.proof ?? [],
          evidence_hash: r.chain.evidence_hash,
          status_code: Number(r.chain.status_code),
          p_zigzag_bp: Number(r.chain.p_zigzag_bp),
        }
      : null,
    events: normEvents(r.events),
  };
}

function reasonFor(status: Status, conflict: boolean): ReasonCode {
  if (conflict) return "CONFLICT";
  if (status === "FCBK") return "SAT_FCBK";
  if (status === "UNDETERMINED") return "UNDETERMINED";
  if (status === "NOT_DETECTED") return "NOT_SEEN";
  return "SAT_ZIGZAG";
}

function normQueue(rows: Raw): QueueItem[] {
  return (Array.isArray(rows) ? rows : []).map((r: Raw, i: number) => {
    const status = normStatus(r.status);
    let p: number | null = r.p_zigzag ?? null;
    if (p === null && typeof r.p_fcbk === "number" && r.p_fcbk > 0 && status !== "NOT_DETECTED") p = 1 - r.p_fcbk;
    return {
      rank: Number(r.rank ?? r.priority ?? i + 1),
      id: r.id,
      district: r.district ?? "",
      lat: Number(r.lat),
      lon: Number(r.lon),
      status,
      baseline_class: normClass(r.baseline_class),
      p_zigzag: p,
      reason_code: (r.reason_code as ReasonCode) ?? reasonFor(status, false),
      reason: r.reason ?? "",
    };
  });
}

function normLedger(raw: Raw): Ledger {
  const chainId = Number(raw.chain_id ?? 11155111);
  return {
    fixture: Boolean(raw.fixture) || FIXTURE,
    mock_chain: Boolean(raw.mock_chain) || (!raw.contract && (Boolean(raw.fixture) || FIXTURE)),
    chain_id: chainId,
    chain_name: raw.chain_name ?? CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
    contract: raw.contract ?? null,
    explorer: raw.explorer ?? raw.explorer_base ?? "",
    rpc: raw.rpc ?? DEFAULT_RPC,
    abi: raw.abi,
    eip712: raw.eip712 ? { name: raw.eip712.name, version: raw.eip712.version } : undefined,
    seasons: (raw.seasons ?? []).map((s: Raw) => ({
      season: Number(s.season),
      root: s.root,
      tx: s.tx ?? null,
      model_hash: typeof s.model_hash === "string" ? s.model_hash : null,
      block: s.block,
      time: s.time,
      kilns: s.kilns,
    })),
    events: normEvents(raw.events),
  };
}

/** The pre-registered targets (docs/PREREG.md), used to label rows the API leaves bare. */
const PREREG: Record<string, { metric: string; target: string }> = {
  T1: { metric: "Detector recall at IoU 0.3", target: ">= 0.80" },
  T2: { metric: "Detector precision at IoU 0.3", target: ">= 0.75" },
  T3: { metric: "Classifier accuracy, FCBK vs Zigzag, on true kilns", target: ">= 0.85" },
  T4: { metric: "Conformal empirical coverage", target: "0.87 to 0.93" },
  T5: { metric: "Share of kilns given a single-class set", target: ">= 0.70" },
  T6: { metric: "Of kilns given the single set {Zigzag}, share truly FCBK", target: "<= 0.05" },
};

function normResults(raw: Raw): Results {
  const rows: Raw[] = Array.isArray(raw) ? raw : (raw.targets ?? []);
  const byId = new Map<string, ResultRow>();
  for (const r of rows) {
    const cells: string[] = Array.isArray(r.cells) ? r.cells : [];
    const pre = PREREG[r.id];
    byId.set(r.id, {
      id: r.id,
      metric: r.metric ?? r.description ?? r.what ?? cells[0] ?? pre?.metric ?? "",
      target: r.target ?? r.threshold ?? cells[1] ?? pre?.target ?? "",
      value: r.value ?? r.result ?? r.measured ?? r.observed ?? cells[2] ?? null,
      n: r.n !== undefined && !Number.isNaN(Number(r.n)) ? Number(r.n) : undefined,
      hit: r.hit === true ? true : r.hit === false ? false : null,
      note: r.note ?? r.notes,
    });
  }
  const targets = Object.keys(PREREG).map(
    (id) => byId.get(id) ?? { id, metric: PREREG[id]!.metric, target: PREREG[id]!.target, value: null, hit: null },
  );
  return { fixture: Boolean(raw.fixture) || FIXTURE, split: raw.split, targets, limits: raw.limits };
}

// ------------------------------------------------------------------ calls

export async function getHealth(): Promise<Health> {
  const raw = FIXTURE ? (await fixtures()).health : await get("/health");
  return { ok: Boolean(raw.ok), fixture: Boolean(raw.fixture), data_version: raw.data_version ?? "", chain: raw.chain ?? { id: null, contract: null } };
}

export async function getSummary(): Promise<Summary> {
  if (FIXTURE) {
    await wait(120);
    return normSummary((await fixtures()).summary);
  }
  return normSummary(await get("/summary"));
}

export async function getKilns(filter: { status?: Status; district?: string } = {}): Promise<KilnListItem[]> {
  let list: Raw[];
  if (FIXTURE) {
    await wait(120);
    list = (await fixtures()).kilns as Raw[];
  } else list = await get(`/kilns${qs({ status: filter.status, district: filter.district })}`);
  return list
    .map(normKiln)
    .filter((k) => (!filter.status || k.status === filter.status) && (!filter.district || k.district === filter.district));
}

export async function getKiln(id: string): Promise<KilnRecord> {
  if (FIXTURE) {
    await wait(120);
    const rec = (await fixtures()).records[id];
    if (!rec) throw new ApiError(404, `No kiln with id ${id}`);
    return normRecord(rec);
  }
  return normRecord(await get(`/kilns/${encodeURIComponent(id)}`));
}

/** URL of a chip image. The record carries "chips/<file>.png"; the API serves it at /api/chips/<file>. */
export function chipUrl(chip: string): string {
  const file = chip.replace(/^\/?chips\//, "");
  return FIXTURE ? `/fixtures/chips/${file}` : `/api/chips/${encodeURIComponent(file)}`;
}

export async function getQueue(district?: string): Promise<QueueItem[]> {
  if (FIXTURE) {
    await wait(120);
    const q = normQueue((await fixtures()).queue);
    return district ? q.filter((x) => x.district === district).map((x, i) => ({ ...x, rank: i + 1 })) : q;
  }
  return normQueue(await get(`/inspect/queue${qs({ district })}`));
}

export async function getLedger(): Promise<Ledger> {
  if (FIXTURE) {
    await wait(120);
    return normLedger((await fixtures()).ledger);
  }
  return normLedger(await get("/ledger"));
}

export async function getResults(): Promise<Results> {
  if (FIXTURE) return normResults((await fixtures()).results);
  return normResults(await get("/results"));
}

/** /api/audit may not exist yet; a 404 means the audit has not been run. */
export async function getAudit(): Promise<Audit> {
  const empty: Audit = { n: 0, agreed: 0, disagreed: 0, unsure: 0, rows: [] };
  if (FIXTURE) return (await fixtures()).audit;
  try {
    const raw = await get("/audit");
    return { ...empty, ...raw, rows: Array.isArray(raw.rows) ? raw.rows : [] };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return empty;
    throw e;
  }
}

export async function relayAttest(body: AttestBody): Promise<RelayResult> {
  if (FIXTURE) {
    await wait(600);
    return { mock: true, error: "Sample mode: no contract is deployed, so nothing was relayed." };
  }
  return post("/relay/attest", body) as Promise<RelayResult>;
}

export async function relayDispute(body: DisputeBody): Promise<RelayResult> {
  if (FIXTURE) {
    await wait(600);
    return { mock: true, error: "Sample mode: no contract is deployed, so nothing was relayed." };
  }
  return post("/relay/dispute", body) as Promise<RelayResult>;
}

export type { Hex };
