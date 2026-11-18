// Directory permissions (DEPTAI-485 r3 #5): path bar with ancestor chips + configured-dir shortcuts,
// inheritance chain, an editable tri-state permission matrix (inherit / allow / deny per rule),
// quick presets for new rules, access gates, and the effective-permission viewer.
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, FolderSearch, FolderTree, Lock, Minus, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { call, PERM_LABEL, PERMS, type Effective, type Gate, type Group, type Me, type Rule } from "../../lib/api";
import { go } from "../../lib/router";
import { cx, errMsg } from "../../lib/util";
import { Badge, Button, Card, Field, IconButton, Input, Select, toast, Checkbox, PageHeader } from "../../ui/ui";
import { DirPicker } from "../../components/DirPicker";

const SUBJ: Record<string, string> = { anonymous: "匿名访客", logged_in: "所有登录用户", group: "用户组", user: "用户" };
const GATE: Record<string, { label: string; hint: string }> = {
  anonymous: { label: "允许匿名", hint: "无需登录即可进入" },
  logged_in: { label: "需要登录", hint: "登录后可进入" },
  password: { label: "需要密码", hint: "输入目录密码后可进入" },
};
const PRESETS: { label: string; allow: string[]; deny: string[]; tone?: "danger" }[] = [
  { label: "只读", allow: ["read", "download"], deny: [] },
  { label: "读写", allow: ["read", "download", "upload", "create", "edit"], deny: [] },
  { label: "完全控制", allow: [...PERMS], deny: [] },
  { label: "禁止访问", allow: [], deny: ["read", "download"], tone: "danger" },
];
type Cell = "none" | "allow" | "deny";
const cellOf = (r: { allow: string[]; deny: string[] }, p: string): Cell => (r.allow.includes(p) ? "allow" : r.deny.includes(p) ? "deny" : "none");
const NEXT: Record<Cell, Cell> = { none: "allow", allow: "deny", deny: "none" };
const CELL_LABEL: Record<Cell, string> = { none: "继承", allow: "允许", deny: "拒绝" };
const norm = (p: string) => "/" + p.split("/").filter(Boolean).join("/");

function CellBtn({ state, onClick, label }: { state: Cell; onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={`${label}：${CELL_LABEL[state]}`} title={`${label}：${CELL_LABEL[state]}（点击切换 继承→允许→拒绝）`} data-state={state}
      className={cx("mx-auto grid size-8 place-items-center rounded-lg border transition active:scale-90", state === "allow" ? "border-ok/40 bg-ok/10 text-ok" : state === "deny" ? "border-danger/40 bg-danger/10 text-danger" : "border-line text-faint hover:bg-hover")}>
      {state === "allow" ? <Check className="size-4" /> : state === "deny" ? <X className="size-4" /> : <Minus className="size-3.5" />}
    </button>
  );
}

export function AclPage({ initialPath }: { initialPath: string }) {
  const [path, setPath] = useState(initialPath || "/");
  const [rules, setRules] = useState<Rule[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [users, setUsers] = useState<Me[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [picker, setPicker] = useState(false);
  const [nr, setNr] = useState<{ subject: string; subject_id: string }>({ subject: "logged_in", subject_id: "" });
  const [gate, setGate] = useState<{ modes: string[]; password: string }>({ modes: [], password: "" });
  const [who, setWho] = useState("0");
  const [eff, setEff] = useState<Effective | null>(null);
  useEffect(() => setPath(initialPath || "/"), [initialPath]);

  const load = async () => {
    try {
      const [r, g, u, gr] = await Promise.all([call<Rule[]>("GET", "/api/acl/rules"), call<Gate[]>("GET", "/api/acl/gates"), call<Me[]>("GET", "/api/admin/users"), call<Group[]>("GET", "/api/admin/groups")]);
      setRules(r);
      setGates(g);
      setUsers(u);
      setGroups(gr);
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  useEffect(() => void load(), []);
  const here = norm(path);
  const parts = here.split("/").filter(Boolean);
  const myGate = gates.find((g) => norm(g.path) === here);
  useEffect(() => setGate({ modes: myGate?.modes ?? [], password: "" }), [here, myGate?.modes.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const hereRules = rules.filter((r) => norm(r.path) === here);
  const inherited = rules.filter((r) => norm(r.path) !== here && (norm(r.path) === "/" || here.startsWith(norm(r.path) + "/")));
  const configured = useMemo(() => [...new Set([...rules.map((r) => norm(r.path)), ...gates.map((g) => norm(g.path))])].sort(), [rules, gates]);
  const subjName = (r: { subject: string; subject_id: number | null }) => (r.subject === "user" ? users.find((u) => u.id === r.subject_id)?.username : r.subject === "group" ? groups.find((g) => g.id === r.subject_id)?.name : null);

  useEffect(() => {
    call<Effective>("GET", `/api/acl/effective?path=${encodeURIComponent(here)}&user_id=${who}`).then(setEff).catch((e) => (setEff(null), toast.err(errMsg(e))));
  }, [here, who, rules, gates]);

  const act = async (f: () => Promise<unknown>, msg: string) => {
    try {
      await f();
      toast.ok(msg);
      await load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const addRule = (allow: string[], deny: string[]) => {
    if ((nr.subject === "user" || nr.subject === "group") && !nr.subject_id) return toast.err(nr.subject === "user" ? "请先选择用户" : "请先选择用户组");
    return act(() => call("POST", "/api/acl/rules", { path: here, subject: nr.subject, subject_id: nr.subject_id ? Number(nr.subject_id) : null, allow, deny }), "规则已添加");
  };
  /** Edit = create the new rule then delete the old one. */
  const setCell = (r: Rule, p: string) =>
    act(async () => {
      const to = NEXT[cellOf(r, p)];
      const allow = r.allow.filter((x) => x !== p), deny = r.deny.filter((x) => x !== p);
      if (to === "allow") allow.push(p);
      if (to === "deny") deny.push(p);
      if (allow.length || deny.length) await call("POST", "/api/acl/rules", { path: r.path, subject: r.subject, subject_id: r.subject_id, allow, deny });
      await call("DELETE", `/api/acl/rules/${r.id}`);
    }, "已更新");

  return (
    <div className="space-y-4">
      <PageHeader title="目录权限" desc="选择目录 → 用矩阵设置谁能做什么；下级目录继承上级，更深层规则可覆盖" />

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="目录路径" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 rounded-xl border border-line bg-panel-2 px-2 py-1.5 text-sm" data-testid="acl-crumbs">
            <button onClick={() => setPath("/")} className={cx("rounded-md px-1.5 py-0.5 hover:bg-hover", parts.length === 0 && "bg-accent-soft font-semibold text-accent")}>根目录</button>
            {parts.map((p, i) => (
              <span key={i} className="flex items-center gap-0.5">
                <ChevronRight className="size-3.5 text-faint" />
                <button onClick={() => setPath("/" + parts.slice(0, i + 1).join("/"))} className={cx("rounded-md px-1.5 py-0.5 hover:bg-hover", i === parts.length - 1 && "bg-accent-soft font-semibold text-accent")}>{p}</button>
              </span>
            ))}
          </nav>
          <Button onClick={() => setPicker(true)}><FolderSearch className="size-4" /> 选择目录</Button>
          <Button variant="ghost" onClick={() => go(`#/files${here === "/" ? "" : here}`)}>在文件页打开</Button>
        </div>
        <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">手动输入路径</summary><Input value={path} onChange={(e) => setPath(e.target.value)} aria-label="目录路径" className="mt-1.5 font-mono" /></details>
        {configured.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs" data-testid="acl-configured">
            <span className="flex items-center gap-1 text-muted"><FolderTree className="size-3.5" /> 已配置：</span>
            {configured.map((c) => <button key={c} onClick={() => setPath(c)} className={cx("rounded-full border px-2 py-0.5 font-mono", c === here ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-hover")}>{c}</button>)}
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <div className="space-y-4">
          <Card title={<span className="flex items-center gap-2">权限规则 <span className="font-mono text-xs font-normal text-muted">{here}</span></span>}>
            {inherited.length > 0 && (
              <details className="mb-3 rounded-xl border border-dashed border-line bg-panel-2 px-3 py-2 text-[13px]" data-testid="acl-inherited" open>
                <summary className="cursor-pointer text-xs font-medium text-muted">继承自上级目录（{inherited.length} 条，本目录规则会在此基础上叠加/覆盖）</summary>
                <ul className="mt-2 space-y-1.5">
                  {inherited.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-1.5">
                      <button onClick={() => setPath(r.path)} className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px] text-muted hover:text-fg">{norm(r.path)}</button>
                      <Badge tone="accent">{SUBJ[r.subject]}{subjName(r) ? `：${subjName(r)}` : ""}</Badge>
                      {r.allow.map((p) => <Badge key={`a${p}`} tone="ok">+{PERM_LABEL[p] ?? p}</Badge>)}
                      {r.deny.map((p) => <Badge key={`d${p}`} tone="danger">−{PERM_LABEL[p] ?? p}</Badge>)}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {hereRules.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line p-4 text-center text-[13px] text-muted">本目录还没有规则，权限完全继承自上级。下方添加第一条。</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[640px] text-center text-xs" data-testid="acl-matrix">
                  <thead className="bg-panel-2 text-muted">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">对象</th>
                      {PERMS.map((p) => <th key={p} className="px-1 py-2 font-medium">{PERM_LABEL[p]}</th>)}
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {hereRules.map((r) => (
                      <tr key={r.id} data-rule={r.id}>
                        <td className="px-3 py-2 text-left"><Badge tone="accent">{SUBJ[r.subject]}</Badge>{subjName(r) && <span className="ml-1.5 text-[13px] font-medium">{subjName(r)}</span>}</td>
                        {PERMS.map((p) => <td key={p} className="px-1 py-1.5"><CellBtn state={cellOf(r, p)} label={`${SUBJ[r.subject]}${subjName(r) ?? ""} ${PERM_LABEL[p]}`} onClick={() => setCell(r, p)} /></td>)}
                        <td><IconButton label="删除规则" onClick={() => act(() => call("DELETE", `/api/acl/rules/${r.id}`), "规则已删除")}><Trash2 className="size-4" /></IconButton></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="border-t border-line bg-panel-2 px-3 py-1.5 text-left text-[11px] text-muted">点击单元格循环切换：<b className="text-faint">—</b> 继承 → <b className="text-ok">✓</b> 允许 → <b className="text-danger">✕</b> 拒绝。同一级别内，用户 &gt; 用户组 &gt; 登录用户 &gt; 匿名。</p>
              </div>
            )}

            <div className="mt-4 rounded-xl border border-line bg-panel-2 p-3" data-testid="acl-add">
              <p className="mb-2 text-[13px] font-medium">添加规则</p>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="对象类型">
                  {Object.entries(SUBJ).map(([k, v]) => <button key={k} role="radio" aria-checked={nr.subject === k} onClick={() => setNr({ subject: k, subject_id: "" })} className={cx("rounded-md px-2.5 py-1 text-xs", nr.subject === k ? "bg-active font-medium text-fg" : "text-muted hover:text-fg")}>{v}</button>)}
                </div>
                {nr.subject === "user" && <Select value={nr.subject_id} onChange={(e) => setNr({ ...nr, subject_id: e.target.value })} aria-label="用户"><option value="">选择用户…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}</Select>}
                {nr.subject === "group" && <Select value={nr.subject_id} onChange={(e) => setNr({ ...nr, subject_id: e.target.value })} aria-label="用户组"><option value="">选择用户组…</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
              </div>
              <p className="mt-2.5 mb-1.5 text-xs text-muted">选一个预设直接添加，之后可在矩阵里微调：</p>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button key={p.label} size="sm" variant={p.tone === "danger" ? "danger" : "outline"} onClick={() => addRule(p.allow, p.deny)}><Plus className="size-3.5" /> {p.label}</Button>
                ))}
              </div>
            </div>
          </Card>

          <Card title={<span className="flex items-center gap-2"><Lock className="size-4" /> 访问方式（门槛）</span>}>
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
        </div>

        <div className="xl:sticky xl:top-4 xl:self-start">
          <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> 有效权限</span>} actions={
            <Select value={who} onChange={(e) => setWho(e.target.value)} className="h-8 text-xs" aria-label="查看对象">
              <option value="0">匿名访客</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.username}（{u.role}）</option>)}
            </Select>
          }>
            {eff && (
              <div className="space-y-3 text-[13px]" data-testid="acl-effective">
                <div className="flex flex-wrap gap-1">
                  {PERMS.map((p) => <Badge key={p} tone={eff.permissions.includes(p) ? "ok" : "neutral"}>{eff.permissions.includes(p) ? "✓" : "✗"} {PERM_LABEL[p]}</Badge>)}
                </div>
                <p className="text-muted">{eff.reason}</p>
                {eff.gate && <p>门槛 <span className="font-mono">{eff.gate.path}</span>：{eff.gate.modes.map((m) => GATE[m]?.label ?? m).join(" / ")} → {eff.gate.passed ? <Badge tone="ok">通过</Badge> : <Badge tone="danger">未通过</Badge>}</p>}
                {eff.trace.length > 0 && (
                  <ol className="space-y-1.5 border-l-2 border-line pl-3">
                    {eff.trace.map((t, i) => (
                      <li key={i}>
                        <span className="font-mono text-xs">{t.path}</span> · {SUBJ[t.subject] ?? t.subject}
                        {t.allow.length > 0 && <span className="text-ok"> +{t.allow.map((p) => PERM_LABEL[p]).join("")}</span>}
                        {t.deny.length > 0 && <span className="text-danger"> −{t.deny.map((p) => PERM_LABEL[p]).join("")}</span>}
                        <span className="text-faint"> ⇒ {t.after.map((p) => PERM_LABEL[p]).join("、") || "无"}</span>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="text-[11px] text-faint">通过「角色」分配的权限在根目录生效（轨迹中显示为 / 上的规则）。</p>
              </div>
            )}
          </Card>
        </div>
      </div>
      <DirPicker allowRoot open={picker} title="选择目录" start={here} onClose={() => setPicker(false)} onPick={(d) => (setPicker(false), setPath(d))} />
    </div>
  );
}
