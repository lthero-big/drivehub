import { useEffect, useState } from "react";
import { LoadingButton } from "../ui/motion";
import { BarChart3, Copy, Inbox, Pencil, QrCode, RefreshCw, Trash2, XCircle } from "lucide-react";
import { call } from "../lib/api";
import { useApp } from "../lib/app";
import { abs, copy, PERM_NAMES, qrDataUrl, STATUS_NAMES, type Share } from "../lib/shares";
import { errMsg, fmtSize, fmtTime } from "../lib/util";
import { Badge, Button, confirmDlg, Empty, Field, IconButton, Input, Modal, Select, Switch, toast } from "../ui/ui";
import { PickupBox } from "./SharePublic";

const tone = (s: string) => (s === "active" ? "ok" : s === "revoked" ? "danger" : "warn") as "ok";

/** My shares: list, stats, QR, edit limits, revoke, delete. */
export function SharesPage() {
  const { isAdmin } = useApp();
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Share[] | null>(null);
  const [qr, setQr] = useState<{ s: Share; img: string } | null>(null);
  const [stats, setStats] = useState<Share | null>(null);
  const [edit, setEdit] = useState<Share | null>(null);
  const [newRoom, setNewRoom] = useState(false);
  const [kind, setKind] = useState<"" | "share" | "room">("");
  const load = () => call<Share[]>("GET", `/api/shares${all ? "?all=true" : ""}`).then(setRows).catch((e) => toast.err(errMsg(e)));
  useEffect(() => void load(), [all]); // eslint-disable-line react-hooks/exhaustive-deps
  const link = (s: Share) => {
    const u = s.kind === "room" && s.room_url ? s.room_url : s.url;
    return abs(s.pin ? `${u}-${s.pin}` : u);
  };
  const shown = rows?.filter((s) => !kind || (s.kind ?? "share") === kind) ?? null;
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
        <Select value={kind} onChange={(e) => setKind(e.target.value as "")} aria-label="分享类型"><option value="">全部类型</option><option value="share">普通分享</option><option value="room">快传房间</option></Select>
        <Button variant="primary" onClick={() => setNewRoom(true)}><Inbox className="size-4" /> 新建快传房间</Button>
        {isAdmin && <Switch checked={all} onChange={setAll} label="全部用户" />}
        <IconButton label="刷新" onClick={load}><RefreshCw className="size-4" /></IconButton>
      </div>
      {rows && rows.length === 0 && <Empty title="还没有分享">在文件列表中选中文件后点击「分享」</Empty>}
      {shown && shown.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full min-w-[860px] text-left text-[12.5px]">
            <thead className="border-b border-line bg-panel-2 text-xs text-muted">
              <tr>{["名称", "类型", "状态", "权限", "提取码", "访问", "下载", "上传", "到期", "创建", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {shown.map((s) => (
                <tr key={s.id} className="hover:bg-hover">
                  <td className="max-w-60 truncate px-3 py-1.5" title={s.items.join("\n")}>{s.name}{all && <span className="text-muted"> · {s.owner}</span>}</td>
                  <td className="px-3 py-1.5">{s.kind === "room" ? <Badge tone="accent">快传房间</Badge> : <span className="text-muted">分享</span>}</td>
                  <td className="px-3 py-1.5"><Badge tone={tone(s.status)}>{STATUS_NAMES[s.status]}</Badge></td>
                  <td className="px-3 py-1.5">{s.kind === "room" ? [s.allow_upload ? "上传" : null, s.allow_download !== false ? "下载" : null].filter(Boolean).join(" + ") || "—" : PERM_NAMES[s.perm]}</td>
                  <td className="px-3 py-1.5 font-mono">{s.pin ?? "—"}</td>
                  <td className="px-3 py-1.5 tabular-nums">{s.visits}{s.max_visits ? ` / ${s.max_visits}` : ""}</td>
                  <td className="px-3 py-1.5 tabular-nums">{s.downloads}{s.max_downloads ? ` / ${s.max_downloads}` : ""}</td>
                  <td className="px-3 py-1.5 tabular-nums whitespace-nowrap">{s.uploads}{s.max_uploads ? ` / ${s.max_uploads}` : ""}{s.kind === "room" && s.max_bytes ? <span className="text-muted"> · {fmtSize(s.up_bytes ?? 0)} / {fmtSize(s.max_bytes)}</span> : null}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.expires_at ? fmtTime(s.expires_at) : "永久"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{fmtTime(s.created_at)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <IconButton label="复制链接" onClick={() => (copy(link(s)), toast.ok("已复制"))}><Copy className="size-4" /></IconButton>
                    <IconButton label="二维码" onClick={async () => setQr({ s, img: await qrDataUrl(link(s)) })}><QrCode className="size-4" /></IconButton>
                    <IconButton label="访问统计" onClick={() => call<Share>("GET", `/api/shares/${s.id}`).then(setStats)}><BarChart3 className="size-4" /></IconButton>
                    <IconButton label="修改限制" onClick={() => setEdit(s)}><Pencil className="size-4" /></IconButton>
                    {!s.revoked && <IconButton label="立即失效" onClick={() => act(() => call("POST", `/api/shares/${s.id}/revoke`))}><XCircle className="size-4" /></IconButton>}
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
      {newRoom && <NewRoom onClose={() => setNewRoom(false)} onCreated={(s) => (setNewRoom(false), load(), copy(link(s)), toast.ok("房间已创建，链接已复制"))} />}
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
  const room = s.kind === "room";
  const [allowUp, setAllowUp] = useState(!!s.allow_upload);
  const [allowDl, setAllowDl] = useState(s.allow_download !== false);
  const [maxUp, setMaxUp] = useState(s.max_uploads?.toString() ?? "");
  const [maxMb, setMaxMb] = useState(s.max_bytes ? String(+(s.max_bytes / 2 ** 20).toFixed(1)) : "");
  const save = async () => {
    try {
      await call("PATCH", `/api/shares/${s.id}`, {
        ...(days !== "" ? { days: Number(days) } : {}),
        max_visits: visits ? Number(visits) : null,
        max_downloads: downloads ? Number(downloads) : null,
        pin: pin || null,
        ...(room ? { allow_upload: allowUp, allow_download: allowDl, max_uploads: maxUp ? Number(maxUp) : null, max_bytes: maxMb ? Math.round(Number(maxMb) * 2 ** 20) : null } : { perm }),
        require_login: login,
        revoked: false,
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
        {room ? (
          <>
            <div className="flex gap-4"><Switch checked={allowUp} onChange={setAllowUp} label="允许上传" /><Switch checked={allowDl} onChange={setAllowDl} label="允许下载" /></div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="最多上传文件数"><Input type="number" min={0} placeholder="不限" value={maxUp} onChange={(e) => setMaxUp(e.target.value)} /></Field>
              <Field label="总大小上限（MB）"><Input type="number" min={0} placeholder="不限" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} /></Field>
            </div>
          </>
        ) : (
          <Field label="权限">
            <Select value={perm} onChange={(e) => setPerm(e.target.value)}>{Object.entries(PERM_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
          </Field>
        )}
        <Switch checked={login} onChange={setLogin} label="需要登录" />
      </div>
    </Modal>
  );
}

/** Create a drop room (快传房间): a temporary folder share visitors can upload into / download from. */
function NewRoom({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Share) => void }) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("/");
  const [hours, setHours] = useState("24");
  const [usePin, setUsePin] = useState(false);
  const [pin, setPin] = useState("");
  const [allowUp, setAllowUp] = useState(true);
  const [allowDl, setAllowDl] = useState(true);
  const [visits, setVisits] = useState("");
  const [maxUp, setMaxUp] = useState("");
  const [maxMb, setMaxMb] = useState("");
  const create = async () => {
    try {
      const s = await call<Share>("POST", "/api/shares", {
        room: true,
        paths: [parent || "/"],
        name: name || null,
        ...(hours ? { expires_in_secs: Math.round(Number(hours) * 3600) } : {}),
        ...(usePin ? (pin ? { pin } : { random_pin: true }) : {}),
        allow_upload: allowUp,
        allow_download: allowDl,
        max_visits: visits ? Number(visits) : null,
        max_uploads: maxUp ? Number(maxUp) : null,
        max_bytes: maxMb ? Math.round(Number(maxMb) * 2 ** 20) : null,
      });
      onCreated(s);
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  return (
    <Modal open onClose={onClose} title="新建快传房间" footer={<><Button variant="ghost" onClick={onClose}>取消</Button><LoadingButton variant="primary" onClick={create}>创建</LoadingButton></>}>
      <div className="space-y-3">
        <p className="text-xs text-muted">在所选目录下创建临时文件夹 <code>.droprooms/…</code>，通过 /r/&lt;code&gt; 链接让他人上传 / 下载；到期后房间及文件自动清理。</p>
        <Field label="名称（可选）"><Input value={name} placeholder="快传房间" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="存放位置" hint="例如 /local/inbox；需要该目录的上传 + 新建 + 分享权限"><Input value={parent} onChange={(e) => setParent(e.target.value)} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="有效期（小时）" hint="留空 = 永久"><Input type="number" min={0} value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
          <Field label="最大访问次数"><Input type="number" min={0} placeholder="不限" value={visits} onChange={(e) => setVisits(e.target.value)} /></Field>
          <Field label="最多上传文件数"><Input type="number" min={0} placeholder="不限" value={maxUp} onChange={(e) => setMaxUp(e.target.value)} /></Field>
          <Field label="总大小上限（MB）"><Input type="number" min={0} placeholder="不限" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} /></Field>
        </div>
        <div className="flex flex-wrap gap-4"><Switch checked={allowUp} onChange={setAllowUp} label="允许上传" /><Switch checked={allowDl} onChange={setAllowDl} label="允许下载" /><Switch checked={usePin} onChange={setUsePin} label="需要提取码" /></div>
        {usePin && <Field label="提取码" hint="留空则随机生成 4 位"><Input value={pin} onChange={(e) => setPin(e.target.value)} /></Field>}
      </div>
    </Modal>
  );
}
