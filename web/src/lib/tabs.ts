// Open-file tabs (VS Code style): a small external store persisted in localStorage.
import { useSyncExternalStore } from "react";
import type { FsItem } from "./api";

export type Tab = Pick<FsItem, "path" | "name" | "size" | "modified_unix"> & { is_dir: false };
type State = { tabs: Tab[]; active: string | null };
const KEY = "dh_tabs";
const MAX = 20;

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "") as State;
    if (Array.isArray(s.tabs)) return { tabs: s.tabs.slice(0, MAX), active: s.tabs.some((t) => t.path === s.active) ? s.active : null };
  } catch {
    /* ignore */
  }
  return { tabs: [], active: null };
}

let state = load();
const subs = new Set<() => void>();
function set(next: State) {
  state = next;
  localStorage.setItem(KEY, JSON.stringify(state));
  subs.forEach((f) => f());
}

export const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

export const tabs = {
  get: () => state,
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
  open(i: FsItem) {
    const t: Tab = { path: i.path, name: i.name, size: i.size, modified_unix: i.modified_unix, is_dir: false };
    const has = state.tabs.some((x) => x.path === i.path);
    set({ tabs: has ? state.tabs.map((x) => (x.path === i.path ? t : x)) : [...state.tabs, t].slice(-MAX), active: i.path });
  },
  activate(path: string | null) {
    if (state.active !== path) set({ ...state, active: path });
  },
  close(path: string) {
    const i = state.tabs.findIndex((t) => t.path === path);
    if (i < 0) return;
    const rest = state.tabs.filter((t) => t.path !== path);
    let active = state.active;
    if (active === path) active = rest.length ? rest[Math.min(i, rest.length - 1)].path : null;
    set({ tabs: rest, active });
  },
  closeOthers(path: string) {
    set({ tabs: state.tabs.filter((t) => t.path === path), active: path });
  },
  closeAll() {
    set({ tabs: [], active: null });
  },
  /** Keep tabs in sync after rename / move / delete. */
  forget(paths: string[]) {
    const gone = (p: string) => paths.some((x) => p === x || p.startsWith(x + "/"));
    if (!state.tabs.some((t) => gone(t.path))) return;
    const rest = state.tabs.filter((t) => !gone(t.path));
    set({ tabs: rest, active: state.active && gone(state.active) ? null : state.active });
  },
};

export function useTabs(): State {
  return useSyncExternalStore(tabs.subscribe, tabs.get);
}
