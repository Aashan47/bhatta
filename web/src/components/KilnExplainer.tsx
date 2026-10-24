import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { chipUrl, FIXTURE, getKiln, getKilns } from "../api";
import { usePrefs } from "../i18n";
import { prefersReducedMotion } from "../lib/util";
import type { ImpactSummary, KilnRecord } from "../types";
import type { KilnScene } from "../kiln3d/scene";
import { ExternalGlyph, SampleTag } from "./ui";

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#f3e7db";
}

/** Stills rendered from this same scene (scripts/make-explainer-stills.mjs), for browsers without WebGL. */
function stillFor(t: number, fire: boolean) {
  if (t >= 0.75) return "/explainer/tenm.png";
  if (t >= 0.25) return "/explainer/top.png";
  return fire ? "/explainer/fire.png" : "/explainer/full.png";
}

export function KilnExplainer({ impact, id = "kilns-3d" }: { impact?: ImpactSummary; id?: string }) {
  const { t, resolvedTheme } = usePrefs();
  const k = t.kiln3d;
  const uid = useId();
  const stage = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const sceneRef = useRef<KilnScene | null>(null);
  const labelF = useRef<HTMLSpanElement>(null);
  const labelZ = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<"idle" | "loading" | "3d" | "fallback">("idle");
  const [fire, setFire] = useState(false);
  const [res, setRes] = useState(0); // 0..100
  const [showChip, setShowChip] = useState(false);
  const [chip, setChip] = useState<KilnRecord | null>(null);
  const reduced = useRef(prefersReducedMotion());
  const anim = useRef(0);

  const bc = impact?.per_conversion.find((x) => x.key === "black_carbon");
  const smokeRatio = bc ? Math.max(0, 1 - bc.reduction_pct / 100) : null;

  // Load three.js only when the section is about to scroll into view.
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          setMode(hasWebGL() ? "loading" : "fallback");
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (mode !== "loading" || !stage.current) return;
    let live = true;
    import("../kiln3d/scene")
      .then(({ createKilnScene }) => {
        if (!live || !stage.current) return;
        sceneRef.current = createKilnScene(stage.current, {
          reducedMotion: reduced.current,
          smokeRatio,
          background: cssVar("--surface"),
          onLabels: (f, z) => {
            for (const [el, p] of [
              [labelF.current, f],
              [labelZ.current, z],
            ] as const) {
              if (!el) continue;
              el.style.opacity = p ? "1" : "0";
              if (p) el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
            }
          },
        });
        setMode("3d");
      })
      .catch(() => live && setMode("fallback"));
    return () => {
      live = false;
    };
    // smokeRatio is read once at creation; it comes from the API and does not change on the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useEffect(
    () => () => {
      cancelAnimationFrame(anim.current);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    },
    [],
  );

  useEffect(() => sceneRef.current?.setFire(fire), [fire, mode]);
  useEffect(() => sceneRef.current?.setResolution(res / 100), [res, mode]);
  useEffect(() => {
    // follow the colour theme
    const id = requestAnimationFrame(() => sceneRef.current?.setBackground(cssVar("--surface")));
    return () => cancelAnimationFrame(id);
  }, [resolvedTheme, mode]);

  useEffect(() => {
    if (!showChip || chip) return;
    getKilns({ status: "FCBK" })
      .then((list) => (list[0] ? getKiln(list[0].id) : null))
      .then((r) => r && setChip(r))
      .catch(() => undefined);
  }, [showChip, chip]);

  function jumpTo(target: number) {
    cancelAnimationFrame(anim.current);
    if (reduced.current) {
      setRes(target);
      return;
    }
    const start = performance.now();
    const from = res;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 2200);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      setRes(Math.round(from + (target - from) * e));
      if (p < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }

  function onKey(e: React.KeyboardEvent) {
    const s = sceneRef.current;
    if (!s) return;
    const map: Record<string, () => void> = {
      ArrowLeft: () => s.rotateBy(0.15),
      ArrowRight: () => s.rotateBy(-0.15),
      ArrowUp: () => s.zoomBy(0.9),
      ArrowDown: () => s.zoomBy(1.1),
      "+": () => s.zoomBy(0.9),
      "=": () => s.zoomBy(0.9),
      "-": () => s.zoomBy(1.1),
    };
    const f = map[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  }

  const tv = res / 100;
  const at10 = tv >= 0.85;
  const stageLabel = k.stageLabel;

  return (
    <section ref={section} className="explainer" aria-labelledby={`${uid}-h`} id={id}>
      <div className="explainer-head">
        <h2 id={`${uid}-h`}>{k.title}</h2>
        <p className="lead-s">{k.lead}</p>
      </div>
      <div className={`explainer-body ${showChip ? "with-chip" : ""}`}>
        <div className="stage-wrap">
          <div
            ref={stage}
            className={`stage ${mode === "3d" ? "is-3d" : ""} ${at10 ? "is-10m" : ""}`}
            tabIndex={mode === "3d" ? 0 : -1}
            role={mode === "3d" ? "application" : undefined}
            aria-label={mode === "3d" ? stageLabel : undefined}
            aria-roledescription={mode === "3d" ? k.roleDesc : undefined}
            onKeyDown={onKey}
          >
            {mode === "fallback" && <img className="stage-still" src={stillFor(tv, fire)} alt={tv >= 0.75 ? k.altTenm : tv >= 0.25 ? k.altTop : k.altFull} width={1200} height={700} />}
            {(mode === "idle" || mode === "loading") && <div className="stage-loading">{t.common.loading}</div>}
            {mode === "3d" && (
              <>
                <span ref={labelF} className="stage-label lab-fcbk" aria-hidden="true">
                  {k.fcbk}
                </span>
                <span ref={labelZ} className="stage-label lab-zig" aria-hidden="true">
                  {k.zigzag}
                </span>
              </>
            )}
            {mode === "3d" && tv === 0 && <span className="stage-hint">{k.hint}</span>}
            {tv > 0.5 && (
              <span className="stage-scale" dir="ltr">
                {tv >= 0.999 ? k.scale10 : k.scaleTop}
              </span>
            )}
          </div>
          {mode === "fallback" && <p className="fine">{k.fallbackNote}</p>}
        </div>
        {showChip && (
          <figure className="real-chip">
            {chip?.observation.chip ? (
              <img src={chipUrl(chip.observation.chip)} alt={k.chipAlt(chip.id)} width={160} height={160} />
            ) : (
              <div className="real-chip-empty">{t.common.loading}</div>
            )}
            <figcaption>
              {k.chipCaption} {FIXTURE && <SampleTag />}
              {chip && (
                <>
                  {" "}
                  <Link to={`/kiln/${chip.id}`}>{chip.id}</Link>
                </>
              )}
            </figcaption>
          </figure>
        )}
      </div>

      <div className="explainer-controls">
        <button type="button" className={`toggle ${fire ? "is-on" : ""}`} aria-pressed={fire} onClick={() => setFire((f) => !f)} disabled={tv > 0.5}>
          <span className="toggle-dot" aria-hidden="true" />
          {k.fire}
        </button>
        <div className="res-field">
          <label htmlFor={`${uid}-res`}>{k.slider}</label>
          <input
            id={`${uid}-res`}
            type="range"
            min={0}
            max={100}
            step={reduced.current ? 50 : 1}
            value={res}
            onChange={(e) => {
              cancelAnimationFrame(anim.current);
              setRes(Number(e.target.value));
            }}
            aria-valuetext={tv >= 0.999 ? k.stop10 : tv >= 0.5 ? k.stopTop : k.stopFull}
          />
          <div className="res-ticks" aria-hidden="true">
            <span>{k.stopFull}</span>
            <span>{k.stopTop}</span>
            <span>{k.stop10}</span>
          </div>
        </div>
        <div className="explainer-buttons">
          <button type="button" className="btn btn-primary" onClick={() => jumpTo(res >= 100 ? 0 : 100)}>
            {res >= 100 ? k.back : k.jump}
          </button>
          <button type="button" className={`toggle ${showChip ? "is-on" : ""}`} aria-pressed={showChip} onClick={() => setShowChip((v) => !v)}>
            <span className="toggle-dot" aria-hidden="true" />
            {k.chipToggle}
          </button>
        </div>
      </div>

      <div className="explainer-notes" aria-live="polite">
        {at10 ? (
          <p className="tenm-caption">
            {k.caption10} <Link to="/method#m-misses">{k.captionLink}</Link>
          </p>
        ) : fire ? (
          <>
            <p>{k.fireNote}</p>
            <p className="fine">
              {bc ? (
                <>
                  {k.smokeNote(`${bc.reduction_pct}%`, /icimod/i.test(bc.source.title) ? "ICIMOD" : "")}{" "}
                  {bc.source.url ? (
                    <a href={bc.source.url} target="_blank" rel="noreferrer">
                      {bc.source.title}
                      <ExternalGlyph />
                    </a>
                  ) : (
                    bc.source.title
                  )}
                  {impact?.sample && <SampleTag />}
                </>
              ) : (
                k.smokeUnknown
              )}
            </p>
          </>
        ) : (
          <p className="fine">{k.keys}</p>
        )}
      </div>
    </section>
  );
}
