// Shared admin update state store: single source of truth + deduplicated polling
// consumed by both the top-left UpdatePopover and the full admin UpdatePage.
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, call } from "./api";
import { errMsg } from "./util";
import { getVersionState, pollVersion, syncVersionHint } from "./version";

export type UpdateArtifact = {
  kind: string;
  platform: string;
  url: string;
  sha256: string;
  size: number;
  image?: string;
  version_code?: number;
};

export type UpdateManifest = {
  version: string;
  channel: string;
  api_version: number;
  min_client_version: string;
  released_at: string;
  notes: string;
  artifacts: UpdateArtifact[];
};

export type UpdateLastCheck = {
  checked_at: number;
  source_url: string;
  channel: string;
  latest: UpdateManifest | null;
  update_available: boolean;
  key_id: string | null;
  error: string | null;
};

export type UpdateStatus = {
  state: string;
  from_version: string | null;
  target_version: string | null;
  progress_bytes: number;
  total_bytes: number;
  message: string;
  error: string | null;
  actor: string;
  started_at: number;
  updated_at: number;
  commands: string[];
  log: string[];
};

export type UpdateSettings = {
  auto_check: boolean;
  mode: "notify" | "download" | "install";
  source_url: string;
  channel: string;
  interval_secs: number;
  window_start: string;
  window_end: string;
  notify_webhook: string;
  notify_email: string;
};

export type UpdateEffective = {
  check_enabled: boolean;
  source_url: string;
  channel: string;
  interval_secs: number;
  deployment: string;
  platform: string;
  exe_path: string | null;
  restart: string;
  docker_socket: string | null;
  can_auto_install: boolean;
  trusted_key_ids: string[];
  db_backups: string[];
};

export type UpdateOverview = {
  current_version: string;
  status: UpdateStatus;
  last_check: UpdateLastCheck | null;
  settings: UpdateSettings;
  effective: UpdateEffective;
};

export type UpdateTone = "neutral" | "accent" | "ok" | "danger" | "warn";

export const UPDATE_STATE_META: Record<string, [string, UpdateTone]> = {
  idle: ["空闲", "neutral"],
  checking: ["检查中", "accent"],
  downloading: ["下载中", "accent"],
  verifying: ["校验中", "accent"],
  ready: ["已下载，待安装", "ok"],
  backing_up: ["备份数据库", "accent"],
  installing: ["安装中", "accent"],
  restarting: ["重启重连中", "accent"],
  health_check: ["健康检查", "accent"],
  rolling_back: ["回滚中", "warn"],
  succeeded: ["更新成功", "ok"],
  failed: ["更新失败", "danger"],
  rolled_back: ["已回滚", "warn"],
  manual: ["需手动更新", "warn"],
};

export const UPDATE_BUSY_STATES = new Set([
  "checking",
  "downloading",
  "verifying",
  "backing_up",
  "installing",
  "restarting",
  "health_check",
  "rolling_back",
]);

export type UpdateActionKind = "check" | "download" | "apply" | "save" | null;

export type AdminUpdateState = {
  overview: UpdateOverview | null;
  loading: boolean;
  busy: UpdateActionKind;
  offline: boolean;
  /** Initial server version seen by this store before any in-session upgrade. */
  startVersion: string | null;
  /** True once an apply was triggered in this session and succeeded, or server version changed. */
  upgraded: boolean;
  /** Last load error (non-restart errors like 403/500). */
  loadError: string | null;
  lastFetchedAt: number;
};

const INITIAL_STATE: AdminUpdateState = {
  overview: null,
  loading: false,
  busy: null,
  offline: false,
  startVersion: null,
  upgraded: false,
  loadError: null,
  lastFetchedAt: 0,
};

let state: AdminUpdateState = { ...INITIAL_STATE };
let appliedInSession = false;
let inflightLoad: Promise<UpdateOverview | null> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let adminSubscribers = 0;

const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function setState(patch: Partial<AdminUpdateState>) {
  state = { ...state, ...patch };
  emit();
}

export function isUpdateBusy(overview: UpdateOverview | null): boolean {
  return !!overview?.status && UPDATE_BUSY_STATES.has(overview.status.state);
}

export function fmtVersion(v: string | null | undefined): string {
  if (!v) return "—";
  return v.startsWith("v") ? v : `v${v}`;
}

/** Builds copyable host commands for Docker deployments without socket access. */
export function dockerManualCommands(overview: UpdateOverview | null): string[] {
  if (!overview) return [];
  const raw = overview.status.commands.filter((c) => !c.trim().startsWith("#") && c.trim().length > 0);
  if (raw.length > 0) return raw;
  const image = overview.last_check?.latest?.artifacts.find((a) => a.kind === "docker")?.image;
  return image
    ? ["docker compose pull && docker compose up -d", `docker pull ${image}`]
    : ["docker compose pull && docker compose up -d"];
}

/** Strips basic markdown syntax from release notes into concise summary lines for the popover. */
export function summarizeReleaseNotes(md: string | null | undefined, maxLines = 4): string[] {
  if (!md) return [];
  const lines: string[] = [];
  for (const raw of md.split(/\r?\n/)) {
    const cleaned = raw
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "• ")
      .replace(/^\d+\.\s+/, "• ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .trim();
    if (!cleaned || /^[-*_]{3,}$/.test(cleaned)) continue;
    lines.push(cleaned);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

function applyOverview(v: UpdateOverview) {
  const baseline = state.startVersion ?? getVersionState().initial ?? v.current_version;
  const versionChanged = !!baseline && v.current_version !== baseline;
  const succeeded = appliedInSession && v.status.state === "succeeded";
  const upgraded = state.upgraded || versionChanged || succeeded;
  if (versionChanged || !UPDATE_BUSY_STATES.has(v.status.state)) {
    if (v.status.state === "failed" || v.status.state === "rolled_back" || v.status.state === "manual") {
      appliedInSession = false;
    }
  }
  syncVersionHint({
    current: v.current_version,
    latest: v.last_check?.latest?.version ?? null,
    updateAvailable: !!v.last_check?.update_available,
  });
  setState({
    overview: v,
    loading: false,
    offline: false,
    startVersion: baseline,
    upgraded,
    loadError: null,
    lastFetchedAt: Date.now(),
  });
  reconcilePolling();
}

function isTransientRestartError(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.status === 502 || e.status === 503 || e.status === 504 || e.status === 0;
  }
  // Network failure (TypeError: Failed to fetch) while server restarts
  return true;
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function shouldPoll(): boolean {
  if (adminSubscribers <= 0) return false;
  return state.offline || isUpdateBusy(state.overview);
}

function reconcilePolling() {
  if (shouldPoll()) {
    if (pollTimer === null) {
      pollTimer = setInterval(() => {
        void pollTick();
      }, 1000);
    }
  } else {
    stopPolling();
  }
}

async function pollTick() {
  if (!shouldPoll()) {
    stopPolling();
    return;
  }
  const st = state.overview?.status.state;
  const restarting = state.offline || st === "restarting" || st === "installing" || st === "health_check";
  if (restarting) {
    // Poll lightweight unauthenticated /api/version first to detect server recovery immediately
    const ver = await pollVersion();
    if (!ver) {
      if (!state.offline) setState({ offline: true });
      return;
    }
    const baseline = state.startVersion ?? getVersionState().initial;
    if (baseline && ver.server_version && ver.server_version !== baseline) {
      setState({ upgraded: true });
    }
  }
  await loadStatus({ silent: true });
}

export async function loadStatus(opts: { silent?: boolean; force?: boolean } = {}): Promise<UpdateOverview | null> {
  if (!opts.force && inflightLoad) return inflightLoad;
  if (!opts.silent && !state.overview) setState({ loading: true, loadError: null });
  const run: Promise<UpdateOverview | null> = (async () => {
    try {
      const v = await call<UpdateOverview>("GET", "/api/admin/update/status");
      applyOverview(v);
      return v;
    } catch (e) {
      const wasActive = state.offline || isUpdateBusy(state.overview) || appliedInSession;
      if (wasActive && isTransientRestartError(e)) {
        setState({ loading: false, offline: true });
        reconcilePolling();
      } else {
        setState({ loading: false, loadError: errMsg(e) });
        stopPolling();
      }
      return null;
    }
  })().finally(() => {
    if (inflightLoad === run) inflightLoad = null;
  });
  inflightLoad = run;
  return run;
}

/** Fetches status if missing or stale (default 15s), deduplicated across all mounted consumers. */
export function ensureStatusLoaded(maxAgeMs = 15_000): Promise<UpdateOverview | null> {
  if (state.overview && Date.now() - state.lastFetchedAt < maxAgeMs && !state.offline) {
    return Promise.resolve(state.overview);
  }
  return loadStatus();
}

async function runAction(kind: Exclude<UpdateActionKind, null>, fn: () => Promise<UpdateOverview>): Promise<UpdateOverview> {
  setState({ busy: kind, loadError: null });
  try {
    const v = await fn();
    applyOverview(v);
    return v;
  } catch (e) {
    if (kind === "apply" && isTransientRestartError(e)) {
      setState({ offline: true });
      reconcilePolling();
    } else {
      void loadStatus({ silent: true });
    }
    throw e;
  } finally {
    setState({ busy: null });
  }
}

export const updateStore = {
  load: loadStatus,
  ensureLoaded: ensureStatusLoaded,
  check: () => runAction("check", () => call<UpdateOverview>("POST", "/api/admin/update/check")),
  apply: (downloadOnly = false) => {
    if (!downloadOnly) appliedInSession = true;
    return runAction(downloadOnly ? "download" : "apply", () =>
      call<UpdateOverview>("POST", "/api/admin/update/apply", { download_only: downloadOnly }),
    );
  },
  saveSettings: (s: UpdateSettings) =>
    runAction("save", () =>
      call<UpdateOverview>("PUT", "/api/admin/update/settings", { ...s, interval_secs: Number(s.interval_secs) || 0 }),
    ),
  /** Clears admin state (e.g. on logout or switching to a non-admin account). */
  reset() {
    stopPolling();
    appliedInSession = false;
    inflightLoad = null;
    state = { ...INITIAL_STATE };
    emit();
  },
  getState: () => state,
};

/**
 * Subscribe to the shared admin update state.
 * When `enabled` is false (non-admin / guest), no admin endpoint is ever requested.
 */
export function useAdminUpdate(enabled: boolean, opts: { autoLoad?: boolean } = {}): AdminUpdateState {
  const { autoLoad = true } = opts;
  const snap = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    () => state,
  );

  useEffect(() => {
    if (!enabled) return;
    adminSubscribers += 1;
    if (autoLoad) void ensureStatusLoaded();
    reconcilePolling();
    return () => {
      adminSubscribers = Math.max(0, adminSubscribers - 1);
      if (adminSubscribers === 0) {
        stopPolling();
      }
    };
  }, [enabled, autoLoad]);

  return enabled ? snap : INITIAL_STATE;
}
