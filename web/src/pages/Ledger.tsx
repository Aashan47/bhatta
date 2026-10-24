import { Link } from "react-router";
import { FIXTURE, getLedger } from "../api";
import { eventSummary } from "../components/Record";
import { ErrorBox, ExternalGlyph, Hash, Loading, Mono, PageHeader, SampleTag, TxLink } from "../components/ui";
import { usePrefs } from "../i18n";
import { dateLabel, explorerAddress, seasonLabel, useAsync } from "../lib/util";
import type { EventType } from "../types";

const EV_CLASS: Record<EventType, string> = {
  SeasonPublished: "ev-season",
  SatelliteProven: "ev-proven",
  Finding: "ev-finding",
  Conflict: "ev-conflict",
  Disputed: "ev-dispute",
};

export function Ledger() {
  const { t, lang } = usePrefs();
  const ledger = useAsync(getLedger, []);
  const l = ledger.data;
  const sample = FIXTURE || l?.mock_chain;

  return (
    <div className="ledger">
      <PageHeader title={t.ledger.title} lead={t.ledger.lead} />
      {ledger.error ? (
        <ErrorBox error={ledger.error} onRetry={ledger.reload} />
      ) : !l ? (
        <Loading />
      ) : (
        <>
          <dl className="chain-card">
            <div>
              <dt>{t.ledger.network}</dt>
              <dd>
                {l.chain_name ?? "Ethereum Sepolia"} <span className="muted" dir="ltr">(chain id {l.chain_id})</span>
              </dd>
            </div>
            <div>
              <dt>{t.ledger.contract}</dt>
              <dd>
                {l.contract ? (
                  <>
                    <Hash value={l.contract} head={8} tail={6} />{" "}
                    <a href={explorerAddress(l.explorer, l.contract)} target="_blank" rel="noreferrer">
                      {t.common.viewOnExplorer}
                      <ExternalGlyph />
                    </a>
                  </>
                ) : l.mock_chain ? (
                  <span className="sample-inline">{t.ledger.mockChain}</span>
                ) : (
                  t.ledger.notDeployed
                )}
              </dd>
            </div>
          </dl>

          <section aria-labelledby="seasons-h" className="ledger-section">
            <h2 id="seasons-h">
              {t.ledger.seasons} <SampleTag />
            </h2>
            <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="seasons-h">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t.common.season}</th>
                    <th scope="col">{t.ledger.root}</th>
                    <th scope="col">{t.ledger.kilns}</th>
                    <th scope="col">{t.ledger.model}</th>
                    <th scope="col">{t.ledger.tx}</th>
                  </tr>
                </thead>
                <tbody>
                  {l.seasons.map((s) => (
                    <tr key={`${s.season}-${s.tx}`}>
                      <th scope="row">
                        {seasonLabel(s.season, lang)}
                        {s.time && <span className="cell-sub">{t.ledger.published(dateLabel(s.time, lang))}</span>}
                      </th>
                      <td>
                        <Hash value={s.root} />
                      </td>
                      <td dir="ltr">{s.kilns?.toLocaleString("en") ?? ""}</td>
                      <td>
                        <Hash value={s.model_hash} copy={false} />
                      </td>
                      <td>
                        <TxLink tx={s.tx} explorer={l.explorer} sample={sample} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="events-h" className="ledger-section">
            <h2 id="events-h">
              {t.ledger.events} <SampleTag />
            </h2>
            {l.events.length === 0 ? (
              <p className="muted">{t.ledger.noEvents}</p>
            ) : (
              <ol className="ev-list">
                {l.events.map((e, i) => {
                  const sum = eventSummary(e, t);
                  return (
                    <li key={i} className={`ev-row ${EV_CLASS[e.type]}`}>
                      <span className="ev-type">
                        <span className="ev-swatch" aria-hidden="true" />
                        {t.events[e.type]}
                      </span>
                      {sum && <span className="ev-sum">{sum}</span>}
                      {e.kiln_id ? (
                        <Link to={`/kiln/${e.kiln_id}`} className="ev-kiln">
                          <Mono>{e.kiln_id}</Mono>
                        </Link>
                      ) : (
                        <span className="ev-kiln muted">{e.season ? seasonLabel(e.season, lang) : ""}</span>
                      )}
                      <time className="ev-time" dateTime={e.time}>
                        {dateLabel(e.time, lang, true)}
                      </time>
                      <span className="ev-tx">
                        <TxLink tx={e.tx} explorer={l.explorer} sample={sample} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}
