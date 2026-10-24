// Types for the API contract in docs/PRODUCT.md. Fields marked optional are ones the frontend can
// live without; it degrades and says what is missing.

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

export interface Impact {
  coal_t_per_season: Range;
  co2_t: Range;
  black_carbon_reduction_pct: Range;
  sources: Source[];
  sample?: boolean;
}

export interface ImpactSummary {
  per_kiln: Omit<Impact, "sources" | "sample">;
  total?: Omit<Impact, "sources" | "sample">;
  kilns?: number;
  basis?: string;
  sources: Source[];
  sample?: boolean;
}

export interface Health {
  ok: boolean;
  fixture: boolean;
  data_version: string;
  chain: { id: number; contract: Hex | null };
}

export interface Scene {
  id: string;
  date: string;
  cloud_pct?: number;
}

export interface Summary {
  fixture?: boolean;
  data_version?: string;
  season: number;
  counts: Record<Status, number>;
  total: number;
  aoi: { name: string; bbox: [number, number, number, number]; districts: string[] };
  scenes: Scene[];
  models: { detector_sha256?: string; classifier_sha256?: string };
  model_sha256?: Hex;
  alpha: number;
  qhat: number;
  claim: {
    quote: string;
    who: string;
    date: string;
    url: string;
    claimed_converted?: number;
    province_total?: number;
    province_total_source?: Source;
  };
  impact?: ImpactSummary;
}

export interface KilnListItem {
  id: string;
  lat: number;
  lon: number;
  district: string;
  status: Status;
  baseline_class: KilnClass;
}

export type EventType = "SeasonPublished" | "SatelliteProven" | "Finding" | "Conflict" | "Disputed";

export interface ChainEvent {
  type: EventType;
  tx: Hex;
  block: number;
  time: string;
  kiln_id?: string | null;
  season?: number;
  detail: Record<string, unknown>;
}

export interface KilnRecord {
  id: string;
  lat: number;
  lon: number;
  district: string;
  baseline: { source: string; period: string; class: KilnClass };
  observation: {
    scene_id: string;
    date: string;
    detected: boolean;
    det_conf: number | null;
    probs: { FCBK: number; Zigzag: number } | null;
    set: KilnClass[];
    chip: string;
    baseline_chip: string;
    chip_sha256?: Hex;
    model_sha256?: Hex;
  };
  status: Status;
  chain: {
    season: number;
    leaf: Hex;
    proof: Hex[];
    evidence_hash: Hex;
    status_code: number;
    p_zigzag_bp: number;
  };
  events: ChainEvent[];
  impact?: Impact | null;
}

export type ReasonCode = "CONFLICT" | "SAT_FCBK" | "UNDETERMINED" | "NOT_SEEN";

export interface QueueItem {
  rank: number;
  id: string;
  district: string;
  lat: number;
  lon: number;
  status: Status;
  baseline_class: KilnClass;
  p_zigzag: number | null;
  reason_code?: ReasonCode;
  reason: string;
}

export interface SeasonRoot {
  season: number;
  root: Hex;
  tx: Hex;
  model_hash: string;
  block?: number;
  time?: string;
  kilns?: number;
}

export interface Ledger {
  fixture?: boolean;
  mock_chain?: boolean;
  chain_id: number;
  chain_name?: string;
  contract: Hex | null;
  explorer: string;
  rpc?: string;
  abi?: unknown[];
  eip712?: { name: string; version: string };
  seasons: SeasonRoot[];
  events: ChainEvent[];
}

export interface ResultRow {
  id: string;
  metric: string;
  target: string;
  value: number | null;
  n?: number;
  hit: boolean | null;
  note?: string;
}

export interface Results {
  fixture?: boolean;
  split?: string;
  targets: ResultRow[];
  limits?: string[];
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
}

export interface DisputeBody {
  kiln_id: string;
  season: number;
  evidence_hash: Hex;
  note: string;
}

export interface RelayResult {
  tx?: Hex;
  error?: string;
  mock?: boolean;
}
