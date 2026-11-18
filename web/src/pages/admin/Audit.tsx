import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { call, type AuditRow } from "../../lib/api";
import { errMsg, fmtTime } from "../../lib/util";
import { Badge, Button, Empty, IconButton, Input, Select, toast } from "../../ui/ui";

export function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [channel, setChannel] = useState("");
  const [filter, setFilter] = useState("");
  const load = () => {
    const q = new URLSearchParams({ limit: "1000" });
    if (denied) q.set("denied", "true");
    if (channel) q.set("channel", channel);
    call<AuditRow[]>("GET", `/api/admin/audit?${q}`).then(setRows).catch((e) => toast.err(errMsg(e)));
  };
  useEffect(load, [denied, channel]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !f || `${r.username} ${r.action} ${r.path} ${r.detail}`.toLowerCase().includes(f));
  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["id", "time", "user", "channel", "action", "path", "allowed", "detail"];
    const body = shown.map((r) => [r.id, new Date(r.ts * 1000).toISOString(), r.username, r.channel, r.action, r.path, r.allowed, r.detail].map(esc).join(","));
    const blob = new Blob(["\ufeff" + [head.join(","), ...body].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `drivehub-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">审计日志</h1>
        <Input className="w-48" placeholder="筛选用户/路径/动作" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选" />
        <Select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="通道">
          <option value="">全部通道</option>
          <option value="api">API / Web</option>
          <option value="webdav">WebDAV</option>
          <option value="auth">认证</option>
        </Select>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input type="checkbox" className="accent-[var(--accent)]" checked={denied} onChange={(e) => setDenied(e.target.checked)} /> 只看拒绝
        </label>
        <IconButton label="刷新" onClick={load}><RefreshCw className="size-4" /></IconButton>
        <Button onClick={exportCsv}><Download className="size-4" /> 导出 CSV</Button>
      </div>
      {rows && shown.length === 0 && <Empty title="没有记录" />}
      {shown.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[760px] text-left text-[12.5px]">
            <thead className="border-b border-line bg-panel-2 text-xs text-muted">
              <tr>{["时间", "用户", "通道", "动作", "路径", "结果", "详情"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((r) => (
                <tr key={r.id} className="hover:bg-hover">
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-1.5">{r.username}</td>
                  <td className="px-3 py-1.5"><Badge>{r.channel}</Badge></td>
                  <td className="px-3 py-1.5">{r.action}</td>
                  <td className="max-w-64 truncate px-3 py-1.5 font-mono" title={r.path}>{r.path}</td>
                  <td className="px-3 py-1.5">{r.allowed ? <Badge tone="ok">允许</Badge> : <Badge tone="danger">拒绝</Badge>}</td>
                  <td className="max-w-80 truncate px-3 py-1.5 text-muted" title={r.detail}>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
