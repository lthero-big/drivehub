// Per-browser UI preferences (DEPTAI-485 r5), persisted in localStorage.
import { useSyncExternalStore } from "react";

export type Prefs = {
  /** Open files in place (replace the current tab) instead of opening a new tab. */
  openInPlace: boolean;
  /** Collapsed sidebar sections. */
  favsCollapsed: boolean;
  adminCollapsed: boolean;
  /** "全部文件" tree (mount list) collapsed (r6 #10). */
  filesCollapsed: boolean;
  /** Favorites: show every entry (scroll area) instead of the first FAV_LIMIT. */
  favsShowAll: boolean;
  /** Hover preview of images in the file list. */
  hoverPreview: boolean;
};
const KEY = "dh_prefs";
const DEF: Prefs = { openInPlace: false, favsCollapsed: false, adminCollapsed: false, filesCollapsed: false, favsShowAll: false, hoverPreview: true };
let cur: Prefs = (() => {
  try {
    return { ...DEF, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEF;
  }
})();
const subs = new Set<() => void>();
export const prefs = {
  get: () => cur,
  set(p: Partial<Prefs>) {
    cur = { ...cur, ...p };
    localStorage.setItem(KEY, JSON.stringify(cur));
    subs.forEach((f) => f());
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
};
export const usePrefs = () => useSyncExternalStore(prefs.subscribe, prefs.get);
