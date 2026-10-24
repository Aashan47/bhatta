import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { FIXTURE, getKiln, getLedger } from "../api";
import { CertIcon, QR, useCertText } from "../components/Record";
import { ArrowGlyph, ErrorBox, Hash, Loading, Logo, Mono, StatusBadge } from "../components/ui";
import { usePrefs } from "../i18n";
import { dateLabel, seasonLabel, useAsync } from "../lib/util";
import type { KilnRecord, Ledger } from "../types";

export function Certificate() {
  const { id = "" } = useParams();
  const rec = useAsync(() => getKiln(id), [id]);
  const ledger = useAsync(getLedger, []);
  if (rec.error) return <ErrorBox error={rec.error} onRetry={rec.reload} />;
  if (!rec.data) return <Loading />;
  return <CertificateSheet rec={rec.data} ledger={ledger.data} />;
}

function CertificateSheet({ rec, ledger }: { rec: KilnRecord; ledger?: Ledger }) {
  const { t, lang } = usePrefs();
  const { c, word, line } = useCertText(rec);
  const live = `${window.location.origin}/kiln/${rec.id}`;
  useEffect(() => {
    const prev = document.title;
    document.title = `${t.cert.pageTitle}: ${rec.id}`;
    return () => {
      document.title = prev;
    };
  }, [rec.id, t.cert.pageTitle]);

  const findingWord = c.lastFinding ? t.events.finding[c.lastFinding] : t.cert.missingInspector;

  return (
    <div className="cert-page">
      <div className="cert-toolbar no-print">
        <Link to={`/kiln/${rec.id}`} className="link-back">
          <ArrowGlyph />
          {t.kiln.titleFor(rec.id)}
        </Link>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>
          {t.common.print}
        </button>
      </div>

      <section className={`sheet cert-${c.state}`} aria-labelledby="sheet-h">
        <header className="sheet-head">
          <Logo size={36} />
          <div>
            <p className="sheet-brand">
              Bhatta <span lang="ur">بھٹہ</span>
            </p>
            <h1 id="sheet-h">{t.cert.pageTitle}</h1>
          </div>
        </header>
        {FIXTURE && <p className="sheet-sample">{t.sample.banner}</p>}

        <div className="sheet-state">
          <CertIcon state={c.state} size={44} />
          <p className="sheet-word">{word}</p>
        </div>
        <p className="sheet-line">{line}</p>

        <div className="sheet-body">
          <dl className="sheet-kv">
            <div>
              <dt>{t.map.drawerTitle}</dt>
              <dd>
                <Mono>{rec.id}</Mono>
              </dd>
            </div>
            <div>
              <dt>{t.common.district}</dt>
              <dd>
                {rec.district}, <span dir="ltr">{rec.lat.toFixed(4)}, {rec.lon.toFixed(4)}</span>
              </dd>
            </div>
            <div>
              <dt>{t.cert.season}</dt>
              <dd>{seasonLabel(rec.chain.season, lang)}</dd>
            </div>
            <div>
              <dt>{t.cert.satellite}</dt>
              <dd>
                <StatusBadge status={rec.status} size="s" />
              </dd>
            </div>
            <div>
              <dt>{t.cert.inspector}</dt>
              <dd>
                {findingWord}
                {c.inspector && (
                  <>
                    {" "}
                    <Hash value={c.inspector} copy={false} />
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>{t.cert.leaf}</dt>
              <dd>
                <Hash value={rec.chain.leaf} head={10} tail={8} copy={false} />
              </dd>
            </div>
            <div>
              <dt>{t.cert.contract}</dt>
              <dd>{ledger?.contract ? <Hash value={ledger.contract} copy={false} /> : ledger?.mock_chain ? t.ledger.mockChain : t.ledger.notDeployed}</dd>
            </div>
          </dl>
          <figure className="sheet-qr">
            <QR text={live} size={132} label={`${t.cert.scan}: ${live}`} />
            <figcaption>
              {t.cert.scan}
              <span className="mono sheet-url" dir="ltr">
                {live.replace(/^https?:\/\//, "")}
              </span>
            </figcaption>
          </figure>
        </div>
        <p className="sheet-foot">{t.cert.issued(dateLabel(new Date().toISOString(), lang))}</p>
      </section>
    </div>
  );
}
