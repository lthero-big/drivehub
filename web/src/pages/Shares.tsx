import { useEffect, useState } from "react";
import { LoadingButton } from "../ui/motion";
import { ArrowRight, BarChart3, Copy, Link2, Pencil, QrCode, RefreshCw, Trash2 } from "lucide-react";
import { call, type FsItem } from "../lib/api";
import { go } from "../lib/router";
import { useApp } from "../lib/app";
import { abs, copy, PERM_NAMES, qrDataUrl, STATUS_NAMES, type Share } from "../lib/shares";
import { errMsg, fmtSize, fmtTime } from "../lib/util";
import { Badge, Button, confirmDlg, Empty, Field, IconButton, Input, Modal, Select, Switch, toast } from "../ui/ui";
import { PickupBox } from "./SharePublic";

const tone = (s: string) => (s === "active" ? "ok" : s === "revoked" ? "danger" : "warn") as "ok";

/** My shares: list, stats, QR, edit limits, revoke, delete. */
export function SharesPage() {
  const { isAdmin, me } = useApp();
  const canAll = isAdmin || !!me?.caps?.includes("share_manage");
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Share[] | null>(null);
  const [qr, setQr] = useState<{ s: Share; img: string } | null>(null);
  const [stats, setStats] = useState<Share | null>(null);
  const [edit, setEdit] = useState<Share | null>(null);
  const load = () => call<Share[]>("GET", `/api/shares${all ? "?all=true" : ""}`).then(setRows).catch((e) => toast.err(errMsg(e)));
  useEffect(() => void load(), [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = (s: Share) => abs(s.url_with_pin ?? s.url);
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  return (
    <div className="mx-auto max-w-6xl space-y-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">我的分享</h1>
        <PickupBox compact />
        {canAll && <label className="flex items-center gap-1 text-[13px] text-muted"><Switch checked={all} onChange={setAll} label="全部用户" />全部用户</label>}
        <Button variant="ghost" onClick={() => go("#/stats")}><BarChart3 className="size-4" /> 访问统计总览</Button>
        <IconButton label="刷新" onClick={load}><RefreshCw className="size-4" /></IconButton>
      </div>
      {rows && rows.length === 0 && <Empty title="还没有分享">在文件列表中选中文件后点击「分享」</Empty>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[860px] text-left text-[12.5px]">
            <thead className="border-b border-line bg-panel-2 text-xs text-muted">
              <tr>{["生效", "名称", "状态", "权限", "提取码", "访问", "下载", "到期", "创建", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((s) => (
                <tr key={s.id} className="hover:bg-hover" data-share-row={s.id}>
                  <td className="px-2 py-0.5"><Switch checked={!s.revoked} onChange={(on) => act(() => call("PATCH", `/api/shares/${s.id}`, { revoked: !on }).then(() => toast.ok(on ? "分享已生效" : "分享已失效")))} label={s.revoked ? `启用分享 ${s.name}` : `停用分享 ${s.name}`} /></td>
                  <td className="max-w-60 truncate px-3 py-1.5" title={s.items.join("\n")}>{s.name}{all && <span className="text-muted"> · {s.owner}</span>}</td>
                  <td className="px-3 py-1.5"><Badge tone={tone(s.status)}>{STATUS_NAMES[s.status]}</Badge></td>
                  <td className="px-3 py-1.5">{PERM_NAMES[s.perm]}</td>
                  <td className="px-3 py-1.5 font-mono">{s.pin ?? "—"}</td>
                  <td className="px-3 py-1.5 tabular-nums">{s.visits}{s.max_visits ? ` / ${s.max_visits}` : ""}</td>
                  <td className="px-3 py-1.5 tabular-nums">{s.downloads}{s.max_downloads ? ` / ${s.max_downloads}` : ""}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.expires_at ? fmtTime(s.expires_at) : "永久"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtTime(s.created_at)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <IconButton label="复制链接" onClick={() => copy(link(s)).then(() => toast.ok("链接已复制"), () => toast.err("复制失败"))}><Copy className="size-4" /></IconButton>
                    {s.direct_url && <IconButton label="复制直链" onClick={() => copy(abs(s.direct_url!)).then(() => toast.ok("直链已复制"), () => toast.err("复制失败"))}><Link2 className="size-4" /></IconButton>}
                    <IconButton label="二维码" onClick={async () => setQr({ s, img: await qrDataUrl(link(s)) })}><QrCode className="size-4" /></IconButton>
                    <IconButton label="访问统计" onClick={() => call<Share>("GET", `/api/shares/${s.id}`).then(setStats)}><BarChart3 className="size-4" /></IconButton>
                    <IconButton label="修改限制" onClick={() => setEdit(s)}><Pencil className="size-4" /></IconButton>
                    <IconButton label="删除" onClick={async () => (await confirmDlg(`删除分享「${s.name}」？`, { danger: true })) && act(() => call("DELETE", `/api/shares/${s.id}`))}><Trash2 className="size-4" /></IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!qr} onClose={() => setQr(null)} title={qr?.s.name ?? ""}>
        {qr && (
          <div className="space-y-2 text-center text-[13px]">
            <img src={qr.img} alt="二维码" className="mx-auto size-48" />
            <p className="break-all">{link(qr.s)}</p>
            <p>取件码：<b className="font-mono">{qr.s.pickup_code}</b></p>
          </div>
        )}
      </Modal>
      <Modal open={!!stats} onClose={() => setStats(null)} title={`访问统计 · ${stats?.name ?? ""}`} wide>
        {stats?.stats && (
          <div className="space-y-3 text-[13px]">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-muted">最近 100 条访问 · 简版</p><Button size="sm" variant="primary" data-full-stats onClick={() => (setStats(null), go(`#/stats?share_id=${stats.id}`))}>查看完整访问统计 <ArrowRight className="size-4" /></Button></div>
            <p>访问 {stats.visits} 次 · 下载 {stats.downloads} 次 · 上传 {stats.uploads} 次 · 流量 {fmtSize(stats.bytes)} · 独立 IP {stats.stats.unique_ips}</p>
            <div className="flex flex-wrap gap-1.5">{stats.stats.by_action.map((a) => <Badge key={a.action}>{a.action} × {a.count}</Badge>)}</div>
            <table className="w-full text-left text-xs">
              <tbody className="divide-y divide-line">
                {stats.stats.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1 pr-2 whitespace-nowrap text-muted">{fmtTime(r.ts)}</td>
                    <td className="pr-2">{r.action}</td>
                    <td className="pr-2">{r.username}</td>
                    <td className="pr-2 font-mono">{r.ip}</td>
                    <td className="max-w-64 truncate pr-2 font-mono" title={r.path}>{r.path}</td>
                    <td>{r.allowed ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
      {edit && <EditShare s={edit} onClose={() => setEdit(null)} onSaved={() => (setEdit(null), load())} />}
    </div>
  );
}

function EditShare({ s, onClose, onSaved }: { s: Share; onClose: () => void; onSaved: () => void }) {
  const [days, setDays] = useState("");
  const [visits, setVisits] = useState(s.max_visits?.toString() ?? "");
  const [downloads, setDownloads] = useState(s.max_downloads?.toString() ?? "");
  const [pin, setPin] = useState(s.pin ?? "");
  const [perm, setPerm] = useState<string>(s.perm);
  const [login, setLogin] = useState(s.require_login);
  const [isDir, setIsDir] = useState(s.perm === "upload");
  useEffect(() => {
    if (s.items.length !== 1) return;
    call<FsItem>("GET", `/api/fs/stat?path=${encodeURIComponent(s.items[0].startsWith("/") ? s.items[0] : "/" + s.items[0])}`).then((i) => setIsDir(i.is_dir)).catch(() => {});
  }, [s]);
  const save = async () => {
    try {
      await call("PATCH", `/api/shares/${s.id}`, {
        ...(days !== "" ? { days: Number(days) } : {}),
        max_visits: visits ? Number(visits) : null,
        max_downloads: downloads ? Number(downloads) : null,
        pin: pin || null,
        perm,
        require_login: login,
      });
      toast.ok("已保存");
      onSaved();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  return (
    <Modal open onClose={onClose} title={`修改 · ${s.name}`} footer={<><Button variant="ghost" onClick={onClose}>取消</Button><LoadingButton variant="primary" onClick={save}>保存</LoadingButton></>}>
      <div className="space-y-3">
        <Field label="重新设置有效天数" hint={s.expires_at ? `当前到期：${fmtTime(s.expires_at)}；0 = 永久` : "当前永久；留空不修改"}><Input type="number" min={0} value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="最大访问"><Input type="number" min={0} placeholder="不限" value={visits} onChange={(e) => setVisits(e.target.value)} /></Field>
          <Field label="最大下载"><Input type="number" min={0} placeholder="不限" value={downloads} onChange={(e) => setDownloads(e.target.value)} /></Field>
        </div>
        <Field label="提取码（留空 = 无）"><Input value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
        <Field label="权限">
          <Select value={perm} onChange={(e) => setPerm(e.target.value)}>{Object.entries(PERM_NAMES).filter(([k]) => k !== "upload" || isDir).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        </Field>
        <Switch checked={login} onChange={setLogin} label="需要登录" />
      </div>
    </Modal>
  );
}
