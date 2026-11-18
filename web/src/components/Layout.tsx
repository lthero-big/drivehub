import { useEffect, useState, type ReactNode } from "react";
import {
  FolderOpen, HardDrive, LayoutDashboard, ListChecks, LogIn, LogOut, Menu as MenuIcon, Monitor, Moon, ScrollText, Search, Settings, Shield, Sun, User, Users, X, Share2,
} from "lucide-react";
import { call, client, ok, tokens, WEB_VERSION, type FsItem } from "../lib/api";
import { useApp } from "../lib/app";
import { filesHref, type Route } from "../lib/router";
import type { ThemePref } from "../lib/theme";
import { cx } from "../lib/util";
import { Menu, MenuItem } from "../ui/ui";
import { FileIcon } from "./FileIcon";

function NavLink({ href, icon, children, active }: { href: string; icon: ReactNode; children: ReactNode; active: boolean }) {
  return (
    <a href={href} aria-current={active ? "page" : undefined} className={cx("flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] [&>svg]:size-4", active ? "bg-active font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
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
        <span className="flex size-7 items-center justify-center rounded-lg bg-accent text-accent-fg"><HardDrive className="size-4" /></span>
        <span className="flex-1 font-semibold">DriveHub</span>
        <button className="rounded-md p-1 text-muted hover:bg-hover lg:hidden" aria-label="关闭菜单" onClick={() => setDrawer(false)}><X className="size-4" /></button>
      </div>
      <button onClick={openPalette} className="flex h-8 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[13px] text-faint hover:text-muted">
        <Search className="size-4" /> <span className="flex-1 text-left">搜索…</span> <kbd className="text-[11px]">⌘K</kbd>
      </button>
      <div className="space-y-0.5">
        <NavLink href="#/files" icon={<FolderOpen />} active={at("files", "")}>全部文件</NavLink>
        {mounts.map((m) => (
          <a key={m.path} href={filesHref(m.path)} aria-current={filesPath.startsWith(m.path) ? "page" : undefined} className={cx("flex items-center gap-2.5 rounded-lg py-1.5 pr-2.5 pl-5 text-[13px]", filesPath === m.path || filesPath.startsWith(m.path + "/") ? "bg-active font-medium" : "text-muted hover:bg-hover hover:text-fg")}>
            <FileIcon name={m.name} isDir mountKind={m.mount_kind} className="size-4" />
            <span className="truncate">{m.name}</span>
          </a>
        ))}
        <NavLink href="#/search" icon={<Search />} active={at("search")}>搜索</NavLink>
        <NavLink href="#/tasks" icon={<ListChecks />} active={at("tasks")}>任务中心</NavLink>
        {me && <NavLink href="#/shares" icon={<Share2 />} active={at("shares")}>我的分享</NavLink>}
      </div>
      {isAdmin && (
        <div className="space-y-0.5">
          <p className="px-2.5 pb-1 text-[11px] font-medium text-faint">管理</p>
          <NavLink href="#/admin/dashboard" icon={<LayoutDashboard />} active={at("admin", "dashboard")}>仪表盘</NavLink>
          <NavLink href="#/admin/mounts" icon={<HardDrive />} active={at("admin", "mounts")}>挂载点</NavLink>
          <NavLink href="#/admin/users" icon={<Users />} active={at("admin", "users")}>用户与用户组</NavLink>
          <NavLink href="#/admin/acl" icon={<Shield />} active={at("admin", "acl")}>目录权限</NavLink>
          <NavLink href="#/admin/audit" icon={<ScrollText />} active={at("admin", "audit")}>审计日志</NavLink>
          <NavLink href="#/admin/settings" icon={<Settings />} active={at("admin", "settings")}>全局设置</NavLink>
        </div>
      )}
      <div className="mt-auto space-y-2">
        <Menu
          align="left"
          trigger={(t) => (
            <button onClick={t} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover">
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
              {me && <MenuItem icon={<User />} onClick={() => (close(), (location.hash = "#/account"))}>账户与安全</MenuItem>}
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

  return (
    <div className="flex h-full">
      <aside className="scroll-thin hidden w-60 shrink-0 overflow-y-auto lg:block">{nav}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="菜单">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <aside className="anim-in scroll-thin absolute inset-y-0 left-0 w-72 overflow-y-auto bg-bg shadow-pop">{nav}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:py-2 lg:pr-2">
        <header className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 lg:hidden">
          <button className="rounded-md p-1.5 hover:bg-hover" aria-label="打开菜单" onClick={() => setDrawer(true)}><MenuIcon className="size-5" /></button>
          <span className="flex-1 font-semibold">DriveHub</span>
          <button className="rounded-md p-1.5 hover:bg-hover" aria-label="搜索" onClick={openPalette}><Search className="size-5" /></button>
        </header>
        <main id="main" className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-panel px-3 sm:px-6 lg:rounded-xl lg:border lg:border-line">{children}</main>
      </div>
    </div>
  );
}
