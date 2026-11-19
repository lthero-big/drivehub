import { useEffect, useState } from "react";
import { ArrowRight, ListChecks, RefreshCw } from "lucide-react";
import { client, ok, type TaskInfo } from "../lib/api";
import { errMsg, fmtSize, fmtTime } from "../lib/util";
import { Badge, Empty, IconButton, Input, PageHeader, Pager, Progress, Select, usePaged } from "../ui/ui";
import { SkTable } from "../ui/r6";

const TONE: Record<string, "ok" | "danger" | "accent" | "neutral"> = { done: "ok", failed: "danger", running: "accent", pending: "neutral" };
const LABEL: Record<string, string> = { done: "完成", failed: "失败", running: "进行中", pending: "排队" };

/** Task center: cross-storage copy/move background tasks, polled while any are active. */
export function TasksPage() {
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [status, setStatus] = useState("");
  const [tq, setTq] = useState("");
  const [err, setErr] = useState("");
  const load = () =>
    ok(client.GET("/api/tasks", { params: { query: { status: status || undefined, limit: 200 } } }))
      .then((t) => (setTasks(t), setErr("")))
      .catch((e) => setErr(errMsg(e)));
  useEffect(() => {
    load();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const live = tasks?.some((t) => t.status === "running" || t.status === "pending");
  useEffect(() => {
    if (!live) return;
    const i = setInterval(load, 1500);
    return () => clearInterval(i);
  }, [live, status]); // eslint-disable-line react-hooks/exhaustive-deps
  const ft = (tasks ?? []).filter((t) => !tq.trim() || `${t.src} ${t.dst} ${t.id}`.toLowerCase().includes(tq.trim().toLowerCase()));
  const pt = usePaged(ft, 10, tq + status);
  return (
    <div className="mx-auto max-w-5xl space-y-4 py-6">
      <PageHeader title="任务中心" desc={tasks ? `${tasks.filter((t) => t.status === "running" || t.status === "pending").length} 个进行中 · 共 ${tasks.length} 个任务` : undefined} actions={<>
        <Input className="w-48" placeholder="筛选路径/编号" aria-label="筛选任务" value={tq} onChange={(e) => setTq(e.target.value)} />
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="状态筛选">
          <option value="">全部</option>
          <option value="running">进行中</option>
          <option value="pending">排队</option>
          <option value="done">完成</option>
          <option value="failed">失败</option>
        </Select>
        <IconButton label="刷新" onClick={load}>
          <RefreshCw className="size-4" />
        </IconButton>
      </>} />
      {err && <p className="text-sm text-danger">{err}</p>}
      {tasks === null && <SkTable cols={[4, 4, 2, 2, 1]} rows={5} label="正在加载任务" />}
      {tasks?.length === 0 && <Empty icon={<ListChecks className="size-10" />} title="暂无任务">跨存储复制 / 移动会在这里显示进度，服务重启后自动续跑</Empty>}
      <ul className="space-y-2">
        {pt.slice.map((t) => (
          <li key={t.id} className="card-lift rounded-2xl border border-line bg-panel p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={TONE[t.status] ?? "neutral"}>{LABEL[t.status] ?? t.status}</Badge>
              <Badge>{t.kind === "move" ? "移动" : "复制"}</Badge>
              <span className="min-w-0 truncate">{t.src}</span>
              <ArrowRight className="size-3.5 text-faint" />
              <span className="min-w-0 truncate">{t.dst}</span>
              <span className="ml-auto text-xs text-faint">#{t.id} · {fmtTime(t.updated_at)}</span>
            </div>
            <div className="mt-2 flex items-center gap-3">
              <Progress value={t.total_bytes ? t.done_bytes / t.total_bytes : t.status === "done" ? 1 : 0} tone={t.status === "failed" ? "danger" : t.status === "done" ? "ok" : "accent"} />
              <span className="w-36 text-right text-xs text-muted tabular-nums">
                {fmtSize(t.done_bytes)} / {fmtSize(t.total_bytes)}
              </span>
            </div>
            {t.error && <p className="mt-1 text-xs text-danger">{t.error}</p>}
          </li>
        ))}
      </ul>
      <Pager {...pt} />
    </div>
  );
}
