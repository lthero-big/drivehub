// Access statistics (DEPTAI-485 r5 C3 → r6 #3 / #4).
// Layout (references: Searchable "Location" view, Canva analytics country bars, Plausible dashboard — via Mobbin):
//   fixed  : header · one-line filter bar (time / scope / share / region / file / IP / keyword + kind chips) ·
//            active-filter pills · KPI strip · tabs
//   scroll : only the tab body scrolls — 访问明细 (sticky table header, pager pinned at the bottom),
//            地区与 IP (offline hotspot map + country / province ranking + per-IP table), 趋势与排行.
import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Download, Eye, Globe, MapPin, RefreshCw, Upload, X } from "lucide-react";
import { call } from "../lib/api";
import { useApp } from "../lib/app";
import { COUNTRIES, LAND_PATH } from "../lib/geo-data";
import { parse } from "../lib/router";
import type { Share } from "../lib/shares";
import { cx, errMsg, fmtSize, fmtTime } from "../lib/util";
import { ChipGroup } from "../ui/r5";
import { Sk, SkChart, SkTable, SkWrap } from "../ui/r6";
import { Badge, Button, Card, Empty, IconButton, Input, PageHeader, Pager, Select, Tabs, toast } from "../ui/ui";

type GeoInfo = { kind: string; code: string; country: string; region: string; city: string; isp: string; label: string };
type Row = { id: number; ts: number; username: string; ip: string; ua: string; client: string; action: string; path: string; allowed: boolean; bytes: number; share_id: number | null; share_name: string | null; detail: string; geo?: string };
type GeoSum = { db: boolean; by_country: { code: string; name: string; count: number; ips: number }[]; by_region: { code: string; country: string; region: string; count: number; ips: number }[] };
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
    top_ips: { ip: string; count: number; geo?: GeoInfo }[];
    geo?: GeoSum;
  };
  rows: Row[];
};
type IpRow = { ip: string; events: number; first_ts: number; last_ts: number; users: string[]; shares: number; visits: number; downloads: number; uploads: number; bytes: number; denied: number; clients: string[]; ua: string; geo: GeoInfo };
type IpResp = { total: number; page: number; per_page: number; db: boolean; rows: IpRow[] };

const KINDS = [
  { value: "visit", label: "访问" },
  { value: "download", label: "下载" },
  { value: "preview", label: "预览" },
  { value: "upload", label: "上传" },
  { value: "denied", label: "被拒绝" },
];
const ACTION_CN: Record<string, string> = { share_visit: "访问分享", share_claim: "提取码进入", share_list: "浏览目录", share_preview: "预览", share_download: "下载", share_direct: "直链下载", share_upload: "上传", share_pin_fail: "提取码错误", download: "下载", preview: "预览" };
const CLIENT_CN: Record<string, string> = { web: "网页", webdav: "WebDAV", api: "API", share: "分享页", mobile: "移动端", desktop: "桌面端" };
const RANGES = [
  { v: "", l: "全部时间" },
  { v: "1", l: "最近 24 小时" },
  { v: "7", l: "最近 7 天" },
  { v: "30", l: "最近 30 天" },
  { v: "custom", l: "自定义…" },
];
const day = (s: string) => (s ? Math.floor(new Date(s + "T00:00:00").getTime() / 1000) : undefined);
export const countryName = (code: string, fallback = "") => (code === "LAN" ? "局域网" : COUNTRIES[code]?.[2] ?? (fallback || code));
type Tab = "rows" | "geo" | "trend";

export function StatsPage() {
  const { isAdmin, me } = useApp();
  const audit = isAdmin || !!me?.caps?.includes("admin_audit");
  const init = parse().q;
  const [tab, setTab] = useState<Tab>((init.get("tab") as Tab) || "rows");
  const [scope, setScope] = useState(init.get("scope") ?? "shares");
  const [share, setShare] = useState(init.get("share_id") ?? "");
  const [path, setPath] = useState(init.get("path") ?? "");
  const [ip, setIp] = useState(init.get("ip") ?? "");
  const [country, setCountry] = useState(init.get("country") ?? "");
  const [region, setRegion] = useState(init.get("region") ?? "");
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [range, setRange] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(() => Number(localStorage.getItem("dh_pagesize_stats")) || 50);
  const [data, setData] = useState<Resp | null>(null);
  const [geoOpts, setGeoOpts] = useState<GeoSum | null>(null);
  const [shares, setShares] = useState<Share[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => void call<Share[]>("GET", `/api/shares${isAdmin ? "?all=true" : ""}`).then(setShares).catch(() => {}), [isAdmin]);
  const filters = useMemo(() => {
    const u = new URLSearchParams({ scope });
    if (share) u.set("share_id", share);
    if (path.trim()) u.set("path", path.trim());
    if (ip.trim()) u.set("ip", ip.trim());
    if (q.trim()) u.set("q", q.trim());
    if (country) u.set("country", country);
    if (region) u.set("region", region);
    if (kinds.length) u.set("kind", kinds.join(","));
    const now = Math.floor(Date.now() / 1000);
    if (range && range !== "custom") u.set("from", String(now - Number(range) * 86400));
    if (range === "custom") {
      const f = day(from), t = day(to);
      if (f) u.set("from", String(f));
      if (t) u.set("to", String(t + 86400));
    }
    return u.toString();
  }, [scope, share, path, ip, q, country, region, kinds, range, from, to]);
  const load = () => {
    setBusy(true);
    call<Resp>("GET", `/api/stats/access?${filters}&page=${page}&per_page=${per}`)
      .then((d) => (setData(d), !country && !region && d.summary.geo && setGeoOpts(d.summary.geo)))
      .catch((e) => toast.err(errMsg(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [filters, page, per]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [filters, per]);
  const s = data?.summary;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.per_page)) : 1;
  const reset = () => (setShare(""), setPath(""), setIp(""), setQ(""), setKinds([]), setRange(""), setFrom(""), setTo(""), setCountry(""), setRegion(""));
  const pickCountry = (c: string, r = "") => (setCountry(c), setRegion(r));
  const pills: { k: string; label: string; clear: () => void }[] = [
    share && { k: "share", label: `分享：${shares.find((x) => String(x.id) === share)?.name ?? `#${share}`}`, clear: () => setShare("") },
    path.trim() && { k: "path", label: `文件：${path}`, clear: () => setPath("") },
    ip.trim() && { k: "ip", label: `IP：${ip}`, clear: () => setIp("") },
    country && { k: "geo", label: `地区：${countryName(country)}${region ? ` · ${region}` : ""}`, clear: () => pickCountry("") },
    q.trim() && { k: "q", label: `关键词：${q}`, clear: () => setQ("") },
  ].filter(Boolean) as { k: string; label: string; clear: () => void }[];
  const countryOpts = geoOpts?.by_country ?? [];
  const regionOpts = (geoOpts?.by_region ?? []).filter((r) => r.code === country);
  return (
    <div className="flex flex-col py-4 sm:h-full" data-stats-page>
      {/* ───── fixed controls ───── */}
      <div className="shrink-0 space-y-3 pb-3" data-stats-controls>
        <PageHeader title="访问统计" desc="分享与文件的访问、下载、上传，含访问者 IP 与地区" actions={<><Button size="sm" variant="ghost" onClick={reset}>重置筛选</Button><Button size="sm" onClick={load} loading={busy}><RefreshCw className="size-4" /> 刷新</Button></>} />
        <div className="ctl-sm flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-panel-2 px-3 py-2.5" data-stats-filters>
          {audit && <Labeled l="范围"><Select size="sm" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="统计范围"><option value="shares">分享访问</option><option value="files">文件直接访问</option><option value="all">全部</option></Select></Labeled>}
          <Labeled l="时间"><Select size="sm" value={range} onChange={(e) => setRange(e.target.value)} aria-label="时间范围">{RANGES.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</Select></Labeled>
          {range === "custom" && <span className="flex items-center gap-1"><Input ctl="sm" type="date" className="w-36" aria-label="开始日期" value={from} onChange={(e) => setFrom(e.target.value)} /><span className="ctl-label">至</span><Input ctl="sm" type="date" className="w-36" aria-label="结束日期" value={to} onChange={(e) => setTo(e.target.value)} /></span>}
          <Labeled l="分享">
            <Select size="sm" className="max-w-52" value={share} onChange={(e) => setShare(e.target.value)} aria-label="按分享筛选">
              <option value="">全部分享</option>
              {shares.map((x) => <option key={x.id} value={String(x.id)}>{x.name}{isAdmin && x.owner ? ` · ${x.owner}` : ""}</option>)}
            </Select>
          </Labeled>
          <Labeled l="地区">
            <Select size="sm" value={country} onChange={(e) => pickCountry(e.target.value)} aria-label="按地区筛选">
              <option value="">全部地区</option>
              {countryOpts.map((c) => <option key={c.code} value={c.code}>{countryName(c.code, c.name)}（{c.count}）</option>)}
            </Select>
            {regionOpts.length > 0 && (
              <Select size="sm" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="按省份筛选">
                <option value="">全部省份</option>
                {regionOpts.map((r) => <option key={r.region} value={r.region}>{r.region}（{r.count}）</option>)}
              </Select>
            )}
          </Labeled>
          <Input ctl="sm" className="w-44" placeholder="文件 / 目录" value={path} onChange={(e) => setPath(e.target.value)} aria-label="按文件筛选" />
          <Input ctl="sm" className="w-32" placeholder="访问者 IP" value={ip} onChange={(e) => setIp(e.target.value)} aria-label="按 IP 筛选" />
          <Input ctl="sm" className="w-40" placeholder="关键词：用户 / 路径 / UA" value={q} onChange={(e) => setQ(e.target.value)} aria-label="关键词" />
          <div className="basis-full"><ChipGroup label="类型" options={KINDS} value={kinds} onChange={setKinds} maxVisible={5} /></div>
        </div>
        {pills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-active-filters>
            {pills.map((p) => <button key={p.k} type="button" onClick={p.clear} className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-soft px-2.5 text-[12px] text-accent hover:bg-accent hover:text-accent-fg" aria-label={`移除筛选 ${p.label}`}>{p.label}<X className="size-3" /></button>)}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-7" data-kpis>
          {s ? (<>
            <Kpi icon={<Activity />} label="事件" v={s.events} />
            <Kpi icon={<Eye />} label="访问" v={s.visits} />
            <Kpi icon={<Download />} label="下载" v={s.downloads} tone="ok" />
            <Kpi icon={<Upload />} label="上传" v={s.uploads} tone="warn" />
            <Kpi icon={<BarChart3 />} label="流量" v={fmtSize(s.bytes)} />
            <Kpi icon={<Globe />} label="独立 IP" v={s.unique_ips} />
            <Kpi icon={<MapPin />} label="地区" v={s.geo?.by_country.length ?? 0} />
          </>) : Array.from({ length: 7 }, (_, i) => <Sk key={i} className="h-[52px] rounded-xl" />)}
        </div>
        <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: "rows", label: `访问明细${data ? `（${data.total}）` : ""}` }, { id: "geo", label: "地区与 IP" }, { id: "trend", label: "趋势与排行" }]} />
      </div>

      {/* ───── the only scrolling region ───── */}
      <div className="scroll-thin min-h-0 flex-1 overflow-auto rounded-2xl border border-line bg-panel" data-stats-scroll={tab}>
        {tab === "rows" && (!data ? <SkTable cols={[2, 2, 2, 4, 2, 2, 3, 1, 1]} rows={10} label="正在加载访问明细" /> : data.rows.length === 0 ? <Empty title="没有匹配的记录" /> : (
          <table className="w-full min-w-[920px] text-left text-[12.5px]" data-stats-rows>
            <thead className="sticky top-0 z-10 bg-panel-2 text-xs text-muted shadow-[0_1px_0_var(--line)]"><tr>{["时间", "动作", "分享", "文件", "访问者", "IP", "地区", "流量", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line">
              {data.rows.map((r) => (
                <tr key={r.id} className="hover:bg-hover">
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{ACTION_CN[r.action] ?? r.action}</td>
                  <td className="max-w-40 truncate px-3 py-1.5"><button className="hover:underline" onClick={() => r.share_id && setShare(String(r.share_id))}>{r.share_name ?? "—"}</button></td>
                  <td className="max-w-64 truncate px-3 py-1.5 font-mono" title={r.path}><button className="hover:underline" onClick={() => setPath(r.path)}>{r.path}</button></td>
                  <td className="px-3 py-1.5">{r.username || "匿名"}</td>
                  <td className="px-3 py-1.5 font-mono"><button className="hover:underline" onClick={() => setIp(r.ip)}>{r.ip}</button></td>
                  <td className="max-w-44 truncate px-3 py-1.5 text-muted" title={r.geo}>{r.geo ?? ""}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.bytes ? fmtSize(r.bytes) : ""}</td>
                  <td className="px-3 py-1.5">{r.allowed ? <Badge tone="ok">允许</Badge> : <Badge tone="danger">拒绝</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {tab === "geo" && <GeoTab s={s} filters={filters} country={country} region={region} pick={pickCountry} setIp={setIp} />}
        {tab === "trend" && <TrendTab s={s} setShare={setShare} setPath={setPath} setIp={setIp} />}
      </div>
      {tab === "rows" && data && data.total > 0 && (
        <div className="shrink-0" data-stats-pager>
          <Pager page={page} pages={pages} total={data.total} size={per} sizes={[20, 50, 100, 200]} setPage={setPage} setSize={(n) => (localStorage.setItem("dh_pagesize_stats", String(n)), setPer(n))} />
        </div>
      )}
    </div>
  );
}

function Labeled({ l, children }: { l: string; children: React.ReactNode }) {
  return <span className="flex items-center gap-1.5"><span className="ctl-label">{l}</span>{children}</span>;
}

function Kpi({ icon, label, v, tone = "accent" }: { icon: React.ReactNode; label: string; v: React.ReactNode; tone?: "accent" | "ok" | "warn" }) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2" data-kpi={label}>
      <span className={cx("hidden size-7 shrink-0 items-center justify-center rounded-lg sm:flex [&>svg]:size-3.5", tone === "accent" && "bg-accent-soft text-accent", tone === "ok" && "bg-ok/12 text-ok", tone === "warn" && "bg-warn/15 text-warn")}>{icon}</span>
      <span className="min-w-0"><span className="block text-[11px] text-muted">{label}</span><span className="block truncate text-[15px] leading-tight font-semibold tabular-nums">{v}</span></span>
    </div>
  );
}

/* ───────────────────────── 地区与 IP ───────────────────────── */

function GeoTab({ s, filters, country, region, pick, setIp }: { s?: Resp["summary"]; filters: string; country: string; region: string; pick: (c: string, r?: string) => void; setIp: (v: string) => void }) {
  const [ips, setIps] = useState<IpResp | null>(null);
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(20);
  const [sort, setSort] = useState("count");
  useEffect(() => setPage(1), [filters, per, sort]);
  useEffect(() => {
    call<IpResp>("GET", `/api/stats/ips?${filters}&page=${page}&per_page=${per}&sort=${sort}`).then(setIps).catch((e) => toast.err(errMsg(e)));
  }, [filters, page, per, sort]);
  const geo = s?.geo;
  if (!geo) return <SkWrap className="grid gap-4 p-4 lg:grid-cols-[1.6fr_1fr]"><Sk className="h-72 rounded-xl" /><SkTable cols={[3, 1, 1]} rows={6} /></SkWrap>;
  const cn = geo.by_region.filter((r) => r.code === "CN");
  const max = Math.max(1, ...geo.by_country.map((c) => c.count));
  return (
    <div className="space-y-4 p-4" data-geo-tab>
      {!geo.db && <p className="rounded-lg bg-warn/12 px-3 py-2 text-[12.5px] text-warn" data-geo-nodb>未安装离线 IP 库：内网 IP 仍会标注为「局域网」，公网 IP 暂不能解析到国家 / 省份。运行 <code>scripts/fetch-geoip.sh</code> 下载 ip2region 数据（免费、离线）后重启即可。</p>}
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card title="访问热点地图" actions={<span className="text-xs text-muted">点击气泡按国家筛选</span>}>
          <WorldMap rows={geo.by_country} active={country} onPick={(c) => pick(c === country ? "" : c)} />
        </Card>
        <Card title="来源国家 / 地区">
          {geo.by_country.length === 0 ? <p className="text-[13px] text-faint">无数据</p> : (
            <ul className="space-y-2" data-country-list>
              {geo.by_country.map((c) => (
                <li key={c.code}>
                  <button type="button" onClick={() => pick(c.code === country ? "" : c.code)} className={cx("group block w-full rounded-lg px-1.5 py-1 text-left text-[12.5px]", country === c.code ? "bg-accent-soft" : "hover:bg-hover")} data-country={c.code}>
                    <span className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-1.5"><CodeBadge code={c.code} /><span className="truncate">{countryName(c.code, c.name)}</span></span><span className="shrink-0 tabular-nums text-muted">{c.count} 次 · {c.ips} IP</span></span>
                    <span className="mt-1 block h-1.5 rounded-full bg-hover"><span className={cx("block h-1.5 rounded-full", c.code === "LAN" ? "bg-ok/70" : "bg-accent/70")} style={{ width: `${(c.count / max) * 100}%` }} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {(cn.length > 0 || country === "CN") && (
        <Card title="中国省份分布" actions={region && <Button size="sm" variant="ghost" onClick={() => pick("CN")}>清除省份</Button>}>
          <ChinaTiles rows={cn} active={region} onPick={(r) => pick("CN", r === region ? "" : r)} />
        </Card>
      )}
      <Card title={`访问者 IP${ips ? `（${ips.total}）` : ""}`} actions={<Select size="sm" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="IP 排序"><option value="count">按次数</option><option value="last">按最近访问</option><option value="bytes">按流量</option></Select>}>
        {!ips ? <SkTable cols={[2, 3, 2, 1, 2, 2, 2, 2]} rows={6} label="正在加载 IP" /> : ips.rows.length === 0 ? <Empty title="没有 IP 记录" /> : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-[12.5px]" data-ip-table>
              <thead className="text-xs text-muted"><tr>{["IP", "地区", "运营商", "次数", "访问 / 下载 / 上传", "流量", "用户", "来源客户端", "最近访问", ""].map((h) => <th key={h} className="px-3 py-1.5 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {ips.rows.map((r) => (
                  <tr key={r.ip} className="hover:bg-hover" data-ip-row={r.ip}>
                    <td className="px-3 py-1.5 font-mono">{r.ip}</td>
                    <td className="px-3 py-1.5"><span className="flex items-center gap-1.5"><CodeBadge code={r.geo.kind === "lan" || r.geo.kind === "loopback" ? "LAN" : r.geo.code} />{r.geo.label}</span></td>
                    <td className="max-w-32 truncate px-3 py-1.5 text-muted">{r.geo.isp || "—"}</td>
                    <td className="px-3 py-1.5 tabular-nums">{r.events}{r.denied > 0 && <span className="ml-1 text-danger" title="被拒绝">({r.denied}✕)</span>}</td>
                    <td className="px-3 py-1.5 tabular-nums">{r.visits} / {r.downloads} / {r.uploads}</td>
                    <td className="px-3 py-1.5 tabular-nums">{r.bytes ? fmtSize(r.bytes) : "—"}</td>
                    <td className="max-w-32 truncate px-3 py-1.5" title={r.users.join("、")}>{r.users.length ? r.users.join("、") : "匿名"}</td>
                    <td className="max-w-40 truncate px-3 py-1.5" title={r.ua}>{r.clients.map((c) => CLIENT_CN[c] ?? c).join("、") || "—"}{r.shares > 0 && <span className="text-muted"> · {r.shares} 个分享</span>}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted" title={`首次 ${fmtTime(r.first_ts)}`}>{fmtTime(r.last_ts)}</td>
                    <td className="px-2 py-1"><IconButton size="sm" label={`只看 ${r.ip}`} onClick={() => setIp(r.ip)}><MapPin /></IconButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {ips && <Pager page={ips.page} pages={Math.max(1, Math.ceil(ips.total / ips.per_page))} total={ips.total} size={per} sizes={[10, 20, 50, 100]} unit="个" setPage={setPage} setSize={setPer} />}
      </Card>
    </div>
  );
}

function CodeBadge({ code }: { code: string }) {
  const lan = code === "LAN";
  return <span className={cx("inline-flex h-4 min-w-6 shrink-0 items-center justify-center rounded px-1 font-mono text-[9.5px] font-semibold", lan ? "bg-ok/15 text-ok" : code && code !== "??" ? "bg-accent-soft text-accent" : "bg-hover text-faint")}>{lan ? "LAN" : code && code !== "??" ? code : "?"}</span>;
}

/** Simplified offline world map (equirectangular land outline) with hotspot bubbles at country centroids.
 *  LAN traffic has no location, so it gets its own pinned bubble in the corner. */
function WorldMap({ rows, active, onPick }: { rows: GeoSum["by_country"]; active: string; onPick: (code: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const r = (n: number) => 2.2 + Math.sqrt(n / max) * 9;
  const placed = rows.filter((c) => COUNTRIES[c.code]);
  const lan = rows.find((c) => c.code === "LAN");
  const unknown = rows.filter((c) => c.code !== "LAN" && !COUNTRIES[c.code]);
  const h = hover ? rows.find((c) => c.code === hover) : null;
  return (
    <div className="relative" data-world-map>
      <svg viewBox="0 6 360 146" className="w-full" role="img" aria-label="访问来源地图">
        <path d={LAND_PATH} className="fill-[var(--hover)] stroke-[var(--line)]" strokeWidth={0.3} />
        {placed.map((c) => {
          const [lon, lat] = COUNTRIES[c.code];
          const on = active === c.code;
          return (
            <g key={c.code} className="cursor-pointer" onClick={() => onPick(c.code)} onMouseEnter={() => setHover(c.code)} onMouseLeave={() => setHover(null)} data-bubble={c.code}>
              <circle cx={lon + 180} cy={90 - lat} r={r(c.count) * 1.8} className="map-pulse fill-[var(--accent)]" opacity={0.18} />
              <circle cx={lon + 180} cy={90 - lat} r={r(c.count)} className={cx("fill-[var(--accent)] stroke-[var(--panel)]", on && "fill-[var(--danger)]")} strokeWidth={0.6} opacity={on ? 0.95 : 0.75} />
            </g>
          );
        })}
      </svg>
      {lan && (
        <button type="button" onClick={() => onPick("LAN")} data-bubble="LAN" className={cx("absolute bottom-1 left-1 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]", active === "LAN" ? "border-ok bg-ok text-white" : "border-ok/40 bg-ok/10 text-ok hover:bg-ok/20")}>
          <span className="size-2 rounded-full bg-current" /> 局域网 {lan.count} 次 · {lan.ips} IP
        </button>
      )}
      {unknown.length > 0 && <p className="absolute right-1 bottom-1 text-[11px] text-faint">未定位：{unknown.reduce((a, b) => a + b.count, 0)} 次</p>}
      {h && <div className="pointer-events-none absolute top-1 right-1 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-[12px] shadow-card" data-map-tip><b>{countryName(h.code, h.name)}</b><br />{h.count} 次访问 · {h.ips} 个 IP</div>}
    </div>
  );
}

/** China province tile-grid heat map (no geo data needed; one tile per province, roughly geographic). */
const CN_TILES: [string, number, number][] = [
  ["黑龙江省", 9, 0], ["内蒙古", 6, 1], ["吉林省", 9, 1], ["新疆", 1, 2], ["宁夏", 4, 2], ["山西省", 5, 2], ["北京市", 6, 2], ["天津市", 7, 2], ["辽宁省", 8, 2],
  ["西藏", 1, 3], ["青海省", 2, 3], ["甘肃省", 3, 3], ["陕西省", 4, 3], ["河北省", 5, 3], ["山东省", 6, 3],
  ["四川省", 3, 4], ["重庆市", 4, 4], ["河南省", 5, 4], ["湖北省", 6, 4], ["安徽省", 7, 4], ["江苏省", 8, 4],
  ["云南省", 3, 5], ["贵州省", 4, 5], ["湖南省", 5, 5], ["江西省", 6, 5], ["浙江省", 7, 5], ["上海市", 8, 5],
  ["广西", 4, 6], ["广东省", 5, 6], ["福建省", 6, 6], ["台湾省", 8, 6], ["海南省", 4, 7], ["澳门特别行政区", 5, 7], ["香港特别行政区", 6, 7],
];
const short = (n: string) => n.replace(/(特别行政区|省|市)$/, "");
function ChinaTiles({ rows, active, onPick }: { rows: GeoSum["by_region"]; active: string; onPick: (region: string) => void }) {
  const by = new Map(rows.map((r) => [r.region, r]));
  const max = Math.max(1, ...rows.map((r) => r.count));
  const other = rows.filter((r) => !CN_TILES.some((t) => t[0] === r.region));
  return (
    <div className="flex flex-wrap items-start gap-6" data-china-tiles>
      <div className="grid grid-cols-10 gap-1" style={{ gridTemplateRows: "repeat(8, minmax(0, 1fr))" }}>
        {CN_TILES.map(([name, c, r]) => {
          const v = by.get(name);
          const t = v ? 0.18 + 0.82 * (v.count / max) : 0;
          return (
            <button key={name} type="button" disabled={!v} onClick={() => onPick(name)} title={v ? `${name}：${v.count} 次 · ${v.ips} 个 IP` : `${name}：无访问`} data-tile={name}
              style={{ gridColumn: c + 1, gridRow: r + 1, background: v ? `color-mix(in srgb, var(--accent) ${Math.round(t * 100)}%, var(--panel))` : undefined }}
              className={cx("flex size-11 flex-col items-center justify-center rounded-lg text-[10.5px] leading-tight sm:size-12", v ? (t > 0.55 ? "text-accent-fg" : "text-fg") : "bg-hover text-faint", active === name && "ring-2 ring-danger ring-offset-1 ring-offset-panel")}>
              <span>{short(name)}</span>{v && <span className="tabular-nums font-semibold">{v.count}</span>}
            </button>
          );
        })}
      </div>
      <div className="min-w-48 flex-1 space-y-1 text-[12.5px]">
        <p className="mb-1 text-xs text-muted">颜色越深访问越多 · 点击省份筛选</p>
        {rows.slice(0, 10).map((r) => <button key={r.region} type="button" onClick={() => onPick(r.region)} className={cx("flex w-full justify-between rounded-md px-1.5 py-0.5 text-left", active === r.region ? "bg-accent-soft text-accent" : "hover:bg-hover")}><span>{r.region}</span><span className="tabular-nums text-muted">{r.count} 次 · {r.ips} IP</span></button>)}
        {other.length > 0 && <p className="pt-1 text-[11px] text-faint">其他：{other.map((o) => o.region).join("、")}</p>}
      </div>
    </div>
  );
}

/* ───────────────────────── 趋势与排行 ───────────────────────── */

function TrendTab({ s, setShare, setPath, setIp }: { s?: Resp["summary"]; setShare: (v: string) => void; setPath: (v: string) => void; setIp: (v: string) => void }) {
  if (!s) return <div className="space-y-4 p-4"><div className="rounded-2xl border border-line p-5"><SkChart /></div><SkTable cols={[3, 1]} rows={5} /></div>;
  const maxDay = Math.max(1, ...s.by_day.map((d) => d.count));
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-3" data-trend-tab>
      <Card title="按天" className="lg:col-span-3">
        {s.by_day.length ? (
          <div className="flex h-32 items-end gap-1" data-by-day>
            {s.by_day.map((d) => <div key={d.day} title={`${d.day}：${d.count}`} className="min-w-1 flex-1 rounded-t bg-accent/70 transition-all hover:bg-accent" style={{ height: `${(d.count / maxDay) * 100}%` }} />)}
          </div>
        ) : <p className="text-[13px] text-faint">无数据</p>}
      </Card>
      <Top title="热门分享" rows={s.top_shares.map((x) => ({ k: String(x.share_id), label: x.name ?? `#${x.share_id}`, n: x.count }))} onPick={setShare} />
      <Top title="热门文件" rows={s.top_paths.map((x) => ({ k: x.path, label: x.path, n: x.count }))} onPick={setPath} mono />
      <Top title="访问者 IP" rows={s.top_ips.map((x) => ({ k: x.ip, label: x.geo ? `${x.ip} · ${x.geo.label}` : x.ip, n: x.count }))} onPick={setIp} mono />
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
