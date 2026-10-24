import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { FIXTURE, getKilns, getQueue } from "../api";
import { ErrorBox, Loading, Mono, PageHeader, SampleTag, StatusBadge } from "../components/ui";
import { usePrefs } from "../i18n";
import { useAsync } from "../lib/util";
import type { QueueItem, ReasonCode } from "../types";

function reasonCode(q: QueueItem): ReasonCode {
  if (q.reason_code) return q.reason_code;
  if (q.status === "FCBK") return "SAT_FCBK";
  if (q.status === "UNDETERMINED") return "UNDETERMINED";
  if (q.status === "ZIGZAG") return "SAT_ZIGZAG";
  return "NOT_SEEN";
}

function csvCell(v: string | number | null): string {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(items: QueueItem[], district: string) {
  const head = ["visit_order", "kiln_id", "district", "lat", "lon", "status", "baseline_2023_24", "p_zigzag", "reason", "record_url"];
  const rows = items.map((q) => [
    q.rank,
    q.id,
    q.district,
    q.lat,
    q.lon,
    q.status,
    q.baseline_class,
    q.p_zigzag === null ? "" : q.p_zigzag.toFixed(4),
    q.reason,
    `${window.location.origin}/kiln/${q.id}`,
  ]);
  const lines = [head, ...rows].map((r) => r.map(csvCell).join(","));
  if (FIXTURE) lines.unshift("# SAMPLE DATA: generated fixtures, not measurements");
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bhatta-inspection-queue${district ? "-" + district.toLowerCase().replace(/\s+/g, "-") : ""}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function Inspect() {
  const { t } = usePrefs();
  const [params, setParams] = useSearchParams();
  const district = params.get("district") ?? "";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const queue = useAsync(() => getQueue(district || undefined), [district]);
  const kilns = useAsync(() => getKilns(), []);
  const districts = useMemo(() => [...new Set((kilns.data ?? []).map((k) => k.district))].sort(), [kilns.data]);

  const total = queue.data?.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const current = Math.min(page, pages);
  const pageItems = useMemo(() => (queue.data ?? []).slice((current - 1) * PAGE, current * PAGE), [queue.data, current]);
  const goto = (p: number) => {
    const next = new URLSearchParams(params);
    if (p > 1) next.set("page", String(p));
    else next.delete("page");
    setParams(next);
    document.getElementById("queue-top")?.scrollIntoView({ block: "start" });
  };

  const groupTotals = useMemo(() => {
    const m = new Map<ReasonCode, number>();
    for (const q of queue.data ?? []) m.set(reasonCode(q), (m.get(reasonCode(q)) ?? 0) + 1);
    return m;
  }, [queue.data]);

  const groups = useMemo(() => {
    const order: ReasonCode[] = ["CONFLICT", "SAT_FCBK", "UNDETERMINED", "NOT_SEEN", "SAT_ZIGZAG"];
    const by = new Map<ReasonCode, QueueItem[]>();
    for (const q of pageItems) {
      const c = reasonCode(q);
      by.set(c, [...(by.get(c) ?? []), q]);
    }
    return order.filter((c) => by.has(c)).map((c) => ({ code: c, items: by.get(c)! }));
  }, [pageItems]);

  return (
    <div className="inspect">
      <PageHeader title={t.inspect.title} lead={t.inspect.lead} />
      <div className="toolbar">
        <label className="field-inline">
          <span>{t.common.district}</span>
          <select
            value={district}
            onChange={(e) => {
              const p = new URLSearchParams(params);
              if (e.target.value) p.set("district", e.target.value);
              else p.delete("district");
              p.delete("page");
              setParams(p, { replace: true });
            }}
          >
            <option value="">{t.common.allDistricts}</option>
            {districts.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <div className="toolbar-end">
          <button type="button" className="btn btn-primary" disabled={!queue.data?.length} onClick={() => queue.data && downloadCsv(queue.data, district)}>
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 2v8M4.5 6.8L8 10.3l3.5-3.5M2.5 13.5h11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t.inspect.export}
          </button>
          <p className="fine">{t.inspect.exportNote}</p>
          {pages > 1 && <p className="fine">{t.inspect.csvAll}</p>}
        </div>
      </div>

      {queue.error ? (
        <ErrorBox error={queue.error} onRetry={queue.reload} />
      ) : !queue.data ? (
        <Loading />
      ) : queue.data.length === 0 ? (
        <p className="empty">{t.inspect.empty}</p>
      ) : (
        <>
          <p className="count-line" id="queue-top" aria-live="polite">
            {t.inspect.count(queue.data.length)} <SampleTag />
          </p>
          {pages > 1 && <Pager current={current} pages={pages} total={total} goto={goto} />}
          {groups.map((g) => (
            <section key={g.code} className={`q-group q-${g.code}`} aria-labelledby={`g-${g.code}`}>
              <h2 id={`g-${g.code}`} className="q-group-title">
                {t.inspect.groups[g.code]} <span className="q-group-n">{(groupTotals.get(g.code) ?? g.items.length).toLocaleString("en")}</span>
              </h2>
              <ol className="q-list">
                {g.items.map((q) => {
                  const p = q.p_zigzag === null ? "n/a" : `\u2066${(q.p_zigzag * 100).toFixed(1)}%\u2069`;
                  return (
                    <li key={q.id} className="q-item">
                      <span className="q-rank" aria-label={`${t.inspect.rank} ${q.rank}`}>
                        {q.rank}
                      </span>
                      <div className="q-main">
                        <div className="q-top">
                          <Link to={`/kiln/${q.id}`} className="q-id">
                            <Mono>{q.id}</Mono>
                          </Link>
                          <span className="q-district">{q.district}</span>
                          <StatusBadge status={q.status} size="s" />
                        </div>
                        <p className="q-reason">{t.inspect.reasons[reasonCode(q)](p)}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
          {pages > 1 && <Pager current={current} pages={pages} total={total} goto={goto} />}
        </>
      )}
    </div>
  );
}

const PAGE = 100;

function Pager({ current, pages, total, goto }: { current: number; pages: number; total: number; goto: (p: number) => void }) {
  const { t } = usePrefs();
  const a = (current - 1) * PAGE + 1;
  const b = Math.min(total, current * PAGE);
  return (
    <nav className="pager" aria-label={t.inspect.pages}>
      <button type="button" className="btn btn-secondary" disabled={current <= 1} onClick={() => goto(current - 1)}>
        {t.inspect.prev}
      </button>
      <span className="pager-info" aria-live="polite">
        {t.inspect.pageOf(a, b, total)}
      </span>
      <button type="button" className="btn btn-secondary" disabled={current >= pages} onClick={() => goto(current + 1)}>
        {t.inspect.next}
      </button>
    </nav>
  );
}
