import { useEffect, useState, type ReactNode } from "react";
import {
  FolderOpen, HardDrive, LayoutDashboard, ListChecks, LogIn, LogOut, Menu as MenuIcon, Monitor, Moon, ScrollText, Search, Settings, Shield, Sun, User, Users, X,
} from "lucide-react";
import { call, client, ok, tokens, WEB_VERSION, type FsItem } from "../lib/api";
import { useApp } from "../lib/app";
import { filesHref, type Route } from "../lib/router";
import type { ThemePref } from "../lib/theme";
import { cx } from "../lib/util";
import { IconButton, Menu, MenuItem } from "../ui/ui";
import { FileIcon } from "./FileIcon";

function NavLink({ href, icon, children, active }: { href: string; icon: ReactNode; children: ReactNode; active: boolean }) {
  return (
    <a href={href} aria-current={active ? "page" : undefined} className={cx("nav-item flex min-h-10 items-center gap-2.5 rounded-xl px-3 py-1.5 text-[14px] [&>svg]:size-[18px]", active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-hover hover:text-fg")}>
      {icon}
      <span className="truncate">{children}</span>
    </a>
  );
}

export function Layout({ route, theme, setTheme, children, serverVersion }: { route: Route; theme: ThemePref; setTheme: (t: ThemePref) => void; children: ReactNode; serverVersion?: string }) {
  const { me, isAdmin, openPalette, fsVersion, reload } = useApp();
  const [mounts, setMounts] = useState<FsItem[]>([]);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    ok(client.GET("/api/fs/list", { params: { query: { path: "/" } } })).then((r) => setMounts(r.items)).catch(() => setMounts([]));
  }, [me?.id, fsVersion]);
  useEffect(() => setDrawer(false), [route.name, route.rest]);
  const at = (name: string, rest?: string) => route.name === name && (rest === undefined || route.rest === rest);
  const filesPath = route.name === "files" ? "/" + route.rest : "";
  const logout = async () => {
    await call("POST", "/api/auth/logout").catch(() => {});
    tokens.set(null);
    sessionStorage.removeItem("dh_guest");
    reload();
  };
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  const nav = (
    <nav className="flex h-full flex-col gap-4 p-3" aria-label="主导航">
      <div className="flex items-center gap-2 px-1.5 pt-1">
        <span className="flex size-9 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-card"><HardDrive className="size-[18px]" /></span>
        <span className="flex-1 text-[17px] font-semibold tracking-tight">DriveHub</span>
        <button className="rounded-md p-1 text-muted hover:bg-hover lg:hidden" aria-label="关闭菜单" onClick={() => setDrawer(false)}><X className="size-4" /></button>
      </div>
      <button onClick={openPalette} className="btn-key flex h-10 items-center gap-2 rounded-xl border border-line bg-panel px-3 text-[13px] text-faint hover:text-muted">
        <Search className="size-4" /> <span className="flex-1 text-left">搜索…</span> <kbd className="text-[11px]">⌘K</kbd>
      </button>
      <div className="space-y-0.5">
        <NavLink href="#/files" icon={<FolderOpen />} active={at("files", "")}>全部文件</NavLink>
        {mounts.map((m) => (
          <a key={m.path} href={filesHref(m.path)} aria-current={filesPath.startsWith(m.path) ? "page" : undefined} className={cx("nav-item flex min-h-9 items-center gap-2.5 rounded-xl py-1.5 pr-2.5 pl-7 text-[13px]", filesPath === m.path || filesPath.startsWith(m.path + "/") ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
            <FileIcon name={m.name} isDir mountKind={m.mount_kind} className="size-4" />
            <span className="truncate">{m.name}</span>
          </a>
        ))}
        <NavLink href="#/search" icon={<Search />} active={at("search")}>搜索</NavLink>
        <NavLink href="#/tasks" icon={<ListChecks />} active={at("tasks")}>任务中心</NavLink>
        {me && <NavLink href="#/account" icon={<User />} active={at("account")}>账户设置</NavLink>}
      </div>
      {isAdmin && (
        <div className="space-y-0.5">
          <p className="px-3 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">管理后台</p>
          <NavLink href="#/admin/dashboard" icon={<LayoutDashboard />} active={at("admin", "dashboard")}>仪表盘</NavLink>
          <NavLink href="#/admin/mounts" icon={<HardDrive />} active={at("admin", "mounts")}>挂载点</NavLink>
          <NavLink href="#/admin/users" icon={<Users />} active={at("admin", "users")}>用户与用户组</NavLink>
          <NavLink href="#/admin/acl" icon={<Shield />} active={at("admin", "acl")}>目录权限</NavLink>
          <NavLink href="#/admin/audit" icon={<ScrollText />} active={at("admin", "audit")}>审计日志</NavLink>
          <NavLink href="#/admin/settings" icon={<Settings />} active={route.name === "admin" && route.rest.startsWith("settings")}>后台设置</NavLink>
        </div>
      )}
      <div className="mt-auto space-y-2">
        <Menu
          align="left"
          trigger={(t) => (
            <button onClick={t} className="btn-key flex min-h-12 w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-hover">
              <span className="flex size-7 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{(me?.username ?? "访")[0].toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{me?.username ?? "访客"}</span>
                <span className="block text-[11px] text-faint">{me ? me.role : "未登录"}</span>
              </span>
              <ThemeIcon className="size-4 text-faint" />
            </button>
          )}
        >
          {(close) => (
            <div className="bottom-full">
              {me && <MenuItem icon={<User />} onClick={() => (close(), (location.hash = "#/account"))}>账户设置</MenuItem>}
              <MenuItem icon={<Sun />} onClick={() => (close(), setTheme("light"))}>浅色{theme === "light" && " ✓"}</MenuItem>
              <MenuItem icon={<Moon />} onClick={() => (close(), setTheme("dark"))}>深色{theme === "dark" && " ✓"}</MenuItem>
              <MenuItem icon={<Monitor />} onClick={() => (close(), setTheme("system"))}>跟随系统{theme === "system" && " ✓"}</MenuItem>
              {me ? <MenuItem icon={<LogOut />} onClick={() => (close(), logout())}>退出登录</MenuItem> : <MenuItem icon={<LogIn />} onClick={() => (close(), sessionStorage.removeItem("dh_guest"), reload())}>登录</MenuItem>}
            </div>
          )}
        </Menu>
        <p className="px-2 text-[10.5px] text-faint">Web {WEB_VERSION} · Server {serverVersion ?? "…"}</p>
      </div>
    </nav>
  );

  const TITLES: Record<string, string> = { files: "文件", search: "搜索", tasks: "任务中心", account: "账户设置", admin: "管理后台" };
  const crumb = route.name === "files" ? (filesPath === "/" ? "全部文件" : filesPath.split("/").filter(Boolean).slice(-1)[0]) : TITLES[route.name] ?? "DriveHub";
  const nextTheme: ThemePref = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  return (
    <div className="flex h-full">
      <aside className="scroll-thin hidden w-64 shrink-0 overflow-y-auto lg:block">{nav}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="菜单">
          <div className="backdrop-in absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="drawer-in glass scroll-thin absolute inset-y-0 left-0 w-72 overflow-y-auto shadow-pop">{nav}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pr-3 lg:pb-3">
        <header className="glass sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line px-3 lg:h-16 lg:border-0 lg:bg-transparent lg:px-2 lg:backdrop-blur-none">
          <IconButton label="打开菜单" className="lg:hidden" onClick={() => setDrawer(true)}><MenuIcon className="size-5" /></IconButton>
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold tracking-tight lg:text-lg">{crumb}</h2>
          <button onClick={openPalette} className="btn-key hidden h-10 w-72 items-center gap-2 rounded-xl border border-line bg-panel px-3 text-[13px] text-faint hover:text-muted md:flex">
            <Search className="size-4" /> <span className="flex-1 text-left">搜索文件、页面…</span> <kbd className="rounded-md border border-line px-1.5 text-[11px]">⌘K</kbd>
          </button>
          <IconButton label="搜索" className="md:hidden" onClick={openPalette}><Search className="size-5" /></IconButton>
          <IconButton label={`主题：${theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统"}（点击切换）`} onClick={() => setTheme(nextTheme)}><ThemeIcon className="size-[18px]" /></IconButton>
        </header>
        <main id="main" className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-panel px-4 sm:px-8 lg:rounded-3xl lg:border lg:border-line lg:shadow-card">{children}</main>
      </div>
    </div>
  );
}
