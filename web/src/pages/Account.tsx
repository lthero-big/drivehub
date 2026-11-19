import { OtpField, type OtpStatus } from "../ui/r5";
import { prefs, usePrefs } from "../lib/prefs";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Copy, HardDrive, KeyRound, LogOut, Monitor, Plus, ShieldCheck, SlidersHorizontal, Trash2, User as UserIcon, Users as UsersIcon } from "lucide-react";
import { call, tokens } from "../lib/api";
import { useApp } from "../lib/app";
import { go } from "../lib/router";
import { errMsg, fmtSize, fmtTime } from "../lib/util";
import { ConfirmButton, Badge, Button, Card, Field, IconButton, Input, PageHeader, Pager, Progress, Select, StatCard, Switch, Tabs, toast, usePaged } from "../ui/ui";

type Tok = { id: number; name: string; prefix: string; created_at: number; last_used: number | null; expires_at: number | null };
type App = { id: number; name: string; created_at: number; last_used: number | null };
type Sess = { id: string; user_agent: string; ip: string; method: string; created_at: number; last_used: number; current: boolean };
type Ident = { provider: string; email: string | null; created_at: number };

const copy = (s: string) => navigator.clipboard?.writeText(s).then(() => toast.ok("已复制"));

function Secret({ value }: { value: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg border border-ok/30 bg-ok/8 p-2">
      <code className="min-w-0 flex-1 break-all text-xs">{value}</code>
      <IconButton label="复制" onClick={() => copy(value)}>
        <Copy className="size-4" />
      </IconButton>
    </div>
  );
}

type Tab = "profile" | "prefs" | "security" | "tokens" | "devices";

export function AccountPage({ tab }: { tab: string }) {
  const { me, status, reload } = useApp();
  const [toks, setToks] = useState<Tok[]>([]);
  const [apps, setApps] = useState<App[]>([]);
  const [sess, setSess] = useState<Sess[]>([]);
  const [ids, setIds] = useState<Ident[]>([]);
  const [secret, setSecret] = useState<{ kind: string; v: string } | null>(null);
  const [totp, setTotp] = useState<{ secret: string; otpauth_url: string; qr?: string } | null>(null);
  const [code, setCode] = useState("");
  const [otp, setOtp] = useState<OtpStatus>("idle");
  const pf = usePrefs();
  const totpAct = async (url: string, msg: string, after?: () => void) => {
    setOtp("checking");
    try {
      await call("POST", url, { code });
      setOtp("ok");
      await new Promise((r) => setTimeout(r, 450));
      toast.ok(msg);
      after?.();
      setCode("");
      setOtp("idle");
      await load();
      reload();
    } catch (e) {
      setOtp("wrong");
      toast.err(errMsg(e));
    }
  };
  const [pw, setPw] = useState({ old: "", next: "" });
  const [tokName, setTokName] = useState("");
  const [tokDays, setTokDays] = useState("90");
  const load = useCallback(async () => {
    const [a, b, c, d] = await Promise.all([call("GET", "/api/auth/tokens"), call("GET", "/api/auth/app-passwords"), call("GET", "/api/auth/sessions"), call("GET", "/api/auth/identities").catch(() => [])]);
    setToks(a);
    setApps(b);
    setSess(c);
    setIds(d);
  }, []);
  const pt = usePaged(toks, 6);
  const pa = usePaged(apps, 6);
  const ps = usePaged(sess, 6);
  useEffect(() => {
    load().catch((e) => toast.err(errMsg(e)));
  }, [load]);
  if (!me) return null;
  const act = async (f: () => Promise<unknown>, okMsg?: string) => {
    try {
      await f();
      if (okMsg) toast.ok(okMsg);
      await load();
      reload();
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const startTotp = async () => {
    const t = await call<{ secret: string; otpauth_url: string }>("POST", "/api/auth/totp/setup");
    const QR = await import("qrcode");
    const qr = await QR.toDataURL(t.otpauth_url, { margin: 1, width: 180 });
    setTotp({ ...t, qr });
  };
  const link = async (p: string) => {
    try {
      const r = await call<{ url: string }>("GET", `/api/auth/oauth/${p}/start?link=true&format=json`);
      location.href = r.url;
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const quota = me.quota_bytes;
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: "profile", label: "概览", icon: <UserIcon /> },
    { id: "prefs", label: "偏好", icon: <SlidersHorizontal /> },
    { id: "security", label: "安全", icon: <ShieldCheck /> },
    { id: "tokens", label: "令牌与 WebDAV", icon: <KeyRound /> },
    { id: "devices", label: "登录设备", icon: <Monitor /> },
  ];
  const cur: Tab = tabs.some((t) => t.id === tab) ? (tab as Tab) : "profile";
  return (
    <div className="mx-auto max-w-4xl space-y-5 py-6">
      <PageHeader title="账户设置" desc={`${me.username} · 管理资料、安全、访问令牌与登录设备`} />
      <Tabs tabs={tabs} value={cur} onChange={(t) => go(`#/account/${t}`)} />
      <div key={cur} className="anim-in space-y-4">
      {cur === "prefs" && (
        <Card title="界面偏好">
          <div className="divide-y divide-line text-[13px]" data-prefs>
            <PrefRow title="原地打开文件" desc="打开文件时替换当前标签页，而不是新开一个标签（保存在本浏览器）" checked={pf.openInPlace} onChange={(v) => prefs.set({ openInPlace: v })} />
            <PrefRow title="图片悬停预览" desc="在列表视图中鼠标停在图片上时，预览跟随光标浮现" checked={pf.hoverPreview} onChange={(v) => prefs.set({ hoverPreview: v })} />
            <PrefRow title="收起侧栏「收藏」分组" desc="也可直接点击侧栏中的分组标题切换" checked={pf.favsCollapsed} onChange={(v) => prefs.set({ favsCollapsed: v })} />
            <PrefRow title="收起侧栏「管理后台」分组" desc="仅管理员 / 有管理权限的用户可见" checked={pf.adminCollapsed} onChange={(v) => prefs.set({ adminCollapsed: v })} />
          </div>
        </Card>
      )}
      {cur === "profile" && (<>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard icon={<HardDrive />} label="已用空间" value={fmtSize(me.used_bytes)} hint={quota ? `配额 ${fmtSize(quota)}` : "不限额"} />
          <StatCard icon={<UsersIcon />} label="用户组" value={me.groups.length} tone="ok" hint={me.groups.map((g) => g.name).join("、") || "未加入用户组"} />
          <StatCard icon={<ShieldCheck />} label="两步验证" value={me.totp_enabled ? "已开启" : "未开启"} tone={me.totp_enabled ? "ok" : "warn"} hint={`${sess.length} 个登录设备`} />
        </div>
      <Card title="基本信息">
        <dl className="grid grid-cols-[6rem_1fr] gap-y-2 text-[13px]">
          <dt className="text-muted">用户名</dt>
          <dd>{me.username} <Badge tone="accent">{me.role}</Badge></dd>
          <dt className="text-muted">邮箱</dt>
          <dd>{me.email ?? "—"} {me.email && (me.email_verified ? <Badge tone="ok">已验证</Badge> : <Button size="sm" variant="ghost" onClick={() => act(() => call("POST", "/api/auth/email/resend"), "验证邮件已发送")}>发送验证邮件</Button>)}</dd>
          <dt className="text-muted">根目录</dt>
          <dd>{me.root_path}</dd>
          <dt className="text-muted">用户组</dt>
          <dd>{me.groups.length ? me.groups.map((g) => g.name).join("、") : "—"}</dd>
          <dt className="text-muted">已用空间</dt>
          <dd className="space-y-1">
            <span>{fmtSize(me.used_bytes)}{quota ? ` / ${fmtSize(quota)}` : "（不限额）"}</span>
            {quota ? <Progress value={me.used_bytes / quota} /> : null}
          </dd>
        </dl>
      </Card>
      </>)}
      {cur === "security" && (<>
      <Card title="修改密码">
        <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => (e.preventDefault(), act(async () => { tokens.set(await call("POST", "/api/auth/password/change", { old_password: pw.old || null, new_password: pw.next })); setPw({ old: "", next: "" }); }, "密码已修改，其他设备已下线"))}>
          {me.has_password && (
            <Field label="当前密码">
              <Input type="password" autoComplete="current-password" value={pw.old} onChange={(e) => setPw({ ...pw, old: e.target.value })} required />
            </Field>
          )}
          <Field label="新密码">
            <Input type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
          </Field>
          <Button type="submit" variant="primary">保存</Button>
        </form>
      </Card>

      <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> 两步验证 (TOTP) {me.totp_enabled ? <Badge tone="ok">已开启</Badge> : <Badge>未开启</Badge>}</span>}>
        {!me.totp_enabled && !totp && <Button onClick={() => startTotp().catch((e) => toast.err(errMsg(e)))}>开启两步验证</Button>}
        {totp && (
          <div className="flex flex-col gap-4 sm:flex-row">
            {totp.qr && <img src={totp.qr} alt="TOTP 二维码" width={180} height={180} className="rounded-lg border border-line bg-white" />}
            <div className="flex-1 space-y-3 text-[13px]">
              <p className="text-muted">用 Google Authenticator / 1Password 等扫码，或手动输入密钥：</p>
              <Secret value={totp.secret} />
              <form className="flex flex-wrap items-center gap-3" onSubmit={(e) => (e.preventDefault(), totpAct("/api/auth/totp/enable", "两步验证已开启", () => setTotp(null)))}>
                <OtpField value={code} onChange={(v) => (setCode(v), otp === "wrong" && setOtp("idle"))} onComplete={() => totpAct("/api/auth/totp/enable", "两步验证已开启", () => setTotp(null))} status={otp} label="验证码" />
                <Button type="submit" variant="primary" disabled={code.length < 6}>确认开启</Button>
              </form>
            </div>
          </div>
        )}
        {me.totp_enabled && (
          <form className="flex flex-wrap items-center gap-3" onSubmit={(e) => (e.preventDefault(), totpAct("/api/auth/totp/disable", "两步验证已关闭"))}>
            <OtpField value={code} onChange={(v) => (setCode(v), otp === "wrong" && setOtp("idle"))} status={otp} label="关闭验证码" />
            <Button type="submit" variant="danger" disabled={code.length < 6}>关闭</Button>
          </form>
        )}
      </Card>

      {status.oauth_providers.length > 0 && (
        <Card title="第三方登录">
          <ul className="space-y-2 text-[13px]">
            {status.oauth_providers.map((p) => {
              const linked = ids.find((i) => i.provider === p);
              return (
                <li key={p} className="flex items-center gap-2">
                  <span className="w-20 font-medium capitalize">{p}</span>
                  {linked ? (
                    <>
                      <Badge tone="ok">已绑定</Badge>
                      <span className="text-muted">{linked.email}</span>
                      <Button size="sm" className="ml-auto" onClick={() => act(() => call("DELETE", `/api/auth/identities/${p}`), "已解绑")}>解绑</Button>
                    </>
                  ) : (
                    <Button size="sm" className="ml-auto" onClick={() => link(p)}>绑定</Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      </>)}
      {cur === "tokens" && (<>
      <Card title={<span className="flex items-center gap-2"><KeyRound className="size-4" /> API Token</span>}>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), act(async () => { const r = await call("POST", "/api/auth/tokens", { name: tokName || "token", expires_in_days: tokDays ? Number(tokDays) : null }); setSecret({ kind: "token", v: r.token }); setTokName(""); }))}>
          <Input className="max-w-48" placeholder="名称，如 rclone" value={tokName} onChange={(e) => setTokName(e.target.value)} aria-label="Token 名称" />
          <Select value={tokDays} onChange={(e) => setTokDays(e.target.value)} aria-label="有效期">
            <option value="30">30 天</option>
            <option value="90">90 天</option>
            <option value="365">1 年</option>
            <option value="">永不过期</option>
          </Select>
          <Button type="submit"><Plus className="size-4" /> 新建</Button>
        </form>
        {secret?.kind === "token" && (<><p className="mt-3 text-xs text-warn">只显示一次，请立即保存：</p><Secret value={secret.v} /></>)}
        <ul className="mt-3 divide-y divide-line text-[13px]">
          {pt.slice.map((t) => (
            <li key={t.id} className="flex items-center gap-2 py-2">
              <span className="font-medium">{t.name}</span>
              <code className="text-xs text-faint">{t.prefix}…</code>
              <span className="ml-auto text-xs text-muted">{t.expires_at ? `到期 ${fmtTime(t.expires_at)}` : "永不过期"} · 最近使用 {fmtTime(t.last_used)}</span>
              <ConfirmButton iconOnly icon={<Trash2 />} label={`删除 Token ${t.name}`} confirmLabel="删除" onConfirm={() => act(() => call("DELETE", `/api/auth/tokens/${t.id}`))} />
            </li>
          ))}
        </ul>
        <Pager {...pt} />
      </Card>

      <Card title="WebDAV">
        <p className="text-[13px] text-muted">地址</p>
        <Secret value={`${location.origin}/dav/`} />
        <p className="mt-3 text-[13px] text-muted">用户名填 <b>{me.username}</b>，密码使用下面生成的应用专用密码（开启两步验证后不能用账户密码）。</p>
        <Button className="mt-3" onClick={() => act(async () => setSecret({ kind: "app", v: (await call("POST", "/api/auth/app-passwords", { name: `webdav-${new Date().toISOString().slice(0, 10)}` })).password }))}>
          <Plus className="size-4" /> 生成应用密码
        </Button>
        {secret?.kind === "app" && (<><p className="mt-3 text-xs text-warn">只显示一次，请立即保存：</p><Secret value={secret.v} /></>)}
        <ul className="mt-3 divide-y divide-line text-[13px]">
          {pa.slice.map((a) => (
            <li key={a.id} className="flex items-center gap-2 py-2">
              <span>{a.name}</span>
              <span className="ml-auto text-xs text-muted">最近使用 {fmtTime(a.last_used)}</span>
              <IconButton label="删除" onClick={() => act(() => call("DELETE", `/api/auth/app-passwords/${a.id}`))}>
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
        <Pager {...pa} />
      </Card>
      </>)}
      {cur === "devices" && (<>
      <Card title="登录设备">
        <ul className="divide-y divide-line text-[13px]">
          {ps.slice.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2">
              <Monitor className="size-4 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate">{s.user_agent || "未知设备"}</p>
                <p className="text-xs text-faint">{s.method} · {s.ip} · 最近活动 {fmtTime(s.last_used)}</p>
              </div>
              {s.current ? <Badge tone="accent">当前</Badge> : (
                <Button size="sm" onClick={() => act(() => call("DELETE", `/api/auth/sessions/${s.id}`), "已下线")}>
                  <LogOut className="size-4" /> 下线
                </Button>
              )}
            </li>
          ))}
        </ul>
        <Pager {...ps} />
      </Card>
      </>)}
      </div>
    </div>
  );
}

function PrefRow({ title, desc, checked, onChange }: { title: string; desc: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1"><p className="font-medium">{title}</p><p className="text-faint">{desc}</p></div>
      <Switch checked={checked} onChange={onChange} label={title} />
    </div>
  );
}
