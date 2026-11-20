// Detects that the server (or the web bundle on disk) changed under an open page:
// every API response carries x-drivehub-server-version, and /api/version is polled
// (every 5 min and when the tab regains focus) for server_version and web_build.
import { useSyncExternalStore } from "react";

export const WEB_BUILD = __WEB_BUILD__;

export type VersionState = {
  /** Server version seen when this page loaded. */
  initial: string | null;
  /** Latest server version observed. */
  current: string | null;
  /** The page should be reloaded (server upgraded or a newer web bundle is deployed). */
  stale: boolean;
};

let state: VersionState = { initial: null, current: null, stale: false };
const subs = new Set<() => void>();
const set = (p: Partial<VersionState>) => {
  const next = { ...state, ...p };
  next.stale = !!(next.initial && next.current && next.initial !== next.current) || (p.stale ?? state.stale);
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  subs.forEach((f) => f());
};

/** Called for every API response (header x-drivehub-server-version). */
export function noteServerVersion(v: string | null) {
  if (!v) return;
  if (!state.initial) set({ initial: v, current: v });
  else if (v !== state.current) set({ current: v });
}

export function noteResponse(r: Response) {
  noteServerVersion(r.headers.get("x-drivehub-server-version"));
}

export async function pollVersion() {
  try {
    const r = await fetch("/api/version", { cache: "no-store" });
    if (!r.ok) return;
    noteResponse(r);
    const v = await r.json();
    noteServerVersion(v.server_version);
    const bundleChanged = import.meta.env.PROD && !!v.web_build && v.web_build !== WEB_BUILD;
    if (bundleChanged) set({ stale: true });
  } catch {
    /* server restarting -- try again later */
  }
}

let started = false;
export function startVersionWatch(intervalMs = 5 * 60_000) {
  if (started) return;
  started = true;
  pollVersion();
  setInterval(pollVersion, intervalMs);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && pollVersion());
  window.addEventListener("focus", () => pollVersion());
}

export function useVersion(): VersionState {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => state,
  );
}

