// Minimized file windows ("genie" dock). A minimized tab stays in the tab strip and shows up as a dock icon.
import { useSyncExternalStore } from "react";

type State = { min: string[]; restore: { path: string; rect: DOMRect } | null };
let state: State = { min: [], restore: null };
const subs = new Set<() => void>();
const set = (n: State) => ((state = n), subs.forEach((f) => f()));

export const dock = {
  get: () => state,
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  minimize: (path: string) => !state.min.includes(path) && set({ ...state, min: [...state.min, path] }),
  /** Restore from the dock: remember the icon rect so the window can genie out of it. */
  restore: (path: string, rect: DOMRect) => set({ min: state.min.filter((p) => p !== path), restore: { path, rect } }),
  forget: (path: string) => state.min.includes(path) && set({ ...state, min: state.min.filter((p) => p !== path) }),
  consumeRestore: (path: string) => {
    const r = state.restore?.path === path ? state.restore.rect : null;
    if (r) state = { ...state, restore: null };
    return r;
  },
  prune: (alive: string[]) => {
    const min = state.min.filter((p) => alive.includes(p));
    if (min.length !== state.min.length) set({ ...state, min });
  },
};
export const useDock = () => useSyncExternalStore(dock.subscribe, dock.get);
