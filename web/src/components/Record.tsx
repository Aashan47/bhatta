import { Link } from "react-router";
import qrcode from "qrcode-generator";
import { useMemo } from "react";
import { usePrefs } from "../i18n";
import { certificateFor, dateLabel, sortEvents, type CertState } from "../lib/util";
import type { ChainEvent, EventType, KilnRecord } from "../types";
import { ArrowGlyph, Hash, TxLink } from "./ui";

const EV_CLASS: Record<EventType, string> = {
  SeasonPublished: "ev-season",
  SatelliteProven: "ev-proven",
  Finding: "ev-finding",
  Conflict: "ev-conflict",
  Disputed: "ev-dispute",
};

function EventGlyph({ type }: { type: EventType }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": true, focusable: false, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (type) {
    case "SeasonPublished":
      return (
        <svg {...p}>
          <path d="M8 2v4M4 6h8M5 6l-2 8h10l-2-8" />
        </svg>
      );
    case "SatelliteProven":
      return (
        <svg {...p}>
          <path d="M3 8.5l3 3L13 4.5" />
        </svg>
      );
    case "Finding":
      return (
        <svg {...p}>
          <path d="M3 13c2-1 3-4 5-4s2 3 5 2M10.5 2.5l3 3-6 6H4.5v-3z" />
        </svg>
      );
    case "Conflict":
      return (
        <svg {...p}>
          <path d="M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.8v.1" />
        </svg>
      );
    case "Disputed":
      return (
        <svg {...p}>
          <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        </svg>
      );
  }
}

export function eventSummary(e: ChainEvent, t: ReturnType<typeof usePrefs>["t"]): string | null {
  const d = e.detail;
  if (e.type === "Finding" && d.finding !== undefined) return t.events.finding[Number(d.finding)] ?? null;
  if (e.type === "Conflict" && d.finding !== undefined) return `${t.status.FCBK} / ${t.events.finding[Number(d.finding)] ?? ""}`;
  if (e.type === "SeasonPublished" && typeof d.kilns === "number") return t.events.kilnCount(d.kilns);
  return null;
}

export function Timeline({ events, explorer, sample }: { events: ChainEvent[]; explorer: string; sample?: boolean }) {
  const { t, lang } = usePrefs();
  const ev = sortEvents(events);
  if (!ev.length) return <p className="muted">{t.kiln.timelineEmpty}</p>;
  return (
    <ol className="timeline">
      {ev.map((e, i) => {
        const sum = eventSummary(e, t);
        const who = (e.detail.inspector ?? e.detail.by) as string | undefined;
        return (
          <li key={i} className={`tl-item ${EV_CLASS[e.type]}`}>
            <span className="tl-dot" aria-hidden="true">
              <EventGlyph type={e.type} />
            </span>
            <div className="tl-body">
              <p className="tl-title">
                {t.events[e.type]}
                {sum && <span className="tl-sum">{sum}</span>}
              </p>
              {typeof e.detail.note === "string" && (
                <p className="tl-note">
                  <span className="muted">{t.events.noteLabel}: </span>
                  {e.detail.note}
                </p>
              )}
              <p className="tl-meta">
                <time dateTime={e.time}>{dateLabel(e.time, lang, true)}</time>
                <span dir="ltr">{t.events.block(e.block)}</span>
                {who && (
                  <span>
                    {t.events.by("")}
                    <Hash value={who} copy={false} />
                  </span>
                )}
                <TxLink tx={e.tx} explorer={explorer} sample={sample} />
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function CertIcon({ state, size = 28 }: { state: CertState; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 28 28", "aria-hidden": true, focusable: false } as const;
  if (state === "certified")
    return (
      <svg {...p} className="cert-icon cert-ok">
        <path d="M14 2l3 2.6 4-.4 1.2 3.8 3.4 2.2-1.4 3.8 1.4 3.8-3.4 2.2-1.2 3.8-4-.4L14 26l-3-2.6-4 .4-1.2-3.8-3.4-2.2L3.8 14 2.4 10.2l3.4-2.2L7 4.2l4 .4z" fill="currentColor" />
        <path d="M9.2 14.2l3.2 3.2 6.4-6.8" fill="none" stroke="var(--page)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (state === "contradicted")
    return (
      <svg {...p} className="cert-icon cert-bad">
        <rect x="3" y="3" width="22" height="22" rx="4" fill="currentColor" />
        <path d="M9.5 9.5l9 9M18.5 9.5l-9 9" stroke="var(--page)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg {...p} className="cert-icon cert-pending">
      <circle cx="14" cy="14" r="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeDasharray="4 3" />
      <path d="M14 8.5V14l3.5 2.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function useCertText(rec: KilnRecord) {
  const { t } = usePrefs();
  const c = useMemo(() => certificateFor(rec), [rec]);
  const word = c.state === "certified" ? t.cert.certified : c.state === "contradicted" ? t.cert.contradicted : t.cert.pending;
  const missingWords = c.missing.map((m) => (m === "sat" ? t.cert.missingSat : m === "proof" ? t.cert.missingProof : t.cert.missingInspector));
  const line = c.state === "certified" ? t.cert.certifiedLine : c.state === "contradicted" ? t.cert.contradictedLine : t.cert.pendingLine(missingWords);
  return { c, word, line };
}

export function CertificatePanel({ rec }: { rec: KilnRecord }) {
  const { t } = usePrefs();
  const { c, word, line } = useCertText(rec);
  return (
    <section className={`panel cert-panel cert-${c.state}`} aria-labelledby="cert-h">
      <h2 id="cert-h" className="panel-title">
        {t.cert.title}
      </h2>
      <p className="cert-state">
        <CertIcon state={c.state} />
        <span>{word}</span>
      </p>
      <p>{line}</p>
      <Link to={`/kiln/${rec.id}/certificate`} className="link-arrow">
        {t.cert.open}
        <ArrowGlyph />
      </Link>
    </section>
  );
}

/** QR code rendered locally as SVG (qrcode-generator, no network). */
export function QR({ text, size = 140, label }: { text: string; size?: number; label: string }) {
  const { cells, n } = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    const count = q.getModuleCount();
    const out: string[] = [];
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) out.push(`M${c + 4} ${r + 4}h1v1h-1z`);
    return { cells: out.join(""), n: count };
  }, [text]);
  const dim = n + 8;
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={dim} height={dim} fill="#fff" />
      <path d={cells} fill="#000" />
    </svg>
  );
}

