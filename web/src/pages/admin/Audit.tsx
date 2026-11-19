import { useEffect, useRef, useState } from "react";
import { useScrollTimeline } from "../../ui/r5";
import { BellPlus, Download, RefreshCw, ShieldCheck, Trash2, Send } from "lucide-react";
import { call, rawFetch } from "../../lib/api";
import type { AuditEvent } from "../../lib/shares";
import { errMsg, fmtSize, fmtTime } from "../../lib/util";
import { Badge, Button, Card, Checkbox, confirmDlg, Empty, Field, IconButton, Input, Modal, PageHeader, Pager, Select, toast, usePaged } from "../../ui/ui";
import { SkTable } from "../../ui/r6";

type Alert = { id: number; name: string; kind: string; actions: string; threshold: number; window_secs: number; sink: string; target: string; enabled: boolean };
type AlertEv = { id: number; time: string; ts: number; rule: string; user: string; ip: string; message: string; sink: string; delivered: boolean; error: string };

const CLIENTS: Record<string, string> = { web: "Web", android: "Android", webdav: "WebDAV", api: "API" };

/** Audit: multi-filter search, timeline, server export, hash-chain verify, retention, alerts. */
export function AuditPage() {
  const [rows, setRows] = useState<AuditEvent[] | null>(null);
  const [f, setF] = useState({ user: "", action: "", channel: "", client: "", path: "", ip: "", q: "", share_id: "", from: "", to: "", denied: false });
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; first_bad_id: number | null; reason: string | null } | null>(null);
  const [policy, setPolicy] = useState<number | null>(null);
  const [view, setView] = useState<"table" | "timeline">("timeline");
  const pr = usePaged(rows ?? [], 50, rows, "audit");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const query = () => {
    const q = new URLSearchParams({ limit: "500" });
    for (const [k, v] of Object.entries(f)) {
      if (k === "denied") v && q.set("denied", "true");
      else if ((k === "from" || k === "to") && v) q.set(k, String(Math.floor(new Date(v as string).getTime() / 1000)));
      else if (v) q.set(k, String(v));
    }
    return q;
  };
  const load = () => call<AuditEvent[]>("GET", `/api/admin/audit?${query()}`).then(setRows).catch((e) => toast.err(errMsg(e)));
  useEffect(() => {
    load();
    call<{ retention_days: number }>("GET", "/api/admin/audit/policy").then((p) => setPolicy(p.retention_days));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const exportAs = async (format: "csv" | "json") => {
    const q = query();
    q.set("format", format);
    q.delete("limit");
    const r = await rawFetch(`/api/admin/audit/export?${q}`);
    if (!r.ok) return toast.err(`导出失败 ${r.status}`);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `drivehub-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const doVerify = () => call("GET", "/api/admin/audit/verify").then(setVerify).catch((e) => toast.err(errMsg(e)));
  const savePolicy = async () => {
    try {
      await call("PUT", "/api/admin/audit/policy", { retention_days: policy ?? 0 });
      const r = await call<{ deleted: number }>("POST", "/api/admin/audit/purge");
      toast.ok(`已保存，清理 ${r.deleted} 条过期记录`);
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="审计日志" desc="所有 API / WebDAV / 分享 / 登录操作，哈希链防篡改" actions={<>
        <Button size="sm" onClick={doVerify}><ShieldCheck className="size-4" /> 校验哈希链</Button>
        <Button size="sm" onClick={() => exportAs("csv")}><Download className="size-4" /> CSV</Button>
        <Button size="sm" onClick={() => exportAs("json")}><Download className="size-4" /> JSON</Button>
      </>} />
      {verify && (
        <p className={`rounded-lg px-3 py-2 text-[13px] ${verify.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"}`}>
          {verify.ok ? `哈希链完整：已校验 ${verify.checked} 条记录` : `发现篡改！记录 #${verify.first_bad_id}：${verify.reason}`}
        </p>
      )}
      <form className="ctl-sm grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6" onSubmit={(e) => (e.preventDefault(), load())}>
        <Input placeholder="用户" value={f.user} onChange={set("user")} aria-label="用户" />
        <Input placeholder="动作 (逗号分隔)" value={f.action} onChange={set("action")} aria-label="动作" />
        <Input placeholder="路径前缀" value={f.path} onChange={set("path")} aria-label="路径" />
        <Input placeholder="IP" value={f.ip} onChange={set("ip")} aria-label="IP" />
        <Input placeholder="分享 ID" value={f.share_id} onChange={set("share_id")} aria-label="分享ID" />
        <Input placeholder="全文" value={f.q} onChange={set("q")} aria-label="全文" />
        <Select value={f.channel} onChange={set("channel")} aria-label="通道">
          <option value="">全部通道</option>
          {["api", "webdav", "share", "auth", "admin"].map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select value={f.client} onChange={set("client")} aria-label="客户端">
          <option value="">全部客户端</option>
          {Object.entries(CLIENTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Input type="datetime-local" value={f.from} onChange={set("from")} aria-label="开始时间" />
        <Input type="datetime-local" value={f.to} onChange={set("to")} aria-label="结束时间" />
        <Checkbox checked={f.denied} onChange={(v) => setF({ ...f, denied: v })} className="justify-start" label="只看拒绝"><span className="ctl-label">只看拒绝</span></Checkbox>
        <div className="flex gap-1">
          <Button type="submit" variant="primary">查询</Button>
          <Select value={view} onChange={(e) => setView(e.target.value as "table")} aria-label="视图">
            <option value="timeline">时间线</option>
            <option value="table">表格</option>
          </Select>
          <IconButton label="刷新" onClick={load}><RefreshCw className="size-4" /></IconButton>
        </div>
      </form>
      {rows === null && <SkTable cols={[2, 1, 2, 1, 1, 2, 4, 1, 1, 1, 3]} rows={8} label="正在加载审计日志" />}
      {rows && rows.length === 0 && <Empty title="没有记录" />}
      {rows && rows.length > 0 && view === "table" && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[1000px] text-left text-[12.5px]">
            <thead className="border-b border-line bg-panel-2 text-xs text-muted">
              <tr>{["时间", "用户", "IP", "客户端", "通道", "动作", "路径", "结果", "字节", "分享", "详情"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pr.slice.map((r) => (
                <tr key={r.id} className="hover:bg-hover">
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-1.5">{r.username}</td>
                  <td className="px-3 py-1.5 font-mono" title={r.ua}>{r.ip}</td>
                  <td className="px-3 py-1.5">{CLIENTS[r.client] ?? r.client}</td>
                  <td className="px-3 py-1.5"><Badge>{r.channel}</Badge></td>
                  <td className="px-3 py-1.5">{r.action}</td>
                  <td className="max-w-64 truncate px-3 py-1.5 font-mono" title={r.path}>{r.path}</td>
                  <td className="px-3 py-1.5">{r.allowed ? <Badge tone="ok">成功</Badge> : <Badge tone="danger">拒绝</Badge>}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.bytes ? fmtSize(r.bytes) : ""}</td>
                  <td className="px-3 py-1.5">{r.share_id ?? ""}</td>
                  <td className="max-w-80 truncate px-3 py-1.5 text-muted" title={r.detail}>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows && rows.length > 0 && view === "table" && <Pager {...pr} />}
      {rows && rows.length > 0 && view === "timeline" && <AuditTimeline rows={rows} />}
      <Card title="保留期策略">
        <div className="flex items-end gap-2">
          <Field label="保留天数（0 = 永久）"><Input type="number" min={0} value={policy ?? 0} onChange={(e) => setPolicy(Number(e.target.value))} /></Field>
          <Button onClick={savePolicy}>保存并清理</Button>
        </div>
      </Card>
      <Alerts />
    </div>
  );
}

function Alerts() {
  const [rules, setRules] = useState<Alert[]>([]);
  const [evs, setEvs] = useState<AlertEv[]>([]);
  const [edit, setEdit] = useState<Partial<Alert> | null>(null);
  const load = () => {
    call<Alert[]>("GET", "/api/admin/alerts").then(setRules);
    call<AlertEv[]>("GET", "/api/admin/alerts/events?limit=50").then(setEvs);
  };
  useEffect(load, []);
  const save = async () => {
    try {
      const body = { ...edit, threshold: Number(edit?.threshold ?? 0), window_secs: Number(edit?.window_secs ?? 60) };
      if (edit?.id) await call("PUT", `/api/admin/alerts/${edit.id}`, body);
      else await call("POST", "/api/admin/alerts", body);
      setEdit(null);
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  return (
    <Card title="告警规则" actions={<Button size="sm" onClick={() => setEdit({ name: "", kind: "burst", actions: "download,share_download", threshold: 50, window_secs: 300, sink: "log", target: "", enabled: true })}><BellPlus className="size-4" /> 新建</Button>}>
      {rules.length === 0 ? <p className="text-[13px] text-muted">暂无规则</p> : (
        <ul className="divide-y divide-line text-[13px]">
          {rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-1.5">
              <span className="flex-1">
                <b>{r.name}</b> {!r.enabled && <Badge>停用</Badge>} <span className="text-muted">{r.kind === "burst" ? `${r.window_secs}s 内 [${r.actions}] ≥ ${r.threshold} 次` : "异地（新网段）登录"} → {r.sink}{r.target && ` ${r.target}`}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>编辑</Button>
              <IconButton label="发送测试" onClick={() => call("POST", `/api/admin/alerts/${r.id}/test`).then(() => (toast.ok("已发送"), setTimeout(load, 800)))}><Send className="size-4" /></IconButton>
              <IconButton label="删除" onClick={async () => (await confirmDlg(`删除规则「${r.name}」？`, { danger: true })) && call("DELETE", `/api/admin/alerts/${r.id}`).then(load)}><Trash2 className="size-4" /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <h3 className="mt-4 mb-1 text-xs font-medium text-muted">最近告警</h3>
      {evs.length === 0 ? <p className="text-[13px] text-muted">暂无</p> : (
        <ul className="space-y-0.5 text-[12.5px]">
          {evs.map((e) => <li key={e.id}><span className="text-muted">{fmtTime(e.ts)}</span> <b>{e.rule}</b> {e.message} <span className={e.delivered ? "text-ok" : "text-danger"}>{e.delivered ? "已送达" : e.error || "发送中"}</span></li>)}
        </ul>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "编辑告警规则" : "新建告警规则"} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
        {edit && (
          <div className="space-y-3">
            <Field label="名称"><Input value={edit.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="类型">
              <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                <option value="burst">短时大量操作</option>
                <option value="new_ip_login">异地登录（新网段）</option>
              </Select>
            </Field>
            {edit.kind === "burst" && (
              <>
                <Field label="动作（逗号分隔）" hint="如 download,share_download 或 delete"><Input value={edit.actions ?? ""} onChange={(e) => setEdit({ ...edit, actions: e.target.value })} /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="阈值（次）"><Input type="number" value={edit.threshold ?? 0} onChange={(e) => setEdit({ ...edit, threshold: Number(e.target.value) })} /></Field>
                  <Field label="时间窗（秒）"><Input type="number" value={edit.window_secs ?? 60} onChange={(e) => setEdit({ ...edit, window_secs: Number(e.target.value) })} /></Field>
                </div>
              </>
            )}
            <Field label="通知方式">
              <Select value={edit.sink} onChange={(e) => setEdit({ ...edit, sink: e.target.value })}>
                <option value="log">仅记录</option>
                <option value="webhook">Webhook</option>
                <option value="email">邮件</option>
              </Select>
            </Field>
            {edit.sink !== "log" && <Field label={edit.sink === "email" ? "邮箱" : "Webhook URL"}><Input value={edit.target ?? ""} onChange={(e) => setEdit({ ...edit, target: e.target.value })} /></Field>}
            <Checkbox checked={edit.enabled ?? true} onChange={(v) => setEdit({ ...edit, enabled: v })} className="justify-start">启用</Checkbox>
          </div>
        )}
      </Modal>
    </Card>
  );
}

const ACTION_CN: Record<string, string> = {
  login: "登录", login_failed: "登录失败", logout: "退出", download: "下载", preview: "预览", upload: "上传", mkdir: "新建文件夹", rename: "重命名", move: "移动", copy: "复制", delete: "删除",
  share_create: "创建分享", share_update: "修改分享", share_revoke: "停用分享", share_visit: "访问分享", share_download: "分享下载", share_upload: "分享上传", share_direct: "直链下载", share_pin_fail: "提取码错误",
  user_create: "创建用户", user_update: "修改用户", role_create: "创建角色", role_update: "修改角色", tag: "打标签",
};

/** Scroll-driven audit timeline (motion-timeline-scroll): the orange line grows with scrolling —
 *  its tip stays 126px below the top of the scroller — and every event lights up over the next
 *  22px of travel (ring → orange, inner dot 0 → 4px, text fades in from 16px right). */
function AuditTimeline({ rows }: { rows: AuditEvent[] }) {
  const root = useRef<HTMLDivElement>(null);
  useScrollTimeline(root, [rows]);
  let last = "";
  return (
    <div className="rounded-xl border border-line bg-panel px-3 py-4 sm:px-6" data-audit-timeline>
      <div ref={root} className="tl">
        <span className="tl-track" aria-hidden />
        <span className="tl-line" aria-hidden />
        <ol>
          {rows.map((r) => {
            const d = new Date(r.ts * 1000);
            const dayKey = d.toLocaleDateString();
            const head = dayKey !== last;
            last = dayKey;
            return (
              <li key={r.id} className="tl-item" data-ev={r.id}>
                <div className="tl-when">
                  {head && <b className="block text-[13px] font-semibold">{d.toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" })}</b>}
                  {d.toLocaleTimeString()}
                </div>
                <span className="tl-dot" data-bad={r.allowed ? undefined : ""} aria-hidden />
                <div className="tl-body text-[13px]">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <b className="font-semibold">{ACTION_CN[r.action] ?? r.action}</b>
                    {!r.allowed && <Badge tone="danger">拒绝</Badge>}
                    <Badge>{r.channel}</Badge>
                    <span className="text-muted">{r.username || "匿名"} · {CLIENTS[r.client] ?? r.client} · <span className="font-mono">{r.ip}</span></span>
                  </p>
                  {r.path && <p className="truncate font-mono text-[12px] text-muted" title={r.path}>{r.path}</p>}
                  {r.detail && <p className="truncate text-[12px] text-faint" title={r.detail}>{r.detail}{r.bytes ? ` · ${fmtSize(r.bytes)}` : ""}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
