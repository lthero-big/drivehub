import { useCallback, useEffect, useState } from "react";
import { api, call, tokens, ApiError, WEB_VERSION, type Compat, type VersionInfo } from "./api";

type Status = {
  initialized: boolean;
  open_registration: boolean;
  require_email_verification: boolean;
  mail_transport: string;
  oauth_providers: string[];
  me: Me | null;
};
type Me = { id: number; username: string; email: string | null; role: string; totp_enabled: boolean; identities: string[] };

const card = "w-full max-w-xl rounded-2xl border border-neutral-800 bg-neutral-900 p-6 shadow-xl";
const input = "w-full rounded-lg bg-neutral-800 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-sky-500";
const btn = "rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50";
const btn2 = "rounded-lg border border-neutral-700 px-3 py-1.5 text-xs hover:bg-neutral-800";

function hashParams(): [string, URLSearchParams] {
  const h = location.hash.replace(/^#\/?/, "");
  const [route, q] = h.split("?");
  return [route, new URLSearchParams(q ?? "")];
}

function Field(p: { label: string; value: string; set: (v: string) => void; type?: string }) {
  return (
    <label className="block text-sm">
      <span className="text-neutral-400">{p.label}</span>
      <input className={input} type={p.type ?? "text"} value={p.value} onChange={(e) => p.set(e.target.value)} />
    </label>
  );
}

function AuthForm({ status, onDone }: { status: Status; onDone: () => void }) {
  const mode = !status.initialized ? "init" : "login";
  const [tab, setTab] = useState<"login" | "register" | "forgot">("login");
  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [msg, setMsg] = useState("");
  const submit = async () => {
    setMsg("");
    try {
      if (mode === "init") {
        tokens.set(await call("POST", "/api/auth/init", { username: login, email: email || null, password: pw }));
      } else if (tab === "register") {
        const r = await call("POST", "/api/auth/register", { username: login || null, email, password: pw });
        if (r.verification_required) return setMsg("注册成功，请查收验证邮件");
        tokens.set(r.tokens);
      } else if (tab === "forgot") {
        await call("POST", "/api/auth/password/forgot", { email });
        return setMsg("如果该邮箱已注册，重置邮件已发送");
      } else {
        tokens.set(await call("POST", "/api/auth/login", { login, password: pw, totp_code: code || null }));
      }
      onDone();
    } catch (e) {
      const err = e as ApiError;
      if (err.body?.totp_required) setNeedTotp(true);
      setMsg(err.status === 429 ? "失败次数过多，请稍后再试" : err.message);
    }
  };
  return (
    <div className={card}>
      <h1 className="text-2xl font-semibold">DriveHub</h1>
      <p className="mt-1 text-sm text-neutral-400">{mode === "init" ? "首次启动：创建管理员" : "登录"}</p>
      {mode === "login" && (
        <div className="mt-4 flex gap-2 text-sm">
          <button className={btn2} onClick={() => setTab("login")}>登录</button>
          {status.open_registration && <button className={btn2} onClick={() => setTab("register")}>注册</button>}
          <button className={btn2} onClick={() => setTab("forgot")}>忘记密码</button>
        </div>
      )}
      <div className="mt-4 space-y-3">
        {tab !== "forgot" && <Field label={mode === "init" ? "管理员用户名" : tab === "register" ? "用户名（可选）" : "用户名或邮箱"} value={login} set={setLogin} />}
        {(mode === "init" || tab !== "login") && <Field label="邮箱" value={email} set={setEmail} />}
        {tab !== "forgot" && <Field label="密码（≥8 位）" type="password" value={pw} set={setPw} />}
        {needTotp && <Field label="两步验证码 (TOTP)" value={code} set={setCode} />}
        <button className={btn} onClick={submit}>{mode === "init" ? "创建管理员" : tab === "register" ? "注册" : tab === "forgot" ? "发送重置邮件" : "登录"}</button>
        {mode === "login" && status.oauth_providers.map((p) => (
          <a key={p} className={`${btn2} ml-2 inline-block`} href={`/api/auth/oauth/${p}/start`}>使用 {p} 登录</a>
        ))}
        {msg && <p className="text-sm text-amber-300">{msg}</p>}
      </div>
    </div>
  );
}

function Account({ me, reload }: { me: Me; reload: () => void }) {
  const [totp, setTotp] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [list, setList] = useState<{ tokens: any[]; apps: any[]; sessions: any[] }>({ tokens: [], apps: [], sessions: [] });
  const load = useCallback(async () => {
    setList({
      tokens: await call("GET", "/api/auth/tokens"),
      apps: await call("GET", "/api/auth/app-passwords"),
      sessions: await call("GET", "/api/auth/sessions"),
    });
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (f: () => Promise<unknown>) => { try { await f(); await load(); reload(); } catch (e) { alert((e as Error).message); } };
  return (
    <div className={card}>
      <h2 className="text-lg font-semibold">账户 · {me.username} <span className="text-xs text-neutral-400">({me.role})</span></h2>
      <section className="mt-4 text-sm">
        <h3 className="font-medium">两步验证 (TOTP)：{me.totp_enabled ? "已开启" : "未开启"}</h3>
        {!me.totp_enabled && !totp && <button className={btn2} onClick={async () => setTotp(await call("POST", "/api/auth/totp/setup"))}>开启</button>}
        {totp && (
          <div className="mt-2 space-y-2">
            <p className="break-all text-xs text-neutral-400">密钥 {totp.secret}<br />{totp.otpauth_url}</p>
            <Field label="验证码" value={code} set={setCode} />
            <button className={btn2} onClick={() => act(async () => { await call("POST", "/api/auth/totp/enable", { code }); setTotp(null); })}>确认开启</button>
          </div>
        )}
        {me.totp_enabled && (
          <div className="mt-2 flex gap-2"><input className={input} placeholder="验证码" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className={btn2} onClick={() => act(() => call("POST", "/api/auth/totp/disable", { code }))}>关闭</button></div>
        )}
      </section>
      <section className="mt-4 text-sm">
        <h3 className="font-medium">API Token / WebDAV 应用密码</h3>
        {secret && <p className="mt-1 break-all rounded bg-neutral-800 p-2 text-xs text-emerald-300">仅显示一次：{secret}</p>}
        <div className="mt-2 flex gap-2">
          <button className={btn2} onClick={() => act(async () => setSecret((await call("POST", "/api/auth/tokens", { name: "web" })).token))}>新建 API Token</button>
          <button className={btn2} onClick={() => act(async () => setSecret((await call("POST", "/api/auth/app-passwords", { name: "webdav" })).password))}>新建应用密码</button>
        </div>
        <ul className="mt-2 space-y-1 text-xs text-neutral-300">
          {list.tokens.map((t) => <li key={`t${t.id}`}>token {t.name} {t.prefix}… <button className={btn2} onClick={() => act(() => call("DELETE", `/api/auth/tokens/${t.id}`))}>删除</button></li>)}
          {list.apps.map((a) => <li key={`a${a.id}`}>app-password {a.name} <button className={btn2} onClick={() => act(() => call("DELETE", `/api/auth/app-passwords/${a.id}`))}>删除</button></li>)}
        </ul>
        <p className="mt-1 text-xs text-neutral-500">WebDAV 地址：{location.origin}/dav/ （用户名 + 应用密码）</p>
      </section>
      <section className="mt-4 text-sm">
        <h3 className="font-medium">登录设备</h3>
        <ul className="mt-1 space-y-1 text-xs text-neutral-300">
          {list.sessions.map((s) => (
            <li key={s.id}>{s.current ? "★ " : ""}{s.method} · {s.ip} · {s.user_agent.slice(0, 40)} {!s.current && <button className={btn2} onClick={() => act(() => call("DELETE", `/api/auth/sessions/${s.id}`))}>下线</button>}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Admin() {
  const [s, setS] = useState<{ open_registration: boolean; require_email_verification: boolean } | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const load = useCallback(async () => { setS(await call("GET", "/api/admin/settings")); setUsers(await call("GET", "/api/admin/users")); }, []);
  useEffect(() => { load(); }, [load]);
  if (!s) return null;
  const put = async (patch: object) => { setS(await call("PUT", "/api/admin/settings", patch)); };
  return (
    <div className={card}>
      <h2 className="text-lg font-semibold">管理设置</h2>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={s.open_registration} onChange={(e) => put({ open_registration: e.target.checked })} /> 开放注册</label>
      <label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={s.require_email_verification} onChange={(e) => put({ require_email_verification: e.target.checked })} /> 注册需邮箱验证</label>
      <h3 className="mt-4 text-sm font-medium">用户</h3>
      <table className="mt-1 w-full text-left text-xs">
        <thead className="text-neutral-400"><tr><th>ID</th><th>用户名</th><th>角色</th><th>2FA</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}><td>{u.id}</td><td>{u.username}{u.disabled ? "（禁用）" : ""}</td>
              <td><select className="bg-neutral-800" value={u.role} onChange={async (e) => { await call("PATCH", `/api/admin/users/${u.id}`, { role: e.target.value }).catch((x) => alert(x.message)); load(); }}>
                <option>admin</option><option>user</option><option>guest</option></select></td>
              <td>{u.totp_enabled ? "✓" : ""}</td>
              <td><button className={btn2} onClick={async () => { await call("POST", `/api/admin/users/${u.id}/logout`); load(); }}>强制下线</button></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TokenPage({ kind, token }: { kind: "verify" | "reset"; token: string }) {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const go = async () => {
    try {
      if (kind === "verify") await call("POST", "/api/auth/email/verify", { token });
      else await call("POST", "/api/auth/password/reset", { token, new_password: pw });
      setMsg("完成，请登录"); location.hash = "";
    } catch (e) { setMsg((e as Error).message); }
  };
  useEffect(() => { if (kind === "verify") go(); }, []); // eslint-disable-line
  return (
    <div className={card}>
      <h2 className="text-lg font-semibold">{kind === "verify" ? "邮箱验证" : "重置密码"}</h2>
      {kind === "reset" && <div className="mt-3 space-y-2"><Field label="新密码" type="password" value={pw} set={setPw} /><button className={btn} onClick={go}>确认</button></div>}
      {msg && <p className="mt-2 text-sm text-amber-300">{msg}</p>}
    </div>
  );
}

export default function App() {
  const [ver, setVer] = useState<VersionInfo | null>(null);
  const [compat, setCompat] = useState<Compat | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [route, setRoute] = useState(hashParams());
  const reload = useCallback(() => { call<Status>("GET", "/api/auth/status").then(setStatus).catch(() => setStatus(null)); }, []);

  useEffect(() => {
    fetch("/api/version").then((r) => r.json()).then(setVer).catch(() => setVer(null));
    api("/api/v1/health").catch((e) => setCompat(e as Compat));
    const [r, q] = hashParams();
    if (r === "oauth" && q.get("access_token")) {
      tokens.set({ access_token: q.get("access_token")!, refresh_token: q.get("refresh_token")! });
      location.hash = "";
    }
    const onHash = () => setRoute(hashParams());
    window.addEventListener("hashchange", onHash);
    reload();
    return () => window.removeEventListener("hashchange", onHash);
  }, [reload]);

  const [r, q] = route;
  const me = status?.me;
  return (
    <main className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4">
        {compat && compat.status !== "ok" && (
          <div className="w-full rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">
            {compat.status === "client_too_old" && `Web 版本过旧，请升级到 ${compat.min_version} 以上`}
            {compat.status === "server_too_old" && "服务端版本过旧，请升级服务端"}
            {compat.status === "invalid" && `版本号无效：${compat.reason}`}
          </div>
        )}
        {r === "oauth" && q.get("error") && <div className="w-full rounded-lg bg-red-500/10 p-3 text-sm text-red-300">OAuth：{q.get("error")}</div>}
        {(r === "verify" || r === "reset") && q.get("token") ? (
          <TokenPage kind={r} token={q.get("token")!} />
        ) : status && !me ? (
          <AuthForm status={status} onDone={reload} />
        ) : me ? (
          <>
            <div className="flex w-full items-center justify-between text-sm">
              <span>DriveHub · {me.username}</span>
              <button className={btn2} onClick={async () => { await call("POST", "/api/auth/logout").catch(() => {}); tokens.set(null); reload(); }}>退出</button>
            </div>
            <Account me={me} reload={reload} />
            {me.role === "admin" && <Admin />}
          </>
        ) : null}
        <p className="text-xs text-neutral-500">Web {WEB_VERSION} · Server {ver?.server_version ?? "…"} · API {ver ? `v${ver.api_version}` : "…"}</p>
      </div>
    </main>
  );
}
