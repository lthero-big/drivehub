import { useEffect, useState } from "react";
import { LogOut, Pencil, Plus, Trash2, Users as UsersIcon } from "lucide-react";
import { call, type Group, type Me } from "../../lib/api";
import { useApp } from "../../lib/app";
import { errMsg, fmtSize, fmtTime } from "../../lib/util";
import { ConfirmButton, ask, Badge, Button, Card, Field, IconButton, Input, Checkbox, Modal, PageHeader, Pager, Select, Switch, toast, usePaged } from "../../ui/ui";

type Edit = { u: Me; email: string; role: string; disabled: boolean; email_verified: boolean; root_path: string; all_mounts: boolean; visible: string[]; quota_gb: string; groups: number[]; password: string; reset_totp: boolean };

export function UsersPage() {
  const { me } = useApp();
  const [users, setUsers] = useState<Me[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [mounts, setMounts] = useState<string[]>([]);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [uq, setUq] = useState("");
  const [role, setRole] = useState("");
  const [creating, setCreating] = useState<{ username: string; email: string; password: string; role: string } | null>(null);
  const load = async () => {
    try {
      const [u, g, m] = await Promise.all([call<Me[]>("GET", "/api/admin/users"), call<Group[]>("GET", "/api/admin/groups"), call<{ name: string }[]>("GET", "/api/mounts")]);
      setUsers(u);
      setGroups(g);
      setMounts(m.map((x) => x.name));
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  useEffect(() => {
    load();
  }, []);
  const fu = users.filter((u) => (!role || u.role === role) && (!uq.trim() || `${u.username} ${u.email ?? ""}`.toLowerCase().includes(uq.trim().toLowerCase())));
  const pu = usePaged(fu, 10, uq + role);
  const [gq, setGq] = useState("");
  const fg = groups.filter((g) => !gq.trim() || g.name.toLowerCase().includes(gq.trim().toLowerCase()));
  const pg = usePaged(fg, 12, gq);
  const act = async (f: () => Promise<unknown>, msg?: string) => {
    try {
      await f();
      if (msg) toast.ok(msg);
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const open = (u: Me) =>
    setEdit({ u, email: u.email ?? "", role: u.role, disabled: u.disabled, email_verified: u.email_verified, root_path: u.root_path, all_mounts: u.visible_mounts == null, visible: u.visible_mounts ?? [], quota_gb: u.quota_bytes ? String(+(u.quota_bytes / 2 ** 30).toFixed(2)) : "", groups: u.groups.map((g) => g.id), password: "", reset_totp: false });
  const save = () =>
    edit &&
    act(async () => {
      const e = edit;
      await call("PATCH", `/api/admin/users/${e.u.id}`, {
        email: e.email || null,
        role: e.role,
        disabled: e.disabled,
        email_verified: e.email_verified,
        root_path: e.root_path || "/",
        ...(e.all_mounts ? { clear_visible_mounts: true } : { visible_mounts: e.visible }),
        quota_bytes: e.quota_gb ? Math.round(Number(e.quota_gb) * 2 ** 30) : -1,
        groups: e.groups,
        ...(e.password ? { password: e.password } : {}),
        ...(e.reset_totp ? { reset_totp: true } : {}),
      });
      setEdit(null);
    }, "已保存");
  return (
    <div className="space-y-4">
      <PageHeader title="用户与用户组" desc={`${users.length} 位用户 · ${groups.length} 个用户组`} actions={
        <>
          <Input className="w-48" placeholder="搜索用户名/邮箱" aria-label="搜索用户" value={uq} onChange={(e) => setUq(e.target.value)} />
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="角色筛选"><option value="">全部角色</option><option value="admin">admin</option><option value="user">user</option></Select>
          <Button variant="primary" onClick={() => setCreating({ username: "", email: "", password: "", role: "user" })}>
            <Plus className="size-4" /> 新建用户
          </Button>
        </>
      } />
      <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-card">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line bg-panel-2 text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">用户</th>
              <th className="px-3 py-2 font-medium">角色</th>
              <th className="px-3 py-2 font-medium">用户组</th>
              <th className="px-3 py-2 font-medium">根目录</th>
              <th className="px-3 py-2 font-medium">空间</th>
              <th className="px-3 py-2 font-medium">创建</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {pu.slice.map((u) => (
              <tr key={u.id} className="hover:bg-hover">
                <td className="px-3 py-2">
                  <p className="font-medium">
                    {u.username} {u.disabled && <Badge tone="danger">已禁用</Badge>} {u.totp_enabled && <Badge tone="ok">2FA</Badge>}
                  </p>
                  <p className="text-xs text-faint">{u.email ?? "—"} {u.identities.length > 0 && `· ${u.identities.join("/")}`}</p>
                </td>
                <td className="px-3 py-2"><Badge tone={u.role === "admin" ? "accent" : "neutral"}>{u.role}</Badge></td>
                <td className="px-3 py-2 text-xs">{u.groups.map((g) => g.name).join("、") || "—"}</td>
                <td className="px-3 py-2 font-mono text-xs">{u.root_path}</td>
                <td className="px-3 py-2 text-xs">{fmtSize(u.used_bytes)}{u.quota_bytes ? ` / ${fmtSize(u.quota_bytes)}` : ""}</td>
                <td className="px-3 py-2 text-xs text-muted">{fmtTime(u.created_at)}</td>
                <td className="px-2 py-2">
                  <div className="flex justify-end">
                    <IconButton label="编辑" onClick={() => open(u)}><Pencil className="size-4" /></IconButton>
                    <IconButton label="强制下线" onClick={() => act(() => call("POST", `/api/admin/users/${u.id}/logout`), "已强制下线")}><LogOut className="size-4" /></IconButton>
                    {u.id !== me?.id && (
                      <ConfirmButton iconOnly icon={<Trash2 />} label={`删除用户 ${u.username}`} confirmLabel="删除用户" onConfirm={() => act(() => call("DELETE", `/api/admin/users/${u.id}`), "已删除")} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {fu.length === 0 && <p className="p-6 text-center text-sm text-muted">没有匹配的用户</p>}
      </div>
      <Pager {...pu} />

      <Card title={<span className="flex items-center gap-2"><UsersIcon className="size-4" /> 用户组</span>} actions={<Button size="sm" onClick={async () => { const n = await ask("新建用户组", { label: "名称", confirm: "创建" }); if (n?.trim()) act(() => call("POST", "/api/admin/groups", { name: n.trim() }), "已创建"); }}><Plus className="size-4" /> 新建</Button>}>
        {groups.length === 0 && <p className="text-[13px] text-muted">还没有用户组。用户组可用于目录权限规则。</p>}
        <ul className="flex flex-wrap gap-2">
          {pg.slice.map((g) => (
            <li key={g.id} className="flex items-center gap-1 rounded-xl border border-line py-1 pr-1 pl-2.5 text-[13px]">
              {g.name} <span className="text-xs text-faint">{g.members} 人</span>
              <ConfirmButton iconOnly size="sm" icon={<Trash2 />} label={`删除 ${g.name}`} confirmLabel="删除" onConfirm={() => act(() => call("DELETE", `/api/admin/groups/${g.id}`))} />
            </li>
          ))}
        </ul>
        {groups.length > 12 && <Input className="mt-3 max-w-xs" placeholder="筛选用户组" aria-label="筛选用户组" value={gq} onChange={(e) => setGq(e.target.value)} />}
        <Pager {...pg} />
      </Card>

      <Modal open={!!creating} onClose={() => setCreating(null)} title="新建用户" footer={<><Button onClick={() => setCreating(null)}>取消</Button><Button variant="primary" onClick={() => creating && act(async () => { await call("POST", "/api/admin/users", { ...creating, email: creating.email || null, password: creating.password || null }); setCreating(null); }, "已创建")}>创建</Button></>}>
        {creating && (
          <div className="space-y-3">
            <Field label="用户名"><Input value={creating.username} onChange={(e) => setCreating({ ...creating, username: e.target.value })} /></Field>
            <Field label="邮箱（可选）"><Input type="email" value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} /></Field>
            <Field label="初始密码" hint="至少 8 位；留空则只能用 OAuth 或重置邮件登录"><Input type="password" autoComplete="new-password" value={creating.password} onChange={(e) => setCreating({ ...creating, password: e.target.value })} /></Field>
            <Field label="角色"><Select value={creating.role} onChange={(e) => setCreating({ ...creating, role: e.target.value })}><option value="user">user</option><option value="admin">admin</option><option value="guest">guest（最多只读+下载）</option></Select></Field>
          </div>
        )}
      </Modal>

      <Modal open={!!edit} onClose={() => setEdit(null)} wide title={`编辑用户「${edit?.u.username}」`} footer={<><Button onClick={() => setEdit(null)}>取消</Button><Button variant="primary" onClick={save}>保存</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="邮箱"><Input type="email" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="角色"><Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })}><option>admin</option><option>user</option><option>guest</option></Select></Field>
            <Field label="根目录" hint="用户只能看到此目录及以下（管理员不受限）"><Input value={edit.root_path} onChange={(e) => setEdit({ ...edit, root_path: e.target.value })} /></Field>
            <Field label="空间配额（GB）" hint="留空 = 不限"><Input type="number" min={0} step="0.1" value={edit.quota_gb} onChange={(e) => setEdit({ ...edit, quota_gb: e.target.value })} /></Field>
            <Field label="重设密码" hint="留空不修改"><Input type="password" autoComplete="new-password" value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} /></Field>
            <div className="space-y-2 text-[13px]">
              <span className="text-[13px] font-medium text-muted">状态</span>
              <label className="flex items-center gap-2"><Switch label="禁用" checked={edit.disabled} onChange={(v) => setEdit({ ...edit, disabled: v })} /> 禁用账号</label>
              <label className="flex items-center gap-2"><Switch label="邮箱已验证" checked={edit.email_verified} onChange={(v) => setEdit({ ...edit, email_verified: v })} /> 邮箱已验证</label>
              {edit.u.totp_enabled && <label className="flex items-center gap-2"><Switch label="重置两步验证" checked={edit.reset_totp} onChange={(v) => setEdit({ ...edit, reset_totp: v })} /> 重置两步验证</label>}
            </div>
            <fieldset className="space-y-1.5 text-[13px]">
              <legend className="mb-1 font-medium text-muted">可见挂载点</legend>
              <Checkbox checked={edit.all_mounts} onChange={(v) => setEdit({ ...edit, all_mounts: v })}>全部</Checkbox>
              {!edit.all_mounts && mounts.map((m) => (
                <Checkbox key={m} className="ml-5" checked={edit.visible.includes(m)} onChange={(v) => setEdit({ ...edit, visible: v ? [...edit.visible, m] : edit.visible.filter((x) => x !== m) })}>{m}</Checkbox>
              ))}
            </fieldset>
            <fieldset className="space-y-1.5 text-[13px]">
              <legend className="mb-1 font-medium text-muted">用户组</legend>
              {groups.length === 0 && <p className="text-faint">暂无</p>}
              {groups.map((g) => (
                <Checkbox key={g.id} checked={edit.groups.includes(g.id)} onChange={(v) => setEdit({ ...edit, groups: v ? [...edit.groups, g.id] : edit.groups.filter((x) => x !== g.id) })}>{g.name}</Checkbox>
              ))}
            </fieldset>
          </div>
        )}
      </Modal>
    </div>
  );
}
