// Internal types for the web app. src/api.ts normalises what the API returns (api/bhatta_api) into
// these shapes, so pages never deal with optional spellings.

export type Status = "ZIGZAG" | "FCBK" | "UNDETERMINED" | "NOT_DETECTED";
export type KilnClass = "FCBK" | "Zigzag";
export type Hex = `0x${string}`;

export const STATUS_CODE: Record<Status, number> = { NOT_DETECTED: 0, FCBK: 1, ZIGZAG: 2, UNDETERMINED: 3 };
export const STATUS_ORDER: Status[] = ["ZIGZAG", "FCBK", "UNDETERMINED", "NOT_DETECTED"];

/** Inspector findings on chain: 1 ZIGZAG_CONFIRMED, 2 FCBK_FOUND, 3 NOT_OPERATING, 4 DEMOLISHED. */
export type FindingCode = 1 | 2 | 3 | 4;

export interface Range {
  low: number;
  high: number;
}

export interface Source {
  title: string;
  url: string;
}

export type ImpactKey = "coal" | "co2" | "pm" | "black_carbon";

export interface ImpactItem {
  key: ImpactKey;
  reduction_pct: number;
  source: { title: string; url: string; quote?: string };
}

/** summary.impact: measured reductions per kiln converted from FCBK to Zigzag. Never tonnes. */
export interface ImpactSummary {
  per_conversion: ImpactItem[];
  note?: string;
  sample?: boolean;
}

export interface Health {
  ok: boolean;
  fixture: boolean;
  data_version: string;
  chain: { id: number | null; contract: Hex | null; configured?: boolean };
}

export interface Scene {
  id: string;
  date: string;
  cloud_pct?: number;
}

export interface Summary {
  fixture: boolean;
  data_version?: string;
  season: number | null;
  counts: Record<Status, number>;
  total: number;
  aoi: { name: string; bbox?: [number, number, number, number]; districts: string[] };
  scenes: Scene[];
  models: { detector_sha256?: string; classifier_sha256?: string; detector?: string; classifier?: string };
  model_sha256?: string;
  alpha: number;
  qhat?: number;
  claim: {
    quote: string;
    who: string;
    date?: string;
    url: string;
    claimed_converted?: number;
    province_total?: number;
    province_total_source?: Source;
  };
  caveats: string[];
  impact?: ImpactSummary;
}

export interface KilnListItem {
  id: string;
  lat: number;
  lon: number;
  district: string;
  status: Status;
  baseline_class: KilnClass | null;
}

export type EventType =
  | "SeasonPublished"
  | "SeasonConfirmed"
  | "SeasonActivated"
  | "CorrectionPublished"
  | "SatelliteProven"
  | "Finding"
  | "FindingRevised"
  | "Conflict"
  | "Disputed"
  | "Certified"
  | "CertificateWithdrawn"
  | "RpcError";

export interface ChainEvent {
  type: EventType;
  tx: Hex | null;
  block: number;
  time?: string;
  kiln_id?: string | null;
  season?: number;
  detail: Record<string, unknown>;
}

export interface KilnRecord {
  id: string;
  lat: number;
  lon: number;
  district: string;
  baseline: { source: string; period: string; class: KilnClass } | null;
  observation: {
    scene_id: string | null;
    date: string | null;
    detected: boolean;
    det_conf: number | null;
    probs: { FCBK: number; Zigzag: number } | null;
    set: KilnClass[];
    chip: string | null;
    baseline_chip: string | null;
    model_sha256?: string;
  };
  status: Status;
  chain: {
    season: number;
    root?: Hex;
    leaf: Hex;
    proof: Hex[];
    evidence_hash: Hex;
    status_code: number;
    p_zigzag_bp: number;
  } | null;
  events: ChainEvent[];
}

export type ReasonCode = "CONFLICT" | "SAT_FCBK" | "UNDETERMINED" | "NOT_SEEN" | "SAT_ZIGZAG";

export interface QueueItem {
  rank: number;
  id: string;
  district: string;
  lat: number;
  lon: number;
  status: Status;
  baseline_class: KilnClass | null;
  p_zigzag: number | null;
  reason_code: ReasonCode;
  reason: string;
}

export interface SeasonRoot {
  season: number;
  root: Hex;
  tx: Hex | null;
  model_hash: string | null;
  block?: number;
  time?: string;
  kilns?: number;
}

export interface Ledger {
  fixture: boolean;
  /** True when there is no contract and the roots come from the sample data. */
  mock_chain: boolean;
  chain_id: number;
  chain_name: string;
  contract: Hex | null;
  /** Explorer base URL, or "" when there is none (local node). */
  explorer: string;
  rpc: string;
  abi?: unknown[];
  eip712?: { name: string; version: string };
  seasons: SeasonRoot[];
  events: ChainEvent[];
}

export interface ProductMetrics {
  n_test?: number | null;
  fcbk_calls?: number | null;
  fcbk_calls_wrong?: number | null;
  fcbk_wrong_share?: number | null;
  refused_share?: number | null;
  zigzag_certified?: number | null;
  coverage?: number | null;
  coverage_fcbk?: number | null;
  coverage_zigzag?: number | null;
  detector_recall?: number | null;
  detector_precision?: number | null;
}

export interface ResultRow {
  id: string;
  metric: string;
  target: string;
  value: string | number | null;
  n?: string | number;
  hit: boolean | null;
  note?: string;
}

export interface Results {
  fixture: boolean;
  /** True when the rows are copied from measured results even in sample mode. */
  measured?: boolean;
  split?: string;
  targets: ResultRow[];
  limits?: string[];
  product: ProductMetrics | null;
}

export interface AuditRow {
  id: string;
  model: string;
  human: string;
  agree: boolean | null;
  note?: string;
}

export interface Audit {
  fixture?: boolean;
  n: number;
  agreed: number;
  disagreed: number;
  unsure: number;
  rows: AuditRow[];
  status?: string;
}

export interface AttestBody {
  kiln_id: string;
  season: number;
  finding: FindingCode;
  evidence_hash: Hex;
  inspector: Hex;
  nonce: string;
  deadline: string;
  signature: Hex;
  revise?: boolean;
}

export interface DisputeBody {
  kiln_id: string;
  season: number;
  evidence_hash: Hex;
  note: string;
}

export interface RelayResult {
  tx?: Hex;
  explorer?: string | null;
  error?: string;
  mock?: boolean;
}
