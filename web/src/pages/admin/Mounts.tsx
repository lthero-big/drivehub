import { useEffect, useState } from "react";
import { Cloud, HardDrive, Pencil, Plus, RefreshCw, Server, Trash2, Terminal } from "lucide-react";
import { call, client, ok, type MountConfig } from "../../lib/api";
import { errMsg } from "../../lib/util";
import { Badge, Button, Card, confirmDlg, Empty, Field, IconButton, Input, Modal, Select, Switch, toast } from "../../ui/ui";

type Kind = "fs" | "s3" | "webdav" | "rclone" | "openlist";
const KINDS: { k: Kind; label: string; desc: string; icon: typeof HardDrive }[] = [
  { k: "fs", label: "本地磁盘", desc: "服务器上的目录", icon: HardDrive },
  { k: "s3", label: "S3 兼容", desc: "AWS S3 / MinIO / R2 / OSS / COS", icon: Cloud },
  { k: "webdav", label: "WebDAV", desc: "任意 WebDAV 服务", icon: Server },
  { k: "rclone", label: "rclone 桥接", desc: "70+ 网盘，经 rclone serve webdav", icon: Terminal },
  { k: "openlist", label: "OpenList 桥接", desc: "115 / PikPak 等，经 OpenList /dav", icon: Server },
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
};
const fieldsOf = (k: Kind) => FIELDS[k === "rclone" || k === "openlist" ? "webdav" : k];

const blank = (): MountConfig & { ui: Kind } => ({ ui: "fs", name: "", kind: "fs", options: {}, read_only: false, hidden: false, sort_order: 0, transfer_mode: "auto" });

export function MountsPage() {
  const [mounts, setMounts] = useState<MountConfig[] | null>(null);
  const [edit, setEdit] = useState<(MountConfig & { ui: Kind }) | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => ok(client.GET("/api/mounts")).then(setMounts).catch((e) => toast.err(errMsg(e)));
  useEffect(() => {
    load();
  }, []);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    try {
      const { ui: _ui, ...cfg } = edit;
      await ok(client.POST("/api/mounts", { body: { ...cfg, options: Object.fromEntries(Object.entries(cfg.options ?? {}).filter(([, v]) => v !== "")) } }));
      toast.ok(isNew ? "挂载点已添加，正在后台建立索引" : "已保存");
      setEdit(null);
      load();
    } catch (e) {
      toast.err(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const opts = (edit?.options ?? {}) as Record<string, string>;
  const setOpt = (k: string, v: string) => edit && setEdit({ ...edit, options: { ...opts, [k]: v } });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-xl font-semibold">挂载点</h1>
        <Button onClick={() => call("POST", "/api/search/reindex").then((r) => toast.ok(`索引已重建：${r.files} 个文件`)).catch((e) => toast.err(errMsg(e)))}>
          <RefreshCw className="size-4" /> 重建索引
        </Button>
        <Button variant="primary" onClick={() => (setIsNew(true), setEdit(blank()))}>
          <Plus className="size-4" /> 添加存储
        </Button>
      </div>
      {mounts?.length === 0 && <Empty icon={<HardDrive className="size-10" />} title="还没有挂载点">添加一个本地目录、S3 或 WebDAV 存储开始使用</Empty>}
      <div className="grid gap-3 md:grid-cols-2">
        {mounts?.map((m) => (
          <Card key={m.name} title={<span className="flex items-center gap-2">{m.name} <Badge>{m.kind}</Badge>{m.read_only && <Badge tone="warn">只读</Badge>}{m.hidden && <Badge>隐藏</Badge>}</span>}
            actions={
              <>
                <IconButton label="编辑" onClick={() => (setIsNew(false), setEdit({ ...m, ui: m.kind as Kind }))}><Pencil className="size-4" /></IconButton>
                <IconButton label="删除" onClick={async () => (await confirmDlg(`删除挂载点「${m.name}」？`, { label: "只删除挂载配置，不会删除后端存储里的文件。", danger: true, confirm: "删除" })) && ok(client.DELETE("/api/mounts/{name}", { params: { path: { name: m.name } } })).then(load).catch((e) => toast.err(errMsg(e)))}><Trash2 className="size-4" /></IconButton>
              </>
            }>
            <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-[12.5px]">
              {Object.entries((m.options ?? {}) as Record<string, string>).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k}</dt>
                  <dd className="truncate font-mono">{v}</dd>
                </div>
              ))}
              <dt className="text-muted">传输方式</dt>
              <dd>{m.transfer_mode}</dd>
              <dt className="text-muted">排序</dt>
              <dd>{m.sort_order}</dd>
            </dl>
          </Card>
        ))}
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={isNew ? "添加存储" : `编辑「${edit?.name}」`} wide footer={<><Button onClick={() => setEdit(null)}>取消</Button><Button variant="primary" loading={busy} onClick={save}>{isNew ? "添加" : "保存"}</Button></>}>
        {edit && (
          <div className="space-y-4">
            {isNew && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {KINDS.map(({ k, label, desc, icon: I }) => (
                  <button key={k} type="button" onClick={() => setEdit({ ...edit, ui: k, kind: k === "fs" || k === "s3" ? k : "webdav", options: k === "rclone" ? { endpoint: "http://127.0.0.1:8090/" } : k === "openlist" ? { endpoint: "http://127.0.0.1:8471/dav/" } : {} })} aria-pressed={edit.ui === k}
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
                <Input value={edit.name} disabled={!isNew} onChange={(e) => setEdit({ ...edit, name: e.target.value.replace(/\//g, "") })} required />
              </Field>
              {fieldsOf(edit.ui).map((f) => (
                <Field key={f.key} label={f.label + (f.req ? "" : "")} hint={f.secret && !isNew ? "留 *** 表示不修改" : undefined}>
                  <Input type={f.secret ? "password" : "text"} placeholder={f.ph} value={opts[f.key] ?? ""} onChange={(e) => setOpt(f.key, e.target.value)} required={f.req} autoComplete="off" />
                </Field>
              ))}
              <Field label="传输方式" hint="direct：有直链时浏览器直连后端；proxy：始终由服务器中转">
                <Select value={edit.transfer_mode} onChange={(e) => setEdit({ ...edit, transfer_mode: e.target.value })}>
                  <option value="auto">auto</option>
                  <option value="direct">direct</option>
                  <option value="proxy">proxy</option>
                </Select>
              </Field>
              <Field label="排序（越小越靠前）">
                <Input type="number" value={edit.sort_order ?? 0} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-6 text-[13px]">
              <label className="flex items-center gap-2"><Switch label="只读" checked={!!edit.read_only} onChange={(v) => setEdit({ ...edit, read_only: v })} /> 只读</label>
              <label className="flex items-center gap-2"><Switch label="隐藏" checked={!!edit.hidden} onChange={(v) => setEdit({ ...edit, hidden: v })} /> 在根目录隐藏</label>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
