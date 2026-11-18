import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { call, type FsItem } from "../lib/api";
import { abs, copy, PERM_NAMES, qrDataUrl, type Share } from "../lib/shares";
import { errMsg, fmtTime } from "../lib/util";
import { Button, Field, Input, Modal, Select, Switch, toast } from "../ui/ui";

/** Create-share dialog (files / folders, multi-select). */
export function ShareDialog({ items, onClose }: { items: FsItem[]; onClose: () => void }) {
  const [perm, setPerm] = useState("download");
  const [days, setDays] = useState("7");
  const [visits, setVisits] = useState("");
  const [downloads, setDownloads] = useState("");
  const [pinMode, setPinMode] = useState<"none" | "random" | "custom">("random");
  const [pin, setPin] = useState("");
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Share | null>(null);
  const [qr, setQr] = useState("");
  const open = items.length > 0;
  useEffect(() => {
    if (!open) (setRes(null), setQr(""));
  }, [open]);
  const create = async () => {
    setBusy(true);
    try {
      const s = await call<Share>("POST", "/api/shares", {
        paths: items.map((i) => i.path),
        perm,
        days: Number(days) || undefined,
        max_visits: Number(visits) || undefined,
        max_downloads: Number(downloads) || undefined,
        random_pin: pinMode === "random",
        pin: pinMode === "custom" ? pin : undefined,
        require_login: login,
      });
      setRes(s);
      setQr(await qrDataUrl(abs(s.url_with_pin ?? s.url)));
    } catch (e) {
      toast.err(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const link = res ? abs(res.url_with_pin ?? res.url) : "";
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={res ? "分享已创建" : `分享 ${items.length === 1 ? items[0].name : `${items.length} 项`}`}
      footer={
        res ? (
          <Button variant="primary" onClick={onClose}>完成</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>取消</Button>
            <Button variant="primary" loading={busy} onClick={create}>创建分享</Button>
          </>
        )
      }
    >
      {!res ? (
        <div className="space-y-3">
          <Field label="权限">
            <Select value={perm} onChange={(e) => setPerm(e.target.value)}>
              {Object.entries(PERM_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="有效天数"><Input type="number" min={0} placeholder="永久" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
            <Field label="最大访问"><Input type="number" min={0} placeholder="不限" value={visits} onChange={(e) => setVisits(e.target.value)} /></Field>
            <Field label="最大下载"><Input type="number" min={0} placeholder="不限" value={downloads} onChange={(e) => setDownloads(e.target.value)} /></Field>
          </div>
          <Field label="提取码 (PIN)">
            <div className="flex gap-2">
              <Select value={pinMode} onChange={(e) => setPinMode(e.target.value as "none")}>
                <option value="none">无</option>
                <option value="random">随机生成</option>
                <option value="custom">自定义</option>
              </Select>
              {pinMode === "custom" && <Input placeholder="3-16 位字母数字" value={pin} onChange={(e) => setPin(e.target.value)} />}
            </div>
          </Field>
          <Switch checked={login} onChange={setLogin} label="需要登录才能访问" />
        </div>
      ) : (
        <div className="space-y-3 text-[13px]">
          <div className="flex gap-2">
            <Input readOnly value={link} aria-label="分享链接" />
            <Button onClick={() => (copy(link), toast.ok("已复制链接"))}><Copy className="size-4" /></Button>
          </div>
          {res.pin && <p>提取码：<b className="font-mono">{res.pin}</b>　取件码：<b className="font-mono">{res.pickup_code}</b></p>}
          {res.direct_url && (
            <p className="break-all">直链：<a className="text-accent underline" href={abs(res.direct_url)}>{abs(res.direct_url)}</a></p>
          )}
          <p className="text-muted">{res.expires_at ? `有效期至 ${fmtTime(res.expires_at)}` : "永久有效"}{res.max_visits ? ` · 最多访问 ${res.max_visits} 次` : ""}{res.max_downloads ? ` · 最多下载 ${res.max_downloads} 次` : ""}</p>
          {qr && <img src={qr} alt="分享二维码" className="mx-auto size-44" />}
        </div>
      )}
    </Modal>
  );
}
