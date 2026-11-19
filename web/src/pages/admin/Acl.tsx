// Directory permissions — DEPTAI-485 r6 #5 redesign.
// References (Mobbin): Twenty "Roles" (tabs Permissions / Assignment / Settings + grouped permission checklist),
// Descript & Base44 member tables (one row per member with a role dropdown), Toggl role picker (preset + description).
// Sub-tabs:
//   按目录   — configured-folder list on the left; on the right one card per member (who) with a preset dropdown
//              (只读 / 读写 / 完全控制 / 禁止访问 / 自定义), a grouped summary and an optional per-permission fine-tune.
//   按成员   — every rule that applies to a user / group / everyone, across folders.
//   权限检查 — pick a person + folder, see the effective permissions and how they were derived.
//   使用说明 — how inheritance and priority work.
import { useEffect, useMemo, useState } from "react";
import { BookOpen, Check, ChevronRight, FolderSearch, FolderTree, Globe2, Lock, Minus, Plus, ShieldCheck, SlidersHorizontal, Trash2, User, Users, X } from "lucide-react";
import { call, PERM_CATEGORIES, PERM_HINT, PERM_LABEL, PERMS, PATH_PERMS, permsOf, type Effective, type Gate, type Group, type Me, type Rule } from "../../lib/api";
import { go } from "../../lib/router";
import { cx, errMsg } from "../../lib/util";
import { DirPicker } from "../../components/DirPicker";
import { Sk, SkWrap } from "../../ui/r6";
import { Badge, Button, Card, Field, IconButton, Input, PageHeader, Pager, Select, Tabs, toast, usePaged } from "../../ui/ui";

const SUBJ: Record<string, string> = { logged_in: "所有登录用户", anonymous: "匿名访客", group: "用户组", user: "用户" };
const SUBJ_ICON: Record<string, React.ReactNode> = { logged_in: <Users />, anonymous: <Globe2 />, group: <Users />, user: <User /> };
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
      const [r, g, u, gr] = await Promise.all([call<Rule[]>("GET", "/api/acl/rules"), call<Gate[]>("GET", "/api/acl/gates"), call<Me[]>("GET", "/api/admin/users"), call<Group[]>("GET", "/api/admin/groups")]);
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
  const subjName = (r: { subject: string; subject_id: number | null }) => (r.subject === "user" ? users.find((u) => u.id === r.subject_id)?.username : r.subject === "group" ? groups.find((g) => g.id === r.subject_id)?.name : null) ?? null;
  const ctx = { rules: rules ?? [], gates, users, groups, act, subjName };
  const openDir = (p: string) => (setPath(p), setTab("dir"));
  return (
    <div className="space-y-4" data-acl-page>
      <PageHeader title="目录权限" desc="决定「谁」在「哪个目录」能做什么。下级目录自动继承上级，越深的规则优先" />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { id: "dir", label: "按目录", icon: <FolderTree className="size-4" /> },
        { id: "member", label: "按成员", icon: <Users className="size-4" /> },
        { id: "check", label: "权限检查", icon: <ShieldCheck className="size-4" /> },
        { id: "help", label: "使用说明", icon: <BookOpen className="size-4" /> },
      ]} />
      {!rules ? (
        <SkWrap className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]" label="正在加载目录权限"><Sk className="h-80 rounded-2xl" /><div className="space-y-3"><Sk className="h-14 rounded-2xl" /><Sk className="h-28 rounded-2xl" /><Sk className="h-28 rounded-2xl" /></div></SkWrap>
      ) : tab === "dir" ? <ByDir {...ctx} path={path} setPath={setPath} />
        : tab === "member" ? <ByMember {...ctx} openDir={openDir} />
        : tab === "check" ? <Check2 users={users} path={path} setPath={setPath} deps={[rules, gates]} />
        : <Help />}
    </div>
  );
}

type Ctx = { rules: Rule[]; gates: Gate[]; users: Me[]; groups: Group[]; act: (f: () => Promise<unknown>, msg: string) => Promise<void>; subjName: (r: { subject: string; subject_id: number | null }) => string | null };

/* ───────────────────────── 按目录 ───────────────────────── */

function ByDir({ rules, gates, users, groups, act, subjName, path, setPath }: Ctx & { path: string; setPath: (p: string) => void }) {
  const [picker, setPicker] = useState(false);
  const [filter, setFilter] = useState("");
  const here = norm(path);
  const parts = here.split("/").filter(Boolean);
  const configured = useMemo(() => {
    const m = new Map<string, { rules: number; gate: boolean }>();
    for (const r of rules) { const k = norm(r.path); m.set(k, { rules: (m.get(k)?.rules ?? 0) + 1, gate: m.get(k)?.gate ?? false }); }
    for (const g of gates) { const k = norm(g.path); m.set(k, { rules: m.get(k)?.rules ?? 0, gate: true }); }
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
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Card title="已配置的目录" actions={<Button size="sm" onClick={() => setPicker(true)}><FolderSearch className="size-4" /> 选择目录</Button>}>
        <Input ctl="sm" placeholder="筛选目录…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选目录" />
        <ul className="-mx-2 mt-2 space-y-0.5" data-testid="acl-configured">
          <li><DirItem p="/" active={here === "/"} meta={configured.find((c) => c.path === "/")} onClick={() => setPath("/")} /></li>
          {pg.slice.filter((c) => c.path !== "/").map((c) => <li key={c.path}><DirItem p={c.path} active={c.path === here} meta={c} onClick={() => setPath(c.path)} /></li>)}
          {!configured.some((c) => c.path === here) && here !== "/" && <li><DirItem p={here} active meta={{ rules: 0, gate: false }} onClick={() => {}} fresh /></li>}
        </ul>
        {shown.length > 10 && <Pager {...pg} unit="个" />}
      </Card>

      <div className="min-w-0 space-y-4">
        <Card>
          <nav aria-label="目录路径" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm" data-testid="acl-crumbs">
            <button onClick={() => setPath("/")} className={cx("rounded-md px-1.5 py-0.5 hover:bg-hover", parts.length === 0 && "bg-accent-soft font-semibold text-accent")}>根目录</button>
            {parts.map((p, i) => (
              <span key={i} className="flex items-center gap-0.5"><ChevronRight className="size-3.5 text-faint" />
                <button onClick={() => setPath("/" + parts.slice(0, i + 1).join("/"))} className={cx("rounded-md px-1.5 py-0.5 hover:bg-hover", i === parts.length - 1 && "bg-accent-soft font-semibold text-accent")}>{p}</button>
              </span>
            ))}
            <span className="ml-auto flex gap-1"><Button size="sm" variant="ghost" onClick={() => go(`#/files${here === "/" ? "" : here}`)}>在文件页打开</Button></span>
          </nav>
          {inherited.length > 0 && (
            <details className="mt-3 rounded-xl border border-dashed border-line bg-panel-2 px-3 py-2 text-[13px]" data-testid="acl-inherited">
              <summary className="cursor-pointer text-xs text-muted">从上级目录继承了 <b className="text-fg">{inherited.length}</b> 条规则（本目录的规则在此基础上叠加或覆盖）</summary>
              <ul className="mt-2 space-y-1.5">
                {inherited.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-1.5">
                    <button onClick={() => setPath(r.path)} className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-fg">{norm(r.path)}</button>
                    <span className="text-[12.5px] font-medium">{SUBJ[r.subject]}{subjName(r) ? `：${subjName(r)}` : ""}</span>
                    <PresetBadge r={r} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2">谁可以访问 <span className="font-mono text-xs font-normal text-muted">{here}</span></span>}>
          {hereRules.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">本目录还没有自己的规则，权限完全继承自上级。在下方添加成员。</p>
          ) : (
            <ul className="space-y-2" data-testid="acl-matrix">
              {hereRules.map((r) => <RuleCard key={`${r.subject}:${r.subject_id ?? ""}`} r={r} atRoot={here === "/"} name={subjName(r)} act={act} />)}
            </ul>
          )}
          <AddRule here={here} users={users} groups={groups} act={act} />
        </Card>

        <GateCard here={here} myGate={myGate} act={act} />
      </div>
      <DirPicker allowRoot open={picker} title="选择目录" start={here} onClose={() => setPicker(false)} onPick={(d) => (setPicker(false), setPath(d))} />
    </div>
  );
}

function DirItem({ p, active, meta, onClick, fresh }: { p: string; active: boolean; meta?: { rules: number; gate: boolean }; onClick: () => void; fresh?: boolean }) {
  const name = p === "/" ? "根目录" : p.split("/").pop();
  return (
    <button type="button" onClick={onClick} data-acl-dir={p} className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", active ? "bg-accent-soft text-accent" : "hover:bg-hover")}>
      <FolderTree className="size-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1"><span className="block truncate font-medium">{name}</span>{p !== "/" && <span className="block truncate font-mono text-[10.5px] text-faint">{p}</span>}</span>
      {fresh ? <span className="text-[11px] text-faint">未配置</span> : <>
        {meta?.gate && <Lock className="size-3.5 text-warn" aria-label="有访问门槛" />}
        {!!meta?.rules && <span className="rounded-full bg-hover px-1.5 text-[11px] tabular-nums text-muted">{meta.rules}</span>}
      </>}
    </button>
  );
}

function PresetBadge({ r }: { r: { allow: string[]; deny: string[] } }) {
  const id = presetOf(r);
  const p = PRESETS.find((x) => x.id === id);
  return <Badge tone={id === "none" ? "danger" : id === "custom" ? "neutral" : "accent"}>{p?.label ?? "自定义"}</Badge>;
}

/** One member's permissions on this folder: preset dropdown + grouped summary + optional fine-tune. */
function RuleCard({ r, atRoot, name, act }: { r: Rule; atRoot: boolean; name: string | null; act: Ctx["act"] }) {
  const [open, setOpen] = useState(false);
  const preset = presetOf(r);
  const cats = PERM_CATEGORIES.map((c) => ({ ...c, perms: permsOf(c.id, atRoot ? PERMS : PATH_PERMS) })).filter((c) => c.perms.length);
  const replace = (allow: string[], deny: string[], msg = "已更新") =>
    act(async () => {
      if (allow.length || deny.length) await call("POST", "/api/acl/rules", { path: r.path, subject: r.subject, subject_id: r.subject_id, allow, deny });
      await call("DELETE", `/api/acl/rules/${r.id}`);
    }, msg);
  const setCell = (p: string, to: Cell) => {
    const allow = r.allow.filter((x) => x !== p), deny = r.deny.filter((x) => x !== p);
    if (to === "allow") allow.push(p);
    if (to === "deny") deny.push(p);
    return replace(allow, deny);
  };
  return (
    <li className="rounded-xl border border-line" data-rule={r.id}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent [&>svg]:size-4">{SUBJ_ICON[r.subject]}</span>
        <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{name ?? SUBJ[r.subject]}</span><span className="block text-[11px] text-muted">{SUBJ[r.subject]}</span></span>
        <span className="ctl-sm flex items-center gap-1.5">
          <Select size="sm" value={preset} aria-label="权限预设" onChange={(e) => { const p = PRESETS.find((x) => x.id === e.target.value); if (p) void replace(p.allow, p.deny, `已设为「${p.label}」`); }}>
            {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label} — {p.desc}</option>)}
            {preset === "custom" && <option value="custom">自定义</option>}
          </Select>
          <Button size="sm" variant={open ? "outline" : "ghost"} onClick={() => setOpen(!open)} aria-expanded={open} data-acl-tune><SlidersHorizontal className="size-3.5" /> 细调</Button>
          <IconButton size="sm" label="移除此成员的规则" onClick={() => act(() => call("DELETE", `/api/acl/rules/${r.id}`), "规则已删除")}><Trash2 /></IconButton>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-3 py-2 text-[12px]">
        {cats.map((c) => {
          const al = c.perms.filter((p) => r.allow.includes(p)), de = c.perms.filter((p) => r.deny.includes(p));
          return (
            <span key={c.id} className="flex flex-wrap items-center gap-1" data-acl-cat={c.id}>
              <span className="text-faint">{c.label}</span>
              {al.length === 0 && de.length === 0 ? <span className="text-faint">继承</span> : al.length === c.perms.length ? <span className="text-ok">全部允许</span> : null}
              {al.length > 0 && al.length < c.perms.length && al.map((p) => <span key={p} className="rounded bg-ok/10 px-1 text-ok">{PERM_LABEL[p]}</span>)}
              {de.map((p) => <span key={p} className="rounded bg-danger/10 px-1 text-danger line-through">{PERM_LABEL[p]}</span>)}
            </span>
          );
        })}
      </div>
      {open && (
        <div className="grid gap-3 border-t border-line bg-panel-2 px-3 py-3 sm:grid-cols-2" data-acl-fine>
          {cats.map((c) => (
            <fieldset key={c.id} className="space-y-1">
              <legend className="mb-1 text-[11px] font-semibold tracking-wider text-muted">{c.label}</legend>
              {c.perms.map((p) => (
                <div key={p} className="flex items-center justify-between gap-2 text-[12.5px]">
                  <span title={PERM_HINT[p]}>{PERM_LABEL[p]}<span className="ml-1.5 text-[11px] text-faint max-sm:hidden">{PERM_HINT[p]}</span></span>
                  <Tri state={cellOf(r, p)} label={PERM_LABEL[p]} onChange={(to) => setCell(p, to)} />
                </div>
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </li>
  );
}

function Tri({ state, label, onChange }: { state: Cell; label: string; onChange: (c: Cell) => void }) {
  return (
    <span className="inline-flex shrink-0 rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label={label}>
      {(["none", "allow", "deny"] as Cell[]).map((c) => (
        <button key={c} type="button" role="radio" aria-checked={state === c} data-state={state === c ? c : undefined} onClick={() => state !== c && onChange(c)}
          className={cx("flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] transition", state === c ? (c === "allow" ? "bg-ok/15 text-ok" : c === "deny" ? "bg-danger/15 text-danger" : "bg-active text-fg") : "text-faint hover:text-fg")}>
          {c === "allow" ? <Check className="size-3" /> : c === "deny" ? <X className="size-3" /> : <Minus className="size-3" />}{CELL_LABEL[c]}
        </button>
      ))}
    </span>
  );
}

function AddRule({ here, users, groups, act }: { here: string; users: Me[]; groups: Group[]; act: Ctx["act"] }) {
  const [subject, setSubject] = useState("user");
  const [sid, setSid] = useState("");
  const [preset, setPreset] = useState("ro");
  const add = () => {
    if ((subject === "user" || subject === "group") && !sid) return toast.err(subject === "user" ? "请先选择用户" : "请先选择用户组");
    const p = PRESETS.find((x) => x.id === preset)!;
    return act(() => call("POST", "/api/acl/rules", { path: here, subject, subject_id: sid ? Number(sid) : null, allow: p.allow, deny: p.deny }), "规则已添加").then(() => setSid(""));
  };
  return (
    <div className="ctl-sm mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line bg-panel-2 p-3" data-testid="acl-add">
      <span className="text-[13px] font-medium">添加成员</span>
      <Select size="sm" value={subject} onChange={(e) => (setSubject(e.target.value), setSid(""))} aria-label="对象类型">
        {Object.entries(SUBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </Select>
      {subject === "user" && <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户"><option value="">选择用户…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}</Select>}
      {subject === "group" && <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户组"><option value="">选择用户组…</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
      <span className="ctl-label">权限</span>
      <Select size="sm" value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="新规则预设">{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label} — {p.desc}</option>)}</Select>
      <Button size="sm" variant="primary" onClick={add} data-acl-add-btn><Plus className="size-3.5" /> 添加</Button>
    </div>
  );
}

function GateCard({ here, myGate, act }: { here: string; myGate?: Gate; act: Ctx["act"] }) {
  const [gate, setGate] = useState<{ modes: string[]; password: string }>({ modes: [], password: "" });
  useEffect(() => setGate({ modes: myGate?.modes ?? [], password: "" }), [here, myGate?.modes.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title={<span className="flex items-center gap-2"><Lock className="size-4" /> 进入方式（门槛）</span>} actions={<span className="text-xs text-muted">在权限之外，额外限制如何进入此目录</span>}>
      <div className="grid gap-2 sm:grid-cols-3">
        {Object.entries(GATE).map(([k, v]) => {
          const on = gate.modes.includes(k);
          return (
            <button key={k} type="button" role="checkbox" aria-checked={on} onClick={() => setGate({ ...gate, modes: on ? gate.modes.filter((x) => x !== k) : [...gate.modes, k] })}
              className={cx("rounded-xl border px-3 py-2 text-left transition active:scale-[0.98]", on ? "border-accent/40 bg-accent-soft" : "border-line hover:bg-hover")}>
              <span className="flex items-center gap-1.5 text-[13px] font-medium">{on ? <Check className="size-4 text-accent" /> : <span className="size-4 rounded border border-line" />}{v.label}</span>
              <span className="mt-0.5 block text-[11px] text-muted">{v.hint}</span>
            </button>
          );
        })}
      </div>
      {gate.modes.includes("password") && (
        <div className="mt-3"><Field label="目录密码" hint={myGate?.has_password ? "已设置；留空保持不变" : undefined}>
          <Input type="password" autoComplete="new-password" value={gate.password} onChange={(e) => setGate({ ...gate, password: e.target.value })} />
        </Field></div>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" variant="primary" onClick={() => act(() => call("PUT", "/api/acl/gates", { path: here, modes: gate.modes, password: gate.password || null }), gate.modes.length ? "已保存" : "已移除门槛")}>保存门槛</Button>
        {myGate && <Button size="sm" onClick={() => act(() => call("PUT", "/api/acl/gates", { path: here, modes: [] }), "已移除门槛")}>移除</Button>}
      </div>
    </Card>
  );
}

/* ───────────────────────── 按成员 ───────────────────────── */

function ByMember({ rules, users, groups, act, openDir }: Ctx & { openDir: (p: string) => void }) {
  const [kind, setKind] = useState("user");
  const [sid, setSid] = useState(() => String(users[0]?.id ?? ""));
  useEffect(() => { if (kind === "user" && !sid && users[0]) setSid(String(users[0].id)); }, [users]); // eslint-disable-line react-hooks/exhaustive-deps
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
    <Card>
      <div className="ctl-sm mb-3 flex flex-wrap items-center gap-2" data-acl-member-pick>
        <span className="ctl-label">查看</span>
        <Select size="sm" value={kind} onChange={(e) => (setKind(e.target.value), setSid(e.target.value === "user" ? String(users[0]?.id ?? "") : e.target.value === "group" ? String(groups[0]?.id ?? "") : ""))} aria-label="成员类型">
          {Object.entries(SUBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {kind === "user" && <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户">{users.map((u) => <option key={u.id} value={u.id}>{u.username}（{u.role}）</option>)}</Select>}
        {kind === "group" && <Select size="sm" value={sid} onChange={(e) => setSid(e.target.value)} aria-label="用户组">{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
        {user && <span className="text-xs text-muted">包含本人、所在用户组（{user.groups.map((g) => g.name).join("、") || "无"}）以及「所有登录用户」的规则{user.role === "admin" && "；管理员不受目录权限限制"}</span>}
      </div>
      {mine.length === 0 ? <p className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">没有针对该成员的目录规则</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line" data-acl-member-rules>
          {pg.slice.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
              <button className="min-w-0 flex-1 truncate text-left font-mono hover:underline" onClick={() => openDir(norm(r.path))} title="在「按目录」中编辑">{norm(r.path) === "/" ? "/（根目录）" : norm(r.path)}</button>
              <span className="text-xs text-muted">{via(r)}</span>
              <PresetBadge r={r} />
              <span className="flex max-w-80 flex-wrap gap-1 text-[11.5px]">
                {r.allow.slice(0, 6).map((p) => <span key={p} className="rounded bg-ok/10 px-1 text-ok">{PERM_LABEL[p] ?? p}</span>)}
                {r.allow.length > 6 && <span className="text-faint">+{r.allow.length - 6}</span>}
                {r.deny.map((p) => <span key={p} className="rounded bg-danger/10 px-1 text-danger line-through">{PERM_LABEL[p] ?? p}</span>)}
              </span>
              <IconButton size="sm" label="删除规则" onClick={() => act(() => call("DELETE", `/api/acl/rules/${r.id}`), "规则已删除")}><Trash2 /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <Pager {...pg} />
    </Card>
  );
}

/* ───────────────────────── 权限检查 ───────────────────────── */

function Check2({ users, path, setPath, deps }: { users: Me[]; path: string; setPath: (p: string) => void; deps: unknown[] }) {
  const [who, setWho] = useState(() => String(users.find((u) => u.role !== "admin")?.id ?? 0));
  const [picker, setPicker] = useState(false);
  const [eff, setEff] = useState<Effective | null>(null);
  const here = norm(path);
  useEffect(() => {
    call<Effective>("GET", `/api/acl/effective?path=${encodeURIComponent(here)}&user_id=${who}`).then(setEff).catch((e) => (setEff(null), toast.err(errMsg(e))));
  }, [here, who, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  const SUBJ2: Record<string, string> = { ...SUBJ, role: "角色" };
  return (
    <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> 某人在某目录能做什么？</span>}>
      <div className="ctl-sm mb-4 flex flex-wrap items-center gap-2">
        <span className="ctl-label">成员</span>
        <Select size="sm" value={who} onChange={(e) => setWho(e.target.value)} aria-label="查看对象">
          <option value="0">匿名访客</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.username}（{u.role}）</option>)}
        </Select>
        <span className="ctl-label">目录</span>
        <button type="button" onClick={() => setPicker(true)} className="flex h-8 max-w-80 items-center gap-1.5 truncate rounded-lg border border-line bg-panel px-2.5 font-mono text-[12.5px] hover:bg-hover"><FolderSearch className="size-3.5 shrink-0" />{here}</button>
      </div>
      {!eff ? <SkWrap className="space-y-2"><Sk className="h-6 w-2/3" /><Sk className="h-6 w-1/2" /><Sk className="h-20" /></SkWrap> : (
        <div className="space-y-3 text-[13px]" data-testid="acl-effective">
          <div className="grid gap-2 sm:grid-cols-2">
            {PERM_CATEGORIES.map((c) => (
              <div key={c.id} className="rounded-xl border border-line px-3 py-2">
                <p className="mb-1 text-[11px] font-semibold tracking-wider text-muted">{c.label}</p>
                <div className="flex flex-wrap gap-1">{permsOf(c.id).map((p) => <Badge key={p} tone={eff.permissions.includes(p) ? "ok" : "neutral"}>{eff.permissions.includes(p) ? "✓" : "✗"} {PERM_LABEL[p]}</Badge>)}</div>
              </div>
            ))}
          </div>
          <p className="text-muted">{eff.reason}</p>
          {eff.gate && <p>门槛 <span className="font-mono">{eff.gate.path}</span>：{eff.gate.modes.map((m) => GATE[m]?.label ?? m).join(" / ")} → {eff.gate.passed ? <Badge tone="ok">通过</Badge> : <Badge tone="danger">未通过</Badge>}</p>}
          {eff.trace.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">推导过程（从根目录到当前目录，依次叠加）</p>
              <ol className="space-y-1.5 border-l-2 border-line pl-3">
                {eff.trace.map((t, i) => (
                  <li key={i}>
                    <span className="font-mono text-xs">{t.path}</span> · {SUBJ2[t.subject] ?? t.subject}
                    {t.allow.length > 0 && <span className="text-ok"> +{t.allow.map((p) => PERM_LABEL[p]).join("、")}</span>}
                    {t.deny.length > 0 && <span className="text-danger"> −{t.deny.map((p) => PERM_LABEL[p]).join("、")}</span>}
                    <span className="text-faint"> ⇒ {t.after.map((p) => PERM_LABEL[p]).join("、") || "无"}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="text-[11px] text-faint">通过「角色」分配的权限在根目录生效（推导中显示为 / 上的规则）。</p>
        </div>
      )}
      <DirPicker allowRoot open={picker} title="选择目录" start={here} onClose={() => setPicker(false)} onPick={(d) => (setPicker(false), setPath(d))} />
    </Card>
  );
}

/* ───────────────────────── 使用说明 ───────────────────────── */

function Help() {
  const steps = [
    { t: "1. 选目录", d: "在「按目录」左侧选择或搜索一个目录（也可以点「选择目录」从文件树挑）。" },
    { t: "2. 加成员", d: "给某个用户、用户组、所有登录用户或匿名访客加一条规则，先选一个预设：只读 / 读写 / 完全控制 / 禁止访问。" },
    { t: "3. 需要时细调", d: "点「细调」逐项设置：继承（不改变）、允许、拒绝。改动立即生效。" },
    { t: "4. 检查结果", d: "到「权限检查」选一个人和目录，看最终能做什么，以及是哪几条规则导致的。" },
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-acl-help>
      <Card title="四步完成配置">
        <ol className="space-y-3">{steps.map((s) => <li key={s.t}><p className="text-[13.5px] font-medium">{s.t}</p><p className="text-[12.5px] text-muted">{s.d}</p></li>)}</ol>
      </Card>
      <Card title="规则如何生效">
        <ul className="list-disc space-y-2 pl-5 text-[13px]">
          <li><b>继承</b>：下级目录自动继承上级的规则；在下级再写一条即可覆盖。</li>
          <li><b>越深越优先</b>：例如 <code>/项目</code> 只读、<code>/项目/草稿</code> 读写，则在草稿里可以写。</li>
          <li><b>同一目录内</b>按 匿名访客 → 所有登录用户 → 用户组 → 用户 的顺序叠加，越具体的越后生效，所以「用户」规则可以覆盖「用户组」规则。</li>
          <li><b>允许 / 拒绝</b>：允许会加上权限，拒绝会去掉权限；没设置（继承）的项保持之前的结果。</li>
          <li><b>管理员</b>（管理员级别角色）不受目录权限限制。</li>
          <li><b>门槛</b>与权限独立：例如设置「需要密码」后，有权限的人也需要先输入目录密码。</li>
        </ul>
      </Card>
      <Card title="预设包含的权限" className="lg:col-span-2">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {PRESETS.map((p) => (
            <div key={p.id} className="rounded-xl border border-line px-3 py-2.5">
              <p className="text-[13.5px] font-medium">{p.label}</p>
              <p className="mb-1.5 text-[11.5px] text-muted">{p.desc}</p>
              <div className="flex flex-wrap gap-1 text-[11.5px]">
                {p.allow.map((x) => <span key={x} className="rounded bg-ok/10 px-1 text-ok">{PERM_LABEL[x]}</span>)}
                {p.deny.map((x) => <span key={x} className="rounded bg-danger/10 px-1 text-danger line-through">{PERM_LABEL[x]}</span>)}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
