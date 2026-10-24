import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { getKiln, getKilns, getSummary } from "../api";
import { MapView } from "../components/MapView";
import { ArrowGlyph, CrossGlyph, ErrorBox, Loading, Mono, StatusBadge, StatusIcon } from "../components/ui";
import { usePrefs } from "../i18n";
import { prefersReducedMotion, setInWords, useAsync } from "../lib/util";
import { usePFcbk } from "../lib/heights";
import { STATUS_ORDER, type Status } from "../types";

export function MapPage() {
  const { t } = usePrefs();
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") as Status | null) ?? "";
  const district = params.get("district") ?? "";
  const selected = params.get("kiln");
  const [satellite, setSatellite] = useState(false);
  const [listLimit, setListLimit] = useState(200);
  const [threeD, setThreeD] = useState(false);
  const [touring, setTouring] = useState(false);
  const [tourAt, setTourAt] = useState<string | null>(null);
  const reduced = prefersReducedMotion();

  const all = useAsync(() => getKilns(), []);
  const pFcbk = usePFcbk(threeD && !(all.data ?? []).some((k) => k.p_fcbk != null));
  const summary = useAsync(getSummary, []);
  const districts = useMemo(() => [...new Set((all.data ?? []).map((k) => k.district))].sort(), [all.data]);
  const shown = useMemo(
    () => (all.data ?? []).filter((k) => (!status || k.status === status) && (!district || k.district === district)),
    [all.data, status, district],
  );

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  if (all.error) return <ErrorBox error={all.error} onRetry={all.reload} />;

  return (
    <div className="mappage">
      <div className="mappage-bar">
        <h1 className="mappage-title">{t.map.title}</h1>
        <div className="filters" role="group" aria-label={t.map.filters}>
          <label className="field-inline">
            <span className="sr-only">{t.common.status}</span>
            <select value={status} onChange={(e) => setParam("status", e.target.value || null)}>
              <option value="">{t.common.allStatuses}</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {t.status[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="field-inline">
            <span className="sr-only">{t.common.district}</span>
            <select value={district} onChange={(e) => setParam("district", e.target.value || null)}>
              <option value="">{t.common.allDistricts}</option>
              {districts.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <div className="seg seg-text" role="radiogroup" aria-label={t.map.basemap}>
            <button type="button" role="radio" aria-checked={!satellite} className={`seg-btn ${!satellite ? "is-on" : ""}`} onClick={() => setSatellite(false)}>
              {t.map.streets}
            </button>
            <button type="button" role="radio" aria-checked={satellite} className={`seg-btn ${satellite ? "is-on" : ""}`} onClick={() => setSatellite(true)}>
              {t.map.satellite}
            </button>
          </div>
          <button type="button" className={`toggle toggle-s ${threeD ? "is-on" : ""}`} aria-pressed={threeD} onClick={() => setThreeD((v) => !v)}>
            <span className="toggle-dot" aria-hidden="true" />
            {t.map.threeD}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-s"
            disabled={reduced}
            title={reduced ? t.map.tourReduced : undefined}
            onClick={() => {
              if (touring) setTouring(false);
              else {
                setThreeD(true);
                setTouring(true);
              }
            }}
          >
            {touring ? t.map.tourStop : t.map.tour}
          </button>
        </div>
        <p className="map-count" aria-live="polite">
          {touring && tourAt ? t.map.touring(tourAt === "FCBK" ? t.map.tourFcbk : tourAt) : all.data ? t.map.showing(shown.length, all.data.length) : t.common.loading}
        </p>
      </div>

      <div className="mappage-body">
        <div className="mappage-map">
          <MapView
            kilns={shown}
            selectedId={selected}
            onSelect={(id) => setParam("kiln", id)}
            bbox={summary.data?.aoi.bbox}
            satellite={satellite}
            label={t.map.mapLabel}
            className="map-full"
            threeD={threeD}
            pFcbk={pFcbk}
            tour={touring}
            onTourStop={(name) => {
              setTourAt(name);
              if (name === null) setTouring(false);
            }}
          />
          <ul className="legend" aria-label={t.map.legend}>
            {STATUS_ORDER.map((s) => (
              <li key={s}>
                <StatusIcon status={s} size={16} />
                <span>{t.status[s]}</span>
              </li>
            ))}
            {threeD && <li className="legend-note">{t.map.heightNote}</li>}
          </ul>
          {selected && <Drawer id={selected} alpha={summary.data?.alpha ?? 0.1} onClose={() => setParam("kiln", null)} />}
        </div>

        <section className="kiln-list" aria-labelledby="kl-h">
          <h2 id="kl-h" className="panel-title">
            {t.map.listTitle}
          </h2>
          {!all.data ? (
            <Loading />
          ) : shown.length === 0 ? (
            <div className="empty">
              <p>{t.map.noKilns}</p>
              <button type="button" className="btn btn-secondary" onClick={() => setParams({}, { replace: true })}>
                {t.map.clear}
              </button>
            </div>
          ) : (
            <ul className="kl-items">
              {(selected && !shown.slice(0, listLimit).some((k) => k.id === selected)
                ? [...shown.filter((k) => k.id === selected), ...shown.slice(0, listLimit)]
                : shown.slice(0, listLimit)
              ).map((k) => (
                <li key={k.id}>
                  <button
                    type="button"
                    className={`kl-item ${selected === k.id ? "is-selected" : ""}`}
                    aria-pressed={selected === k.id}
                    onClick={() => setParam("kiln", k.id)}
                  >
                    <StatusBadge status={k.status} size="s" />
                    <Mono>{k.id}</Mono>
                    <span className="kl-district">{k.district}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {shown.length > listLimit && (
            <button type="button" className="btn btn-secondary btn-block more-btn" onClick={() => setListLimit((n) => n + 200)}>
              {t.map.showMore(Math.min(200, shown.length - listLimit))}
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function Drawer({ id, alpha, onClose }: { id: string; alpha: number; onClose: () => void }) {
  const { t } = usePrefs();
  const rec = useAsync(() => getKiln(id), [id]);
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);
  const r = rec.data;
  return (
    <div className="drawer" role="dialog" aria-modal="false" aria-labelledby="drawer-h" ref={ref} tabIndex={-1}>
      <div className="drawer-head">
        <h2 id="drawer-h">
          <span className="sr-only">{t.map.drawerTitle} </span>
          <Mono>{id}</Mono>
        </h2>
        <button type="button" className="icon-btn icon-btn-l" onClick={onClose} aria-label={t.common.close}>
          <CrossGlyph />
        </button>
      </div>
      {rec.error ? (
        <ErrorBox error={rec.error} />
      ) : !r ? (
        <Loading />
      ) : (
        <div className="drawer-body">
          <StatusBadge status={r.status} long size="l" />
          <p className="set-words">{setInWords(t, r.status, r.observation.set, alpha)}</p>
          <dl className="kv">
            <div>
              <dt>{t.common.district}</dt>
              <dd>{r.district}</dd>
            </div>
            <div>
              <dt>{t.map.coords}</dt>
              <dd dir="ltr">
                {r.lat.toFixed(4)}, {r.lon.toFixed(4)}
              </dd>
            </div>
            <div>
              <dt>{t.map.baseline}</dt>
              <dd>{r.baseline ? t.className[r.baseline.class] : t.kiln.newDetection}</dd>
            </div>
            {r.observation.probs && (
              <div>
                <dt>{t.inspect.pZigzag}</dt>
                <dd dir="ltr">{(r.observation.probs.Zigzag * 100).toFixed(1)}%</dd>
              </div>
            )}
          </dl>
          <Link to={`/kiln/${r.id}`} className="btn btn-primary btn-block">
            {t.common.open}
            <ArrowGlyph />
          </Link>
        </div>
      )}
    </div>
  );
}
