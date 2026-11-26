import { useMemo, useState } from "react";
import {
  BadgeCheck,
  Check,
  ChevronDown,
  Copy,
  Download,
  Eye,
  FilePenLine,
  FolderInput,
  FolderLock,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Inbox,
  Link2,
  ScrollText,
  Search,
  Settings,
  Share2,
  Shield,
  Tag,
  TextCursorInput,
  Trash2,
  Upload,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { PERM_CATEGORIES, PERM_HINT, PERM_LABEL, PERMS, permsOf, type PermDef } from "../lib/api";
import { cx } from "../lib/util";
import { Disclosure, InfoTip, StatusPill } from "../ui/settings-ui";

export const PERM_ICON: Record<string, LucideIcon> = {
  read: Eye,
  download: Download,
  upload: Upload,
  create: FolderPlus,
  edit: FilePenLine,
  rename: TextCursorInput,
  move: FolderInput,
  copy: Copy,
  delete: Trash2,
  share: Share2,
  share_upload: Inbox,
  share_manage: Link2,
  tag: Tag,
  admin_users: UserCog,
  admin_groups: Users,
  admin_roles: BadgeCheck,
  admin_acl: FolderLock,
  admin_mounts: HardDrive,
  admin_audit: ScrollText,
  admin_settings: Settings,
};

export const PERM_CAT_META: Record<
  PermDef["category"],
  { icon: LucideIcon; shortLabel: string; color: string }
> = {
  file: { icon: FolderOpen, shortLabel: "文件", color: "#2563eb" },
  share: { icon: Share2, shortLabel: "分享", color: "#0d9488" },
  tag: { icon: Tag, shortLabel: "标签", color: "#d97706" },
  admin: { icon: Shield, shortLabel: "管理", color: "#c83e1c" },
};

const FILE_RW = ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "tag"];

const BASE_PRESETS: { id: string; label: string; perms: string[] }[] = [
  { id: "ro", label: "只读", perms: ["read", "download", "copy", "tag"] },
  { id: "rw", label: "读写", perms: FILE_RW },
  { id: "file_full", label: "文件完全控制", perms: [...FILE_RW, "delete", "share", "share_upload"] },
  { id: "all", label: "全部（含管理）", perms: [...PERMS] },
  { id: "empty", label: "清空", perms: [] },
];

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export interface PermMatrixProps {
  value: string[];
  onChange: (v: string[]) => void;
  /** Restrict displayed permissions (e.g. PATH_PERMS for non-root directory ACL). */
  only?: string[];
  /** Compact 2-column grid for embedded editors (such as ACL AddRule). */
  compact?: boolean;
  /** Start with specific categories collapsed (defaults to all expanded). */
  defaultCollapsed?: PermDef["category"][];
}

/**
 * Searchable, collapsible grouped permission matrix (RHEA-278).
 * Shared by RolesPage modal and AclPage custom permission editor.
 */
export function PermMatrix({
  value,
  onChange,
  only,
  compact = false,
  defaultCollapsed = [],
}: PermMatrixProps) {
  const names = only ?? PERMS;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(defaultCollapsed.map((k) => [k, true])),
  );

  const q = query.trim().toLowerCase();

  const presets = useMemo(() => {
    const hasAdmin = names.some((n) => n.startsWith("admin_"));
    return BASE_PRESETS.map((p) => ({
      ...p,
      label: p.id === "all" && !hasAdmin ? "全部" : p.label,
      perms: p.perms.filter((x) => names.includes(x)),
    })).filter((p, idx, arr) => p.id === "empty" || arr.findIndex((o) => sameSet(o.perms, p.perms)) === idx);
  }, [names]);

  const categories = useMemo(() => {
    return PERM_CATEGORIES.map((c) => {
      const allPs = permsOf(c.id, names);
      const visiblePs = q
        ? allPs.filter((p) => {
            const label = (PERM_LABEL[p] ?? "").toLowerCase();
            const hint = (PERM_HINT[p] ?? "").toLowerCase();
            return label.includes(q) || hint.includes(q) || p.toLowerCase().includes(q) || c.label.toLowerCase().includes(q);
          })
        : allPs;
      return { ...c, allPs, visiblePs };
    }).filter((c) => c.visiblePs.length > 0);
  }, [names, q]);

  const allCategoryIds = useMemo(
    () => PERM_CATEGORIES.filter((c) => permsOf(c.id, names).length > 0).map((c) => c.id),
    [names],
  );
  const allCollapsed = allCategoryIds.length > 0 && allCategoryIds.every((id) => collapsed[id]);

  const toggleAllCollapsed = () => {
    const next = !allCollapsed;
    setCollapsed(Object.fromEntries(allCategoryIds.map((id) => [id, next])));
  };

  const selectedInScope = value.filter((v) => names.includes(v));

  return (
    <div className="space-y-3" data-testid="perm-matrix">
      {/* Top toolbar: search + summary + presets */}
      <div className="space-y-2.5 rounded-xl border border-line-1 bg-surface-0/75 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-44 flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索权限名称或说明…"
              aria-label="搜索权限"
              data-perm-search=""
              className="h-8 w-full rounded-lg border border-line-2 bg-surface-1 pr-7 pl-8 text-[12.5px] text-fg placeholder:text-fg-4 transition-colors hover:border-line-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring/30"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-fg-4 hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-3" />
              </button>
            )}
          </div>
          <span className="text-[12px] text-fg-3 tabular-nums">
            已选 <strong className="font-semibold text-fg">{selectedInScope.length}</strong> / {names.length}
          </span>
          {!q && (
            <button
              type="button"
              onClick={toggleAllCollapsed}
              data-perm-toggle-all=""
              className="rounded-lg border border-line-2 bg-surface-1 px-2.5 py-1 text-[11.5px] font-medium text-fg-2 transition-colors hover:border-line-3 hover:bg-surface-2 hover:text-fg"
            >
              {allCollapsed ? "展开全部" : "收起全部分组"}
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="快捷权限预设">
          <span className="mr-0.5 text-[11.5px] font-medium text-fg-4">快捷预设</span>
          {presets.map((p) => {
            const active = sameSet(selectedInScope, p.perms);
            return (
              <button
                key={p.id}
                type="button"
                data-perm-preset={p.id}
                aria-pressed={active}
                onClick={() => onChange(p.perms)}
                className={cx(
                  "rounded-full border px-2.5 py-0.5 text-[12px] font-medium transition-colors",
                  active
                    ? "border-accent/50 bg-accent-soft text-accent"
                    : "border-line-2 bg-surface-1 text-fg-2 hover:border-line-3 hover:bg-surface-2 hover:text-fg",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Category sections */}
      {categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-2 bg-surface-0/60 px-4 py-8 text-center text-[13px] text-fg-3">
          没有找到匹配「{query}」的权限
        </div>
      ) : (
        <div className="space-y-2.5">
          {categories.map((c) => {
            const ps = c.visiblePs;
            const allPs = c.allPs;
            const count = allPs.filter((p) => value.includes(p)).length;
            const allSelected = count === allPs.length;
            const isOpen = q ? true : !collapsed[c.id];
            const meta = PERM_CAT_META[c.id];
            const CatIcon = meta.icon;

            return (
              <section
                key={c.id}
                data-perm-cat={c.id}
                data-open={isOpen ? "true" : "false"}
                className="overflow-hidden rounded-xl border border-line-1 bg-surface-1"
              >
                <header className="flex items-center gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    data-perm-cat-toggle={c.id}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [c.id]: isOpen }))}
                    className="group flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        color: meta.color,
                        backgroundColor: `color-mix(in oklab, ${meta.color} 12%, var(--surface-1))`,
                      }}
                      className="flex size-7 shrink-0 items-center justify-center rounded-lg"
                    >
                      <CatIcon className="size-3.5" />
                    </span>
                    <span className="text-[13.5px] font-semibold text-fg">{c.label}</span>
                    <StatusPill
                      tone={allSelected ? "ok" : count > 0 ? "accent" : "neutral"}
                      dot={false}
                      className="px-2 py-0 text-[11px] tabular-nums"
                    >
                      {count}/{allPs.length}
                    </StatusPill>
                    <ChevronDown
                      aria-hidden="true"
                      className={cx(
                        "ml-auto size-4 shrink-0 text-fg-4 transition-transform duration-[var(--dur-base)] ease-[var(--ease-enter)] group-hover:text-fg-2",
                        isOpen && "rotate-180 text-fg-2",
                      )}
                    />
                  </button>
                  {c.id === "admin" && (
                    <InfoTip content="全局管理权限仅在根目录与角色中生效，无法在子目录规则里单独授予。" />
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      onChange(
                        allSelected
                          ? value.filter((x) => !allPs.includes(x))
                          : [...new Set([...value, ...allPs])],
                      )
                    }
                    className="shrink-0 rounded-lg border border-line-2 bg-surface-0 px-2 py-0.5 text-[11.5px] font-medium text-fg-2 transition-colors hover:border-line-3 hover:bg-surface-2 hover:text-fg"
                  >
                    {allSelected ? "全不选" : "全选"}
                  </button>
                </header>

                <Disclosure open={isOpen}>
                  <div className="border-t border-line-1 bg-surface-0/50 p-2.5">
                    <ul
                      className={cx(
                        "grid gap-1.5",
                        compact ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3",
                      )}
                    >
                      {ps.map((p) => {
                        const on = value.includes(p);
                        const Icon = PERM_ICON[p] ?? Shield;
                        return (
                          <li key={p}>
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={on}
                              data-perm={p}
                              onClick={() =>
                                onChange(on ? value.filter((x) => x !== p) : [...value, p])
                              }
                              className={cx(
                                "group flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all active:scale-[0.985]",
                                on
                                  ? "border-accent/45 bg-accent-soft/75 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_14%,transparent)]"
                                  : "border-line-1 bg-surface-1 hover:border-line-2 hover:bg-surface-2/60",
                              )}
                            >
                              <span
                                aria-hidden="true"
                                className={cx(
                                  "flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                                  on
                                    ? "bg-accent/14 text-accent"
                                    : "bg-surface-2 text-fg-3 group-hover:text-fg-2",
                                )}
                              >
                                <Icon className="size-3.5" />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-semibold text-fg">
                                  {PERM_LABEL[p]}
                                </span>
                                <span
                                  className="block truncate text-[11px] text-fg-3"
                                  title={PERM_HINT[p]}
                                >
                                  {PERM_HINT[p]}
                                </span>
                              </span>
                              <span
                                aria-hidden="true"
                                className={cx(
                                  "flex size-4.5 shrink-0 items-center justify-center rounded-md border transition-colors",
                                  on
                                    ? "border-accent bg-accent text-accent-fg"
                                    : "border-line-2 bg-surface-0 text-transparent",
                                )}
                              >
                                <Check className="size-3 stroke-[3]" />
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </Disclosure>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
