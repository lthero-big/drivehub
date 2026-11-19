import { useEffect, useState } from "react";
import { HardDrive, ListChecks, ShieldAlert, Users } from "lucide-react";
import { call, client, ok, type AuditRow, type TaskInfo, type VersionInfo } from "../../lib/api";
import { fmtTime } from "../../lib/util";
import { Badge, Card, PageHeader } from "../../ui/ui";
import { AuditDash } from "./AuditDash";
import { PageSkeleton } from "../../ui/r6";

function Stat({ icon: I, label, value, href, tone = "accent" }: { icon: typeof HardDrive; label: string; value: number | string; href: string; tone?: "accent" | "ok" | "warn" | "danger" }) {
  const t = { accent: "bg-accent-soft text-accent", ok: "bg-ok/12 text-ok", warn: "bg-warn/15 text-warn", danger: "bg-danger/12 text-danger" }[tone];
  return (
    <a href={href} className="card-lift block rounded-2xl border border-line bg-panel p-5 shadow-card active:scale-[0.98]">
      <span className={`flex size-10 items-center justify-center rounded-xl ${t}`}><I className="size-5" /></span>
      <span className="mt-4 block text-4xl font-semibold tracking-tight tabular-nums">{value}</span>
      <span className="mt-1 block text-[13px] text-muted">{label}</span>
    </a>
  );
}

export function DashboardPage() {
  const [d, setD] = useState<{ mounts: number; users: number; tasks: TaskInfo[]; audit: AuditRow[]; denied: AuditRow[]; ver?: VersionInfo } | null>(null);
  useEffect(() => {
    Promise.all([
      ok(client.GET("/api/mounts")),
      call<unknown[]>("GET", "/api/admin/users"),
      ok(client.GET("/api/tasks", { params: { query: { limit: 50 } } })),
      call<AuditRow[]>("GET", "/api/admin/audit?limit=200"),
      call<AuditRow[]>("GET", "/api/admin/audit?limit=200&denied=true"),
      ok(client.GET("/api/version")),
    ])
      .then(([m, u, t, a, dn, v]) => setD({ mounts: m.length, users: u.length, tasks: t, audit: a, denied: dn, ver: v }))
      .catch(() => {});
  }, []);
  if (!d) return <PageSkeleton kind="dashboard" />;
  const since = Date.now() / 1000 - 86400;
  const active = d.tasks.filter((t) => t.status === "running" || t.status === "pending").length;
  // 24h activity histogram (per hour) from the audit sample
  const buckets = Array.from({ length: 24 }, (_, i) => d.audit.filter((r) => r.ts >= since + i * 3600 && r.ts < since + (i + 1) * 3600).length);
  const max = Math.max(1, ...buckets);
  return (
    <div className="space-y-4">
      <PageHeader title="仪表盘" desc="存储、用户与访问概览" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon={HardDrive} label="挂载点" value={d.mounts} href="#/admin/mounts" />
        <Stat icon={Users} label="用户" value={d.users} href="#/admin/users" />
        <Stat icon={ListChecks} label="进行中的任务" value={active} href="#/tasks" tone="ok" />
        <Stat icon={ShieldAlert} label="24h 拒绝访问" value={d.denied.filter((r) => r.ts >= since).length} href="#/admin/audit" tone="danger" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="近 24 小时操作">
          <div className="flex h-32 items-end gap-1" role="img" aria-label="每小时操作次数柱状图">
            {buckets.map((b, i) => (
              <div key={i} title={`${b} 次`} className="flex-1 rounded-t bg-accent/70" style={{ height: `${(b / max) * 100}%`, minHeight: b ? 3 : 1 }} />
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-faint"><span>24 小时前</span><span>现在</span></div>
        </Card>
        <Card title="版本">
          <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 text-[13px]">
            <dt className="text-muted">服务端</dt><dd>{d.ver?.server_version}</dd>
            <dt className="text-muted">API</dt><dd>v{d.ver?.api_version}</dd>
            <dt className="text-muted">最低 Web</dt><dd>{d.ver?.min_web_version}</dd>
            <dt className="text-muted">最低 App</dt><dd>{d.ver?.min_app_version}</dd>
          </dl>
        </Card>
      </div>
      <AuditDash />
      <Card title="最近活动" actions={<a href="#/admin/audit" className="btn-key inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs">查看全部</a>}>
        <ul className="divide-y divide-line text-[13px]">
          {d.audit.slice(0, 12).map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-1.5">
              {r.allowed ? <Badge tone="ok">允许</Badge> : <Badge tone="danger">拒绝</Badge>}
              <span className="font-medium">{r.username}</span>
              <span className="text-muted">{r.action}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{r.path}</span>
              <span className="text-xs text-faint">{fmtTime(r.ts)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
