import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, chipUrl, FIXTURE, getKiln, getLedger, getSummary } from "../api";
import { DisputeForm, SignFinding } from "../components/Actions";
import { ImpactPanel } from "../components/Impact";
import { CertificatePanel, Timeline } from "../components/Record";
import { ArrowGlyph, ErrorBox, Loading, Mono, SampleTag, StatusBadge, ZigzagRule, statusClass } from "../components/ui";
import { VerifyPanel } from "../components/Verify";
import { usePrefs } from "../i18n";
import { dateLabel, setInWords, useAsync } from "../lib/util";
import type { KilnClass, KilnRecord } from "../types";

function seasonOf(rec: KilnRecord, fallback: number | null | undefined): number {
  if (rec.chain) return rec.chain.season;
  const m = rec.observation.date ? /^(\d{4})-(\d{2})/.exec(rec.observation.date) : null;
  if (m) return Number(m[1]) * 100 + Number(m[2]);
  return fallback ?? 202610;
}

export function Kiln() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const { t } = usePrefs();
  const rec = useAsync(() => getKiln(id), [id]);
  const summary = useAsync(getSummary, []);
  const ledger = useAsync(getLedger, []);

  if (rec.error) {
    if (rec.error instanceof ApiError && rec.error.status === 404)
      return (
        <div className="notfound">
          <h1>{t.kiln.titleFor(id)}</h1>
          <p>{t.kiln.notFound}</p>
          <Link to="/map" className="btn btn-primary">
            {t.nav.map}
          </Link>
        </div>
      );
    return <ErrorBox error={rec.error} onRetry={rec.reload} />;
  }
  const r = rec.data;
  if (!r) return <Loading />;
  const alpha = summary.data?.alpha ?? 0.1;
  const qhat = summary.data?.qhat;
  const season = seasonOf(r, summary.data?.season);
  const modelSha = summary.data?.model_sha256;
  const impactLead = r.status === "ZIGZAG" ? t.impact.leadZigzag : t.impact.leadKiln;
  const showImpact = r.status !== "NOT_DETECTED";

  return (
    <article className="kiln">
      <nav className="crumbs" aria-label={t.common.back}>
        <Link to={`/map?kiln=${r.id}`} className="link-back">
          <ArrowGlyph />
          {t.nav.map}
        </Link>
      </nav>

      <header className={`kiln-head ${statusClass(r.status)}`}>
        <div className="kiln-id">
          <h1>
            <span className="sr-only">{t.map.drawerTitle} </span>
            <Mono>{r.id}</Mono>
          </h1>
          <p className="muted">
            {t.kiln.location(r.district, r.lat, r.lon)} <SampleTag />
          </p>
          {!r.baseline && <p className="new-det">{t.kiln.newDetection}</p>}
        </div>
        <StatusBadge status={r.status} long size="l" />
        <p className="set-words set-words-l">{setInWords(t, r.status, r.observation.set, alpha)}</p>
      </header>

      <ZigzagRule />

      <div className="kiln-grid">
        <div className="kiln-main">
          <Chips rec={r} />
          <Model rec={r} qhat={qhat} />
          <section className="panel" aria-labelledby="tl-h">
            <h2 id="tl-h" className="panel-title">
              {t.kiln.timelineTitle}
            </h2>
            <Timeline events={r.events} explorer={ledger.data?.explorer ?? ""} sample={FIXTURE || ledger.data?.mock_chain} />
          </section>
        </div>
        <aside className="kiln-side">
          <CertificatePanel rec={r} printedHash={params.get("cert")} />
          <VerifyPanel rec={r} modelSha={modelSha} />
          <ActionPanels rec={r} season={season} />
          {showImpact && <ImpactPanel title={t.impact.perKilnTitle} lead={impactLead} impact={summary.data?.impact} />}
        </aside>
      </div>
    </article>
  );
}

function ChipFigure({ src, alt, caption, empty }: { src: string | null; alt: string; caption: React.ReactNode; empty: string }) {
  const t = usePrefs().t;
  const [broken, setBroken] = useState(false);
  return (
    <figure className="chip">
      <div className="chip-frame">
        {src && !broken ? (
          <img src={chipUrl(src)} alt={alt} width={256} height={256} loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <p className="chip-empty">{empty}</p>
        )}
        {FIXTURE && src && <span className="chip-sample">{t.sample.badge}</span>}
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Chips({ rec }: { rec: KilnRecord }) {
  const { t, lang } = usePrefs();
  const o = rec.observation;
  const sampleAlt = FIXTURE ? ` ${t.kiln.chipSampleAlt}` : "";
  const cls = rec.baseline ? t.className[rec.baseline.class] : "";
  return (
    <section className="panel" aria-labelledby="chips-h">
      <h2 id="chips-h" className="panel-title">
        {t.kiln.imagesTitle}
      </h2>
      <div className="chips">
        <ChipFigure
          src={o.baseline_chip}
          alt={t.kiln.chipAltBase(rec.id, cls) + sampleAlt}
          empty={t.kiln.noBaselineChip}
          caption={rec.baseline ? t.kiln.baselineChip(rec.baseline.period, cls) : t.kiln.newDetection}
        />
        <ChipFigure
          src={o.chip}
          alt={t.kiln.chipAltNow(rec.id, o.date ?? "", t.status[rec.status]) + sampleAlt}
          empty={t.kiln.noChip}
          caption={
            <>
              {o.date ? t.kiln.nowChip(dateLabel(o.date, lang)) : null} {o.scene_id && <Mono>{o.scene_id}</Mono>}
            </>
          }
        />
      </div>
      <p className="fine">{t.kiln.chipNote}</p>
    </section>
  );
}

function Model({ rec, qhat }: { rec: KilnRecord; qhat?: number }) {
  const { t } = usePrefs();
  const o = rec.observation;
  const classes: KilnClass[] = ["FCBK", "Zigzag"];
  return (
    <section className="panel" aria-labelledby="model-h">
      <h2 id="model-h" className="panel-title">
        {t.kiln.modelTitle} <SampleTag />
      </h2>
      {!o.probs ? (
        <p>{rec.status === "NOT_DETECTED" ? t.kiln.notDetected : t.set.noImage}</p>
      ) : (
        <>
          {o.det_conf != null && <p className="muted">{t.kiln.detConf(o.det_conf)}</p>}
          <h3 className="sub">{t.kiln.probs}</h3>
          <div className="probbar" role="img" aria-label={`FCBK ${(o.probs.FCBK * 100).toFixed(1)}%, Zigzag ${(o.probs.Zigzag * 100).toFixed(1)}%`}>
            <span className="pb-fcbk" style={{ inlineSize: `${o.probs.FCBK * 100}%` }} />
            <span className="pb-zig" style={{ inlineSize: `${o.probs.Zigzag * 100}%` }} />
          </div>
          <div className="problabels" aria-hidden="true">
            <span className="st-fcbk">
              {t.status.FCBK} <b dir="ltr">{(o.probs.FCBK * 100).toFixed(1)}%</b>
            </span>
            <span className="st-zigzag">
              {t.status.ZIGZAG} <b dir="ltr">{(o.probs.Zigzag * 100).toFixed(1)}%</b>
            </span>
          </div>
          <h3 className="sub">{t.kiln.setTitle}</h3>
          <ul className="setpills" aria-label={t.kiln.setTitle}>
            {classes.map((c) => {
              const kept = o.set.includes(c);
              return (
                <li key={c} className={`setpill ${kept ? "kept" : "dropped"} ${c === "FCBK" ? "st-fcbk" : "st-zigzag"}`}>
                  <span aria-hidden="true">{kept ? "✓" : "✗"}</span>
                  <span>{t.className[c]}</span>
                  <span className="sr-only">{kept ? t.kiln.kept : t.kiln.excluded}</span>
                </li>
              );
            })}
          </ul>
          {qhat !== undefined && <p className="fine">{t.kiln.setExplain(qhat)}</p>}
        </>
      )}
    </section>
  );
}

function ActionPanels({ rec, season }: { rec: KilnRecord; season: number }) {
  const { t } = usePrefs();
  const [open, setOpen] = useState<"sign" | "dispute" | null>(null);
  return (
    <section className="panel actions" aria-labelledby="act-h">
      <h2 id="act-h" className="panel-title">
        {t.kiln.actionsTitle}
      </h2>
      <div className="disclosure">
        <button type="button" className="disc-btn" aria-expanded={open === "sign"} aria-controls="act-sign" onClick={() => setOpen(open === "sign" ? null : "sign")}>
          <span>{t.kiln.sign}</span>
          <span className="disc-caret" aria-hidden="true" />
        </button>
        <div id="act-sign" hidden={open !== "sign"}>
          {open === "sign" && <SignFinding rec={rec} season={season} />}
        </div>
      </div>
      <div className="disclosure">
        <button type="button" className="disc-btn" aria-expanded={open === "dispute"} aria-controls="act-dispute" onClick={() => setOpen(open === "dispute" ? null : "dispute")}>
          <span>{t.kiln.dispute}</span>
          <span className="disc-caret" aria-hidden="true" />
        </button>
        <div id="act-dispute" hidden={open !== "dispute"}>
          {open === "dispute" && <DisputeForm rec={rec} season={season} />}
        </div>
      </div>
    </section>
  );
}
