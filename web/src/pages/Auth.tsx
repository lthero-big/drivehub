import { useEffect, useState, type FormEvent } from "react";
import { HardDrive } from "lucide-react";
import { ApiError, call, tokens, type AuthStatus } from "../lib/api";
import { errMsg } from "../lib/util";
import { Button, Field, Input } from "../ui/ui";

function Shell({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="anim-in w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-fg">
            <HardDrive className="size-5" />
          </span>
          <span className="text-lg font-semibold">DriveHub</span>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-6 shadow-pop">
          <h1 className="text-lg font-semibold">{title}</h1>
          {sub && <p className="mt-1 text-[13px] text-muted">{sub}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </main>
  );
}

const ProviderIcon = ({ p }: { p: string }) =>
  p === "github" ? (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" /></svg>
  ) : (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7Z" /><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24Z" /><path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.9l4-3.1Z" /><path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" /></svg>
  );

export function AuthPage({ status, onDone, totpTicket }: { status: AuthStatus; onDone: () => void; totpTicket?: string | null }) {
  const init = !status.initialized;
  const [tab, setTab] = useState<"login" | "register" | "forgot">("login");
  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [needTotp, setNeedTotp] = useState(!!totpTicket);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    try {
      if (init) tokens.set(await call("POST", "/api/auth/init", { username: login, email: email || null, password: pw }));
      else if (totpTicket) tokens.set(await call("POST", "/api/auth/login/totp", { ticket: totpTicket, code }));
      else if (tab === "register") {
        const r = await call("POST", "/api/auth/register", { username: login || null, email, password: pw });
        if (r.verification_required) return setMsg({ text: "注册成功，请查收验证邮件后登录", ok: true });
        tokens.set(r.tokens);
      } else if (tab === "forgot") {
        await call("POST", "/api/auth/password/forgot", { email });
        return setMsg({ text: "如果该邮箱已注册，重置邮件已发送", ok: true });
      } else tokens.set(await call("POST", "/api/auth/login", { login, password: pw, totp_code: code || null }));
      if (totpTicket) location.hash = "";
      onDone();
    } catch (err) {
      const a = err as ApiError;
      if (a.body?.totp_required) {
        setNeedTotp(true);
        setMsg({ text: "请输入两步验证码" });
      } else setMsg({ text: a.status === 429 ? "失败次数过多，请稍后再试" : errMsg(err) });
    } finally {
      setBusy(false);
    }
  };

  const title = init ? "欢迎使用 DriveHub" : totpTicket ? "两步验证" : tab === "register" ? "创建账号" : tab === "forgot" ? "找回密码" : "登录";
  const sub = init ? "首次启动：创建唯一的管理员账号" : totpTicket ? "输入验证器 App 中的 6 位验证码" : undefined;
  return (
    <Shell title={title} sub={sub}>
      <form onSubmit={submit} className="space-y-3.5">
        {!totpTicket && tab !== "forgot" && (
          <Field label={init ? "管理员用户名" : tab === "register" ? "用户名（可选）" : "用户名或邮箱"}>
            <Input autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} required={tab === "login" || init} autoFocus />
          </Field>
        )}
        {!totpTicket && (init || tab !== "login") && (
          <Field label={init ? "邮箱（可选）" : "邮箱"}>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required={!init} />
          </Field>
        )}
        {!totpTicket && tab !== "forgot" && (
          <Field label="密码" hint={init || tab === "register" ? "至少 8 位" : undefined}>
            <Input type="password" autoComplete={tab === "login" && !init ? "current-password" : "new-password"} value={pw} onChange={(e) => setPw(e.target.value)} required minLength={init || tab === "register" ? 8 : undefined} />
          </Field>
        )}
        {needTotp && (
          <Field label="两步验证码">
            <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          </Field>
        )}
        {msg && <p className={msg.ok ? "text-[13px] text-ok" : "text-[13px] text-danger"} role="alert">{msg.text}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {init ? "创建管理员" : totpTicket ? "验证" : tab === "register" ? "注册" : tab === "forgot" ? "发送重置邮件" : "登录"}
        </Button>
      </form>
      {!init && !totpTicket && (
        <>
          {tab === "login" && status.oauth_providers.length > 0 && (
            <>
              <div className="my-4 flex items-center gap-3 text-[11px] text-faint">
                <span className="h-px flex-1 bg-line" /> 或 <span className="h-px flex-1 bg-line" />
              </div>
              <div className="space-y-2">
                {status.oauth_providers.map((p) => (
                  <a key={p} href={`/api/auth/oauth/${p}/start`} className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line text-sm hover:bg-hover">
                    <ProviderIcon p={p} /> 使用 {p === "github" ? "GitHub" : p === "google" ? "Google" : p} 登录
                  </a>
                ))}
              </div>
            </>
          )}
          <div className="mt-5 flex justify-center gap-4 text-[13px] text-muted">
            {tab !== "login" && <button onClick={() => setTab("login")} className="hover:text-fg">返回登录</button>}
            {tab === "login" && status.open_registration && <button onClick={() => setTab("register")} className="hover:text-fg">注册账号</button>}
            {tab === "login" && <button onClick={() => setTab("forgot")} className="hover:text-fg">忘记密码</button>}
          </div>
        </>
      )}
    </Shell>
  );
}

export function TokenPage({ kind, token }: { kind: "verify" | "reset"; token: string }) {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const go = async () => {
    try {
      if (kind === "verify") await call("POST", "/api/auth/email/verify", { token });
      else await call("POST", "/api/auth/password/reset", { token, new_password: pw });
      setMsg({ text: kind === "verify" ? "邮箱已验证，请登录" : "密码已重置，请登录", ok: true });
    } catch (e) {
      setMsg({ text: errMsg(e) });
    }
  };
  useEffect(() => {
    if (kind === "verify") go();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Shell title={kind === "verify" ? "邮箱验证" : "重置密码"}>
      {kind === "reset" && !msg?.ok && (
        <form onSubmit={(e) => (e.preventDefault(), go())} className="space-y-3">
          <Field label="新密码" hint="至少 8 位">
            <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required />
          </Field>
          <Button type="submit" variant="primary" className="w-full">确认</Button>
        </form>
      )}
      {msg && <p className={msg.ok ? "text-sm text-ok" : "text-sm text-danger"}>{msg.text}</p>}
      {msg?.ok && (
        <a href="#/" className="mt-4 inline-block text-sm text-accent underline">去登录</a>
      )}
    </Shell>
  );
}
