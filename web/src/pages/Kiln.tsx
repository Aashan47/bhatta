import { useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, chipUrl, FIXTURE, getKiln, getLedger, getSummary } from "../api";
import { DisputeForm, SignFinding } from "../components/Actions";
import { ImpactPanel } from "../components/Impact";
import { CertificatePanel, Timeline } from "../components/Record";
import { ArrowGlyph, ErrorBox, Loading, Mono, SampleTag, StatusBadge, ZigzagRule, statusClass } from "../components/ui";
import { VerifyPanel } from "../components/Verify";
import { usePrefs } from "../i18n";
import { dateLabel, setInWords, useAsync } from "../lib/util";
import type { KilnClass, KilnRecord } from "../types";

export function Kiln() {
  const { id = "" } = useParams();
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
            <Timeline events={r.events} explorer={ledger.data?.explorer ?? "https://sepolia.etherscan.io"} sample={FIXTURE || ledger.data?.mock_chain} />
          </section>
        </div>
        <aside className="kiln-side">
          <CertificatePanel rec={r} />
          <VerifyPanel rec={r} modelSha={summary.data?.model_sha256} />
          <ActionPanels rec={r} />
          {r.impact && (
            <ImpactPanel
              title={t.impact.perKilnTitle}
              lead={t.impact.perKilnLead}
              figures={r.impact}
              sources={r.impact.sources}
              sample={r.impact.sample}
            />
          )}
        </aside>
      </div>
    </article>
  );
}

function Chips({ rec }: { rec: KilnRecord }) {
  const { t, lang } = usePrefs();
  const o = rec.observation;
  const sampleAlt = FIXTURE ? ` ${t.kiln.chipSampleAlt}` : "";
  return (
    <section className="panel" aria-labelledby="chips-h">
      <h2 id="chips-h" className="panel-title">
        {t.kiln.imagesTitle}
      </h2>
      <div className="chips">
        <figure className="chip">
          <div className="chip-frame">
            <img src={chipUrl(o.baseline_chip)} alt={t.kiln.chipAltBase(rec.id, rec.baseline.class) + sampleAlt} width={256} height={256} loading="lazy" />
            {FIXTURE && <span className="chip-sample">{t.sample.badge}</span>}
          </div>
          <figcaption>{t.kiln.baselineChip(rec.baseline.period, t.className[rec.baseline.class])}</figcaption>
        </figure>
        <figure className="chip">
          <div className="chip-frame">
            <img src={chipUrl(o.chip)} alt={t.kiln.chipAltNow(rec.id, o.date, t.status[rec.status]) + sampleAlt} width={256} height={256} loading="lazy" />
            {FIXTURE && <span className="chip-sample">{t.sample.badge}</span>}
          </div>
          <figcaption>
            {t.kiln.nowChip(dateLabel(o.date, lang))} <Mono>{o.scene_id}</Mono>
          </figcaption>
        </figure>
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
      {!o.detected || !o.probs ? (
        <p>{t.kiln.notDetected}</p>
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
                  <span className="sr-only">{kept ? "kept" : "excluded"}</span>
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

function ActionPanels({ rec }: { rec: KilnRecord }) {
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
          {open === "sign" && <SignFinding rec={rec} />}
        </div>
      </div>
      <div className="disclosure">
        <button type="button" className="disc-btn" aria-expanded={open === "dispute"} aria-controls="act-dispute" onClick={() => setOpen(open === "dispute" ? null : "dispute")}>
          <span>{t.kiln.dispute}</span>
          <span className="disc-caret" aria-hidden="true" />
        </button>
        <div id="act-dispute" hidden={open !== "dispute"}>
          {open === "dispute" && <DisputeForm rec={rec} />}
        </div>
      </div>
    </section>
  );
}
