import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
export type SkinId = "paper" | "bento" | "swiss";

export interface SkinMeta {
  id: SkinId;
  label: string;
  shortLabel: string;
  description: string;
  /** Light preview swatches: [canvas, card, accent] */
  swatches: readonly [string, string, string];
  /** Dark preview swatches: [canvas, card, accent] */
  darkSwatches: readonly [string, string, string];
  /** Corner preview indicator */
  radiusHint: "soft" | "round" | "sharp";
}

export const THEME_STORAGE_KEY = "dh_theme";
export const SKIN_STORAGE_KEY = "dh_skin";

export const SKINS: readonly SkinMeta[] = [
  {
    id: "paper",
    label: "暖纸 Paper",
    shortLabel: "暖纸",
    description: "温润纸感与四层留白，克制柔和",
    swatches: ["#f4f2ee", "#ffffff", "#c83e1c"],
    darkSwatches: ["#121110", "#1d1c1a", "#f07454"],
    radiusHint: "soft",
  },
  {
    id: "bento",
    label: "Bento 瓷片",
    shortLabel: "Bento",
    description: "大圆角便当瓷片、清晰投影与钴蓝强调",
    swatches: ["#eceef2", "#ffffff", "#3048d8"],
    darkSwatches: ["#0e1016", "#171b24", "#7b8cff"],
    radiusHint: "round",
  },
  {
    id: "swiss",
    label: "瑞士网格 Swiss",
    shortLabel: "瑞士",
    description: "零圆角利落栅格线、高对比排版与信号红",
    swatches: ["#f3f3ef", "#ffffff", "#d0021b"],
    darkSwatches: ["#0a0a0a", "#141414", "#ff3b47"],
    radiusHint: "sharp",
  },
] as const;

const THEME_BG: Record<SkinId, { light: string; dark: string }> = {
  paper: { light: "#f4f2ee", dark: "#121110" },
  bento: { light: "#eceef2", dark: "#0e1016" },
  swiss: { light: "#f3f3ef", dark: "#0a0a0a" },
};

const mq = () => window.matchMedia("(prefers-color-scheme: dark)");

export function normalizeTheme(raw: string | null | undefined): ThemePref {
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function normalizeSkin(raw: string | null | undefined): SkinId {
  return raw === "bento" || raw === "swiss" || raw === "paper" ? raw : "paper";
}

function readTheme(): ThemePref {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function readSkin(): SkinId {
  try {
    return normalizeSkin(localStorage.getItem(SKIN_STORAGE_KEY));
  } catch {
    return "paper";
  }
}

export function isDarkResolved(pref: ThemePref = readTheme()): boolean {
  return pref === "dark" || (pref === "system" && mq().matches);
}

function syncMetaThemeColor(skin: SkinId, dark: boolean) {
  const palette = THEME_BG[skin] ?? THEME_BG.paper;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? palette.dark : palette.light);
}

const themeListeners = new Set<(p: ThemePref) => void>();
const skinListeners = new Set<(s: SkinId) => void>();

export function applyTheme(pref: ThemePref) {
  const next = normalizeTheme(pref);
  const dark = isDarkResolved(next);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const activeSkin = normalizeSkin(document.documentElement.dataset.skin ?? readSkin());
  syncMetaThemeColor(activeSkin, dark);
}

export function applySkin(skin: SkinId) {
  const next = normalizeSkin(skin);
  document.documentElement.dataset.skin = next;
  const dark = document.documentElement.dataset.theme === "dark" || isDarkResolved();
  syncMetaThemeColor(next, dark);
}

export function setThemePref(pref: ThemePref) {
  const next = normalizeTheme(pref);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // ignore private browsing quota errors
  }
  applyTheme(next);
  themeListeners.forEach((fn) => fn(next));
}

export function setSkinPref(skin: SkinId) {
  const next = normalizeSkin(skin);
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, next);
  } catch {
    // ignore private browsing quota errors
  }
  applySkin(next);
  skinListeners.forEach((fn) => fn(next));
}

export function getSkin(): SkinId {
  return readSkin();
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => readTheme());
  useEffect(() => {
    applyTheme(pref);
    const onSub = (next: ThemePref) => setPref(next);
    themeListeners.add(onSub);
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) {
        const next = normalizeTheme(e.newValue);
        applyTheme(next);
        setPref(next);
      }
    };
    window.addEventListener("storage", onStorage);
    const m = mq();
    const onMedia = () => {
      if (readTheme() === "system") applyTheme("system");
    };
    m.addEventListener("change", onMedia);
    return () => {
      themeListeners.delete(onSub);
      window.removeEventListener("storage", onStorage);
      m.removeEventListener("change", onMedia);
    };
  }, [pref]);
  return [pref, setThemePref];
}

export function useSkin(): [SkinId, (s: SkinId) => void] {
  const [skin, setSkin] = useState<SkinId>(() => readSkin());
  useEffect(() => {
    applySkin(skin);
    const onSub = (next: SkinId) => setSkin(next);
    skinListeners.add(onSub);
    const onStorage = (e: StorageEvent) => {
      if (e.key === SKIN_STORAGE_KEY) {
        const next = normalizeSkin(e.newValue);
        applySkin(next);
        setSkin(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      skinListeners.delete(onSub);
      window.removeEventListener("storage", onStorage);
    };
  }, [skin]);
  return [skin, setSkinPref];
}

export function useResolvedDark(): boolean {
  const [theme] = useTheme();
  const [dark, setDark] = useState(() => isDarkResolved(theme));
  useEffect(() => {
    const sync = () => setDark(isDarkResolved(theme));
    sync();
    if (theme !== "system") return;
    const m = mq();
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, [theme]);
  return dark;
}
