import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import en, { type Strings } from "./en";
import ur from "./ur";

export type Lang = "en" | "ur";
export type Theme = "system" | "light" | "dark";

const STRINGS: Record<Lang, Strings> = { en, ur };

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}
function writePref(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* storage unavailable */
  }
}

function initialLang(): Lang {
  const fromUrl = new URLSearchParams(window.location.search).get("lang");
  if (fromUrl === "ur" || fromUrl === "en") return fromUrl;
  return readPref<Lang>("bhatta.lang", ["en", "ur"], "en");
}
function initialTheme(): Theme {
  const fromUrl = new URLSearchParams(window.location.search).get("theme");
  if (fromUrl === "light" || fromUrl === "dark") return fromUrl;
  return readPref<Theme>("bhatta.theme", ["system", "light", "dark"], "system");
}

interface Prefs {
  lang: Lang;
  t: Strings;
  setLang: (l: Lang) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** The theme actually shown, after resolving "system". */
  resolvedTheme: "light" | "dark";
}

const Ctx = createContext<Prefs | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = STRINGS[lang].dir;
  }, [lang]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    writePref("bhatta.lang", l);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    writePref("bhatta.theme", t);
  }, []);

  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  const value = useMemo(
    () => ({ lang, t: STRINGS[lang], setLang, theme, setTheme, resolvedTheme }),
    [lang, setLang, theme, setTheme, resolvedTheme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): Prefs {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePrefs outside PrefsProvider");
  return v;
}

export function useT(): Strings {
  return usePrefs().t;
}
