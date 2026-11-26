import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpDown,
  Check,
  Cloud,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Globe,
  HardDrive,
  Lock,
  Pencil,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  Trash2,
  User,
  Zap,
} from "lucide-react";
import { call, client, ok, type MountConfig } from "../../lib/api";
import { useApp } from "../../lib/app";
import { filesHref, go } from "../../lib/router";
import { cx, errMsg } from "../../lib/util";
import {
  Button,
  ConfirmButton,
  Empty,
  IconButton,
  Input,
  Modal,
  PageHeader,
  Pager,
  toast,
  usePaged,
} from "../../ui/ui";
import {
  DisclosureRow,
  InfoTip,
  InlineNote,
  PROVIDER_META,
  ProviderIcon,
  SectionPanel,
  SettingField,
  SettingInput,
  SettingSwitch,
  StatusPill,
} from "../../ui/settings-ui";
import { SegmentedDrag } from "../../ui/motion";
import { SkCards } from "../../ui/r6";

type TransferMode = "auto" | "direct" | "proxy";
type Kind = "fs" | "s3" | "webdav" | "rclone" | "openlist" | "pikpak" | "p115";
type StatusFilter = "all" | "enabled" | "disabled";

interface FieldDef {
  key: string;
  label: string;
  ph?: string;
  secret?: boolean;
  req?: boolean;
  advanced?: boolean;
  hint?: string;
}

const KINDS: { k: Kind; label: string; shortLabel: string; desc: string }[] = [
  { k: "fs", label: "本地磁盘", shortLabel: "本地磁盘", desc: "服务器上的本地目录" },
  { k: "s3", label: "S3 兼容", shortLabel: "S3 兼容", desc: "AWS S3 / MinIO / R2 / OSS" },
  { k: "webdav", label: "WebDAV", shortLabel: "WebDAV", desc: "任意标准 WebDAV 服务" },
  { k: "rclone", label: "rclone 桥接", shortLabel: "rclone", desc: "70+ 网盘，经 rclone serve" },
  { k: "openlist", label: "OpenList 桥接", shortLabel: "OpenList", desc: "经 OpenList /dav 桥接" },
  { k: "pikpak", label: "PikPak（原生）", shortLabel: "PikPak", desc: "内置驱动，账号密码直连" },
  { k: "p115", label: "115（原生）", shortLabel: "115 网盘", desc: "内置驱动，四段凭据登录" },
];

const FIELDS: Record<string, FieldDef[]> = {
  fs: [{ key: "root", label: "根目录", ph: "/srv/files", req: true }],
  s3: [
    { key: "bucket", label: "Bucket", ph: "my-bucket", req: true },
    { key: "endpoint", label: "Endpoint", ph: "https://s3.amazonaws.com" },
    { key: "region", label: "Region", ph: "us-east-1" },
    { key: "access_key_id", label: "Access Key ID", ph: "AKIA..." },
    { key: "secret_access_key", label: "Secret Access Key", secret: true },
    { key: "root", label: "路径前缀（可选）", ph: "/", advanced: true, hint: "仅挂载 Bucket 中的某个子目录" },
  ],
  webdav: [
    { key: "endpoint", label: "服务地址", ph: "http://127.0.0.1:8080/", req: true },
    { key: "username", label: "用户名" },
    { key: "password", label: "密码", secret: true },
    { key: "root", label: "子路径（可选）", ph: "/", advanced: true, hint: "限制挂载到远端 WebDAV 的子路径" },
  ],
  pikpak: [
    { key: "username", label: "账号（邮箱 / 手机号）", ph: "name@example.com", req: true },
    { key: "password", label: "密码", secret: true, req: true },
    { key: "platform", label: "客户端类型", ph: "web / android / pc（默认 web）", advanced: true },
    { key: "refresh_token", label: "Refresh Token", secret: true, advanced: true, hint: "可选，复用已有登录会话" },
    { key: "captcha_token", label: "Captcha Token", secret: true, advanced: true, hint: "触发人机验证时手动填入" },
    { key: "device_id", label: "设备 ID", ph: "留空按账号自动生成", advanced: true },
    { key: "root_id", label: "根目录 ID", ph: "留空挂载云盘根目录", advanced: true },
  ],
  p115: [
    { key: "uid", label: "UID", ph: "用户 ID", secret: true, req: true },
    { key: "cid", label: "CID", ph: "客户端 ID", secret: true, req: true },
    { key: "seid", label: "SEID", ph: "会话 ID", secret: true, req: true },
    { key: "kid", label: "KID", ph: "密钥 ID", secret: true, req: true },
    { key: "root_id", label: "根目录 ID", ph: "默认 0（网盘根目录）", advanced: true },
    { key: "page_size", label: "分页大小", ph: "默认 1000", advanced: true },
  ],
};

const fieldsOf = (k: Kind): FieldDef[] => FIELDS[k === "rclone" || k === "openlist" ? "webdav" : k];

const TRANSFER_OPTS: { value: TransferMode; label: string; title: string }[] = [
  { value: "auto", label: "自动", title: "有直链时浏览器直连，否则由服务器中转" },
  { value: "direct", label: "直链", title: "浏览器直连后端（direct）" },
  { value: "proxy", label: "中转", title: "始终由服务器中转（proxy）" },
];

const TRANSFER_META: Record<TransferMode, { label: string; icon: typeof Zap }> = {
  auto: { label: "自动传输", icon: ArrowLeftRight },
  direct: { label: "直链下载", icon: Zap },
  proxy: { label: "服务器中转", icon: Server },
};

const P115_KEYS = ["uid", "cid", "seid", "kid"] as const;

/** Infer display brand for a saved mount while keeping backend `kind` intact. */
export function detectMountBrand(m: Pick<MountConfig, "kind" | "options">): Kind {
  const k = m.kind.toLowerCase();
  if (k === "115" || k === "p115") return "p115";
  if (k === "fs" || k === "s3" || k === "pikpak" || k === "rclone" || k === "openlist") return k;
  const ep = String((m.options as Record<string, string> | undefined)?.endpoint ?? "").toLowerCase();
  if (ep.includes("openlist") || ep.includes(":8471") || ep.includes("/dav")) return "openlist";
  if (ep.includes("rclone") || ep.includes(":8090")) return "rclone";
  return "webdav";
}

function maskAccount(raw: string): string {
  const s = raw.trim();
  if (!s || s === "***") return "";
  const at = s.indexOf("@");
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const maskedLocal = local.length <= 2 ? `${local[0]}••` : `${local.slice(0, 2)}••${local.slice(-1)}`;
    return `${maskedLocal}@${domain}`;
  }
  if (/^\+?\d{7,}$/.test(s)) {
    return `${s.slice(0, 3)}••••${s.slice(-4)}`;
  }
  if (s.length <= 4) return `${s[0]}••`;
  return `${s.slice(0, 2)}••${s.slice(-2)}`;
}

function cleanEndpointHost(raw?: string): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const p = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
    return `${u.host}${p}`;
  } catch {
    return s.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

/** Produce a clean, credential-free one-line summary for mount cards. */
function summarizeMountSource(m: MountConfig, brand: Kind): { text: string; icon: "path" | "url" | "account" | "cloud" } {
  const opts = (m.options ?? {}) as Record<string, string>;
  switch (brand) {
    case "fs":
      return { text: opts.root || "/", icon: "path" };
    case "s3": {
      const bucket = opts.bucket ? `s3://${opts.bucket}` : "S3 存储桶";
      const host = cleanEndpointHost(opts.endpoint);
      const extra = host || opts.region || "";
      return { text: extra ? `${bucket} · ${extra}` : bucket, icon: "cloud" };
    }
    case "webdav":
    case "rclone":
    case "openlist": {
      const host = cleanEndpointHost(opts.endpoint) || "WebDAV 端点";
      const user = opts.username ? maskAccount(opts.username) : "";
      return { text: user ? `${host} · ${user}` : host, icon: "url" };
    }
    case "pikpak": {
      const acct = opts.username ? maskAccount(opts.username) : "";
      return { text: acct ? `账号 ${acct}` : "PikPak 原生云盘", icon: "account" };
    }
    case "p115": {
      const rootId = opts.root_id && opts.root_id !== "0" ? `目录 #${opts.root_id}` : "云盘根目录";
      return { text: `115 原生凭据 · ${rootId}`, icon: "cloud" };
    }
  }
}

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

const blank = (): MountConfig & { ui: Kind } => ({
  ui: "fs",
  name: "",
  kind: "fs",
  options: {},
  read_only: false,
  hidden: false,
  enabled: true,
  sort_order: 0,
  transfer_mode: "auto",
});

export function MountsPage() {
  const { bumpFs } = useApp();
  const [mounts, setMounts] = useState<MountConfig[] | null>(null);
  const [mq, setMq] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [edit, setEdit] = useState<(MountConfig & { ui: Kind }) | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  const load = () => ok(client.GET("/api/mounts")).then(setMounts).catch((e) => toast.err(errMsg(e)));
  const refresh = () => {
    load();
    bumpFs();
  };
  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    const list = mounts ?? [];
    const enabled = list.filter((m) => m.enabled !== false).length;
    return { total: list.length, enabled, disabled: list.length - enabled };
  }, [mounts]);

  const fm = useMemo(() => {
    const q = mq.trim().toLowerCase();
    return (mounts ?? []).filter((m) => {
      if (statusFilter === "enabled" && m.enabled === false) return false;
      if (statusFilter === "disabled" && m.enabled !== false) return false;
      if (!q) return true;
      const brand = detectMountBrand(m);
      const label = PROVIDER_META[brand]?.label?.toLowerCase() ?? "";
      return m.name.toLowerCase().includes(q) || m.kind.toLowerCase().includes(q) || label.includes(q);
    });
  }, [mounts, mq, statusFilter]);

  const pm = usePaged(fm, 8, `${mq}|${statusFilter}`);

  const toggleEnabled = async (m: MountConfig, enabled: boolean) => {
    try {
      await ok(client.POST("/api/mounts", { body: { ...m, enabled } }));
      toast.ok(enabled ? `已启用「${m.name}」` : `已停用「${m.name}」`);
      refresh();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const r = await call("POST", "/api/search/reindex");
      toast.ok(`索引已重建：${r.files} 个文件`);
    } catch (e) {
      toast.err(errMsg(e));
    } finally {
      setReindexing(false);
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
    const brand = detectMountBrand(m);
    setEdit({
      ...m,
      ui: brand,
      options: splitP115Options(m.kind, (m.options ?? {}) as Record<string, string>),
    });
  };

  const editFields = edit ? fieldsOf(edit.ui) : [];
  const basicFields = editFields.filter((f) => !f.advanced);
  const advancedFields = editFields.filter((f) => f.advanced);
  const configuredAdvCount = advancedFields.filter((f) => {
    const v = opts[f.key];
    return Boolean(v && v.trim() !== "");
  }).length;

  return (
    <div className="space-y-4" data-mounts-page="">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <span>挂载点</span>
            <InfoTip content="挂载点将本地目录、对象存储或云盘映射为顶层文件夹。停用后保留配置但无法访问；删除挂载点不会删除远端或磁盘中的实际文件。" />
          </span>
        }
        desc="统一连接本地磁盘、对象存储与多网盘后端"
        actions={
          <>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4"
                aria-hidden="true"
              />
              <Input
                ctl="sm"
                className="w-48 !pl-8"
                placeholder="筛选挂载点"
                aria-label="筛选挂载点"
                value={mq}
                onChange={(e) => setMq(e.target.value)}
              />
            </div>
            <Button size="sm" loading={reindexing} onClick={reindex}>
              <RefreshCw className="size-3.5" /> 重建索引
            </Button>
            <Button size="sm" variant="primary" onClick={() => (setIsNew(true), setEdit(blank()))}>
              <Plus className="size-3.5" /> 添加存储
            </Button>
          </>
        }
      />

      {/* Compact status filter strip */}
      {mounts && mounts.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label="按启用状态筛选" className="inline-flex items-center gap-1 rounded-xl border border-line-1 bg-surface-0 p-1">
            {(
              [
                ["all", "全部", counts.total],
                ["enabled", "已启用", counts.enabled],
                ["disabled", "已停用", counts.disabled],
              ] as const
            ).map(([id, label, count]) => {
              const active = statusFilter === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStatusFilter(id)}
                  className={cx(
                    "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors",
                    active
                      ? "bg-surface-1 text-fg shadow-elev-1"
                      : "text-fg-3 hover:text-fg",
                  )}
                >
                  <span>{label}</span>
                  <span className="text-[11px] text-fg-4 tabular-nums">{count}</span>
                </button>
              );
            })}
          </div>
          <span className="text-[12px] text-fg-4">
            凭证均由服务端安全保管，卡片仅展示非敏感连接摘要
          </span>
        </div>
      )}

      {mounts === null && <SkCards n={4} />}

      {mounts?.length === 0 && (
        <div className="dh-st-panel">
          <Empty icon={<HardDrive className="size-10" />} title="还没有挂载点">
            添加一个本地目录、S3、WebDAV、PikPak 或 115 存储开始使用
          </Empty>
        </div>
      )}

      {mounts && mounts.length > 0 && fm.length === 0 && (
        <div className="dh-st-panel px-6 py-12 text-center text-[13px] text-fg-3">
          没有匹配当前筛选条件的挂载点
        </div>
      )}

      <div className="grid gap-3.5 lg:grid-cols-2" data-testid="mount-list">
        {pm.slice.map((m) => {
          const brand = detectMountBrand(m);
          const brandMeta = KINDS.find((k) => k.k === brand);
          const enabled = m.enabled !== false;
          const src = summarizeMountSource(m, brand);
          const mode = ((m.transfer_mode as TransferMode) || "auto") in TRANSFER_META
            ? (m.transfer_mode as TransferMode)
            : "auto";
          const tm = TRANSFER_META[mode];
          const TransferIcon = tm.icon;
          const SrcIcon =
            src.icon === "path" ? Folder : src.icon === "url" ? Globe : src.icon === "account" ? User : Cloud;

          return (
            <article
              key={m.name}
              data-mount-card={m.name}
              data-mount-kind={brand}
              className="dh-st-panel card-lift flex flex-col overflow-hidden"
            >
              {/* Main header row: brand icon + name + clean source summary + status & quick actions */}
              <div className="flex flex-wrap items-start gap-3.5 p-4 sm:px-5">
                <ProviderIcon
                  kind={brand}
                  size="lg"
                  className={cx(!enabled && "opacity-60 saturate-50")}
                />

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className={cx("truncate text-[15px] font-semibold tracking-tight", enabled ? "text-fg" : "text-fg-3")}>
                      {m.name}
                    </h2>
                    <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-fg-3">
                      {brandMeta?.shortLabel ?? m.kind}
                    </span>
                  </div>

                  <p className="flex items-center gap-1.5 text-[12.5px] text-fg-3" title={src.text}>
                    <SrcIcon className="size-3.5 shrink-0 text-fg-4" aria-hidden="true" />
                    <span className={cx("truncate", (src.icon === "path" || src.icon === "url") && "font-mono text-[12px]")}>
                      {src.text}
                    </span>
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <StatusPill tone={enabled ? "ok" : "warn"}>
                      {enabled ? "已启用" : "已停用"}
                    </StatusPill>
                    {m.read_only && (
                      <StatusPill tone="warn" dot={false}>
                        只读
                      </StatusPill>
                    )}
                    {m.hidden && (
                      <StatusPill tone="neutral" dot={false}>
                        隐藏
                      </StatusPill>
                    )}
                  </div>

                  <div className="flex items-center gap-1">
                    <SettingSwitch
                      variant="inline"
                      checked={enabled}
                      onChange={(v) => toggleEnabled(m, v)}
                      label={enabled ? `停用挂载点 ${m.name}` : `启用挂载点 ${m.name}`}
                      className="mr-1"
                    />
                    <IconButton
                      size="sm"
                      label={enabled ? `打开目录 /${m.name}` : "已停用，无法打开目录"}
                      disabled={!enabled}
                      onClick={() => go(filesHref(`/${m.name}`))}
                    >
                      <FolderOpen className="size-4" />
                    </IconButton>
                    <IconButton size="sm" label={`编辑 ${m.name}`} onClick={() => openEdit(m)}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <ConfirmButton
                      size="sm"
                      iconOnly
                      icon={<Trash2 />}
                      label={`删除挂载点 ${m.name}（不删除后端文件）`}
                      confirmLabel="删除挂载"
                      onConfirm={() =>
                        ok(client.DELETE("/api/mounts/{name}", { params: { path: { name: m.name } } }))
                          .then(refresh)
                          .catch((e) => toast.err(errMsg(e)))
                      }
                    />
                  </div>
                </div>
              </div>

              {/* Compact iconified metadata footer */}
              <footer className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line-1 bg-surface-0/70 px-4 py-2.5 text-[12px] text-fg-3 sm:px-5">
                <span className="inline-flex items-center gap-1.5" title={`传输方式：${tm.label}`}>
                  <TransferIcon className="size-3.5 text-fg-4" aria-hidden="true" />
                  <span>{tm.label}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 tabular-nums" title="侧栏与根目录排序权重（越小越靠前）">
                  <ArrowUpDown className="size-3.5 text-fg-4" aria-hidden="true" />
                  <span>排序 #{m.sort_order ?? 0}</span>
                </span>
                <span
                  className={cx("inline-flex items-center gap-1.5", m.read_only ? "text-warn" : "text-fg-3")}
                >
                  {m.read_only ? (
                    <>
                      <Lock className="size-3.5" aria-hidden="true" />
                      <span>只读保护</span>
                    </>
                  ) : (
                    <>
                      <PencilLine className="size-3.5 text-fg-4" aria-hidden="true" />
                      <span>可读写</span>
                    </>
                  )}
                </span>
                <span className="ml-auto inline-flex items-center gap-1 text-fg-4">
                  {m.hidden ? (
                    <>
                      <EyeOff className="size-3.5" aria-hidden="true" />
                      <span>侧栏隐藏</span>
                    </>
                  ) : (
                    <>
                      <Eye className="size-3.5" aria-hidden="true" />
                      <span>侧栏可见</span>
                    </>
                  )}
                </span>
              </footer>
            </article>
          );
        })}
      </div>

      <Pager {...pm} unit="个" />

      {/* Create / Edit Mount Modal */}
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={isNew ? "添加存储挂载点" : `编辑挂载点「${edit?.name}」`}
        wide
        footer={
          <>
            <Button onClick={() => setEdit(null)}>取消</Button>
            <Button variant="primary" loading={busy} onClick={save}>
              {isNew ? "添加挂载点" : "保存更改"}
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-4">
            {/* Driver picker on create; brand banner on edit */}
            {isNew ? (
              <div className="space-y-2">
                <p className="text-[12.5px] font-medium text-fg-2">选择存储类型</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" role="radiogroup" aria-label="存储类型">
                  {KINDS.map(({ k, label, desc }) => {
                    const selected = edit.ui === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-mount-kind-opt={k}
                        onClick={() =>
                          setEdit({
                            ...edit,
                            ui: k,
                            kind: k === "fs" || k === "s3" || k === "pikpak" || k === "p115" ? k : "webdav",
                            options:
                              k === "rclone"
                                ? { endpoint: "http://127.0.0.1:8090/" }
                                : k === "openlist"
                                  ? { endpoint: "http://127.0.0.1:8471/dav/" }
                                  : {},
                          })
                        }
                        className={cx(
                          "group relative flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition-all",
                          selected
                            ? "border-accent/55 bg-accent-soft/65 shadow-elev-1 ring-1 ring-accent/25"
                            : "border-line-1 bg-surface-0/75 hover:border-line-2 hover:bg-surface-2/60",
                        )}
                      >
                        <ProviderIcon kind={k} size="sm" />
                        <span className="min-w-0 flex-1 pr-3">
                          <span className="block truncate text-[12.5px] font-semibold text-fg">{label}</span>
                          <span className="mt-0.5 block truncate text-[11px] text-fg-3">{desc}</span>
                        </span>
                        {selected && (
                          <span className="absolute top-2 right-2 flex size-4 items-center justify-center rounded-full bg-accent text-accent-fg">
                            <Check className="size-2.5 stroke-[3]" aria-hidden="true" />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-line-1 bg-surface-0/75 px-3.5 py-2.5">
                <ProviderIcon kind={edit.ui} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-semibold text-fg">{edit.name}</p>
                  <p className="text-[12px] text-fg-3">
                    {KINDS.find((k) => k.k === edit.ui)?.label ?? edit.kind}
                  </p>
                </div>
                <StatusPill tone={edit.enabled !== false ? "ok" : "warn"}>
                  {edit.enabled !== false ? "已启用" : "已停用"}
                </StatusPill>
              </div>
            )}

            {edit.ui === "rclone" && (
              <InlineNote tone="info">
                <p className="font-medium text-fg">rclone 桥接向导</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[12px] text-fg-2">
                  <li>在服务器运行 <code>rclone config</code> 配置远端网盘（如 <code>gdrive:</code>）。</li>
                  <li>
                    启动桥接：<code className="break-all">rclone serve webdav gdrive: --addr 127.0.0.1:8090 --user dh --pass 密码</code>
                  </li>
                  <li>将地址、用户名与密码填入下方基础连接字段。</li>
                </ol>
              </InlineNote>
            )}

            {edit.ui === "openlist" && (
              <InlineNote tone="info">
                填写 OpenList 的 WebDAV 地址（形如 <code>http://主机:端口/dav/</code>）与账号信息。
              </InlineNote>
            )}

            {edit.ui === "p115" && (
              <InlineNote tone="info">
                填写 115 网页端 Cookie 中的四段核心字段（UID / CID / SEID / KID），提交时将自动拼装加密保存{!isNew ? "；编辑时全部留空则保持原凭据不变" : ""}。
              </InlineNote>
            )}

            {/* Section 1: Basic connection */}
            <SectionPanel title="基础连接" description="挂载名称与驱动必需的连接参数">
              <div className="grid gap-3.5 sm:grid-cols-2">
                <SettingField
                  label="名称（顶层文件夹名）"
                  required={isNew}
                  caption={!isNew ? "挂载名称创建后不可修改" : undefined}
                >
                  <SettingInput
                    name="mount-display-name"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder="例如：我的影音盘"
                    value={edit.name}
                    disabled={!isNew}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value.replace(/\//g, "") })}
                    required
                  />
                </SettingField>

                {basicFields.map((f) => (
                  <SettingField
                    key={f.key}
                    label={f.label}
                    required={!!f.req && isNew}
                    hint={f.hint}
                    caption={f.secret && !isNew ? "留空表示保持已存凭据不变" : undefined}
                  >
                    <SettingInput
                      name={"mount-opt-" + f.key}
                      type={f.secret ? "password" : "text"}
                      placeholder={f.ph}
                      value={opts[f.key] ?? ""}
                      onChange={(e) => setOpt(f.key, e.target.value)}
                      required={!!f.req && isNew}
                      autoComplete={fieldAutoComplete(f)}
                    />
                  </SettingField>
                ))}
              </div>
            </SectionPanel>

            {/* Section 2: Collapsible advanced driver options */}
            {advancedFields.length > 0 && (
              <SectionPanel flush>
                <DisclosureRow
                  title="高级选项"
                  summary={advancedFields.map((f) => f.label).join(" · ")}
                  icon={<SlidersHorizontal />}
                  badge={
                    configuredAdvCount > 0 ? (
                      <StatusPill tone="accent" dot={false}>
                        已设 {configuredAdvCount} 项
                      </StatusPill>
                    ) : (
                      <StatusPill tone="neutral" dot={false}>
                        可选
                      </StatusPill>
                    )
                  }
                >
                  <div className="grid gap-3.5 sm:grid-cols-2" data-mount-advanced="">
                    {advancedFields.map((f) => (
                      <SettingField
                        key={f.key}
                        label={f.label}
                        hint={f.hint}
                        caption={f.secret && !isNew ? "留空表示保持不变" : undefined}
                      >
                        <SettingInput
                          name={"mount-opt-" + f.key}
                          type={f.secret ? "password" : "text"}
                          placeholder={f.ph}
                          value={opts[f.key] ?? ""}
                          onChange={(e) => setOpt(f.key, e.target.value)}
                          autoComplete={fieldAutoComplete(f)}
                        />
                      </SettingField>
                    ))}
                  </div>
                </DisclosureRow>
              </SectionPanel>
            )}

            {/* Section 3: Transfer & visibility behavior */}
            <SectionPanel title="传输与访问控制">
              <div className="space-y-4">
                <div className="grid gap-3.5 sm:grid-cols-2">
                  <SettingField
                    label="传输方式"
                    hint="自动：有直链时浏览器直连，否则服务器中转；直链：始终直连；中转：始终经服务器转发。"
                  >
                    <SegmentedDrag
                      className="w-full min-w-0"
                      label="传输方式"
                      value={(edit.transfer_mode as TransferMode) || "auto"}
                      onChange={(v) => setEdit({ ...edit, transfer_mode: v })}
                      options={TRANSFER_OPTS}
                    />
                  </SettingField>
                  <SettingField label="排序权重" hint="数值越小，在侧栏与根目录中越靠前显示">
                    <SettingInput
                      type="number"
                      value={edit.sort_order ?? 0}
                      onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })}
                    />
                  </SettingField>
                </div>

                <div className="grid gap-2.5 sm:grid-cols-3">
                  <SettingSwitch
                    variant="card"
                    label="启用挂载点"
                    description="关闭后保留配置但不可访问"
                    checked={edit.enabled !== false}
                    onChange={(v) => setEdit({ ...edit, enabled: v })}
                  />
                  <SettingSwitch
                    variant="card"
                    label="在侧栏显示"
                    description="出现在侧栏与根目录列表中"
                    checked={!edit.hidden}
                    onChange={(v) => setEdit({ ...edit, hidden: !v })}
                  />
                  <SettingSwitch
                    variant="card"
                    label="只读模式"
                    description="禁止上传、修改与删除操作"
                    checked={!!edit.read_only}
                    onChange={(v) => setEdit({ ...edit, read_only: v })}
                  />
                </div>
              </div>
            </SectionPanel>
          </div>
        )}
      </Modal>
    </div>
  );
}
