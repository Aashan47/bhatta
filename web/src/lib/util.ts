import { useCallback, useEffect, useRef, useState } from "react";
import type { Strings } from "../i18n/en";
import type { ChainEvent, KilnClass, KilnRecord, Range, Status } from "../types";

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
}

/** Minimal data hook: runs fn when deps change, ignores stale responses. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({ loading: true });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fn().then(
      (data) => my === seq.current && setState({ data, loading: false }),
      (error: unknown) =>
        my === seq.current &&
        setState({ error: error instanceof Error ? error : new Error(String(error)), loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

export function seasonLabel(season: number, lang: string): string {
  const y = Math.floor(season / 100);
  const m = season % 100;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString(lang === "ur" ? "ur-PK" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function dateLabel(iso: string, lang: string, withTime = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === "ur" ? "ur-PK" : "en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Karachi" } : { timeZone: "UTC" }),
    numberingSystem: "latn",
  });
}

export function pctStr(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined) return "n/a";
  return `${(x * 100).toFixed(digits)}%`;
}

export function rangeStr(r: Range, digits = 0): string {
  const f = (x: number) => x.toLocaleString("en", { maximumFractionDigits: digits });
  return `${f(r.low)}–${f(r.high)}`;
}

/** The conformal set, explained in words. */
export function setInWords(t: Strings, status: Status, set: KilnClass[], alpha: number): string {
  if (status === "NOT_DETECTED") return t.set.notSeen;
  if (status === "UNDETERMINED" && set.length === 0) return t.set.noImage;
  if (set.length === 1) {
    const only = set[0]!;
    return t.set.only(1 - alpha, only === "Zigzag" ? t.status.ZIGZAG : t.status.FCBK);
  }
  if (set.length === 2) return t.set.both;
  return t.set.empty;
}

export type CertState = "certified" | "pending" | "contradicted";

export interface Certificate {
  state: CertState;
  missing: ("sat" | "proof" | "inspector")[];
  satelliteProven: boolean;
  lastFinding: number | null;
  inspector: string | null;
}

/** Certificate rule (product decision, 24 Oct 2026): a kiln is certified only by an inspector's signed
 *  "Zigzag confirmed" with no satellite contradiction (no satellite FCBK call, no Conflict) and no
 *  "FCBK found" finding outstanding. The satellite alone never certifies; it can only contradict. */
export function certificateFor(rec: KilnRecord): Certificate {
  const ev = sortEvents(rec.events);
  const latest = new Map<string, number>();
  let lastFinding: number | null = null;
  for (const e of ev) {
    if (e.type === "Finding" || e.type === "FindingRevised") {
      const f = Number(e.detail.finding);
      latest.set(String(e.detail.inspector ?? "?").toLowerCase(), f);
      lastFinding = f;
    }
  }
  const findings = [...latest.entries()];
  const confirmed = findings.filter(([, f]) => f === 1);
  const fcbkFound = findings.some(([, f]) => f === 2);
  const conflict = ev.some((e) => e.type === "Conflict");
  const proven = ev.some((e) => e.type === "SatelliteProven");
  const base = {
    satelliteProven: proven,
    lastFinding,
    inspector: confirmed.length ? confirmed[confirmed.length - 1]![0] : null,
  };
  if (conflict || fcbkFound || rec.status === "FCBK") return { state: "contradicted", missing: [], ...base };
  if (!confirmed.length) return { state: "pending", missing: ["inspector"], ...base };
  return { state: "certified", missing: [], ...base };
}

export function explorerTx(explorer: string, tx: string) {
  return `${explorer.replace(/\/$/, "")}/tx/${tx}`;
}
export function explorerAddress(explorer: string, a: string) {
  return `${explorer.replace(/\/$/, "")}/address/${a}`;
}

export function sortEvents(ev: ChainEvent[]): ChainEvent[] {
  return ev.slice().sort((a, b) => a.block - b.block);
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
