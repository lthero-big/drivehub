// Roles (RBAC): a role is a named bundle of permissions; assigned to users and user groups.
import { useEffect, useState } from "react";
import { BadgeCheck, Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { PERM_LABEL, PERMS, rbac, type Role } from "../../lib/api";
import { cx, errMsg } from "../../lib/util";
import { Badge, Button, ConfirmButton, Field, IconButton, Input, Modal, PageHeader, toast } from "../../ui/ui";

const PERM_HINT: Record<string, string> = {
  read: "列目录、预览、查看属性", download: "下载文件与打包下载", upload: "上传文件到目录", create: "新建文件夹", edit: "重命名、移动、覆盖保存", delete: "删除文件与文件夹", share: "创建分享链接",
};
const PRESETS: { label: string; perms: string[] }[] = [
  { label: "只读", perms: ["read", "download"] },
  { label: "读写", perms: ["read", "download", "upload", "create", "edit"] },
  { label: "完全控制", perms: [...PERMS] },
  { label: "清空", perms: [] },
];

export function PermMatrix({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="space-y-2" data-testid="perm-matrix">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => <button key={p.label} type="button" onClick={() => onChange(p.perms)} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg">{p.label}</button>)}
      </div>
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {PERMS.map((p) => {
          const on = value.includes(p);
          return (
            <li key={p}>
              <button type="button" role="checkbox" aria-checked={on} onClick={() => onChange(on ? value.filter((x) => x !== p) : [...value, p])}
                className={cx("flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition active:scale-[0.98]", on ? "border-accent/40 bg-accent-soft" : "border-line hover:bg-hover")}>
                <span className={cx("grid size-5 shrink-0 place-items-center rounded-md border text-[11px] font-bold", on ? "border-accent bg-accent text-accent-fg" : "border-line text-transparent")}>✓</span>
                <span className="min-w-0"><span className="block text-[13px] font-medium">{PERM_LABEL[p]}</span><span className="block truncate text-[11px] text-muted">{PERM_HINT[p]}</span></span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Draft = { id: number | null; name: string; description: string; permissions: string[]; builtin: boolean };

export function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [d, setD] = useState<Draft | null>(null);
  const load = () => rbac.roles().then(setRoles, (e) => toast.err(errMsg(e)));
  useEffect(() => void load(), []);
  const save = async () => {
    if (!d) return;
    try {
      const b = { name: d.name, description: d.description, permissions: d.permissions };
      if (d.id == null) await rbac.createRole(b);
      else await rbac.updateRole(d.id, b);
      toast.ok("已保存");
      setD(null);
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader title="角色" desc="角色 = 一组权限。把角色分配给用户或用户组后，在根目录授予这些权限；目录权限页里更深层的规则仍可覆盖。" actions={
        <Button variant="primary" onClick={() => setD({ id: null, name: "", description: "", permissions: ["read", "download"], builtin: false })}><Plus className="size-4" /> 新建角色</Button>
      } />
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="role-list">
        {roles.map((r) => (
          <li key={r.id} className="card-lift flex flex-col gap-3 rounded-2xl border border-line bg-panel p-4 shadow-card" data-role={r.name}>
            <div className="flex items-start gap-2">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><BadgeCheck className="size-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 font-semibold">{r.name} {r.builtin && <Badge tone="neutral"><Lock className="mr-0.5 inline size-3" />内置</Badge>}</p>
                <p className="truncate text-xs text-muted">{r.description || "无描述"}</p>
              </div>
              <IconButton label={`编辑角色 ${r.name}`} onClick={() => setD({ id: r.id, name: r.name, description: r.description, permissions: r.permissions, builtin: r.builtin })}><Pencil className="size-4" /></IconButton>
              <ConfirmButton iconOnly icon={<Trash2 />} label={`删除角色 ${r.name}`} confirmLabel="删除角色" onConfirm={async () => { try { await rbac.deleteRole(r.id); toast.ok("已删除"); load(); } catch (e) { toast.err(errMsg(e)); } }} />
            </div>
            <div className="flex flex-wrap gap-1">
              {PERMS.map((p) => <Badge key={p} tone={r.permissions.includes(p) ? "ok" : "neutral"}>{r.permissions.includes(p) ? "✓" : "·"} {PERM_LABEL[p]}</Badge>)}
            </div>
            <p className="text-xs text-faint">{r.users} 个用户 · {r.groups} 个用户组 已分配</p>
          </li>
        ))}
      </ul>
      <Modal open={!!d} onClose={() => setD(null)} wide title={d?.id == null ? "新建角色" : `编辑角色「${d.name}」`} footer={<><Button onClick={() => setD(null)}>取消</Button><Button variant="primary" onClick={save} disabled={!d?.name.trim()}>保存</Button></>}>
        {d && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="角色名称" hint={d.builtin ? "内置角色不能改名" : undefined}><Input value={d.name} disabled={d.builtin} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
              <Field label="描述"><Input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
            </div>
            <p className="text-[13px] font-medium text-muted">包含的权限</p>
            <PermMatrix value={d.permissions} onChange={(permissions) => setD({ ...d, permissions })} />
          </div>
        )}
      </Modal>
    </div>
  );
}
