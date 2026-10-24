import { useEffect, useRef, type ReactNode } from "react";
import { NavLink, Link, useLocation } from "react-router";
import { usePrefs, type Theme } from "../i18n";
import { FIXTURE } from "../api";
import { Logo, SampleBanner } from "./ui";

const NavIcon = ({ name }: { name: "overview" | "map" | "inspect" | "ledger" | "method" }) => {
  const p = { width: 22, height: 22, viewBox: "0 0 24 24", "aria-hidden": true, focusable: false, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (name) {
    case "overview":
      return (
        <svg {...p}>
          <rect x="3" y="5" width="8" height="4.5" rx="0.8" />
          <rect x="13" y="5" width="8" height="4.5" rx="0.8" />
          <rect x="7.5" y="11" width="9" height="4.5" rx="0.8" />
          <rect x="3" y="17" width="8" height="3" rx="0.8" />
          <rect x="13" y="17" width="8" height="3" rx="0.8" />
        </svg>
      );
    case "map":
      return (
        <svg {...p}>
          <path d="M12 21s-6.5-5.8-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.2-6.5 11-6.5 11z" />
          <circle cx="12" cy="10" r="2.4" />
        </svg>
      );
    case "inspect":
      return (
        <svg {...p}>
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4V2.8h6V4M8.5 10h7M8.5 14h7M8.5 18h4" />
        </svg>
      );
    case "ledger":
      return (
        <svg {...p}>
          <rect x="3" y="4" width="7" height="7" rx="1.2" />
          <rect x="14" y="13" width="7" height="7" rx="1.2" />
          <path d="M10 7.5h3a2.5 2.5 0 0 1 2.5 2.5v3" />
          <path d="M6.5 11v3a2.5 2.5 0 0 0 2.5 2.5h5" />
        </svg>
      );
    case "method":
      return (
        <svg {...p}>
          <path d="M3 17l4.5-8 4.5 8 4.5-8 4.5 8" />
          <path d="M3 21h18" />
        </svg>
      );
  }
};

const ROUTES = [
  { to: "/", key: "overview" as const, end: true },
  { to: "/map", key: "map" as const, end: false },
  { to: "/inspect", key: "inspect" as const, end: false },
  { to: "/ledger", key: "ledger" as const, end: false },
  { to: "/method", key: "method" as const, end: false },
];

function ThemeSwitch() {
  const { t, theme, setTheme } = usePrefs();
  const opts: { v: Theme; label: string }[] = [
    { v: "system", label: t.toggles.themeSystem },
    { v: "light", label: t.toggles.themeLight },
    { v: "dark", label: t.toggles.themeDark },
  ];
  return (
    <div className="seg" role="radiogroup" aria-label={t.toggles.theme}>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={theme === o.v}
          className={`seg-btn ${theme === o.v ? "is-on" : ""}`}
          onClick={() => setTheme(o.v)}
          title={o.label}
        >
          <ThemeGlyph v={o.v} />
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function ThemeGlyph({ v }: { v: Theme }) {
  const p = { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": true, focusable: false, fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" } as const;
  if (v === "light")
    return (
      <svg {...p}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
      </svg>
    );
  if (v === "dark")
    return (
      <svg {...p}>
        <path d="M13.2 10.2A5.6 5.6 0 0 1 5.8 2.8a5.6 5.6 0 1 0 7.4 7.4z" />
      </svg>
    );
  return (
    <svg {...p}>
      <rect x="1.8" y="3" width="12.4" height="8.4" rx="1.2" />
      <path d="M5.5 14h5" />
    </svg>
  );
}

function LangSwitch() {
  const { t, lang, setLang } = usePrefs();
  const next = lang === "en" ? "ur" : "en";
  return (
    <button
      type="button"
      className={`lang-btn ${next === "ur" ? "to-ur" : "to-en"}`}
      onClick={() => setLang(next)}
      aria-label={t.toggles.langLabel}
      title={next === "ur" ? "Urdu translation not yet reviewed by a native reader" : undefined}
      lang={next}
    >
      {next === "ur" ? t.toggles.toUrdu : t.toggles.toEnglish}
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { t, lang } = usePrefs();
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page on route change so keyboard and screen reader users land on new content.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [loc.pathname]);

  return (
    <div className="app">
      <a className="skip" href="#main">
        {t.nav.skip}
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand" aria-label={`${t.appName}, ${t.nav.overview}`}>
            <Logo size={34} />
            <span className="brand-words">
              <span className="brand-name">Bhatta</span>
              <span className="brand-ur" lang="ur" dir="rtl">
                بھٹہ
              </span>
            </span>
          </Link>
          <nav className="topnav" aria-label={t.nav.main}>
            {ROUTES.map((r) => (
              <NavLink key={r.to} to={r.to} end={r.end} className="topnav-link">
                {t.nav[r.key]}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-tools">
            {FIXTURE && <span className="sample-pill sample-pill-top">{t.sample.badge}</span>}
            <LangSwitch />
            <ThemeSwitch />
          </div>
        </div>
        {lang === "ur" && (
          <div className="urdu-note" role="note">
            <span lang="ur">{t.toggles.urduNote}</span>
            <span lang="en" dir="ltr">
              Urdu translation not yet reviewed by a native reader
            </span>
          </div>
        )}
      </header>
      <SampleBanner />
      <main id="main" ref={mainRef} tabIndex={-1} className="main">
        {children}
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <Logo size={22} />
          <p>{t.footer.licence}</p>
          <p>{t.footer.code}</p>
        </div>
      </footer>
      <nav className="tabbar" aria-label={t.nav.main}>
        {ROUTES.map((r) => (
          <NavLink key={r.to} to={r.to} end={r.end} className="tab">
            <NavIcon name={r.key} />
            <span>{t.nav[r.key]}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
