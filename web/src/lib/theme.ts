import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const mq = () => window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && mq().matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0c0e" : "#f6f5f3");
}

export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem("dh_theme") as ThemePref) || "system");
  useEffect(() => {
    applyTheme(pref);
    localStorage.setItem("dh_theme", pref);
    if (pref !== "system") return;
    const m = mq();
    const f = () => applyTheme("system");
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [pref]);
  return [pref, setPref];
}
