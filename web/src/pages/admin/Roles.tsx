// Roles (RBAC): a role is a named bundle of permissions; assigned to users and user groups.
import { useEffect, useMemo, useState } from "react";
import { Lock, Pencil, Plus, ShieldCheck, Sparkles, Trash2, User, Users } from "lucide-react";
import { PERM_CATEGORIES, PERM_LABEL, PERMS, permsOf, rbac, type Role } from "../../lib/api";
import { cx, errMsg } from "../../lib/util";
import { LoadingButton } from "../../ui/motion";
import { Button, ConfirmButton, Empty, IconButton, Modal, PageHeader, toast } from "../../ui/ui";
import {
  InfoTip,
  InlineNote,
  ProviderIcon,
  SettingField,
  SettingInput,
  StatusPill,
  type ProviderKind,
  type StatusTone,
} from "../../ui/settings-ui";
import { SkCards } from "../../ui/r6";
import { PERM_CAT_META, PermMatrix } from "../../components/PermMatrix";

export { PermMatrix };

type Draft = { id: number | null; name: string; description: string; permissions: string[]; builtin: boolean };

interface RoleVisual {
  kind: ProviderKind;
  pillLabel: string;
  pillTone: StatusTone;
}

function getRoleVisual(r: Role): RoleVisual {
  if (r.level === "admin") {
    return { kind: "admin", pillLabel: "全局管理员", pillTone: "brand" };
  }
  if (r.level === "guest") {
    return { kind: "guest", pillLabel: "访客受限", pillTone: "warn" };
  }
  const hasAdminPerms = r.permissions.some((p) => p.startsWith("admin_"));
  const hasWritePerms = r.permissions.some((p) => ["upload", "create", "edit", "delete"].includes(p));
  if (r.builtin) {
    if (hasWritePerms) return { kind: "user", pillLabel: "内置成员", pillTone: "accent" };
    return { kind: "viewer", pillLabel: "内置只读", pillTone: "neutral" };
  }
  if (hasAdminPerms) return { kind: "custom", pillLabel: "含管理权限", pillTone: "accent" };
  if (hasWritePerms) return { kind: "editor", pillLabel: "可协作编辑", pillTone: "ok" };
  return { kind: "viewer", pillLabel: "只读角色", pillTone: "neutral" };
}

function RoleCard({
  role: r,
  onEdit,
  onDelete,
}: {
  role: Role;
  onEdit: () => void;
  onDelete: () => Promise<void>;
}) {
  const vis = getRoleVisual(r);
  const isAdminLevel = r.level === "admin";
  const grantedTotal = isAdminLevel ? PERMS.length : r.permissions.length;

  return (
    <li
      key={r.id}
      data-role={r.name}
      data-role-builtin={r.builtin ? "true" : "false"}
      className="dh-st-panel card-lift flex flex-col overflow-hidden"
    >
      {/* Header: distinct icon + title + concise badge + actions */}
      <div className="flex items-start gap-3 p-4 pb-3">
        <ProviderIcon kind={vis.kind} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[14.5px] font-semibold tracking-tight text-fg">{r.name}</h3>
            {r.builtin && (
              <span
                className="inline-flex items-center gap-0.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-fg-3"
                title="系统内置角色（不可删除或改名）"
              >
                <Lock className="size-2.5" aria-hidden="true" />
                内置
              </span>
            )}
            <StatusPill tone={vis.pillTone} dot={false} className="px-2 py-0 text-[11px]">
              {vis.pillLabel}
            </StatusPill>
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-fg-3" title={r.description || undefined}>
            {r.description || "未填写角色描述"}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton size="sm" label={`编辑角色 ${r.name}`} onClick={onEdit}>
            <Pencil className="size-4" />
          </IconButton>
          {!r.builtin && (
            <ConfirmButton
              size="sm"
              iconOnly
              icon={<Trash2 />}
              label={`删除角色 ${r.name}`}
              confirmLabel="删除角色"
              onConfirm={onDelete}
            />
          )}
        </div>
      </div>

      {/* Body: level callout (if admin/guest) + 4 compact capability micro-bars */}
      <div className="flex-1 space-y-3 px-4 pb-4">
        {isAdminLevel && (
          <InlineNote tone="info" className="py-1.5 text-[12px]">
            <span data-role-level="admin">拥有全部文件与管理后台权限，不受目录 ACL 规则限制</span>
          </InlineNote>
        )}
        {r.level === "guest" && (
          <InlineNote tone="warn" className="py-1.5 text-[12px]">
            <span data-role-level="guest">受 guest 级别上限约束，最高仅允许浏览与下载</span>
          </InlineNote>
        )}

        <div className="grid grid-cols-2 gap-2">
          {PERM_CATEGORIES.map((c) => {
            const ps = permsOf(c.id);
            const got = isAdminLevel ? ps : ps.filter((p) => r.permissions.includes(p));
            const ratio = ps.length ? got.length / ps.length : 0;
            const pct = Math.round(ratio * 100);
            const full = got.length === ps.length && ps.length > 0;
            const meta = PERM_CAT_META[c.id];
            const CatIcon = meta.icon;
            const tooltip = got.length
              ? `${c.label}（${got.length}/${ps.length}）：${got.map((p) => PERM_LABEL[p]).join("、")}`
              : `${c.label}：未授予任何权限`;

            return (
              <div
                key={c.id}
                data-role-cat={c.id}
                title={tooltip}
                className="rounded-xl border border-line-1 bg-surface-0/75 px-2.5 py-2 transition-colors hover:border-line-2"
              >
                <div className="flex items-center justify-between gap-1.5 text-[12px]">
                  <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-fg-2">
                    <CatIcon
                      className="size-3.5 shrink-0"
                      style={{ color: got.length > 0 ? meta.color : "var(--fg-4)" }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{meta.shortLabel}</span>
                  </span>
                  <span
                    className={cx(
                      "shrink-0 text-[11.5px] font-semibold tabular-nums",
                      full ? "text-ok" : got.length > 0 ? "text-fg" : "text-fg-4",
                    )}
                  >
                    {got.length}/{ps.length}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: full ? "var(--ok)" : got.length > 0 ? meta.color : "transparent",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer: assigned users/groups summary */}
      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-line-1 bg-surface-0/70 px-4 py-2.5 text-[12px] text-fg-3">
        <span className="inline-flex items-center gap-3 tabular-nums">
          <span className="inline-flex items-center gap-1" title={`已分配给 ${r.users} 位用户`}>
            <User className="size-3.5 text-fg-4" aria-hidden="true" />
            <span>{r.users} 用户</span>
          </span>
          <span className="inline-flex items-center gap-1" title={`已分配给 ${r.groups} 个用户组`}>
            <Users className="size-3.5 text-fg-4" aria-hidden="true" />
            <span>{r.groups} 组</span>
          </span>
        </span>
        <span className="text-[11.5px] font-medium text-fg-4 tabular-nums">
          {isAdminLevel ? "全量权限" : `${grantedTotal}/${PERMS.length} 项`}
        </span>
      </footer>
    </li>
  );
}

export function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [d, setD] = useState<Draft | null>(null);
  const [ready, setReady] = useState(false);

  const load = () => rbac.roles().then((r) => (setRoles(r), setReady(true)), (e) => toast.err(errMsg(e)));
  useEffect(() => void load(), []);

  const { builtinRoles, customRoles } = useMemo(() => {
    const builtin: Role[] = [];
    const custom: Role[] = [];
    for (const r of roles) {
      if (r.builtin) builtin.push(r);
      else custom.push(r);
    }
    return { builtinRoles: builtin, customRoles: custom };
  }, [roles]);

  const openCreate = () =>
    setD({ id: null, name: "", description: "", permissions: ["read", "download", "copy", "tag"], builtin: false });

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

  const removeRole = async (id: number) => {
    try {
      await rbac.deleteRole(id);
      toast.ok("已删除");
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };

  return (
    <div className="space-y-5" data-roles-page="">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <span>角色</span>
            <InfoTip content="角色是一组可复用的权限集合。分配给用户或用户组后在根目录生效；目录权限页中的深层规则可按需叠加或覆盖。" />
          </span>
        }
        desc="按能力组合管理成员权限包"
        actions={
          <Button size="sm" variant="primary" onClick={openCreate}>
            <Plus className="size-3.5" /> 新建角色
          </Button>
        }
      />

      {!ready && <SkCards n={3} />}

      <div className={cx("space-y-6", !ready && "hidden")} data-testid="role-list">
        {/* Builtin roles section */}
        <section className="space-y-3" aria-labelledby="roles-builtin-heading">
          <header className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-fg-3" aria-hidden="true" />
            <h2 id="roles-builtin-heading" className="text-[13.5px] font-semibold tracking-tight text-fg">
              系统内置角色
            </h2>
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-3 tabular-nums">
              {builtinRoles.length}
            </span>
          </header>
          <ul className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
            {builtinRoles.map((r) => (
              <RoleCard
                key={r.id}
                role={r}
                onEdit={() =>
                  setD({ id: r.id, name: r.name, description: r.description, permissions: r.permissions, builtin: r.builtin })
                }
                onDelete={() => removeRole(r.id)}
              />
            ))}
          </ul>
        </section>

        {/* Custom roles section */}
        <section className="space-y-3" aria-labelledby="roles-custom-heading">
          <header className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="size-4 text-fg-3" aria-hidden="true" />
              <h2 id="roles-custom-heading" className="text-[13.5px] font-semibold tracking-tight text-fg">
                自定义角色
              </h2>
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-3 tabular-nums">
                {customRoles.length}
              </span>
            </div>
          </header>

          {customRoles.length === 0 ? (
            <div className="dh-st-panel">
              <Empty icon={<Sparkles className="size-8" />} title="还没有自定义角色">
                <p className="mb-3">根据团队协作或运维分工创建精细权限包</p>
                <Button size="sm" variant="outline" onClick={openCreate}>
                  <Plus className="size-3.5" /> 创建第一个自定义角色
                </Button>
              </Empty>
            </div>
          ) : (
            <ul className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
              {customRoles.map((r) => (
                <RoleCard
                  key={r.id}
                  role={r}
                  onEdit={() =>
                    setD({ id: r.id, name: r.name, description: r.description, permissions: r.permissions, builtin: r.builtin })
                  }
                  onDelete={() => removeRole(r.id)}
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Create / Edit Role Modal */}
      <Modal
        open={!!d}
        onClose={() => setD(null)}
        wide
        title={d?.id == null ? "新建角色" : `编辑角色「${d.name}」`}
        footer={
          <>
            <Button onClick={() => setD(null)}>取消</Button>
            <LoadingButton variant="primary" onClick={save} disabled={!d?.name.trim()}>
              保存角色
            </LoadingButton>
          </>
        }
      >
        {d && (
          <div className="space-y-4">
            <div className="grid gap-3.5 sm:grid-cols-2">
              <SettingField
                label="角色名称"
                required={!d.builtin}
                caption={d.builtin ? "内置角色名称受保护，无法修改" : undefined}
              >
                <SettingInput
                  value={d.name}
                  disabled={d.builtin}
                  placeholder="例如：媒体协作者"
                  onChange={(e) => setD({ ...d, name: e.target.value })}
                />
              </SettingField>
              <SettingField label="角色描述">
                <SettingInput
                  value={d.description}
                  placeholder="简短说明适用成员与权限范围"
                  onChange={(e) => setD({ ...d, description: e.target.value })}
                />
              </SettingField>
            </div>

            <div className="space-y-2">
              <p className="text-[12.5px] font-medium text-fg-2">包含的权限</p>
              <PermMatrix value={d.permissions} onChange={(permissions) => setD({ ...d, permissions })} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
