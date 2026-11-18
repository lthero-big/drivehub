import { useEffect, useMemo, useState } from "react";
import { FolderSearch, Lock, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { call, PERM_LABEL, PERMS, type Effective, type Gate, type Group, type Me, type Rule } from "../../lib/api";
import { go } from "../../lib/router";
import { cx, errMsg } from "../../lib/util";
import { Badge, Button, Card, Field, IconButton, Input, Select, toast } from "../../ui/ui";
import { DirPicker } from "../../components/DirPicker";

const SUBJ: Record<string, string> = { anonymous: "匿名访客", logged_in: "所有登录用户", group: "用户组", user: "用户" };
const GATE: Record<string, string> = { anonymous: "允许匿名", logged_in: "需要登录", password: "需要密码" };

function PermPicker({ value, onChange, tone }: { value: string[]; onChange: (v: string[]) => void; tone: "ok" | "danger" }) {
  return (
    <div className="flex flex-wrap gap-1">
      {PERMS.map((p) => {
        const on = value.includes(p);
        return (
          <button key={p} type="button" aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== p) : [...value, p])}
            className={cx("rounded-md border px-2 py-0.5 text-xs", on ? (tone === "ok" ? "border-ok/40 bg-ok/10 text-ok" : "border-danger/40 bg-danger/10 text-danger") : "border-line text-muted hover:bg-hover")}>
            {PERM_LABEL[p]}
          </button>
        );
      })}
    </div>
  );
}

export function AclPage({ initialPath }: { initialPath: string }) {
  const [path, setPath] = useState(initialPath || "/");
  const [rules, setRules] = useState<Rule[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [users, setUsers] = useState<Me[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [picker, setPicker] = useState(false);
  const [nr, setNr] = useState<{ subject: string; subject_id: string; allow: string[]; deny: string[] }>({ subject: "logged_in", subject_id: "", allow: ["read", "download"], deny: [] });
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
  useEffect(() => {
    load();
  }, []);
  const norm = (p: string) => "/" + p.split("/").filter(Boolean).join("/");
  const here = norm(path);
  const myGate = gates.find((g) => norm(g.path) === here);
  useEffect(() => setGate({ modes: myGate?.modes ?? [], password: "" }), [here, myGate?.modes.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const hereRules = rules.filter((r) => norm(r.path) === here);
  const inherited = rules.filter((r) => norm(r.path) !== here && (norm(r.path) === "/" || here.startsWith(norm(r.path) + "/")));
  const name = useMemo(() => (r: Rule) => (r.subject === "user" ? users.find((u) => u.id === r.subject_id)?.username : r.subject === "group" ? groups.find((g) => g.id === r.subject_id)?.name : null), [users, groups]);

  useEffect(() => {
    call<Effective>("GET", `/api/acl/effective?path=${encodeURIComponent(here)}&user_id=${who}`).then(setEff).catch((e) => (setEff(null), toast.err(errMsg(e))));
  }, [here, who, rules, gates]);

  const act = async (f: () => Promise<unknown>, msg: string) => {
    try {
      await f();
      toast.ok(msg);
      load();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const RuleRow = ({ r, own }: { r: Rule; own: boolean }) => (
    <li className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
      <Badge tone="accent">{SUBJ[r.subject]}{name(r) ? `：${name(r)}` : ""}</Badge>
      {!own && <span className="font-mono text-xs text-faint">{r.path}</span>}
      {r.allow.map((p) => <Badge key={`a${p}`} tone="ok">+{PERM_LABEL[p] ?? p}</Badge>)}
      {r.deny.map((p) => <Badge key={`d${p}`} tone="danger">−{PERM_LABEL[p] ?? p}</Badge>)}
      <IconButton className="ml-auto" label="删除规则" onClick={() => act(() => call("DELETE", `/api/acl/rules/${r.id}`), "规则已删除")}>
        <Trash2 className="size-4" />
      </IconButton>
    </li>
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">目录权限</h1>
      <div className="flex gap-2">
        <Input value={path} onChange={(e) => setPath(e.target.value)} aria-label="目录路径" className="font-mono" />
        <Button onClick={() => setPicker(true)}>
          <FolderSearch className="size-4" /> 选择
        </Button>
        <Button variant="ghost" onClick={() => go(`#/files${here === "/" ? "" : here}`)}>打开</Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="本目录规则">
            {hereRules.length === 0 && <p className="text-[13px] text-muted">没有规则，权限继承自上级目录。</p>}
            <ul className="divide-y divide-line">{hereRules.map((r) => <RuleRow key={r.id} r={r} own />)}</ul>
            <form className="mt-3 space-y-2 rounded-lg border border-line bg-panel-2 p-3" onSubmit={(e) => (e.preventDefault(), act(() => call("POST", "/api/acl/rules", { path: here, subject: nr.subject, subject_id: nr.subject_id ? Number(nr.subject_id) : null, allow: nr.allow, deny: nr.deny }), "规则已添加"))}>
              <div className="flex flex-wrap gap-2">
                <Select value={nr.subject} onChange={(e) => setNr({ ...nr, subject: e.target.value, subject_id: "" })} aria-label="对象">
                  {Object.entries(SUBJ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
                {nr.subject === "user" && <Select value={nr.subject_id} onChange={(e) => setNr({ ...nr, subject_id: e.target.value })} aria-label="用户" required><option value="">选择用户</option>{users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}</Select>}
                {nr.subject === "group" && <Select value={nr.subject_id} onChange={(e) => setNr({ ...nr, subject_id: e.target.value })} aria-label="用户组" required><option value="">选择用户组</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select>}
              </div>
              <p className="text-xs text-muted">允许</p>
              <PermPicker value={nr.allow} onChange={(allow) => setNr({ ...nr, allow })} tone="ok" />
              <p className="text-xs text-muted">拒绝</p>
              <PermPicker value={nr.deny} onChange={(deny) => setNr({ ...nr, deny })} tone="danger" />
              <Button type="submit" size="sm" variant="primary"><Plus className="size-4" /> 添加规则</Button>
            </form>
          </Card>
          <Card title={<span className="flex items-center gap-2"><Lock className="size-4" /> 访问方式（门槛）</span>}>
            <div className="flex flex-wrap gap-4 text-[13px]">
              {Object.entries(GATE).map(([k, v]) => (
                <label key={k} className="flex items-center gap-2">
                  <input type="checkbox" className="accent-[var(--accent)]" checked={gate.modes.includes(k)} onChange={(e) => setGate({ ...gate, modes: e.target.checked ? [...gate.modes, k] : gate.modes.filter((x) => x !== k) })} /> {v}
                </label>
              ))}
            </div>
            {gate.modes.includes("password") && (
              <Field label="目录密码" hint={myGate?.has_password ? "已设置；留空保持不变" : undefined}>
                <Input type="password" autoComplete="new-password" value={gate.password} onChange={(e) => setGate({ ...gate, password: e.target.value })} />
              </Field>
            )}
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="primary" onClick={() => act(() => call("PUT", "/api/acl/gates", { path: here, modes: gate.modes, password: gate.password || null }), gate.modes.length ? "已保存" : "已移除门槛")}>保存</Button>
              {myGate && <Button size="sm" onClick={() => act(() => call("PUT", "/api/acl/gates", { path: here, modes: [] }), "已移除门槛")}>移除</Button>}
            </div>
            {gates.length > 0 && <p className="mt-3 text-xs text-faint">已设门槛的目录：{gates.map((g) => g.path).join("、")}</p>}
          </Card>
          {inherited.length > 0 && (
            <Card title="继承的上级规则">
              <ul className="divide-y divide-line">{inherited.map((r) => <RuleRow key={r.id} r={r} own={false} />)}</ul>
            </Card>
          )}
        </div>
        <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> 有效权限</span>} actions={
          <Select value={who} onChange={(e) => setWho(e.target.value)} className="h-8 text-xs" aria-label="查看对象">
            <option value="0">匿名访客</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.username}（{u.role}）</option>)}
          </Select>
        }>
          {eff && (
            <div className="space-y-3 text-[13px]">
              <div className="flex flex-wrap gap-1">
                {PERMS.map((p) => <Badge key={p} tone={eff.permissions.includes(p) ? "ok" : "neutral"}>{eff.permissions.includes(p) ? "✓" : "✗"} {PERM_LABEL[p]}</Badge>)}
              </div>
              <p className="text-muted">{eff.reason}</p>
              {eff.gate && <p>门槛 <span className="font-mono">{eff.gate.path}</span>：{eff.gate.modes.map((m) => GATE[m] ?? m).join(" / ")} → {eff.gate.passed ? <Badge tone="ok">通过</Badge> : <Badge tone="danger">未通过</Badge>}</p>}
              {eff.trace.length > 0 && (
                <ol className="space-y-1 border-l-2 border-line pl-3">
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
            </div>
          )}
        </Card>
      </div>
      <DirPicker allowRoot open={picker} title="选择目录" start={here} onClose={() => setPicker(false)} onPick={(d) => (setPicker(false), setPath(d))} />
    </div>
  );
}
