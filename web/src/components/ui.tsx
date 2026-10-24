import { useState, type ReactNode } from "react";
import { FIXTURE } from "../api";
import { useT } from "../i18n";
import { shortHex } from "../lib/chain";
import { explorerTx } from "../lib/util";
import type { Status } from "../types";

/** Status shapes are distinct as well as coloured: ring+tick, square+bang, triangle+?, dashed ring. */
export function StatusIcon({ status, size = 18 }: { status: Status; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": true, focusable: false } as const;
  switch (status) {
    case "ZIGZAG":
      return (
        <svg {...common} className="sicon sicon-zigzag">
          <circle cx="10" cy="10" r="8.5" fill="currentColor" />
          <path d="M5.8 10.4l2.8 2.8 5.6-6" fill="none" stroke="var(--icon-on, #fff)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "FCBK":
      return (
        <svg {...common} className="sicon sicon-fcbk">
          <rect x="2" y="2" width="16" height="16" rx="2.5" fill="currentColor" />
          <path d="M10 5.2v6.2" stroke="var(--icon-on, #fff)" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="10" cy="14.6" r="1.4" fill="var(--icon-on, #fff)" />
        </svg>
      );
    case "UNDETERMINED":
      return (
        <svg {...common} className="sicon sicon-undetermined">
          <path d="M10 1.8l8.6 15.4H1.4z" fill="currentColor" strokeLinejoin="round" />
          <path d="M7.9 8.6c0-1.3 1-2.2 2.2-2.2s2.2.9 2.2 2c0 1.6-2.1 1.7-2.1 3.3" fill="none" stroke="var(--icon-on, #fff)" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10.1" cy="14.4" r="1.15" fill="var(--icon-on, #fff)" />
        </svg>
      );
    case "NOT_DETECTED":
      return (
        <svg {...common} className="sicon sicon-notseen">
          <circle cx="10" cy="10" r="7.6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeDasharray="3.2 2.6" />
          <circle cx="10" cy="10" r="1.8" fill="currentColor" />
        </svg>
      );
  }
}

const STATUS_CLASS: Record<Status, string> = {
  ZIGZAG: "st-zigzag",
  FCBK: "st-fcbk",
  UNDETERMINED: "st-undetermined",
  NOT_DETECTED: "st-notseen",
};
export const statusClass = (s: Status) => STATUS_CLASS[s];

export function StatusBadge({ status, long = false, size = "m" }: { status: Status; long?: boolean; size?: "s" | "m" | "l" }) {
  const t = useT();
  return (
    <span className={`badge badge-${size} ${STATUS_CLASS[status]}`}>
      <StatusIcon status={status} size={size === "l" ? 24 : size === "s" ? 14 : 18} />
      <span>{long ? t.statusLong[status] : t.status[status]}</span>
    </span>
  );
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false" className="logo-mark">
      <rect x="0" y="0" width="48" height="48" rx="10" fill="var(--primary)" />
      <path
        d="M7 30 L14.5 18 L22 30 L29.5 18 L37 30 L41 23.6"
        fill="none"
        stroke="var(--on-primary)"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="35" y="7" width="5" height="10" rx="1" fill="var(--on-primary)" opacity="0.85" />
    </svg>
  );
}

export function ZigzagRule({ className = "" }: { className?: string }) {
  return <div className={`zz-rule ${className}`} role="presentation" />;
}

export function SampleBanner() {
  const t = useT();
  if (!FIXTURE) return null;
  return (
    <div className="sample-banner" role="note">
      <span className="sample-pill">{t.sample.badge}</span>
      <span>{t.sample.banner}</span>
    </div>
  );
}

export function SampleTag() {
  const t = useT();
  if (!FIXTURE) return null;
  return <span className="sample-tag">{t.sample.short}</span>;
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" dir="ltr" title={title}>
      {children}
    </code>
  );
}

export function Hash({ value, head = 6, tail = 4, copy = true }: { value: string; head?: number; tail?: number; copy?: boolean }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <span className="hash">
      <Mono title={value}>{shortHex(value, head, tail)}</Mono>
      {copy && (
        <button
          type="button"
          className="icon-btn"
          aria-label={`${done ? t.common.copied : t.common.copy} ${value}`}
          onClick={() => {
            navigator.clipboard?.writeText(value).then(
              () => {
                setDone(true);
                setTimeout(() => setDone(false), 1400);
              },
              () => undefined,
            );
          }}
        >
          {done ? <CheckGlyph /> : <CopyGlyph />}
        </button>
      )}
    </span>
  );
}

export function TxLink({ tx, explorer, sample }: { tx: string; explorer: string; sample?: boolean }) {
  const t = useT();
  if (FIXTURE || sample) {
    return (
      <span className="txlink is-sample" title={t.sample.txNote}>
        <Mono>{shortHex(tx)}</Mono>
        <span className="sample-tag">{t.sample.short}</span>
      </span>
    );
  }
  return (
    <a className="txlink" href={explorerTx(explorer, tx)} target="_blank" rel="noreferrer">
      <Mono>{shortHex(tx)}</Mono>
      <ExternalGlyph />
      <span className="sr-only">{t.common.viewOnExplorer}</span>
    </a>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useT();
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-zz" aria-hidden="true" />
      <span>{label ?? t.common.loading}</span>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const t = useT();
  const isNetwork = /fetch|JSON|502|504|ECONNREFUSED|NetworkError/i.test(error.message);
  return (
    <div className="error-box" role="alert">
      <h2>{t.common.errorTitle}</h2>
      <p>{isNetwork ? t.common.apiDown : error.message}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary" onClick={onRetry}>
          {t.common.retry}
        </button>
      )}
    </div>
  );
}

export function PageHeader({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
      {children}
      <ZigzagRule />
    </header>
  );
}

export const CopyGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M3 10.5V3.5A1 1 0 0 1 4 2.5h6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
export const CheckGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const CrossGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
export const ExternalGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="ext-glyph">
    <path d="M9 2.5h4.5V7M13.5 2.5L7 9M12 10v3.5H2.5V4H6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const ArrowGlyph = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="dir-flip">
    <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
