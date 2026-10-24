import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { getKilns, getSummary } from "../api";
import { BrickWall } from "../components/BrickWall";
import { ImpactPanel } from "../components/Impact";
import { MapView } from "../components/MapView";
import { ArrowGlyph, ErrorBox, ExternalGlyph, Hash, Loading, SampleTag, StatusIcon, ZigzagRule, statusClass } from "../components/ui";
import { usePrefs } from "../i18n";
import { dateLabel, seasonLabel, useAsync } from "../lib/util";
import { STATUS_ORDER } from "../types";

export function Overview() {
  const { t, lang } = usePrefs();
  const nav = useNavigate();
  const summary = useAsync(getSummary, []);
  const kilns = useAsync(() => getKilns(), []);
  const s = summary.data;

  const shares = useMemo(() => {
    if (!s) return null;
    const claimed = s.claim.province_total && s.claim.claimed_converted ? s.claim.claimed_converted / s.claim.province_total : null;
    const seen = s.total ? s.counts.ZIGZAG / s.total : 0;
    return { claimed, seen };
  }, [s]);

  if (summary.error) return <ErrorBox error={summary.error} onRetry={summary.reload} />;
  if (!s) return <Loading />;

  const season = s.season ? seasonLabel(s.season, lang) : "";
  const toVisit = s.counts.FCBK + s.counts.UNDETERMINED + s.counts.NOT_DETECTED;
  const sceneDates = [...new Set(s.scenes.map((x) => dateLabel(x.date, lang)))].join(", ");

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
            {t.overview.seenTitle(season)} <SampleTag />
          </h2>
          <p className="seen-lead">{t.overview.seenLead(s.total, "\u2068" + s.aoi.name + "\u2069")}</p>
          <figure className="wall-fig">
            <BrickWall counts={s.counts} cols={s.total > 400 ? 40 : 18} />
            <figcaption className="fine">{t.overview.wallCaption}</figcaption>
          </figure>
          <ul className="tally" aria-label={t.common.status}>
            {STATUS_ORDER.map((st) => (
              <li key={st} className={`tally-row ${statusClass(st)}`}>
                <Link to={`/map?status=${st}`} className="tally-link">
                  <StatusIcon status={st} size={20} />
                  <span className="tally-word">{t.statusLong[st]}</span>
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

      <div className="overview-pair">
      {shares?.claimed != null && (
        <section className="compare panel" aria-labelledby="cmp-h">
          <h2 id="cmp-h" className="panel-title">
            {t.overview.compareTitle}
          </h2>
          <div className="cmp-row">
            <span className="cmp-label">{t.overview.compareClaim}</span>
            <span className="cmp-bar" aria-hidden="true">
              <span className="cmp-fill cmp-claim" style={{ inlineSize: `${shares.claimed * 100}%` }} />
            </span>
            <span className="cmp-val" dir="ltr">
              {Math.round(shares.claimed * 100)}%
            </span>
          </div>
          <div className="cmp-row">
            <span className="cmp-label">
              {t.overview.compareSeen} <SampleTag />
            </span>
            <span className="cmp-bar" aria-hidden="true">
              <span className="cmp-fill cmp-seen" style={{ inlineSize: `${shares.seen * 100}%` }} />
            </span>
            <span className="cmp-val" dir="ltr">
              {Math.round(shares.seen * 100)}%
            </span>
          </div>
          <p className="fine">
            {t.overview.claimShare(`${Math.round(shares.claimed * 100)}%`)}{" "}
            {s.claim.province_total_source && (
              <a href={s.claim.province_total_source.url} target="_blank" rel="noreferrer">
                {s.claim.province_total_source.title}
                <ExternalGlyph />
              </a>
            )}
          </p>
          <p className="fine">{t.overview.compareNote}</p>
        </section>
      )}

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
          <h2 id="q-h">{t.overview.queueLead(toVisit)}</h2>
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
            <Link to="/map" className="link-arrow">
              {t.overview.openMap}
              <ArrowGlyph />
            </Link>
          </div>
          <MapView
            kilns={kilns.data ?? []}
            bbox={s.aoi.bbox}
            label={t.map.mapLabel}
            compact
            className="map-compact"
            onSelect={(id) => nav(`/kiln/${id}`)}
          />
        </section>

        <ImpactPanel title={t.impact.title} lead={t.impact.leadAll} impact={s.impact} />
      </div>

      <section className="provenance" aria-label={t.overview.modelsLine}>
        <p>
          {t.overview.sceneLine(s.scenes.length, sceneDates)} <SampleTag />
        </p>
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
