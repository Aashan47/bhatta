import { useT } from "../i18n";
import { rangeStr } from "../lib/util";
import type { Range, Source } from "../types";
import { ExternalGlyph, SampleTag } from "./ui";

interface Figures {
  coal_t_per_season: Range;
  co2_t: Range;
  black_carbon_reduction_pct: Range;
}

export function ImpactPanel({
  figures,
  sources,
  lead,
  title,
  sample,
}: {
  figures: Figures | null | undefined;
  sources: Source[];
  lead: string;
  title: string;
  sample?: boolean;
}) {
  const t = useT();
  return (
    <section className="panel impact" aria-labelledby="impact-h">
      <h2 id="impact-h" className="panel-title">
        {title} {sample && <SampleTag />}
      </h2>
      {!figures ? (
        <p className="muted">{t.impact.none}</p>
      ) : (
        <>
          <p className="impact-lead">{lead}</p>
          <dl className="impact-grid">
            <div>
              <dt>{t.impact.coal}</dt>
              <dd dir="ltr">{t.impact.tonnes(rangeStr(figures.coal_t_per_season))}</dd>
            </div>
            <div>
              <dt>{t.impact.co2}</dt>
              <dd dir="ltr">{t.impact.tonnes(rangeStr(figures.co2_t))}</dd>
            </div>
            <div>
              <dt>{t.impact.bc}</dt>
              <dd dir="ltr">{t.impact.percent(rangeStr(figures.black_carbon_reduction_pct))}</dd>
            </div>
          </dl>
          <p className="fine">{t.impact.rangeNote}</p>
          {sources.length > 0 && (
            <div className="sources">
              <h3>{t.impact.sources}</h3>
              <ol>
                {sources.map((s, i) => (
                  <li key={i}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noreferrer">
                        {s.title}
                        <ExternalGlyph />
                      </a>
                    ) : (
                      <span>
                        {s.title} <span className="muted">({t.impact.placeholderSource})</span>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  );
}
