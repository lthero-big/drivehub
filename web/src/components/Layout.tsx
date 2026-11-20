import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronsUpDown, FolderOpen, HardDrive, LayoutDashboard, ListChecks, LogIn, LogOut, Menu as MenuIcon, Monitor, Moon, PanelLeftClose, PanelLeftOpen, ScrollText, Search, Settings, Shield, Star, Sun, User, Users, X,
  BadgeCheck, Share2, ChevronRight, BarChart3, ArrowUpCircle,
} from "lucide-react";
import { call, client, ok, tokens, WEB_VERSION, type FsItem } from "../lib/api";
import { useApp } from "../lib/app";
import { useFavorites } from "../lib/favs";
import { prefs, usePrefs } from "../lib/prefs";
import { filesHref, go, type Route } from "../lib/router";
import { tabs } from "../lib/tabs";
import type { ThemePref } from "../lib/theme";
import { cx } from "../lib/util";
import { IconButton, Menu, MenuItem } from "../ui/ui";
import { FileIcon } from "./FileIcon";

function NavLink({ href, icon, children, active, mini, onClick }: { href: string; icon: ReactNode; children: ReactNode; active: boolean; mini?: boolean; onClick?: () => void }) {
  return (
    <a href={href} onClick={onClick} title={mini ? String(children) : undefined} aria-label={mini ? String(children) : undefined} aria-current={active ? "page" : undefined} className={cx("nav-item flex min-h-10 items-center gap-2.5 rounded-xl py-1.5 text-[14px] [&>svg]:size-[18px] [&>svg]:shrink-0", mini ? "justify-center px-0" : "px-3", active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-hover hover:text-fg")}>
      {icon}
      {!mini && <span className="truncate">{children}</span>}
    </a>
  );
}

/** Light / dark / system segmented switch with a sliding thumb (lives in the top bar). */
function ThemeSwitch({ theme, setTheme }: { theme: ThemePref; setTheme: (t: ThemePref) => void }) {
  const opts = [
    ["light", Sun, "浅色"],
    ["dark", Moon, "深色"],
    ["system", Monitor, "跟随系统"],
  ] as const;
  const i = opts.findIndex((o) => o[0] === theme);
  return (
    <div role="radiogroup" aria-label="主题" className="relative flex h-9 shrink-0 items-center rounded-xl border border-line bg-panel-2 p-0.5">
      <span aria-hidden className="theme-seg-ind absolute top-0.5 left-0.5 size-[30px] rounded-[9px] border border-line bg-panel shadow-card" style={{ transform: `translateX(${i * 30}px)` }} />
      {opts.map(([v, I, l]) => (
        <button key={v} role="radio" aria-checked={theme === v} aria-label={l} title={l} onClick={() => setTheme(v)} className={cx("relative z-[1] flex size-[30px] items-center justify-center rounded-[9px] transition-colors", theme === v ? "text-fg" : "text-faint hover:text-fg")}>
          <I className="size-4" />
        </button>
      ))}
    </div>
  );
}

/** Favorites shown before "查看全部" (the rest live in a scroll area once expanded). */
const FAV_LIMIT = 6;


function NavSection({
  id, title, icon, count, collapsed, onToggle, mini, href, hrefActive, onHrefClick, showToggle, showMiniLine, children, footer,
}: {
  id: string; title: string; icon?: ReactNode; count?: number; collapsed: boolean; onToggle: () => void; mini: boolean;
  href?: string; hrefActive?: boolean; onHrefClick?: () => void; showToggle?: boolean; showMiniLine?: boolean; children: ReactNode; footer?: ReactNode;
}) {
  const bodyId = `nav-${id}`;
  const toggleLabel = collapsed ? `展开${title}` : `收起${title}`;
  const headCls = "sec-head flex w-full items-center gap-1 rounded-lg px-3 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-faint";
  const chevron = <ChevronRight className={cx("size-3 transition-transform duration-200", !collapsed && "rotate-90")} />;
  return (
    <div data-sec={id}>
      {!mini ? (
        href ? (
          <div className={headCls}>
            {showToggle !== false && (
              <button type="button" aria-expanded={!collapsed} aria-controls={bodyId} aria-label={toggleLabel} data-files-toggle={id === "files" ? "" : undefined} data-sec-toggle={id} onClick={onToggle} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-hover hover:text-fg">
                {chevron}
              </button>
            )}
            <a href={href} onClick={onHrefClick} aria-current={hrefActive ? "page" : undefined} className={cx("flex min-w-0 flex-1 items-center gap-1 rounded-md py-0.5 hover:text-fg", hrefActive && "text-accent")}>
              {icon}<span className="truncate">{title}</span>
            </a>
            {count != null && <span className="font-normal tabular-nums">{count}</span>}
          </div>
        ) : (
          <button type="button" aria-expanded={!collapsed} aria-controls={bodyId} onClick={onToggle} className={cx(headCls, "hover:text-fg")}>
            {chevron}{icon}{title}{count != null && <span className="ml-auto font-normal tabular-nums">{count}</span>}
          </button>
        )
      ) : showMiniLine !== false ? <div className="mx-3 h-px bg-line" /> : null}
      <div id={bodyId} className="sec-body" data-closed={collapsed && !mini ? "" : undefined}>
        <div className="min-h-0 overflow-hidden">
          {children}
          {footer}
        </div>
      </div>
    </div>
  );
}

const useCollapsed = (): [boolean, (v: boolean) => void] => {
  const [v, set] = useState(() => localStorage.getItem("dh_sidebar_collapsed") === "1");
  return [v, (x) => (set(x), localStorage.setItem("dh_sidebar_collapsed", x ? "1" : "0"))];
};

export function Layout({ route, theme, setTheme, children, serverVersion, updateAvailable }: { route: Route; theme: ThemePref; setTheme: (t: ThemePref) => void; children: ReactNode; serverVersion?: string; updateAvailable?: boolean }) {
  const { me, isAdmin, openPalette, fsVersion, reload } = useApp();
  const caps: string[] = me?.caps ?? [];
  const can = (c: string) => isAdmin || caps.includes(c);
  const [mounts, setMounts] = useState<FsItem[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useCollapsed();
  const favs = useFavorites();
  const pf = usePrefs();
  useEffect(() => {
    ok(client.GET("/api/fs/list", { params: { query: { path: "/" } } })).then((r) => setMounts(r.items)).catch(() => setMounts([]));
  }, [me?.id, fsVersion]);
  useEffect(() => setDrawer(false), [route.name, route.rest]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b" && !(e.target as HTMLElement).closest("input,textarea")) {
        e.preventDefault();
        setCollapsed(localStorage.getItem("dh_sidebar_collapsed") !== "1");
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const at = (name: string, rest?: string) => route.name === name && (rest === undefined || route.rest === rest);
  const filesPath = route.name === "files" ? "/" + route.rest : "";
  const logout = async () => {
    await call("POST", "/api/auth/logout").catch(() => {});
    tokens.set(null);
    sessionStorage.removeItem("dh_guest");
    reload();
  };
  const toFolder = () => tabs.activate(null);

  const nav = (mini: boolean) => (
    <nav className={cx("flex h-full flex-col gap-4 py-3", mini ? "px-2" : "px-3")} aria-label="主导航">
      <div className={cx("flex items-center gap-2 pt-1", mini ? "justify-center" : "px-1.5")}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg shadow-card"><HardDrive className="size-[18px]" /></span>
        {!mini && <span className="flex-1 text-[17px] font-semibold tracking-tight">DriveHub</span>}
        {!mini && <button className="rounded-md p-1 text-muted hover:bg-hover lg:hidden" aria-label="关闭菜单" onClick={() => setDrawer(false)}><X className="size-4" /></button>}
      </div>
      <div className="space-y-0.5">
        <NavSection id="files" title="全部文件" icon={<FolderOpen className="size-3" />} collapsed={pf.filesCollapsed} onToggle={() => prefs.set({ filesCollapsed: !pf.filesCollapsed })} mini={mini} href="#/files" hrefActive={at("files", "")} onHrefClick={toFolder} showToggle={!mini && mounts.length > 0} showMiniLine={false}>
          <div className={cx("min-h-0 space-y-0.5 overflow-hidden", !mini && "nav-tree")}>
          {mini && <NavLink mini={mini} href="#/files" icon={<FolderOpen />} active={at("files", "")} onClick={toFolder}>全部文件</NavLink>}
          {mounts.map((m) => {
            const on = filesPath === m.path || filesPath.startsWith(m.path + "/");
            return (
              <a key={m.path} href={filesHref(m.path)} onClick={toFolder} title={m.name} tabIndex={pf.filesCollapsed && !mini ? -1 : undefined} aria-label={mini ? m.name : undefined} aria-current={on ? "page" : undefined} className={cx("nav-item flex min-h-9 items-center gap-2.5 rounded-xl py-1.5 text-[13px]", mini ? "justify-center" : "pr-2.5 pl-3", on ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                <FileIcon name={m.name} isDir mountKind={m.mount_kind} className="size-4" />
                {!mini && <span className="truncate">{m.name}</span>}
              </a>
            );
          })}
          </div>
        </NavSection>
        <NavLink mini={mini} href="#/search" icon={<Search />} active={at("search")}>搜索</NavLink>
        <NavLink mini={mini} href="#/tasks" icon={<ListChecks />} active={at("tasks")}>任务中心</NavLink>
        {me && <NavLink mini={mini} href="#/shares" icon={<Share2 />} active={at("shares")}>我的分享</NavLink>}
        {me && <NavLink mini={mini} href="#/stats" icon={<BarChart3 />} active={at("stats")}>访问统计</NavLink>}
        {me && <NavLink mini={mini} href="#/account" icon={<User />} active={at("account")}>账户设置</NavLink>}
      </div>
      {favs.length > 0 && (
        <NavSection id="favs" title="收藏" icon={<Star className="size-3" />} count={favs.length} collapsed={pf.favsCollapsed} onToggle={() => prefs.set({ favsCollapsed: !pf.favsCollapsed })} mini={mini} footer={!mini && favs.length > FAV_LIMIT ? (
            <button type="button" data-favs-more tabIndex={pf.favsCollapsed ? -1 : undefined} onClick={() => prefs.set({ favsShowAll: !pf.favsShowAll })} className="ml-7 flex min-h-8 items-center gap-1 rounded-lg px-2 text-[12px] text-accent hover:bg-hover">
              {pf.favsShowAll ? "只显示前 " + FAV_LIMIT + " 个" : "查看全部 " + favs.length + " 个"}
            </button>
          ) : undefined}>
          <div className={cx("space-y-0.5", !mini && "nav-tree", !mini && pf.favsShowAll && favs.length > FAV_LIMIT && "scroll-thin max-h-72 overflow-y-auto")} data-favs-list data-favs-shown={mini || pf.favsShowAll ? favs.length : Math.min(FAV_LIMIT, favs.length)}>
          {(mini || pf.favsShowAll ? favs : favs.slice(0, FAV_LIMIT)).map((f) => (
            <a
              key={f.path}
              href={f.is_dir ? filesHref(f.path) : filesHref(f.path.slice(0, f.path.lastIndexOf("/")) || "/")}
              onClick={() => (f.is_dir ? toFolder() : tabs.open({ ...f, size: 0, is_dir: false }))}
              title={f.path}
              tabIndex={pf.favsCollapsed && !mini ? -1 : undefined}
              data-fav-item
              className={cx("nav-item flex min-h-9 items-center gap-2.5 rounded-xl py-1.5 text-[13px] text-muted hover:bg-hover hover:text-fg", mini ? "justify-center" : "pr-2.5 pl-3")}
            >
              <FileIcon name={f.name} isDir={f.is_dir} className="size-4" />
              {!mini && <span className="truncate">{f.name}</span>}
            </a>
          ))}
          </div>
        </NavSection>
      )}
      {(isAdmin || caps.length > 0) && (
        <NavSection id="admin" title="管理后台" icon={<Shield className="size-3" />} collapsed={pf.adminCollapsed} onToggle={() => prefs.set({ adminCollapsed: !pf.adminCollapsed })} mini={mini}>
          <div className="min-h-0 space-y-0.5 overflow-hidden">
          {isAdmin && <NavLink mini={mini} href="#/admin/dashboard" icon={<LayoutDashboard />} active={at("admin", "dashboard")}>仪表盘</NavLink>}
          {can("admin_mounts") && <NavLink mini={mini} href="#/admin/mounts" icon={<HardDrive />} active={at("admin", "mounts")}>挂载点</NavLink>}
          {can("admin_users") && <NavLink mini={mini} href="#/admin/users" icon={<User />} active={at("admin", "users")}>用户</NavLink>}
          {can("admin_groups") && <NavLink mini={mini} href="#/admin/groups" icon={<Users />} active={at("admin", "groups")}>用户组</NavLink>}
          {can("admin_roles") && <NavLink mini={mini} href="#/admin/roles" icon={<BadgeCheck />} active={at("admin", "roles")}>角色</NavLink>}
          {can("admin_acl") && <NavLink mini={mini} href="#/admin/acl" icon={<Shield />} active={at("admin", "acl")}>目录权限</NavLink>}
          {can("admin_audit") && <NavLink mini={mini} href="#/admin/audit" icon={<ScrollText />} active={at("admin", "audit")}>审计日志</NavLink>}
          {isAdmin && <NavLink mini={mini} href="#/admin/update" icon={<ArrowUpCircle />} active={at("admin", "update")}><span className="flex items-center gap-1.5">系统更新{updateAvailable && <span className="size-1.5 rounded-full bg-accent" aria-label="有可用更新" />}</span></NavLink>}
          {can("admin_settings") && <NavLink mini={mini} href="#/admin/settings" icon={<Settings />} active={route.name === "admin" && route.rest.startsWith("settings")}>后台设置</NavLink>}
          </div>
        </NavSection>
      )}
      <div className="mt-auto space-y-2">
        <Menu
          align="left"
          side="top"
          matchWidth={!mini}
          className="block"
          trigger={(t) => (
            <button onClick={t} aria-label="账户菜单" className={cx("btn-key flex min-h-12 w-full items-center gap-2 rounded-xl py-1.5 text-left hover:bg-hover", mini ? "justify-center px-0" : "px-2")}>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{(me?.username ?? "访")[0].toUpperCase()}</span>
              {!mini && (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{me?.username ?? "访客"}</span>
                    <span className="block text-[11px] text-faint">{me ? me.role : "未登录"}</span>
                  </span>
                  <ChevronsUpDown className="size-4 text-faint" />
                </>
              )}
            </button>
          )}
        >
          {(close) => (
            <div>
              {me && <MenuItem icon={<User />} onClick={() => (close(), go("#/account"))}>账户设置</MenuItem>}
              {me ? <MenuItem icon={<LogOut />} onClick={() => (close(), logout())}>退出登录</MenuItem> : <MenuItem icon={<LogIn />} onClick={() => (close(), sessionStorage.removeItem("dh_guest"), reload())}>登录</MenuItem>}
            </div>
          )}
        </Menu>
        <button type="button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "展开侧栏" : "收起侧栏"} data-sidebar-toggle className={cx("max-lg:hidden flex min-h-9 w-full items-center gap-2 rounded-xl py-1.5 text-[12.5px] text-faint hover:bg-hover hover:text-fg", mini ? "justify-center" : "px-3")}>
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}{!mini && "收起侧栏"}
        </button>
        {!mini && <p className="px-2 text-[10.5px] text-faint">Web {WEB_VERSION} · Server {serverVersion ?? "…"}</p>}
      </div>
    </nav>
  );

  const TITLES: Record<string, string> = { stats: "访问统计", shares: "我的分享", files: "文件", search: "搜索", tasks: "任务中心", account: "账户设置", admin: "管理后台" };
  const crumb = route.name === "files" ? (filesPath === "/" ? "全部文件" : filesPath.split("/").filter(Boolean).slice(-1)[0]) : TITLES[route.name] ?? "DriveHub";
  return (
    <div className="flex h-full bg-panel">
      <aside aria-label="侧栏" data-collapsed={collapsed ? "" : undefined} className={cx("sidebar scroll-thin hidden shrink-0 overflow-x-hidden overflow-y-auto border-r border-line bg-panel lg:block", collapsed ? "w-[68px]" : "w-64")}>{nav(collapsed)}</aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="菜单">
          <div className="backdrop-in absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="drawer-in scroll-thin absolute inset-y-0 left-0 w-72 overflow-y-auto border-r border-line bg-panel shadow-pop">{nav(false)}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 lg:px-4">
          <IconButton label="打开菜单" className="lg:hidden" onClick={() => setDrawer(true)}><MenuIcon className="size-5" /></IconButton>
          <IconButton label={collapsed ? "展开侧栏（Ctrl/⌘ B）" : "收起侧栏（Ctrl/⌘ B）"} aria-expanded={!collapsed} className="max-lg:hidden" onClick={() => setCollapsed(!collapsed)}>
            {collapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
          </IconButton>
          <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight">{crumb}</h2>
          <IconButton label="搜索（⌘K）" onClick={openPalette}><Search className="size-[18px]" /></IconButton>
          <ThemeSwitch theme={theme} setTheme={setTheme} />
        </header>
        <main id="main" className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-panel px-4 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
