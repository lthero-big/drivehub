import { useEffect, useState } from "react";
import { ArrowUpCircle, Copy, Download, RefreshCw, RotateCcw } from "lucide-react";
import { WEB_VERSION } from "../../lib/api";
import {
  isUpdateBusy,
  UPDATE_BUSY_STATES,
  UPDATE_STATE_META,
  updateStore,
  useAdminUpdate,
  type UpdateSettings,
} from "../../lib/update";
import { errMsg, fmtSize, fmtTime } from "../../lib/util";
import { useVersion, WEB_BUILD } from "../../lib/version";
import { Badge, Button, Card, confirmDlg, Field, Input, Progress, Select, Spinner, Switch, toast } from "../../ui/ui";

const MODES = [
  ["notify", "仅通知", "发现新版本时提示（及 Webhook/邮件通知），由管理员手动更新"],
  ["download", "自动下载", "后台下载并校验，管理员点「立即更新」即可安装"],
  ["install", "自动安装", "在维护时间窗内自动下载、备份、安装并健康检查，失败自动回滚"],
] as const;

function Notes({ md }: { md: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([import("marked"), import("dompurify")]).then(([{ marked }, purify]) => {
      const h = purify.default.sanitize(marked.parse(md || "_（无更新说明）_", { async: false }) as string);
      if (live) setHtml(h);
    });
    return () => void (live = false);
  }, [md]);
  return <div className="prose-dh text-[13.5px]" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function UpdatePage() {
  const { overview: o, busy, offline, upgraded } = useAdminUpdate(true);
  const live = useVersion();
  const [s, setS] = useState<UpdateSettings | null>(null);

  useEffect(() => {
    if (o && !s) setS(o.settings);
  }, [o, s]);

  const st = o?.status;
  const running = isUpdateBusy(o);

  const check = async () => {
    try {
      await updateStore.check();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const apply = async (downloadOnly = false) => {
    const m = o?.last_check?.latest;
    if (!downloadOnly && !(await confirmDlg(`更新到 ${m?.version ?? "最新版本"}？`, { label: "将下载并校验签名与 SHA-256、备份数据库、替换程序（保留 .bak）后重启；新版本健康检查失败会自动回滚。重启期间服务会中断几秒。", confirm: "立即更新" }))) return;
    try {
      await updateStore.apply(downloadOnly);
    } catch (e) {
      if (!updateStore.getState().offline) toast.err(errMsg(e));
    }
  };
  const save = async () => {
    if (!s) return;
    try {
      const next = await updateStore.saveSettings(s);
      setS(next.settings);
      toast.ok("已保存更新设置");
    } catch (e) {
      toast.err(errMsg(e));
    }
  };

  if (!o || !s) return <div className="flex justify-center py-20">{offline ? <p className="text-sm text-muted">服务正在重启…</p> : <Spinner />}</div>;
  const lc = o.last_check;
  const m = lc?.latest ?? null;
  const eff = o.effective;
  const showUpgraded = upgraded || live.stale;
  const [label, tone] = UPDATE_STATE_META[st!.state] ?? [st!.state, "neutral"];
  const pct = st!.total_bytes ? st!.progress_bytes / st!.total_bytes : 0;
  const server = m?.artifacts.find((a) => a.kind === "server" && a.platform === eff.platform);
  const docker = m?.artifacts.find((a) => a.kind === "docker");

  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex-1 text-xl font-semibold">系统更新</h1>
        <Button onClick={check} loading={busy === "check"} disabled={!eff.check_enabled || running}><RefreshCw className="size-4" />检查更新</Button>
        {lc?.update_available && eff.deployment === "binary" && (
          <Button onClick={() => apply(true)} loading={busy === "download"} disabled={running || st!.state === "ready"}><Download className="size-4" />仅下载</Button>
        )}
        <Button variant="primary" onClick={() => apply()} loading={busy === "apply"} disabled={!lc?.update_available || running || !eff.check_enabled}>
          <ArrowUpCircle className="size-4" />立即更新
        </Button>
      </div>

      {!eff.check_enabled && (
        <p role="alert" className="rounded-lg bg-warn/15 px-3 py-2 text-[13px] text-warn">此服务器已关闭更新检查（DRIVEHUB_UPDATE_CHECK=false，内网/离线模式）。</p>
      )}
      {showUpgraded && (
        <p role="status" className="flex items-center gap-3 rounded-lg bg-ok/12 px-3 py-2 text-[13px] text-ok">
          服务端已更新到 {o.current_version}。<Button size="sm" onClick={() => location.reload()}><RotateCcw className="size-4" />刷新以加载新版本</Button>
        </p>
      )}

      <Card title="版本">
        <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-2.5 text-[13px]">
          <dt className="text-muted">当前版本</dt>
          <dd className="flex flex-wrap items-center gap-2"><b className="font-mono">{o.current_version}</b><span className="text-faint">Web {WEB_VERSION} <span className="font-mono text-[11px]">({WEB_BUILD})</span></span></dd>
          <dt className="text-muted">最新版本</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {m ? <b className="font-mono">{m.version}</b> : <span className="text-faint">—</span>}
            {m && <Badge tone={m.channel === "beta" ? "warn" : "neutral"}>{m.channel}</Badge>}
            {lc?.error ? <Badge tone="danger">检查失败</Badge> : lc?.update_available ? <Badge tone="accent">有可用更新</Badge> : m ? <Badge tone="ok">已是最新</Badge> : null}
            {m?.released_at && <span className="text-faint">发布于 {m.released_at.slice(0, 10)}</span>}
          </dd>
          {lc?.error && (<><dt className="text-muted">错误</dt><dd className="break-all text-danger">{lc.error}</dd></>)}
          <dt className="text-muted">上次检查</dt>
          <dd>{lc ? fmtTime(lc.checked_at) : "从未"}{lc?.key_id && <span className="ml-2 text-faint">签名密钥 <span className="font-mono">{lc.key_id}</span></span>}</dd>
          {m && (<><dt className="text-muted">最低客户端</dt><dd className="font-mono">{m.min_client_version}<span className="ml-2 font-sans text-faint">API v{m.api_version}</span></dd></>)}
          {server && (<><dt className="text-muted">安装包</dt><dd className="break-all"><span className="font-mono text-[12px]">{eff.platform}</span> · {fmtSize(server.size)} · <span className="font-mono text-[11px] text-faint">sha256 {server.sha256.slice(0, 16)}…</span></dd></>)}
          {docker?.image && (<><dt className="text-muted">Docker 镜像</dt><dd className="font-mono text-[12px]">{docker.image}</dd></>)}
        </dl>
      </Card>

      {m && (
        <Card title={`更新说明 · ${m.version}`}>
          <Notes md={m.notes} />
        </Card>
      )}

      {st!.state !== "idle" && (
        <Card title="更新进度" actions={<Badge tone={tone}>{label}</Badge>}>
          <div className="space-y-3 text-[13px]">
            <p>
              {st!.from_version && st!.target_version ? <span className="font-mono">{st!.from_version} → {st!.target_version}</span> : null}
              <span className="ml-2 text-muted">{st!.message}</span>
              {offline && <span className="ml-2 text-warn">（服务重启中，自动重连…）</span>}
            </p>
            {(st!.state === "downloading" || st!.total_bytes > 0) && UPDATE_BUSY_STATES.has(st!.state) && (
              <div className="space-y-1">
                <Progress value={pct} />
                <p className="text-xs text-faint">{fmtSize(st!.progress_bytes)} / {fmtSize(st!.total_bytes)}</p>
              </div>
            )}
            {st!.error && <p className="break-all rounded-lg bg-danger/10 px-3 py-2 text-danger">{st!.error}</p>}
            {st!.commands.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between"><span className="text-muted">在宿主机执行：</span>
                  <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(st!.commands.filter((c) => !c.startsWith("#")).join("\n")).then(() => toast.ok("已复制"))}><Copy className="size-4" />复制</Button>
                </div>
                <pre className="overflow-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-[12px] leading-relaxed">{st!.commands.join("\n")}</pre>
              </div>
            )}
            {st!.log.length > 0 && (
              <ol className="max-h-56 space-y-0.5 overflow-auto rounded-lg border border-line bg-panel-2 p-3 font-mono text-[11.5px] text-muted">
                {st!.log.map((l, i) => {
                  const [ts, ...rest] = l.split(" ");
                  return <li key={i}><span className="text-faint">{fmtTime(Number(ts))}</span> {rest.join(" ")}</li>;
                })}
              </ol>
            )}
          </div>
        </Card>
      )}

      <Card title="更新设置" actions={<Button size="sm" variant="primary" onClick={save} loading={busy === "save"}>保存</Button>}>
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <p className="text-[13.5px] font-medium">后台定时检查</p>
              <p className="text-xs text-muted">关闭后仅在此页手动检查（内网/离线部署可在配置中彻底关闭）</p>
            </div>
            <Switch label="后台定时检查" checked={s.auto_check} onChange={(v) => setS({ ...s, auto_check: v })} />
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-[13px] font-medium text-muted">更新模式</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {MODES.map(([k, t, d]) => (
                <label key={k} className={`cursor-pointer rounded-lg border p-3 ${s.mode === k ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"}`}>
                  <span className="flex items-center gap-2 text-[13.5px] font-medium">
                    <input type="radio" name="mode" value={k} checked={s.mode === k} onChange={() => setS({ ...s, mode: k })} className="accent-[var(--accent)]" />
                    {t}
                  </span>
                  <span className="mt-1 block text-xs text-muted">{d}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="维护时间窗（UTC）" hint="自动安装只在此时间段内进行；留空 = 任意时间">
              <div className="flex items-center gap-2">
                <Input type="time" aria-label="开始" value={s.window_start} onChange={(e) => setS({ ...s, window_start: e.target.value })} />
                <span className="text-faint">—</span>
                <Input type="time" aria-label="结束" value={s.window_end} onChange={(e) => setS({ ...s, window_end: e.target.value })} />
              </div>
            </Field>
            <Field label="更新通道">
              <Select className="w-full" value={s.channel} onChange={(e) => setS({ ...s, channel: e.target.value })}>
                <option value="">默认（{eff.channel}）</option>
                <option value="stable">stable 稳定版</option>
                <option value="beta">beta 测试版</option>
              </Select>
            </Field>
            <Field label="检查间隔（小时）" hint={`默认 ${Math.round(eff.interval_secs / 360) / 10} 小时`}>
              <Input type="number" min={0} step={0.5} value={s.interval_secs ? s.interval_secs / 3600 : ""} placeholder="默认" onChange={(e) => setS({ ...s, interval_secs: Math.round(Number(e.target.value) * 3600) })} />
            </Field>
            <Field label="更新源（清单 URL）" hint="默认 GitHub Releases；可填自建地址（同目录需有 .sig 签名文件）">
              <Input value={s.source_url} placeholder={eff.source_url} onChange={(e) => setS({ ...s, source_url: e.target.value })} />
            </Field>
            <Field label="Webhook 通知" hint="发现新版本 / 更新成功 / 失败 / 回滚时 POST JSON">
              <Input value={s.notify_webhook} placeholder="https://…" onChange={(e) => setS({ ...s, notify_webhook: e.target.value })} />
            </Field>
            <Field label="邮件通知">
              <Input type="email" value={s.notify_email} placeholder="admin@example.com" onChange={(e) => setS({ ...s, notify_email: e.target.value })} />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="部署信息">
        <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-2 text-[13px]">
          <dt className="text-muted">部署方式</dt>
          <dd>{eff.deployment === "docker" ? <>Docker {eff.docker_socket ? <Badge tone="ok">已授权 docker.sock，可一键更新</Badge> : <Badge tone="warn">未授权 docker.sock，将给出更新命令</Badge>}</> : <>二进制 <span className="font-mono text-[12px] text-faint">{eff.platform}</span></>}</dd>
          {eff.deployment === "binary" && (<><dt className="text-muted">程序路径</dt><dd className="break-all font-mono text-[12px]">{eff.exe_path ?? "—"}</dd>
            <dt className="text-muted">重启方式</dt><dd>{eff.restart === "exit" ? "退出（exit 75）由 pm2/systemd 拉起" : "exec 原地替换进程（PID 不变，pm2/systemd 无需配置）"}</dd></>)}
          <dt className="text-muted">自动安装</dt><dd>{eff.can_auto_install ? <Badge tone="ok">可用</Badge> : <Badge tone="warn">不可用</Badge>}</dd>
          <dt className="text-muted">信任公钥</dt><dd className="font-mono text-[12px]">{eff.trusted_key_ids.join("  ") || "—"}</dd>
          <dt className="text-muted">数据库备份</dt>
          <dd className="space-y-0.5 break-all font-mono text-[11.5px] text-muted">{eff.db_backups.length ? eff.db_backups.map((b) => <p key={b}>{b}</p>) : <span className="font-sans text-faint">暂无（每次更新前自动备份，保留最近 3 份）</span>}</dd>
        </dl>
      </Card>
    </div>
  );
}
