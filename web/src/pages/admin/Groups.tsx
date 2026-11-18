// User groups: members + assigned roles. (Users and roles live on their own pages.)
import { LoadingButton } from "../../ui/motion";
import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2, Users as UsersIcon } from "lucide-react";
import { call, rbac, type Group, type Me, type Role } from "../../lib/api";
import { errMsg } from "../../lib/util";
import { Badge, Button, Checkbox, ConfirmButton, Field, IconButton, Input, Modal, PageHeader, Pager, toast, usePaged } from "../../ui/ui";

type Draft = { id: number | null; name: string; members: number[]; roles: number[] };

export function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<Me[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [d, setD] = useState<Draft | null>(null);
  const [q, setQ] = useState("");
  const [uq, setUq] = useState("");
  const load = async () => {
    try {
      const [g, u, r] = await Promise.all([rbac.groups(), call<Me[]>("GET", "/api/admin/users"), rbac.roles()]);
      setGroups(g);
      setUsers(u);
      setRoles(r);
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  useEffect(() => void load(), []);
  const f = groups.filter((g) => !q.trim() || g.name.toLowerCase().includes(q.trim().toLowerCase()));
  const pg = usePaged(f, 10, q);
  const shownUsers = useMemo(() => users.filter((u) => !uq.trim() || u.username.toLowerCase().includes(uq.trim().toLowerCase())), [users, uq]);
  const save = async () => {
    if (!d) return;
    try {
      let id = d.id;
      if (id == null) id = (await rbac.createGroup(d.name.trim())).id;
      await rbac.updateGroup(id, { name: d.name.trim(), members: d.members, roles: d.roles });
      toast.ok("已保存");
      setD(null);
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const tog = (arr: number[], v: number, on: boolean) => (on ? [...arr, v] : arr.filter((x) => x !== v));
  return (
    <div className="space-y-4">
      <PageHeader title="用户组" desc={`${groups.length} 个用户组 · 组内成员继承组的角色与目录规则`} actions={
        <>
          <Input className="w-48" placeholder="搜索用户组" aria-label="搜索用户组" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button variant="primary" onClick={() => setD({ id: null, name: "", members: [], roles: [] })}><Plus className="size-4" /> 新建用户组</Button>
        </>
      } />
      <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-card">
        <table className="w-full min-w-[560px] text-left text-[13px]" data-testid="group-table">
          <thead className="border-b border-line bg-panel-2 text-xs text-muted"><tr><th className="px-3 py-2 font-medium">用户组</th><th className="px-3 py-2 font-medium">成员</th><th className="px-3 py-2 font-medium">角色</th><th /></tr></thead>
          <tbody className="divide-y divide-line">
            {pg.slice.map((g) => (
              <tr key={g.id} className="hover:bg-hover">
                <td className="px-3 py-2.5"><span className="flex items-center gap-2 font-medium"><span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent"><UsersIcon className="size-4" /></span>{g.name}</span></td>
                <td className="px-3 py-2.5 text-xs text-muted">{g.members} 人{(g.member_list?.length ?? 0) > 0 && <span className="text-faint"> · {g.member_list!.slice(0, 4).map((m) => m.username).join("、")}{g.members > 4 ? "…" : ""}</span>}</td>
                <td className="px-3 py-2.5"><div className="flex flex-wrap gap-1">{(g.roles ?? []).map((r) => <Badge key={r.id} tone="ok">{r.name}</Badge>)}{!(g.roles ?? []).length && <span className="text-xs text-faint">—</span>}</div></td>
                <td className="px-2 py-2.5"><div className="flex justify-end">
                  <IconButton label={`编辑用户组 ${g.name}`} onClick={() => setD({ id: g.id, name: g.name, members: (g.member_list ?? []).map((m) => m.id), roles: (g.roles ?? []).map((r) => r.id) })}><Pencil className="size-4" /></IconButton>
                  <ConfirmButton iconOnly icon={<Trash2 />} label={`删除用户组 ${g.name}`} confirmLabel="删除用户组" onConfirm={async () => { try { await rbac.deleteGroup(g.id); toast.ok("已删除"); load(); } catch (e) { toast.err(errMsg(e)); } }} />
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {f.length === 0 && <p className="p-6 text-center text-sm text-muted">还没有用户组</p>}
      </div>
      <Pager {...pg} />
      <Modal open={!!d} onClose={() => setD(null)} wide title={d?.id == null ? "新建用户组" : `编辑用户组「${d.name}」`} footer={<><Button onClick={() => setD(null)}>取消</Button><LoadingButton variant="primary" onClick={save} disabled={!d?.name.trim()}>保存</LoadingButton></>}>
        {d && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <Field label="名称"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
              <fieldset className="space-y-1.5 text-[13px]"><legend className="mb-1 font-medium text-muted">分配角色</legend>
                {roles.map((r) => <Checkbox key={r.id} checked={d.roles.includes(r.id)} onChange={(v) => setD({ ...d, roles: tog(d.roles, r.id, v) })}>{r.name} <span className="text-xs text-faint">{r.description}</span></Checkbox>)}
              </fieldset>
            </div>
            <fieldset className="space-y-1.5 text-[13px]"><legend className="mb-1 font-medium text-muted">成员（{d.members.length}）</legend>
              <Input placeholder="筛选用户" aria-label="筛选用户" value={uq} onChange={(e) => setUq(e.target.value)} />
              <div className="max-h-56 space-y-1 overflow-auto scroll-thin">
                {shownUsers.map((u) => <Checkbox key={u.id} checked={d.members.includes(u.id)} onChange={(v) => setD({ ...d, members: tog(d.members, u.id, v) })}>{u.username}</Checkbox>)}
              </div>
            </fieldset>
          </div>
        )}
      </Modal>
    </div>
  );
}
