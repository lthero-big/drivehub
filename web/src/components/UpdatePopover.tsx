import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpCircle,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  HardDrive,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { WEB_VERSION } from "../lib/api";
import { useApp } from "../lib/app";
import { go } from "../lib/router";
import {
  dockerManualCommands,
  fmtVersion,
  isUpdateBusy,
  summarizeReleaseNotes,
  UPDATE_STATE_META,
  updateStore,
  useAdminUpdate,
  type UpdateTone,
} from "../lib/update";
import { cx, errMsg, fmtSize, fmtTime } from "../lib/util";
import { useVersion, WEB_BUILD } from "../lib/version";
import { Button, IconButton, Progress, toast } from "../ui/ui";

type PopPlacement = "bottom" | "right";

function useAnchorPosition(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null>,
  popRef: React.RefObject<HTMLElement | null>,
  placement: PopPlacement,
) {
  const [style, setStyle] = useState<React.CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
    visibility: "hidden",
  });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const M = 8;
      const gap = placement === "right" ? 10 : 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const r = anchor.getBoundingClientRect();
      pop.style.maxHeight = "";
      const w = pop.offsetWidth || 336;
      const h = pop.scrollHeight;

      let left: number;
      let top: number;
      if (placement === "right" && r.right + gap + w <= vw - M) {
        left = r.right + gap;
        top = r.top;
      } else {
        left = r.left;
        top = r.bottom + gap;
      }

      left = Math.max(M, Math.min(left, vw - M - w));
      const maxH = vh - 2 * M;
      if (top + Math.min(h, maxH) > vh - M) {
        top = Math.max(M, vh - M - Math.min(h, maxH));
      }
      setStyle({
        position: "fixed",
        top,
        left,
        maxHeight: h > vh - top - M ? Math.max(200, vh - top - M) : undefined,
        transformOrigin: placement === "right" ? "left top" : "left top",
      });
    };

    place();
    const ro = new ResizeObserver(place);
    if (popRef.current) ro.observe(popRef.current);
    if (anchorRef.current) ro.observe(anchorRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, popRef, placement]);

  return style;
}

function StatusPill({ tone, label, spinning, pulsing }: { tone: UpdateTone; label: string; spinning?: boolean; pulsing?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium leading-none",
        tone === "neutral" && "bg-hover text-muted",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "ok" && "bg-ok/12 text-ok",
        tone === "danger" && "bg-danger/12 text-danger",
        tone === "warn" && "bg-warn/15 text-warn",
      )}
    >
      {spinning ? (
        <Loader2 className="size-3 animate-spin shrink-0" />
      ) : (
        <span className="relative flex size-2 shrink-0">
          {pulsing && (
            <span
              aria-hidden
              className={cx(
                "upd-pulse-ring absolute inset-0 rounded-full",
                tone === "accent" ? "bg-accent" : tone === "ok" ? "bg-ok" : "bg-brand",
              )}
            />
          )}
          <span
            className={cx(
              "relative inline-flex size-2 rounded-full",
              tone === "neutral" && "bg-faint",
              tone === "accent" && "bg-accent",
              tone === "ok" && "bg-ok",
              tone === "danger" && "bg-danger",
              tone === "warn" && "bg-warn",
            )}
          />
        </span>
      )}
      <span>{label}</span>
    </span>
  );
}

export function UpdatePopover({
  mini,
  serverVersion,
  updateAvailable: updateAvailableProp,
  onNavigate,
}: {
  mini: boolean;
  serverVersion?: string;
  updateAvailable?: boolean;
  onNavigate?: () => void;
}) {
  const { isAdmin } = useApp();
  const live = useVersion();
  const admin = useAdminUpdate(isAdmin, { autoLoad: true });

  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [copied, setCopied] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  const overview = isAdmin ? admin.overview : null;
  const st = overview?.status ?? null;
  const lc = overview?.last_check ?? null;
  const manifest = lc?.latest ?? null;
  const eff = overview?.effective ?? null;

  const running = isAdmin && (isUpdateBusy(overview) || admin.offline);
  const currentVer = overview?.current_version ?? live.current ?? serverVersion ?? null;
  const latestVer = manifest?.version ?? live.latest ?? null;
  const updateAvailable = isAdmin
    ? (lc?.update_available ?? (updateAvailableProp ?? live.updateAvailable))
    : false;
  const needsRefresh = (isAdmin && admin.upgraded) || live.stale;
  const canAutoInstall = !!eff?.can_auto_install;
  const isDockerManual = eff?.deployment === "docker" && !eff.can_auto_install;
  const checkEnabled = eff ? eff.check_enabled : true;

  const pct = st && st.total_bytes > 0 ? Math.min(1, st.progress_bytes / st.total_bytes) : 0;
  const pctLabel = st && st.total_bytes > 0 ? `${Math.round(pct * 100)}%` : null;

  const posStyle = useAnchorPosition(open, triggerRef, popRef, mini ? "right" : "bottom");

  // Refresh admin overview on popover open (deduplicated with UpdatePage)
  useEffect(() => {
    if (open && isAdmin) {
      void updateStore.ensureLoaded(10_000);
    }
    if (!open) {
      setArmed(false);
    }
  }, [open, isAdmin]);

  // Auto-disarm inline confirmation after 10s
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 10_000);
    return () => clearTimeout(t);
  }, [armed]);

  // Focus confirm button when armed
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => popRef.current?.querySelector<HTMLElement>("[data-update-confirm]")?.focus(), 0);
    return () => clearTimeout(t);
  }, [armed]);

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (armed) {
        setArmed(false);
        return;
      }
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, armed]);

  const handleCheck = async () => {
    if (!isAdmin || running || !checkEnabled) return;
    try {
      const next = await updateStore.check();
      if (next.last_check?.error) {
        toast.err(next.last_check.error);
      } else if (next.last_check?.update_available && next.last_check.latest) {
        toast.ok(`发现新版本 ${fmtVersion(next.last_check.latest.version)}`);
      } else {
        toast.info("当前已是最新版本");
      }
    } catch (e) {
      toast.err(errMsg(e));
    }
  };

  const handleApply = async () => {
    if (!isAdmin || running) return;
    setArmed(false);
    try {
      await updateStore.apply(false);
    } catch (e) {
      if (!updateStore.getState().offline) {
        toast.err(errMsg(e));
      }
    }
  };

  const handleCopyCommands = async () => {
    const cmds = dockerManualCommands(overview);
    if (!cmds.length) return;
    try {
      await navigator.clipboard?.writeText(cmds.join("\n"));
      setCopied(true);
      toast.ok("已复制宿主机升级命令");
      setTimeout(() => setCopied(false), 2200);
    } catch {
      toast.err("复制失败，请手动复制");
    }
  };

  const openFullUpdatePage = () => {
    setOpen(false);
    onNavigate?.();
    go("#/admin/update");
  };

  // Derive header status pill
  const headerStatus = ((): { label: string; tone: UpdateTone; spinning?: boolean; pulsing?: boolean } => {
    if (needsRefresh) {
      return isAdmin && admin.upgraded
        ? { label: "更新完成", tone: "ok", pulsing: true }
        : { label: "有新版本可刷新", tone: "ok", pulsing: true };
    }
    if (!isAdmin) {
      return { label: "版本信息", tone: "neutral" };
    }
    if (admin.offline) {
      return { label: "重启重连中", tone: "accent", spinning: true };
    }
    if (st && isUpdateBusy(overview)) {
      const [label, tone] = UPDATE_STATE_META[st.state] ?? [st.state, "accent"];
      return { label, tone, spinning: true };
    }
    if (!checkEnabled) {
      return { label: "离线模式", tone: "warn" };
    }
    if (st?.state === "failed") {
      return { label: "更新失败", tone: "danger" };
    }
    if (st?.state === "rolled_back") {
      return { label: "已回滚", tone: "warn" };
    }
    if (st?.state === "manual") {
      return { label: "需手动更新", tone: "warn" };
    }
    if (st?.state === "ready" && updateAvailable) {
      return { label: "已下载，待安装", tone: "ok" };
    }
    if (lc?.error) {
      return { label: "检查失败", tone: "danger" };
    }
    if (updateAvailable) {
      return { label: "有可用更新", tone: "accent", pulsing: true };
    }
    if (admin.loading && !overview) {
      return { label: "读取中", tone: "neutral", spinning: true };
    }
    return { label: "已是最新", tone: "ok" };
  })();

  // Trigger compact pill text & label
  const triggerAriaLabel = (() => {
    const base = `DriveHub ${fmtVersion(currentVer)}`;
    if (needsRefresh) return `${base}，新版本已就绪，点击刷新`;
    if (running) return `${base}，正在更新，点击查看进度`;
    if (isAdmin && updateAvailable && latestVer) return `${base}，有新版本 ${fmtVersion(latestVer)} 可用，点击查看更新`;
    return `${base}，点击查看版本信息`;
  })();

  const releaseLines = summarizeReleaseNotes(manifest?.notes, 4);
  const serverArt =
    eff?.deployment === "docker"
      ? undefined
      : manifest?.artifacts.find((a) => a.kind === "server" && eff && a.platform === eff.platform);
  const dockerCmds = isDockerManual ? dockerManualCommands(overview) : [];
  const showCompare = isAdmin && (updateAvailable || running || (admin.upgraded && admin.startVersion && admin.startVersion !== currentVer));
  const compareFrom = admin.upgraded && admin.startVersion ? admin.startVersion : (st?.from_version ?? currentVer);
  const compareTo = admin.upgraded ? currentVer : (st?.target_version ?? latestVer);
  const runningHint = admin.offline
    ? "服务正在重启，自动轮询 /api/version 等待新版本上线…"
    : st?.state === "restarting"
      ? "正在重启服务，自动检测新版本上线…"
      : st?.message || "正在执行更新…";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-update-trigger
        data-update-state={needsRefresh ? "refresh" : running ? "running" : updateAvailable ? "available" : "idle"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={triggerAriaLabel}
        title={mini ? triggerAriaLabel : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "group relative flex min-w-0 items-center gap-2.5 rounded-xl text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 active:scale-[0.98]",
          mini ? "size-10 justify-center p-0" : "flex-1 px-1.5 py-1",
          open ? "bg-hover" : "hover:bg-hover/80",
        )}
      >
        <span className="relative flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-card transition-transform duration-150 group-hover:scale-[1.03]">
          <HardDrive className={cx("size-[18px] transition-opacity", running && "opacity-90")} />

          {/* Corner status badge: running spinner / refresh ok dot / breathing update dot */}
          {running ? (
            <span
              data-update-indicator="running"
              aria-hidden
              className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-panel text-accent shadow-card ring-2 ring-bg"
            >
              <Loader2 className="size-2.5 animate-spin stroke-[2.75]" />
            </span>
          ) : needsRefresh ? (
            <span data-update-indicator="refresh" aria-hidden className="absolute -top-1 -right-1 flex size-3">
              <span className="upd-pulse-ring absolute inset-0 rounded-full bg-ok" />
              <span className="relative inline-flex size-3 rounded-full bg-ok ring-2 ring-bg" />
            </span>
          ) : isAdmin && updateAvailable ? (
            <span data-update-indicator="available" aria-hidden className="absolute -top-1 -right-1 flex size-3">
              <span className="upd-pulse-ring absolute inset-0 rounded-full bg-brand" />
              <span className="relative inline-flex size-3 rounded-full bg-brand ring-2 ring-bg" />
            </span>
          ) : null}
        </span>

        {!mini && (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate text-[16.5px] font-semibold tracking-tight text-fg">DriveHub</span>
            {needsRefresh ? (
              <span
                data-version-pill="refresh"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-ok/15 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold leading-none tabular-nums text-ok"
              >
                新版本 ↻
              </span>
            ) : running ? (
              <span
                data-version-pill="running"
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium leading-none tabular-nums text-accent"
              >
                {pctLabel && st?.state === "downloading" ? pctLabel : admin.offline || st?.state === "restarting" ? "重启中" : "更新中"}
              </span>
            ) : isAdmin && updateAvailable && latestVer ? (
              <span
                data-version-pill="available"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold leading-none tabular-nums text-accent ring-1 ring-accent/25"
              >
                {fmtVersion(latestVer)} ↑
              </span>
            ) : currentVer ? (
              <span
                data-version-pill="current"
                className="inline-flex shrink-0 items-center rounded-md bg-hover px-1.5 py-0.5 font-mono text-[10.5px] font-medium leading-none tabular-nums text-muted"
              >
                {fmtVersion(currentVer)}
              </span>
            ) : null}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            role="dialog"
            aria-label="系统版本与更新"
            data-update-popover
            style={posStyle}
            className="upd-pop-in pop-surface scroll-thin z-[75] w-[336px] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-2xl text-fg"
          >
            {/* Header: Status pill + check update icon button (admin only) */}
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
              <StatusPill
                tone={headerStatus.tone}
                label={headerStatus.label}
                spinning={headerStatus.spinning}
                pulsing={headerStatus.pulsing}
              />
              {isAdmin && (
                <IconButton
                  size="sm"
                  label={checkEnabled ? "检查更新" : "已关闭更新检查"}
                  disabled={!checkEnabled || running || admin.busy === "check"}
                  onClick={handleCheck}
                  data-update-check
                >
                  <RefreshCw className={cx("size-3.5", (admin.busy === "check" || st?.state === "checking") && "animate-spin")} />
                </IconButton>
              )}
            </div>

            {/* Body: Version comparison, release notes, progress, errors */}
            <div className="space-y-3 p-4">
              {showCompare ? (
                <div className="rounded-xl border border-line/80 bg-panel-2 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] text-faint">当前版本</p>
                      <p className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-fg">
                        {fmtVersion(compareFrom)}
                      </p>
                    </div>
                    <span
                      aria-hidden
                      className={cx(
                        "flex size-7 shrink-0 items-center justify-center rounded-full",
                        needsRefresh ? "bg-ok/12 text-ok" : "bg-accent-soft text-accent",
                      )}
                    >
                      {needsRefresh ? <Check className="size-3.5 stroke-[2.5]" /> : <ArrowRight className="size-3.5" />}
                    </span>
                    <div className="min-w-0 text-right">
                      <p className={cx("text-[11px]", needsRefresh ? "text-ok" : "text-accent")}>
                        {needsRefresh ? "已就绪版本" : "最新版本"}
                      </p>
                      <p className={cx("mt-0.5 font-mono text-[15px] font-semibold tabular-nums", needsRefresh ? "text-ok" : "text-accent")}>
                        {fmtVersion(compareTo)}
                      </p>
                    </div>
                  </div>
                  {(manifest?.released_at || serverArt || eff?.deployment) && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/70 pt-2 text-[11.5px] text-faint">
                      {manifest?.released_at && <span>发布于 {manifest.released_at.slice(0, 10)}</span>}
                      {manifest?.released_at && serverArt && <span aria-hidden>·</span>}
                      {serverArt && <span className="tabular-nums">{fmtSize(serverArt.size)}</span>}
                      {manifest?.channel === "beta" && (
                        <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10.5px] font-medium text-warn">beta</span>
                      )}
                      {eff?.deployment && (
                        <span className="ml-auto rounded bg-hover px-1.5 py-0.5 text-[10.5px] text-muted">
                          {eff.deployment === "docker" ? "Docker" : "二进制"}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-line/80 bg-panel-2 p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="min-w-0">
                      <p className="text-[11px] text-faint">服务端版本</p>
                      <p className="mt-0.5 truncate font-mono text-[15px] font-semibold tabular-nums text-fg">
                        {fmtVersion(currentVer)}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] text-faint">Web 版本</p>
                      <p className="mt-0.5 truncate font-mono text-[15px] font-semibold tabular-nums text-fg">
                        {fmtVersion(WEB_VERSION)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-2 text-[11.5px] text-faint">
                    {isAdmin ? (
                      <>
                        <span>上次检查：{lc ? fmtTime(lc.checked_at) : "从未"}</span>
                        {eff?.channel && <span className="font-mono text-[11px]">{eff.channel}</span>}
                      </>
                    ) : (
                      <>
                        <span className="truncate font-mono text-[11px]" title={WEB_BUILD}>
                          构建 {WEB_BUILD}
                        </span>
                        {live.stale ? (
                          <span className="font-medium text-ok">待刷新</span>
                        ) : (
                          <span>运行正常</span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Non-admin stale notice */}
              {!isAdmin && live.stale && (
                <div className="flex items-start gap-2 rounded-xl bg-ok/12 px-3 py-2.5 text-[12.5px] leading-snug text-ok">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {live.initial && live.current && live.initial !== live.current
                      ? `服务端已升级至 ${fmtVersion(live.current)}，刷新页面以加载新版本。`
                      : "检测到新版 Web 资源已部署，刷新页面即可加载。"}
                  </span>
                </div>
              )}

              {/* Release notes excerpt (admin with newer release) */}
              {isAdmin && releaseLines.length > 0 && (updateAvailable || running) && !needsRefresh && (
                <div className="space-y-1 rounded-xl bg-panel-2/70 px-3 py-2.5">
                  <p className="text-[11px] font-medium text-faint">更新摘要</p>
                  <div className="space-y-0.5 text-[12.5px] leading-relaxed text-muted">
                    {releaseLines.map((line, i) => (
                      <p key={i} className="line-clamp-2">
                        {line}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {/* Live progress panel during active update / restart reconnect */}
              {isAdmin && running && (
                <div className="space-y-2 rounded-xl border border-accent/25 bg-accent-soft/45 p-3">
                  <div className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="truncate font-medium text-fg">{runningHint}</span>
                    {st?.state === "downloading" && pctLabel && (
                      <span className="shrink-0 font-mono font-semibold tabular-nums text-accent">{pctLabel}</span>
                    )}
                  </div>
                  {st?.state === "downloading" && st.total_bytes > 0 ? (
                    <>
                      <Progress value={pct} />
                      <p className="font-mono text-[11px] tabular-nums text-faint">
                        {fmtSize(st.progress_bytes)} / {fmtSize(st.total_bytes)}
                      </p>
                    </>
                  ) : (
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
                      <div className="upd-bar-indet h-full rounded-full bg-accent" />
                    </div>
                  )}
                </div>
              )}

              {/* Error feedback (update failed / rolled back / check failed / fetch error) */}
              {isAdmin && !running && (st?.error || lc?.error || admin.loadError) && (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2.5 text-[12px] leading-snug text-danger">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0 break-words">{st?.error || lc?.error || admin.loadError}</span>
                </div>
              )}

              {/* Offline check disabled hint */}
              {isAdmin && !checkEnabled && (
                <p className="rounded-xl bg-warn/12 px-3 py-2 text-[12px] text-warn">
                  服务端已关闭更新检查（DRIVEHUB_UPDATE_CHECK=false，内网/离线模式）。
                </p>
              )}

              {/* Docker without socket: host upgrade commands preview */}
              {isAdmin && isDockerManual && (updateAvailable || st?.state === "manual") && !needsRefresh && (
                <div className="space-y-1.5">
                  <p className="flex items-center gap-1.5 text-[11.5px] text-muted">
                    <Terminal className="size-3.5 shrink-0 text-faint" />
                    <span>Docker 未挂载 socket，请在宿主机执行：</span>
                  </p>
                  <pre className="scroll-thin max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-panel-2 p-2.5 font-mono text-[11.5px] leading-relaxed text-fg">
                    {dockerCmds.join("\n")}
                  </pre>
                </div>
              )}
            </div>

            {/* Footer: Primary action area + link to full settings/logs */}
            <div className="space-y-2 border-t border-line bg-panel-2/60 px-4 py-3">
              {needsRefresh ? (
                <button
                  type="button"
                  data-update-reload
                  onClick={() => location.reload()}
                  className="btn-key flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-ok px-3 text-[13px] font-semibold text-white hover:brightness-105"
                >
                  <RotateCcw className="size-4" />
                  <span>
                    {isAdmin && admin.upgraded && currentVer
                      ? `已更新到 ${fmtVersion(currentVer)}，点击刷新`
                      : "刷新加载新版本"}
                  </span>
                </button>
              ) : isAdmin ? (
                running ? (
                  <button
                    type="button"
                    disabled
                    className="flex h-9 w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl bg-accent-soft px-3 text-[13px] font-medium text-accent"
                  >
                    <Loader2 className="size-4 animate-spin" />
                    <span>
                      {admin.offline || st?.state === "restarting"
                        ? "重启重连中…"
                        : st?.state === "downloading" && pctLabel
                          ? `正在下载 ${pctLabel}`
                          : `${headerStatus.label}…`}
                    </span>
                  </button>
                ) : updateAvailable && canAutoInstall && checkEnabled ? (
                  armed ? (
                    <div className="anim-in space-y-2 rounded-xl border border-accent/30 bg-accent-soft/50 p-2.5">
                      <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-muted">
                        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-accent" />
                        <span>将校验签名、自动备份数据库并重启服务（中断数秒，健康检查失败自动回滚）。</span>
                      </p>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="outline" className="flex-1" onClick={() => setArmed(false)}>
                          取消
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          className="flex-[1.4]"
                          data-update-confirm
                          loading={admin.busy === "apply"}
                          onClick={handleApply}
                        >
                          <ArrowUpCircle className="size-3.5" />
                          确认更新
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      className="h-9 w-full text-[13px]"
                      data-update-apply
                      onClick={() => setArmed(true)}
                    >
                      <ArrowUpCircle className="size-4" />
                      {st?.state === "ready"
                        ? `立即安装 ${fmtVersion(latestVer)}`
                        : `立即更新到 ${fmtVersion(latestVer)}`}
                    </Button>
                  )
                ) : isDockerManual && (updateAvailable || st?.state === "manual") ? (
                  <Button
                    variant="primary"
                    size="sm"
                    className="h-9 w-full text-[13px]"
                    data-update-copy-docker
                    onClick={handleCopyCommands}
                  >
                    {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                    {copied ? "已复制宿主机升级命令" : "复制宿主机升级命令"}
                  </Button>
                ) : updateAvailable && !canAutoInstall ? (
                  <p className="text-center text-[12px] text-muted">
                    当前部署环境不支持自动安装，请前往更新页查看详情。
                  </p>
                ) : null
              ) : (
                <p className="text-center text-[12px] text-faint">当前客户端与服务端版本正常</p>
              )}

              {isAdmin && (
                <a
                  href="#/admin/update"
                  onClick={(e) => {
                    e.preventDefault();
                    openFullUpdatePage();
                  }}
                  data-update-settings-link
                  className="flex items-center justify-center gap-1 rounded-lg py-1 text-[12px] font-medium text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  <span>完整更新设置与日志</span>
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
