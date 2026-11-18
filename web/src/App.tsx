import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { call, client, CLIENT_HEADERS, ok, tokens, type AuthStatus, type VersionInfo } from "./lib/api";
import { Ctx } from "./lib/app";
import { useRoute } from "./lib/router";
import { useTheme } from "./lib/theme";
import { Button, Overlays, Spinner } from "./ui/ui";
import { AuthPage, TokenPage } from "./pages/Auth";
import { Layout } from "./components/Layout";
import { FilesArea } from "./components/Editor";
import { UploadQueue } from "./components/UploadQueue";
import { CommandPalette } from "./components/CommandPalette";

const SearchPage = lazy(() => import("./pages/Search").then((m) => ({ default: m.SearchPage })));
const TasksPage = lazy(() => import("./pages/Tasks").then((m) => ({ default: m.TasksPage })));
const AccountPage = lazy(() => import("./pages/Account").then((m) => ({ default: m.AccountPage })));
const DashboardPage = lazy(() => import("./pages/admin/Dashboard").then((m) => ({ default: m.DashboardPage })));
const MountsPage = lazy(() => import("./pages/admin/Mounts").then((m) => ({ default: m.MountsPage })));
const UsersPage = lazy(() => import("./pages/admin/Users").then((m) => ({ default: m.UsersPage })));
const AclPage = lazy(() => import("./pages/admin/Acl").then((m) => ({ default: m.AclPage })));
const AuditPage = lazy(() => import("./pages/admin/Audit").then((m) => ({ default: m.AuditPage })));
const SettingsPage = lazy(() => import("./pages/admin/Settings").then((m) => ({ default: m.SettingsPage })));

type Compat = { status: string; min_version?: string; reason?: string };

export default function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [ver, setVer] = useState<VersionInfo | null>(null);
  const [compat, setCompat] = useState<Compat | null>(null);
  const [palette, setPalette] = useState(false);
  const [fsVersion, setFsVersion] = useState(0);
  const [guest, setGuest] = useState(() => sessionStorage.getItem("dh_guest") === "1");
  const [oauthTicket, setOauthTicket] = useState<string | null>(null);
  const [oauthErr, setOauthErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    setGuest(sessionStorage.getItem("dh_guest") === "1");
    call<AuthStatus>("GET", "/api/auth/status")
      .then((s) => (setStatus(s), setFailed(false)))
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    // OAuth callback lands on #/oauth?access_token=…|totp_ticket=…|error=…
    if (route.name === "oauth") {
      const at = route.q.get("access_token");
      if (at) {
        tokens.set({ access_token: at, refresh_token: route.q.get("refresh_token") ?? "" });
        location.hash = "#/files";
      } else if (route.q.get("totp_ticket")) setOauthTicket(route.q.get("totp_ticket"));
      else if (route.q.get("error")) {
        setOauthErr(route.q.get("error"));
        location.hash = "#/files";
      }
    }
    ok(client.GET("/api/version")).then(setVer).catch(() => {});
    fetch("/api/v1/health", { headers: CLIENT_HEADERS }).then(async (r) => {
      if (r.status === 426 || r.status === 400) setCompat(await r.json());
    });
    reload();
    return tokens.subscribe(reload);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  const me = status?.me ?? null;
  const ctx = useMemo(
    () =>
      status && {
        status,
        me,
        isAdmin: me?.role === "admin" || !status.initialized,
        reload,
        openPalette: () => setPalette(true),
        fsVersion,
        bumpFs: () => setFsVersion((v) => v + 1),
      },
    [status, me, reload, fsVersion],
  );

  const banner = compat && compat.status !== "ok" && (
    <div role="alert" className="bg-warn/15 px-4 py-2 text-center text-[13px] text-warn">
      {compat.status === "client_too_old" && `Web 版本过旧，请刷新或升级到 ${compat.min_version} 以上`}
      {compat.status === "server_too_old" && "服务端版本过旧，请升级服务端"}
      {compat.status === "invalid" && `版本号无效：${compat.reason}`}
    </div>
  );

  if ((route.name === "verify" || route.name === "reset") && route.q.get("token"))
    return (
      <>
        <TokenPage kind={route.name} token={route.q.get("token")!} />
        <Overlays />
      </>
    );
  if (!status || !ctx)
    return (
      <div className="flex h-full items-center justify-center">
        {failed ? <p className="text-sm text-danger">无法连接服务器，请稍后刷新</p> : <Spinner />}
      </div>
    );
  if (!status.initialized || oauthTicket || (!me && !guest))
    return (
      <Ctx.Provider value={ctx}>
        {banner}
        {oauthErr && <p className="bg-danger/10 px-4 py-2 text-center text-[13px] text-danger">第三方登录失败：{oauthErr}</p>}
        <AuthPage status={status} onDone={() => (setOauthTicket(null), reload())} totpTicket={oauthTicket} />
        {status.initialized && !oauthTicket && (
          <p className="-mt-6 pb-8 text-center text-[13px]">
            <Button variant="ghost" size="sm" onClick={() => (sessionStorage.setItem("dh_guest", "1"), setGuest(true))}>以访客身份浏览公开目录</Button>
          </p>
        )}
        <Overlays />
      </Ctx.Provider>
    );

  const admin = ctx.isAdmin;
  const page = (() => {
    switch (route.name) {
      case "search":
        return <SearchPage initial={route.q.get("q") ?? ""} />;
      case "tasks":
        return <TasksPage />;
      case "account":
        return me ? <AccountPage tab={route.rest} /> : null;
      case "admin":
        if (!admin) return <p className="py-10 text-center text-sm text-muted">仅管理员可用</p>;
        return (
          <div className="mx-auto max-w-6xl py-4">
            {route.rest === "mounts" ? <MountsPage /> : route.rest === "users" ? <UsersPage /> : route.rest === "acl" ? <AclPage initialPath={route.q.get("path") ?? "/"} /> : route.rest === "audit" ? <AuditPage /> : route.rest.split("/")[0] === "settings" ? <SettingsPage tab={route.rest.split("/")[1]} /> : <DashboardPage />}
          </div>
        );
      default:
        return <FilesArea path={"/" + route.rest} openParam={route.q.get("open")} />;
    }
  })();

  return (
    <Ctx.Provider value={ctx}>
      <div className="flex h-full flex-col">
        {banner}
        <div className="min-h-0 flex-1">
          <Layout route={route} theme={theme} setTheme={setTheme} serverVersion={ver?.server_version}>
            <Suspense fallback={<div className="flex justify-center py-20"><Spinner /></div>}><div key={route.name === "admin" ? `admin/${route.rest.split("/")[0]}` : route.name} className="page-in h-full">{page}</div></Suspense>
          </Layout>
        </div>
      </div>
      <UploadQueue />
      <CommandPalette open={palette} onClose={() => setPalette(false)} setTheme={setTheme} />
      <Overlays />
    </Ctx.Provider>
  );
}
