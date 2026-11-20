import { useEffect, useState } from "react";
import { Cloud, HardDrive, Pencil, Plus, RefreshCw, Server, Trash2, Terminal } from "lucide-react";
import { call, client, ok, type MountConfig } from "../../lib/api";
import { useApp } from "../../lib/app";
import { errMsg } from "../../lib/util";
import { ConfirmButton, Badge, Button, Card, Empty, Field, IconButton, Input, Modal, Switch, toast, PageHeader, Pager, usePaged } from "../../ui/ui";
import { SegmentedDrag } from "../../ui/motion";
import { SkCards } from "../../ui/r6";

type TransferMode = "auto" | "direct" | "proxy";

type Kind = "fs" | "s3" | "webdav" | "rclone" | "openlist" | "pikpak" | "p115";
const KINDS: { k: Kind; label: string; desc: string; icon: typeof HardDrive }[] = [
  { k: "fs", label: "本地磁盘", desc: "服务器上的目录", icon: HardDrive },
  { k: "s3", label: "S3 兼容", desc: "AWS S3 / MinIO / R2 / OSS / COS", icon: Cloud },
  { k: "webdav", label: "WebDAV", desc: "任意 WebDAV 服务", icon: Server },
  { k: "rclone", label: "rclone 桥接", desc: "70+ 网盘，经 rclone serve webdav", icon: Terminal },
  { k: "openlist", label: "OpenList 桥接", desc: "115 / PikPak 等，经 OpenList /dav", icon: Server },
  { k: "pikpak", label: "PikPak（原生）", desc: "内置驱动，账号密码登录", icon: Cloud },
  { k: "p115", label: "115（原生）", desc: "内置驱动，用 UID / CID / SEID / KID 登录", icon: Cloud },
];
const FIELDS: Record<string, { key: string; label: string; ph?: string; secret?: boolean; req?: boolean }[]> = {
  fs: [{ key: "root", label: "根目录", ph: "/srv/files", req: true }],
  s3: [
    { key: "bucket", label: "Bucket", req: true },
    { key: "endpoint", label: "Endpoint", ph: "https://s3.amazonaws.com" },
    { key: "region", label: "Region", ph: "us-east-1" },
    { key: "access_key_id", label: "Access Key ID" },
    { key: "secret_access_key", label: "Secret Access Key", secret: true },
    { key: "root", label: "前缀（可选）", ph: "/" },
  ],
  webdav: [
    { key: "endpoint", label: "地址", ph: "http://127.0.0.1:8080/", req: true },
    { key: "username", label: "用户名" },
    { key: "password", label: "密码", secret: true },
    { key: "root", label: "子路径（可选）", ph: "/" },
  ],
  pikpak: [
    { key: "username", label: "账号（邮箱/手机号）", req: true },
    { key: "password", label: "密码", secret: true, req: true },
    { key: "platform", label: "客户端类型", ph: "web / android / pc（默认 web）" },
    { key: "refresh_token", label: "Refresh Token（可选）", secret: true },
    { key: "captcha_token", label: "Captcha Token（触发人机验证时填写）", secret: true },
    { key: "device_id", label: "设备 ID（可选，默认按账号生成）" },
    { key: "root_id", label: "根目录 ID（可选）" },
  ],
  p115: [
    { key: "uid", label: "UID", ph: "用户 ID", secret: true, req: true },
    { key: "cid", label: "CID", secret: true, req: true },
    { key: "seid", label: "SEID", secret: true, req: true },
    { key: "kid", label: "KID", secret: true, req: true },
    { key: "root_id", label: "根目录 ID（可选，默认 0）", ph: "0" },
    { key: "page_size", label: "分页大小（可选）", ph: "1000" },
  ],
};
const fieldsOf = (k: Kind) => FIELDS[k === "rclone" || k === "openlist" ? "webdav" : k];
const TRANSFER_OPTS: { value: TransferMode; label: string; title: string }[] = [
  { value: "auto", label: "自动", title: "有直链时浏览器直连，否则由服务器中转" },
  { value: "direct", label: "直链", title: "浏览器直连后端（direct）" },
  { value: "proxy", label: "中转", title: "始终由服务器中转（proxy）" },
];
const P115_KEYS = ["uid", "cid", "seid", "kid"] as const;

/** Split a stored 115 cookie into UID/CID/SEID/KID for the form. Masked "***" becomes empty (leave blank to keep). */
function splitP115Options(kind: string, options: Record<string, string> | undefined): Record<string, string> {
  const o = { ...(options ?? {}) };
  if (kind !== "p115" && kind !== "115") return o;
  if (P115_KEYS.some((k) => o[k] && o[k] !== "***")) {
    delete o.cookie;
    for (const k of P115_KEYS) if (o[k] === "***") o[k] = "";
    return o;
  }
  const cookie = o.cookie ?? "";
  delete o.cookie;
  if (!cookie || cookie === "***") return o;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    if ((P115_KEYS as readonly string[]).includes(k)) o[k] = part.slice(i + 1).trim();
  }
  return o;
}

/** Compose split 115 fields back into cookie. On edit, empty fields keep the stored cookie via "***". */
function assembleP115(opts: Record<string, string>, isNew: boolean): Record<string, string> {
  const { uid, cid, seid, kid, cookie: _ignored, ...rest } = opts;
  const vals = [uid, cid, seid, kid].map((v) => (v ?? "").trim());
  const filled = vals.filter((v) => v && v !== "***");
  if (filled.length === 4 && vals.every((v) => v && v !== "***")) {
    return { ...rest, cookie: ["UID=" + vals[0], "CID=" + vals[1], "SEID=" + vals[2], "KID=" + vals[3]].join("; ") };
  }
  if (!isNew && filled.length === 0) return { ...rest, cookie: "***" };
  throw new Error("请完整填写 UID / CID / SEID / KID");
}

function fieldAutoComplete(f: { key: string; secret?: boolean }) {
  if (f.secret) return "new-password";
  if (f.key === "username") return "username";
  return "off";
}

const blank = (): MountConfig & { ui: Kind } => ({ ui: "fs", name: "", kind: "fs", options: {}, read_only: false, hidden: false, enabled: true, sort_order: 0, transfer_mode: "auto" });

export function MountsPage() {
  const { bumpFs } = useApp();
  const [mounts, setMounts] = useState<MountConfig[] | null>(null);
  const [mq, setMq] = useState("");
  const fm = (mounts ?? []).filter((m) => !mq.trim() || m.name.toLowerCase().includes(mq.trim().toLowerCase()));
  const pm = usePaged(fm, 6, mq);
  const [edit, setEdit] = useState<(MountConfig & { ui: Kind }) | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => ok(client.GET("/api/mounts")).then(setMounts).catch((e) => toast.err(errMsg(e)));
  const refresh = () => { load(); bumpFs(); };
  useEffect(() => {
    load();
  }, []);
  const toggleEnabled = async (m: MountConfig, enabled: boolean) => {
    try {
      await ok(client.POST("/api/mounts", { body: { ...m, enabled } }));
      toast.ok(enabled ? "已启用" : "已停用");
      refresh();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const { ui, ...cfg } = edit;
      let options = { ...(cfg.options ?? {}) } as Record<string, string>;
      if (ui === "p115" || cfg.kind === "p115" || cfg.kind === "115") {
        options = assembleP115(options, isNew);
      }
      options = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== ""));
      await ok(client.POST("/api/mounts", { body: { ...cfg, options } }));
      toast.ok(isNew ? "挂载点已添加，正在后台建立索引" : "已保存");
      setEdit(null);
      refresh();
    } catch (e) {
      toast.err(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const opts = (edit?.options ?? {}) as Record<string, string>;
  const setOpt = (k: string, v: string) => edit && setEdit({ ...edit, options: { ...opts, [k]: v } });
  const openEdit = (m: MountConfig) => {
    setIsNew(false);
    setEdit({ ...m, ui: m.kind as Kind, options: splitP115Options(m.kind, (m.options ?? {}) as Record<string, string>) });
  };
  return (
    <div className="space-y-4">
      <PageHeader title="挂载点" desc="本地目录、S3、WebDAV 等存储后端" actions={<>
        <Input className="w-44" placeholder="筛选挂载点" aria-label="筛选挂载点" value={mq} onChange={(e) => setMq(e.target.value)} />
        <Button onClick={() => call("POST", "/api/search/reindex").then((r) => toast.ok(`索引已重建：${r.files} 个文件`)).catch((e) => toast.err(errMsg(e)))}>
          <RefreshCw className="size-4" /> 重建索引
        </Button>
        <Button variant="primary" onClick={() => (setIsNew(true), setEdit(blank()))}>
          <Plus className="size-4" /> 添加存储
        </Button>
      </>} />
      {mounts === null && <SkCards n={3} />}
      {mounts?.length === 0 && <Empty icon={<HardDrive className="size-10" />} title="还没有挂载点">添加一个本地目录、S3 或 WebDAV 存储开始使用</Empty>}
      <div className="grid gap-3 md:grid-cols-2">
        {pm.slice.map((m) => (
          <Card key={m.name} title={<span className="flex items-center gap-2">{m.name} <Badge>{m.kind}</Badge>{m.read_only && <Badge tone="warn">只读</Badge>}{m.enabled === false && <Badge tone="warn">已停用</Badge>}{m.hidden && <Badge>隐藏</Badge>}</span>}
            actions={
              <>
                <IconButton label="编辑" onClick={() => openEdit(m)}><Pencil className="size-4" /></IconButton>
                <ConfirmButton iconOnly icon={<Trash2 />} label={`删除挂载点 ${m.name}（不删除后端文件）`} confirmLabel="删除挂载" onConfirm={() => ok(client.DELETE("/api/mounts/{name}", { params: { path: { name: m.name } } })).then(refresh).catch((e) => toast.err(errMsg(e)))} />
              </>
            }>
            <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-[12.5px]">
              {Object.entries((m.options ?? {}) as Record<string, string>).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="truncate font-mono">{v}</dd>
                </div>
              ))}
              <dt className="text-muted">启用</dt>
              <dd><label className="flex items-center gap-2"><Switch label={m.enabled === false ? "已停用" : "已启用"} checked={m.enabled !== false} onChange={(v) => toggleEnabled(m, v)} /> {m.enabled === false ? "已停用" : "已启用"}</label></dd>
              <dt className="text-muted">传输方式</dt>
              <dd>{m.transfer_mode}</dd>
              <dt className="text-muted">排序</dt>
              <dd>{m.sort_order}</dd>
            </dl>
          </Card>
        ))}
      </div>
      <Pager {...pm} />

      <Modal open={!!edit} onClose={() => setEdit(null)} title={isNew ? "添加存储" : `编辑「${edit?.name}」`} wide footer={<><Button onClick={() => setEdit(null)}>取消</Button><Button variant="primary" loading={busy} onClick={save}>{isNew ? "添加" : "保存"}</Button></>}>
        {edit && (
          <div className="space-y-4">
            {isNew && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {KINDS.map(({ k, label, desc, icon: I }) => (
                  <button key={k} type="button" onClick={() => setEdit({ ...edit, ui: k, kind: k === "fs" || k === "s3" || k === "pikpak" || k === "p115" ? k : "webdav", options: k === "rclone" ? { endpoint: "http://127.0.0.1:8090/" } : k === "openlist" ? { endpoint: "http://127.0.0.1:8471/dav/" } : {} })} aria-pressed={edit.ui === k}
                    className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left ${edit.ui === k ? "border-accent bg-accent-soft" : "border-line hover:bg-hover"}`}>
                    <I className="size-5 text-accent" />
                    <span className="text-[13px] font-medium">{label}</span>
                    <span className="text-[11px] leading-tight text-muted">{desc}</span>
                  </button>
                ))}
              </div>
            )}
            {edit.ui === "rclone" && (
              <div className="rounded-lg border border-line bg-panel-2 p-3 text-[12.5px]">
                <p className="font-medium">rclone 向导</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted">
                  <li>在服务器上用 <code>rclone config</code> 配好网盘（如 <code>gdrive:</code>）。</li>
                  <li>启动：<code className="break-all">rclone serve webdav gdrive: --addr 127.0.0.1:8090 --user dh --pass 密码</code></li>
                  <li>把地址、用户名、密码填到下面。</li>
                </ol>
              </div>
            )}
            {edit.ui === "openlist" && <p className="rounded-lg border border-line bg-panel-2 p-3 text-[12.5px] text-muted">填写 OpenList 的 WebDAV 地址（形如 <code>http://主机:端口/dav/</code>）和 OpenList 账号。</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="名称（显示为顶层文件夹）">
                <Input name="mount-display-name" autoComplete="off" autoCorrect="off" spellCheck={false} value={edit.name} disabled={!isNew} onChange={(e) => setEdit({ ...edit, name: e.target.value.replace(/\//g, "") })} required />
              </Field>
              {fieldsOf(edit.ui).map((f) => (
                <Field key={f.key} label={f.label} hint={f.secret && !isNew ? "留空表示不修改" : undefined}>
                  <Input name={"mount-opt-" + f.key} type={f.secret ? "password" : "text"} placeholder={f.ph} value={opts[f.key] ?? ""} onChange={(e) => setOpt(f.key, e.target.value)} required={!!f.req && isNew} autoComplete={fieldAutoComplete(f)} />
                </Field>
              ))}
              <Field label="传输方式" hint="自动：有直链时浏览器直连；直链：始终直连；中转：始终由服务器中转">
                <SegmentedDrag
                  className="w-full min-w-0"
                  label="传输方式"
                  value={((edit.transfer_mode as TransferMode) || "auto")}
                  onChange={(v) => setEdit({ ...edit, transfer_mode: v })}
                  options={TRANSFER_OPTS}
                />
              </Field>
              <Field label="排序（越小越靠前）">
                <Input type="number" value={edit.sort_order ?? 0} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-6 text-[13px]">
              <label className="flex items-center gap-2"><Switch label="启用" checked={edit.enabled !== false} onChange={(v) => setEdit({ ...edit, enabled: v })} /> 启用（关闭后保留配置，但不出现在文件列表中，也无法访问）</label>
              <label className="flex items-center gap-2"><Switch label="在侧栏和根目录显示" checked={!edit.hidden} onChange={(v) => setEdit({ ...edit, hidden: !v })} /> 在侧栏和根目录显示</label>
              <label className="flex items-center gap-2"><Switch label="只读" checked={!!edit.read_only} onChange={(v) => setEdit({ ...edit, read_only: v })} /> 只读</label>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
