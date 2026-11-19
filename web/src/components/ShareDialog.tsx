import { useEffect, useRef, useState } from "react";
import { Check, Copy, Link2, Mail, QrCode } from "lucide-react";
import { call, type FsItem } from "../lib/api";
import { abs, copy, PERM_NAMES, qrDataUrl, type Share } from "../lib/shares";
import { errMsg, fmtTime } from "../lib/util";
import { SendButton, ShareButton } from "../ui/motion";
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
  // Only a single folder can collect uploads (DEPTAI-485 r5); the server rejects it otherwise.
  const canUpload = items.length === 1 && items[0].is_dir;
  const permOpts = Object.entries(PERM_NAMES).filter(([k]) => k !== "upload" || canUpload);
  useEffect(() => {
    if (!canUpload && perm === "upload") setPerm("download");
  }, [canUpload, perm]);
  useEffect(() => {
    if (!open) (setRes(null), setQr(""));
  }, [open]);
  const pending = useRef<Share | null>(null);
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
      pending.current = s;
      setQr(await qrDataUrl(abs(s.url_with_pin ?? s.url)));
    } catch (e) {
      toast.err(errMsg(e));
      throw e;
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
            <SendButton label="创建分享" sentLabel="已创建" disabled={busy} onSend={create} onDone={() => setRes(pending.current)} />
          </>
        )
      }
    >
      {!res ? (
        <div className="space-y-3">
          <Field label="权限">
            <Select value={perm} onChange={(e) => setPerm(e.target.value)}>
              {permOpts.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            {!canUpload && <p className="mt-1 text-[11.5px] text-faint" data-upload-hint>「可上传（收集文件）」仅在分享单个文件夹时可用</p>}
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
        <div className="share-result min-w-0 space-y-3 text-[13px]">
          <CopyRow label="分享链接" value={link} />
          {res.direct_url && <CopyRow label="直链" value={abs(res.direct_url)} />}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ShareButton url={link} actions={[
              { icon: <QrCode className="size-4" />, label: "二维码", onClick: () => document.querySelector("[data-share-qr]")?.scrollIntoView({ behavior: "smooth" }) },
              { icon: <Mail className="size-4" />, label: "邮件分享", onClick: () => void (location.href = `mailto:?subject=${encodeURIComponent("文件分享")}&body=${encodeURIComponent(link)}`) },
              ...(res.direct_url ? [{ icon: <Link2 className="size-4" />, label: "复制直链", onClick: () => void copyText(abs(res.direct_url!), "直链已复制") }] : []),
            ]} />
          </div>
          {res.pin && <p>提取码：<b className="font-mono">{res.pin}</b>　取件码：<b className="font-mono">{res.pickup_code}</b></p>}
          <p className="text-muted">{res.expires_at ? `有效期至 ${fmtTime(res.expires_at)}` : "永久有效"}{res.max_visits ? ` · 最多访问 ${res.max_visits} 次` : ""}{res.max_downloads ? ` · 最多下载 ${res.max_downloads} 次` : ""}</p>
          {qr && <img data-share-qr src={qr} alt="分享二维码" className="mx-auto size-44" />}
        </div>
      )}
    </Modal>
  );
}

async function copyText(v: string, msg = "已复制") {
  try {
    await copy(v);
    toast.ok(msg);
    return true;
  } catch {
    toast.err("复制失败，请手动选择复制");
    return false;
  }
}

/** Read-only link + one-click copy button (used for share and direct links). */
export function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[12px] text-muted">{label}</p>
      <div className="flex min-w-0 gap-2">
        <Input readOnly value={value} aria-label={label} className="min-w-0 flex-1 font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
        <Button type="button" aria-label={`复制${label}`} data-copy={label} onClick={async () => { if (await copyText(value, `${label}已复制`)) { setDone(true); setTimeout(() => setDone(false), 1600); } }}>
          {done ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}{done ? "已复制" : "复制"}
        </Button>
      </div>
    </div>
  );
}
