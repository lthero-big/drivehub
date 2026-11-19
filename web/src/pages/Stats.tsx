// Full access statistics (DEPTAI-485 r5 C3): every share / file access with filters
// (time, file / path, share, visitor / IP, kind, free text) on top of /api/stats/access.
import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Download, Eye, Globe, RefreshCw, Upload } from "lucide-react";
import { call } from "../lib/api";
import { useApp } from "../lib/app";
import { parse } from "../lib/router";
import type { Share } from "../lib/shares";
import { errMsg, fmtSize, fmtTime } from "../lib/util";
import { ChipGroup } from "../ui/r5";
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Select, Spinner, StatCard, toast } from "../ui/ui";

type Row = { id: number; ts: number; username: string; ip: string; ua: string; client: string; action: string; path: string; allowed: boolean; bytes: number; share_id: number | null; share_name: string | null; detail: string };
type Resp = {
  scope: string;
  total: number;
  page: number;
  per_page: number;
  summary: {
    events: number; visits: number; downloads: number; uploads: number; previews: number; bytes: number; unique_ips: number;
    by_action: { action: string; count: number }[];
    by_day: { day: string; count: number }[];
    top_shares: { share_id: number; name: string | null; count: number }[];
    top_paths: { path: string; count: number }[];
    top_ips: { ip: string; count: number }[];
  };
  rows: Row[];
};

const KINDS = [
  { value: "visit", label: "访问" },
  { value: "download", label: "下载" },
  { value: "preview", label: "预览" },
  { value: "upload", label: "上传" },
  { value: "denied", label: "被拒绝" },
];
const ACTION_CN: Record<string, string> = { share_visit: "访问分享", share_claim: "提取码进入", share_list: "浏览目录", share_preview: "预览", share_download: "下载", share_direct: "直链下载", share_upload: "上传", share_pin_fail: "提取码错误", download: "下载", preview: "预览" };
const RANGES = [
  { v: "", l: "全部时间" },
  { v: "1", l: "最近 24 小时" },
  { v: "7", l: "最近 7 天" },
  { v: "30", l: "最近 30 天" },
  { v: "custom", l: "自定义…" },
];
const day = (s: string) => (s ? Math.floor(new Date(s + "T00:00:00").getTime() / 1000) : undefined);

export function StatsPage() {
  const { isAdmin, me } = useApp();
  const audit = isAdmin || !!me?.caps?.includes("admin_audit");
  const init = parse().q;
  const [scope, setScope] = useState(init.get("scope") ?? "shares");
  const [share, setShare] = useState(init.get("share_id") ?? "");
  const [path, setPath] = useState(init.get("path") ?? "");
  const [ip, setIp] = useState(init.get("ip") ?? "");
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [range, setRange] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => void call<Share[]>("GET", `/api/shares${isAdmin ? "?all=true" : ""}`).then(setShares).catch(() => {}), [isAdmin]);
  const query = useMemo(() => {
    const u = new URLSearchParams({ scope, page: String(page), per_page: "50" });
    if (share) u.set("share_id", share);
    if (path.trim()) u.set("path", path.trim());
    if (ip.trim()) u.set("ip", ip.trim());
    if (q.trim()) u.set("q", q.trim());
    if (kinds.length) u.set("kind", kinds.join(","));
    const now = Math.floor(Date.now() / 1000);
    if (range && range !== "custom") u.set("from", String(now - Number(range) * 86400));
    if (range === "custom") {
      const f = day(from), t = day(to);
      if (f) u.set("from", String(f));
      if (t) u.set("to", String(t + 86400));
    }
    return u.toString();
  }, [scope, share, path, ip, q, kinds, range, from, to, page]);
  const load = () => {
    setBusy(true);
    call<Resp>("GET", `/api/stats/access?${query}`)
      .then(setData)
      .catch((e) => toast.err(errMsg(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [scope, share, path, ip, q, kinds, range, from, to]);
  const s = data?.summary;
  const maxDay = Math.max(1, ...(s?.by_day.map((d) => d.count) ?? [1]));
  const pages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;
  const reset = () => (setShare(""), setPath(""), setIp(""), setQ(""), setKinds([]), setRange(""), setFrom(""), setTo(""));
  return (
    <div className="mx-auto max-w-6xl space-y-4 py-4" data-stats-page>
      <PageHeader title="访问统计" desc="分享与文件的访问、下载、上传记录，可按时间、文件、分享、访问者筛选" actions={<><Button variant="ghost" onClick={reset}>重置筛选</Button><Button onClick={load} loading={busy}><RefreshCw className="size-4" /> 刷新</Button></>} />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {audit && (
            <Field label="范围">
              <Select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="统计范围">
                <option value="shares">分享访问</option>
                <option value="files">文件直接访问</option>
                <option value="all">全部</option>
              </Select>
            </Field>
          )}
          <Field label="时间">
            <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label="时间范围">{RANGES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</Select>
          </Field>
          {range === "custom" && (
            <Field label="起止日期">
              <div className="flex gap-1"><Input type="date" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} /><Input type="date" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} /></div>
            </Field>
          )}
          <Field label="分享">
            <Select value={share} onChange={(e) => setShare(e.target.value)} aria-label="按分享筛选">
              <option value="">全部分享</option>
              {shares.map((x) => <option key={x.id} value={x.id}>{x.name}{isAdmin && x.owner ? ` · ${x.owner}` : ""}</option>)}
            </Select>
          </Field>
          <Field label="文件 / 目录"><Input placeholder="/local/docs 或具体文件" value={path} onChange={(e) => setPath(e.target.value)} aria-label="按文件筛选" /></Field>
          <Field label="访问者 IP"><Input placeholder="如 10.0.0.2" value={ip} onChange={(e) => setIp(e.target.value)} aria-label="按 IP 筛选" /></Field>
          <Field label="关键词"><Input placeholder="用户名 / 路径 / UA" value={q} onChange={(e) => setQ(e.target.value)} aria-label="关键词" /></Field>
        </div>
        <div className="mt-3"><ChipGroup label="类型" options={KINDS} value={kinds} onChange={setKinds} maxVisible={5} /></div>
      </Card>
      {!data ? <div className="flex justify-center py-10"><Spinner /></div> : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard icon={<Activity />} label="事件" value={s!.events} />
            <StatCard icon={<Eye />} label="访问" value={s!.visits} />
            <StatCard icon={<Download />} label="下载" value={s!.downloads} tone="ok" />
            <StatCard icon={<Upload />} label="上传" value={s!.uploads} tone="warn" />
            <StatCard icon={<BarChart3 />} label="流量" value={fmtSize(s!.bytes)} />
            <StatCard icon={<Globe />} label="独立 IP" value={s!.unique_ips} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="按天" className="lg:col-span-3">
              {s!.by_day.length ? (
                <div className="flex h-28 items-end gap-1" data-by-day>
                  {s!.by_day.map((d) => <div key={d.day} title={`${d.day}：${d.count}`} className="min-w-1 flex-1 rounded-t bg-accent/70 transition-all hover:bg-accent" style={{ height: `${(d.count / maxDay) * 100}%` }} />)}
                </div>
              ) : <p className="text-[13px] text-faint">无数据</p>}
            </Card>
            <Top title="热门分享" rows={s!.top_shares.map((x) => ({ k: String(x.share_id), label: x.name ?? `#${x.share_id}`, n: x.count }))} onPick={(k) => setShare(k)} />
            <Top title="热门文件" rows={s!.top_paths.map((x) => ({ k: x.path, label: x.path, n: x.count }))} onPick={(k) => setPath(k)} mono />
            <Top title="访问者 IP" rows={s!.top_ips.map((x) => ({ k: x.ip, label: x.ip, n: x.count }))} onPick={(k) => setIp(k)} mono />
          </div>
          <Card title={`访问明细（${data.total}）`}>
            {data.rows.length === 0 ? <Empty title="没有匹配的记录" /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-[12.5px]" data-stats-rows>
                  <thead className="text-xs text-muted"><tr>{["时间", "动作", "分享", "文件", "访问者", "IP", "流量", ""].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">
                    {data.rows.map((r) => (
                      <tr key={r.id} className="hover:bg-hover">
                        <td className="px-2 py-1 whitespace-nowrap text-muted">{fmtTime(r.ts)}</td>
                        <td className="px-2 py-1">{ACTION_CN[r.action] ?? r.action}</td>
                        <td className="max-w-40 truncate px-2 py-1"><button className="hover:underline" onClick={() => r.share_id && setShare(String(r.share_id))}>{r.share_name ?? "—"}</button></td>
                        <td className="max-w-64 truncate px-2 py-1 font-mono" title={r.path}><button className="hover:underline" onClick={() => setPath(r.path)}>{r.path}</button></td>
                        <td className="px-2 py-1">{r.username || "匿名"}</td>
                        <td className="px-2 py-1 font-mono"><button className="hover:underline" onClick={() => setIp(r.ip)}>{r.ip}</button></td>
                        <td className="px-2 py-1 tabular-nums">{r.bytes ? fmtSize(r.bytes) : ""}</td>
                        <td className="px-2 py-1">{r.allowed ? <Badge tone="ok">允许</Badge> : <Badge tone="danger">拒绝</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {pages > 1 && (
              <div className="mt-3 flex items-center justify-end gap-2 text-[13px]">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
                <span className="tabular-nums text-muted">{page} / {pages}</span>
                <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</Button>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function Top({ title, rows, onPick, mono }: { title: string; rows: { k: string; label: string; n: number }[]; onPick: (k: string) => void; mono?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <Card title={title}>
      {rows.length === 0 ? <p className="text-[13px] text-faint">无数据</p> : (
        <ul className="space-y-1.5 text-[12.5px]">
          {rows.map((r) => (
            <li key={r.k}>
              <button className="group block w-full text-left" onClick={() => onPick(r.k)} title={`筛选：${r.label}`}>
                <span className="flex justify-between gap-2"><span className={`truncate group-hover:underline ${mono ? "font-mono" : ""}`}>{r.label}</span><span className="tabular-nums text-muted">{r.n}</span></span>
                <span className="mt-0.5 block h-1 rounded bg-hover"><span className="block h-1 rounded bg-accent/70" style={{ width: `${(r.n / max) * 100}%` }} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
