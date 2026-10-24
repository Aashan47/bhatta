import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { getKilns, getLedger, getSummary } from "../api";
import { BrickWall, brickScale } from "../components/BrickWall";
import { ImpactPanel } from "../components/Impact";
import { KilnExplainer } from "../components/KilnExplainer";
import { MapView } from "../components/MapView";
import { ArrowGlyph, ErrorBox, ExternalGlyph, Hash, Loading, SampleTag, StatusIcon, ZigzagRule, statusClass } from "../components/ui";
import { usePrefs } from "../i18n";
import { dateLabel, seasonLabel, useAsync } from "../lib/util";
import { usePFcbk } from "../lib/heights";
import { STATUS_ORDER } from "../types";

const pctOf = (x: number) => `\u2066${Math.round(x * 100)}%\u2069`;

export function Overview() {
  const { t, lang } = usePrefs();
  const nav = useNavigate();
  const summary = useAsync(getSummary, []);
  const kilns = useAsync(() => getKilns(), []);
  const ledger = useAsync(getLedger, []);
  const [threeD, setThreeD] = useState(false);
  const pFcbk = usePFcbk(threeD && !(kilns.data ?? []).some((k) => k.p_fcbk != null));
  const s = summary.data;

  const shares = useMemo(() => {
    if (!s) return null;
    const claimed = s.claim.province_total && s.claim.claimed_converted ? s.claim.claimed_converted / s.claim.province_total : null;
    const pct = (n: number) => (s.total ? Math.round((n / s.total) * 100) : 0);
    return { claimed, fcbk: pct(s.counts.FCBK), refused: pct(s.counts.UNDETERMINED) };
  }, [s]);

  if (summary.error) return <ErrorBox error={summary.error} onRetry={summary.reload} />;
  if (!s) return <Loading />;

  const seasonNum = s.season ?? ledger.data?.seasons[0]?.season ?? null;
  const season = seasonNum ? seasonLabel(seasonNum, lang) : "";
  const areaName = s.aoi.name || [...new Set((kilns.data ?? []).map((k) => k.district).filter(Boolean))].sort().join(", ");
  const scale = brickScale(s.counts);
  const isoDates = [...new Set(s.scenes.map((x) => x.date).filter(Boolean))].sort();
  const sceneDates =
    isoDates.length > 3
      ? t.overview.dateRange(dateLabel(isoDates[0]!, lang), dateLabel(isoDates[isoDates.length - 1]!, lang))
      : isoDates.map((d) => dateLabel(d, lang)).join(", ");

  return (
    <div className="overview">
      <section className="hero" aria-labelledby="claim-h">
        <div className="hero-claim">
          <h1 id="claim-h" className="eyebrowless">
            <span className="claim-label">{t.overview.claimLabel}</span>
            <q className="claim-quote" lang="en" dir="ltr">
              {s.claim.quote}
            </q>
          </h1>
          <p className="claim-who">
            {s.claim.date ? t.overview.claimWho("\u2068" + s.claim.who + "\u2069", dateLabel(s.claim.date, lang)) : s.claim.who}.{" "}
            <a href={s.claim.url} target="_blank" rel="noreferrer">
              {t.overview.readSource}
              <ExternalGlyph />
            </a>
          </p>
        </div>

        <div className="hero-seen">
          <h2 className="seen-title">
            {season ? t.overview.seenTitle(season) : t.overview.seenTitleNoSeason} <SampleTag />
          </h2>
          <p className="seen-lead">{t.overview.seenLead(s.total, "\u2068" + areaName + "\u2069")}</p>
          <figure className="wall-fig">
            <BrickWall counts={s.counts} scale={scale} cols={20} />
            <figcaption className="fine">{t.overview.wallCaption(scale)}</figcaption>
          </figure>
          <ul className="tally" aria-label={t.common.status}>
            {STATUS_ORDER.map((st) => (
              <li key={st} className={`tally-row ${statusClass(st)}`}>
                <Link to={`/map?status=${st}`} className="tally-link">
                  <StatusIcon status={st} size={20} />
                  <span className="tally-word">
                    {t.statusLong[st]}
                    {st === "ZIGZAG" && <span className="tally-sub">{t.overview.zigzagNever}</span>}
                  </span>
                  <span className="tally-n" dir="ltr">
                    {s.counts[st].toLocaleString("en")}
                  </span>
                  <span className="tally-pct" dir="ltr">
                    {s.total ? Math.round((s.counts[st] / s.total) * 100) : 0}%
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <KilnExplainer impact={s.impact} />

      <div className="overview-pair">
      <section className="compare panel" aria-labelledby="cmp-h">
        <h2 id="cmp-h" className="panel-title">
          {t.overview.compareTitle}
        </h2>
        {shares?.claimed != null && (
          <div className="cmp-row">
            <span className="cmp-label">{t.overview.cmpClaim}</span>
            <span className="cmp-bar" aria-hidden="true">
              <span className="cmp-fill cmp-claim" style={{ inlineSize: `${shares.claimed * 100}%` }} />
            </span>
            <span className="cmp-val">{t.overview.cmpClaimVal(pctOf(shares.claimed))}</span>
          </div>
        )}
        <div className="cmp-row">
          <span className="cmp-label">
            {t.overview.cmpFcbk} <SampleTag />
          </span>
          <span className="cmp-bar" aria-hidden="true">
            <span className="cmp-fill cmp-fcbk" style={{ inlineSize: `${shares?.fcbk ?? 0}%` }} />
          </span>
          <span className="cmp-val">{t.overview.cmpFcbkVal(`\u2066${shares?.fcbk ?? 0}%\u2069`)}</span>
        </div>
        <div className="cmp-row">
          <span className="cmp-label">
            {t.overview.cmpRefused} <SampleTag />
          </span>
          <span className="cmp-bar" aria-hidden="true">
            <span className="cmp-fill cmp-refused" style={{ inlineSize: `${shares?.refused ?? 0}%` }} />
          </span>
          <span className="cmp-val">{t.overview.cmpRefusedVal(`\u2066${shares?.refused ?? 0}%\u2069`)}</span>
        </div>
        <p className="limit-sentence">{t.overview.limitSentence}</p>
        {shares?.claimed != null && (
          <p className="fine">
            {t.overview.claimShare(pctOf(shares.claimed))}{" "}
            {s.claim.province_total_source && (
              <a href={s.claim.province_total_source.url} target="_blank" rel="noreferrer">
                {s.claim.province_total_source.title}
                <ExternalGlyph />
              </a>
            )}
          </p>
        )}
        <p className="fine">{t.overview.compareNote}</p>
      </section>

      <div className="cannot-see">
        <p>{t.overview.cannotSee}</p>
        {s.caveats.length > 0 && (
          <ul className="caveats" lang="en" dir="ltr">
            {s.caveats.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        )}
      </div>
      </div>

      <section className="queue-cta" aria-labelledby="q-h">
        <div>
          <h2 id="q-h">
            {s.counts.FCBK > 0 ? t.overview.queueContradict(s.counts.FCBK) : t.overview.queueNoContradict}
            {s.counts.UNDETERMINED > 0 && <span className="q-more">{t.overview.queueUndecided(s.counts.UNDETERMINED)}</span>}
          </h2>
        </div>
        <Link to="/inspect" className="btn btn-primary">
          {t.overview.queueCta}
          <ArrowGlyph />
        </Link>
      </section>

      <ZigzagRule />

      <div className="overview-grid">
        <section aria-labelledby="map-h" className="overview-map">
          <div className="section-head">
            <h2 id="map-h">{t.overview.mapTitle}</h2>
            <span className="section-tools">
              <button type="button" className={`toggle toggle-s ${threeD ? "is-on" : ""}`} aria-pressed={threeD} onClick={() => setThreeD((v) => !v)}>
                <span className="toggle-dot" aria-hidden="true" />
                {t.map.threeD}
              </button>
              <Link to="/map" className="link-arrow">
                {t.overview.openMap}
                <ArrowGlyph />
              </Link>
            </span>
          </div>
          <MapView
            kilns={kilns.data ?? []}
            bbox={s.aoi.bbox}
            label={t.map.mapLabel}
            compact
            className="map-compact"
            onSelect={(id) => nav(`/kiln/${id}`)}
            threeD={threeD}
            pFcbk={pFcbk}
          />
        </section>

        <ImpactPanel title={t.impact.title} lead={t.impact.leadAll} impact={s.impact} />
      </div>

      <section className="provenance" aria-label={t.overview.modelsLine}>
        {s.scenes.length > 0 && (
          <p>
            {t.overview.sceneLine(s.scenes.length, sceneDates)} <SampleTag />
          </p>
        )}
        {s.models.classifier_sha256 && (
          <p>
            {t.overview.modelsLine}: <Hash value={s.models.classifier_sha256} />
            {s.models.detector_sha256 && (
              <>
                {" "}
                <Hash value={s.models.detector_sha256} />
              </>
            )}
          </p>
        )}
      </section>
    </div>
  );
}
