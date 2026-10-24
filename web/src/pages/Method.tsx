import { getAudit, getResults, getSummary } from "../api";
import { Architecture } from "../components/Architecture";
import { CheckGlyph, CrossGlyph, ErrorBox, Loading, PageHeader, SampleTag, ZigzagRule } from "../components/ui";
import { usePrefs } from "../i18n";
import { useAsync } from "../lib/util";

export function Method() {
  const { t, lang } = usePrefs();
  const results = useAsync(getResults, []);
  const audit = useAsync(getAudit, []);
  const summary = useAsync(getSummary, []);
  const alpha = summary.data?.alpha ?? 0.1;
  const qhat = summary.data?.qhat;

  return (
    <div className="method prose-page">
      <PageHeader title={t.method.title} lead={t.method.lead} />

      <section aria-labelledby="m-data">
        <h2 id="m-data">{t.method.dataTitle}</h2>
        <ul className="plain-list">
          {t.method.data.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="m-models">
        <h2 id="m-models">{t.method.modelsTitle}</h2>
        <ul className="plain-list">
          {t.method.models.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
        <p>{t.method.splitNote}</p>
      </section>

      <section aria-labelledby="m-rule" className="rule-box">
        <h2 id="m-rule">{t.method.ruleTitle}</h2>
        <p>
          {t.method.rule(`${Math.round((1 - alpha) * 100)}%`, qhat !== undefined ? qhat.toFixed(4) : "q")} {qhat !== undefined && <SampleTag />}
        </p>
        <p className="fine">{t.method.ruleExample}</p>
      </section>

      <section aria-labelledby="m-arch" className="wide">
        <h2 id="m-arch">{t.method.archTitle}</h2>
        <Architecture />
      </section>

      <ZigzagRule />

      <section aria-labelledby="m-res" className="wide">
        <h2 id="m-res">
          {t.method.resultsTitle} {results.data?.fixture && <SampleTag />}
        </h2>
        <p>{t.method.resultsLead}</p>
        {results.error ? (
          <ErrorBox error={results.error} onRetry={results.reload} />
        ) : !results.data ? (
          <Loading />
        ) : (
          <>
            {results.data.fixture && <p className="sample-inline block">{t.sample.banner}</p>}
            <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="m-res">
              <table className="table results">
                <thead>
                  <tr>
                    <th scope="col">{t.method.id}</th>
                    <th scope="col">{t.method.metric}</th>
                    <th scope="col">{t.method.target}</th>
                    <th scope="col">{t.method.value}</th>
                    <th scope="col">{t.method.verdict}</th>
                  </tr>
                </thead>
                <tbody>
                  {results.data.targets.map((r) => (
                    <tr key={r.id} className={r.hit === true ? "row-hit" : r.hit === false ? "row-miss" : "row-pending"}>
                      <th scope="row" dir="ltr">
                        {r.id}
                      </th>
                      <td lang="en" dir="ltr" className="metric-cell">
                        {r.metric}
                      </td>
                      <td dir="ltr" className="num">
                        {r.target}
                      </td>
                      <td dir="ltr" className="num">
                        {r.value === null || r.value === "" ? "" : String(r.value)}
                        {r.n !== undefined && <span className="cell-sub">{t.method.n(r.n)}</span>}
                      </td>
                      <td>
                        {r.hit === true ? (
                          <span className="verdict-tag hit">
                            <CheckGlyph />
                            {t.method.hit}
                          </span>
                        ) : r.hit === false ? (
                          <span className="verdict-tag miss">
                            <CrossGlyph />
                            {t.method.miss}
                          </span>
                        ) : (
                          <span className="verdict-tag pending">{t.method.pending}</span>
                        )}
                        {r.note && <span className="cell-sub">{r.note}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {results.data.split && <p className="fine">{results.data.split}</p>}
          </>
        )}
      </section>

      <section aria-labelledby="m-audit">
        <h2 id="m-audit">{t.method.auditTitle}</h2>
        <p>{t.method.auditLead}</p>
        {audit.error ? (
          <p className="muted">{t.method.auditNotRun}</p>
        ) : !audit.data ? (
          <Loading />
        ) : audit.data.n === 0 ? (
          <p className="audit-empty">{audit.data.status && lang === "en" ? audit.data.status : t.method.auditNotRun}</p>
        ) : (
          <>
            <p>{t.method.auditCounts(audit.data.n, audit.data.agreed, audit.data.disagreed, audit.data.unsure)}</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="m-audit">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">{t.method.auditModel}</th>
                    <th scope="col">{t.method.auditHuman}</th>
                    <th scope="col">{t.method.auditAgree}</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.rows.map((r) => (
                    <tr key={r.id}>
                      <th scope="row" className="mono" dir="ltr">
                        {r.id}
                      </th>
                      <td>{r.model}</td>
                      <td>{r.human}</td>
                      <td>{r.agree === null ? "?" : r.agree ? <CheckGlyph /> : <CrossGlyph />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="m-limits" className="limits">
        <h2 id="m-limits">{t.method.limitsTitle}</h2>
        <ul className="limit-list">
          {[...t.method.limits, ...(results.data?.limits ?? [])].map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
