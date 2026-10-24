import { Link } from "react-router";
import qrcode from "qrcode-generator";
import { useEffect, useMemo, useState } from "react";
import { FIXTURE, getLedger } from "../api";
import { usePrefs } from "../i18n";
import { readCertificate, ZERO_HASH, type OnchainCertificate } from "../lib/chain";
import { certificateFor, dateLabel, sortEvents, type CertState } from "../lib/util";
import type { ChainEvent, EventType, KilnRecord, Ledger } from "../types";
import { ArrowGlyph, Hash, TxLink } from "./ui";

export const EV_CLASS: Record<EventType, string> = {
  SeasonPublished: "ev-season",
  SeasonConfirmed: "ev-season",
  SeasonActivated: "ev-season",
  CorrectionPublished: "ev-dispute",
  SatelliteProven: "ev-proven",
  Finding: "ev-finding",
  FindingRevised: "ev-finding",
  Conflict: "ev-conflict",
  Disputed: "ev-dispute",
  Certified: "ev-proven",
  CertificateWithdrawn: "ev-conflict",
  RpcError: "ev-conflict",
};

function EventGlyph({ type }: { type: EventType }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": true, focusable: false, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (type) {
    case "SeasonPublished":
    case "SeasonConfirmed":
    case "SeasonActivated":
      return (
        <svg {...p}>
          <path d="M8 2v4M4 6h8M5 6l-2 8h10l-2-8" />
        </svg>
      );
    case "SatelliteProven":
    case "Certified":
      return (
        <svg {...p}>
          <path d="M3 8.5l3 3L13 4.5" />
        </svg>
      );
    case "Finding":
    case "FindingRevised":
      return (
        <svg {...p}>
          <path d="M3 13c2-1 3-4 5-4s2 3 5 2M10.5 2.5l3 3-6 6H4.5v-3z" />
        </svg>
      );
    case "Disputed":
    case "CorrectionPublished":
      return (
        <svg {...p}>
          <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <path d="M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.8v.1" />
        </svg>
      );
  }
}

export function eventSummary(e: ChainEvent, t: ReturnType<typeof usePrefs>["t"]): string | null {
  const d = e.detail;
  if ((e.type === "Finding" || e.type === "FindingRevised") && d.finding !== undefined) return t.events.finding[Number(d.finding)] ?? null;
  if (e.type === "Conflict" && d.reasonCode !== undefined) return t.events.conflict[Number(d.reasonCode)] ?? null;
  if (e.type === "SatelliteProven" && d.status !== undefined) {
    const s = ["NOT_DETECTED", "FCBK", "ZIGZAG", "UNDETERMINED"][Number(d.status)] as keyof typeof t.status | undefined;
    return s ? t.status[s] : null;
  }
  if (e.type === "SeasonPublished" && typeof d.kilns === "number") return t.events.kilnCount(d.kilns);
  if (e.type === "CorrectionPublished" && typeof d.reason === "string") return d.reason;
  return null;
}

export function Timeline({ events, explorer, sample }: { events: ChainEvent[]; explorer: string; sample?: boolean }) {
  const { t, lang } = usePrefs();
  const ev = sortEvents(events.filter((e) => e.type !== "RpcError"));
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
              {typeof e.detail.note === "string" && e.detail.note && (
                <p className="tl-note">
                  <span className="muted">{t.events.noteLabel}: </span>
                  {e.detail.note}
                </p>
              )}
              <p className="tl-meta">
                {e.time && <time dateTime={e.time}>{dateLabel(e.time, lang, true)}</time>}
                {e.block > 0 && <span dir="ltr">{t.events.block(e.block)}</span>}
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
  const line = c.state === "certified" ? t.cert.certifiedLine : c.state === "contradicted" ? t.cert.contradictedLine : t.cert.pendingLine;
  return { c, word, line };
}

/** Reads certified() and certificateHash() from the contract when one is deployed. */
export function useOnchainCertificate(rec: KilnRecord): { ledger?: Ledger; cert?: OnchainCertificate; loading: boolean } {
  const [state, setState] = useState<{ ledger?: Ledger; cert?: OnchainCertificate; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const ledger = await getLedger();
        if (!live) return;
        if (FIXTURE || ledger.mock_chain || !ledger.contract || !rec.chain) {
          setState({ ledger, loading: false });
          return;
        }
        const cert = await readCertificate({ contract: ledger.contract, id: rec.id, season: rec.chain.season, rpc: ledger.rpc });
        if (live) setState({ ledger, cert, loading: false });
      } catch {
        if (live) setState((s) => ({ ...s, loading: false }));
      }
    })();
    return () => {
      live = false;
    };
  }, [rec.id, rec.chain]);
  return state;
}

export function CertificatePanel({ rec, printedHash }: { rec: KilnRecord; printedHash?: string | null }) {
  const { t } = usePrefs();
  const { c, line } = useCertText(rec);
  const onchain = useOnchainCertificate(rec);
  // The product rule decides the state. The contract's own flag is shown beside it, with a note when
  // the deployed contract is stricter (it also wants a satellite Zigzag record, which never exists).
  const state: CertState = c.state;
  const words: Record<CertState, string> = { certified: t.cert.certified, pending: t.cert.pending, contradicted: t.cert.contradicted };
  const shownLine = line;
  return (
    <section className={`panel cert-panel cert-${state}`} aria-labelledby="cert-h">
      <h2 id="cert-h" className="panel-title">
        {t.cert.title}
      </h2>
      <p className="cert-state">
        <CertIcon state={state} />
        <span>{words[state]}</span>
      </p>
      <p>{shownLine}</p>
      <div aria-live="polite">
        {onchain.loading && onchain.ledger?.contract && !FIXTURE && <p className="fine">{t.cert.onchainChecking}</p>}
        {onchain.cert && <p className="fine">{onchain.cert.certified ? t.cert.onchainYes : t.cert.onchainNo}</p>}
        {onchain.cert && !onchain.cert.certified && state === "certified" && <p className="fine">{t.cert.contractNote}</p>}
        {printedHash && onchain.cert && (
          <p className={`verdict ${onchain.cert.hash.toLowerCase() === printedHash.toLowerCase() && onchain.cert.hash !== ZERO_HASH ? "verdict-pass" : "verdict-fail"}`}>
            {onchain.cert.hash.toLowerCase() === printedHash.toLowerCase() && onchain.cert.hash !== ZERO_HASH ? t.cert.printedValid : t.cert.printedStale}
          </p>
        )}
      </div>
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
