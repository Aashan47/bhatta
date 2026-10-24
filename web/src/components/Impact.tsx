import { useT } from "../i18n";
import type { ImpactSummary } from "../types";
import { ExternalGlyph, SampleTag } from "./ui";

/** Measured reductions per FCBK kiln converted to Zigzag. Percentages only, each with its source;
 *  never multiplied into tonnes, because no verified per-kiln coal figure exists. */
export function ImpactPanel({ impact, title, lead }: { impact: ImpactSummary | undefined; title: string; lead: string }) {
  const t = useT();
  return (
    <section className="panel impact" aria-labelledby="impact-h">
      <h2 id="impact-h" className="panel-title">
        {title} {impact?.sample && <SampleTag />}
      </h2>
      {!impact || impact.per_conversion.length === 0 ? (
        <p className="muted">{t.impact.none}</p>
      ) : (
        <>
          <p className="impact-lead">{lead}</p>
          <ul className="impact-list">
            {impact.per_conversion.map((it) => {
              const words = (t.impact.less[it.key] ?? ((p: string) => `${p} ${it.key}`))(`${it.reduction_pct}%`);
              return (
                <li key={it.key} className={`impact-item ik-${it.key}`}>
                  <span className="impact-pct" dir="ltr">
                    {it.reduction_pct}%
                  </span>
                  <span className="impact-words">
                    <span className="impact-what">{words.replace(`${it.reduction_pct}%`, "").trim()}</span>
                    <span className="impact-src" dir="auto">
                      {it.source.url ? (
                        <a href={it.source.url} target="_blank" rel="noreferrer" title={it.source.quote || undefined}>
                          {it.source.title}
                          <ExternalGlyph />
                        </a>
                      ) : (
                        <>
                          {it.source.title} <span className="muted">({t.impact.noLink})</span>
                        </>
                      )}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          {impact.note && (
            <p className="fine" dir="auto">
              {impact.note}
            </p>
          )}
        </>
      )}
    </section>
  );
}
