// Typed client for the Bhatta API (docs/PRODUCT.md). With VITE_FIXTURE=1 every call is answered from
// src/fixtures/ (sample data, no network), and the UI shows a "Sample data" banner.

import type {
  AttestBody,
  Audit,
  DisputeBody,
  Health,
  KilnListItem,
  KilnRecord,
  Ledger,
  QueueItem,
  RelayResult,
  Results,
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

async function fixtures() {
  return (await import("./fixtures")).default;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText} for /api${path}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new ApiError(502, `The API did not answer /api${path} with JSON.`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { detail?: string; error?: string };
  if (!res.ok) throw new ApiError(res.status, data.detail ?? data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
};

export async function getHealth(): Promise<Health> {
  if (FIXTURE) return (await fixtures()).health;
  return get<Health>("/health");
}

export async function getSummary(): Promise<Summary> {
  if (FIXTURE) {
    await wait(120);
    return (await fixtures()).summary;
  }
  return get<Summary>("/summary");
}

export async function getKilns(filter: { status?: Status; district?: string } = {}): Promise<KilnListItem[]> {
  if (FIXTURE) {
    await wait(120);
    return (await fixtures()).kilns.filter(
      (k) => (!filter.status || k.status === filter.status) && (!filter.district || k.district === filter.district),
    );
  }
  return get<KilnListItem[]>(`/kilns${qs({ status: filter.status, district: filter.district })}`);
}

export async function getKiln(id: string): Promise<KilnRecord> {
  if (FIXTURE) {
    await wait(120);
    const rec = (await fixtures()).records[id];
    if (!rec) throw new ApiError(404, `No kiln with id ${id}`);
    return rec;
  }
  return get<KilnRecord>(`/kilns/${encodeURIComponent(id)}`);
}

/** URL of a chip image. The record carries "chips/<file>.png"; the API serves it at /api/chips/<file>. */
export function chipUrl(chip: string): string {
  const file = chip.replace(/^\/?chips\//, "");
  return FIXTURE ? `/fixtures/chips/${file}` : `/api/chips/${encodeURIComponent(file)}`;
}

export async function getQueue(district?: string): Promise<QueueItem[]> {
  if (FIXTURE) {
    await wait(120);
    const q = (await fixtures()).queue;
    return district ? q.filter((x) => x.district === district).map((x, i) => ({ ...x, rank: i + 1 })) : q;
  }
  return get<QueueItem[]>(`/inspect/queue${qs({ district })}`);
}

export async function getLedger(): Promise<Ledger> {
  if (FIXTURE) {
    await wait(120);
    return (await fixtures()).ledger;
  }
  return get<Ledger>("/ledger");
}

export async function getResults(): Promise<Results> {
  if (FIXTURE) return (await fixtures()).results;
  return get<Results>("/results");
}

export async function getAudit(): Promise<Audit> {
  if (FIXTURE) return (await fixtures()).audit;
  return get<Audit>("/audit");
}

export async function relayAttest(body: AttestBody): Promise<RelayResult> {
  if (FIXTURE) {
    await wait(600);
    return {
      mock: true,
      error: "Sample mode: no contract is deployed, so nothing was relayed.",
    };
  }
  return post<RelayResult>("/relay/attest", body);
}

export async function relayDispute(body: DisputeBody): Promise<RelayResult> {
  if (FIXTURE) {
    await wait(600);
    return { mock: true, error: "Sample mode: no contract is deployed, so nothing was relayed." };
  }
  return post<RelayResult>("/relay/dispute", body);
}
