// Directory permissions — RHEA-278 aligned with settings-ui, StatusPill & upgraded PermMatrix.
// Sub-tabs:
//   按目录   — configured-folder list on the left; on the right one card per member (who) with a preset dropdown
//              (只读 / 读写 / 完全控制 / 禁止访问 / 自定义), a grouped summary and an optional per-permission fine-tune.
//   按成员   — every rule that applies to a user / group / everyone, across folders.
//   权限检查 — pick a person + folder, see the effective permissions and how they were derived.
//   使用说明 — how inheritance and priority work.
import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronRight,
  FolderOpen,
  FolderSearch,
  FolderTree,
  Globe2,
  Lock,
  Minus,
  Plus,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import {
  call,
  PERM_CATEGORIES,
  PERM_HINT,
  PERM_LABEL,
  PERMS,
  PATH_PERMS,
  permsOf,
  type Effective,
  type Gate,
  type Group,
  type Me,
  type Rule,
} from "../../lib/api";
import { go } from "../../lib/router";
import { cx, errMsg } from "../../lib/util";
import { DirPicker } from "../../components/DirPicker";
import { PERM_CAT_META, PERM_ICON, PermMatrix } from "../../components/PermMatrix";
import { Sk, SkWrap } from "../../ui/r6";
import { Button, Card, Field, IconButton, Input, PageHeader, Pager, Select, Tabs, toast, usePaged } from "../../ui/ui";
import { Disclosure, InfoTip, SectionPanel, StatusPill, type StatusTone } from "../../ui/settings-ui";

const SUBJ: Record<string, string> = { logged_in: "所有登录用户", anonymous: "匿名访客", group: "用户组", user: "用户" };
const SUBJ_META: Record<string, { icon: React.ReactNode; color: string }> = {
  logged_in: { icon: <Users />, color: "#4f46e5" },
  anonymous: { icon: <Globe2 />, color: "#b45309" },
  group: { icon: <Users />, color: "#0d9488" },
  user: { icon: <User />, color: "#2563eb" },
};
const GATE: Record<string, { label: string; hint: string }> = {
  anonymous: { label: "允许匿名", hint: "无需登录即可进入" },
  logged_in: { label: "需要登录", hint: "登录后可进入" },
  password: { label: "需要密码", hint: "输入目录密码后可进入" },
};
type Preset = { id: string; label: string; desc: string; allow: string[]; deny: string[] };
const PRESETS: Preset[] = [
  { id: "ro", label: "只读", desc: "可以浏览和下载", allow: ["read", "download"], deny: [] },
  { id: "rw", label: "读写", desc: "还可以上传、新建、编辑、整理", allow: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "tag"], deny: [] },
  { id: "full", label: "完全控制", desc: "包括删除与分享", allow: [...PATH_PERMS], deny: [] },
  { id: "none", label: "禁止访问", desc: "看不到、也不能下载", allow: [], deny: ["read", "download"] },
];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const presetOf = (r: { allow: string[]; deny: string[] }) => PRESETS.find((p) => same(p.allow, r.allow) && same(p.deny, r.deny))?.id ?? "custom";
type Cell = "none" | "allow" | "deny";
const cellOf = (r: { allow: string[]; deny: string[] }, p: string): Cell => (r.allow.includes(p) ? "allow" : r.deny.includes(p) ? "deny" : "none");
const CELL_LABEL: Record<Cell, string> = { none: "继承", allow: "允许", deny: "拒绝" };
const norm = (p: string) => "/" + p.split("/").filter(Boolean).join("/");
type Tab = "dir" | "member" | "check" | "help";

export function AclPage({ initialPath }: { initialPath: string }) {
  const [tab, setTab] = useState<Tab>("dir");
  const [path, setPath] = useState(initialPath || "/");
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [gates, setGates] = useState<Gate[]>([]);
  const [users, setUsers] = useState<Me[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => setPath(initialPath || "/"), [initialPath]);
  const load = async () => {
    try {
      const [r, g, u, gr] = await Promise.all([
        call<Rule[]>("GET", "/api/acl/rules"),
        call<Gate[]>("GET", "/api/acl/gates"),
        call<Me[]>("GET", "/api/admin/users"),
        call<Group[]>("GET", "/api/admin/groups"),
      ]);
      setRules(r), setGates(g), setUsers(u), setGroups(gr);
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  useEffect(() => void load(), []);
  const act = async (f: () => Promise<unknown>, msg: string) => {
    try {
      await f();
      toast.ok(msg);
      await load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const subjName = (r: { subject: string; subject_id: number | null }) =>
    (r.subject === "user"
      ? users.find((u) => u.id === r.subject_id)?.username
      : r.subject === "group"
        ? groups.find((g) => g.id === r.subject_id)?.name
        : null) ?? null;
  const ctx = { rules: rules ?? [], gates, users, groups, act, subjName };
  const openDir = (p: string) => (setPath(p), setTab("dir"));
  return (
    <div className="space-y-4" data-acl-page>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <span>目录权限</span>
            <InfoTip content="控制成员在指定目录及其子目录中的操作权限与进入门槛。下级目录自动继承上级规则，越深的路径优先级越高。" />
          </span>
        }
        desc="按目录与成员精细配置访问规则与门槛"
      />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "dir", label: "按目录", icon: <FolderTree className="size-4" /> },
          { id: "member", label: "按成员", icon: <Users className="size-4" /> },
          { id: "check", label: "权限检查", icon: <ShieldCheck className="size-4" /> },
          { id: "help", label: "使用说明", icon: <BookOpen className="size-4" /> },
        ]}
      />
      {!rules ? (
        <SkWrap className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]" label="正在加载目录权限">
          <Sk className="h-80 rounded-2xl" />
          <div className="space-y-3">
            <Sk className="h-14 rounded-2xl" />
            <Sk className="h-28 rounded-2xl" />
            <Sk className="h-28 rounded-2xl" />
          </div>
        </SkWrap>
      ) : tab === "dir" ? (
        <ByDir {...ctx} path={path} setPath={setPath} />
      ) : tab === "member" ? (
        <ByMember {...ctx} openDir={openDir} />
      ) : tab === "check" ? (
        <Check2 users={users} path={path} setPath={setPath} deps={[rules, gates]} />
      ) : (
        <Help />
      )}
    </div>
  );
}

type Ctx = {
  rules: Rule[];
  gates: Gate[];
  users: Me[];
  groups: Group[];
  act: (f: () => Promise<unknown>, msg: string) => Promise<void>;
  subjName: (r: { subject: string; subject_id: number | null }) => string | null;
};

/* ───────────────────────── 按目录 ───────────────────────── */

function ByDir({ rules, gates, users, groups, act, subjName, path, setPath }: Ctx & { path: string; setPath: (p: string) => void }) {
  const [picker, setPicker] = useState(false);
  const [filter, setFilter] = useState("");
  const here = norm(path);
  const parts = here.split("/").filter(Boolean);
  const configured = useMemo(() => {
    const m = new Map<string, { rules: number; gate: boolean }>();
    for (const r of rules) {
      const k = norm(r.path);
      m.set(k, { rules: (m.get(k)?.rules ?? 0) + 1, gate: m.get(k)?.gate ?? false });
    }
    for (const g of gates) {
      const k = norm(g.path);
      m.set(k, { rules: m.get(k)?.rules ?? 0, gate: true });
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, v]) => ({ path: p, ...v }));
  }, [rules, gates]);
  const shown = configured.filter((c) => !filter.trim() || c.path.toLowerCase().includes(filter.trim().toLowerCase()));
  const pg = usePaged(shown, 10, filter, "acl_dirs");
  // Stable order (member kind, then name): editing a rule re-creates it with a new id, so ordering by id would make the card jump.
  const subjKey = (r: Rule) => `${Object.keys(SUBJ).indexOf(r.subject)}|${subjName(r) ?? r.subject_id ?? ""}`;
  const hereRules = rules.filter((r) => norm(r.path) === here).sort((a, b) => subjKey(a).localeCompare(subjKey(b), "zh"));
  const inherited = rules.filter((r) => norm(r.path) !== here && (norm(r.path) === "/" || here.startsWith(norm(r.path) + "/")));
  const myGate = gates.find((g) => norm(g.path) === here);
  return (
    <div className="grid gap-4 lg:grid-cols-[17.5rem_minmax(0,1fr)]">
      <SectionPanel
        title="已配置目录"
        actions={
          <Button size="sm" onClick={() => setPicker(true)}>
            <FolderSearch className="size-3.5" /> 选择
          </Button>
        }
      >
        <Input ctl="sm" placeholder="筛选目录…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选目录" />
        <ul className="-mx-2 mt-2.5 space-y-0.5" data-testid="acl-configured">
          <li>
            <DirItem p="/" active={here === "/"} meta={configured.find((c) => c.path === "/")} onClick={() => setPath("/")} />
          </li>
          {pg.slice
            .filter((c) => c.path !== "/")
            .map((c) => (
              <li key={c.path}>
                <DirItem p={c.path} active={c.path === here} meta={c} onClick={() => setPath(c.path)} />
              </li>
            ))}
          {!configured.some((c) => c.path === here) && here !== "/" && (
            <li>
              <DirItem p={here} active meta={{ rules: 0, gate: false }} onClick={() => {}} fresh />
            </li>
          )}
        </ul>
        {shown.length > 10 && <Pager {...pg} unit="个" />}
      </SectionPanel>

      <div className="min-w-0 space-y-4">
        <SectionPanel>
          <nav aria-label="目录路径" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" data-testid="acl-crumbs">
            <button
              onClick={() => setPath("/")}
              className={cx("rounded-lg px-2 py-0.5 transition-colors hover:bg-hover", parts.length === 0 && "bg-accent-soft font-semibold text-accent")}
            >
              根目录
            </button>
            {parts.map((p, i) => (
              <span key={i} className="flex items-center gap-0.5">
                <ChevronRight className="size-3.5 text-faint" />
                <button
                  onClick={() => setPath("/" + parts.slice(0, i + 1).join("/"))}
                  className={cx(
                    "rounded-lg px-2 py-0.5 transition-colors hover:bg-hover",
                    i === parts.length - 1 && "bg-accent-soft font-semibold text-accent",
                  )}
                >
                  {p}
                </button>
              </span>
            ))}
            <span className="ml-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => go(`#/files${here === "/" ? "" : here}`)}>
                <FolderOpen className="size-3.5" /> 打开目录
              </Button>
            </span>
          </nav>
          {inherited.length > 0 && (
            <details className="mt-3 rounded-xl border border-dashed border-line-2 bg-surface-0 px-3 py-2 text-[13px]" data-testid="acl-inherited">
              <summary className="cursor-pointer text-xs text-fg-3">
                从上级目录继承了 <b className="text-fg">{inherited.length}</b> 条规则（本目录的规则在此基础上叠加或覆盖）
              </summary>
              <ul className="mt-2 space-y-1.5">
                {inherited.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => setPath(r.path)}
                      className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-3 hover:text-fg"
                    >
                      {norm(r.path)}
                    </button>
                    <span className="text-[12.5px] font-medium text-fg">
                      {SUBJ[r.subject]}
                      {subjName(r) ? `：${subjName(r)}` : ""}
                    </span>
                    <PresetBadge r={r} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </SectionPanel>

        <SectionPanel
          title={
            <span className="flex items-center gap-2">
              <span>成员规则</span>
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] font-normal text-fg-3">
                {here}
              </span>
            </span>
          }
          badge={
            hereRules.length > 0 ? (
              <StatusPill tone="neutral" dot={false}>
                {hereRules.length} 条规则
              </StatusPill>
            ) : undefined
          }
        >
          {hereRules.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line-2 bg-surface-0/70 p-4 text-center text-[13px] text-fg-3">
              本目录还没有单独规则，权限完全继承自上级。可在下方快速添加成员。
            </p>
          ) : (
            <ul className="space-y-2.5" data-testid="acl-matrix">
              {hereRules.map((r) => (
                <RuleCard key={`${r.subject}:${r.subject_id ?? ""}`} r={r} atRoot={here === "/"} name={subjName(r)} act={act} />
              ))}
            </ul>
          )}
          <AddRule here={here} users={users} groups={groups} act={act} />
        </SectionPanel>

        <GateCard here={here} myGate={myGate} act={act} />
      </div>
      <DirPicker allowRoot open={picker} title="选择目录" start={here} onClose={() => setPicker(false)} onPick={(d) => (setPicker(false), setPath(d))} />
    </div>
  );
}

function DirItem({ p, active, meta, onClick, fresh }: { p: string; active: boolean; meta?: { rules: number; gate: boolean }; onClick: () => void; fresh?: boolean }) {
  const name = p === "/" ? "根目录" : p.split("/").pop();
  return (
    <button
      type="button"
      onClick={onClick}
      data-acl-dir={p}
      className={cx(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
        active ? "bg-accent-soft font-medium text-accent" : "text-fg-2 hover:bg-hover hover:text-fg",
      )}
    >
      <FolderTree className="size-4 shrink-0 opacity-75" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{name}</span>
        {p !== "/" && <span className="block truncate font-mono text-[10.5px] text-fg-4">{p}</span>}
      </span>
      {fresh ? (
        <span className="text-[11px] text-fg-4">未配置</span>
      ) : (
        <>
          {meta?.gate && <Lock className="size-3.5 text-warn" aria-label="有访问门槛" />}
          {!!meta?.rules && (
            <span className="rounded-full bg-surface-2 px-1.5 text-[11px] text-fg-3 tabular-nums">{meta.rules}</span>
          )}
        </>
      )}
    </button>
  );
}

function PresetBadge({ r }: { r: { allow: string[]; deny: string[] } }) {
  const id = presetOf(r);
  const p = PRESETS.find((x) => x.id === id);
  const tone: StatusTone = id === "none" ? "danger" : id === "full" ? "ok" : id === "custom" ? "neutral" : "accent";
  return <StatusPill tone={tone}>{p?.label ?? "自定义"}</StatusPill>;
}

/** One member's permissions on this folder: preset dropdown + grouped summary + optional fine-tune. */
function RuleCard({ r, atRoot, name, act }: { r: Rule; atRoot: boolean; name: string | null; act: Ctx["act"] }) {
  const [open, setOpen] = useState(false);
  const preset = presetOf(r);
  const cats = PERM_CATEGORIES.map((c) => ({ ...c, perms: permsOf(c.id, atRoot ? PERMS : PATH_PERMS) })).filter((c) => c.perms.length);
  const subj = SUBJ_META[r.subject] ?? SUBJ_META.user;
  const replace = (allow: string[], deny: string[], msg = "已更新") =>
    act(async () => {
      if (allow.length || deny.length) await call("POST", "/api/acl/rules", { path: r.path, subject: r.subject, subject_id: r.subject_id, allow, deny });
      await call("DELETE", `/api/acl/rules/${r.id}`);
    }, msg);
  const setCell = (p: string, to: Cell) => {
    const allow = r.allow.filter((x) => x !== p),
      deny = r.deny.filter((x) => x !== p);
    if (to === "allow") allow.push(p);
    if (to === "deny") deny.push(p);
    return replace(allow, deny);
  };
  return (
    <li className="overflow-hidden rounded-xl border border-line-1 bg-surface-1 transition-colors hover:border-line-2" data-rule={r.id}>
      <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
        <span
          aria-hidden="true"
          style={{
            color: subj.color,
            backgroundColor: `color-mix(in oklab, ${subj.color} 13%, var(--surface-1))`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${subj.color} 20%, transparent)`,
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4"
        >
          {subj.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13.5px] font-semibold text-fg">{name ?? SUBJ[r.subject]}</span>
            <PresetBadge r={r} />
          </span>
          <span className="block text-[11.5px] text-fg-3">{SUBJ[r.subject]}</span>
        </span>
        <span className="ctl-sm flex items-center gap-1.5">
          <Select
            size="sm"
            value={preset}
            aria-label="权限预设"
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value);
              if (p) void replace(p.allow, p.deny, `已设为「${p.label}」`);
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} — {p.desc}
              </option>
            ))}
            {preset === "custom" && <option value="custom">自定义</option>}
          </Select>
          <Button size="sm" variant={open ? "outline" : "ghost"} onClick={() => setOpen(!open)} aria-expanded={open} data-acl-tune>
            <SlidersHorizontal className="size-3.5" /> 细调
          </Button>
          <IconButton size="sm" label="移除此成员的规则" onClick={() => act(() => call("DELETE", `/api/acl/rules/${r.id}`), "规则已删除")}>
            <Trash2 />
          </IconButton>
        </span>
      </div>

      {/* Compact grouped capability summary strip */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line-1 bg-surface-0/65 px-3.5 py-2 text-[12px]">
        {cats.map((c) => {
          const al = c.perms.filter((p) => r.allow.includes(p));
          const de = c.perms.filter((p) => r.deny.includes(p));
          const meta = PERM_CAT_META[c.id];
          const CatIcon = meta.icon;
          const detailTitle = [
            al.length ? `允许：${al.map((p) => PERM_LABEL[p]).join("、")}` : "",
            de.length ? `拒绝：${de.map((p) => PERM_LABEL[p]).join("、")}` : "",
          ]
            .filter(Boolean)
            .join("；") || `${c.label}：继承上级`;

          return (
            <span
              key={c.id}
              data-acl-cat={c.id}
              title={detailTitle}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-1 bg-surface-1 px-2 py-0.5"
            >
              <CatIcon className="size-3 text-fg-4" aria-hidden="true" />
              <span className="font-medium text-fg-3">{meta.shortLabel}</span>
              {al.length === 0 && de.length === 0 ? (
                <span className="text-fg-4">继承</span>
              ) : (
                <>
                  {al.length === c.perms.length && de.length === 0 ? (
                    <span className="font-medium text-ok">全部允许</span>
                  ) : al.length > 0 ? (
                    <span className="font-medium text-ok tabular-nums">+{al.length}</span>
                  ) : null}
                  {de.length > 0 && <span className="font-medium text-danger tabular-nums">−{de.length}</span>}
                </>
              )}
            </span>
          );
        })}
      </div>

      {open && (
        <div className="grid gap-3 border-t border-line-1 bg-surface-0 px-3.5 py-3 sm:grid-cols-2" data-acl-fine>
          {cats.map((c) => {
            const meta = PERM_CAT_META[c.id];
            const CatIcon = meta.icon;
            return (
              <fieldset key={c.id} className="space-y-1.5 rounded-xl border border-line-1 bg-surface-1 p-2.5">
                <legend className="mb-1 flex items-center gap-1.5 px-1 text-[11.5px] font-semibold tracking-wide text-fg-2">
                  <CatIcon className="size-3.5" style={{ color: meta.color }} aria-hidden="true" />
                  <span>{c.label}</span>
                </legend>
                {c.perms.map((p) => {
                  const PIcon = PERM_ICON[p] ?? Shield;
                  return (
                    <div key={p} className="flex items-center justify-between gap-2 text-[12.5px]">
                      <span className="inline-flex min-w-0 items-center gap-1.5" title={PERM_HINT[p]}>
                        <PIcon className="size-3.5 shrink-0 text-fg-4" aria-hidden="true" />
                        <span className="font-medium text-fg">{PERM_LABEL[p]}</span>
                        <span className="truncate text-[11px] text-fg-4 max-sm:hidden">{PERM_HINT[p]}</span>
                      </span>
                      <Tri state={cellOf(r, p)} label={PERM_LABEL[p]} onChange={(to) => setCell(p, to)} />
                    </div>
                  );
                })}
              </fieldset>
            );
          })}
        </div>
      )}
    </li>
  );
}

function Tri({ state, label, onChange }: { state: Cell; label: string; onChange: (c: Cell) => void }) {
  return (
    <span className="inline-flex shrink-0 rounded-lg border border-line-2 bg-surface-0 p-0.5" role="radiogroup" aria-label={label}>
      {(["none", "allow", "deny"] as Cell[]).map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={state === c}
          data-state={state === c ? c : undefined}
          onClick={() => state !== c && onChange(c)}
          className={cx(
            "flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium transition-colors",
            state === c
              ? c === "allow"
                ? "bg-ok-soft text-ok"
                : c === "deny"
                  ? "bg-danger-soft text-danger"
                  : "bg-surface-1 text-fg shadow-elev-1"
              : "text-fg-4 hover:text-fg",
          )}
        >
          {c === "allow" ? <Check className="size-3" /> : c === "deny" ? <X className="size-3" /> : <Minus className="size-3" />}
          {CELL_LABEL[c]}
        </button>
      ))}
    </span>
  );
}

function AddRule({ here, users, groups, act }: { here: string; users: Me[]; groups: Group[]; act: Ctx["act"] }) {
  const [subject, setSubject] = useState("user");
  const [sid, setSid] = useState("");
  const [preset, setPreset] = useState("ro");
  const [customAllow, setCustomAllow] = useState<string[]>(["read", "download"]);
  const allowedScope = here === "/" ? PERMS : PATH_PERMS;

  const add = () => {
    if ((subject === "user" || subject === "group") && !sid) {
      return toast.err(subject === "user" ? "请先选择用户" : "请先选择用户组");
    }
    if (preset === "custom") {
      const allow = customAllow.filter((x) => allowedScope.includes(x));
      if (!allow.length) return toast.err("请至少选择一项权限");
      return act(
        () => call("POST", "/api/acl/rules", { path: here, subject, subject_id: sid ? Number(sid) : null, allow, deny: [] }),
        "规则已添加",
      ).then(() => setSid(""));
    }
    const p = PRESETS.find((x) => x.id === preset)!;
    return act(
      () => call("POST", "/api/acl/rules", { path: here, subject, subject_id: sid ? Number(sid) : null, allow: p.allow, deny: p.deny }),
      "规则已添加",
    ).then(() => setSid(""));
  };

  return (
    <div className="mt-3.5 space-y-3 rounded-xl border border-dashed border-line-2 bg-surface-0 p-3.5" data-testid="acl-add">
      <div className="ctl-sm flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-fg">添加成员</span>
        <Select size="sm" value={subject} onChange={(e) => (setSubject(e.target.value), setSid(""))} aria-label="对象类型">
          {Object.entries(SUBJ).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        {subject === "user" && (
          <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户">
            <option value="">选择用户…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </Select>
        )}
        {subject === "group" && (
          <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户组">
            <option value="">选择用户组…</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        )}
        <span className="ctl-label">权限</span>
        <Select size="sm" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="新规则预设">
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} — {p.desc}
            </option>
          ))}
          <option value="custom">自定义 — 勾选具体权限矩阵</option>
        </Select>
        <Button size="sm" variant="primary" onClick={add} data-acl-add-btn>
          <Plus className="size-3.5" /> 添加
        </Button>
      </div>

      <Disclosure open={preset === "custom"}>
        <div className="pt-1">
          <PermMatrix compact only={allowedScope} value={customAllow} onChange={setCustomAllow} />
        </div>
      </Disclosure>
    </div>
  );
}

function GateCard({ here, myGate, act }: { here: string; myGate?: Gate; act: Ctx["act"] }) {
  const [gate, setGate] = useState<{ modes: string[]; password: string }>({ modes: [], password: "" });
  useEffect(() => setGate({ modes: myGate?.modes ?? [], password: "" }), [here, myGate?.modes.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <SectionPanel
      title="进入方式（门槛）"
      icon={<Lock />}
      hint="门槛独立于权限规则。例如设置「需要密码」后，即使有读取权限，进入该目录前也需先输入目录密码。"
      badge={myGate?.modes.length ? <StatusPill tone="warn">已启用门槛</StatusPill> : undefined}
    >
      <div className="grid gap-2 sm:grid-cols-3">
        {Object.entries(GATE).map(([k, v]) => {
          const on = gate.modes.includes(k);
          return (
            <button
              key={k}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => setGate({ ...gate, modes: on ? gate.modes.filter((x) => x !== k) : [...gate.modes, k] })}
              className={cx(
                "rounded-xl border px-3 py-2.5 text-left transition-all active:scale-[0.985]",
                on
                  ? "border-accent/45 bg-accent-soft/75"
                  : "border-line-1 bg-surface-0/75 hover:border-line-2 hover:bg-surface-2/60",
              )}
            >
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                {on ? <Check className="size-4 text-accent" /> : <span className="size-4 rounded border border-line-2 bg-surface-1" />}
                {v.label}
              </span>
              <span className="mt-0.5 block text-[11.5px] text-fg-3">{v.hint}</span>
            </button>
          );
        })}
      </div>
      {gate.modes.includes("password") && (
        <div className="mt-3">
          <Field label="目录密码" hint={myGate?.has_password ? "已设置；留空保持不变" : undefined}>
            <Input type="password" autoComplete="new-password" value={gate.password} onChange={(e) => setGate({ ...gate, password: e.target.value })} />
          </Field>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => act(() => call("PUT", "/api/acl/gates", { path: here, modes: gate.modes, password: gate.password || null }), gate.modes.length ? "已保存" : "已移除门槛")}
        >
          保存门槛
        </Button>
        {myGate && (
          <Button size="sm" onClick={() => act(() => call("PUT", "/api/acl/gates", { path: here, modes: [] }), "已移除门槛")}>
            移除
          </Button>
        )}
      </div>
    </SectionPanel>
  );
}

/* ───────────────────────── 按成员 ───────────────────────── */

function ByMember({ rules, users, groups, act, openDir }: Ctx & { openDir: (p: string) => void }) {
  const [kind, setKind] = useState("user");
  const [sid, setSid] = useState(() => String(users[0]?.id ?? ""));
  useEffect(() => {
    if (kind === "user" && !sid && users[0]) setSid(String(users[0].id));
  }, [users]); // eslint-disable-line react-hooks/exhaustive-deps
  const user = kind === "user" ? users.find((u) => String(u.id) === sid) : undefined;
  const mine = rules
    .filter((r) => {
      if (kind === "user") return (r.subject === "user" && String(r.subject_id) === sid) || (r.subject === "group" && !!user?.groups.some((g) => g.id === r.subject_id)) || r.subject === "logged_in";
      if (kind === "group") return r.subject === "group" && String(r.subject_id) === sid;
      return r.subject === kind;
    })
    .sort((a, b) => norm(a.path).localeCompare(norm(b.path)));
  const pg = usePaged(mine, 20, `${kind}:${sid}`, "acl_member");
  const via = (r: Rule) => (r.subject === "user" ? "本人" : r.subject === "group" ? `用户组：${groups.find((g) => g.id === r.subject_id)?.name ?? r.subject_id}` : SUBJ[r.subject]);
  return (
    <SectionPanel>
      <div className="ctl-sm mb-3 flex flex-wrap items-center gap-2" data-acl-member-pick>
        <span className="ctl-label">查看</span>
        <Select
          size="sm"
          value={kind}
          onChange={(e) => (
            setKind(e.target.value),
            setSid(e.target.value === "user" ? String(users[0]?.id ?? "") : e.target.value === "group" ? String(groups[0]?.id ?? "") : "")
          )}
          aria-label="成员类型"
        >
          {Object.entries(SUBJ).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        {kind === "user" && (
          <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户">
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}（{u.role}）
              </option>
            ))}
          </Select>
        )}
        {kind === "group" && (
          <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户组">
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        )}
        {user && (
          <span className="text-xs text-fg-3">
            包含本人、用户组（{user.groups.map((g) => g.name).join("、") || "无"}）及「所有登录用户」规则
            {user.role === "admin" && "；管理员不受目录规则限制"}
          </span>
        )}
      </div>
      {mine.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-2 bg-surface-0/70 p-6 text-center text-[13px] text-fg-3">没有针对该成员的目录规则</p>
      ) : (
        <ul className="divide-y divide-line-1 overflow-hidden rounded-xl border border-line-1" data-acl-member-rules>
          {pg.slice.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2.5 bg-surface-1 px-3.5 py-2.5 text-[13px]">
              <button
                className="min-w-0 flex-1 truncate text-left font-mono text-fg hover:text-accent hover:underline"
                onClick={() => openDir(norm(r.path))}
                title="在「按目录」中编辑"
              >
                {norm(r.path) === "/" ? "/（根目录）" : norm(r.path)}
              </button>
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-fg-3">{via(r)}</span>
              <PresetBadge r={r} />
              <span
                className="text-[11.5px] text-fg-3 tabular-nums"
                title={[
                  r.allow.length ? `允许：${r.allow.map((p) => PERM_LABEL[p] ?? p).join("、")}` : "",
                  r.deny.length ? `拒绝：${r.deny.map((p) => PERM_LABEL[p] ?? p).join("、")}` : "",
                ]
                  .filter(Boolean)
                  .join("；")}
              >
                {r.allow.length > 0 && <span className="text-ok">+{r.allow.length} 允许</span>}
                {r.allow.length > 0 && r.deny.length > 0 && " · "}
                {r.deny.length > 0 && <span className="text-danger">−{r.deny.length} 拒绝</span>}
              </span>
              <IconButton size="sm" label="删除规则" onClick={() => act(() => call("DELETE", `/api/acl/rules/${r.id}`), "规则已删除")}>
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Pager {...pg} />
    </SectionPanel>
  );
}

/* ───────────────────────── 权限检查 ───────────────────────── */

function Check2({ users, path, setPath, deps }: { users: Me[]; path: string; setPath: (p: string) => void; deps: unknown[] }) {
  const [who, setWho] = useState(() => String(users.find((u) => u.role !== "admin")?.id ?? 0));
  const [picker, setPicker] = useState(false);
  const [eff, setEff] = useState<Effective | null>(null);
  const here = norm(path);
  useEffect(() => {
    call<Effective>("GET", `/api/acl/effective?path=${encodeURIComponent(here)}&user_id=${who}`)
      .then(setEff)
      .catch((e) => (setEff(null), toast.err(errMsg(e))));
  }, [here, who, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const SUBJ2: Record<string, string> = { ...SUBJ, role: "角色" };
  return (
    <SectionPanel title="有效权限模拟检查" icon={<ShieldCheck />}>
      <div className="ctl-sm mb-4 flex flex-wrap items-center gap-2">
        <span className="ctl-label">成员</span>
        <Select size="sm" value={who} onChange={(e) => setWho(e.target.value)} aria-label="查看对象">
          <option value="0">匿名访客</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}（{u.role}）
            </option>
          ))}
        </Select>
        <span className="ctl-label">目录</span>
        <button
          type="button"
          onClick={() => setPicker(true)}
          className="flex h-8 max-w-80 items-center gap-1.5 truncate rounded-lg border border-line-2 bg-surface-0 px-2.5 font-mono text-[12.5px] text-fg hover:border-line-3 hover:bg-surface-2"
        >
          <FolderSearch className="size-3.5 shrink-0 text-fg-3" />
          {here}
        </button>
      </div>
      {!eff ? (
        <SkWrap className="space-y-2">
          <Sk className="h-6 w-2/3" />
          <Sk className="h-6 w-1/2" />
          <Sk className="h-20" />
        </SkWrap>
      ) : (
        <div className="space-y-3.5 text-[13px]" data-testid="acl-effective">
          <div className="grid gap-2.5 sm:grid-cols-2">
            {PERM_CATEGORIES.map((c) => {
              const ps = permsOf(c.id);
              const got = ps.filter((p) => eff.permissions.includes(p));
              const meta = PERM_CAT_META[c.id];
              const CatIcon = meta.icon;
              return (
                <div key={c.id} className="rounded-xl border border-line-1 bg-surface-0/75 px-3 py-2.5">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-fg-2">
                      <CatIcon className="size-3.5" style={{ color: meta.color }} aria-hidden="true" />
                      {c.label}
                    </span>
                    <StatusPill tone={got.length === ps.length ? "ok" : got.length > 0 ? "accent" : "neutral"} dot={false} className="px-2 py-0 text-[11px] tabular-nums">
                      {got.length}/{ps.length}
                    </StatusPill>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {ps.map((p) => {
                      const on = eff.permissions.includes(p);
                      return (
                        <span
                          key={p}
                          className={cx(
                            "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11.5px] font-medium",
                            on ? "bg-ok-soft text-ok" : "bg-surface-2 text-fg-4 line-through decoration-fg-4/50",
                          )}
                        >
                          {on ? <Check className="size-3" /> : <X className="size-3" />}
                          {PERM_LABEL[p]}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-fg-3">{eff.reason}</p>
          {eff.gate && (
            <p className="flex flex-wrap items-center gap-2">
              <span>
                门槛 <span className="font-mono">{eff.gate.path}</span>：{eff.gate.modes.map((m) => GATE[m]?.label ?? m).join(" / ")}
              </span>
              <StatusPill tone={eff.gate.passed ? "ok" : "danger"}>{eff.gate.passed ? "已通过" : "未通过"}</StatusPill>
            </p>
          )}
          {eff.trace.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-3">推导过程（从根目录到当前目录，依次叠加）</p>
              <ol className="space-y-1.5 border-l-2 border-line-2 pl-3">
                {eff.trace.map((t, i) => (
                  <li key={i}>
                    <span className="font-mono text-xs">{t.path}</span> · {SUBJ2[t.subject] ?? t.subject}
                    {t.allow.length > 0 && <span className="text-ok"> +{t.allow.map((p) => PERM_LABEL[p]).join("、")}</span>}
                    {t.deny.length > 0 && <span className="text-danger"> −{t.deny.map((p) => PERM_LABEL[p]).join("、")}</span>}
                    <span className="text-fg-4"> ⇒ {t.after.map((p) => PERM_LABEL[p]).join("、") || "无"}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="text-[11.5px] text-fg-4">通过「角色」分配的权限在根目录生效（推导中显示为 / 上的规则）。</p>
        </div>
      )}
      <DirPicker allowRoot open={picker} title="选择目录" start={here} onClose={() => setPicker(false)} onPick={(d) => (setPicker(false), setPath(d))} />
    </SectionPanel>
  );
}

/* ───────────────────────── 使用说明 ───────────────────────── */

function Help() {
  const steps = [
    { t: "1. 选目录", d: "在「按目录」左侧选择或搜索一个目录（也可以点「选择」从文件树挑）。" },
    { t: "2. 加成员", d: "给用户、用户组、所有登录用户或匿名访客添加规则，可直接选预设或自定义勾选权限矩阵。" },
    { t: "3. 需要时细调", d: "点「细调」逐项设置：继承（不改变）、允许、拒绝。改动立即生效。" },
    { t: "4. 检查结果", d: "到「权限检查」选成员和目录，查看最终有效权限与推导链路。" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-acl-help>
      <Card title="四步完成配置">
        <ol className="space-y-3">
          {steps.map((s) => (
            <li key={s.t}>
              <p className="text-[13.5px] font-medium">{s.t}</p>
              <p className="text-[12.5px] text-fg-3">{s.d}</p>
            </li>
          ))}
        </ol>
      </Card>
      <Card title="规则如何生效">
        <ul className="list-disc space-y-2 pl-5 text-[13px] text-fg-2">
          <li>
            <b className="text-fg">继承</b>：下级目录自动继承上级的规则；在下级再写一条即可覆盖。
          </li>
          <li>
            <b className="text-fg">越深越优先</b>：例如 <code>/项目</code> 只读、<code>/项目/草稿</code> 读写，则在草稿里可以写。
          </li>
          <li>
            <b className="text-fg">同一目录内</b>按 匿名访客 → 所有登录用户 → 用户组 → 用户 的顺序叠加，越具体的越后生效。
          </li>
          <li>
            <b className="text-fg">允许 / 拒绝</b>：允许会加上权限，拒绝会去掉权限；没设置（继承）的项保持之前的结果。
          </li>
          <li>
            <b className="text-fg">管理员</b>（管理员级别角色）不受目录权限限制。
          </li>
          <li>
            <b className="text-fg">门槛</b>与权限独立：例如设置「需要密码」后，有权限的人也需要先输入目录密码。
          </li>
        </ul>
      </Card>
      <Card title="预设包含的权限" className="lg:col-span-2">
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {PRESETS.map((p) => (
            <div key={p.id} className="rounded-xl border border-line-1 bg-surface-0/75 px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13.5px] font-semibold text-fg">{p.label}</p>
                <StatusPill tone={p.id === "none" ? "danger" : p.id === "full" ? "ok" : "accent"} dot={false} className="px-2 py-0 text-[10.5px]">
                  {p.allow.length > 0 ? `${p.allow.length} 允许` : `${p.deny.length} 拒绝`}
                </StatusPill>
              </div>
              <p className="mt-0.5 mb-2 text-[11.5px] text-fg-3">{p.desc}</p>
              <div className="flex flex-wrap gap-1 text-[11.5px]">
                {p.allow.map((x) => (
                  <span key={x} className="rounded bg-ok-soft px-1.5 py-0.5 text-ok">
                    {PERM_LABEL[x]}
                  </span>
                ))}
                {p.deny.map((x) => (
                  <span key={x} className="rounded bg-danger-soft px-1.5 py-0.5 text-danger line-through">
                    {PERM_LABEL[x]}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
