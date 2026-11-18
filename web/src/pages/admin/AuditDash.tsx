import { useEffect, useState } from "react";
import { call } from "../../lib/api";
import { fmtSize } from "../../lib/util";
import { Card } from "../../ui/ui";

type Dash = {
  totals: { events: number; denied: number; failed_logins: number; active_users: number; download_bytes: number; upload_bytes: number };
  traffic: { day: string; download_bytes: number; upload_bytes: number; events: number }[];
  hot_files: { path: string; count: number; bytes: number }[];
  top_shares: { id: number; code: string; name: string; owner: string; visits: number; downloads: number; bytes: number }[];
  alerts: { id: number; time: string; rule: string; user: string; ip: string; message: string }[];
};

/** Audit dashboard (DEPTAI-475): traffic, hot files, share ranking, anomalies. */
export function AuditDash() {
  const [d, setD] = useState<Dash | null>(null);
  const [days, setDays] = useState(7);
  useEffect(() => void call<Dash>("GET", `/api/admin/audit/dashboard?days=${days}`).then(setD).catch(() => {}), [days]);
  if (!d) return null;
  const max = Math.max(1, ...d.traffic.map((t) => t.download_bytes + t.upload_bytes));
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-base font-semibold">审计概览</h2>
        <select className="rounded border border-line bg-panel px-2 py-1 text-[13px]" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="时间范围">
          {[1, 7, 30, 90].map((n) => <option key={n} value={n}>近 {n} 天</option>)}
        </select>
      </div>
      <p className="text-[13px] text-muted">
        事件 {d.totals.events} · 活跃用户 {d.totals.active_users} · 下载 {fmtSize(d.totals.download_bytes)} · 上传 {fmtSize(d.totals.upload_bytes)} · 拒绝 {d.totals.denied} · 登录失败 {d.totals.failed_logins}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="流量（每天）">
          <div className="flex h-32 items-end gap-1" role="img" aria-label="每日流量">
            {d.traffic.map((t) => (
              <div key={t.day} className="flex flex-1 flex-col justify-end" title={`${t.day} 下载 ${fmtSize(t.download_bytes)} 上传 ${fmtSize(t.upload_bytes)}`} style={{ height: "100%" }}>
                <div className="bg-accent/70" style={{ height: `${(t.download_bytes / max) * 100}%` }} />
                <div className="bg-ok/60" style={{ height: `${(t.upload_bytes / max) * 100}%` }} />
              </div>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-faint">蓝 = 下载，绿 = 上传</p>
        </Card>
        <Card title="热门文件">
          <ol className="space-y-0.5 text-[12.5px]">
            {d.hot_files.map((h) => <li key={h.path} className="flex gap-2"><span className="min-w-0 flex-1 truncate font-mono">{h.path}</span><span className="tabular-nums">{h.count} 次</span></li>)}
          </ol>
        </Card>
        <Card title="分享排行">
          <ol className="space-y-0.5 text-[12.5px]">
            {d.top_shares.map((s) => <li key={s.id} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{s.name} <span className="text-muted">({s.owner})</span></span><span className="tabular-nums">访问 {s.visits} · 下载 {s.downloads}</span></li>)}
          </ol>
        </Card>
        <Card title="异常事件 / 告警">
          {d.alerts.length === 0 ? <p className="text-[13px] text-muted">暂无告警</p> : (
            <ul className="space-y-0.5 text-[12.5px]">
              {d.alerts.map((a) => <li key={a.id}><span className="text-muted">{a.time.replace("T", " ").slice(0, 16)}</span> <b>{a.rule}</b> {a.message}</li>)}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
