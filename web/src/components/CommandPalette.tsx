import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSpring } from "../ui/r5";
import { Command, FolderOpen, Moon, Search, Settings, Sun, Users, HardDrive, ListChecks, Shield, ScrollText, User, LayoutDashboard, Monitor, Share2, BarChart3, BadgeCheck, SlidersHorizontal } from "lucide-react";
import { client, ok, type FsItem, type SearchHit } from "../lib/api";
import { useApp } from "../lib/app";
import { filesHref, go } from "../lib/router";
import { tabs } from "../lib/tabs";
import type { ThemePref } from "../lib/theme";
import { cx, fmtSize } from "../lib/util";
import { FileIcon } from "./FileIcon";

/** Fuzzy rank (interior command palette; nav items also match English / pinyin-initial keywords): all query chars must appear in order; first char,
 *  word-boundary and consecutive hits score higher, gaps cost a little. -1 = no match. */
export function fuzzyScore(label: string, query: string): number {
  const l = label.toLowerCase(), q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  let score = 0, li = 0, prev = -2;
  for (const ch of q) {
    const at = l.indexOf(ch, li);
    if (at < 0) return -1;
    if (at === 0) score += 10;
    else if (/[\s\-_./()·（）]/.test(l[at - 1])) score += 6;
    if (at === prev + 1) score += 4;
    score += 1 - Math.min(3, at - li) * 0.25;
    prev = at;
    li = at + 1;
  }
  return score - l.length * 0.01;
}

type Item = { id: string; label: string; hint?: string; kw?: string; icon: ReactNode; run: () => void; group: string };

/** ⌘K / Ctrl+K command palette: navigation, actions, and live file search. */
export function CommandPalette({ open, onClose, setTheme }: { open: boolean; onClose: () => void; setTheme: (t: ThemePref) => void }) {
  const { isAdmin, me } = useApp();
  const caps = me?.caps ?? [];
  const can = (c: string) => isAdmin || caps.includes(c);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [mounts, setMounts] = useState<FsItem[]>([]);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    setTimeout(() => input.current?.focus(), 0);
    ok(client.GET("/api/fs/list", { params: { query: { path: "/" } } })).then((r) => setMounts(r.items)).catch(() => {});
  }, [open]);
  useEffect(() => {
    if (!open || q.trim().length < 1) return setHits([]);
    const t = setTimeout(() => {
      ok(client.GET("/api/search", { params: { query: { q, limit: 8 } } }))
        .then((r) => setHits(r.hits))
        .catch(() => setHits([]));
    }, 160);
    return () => clearTimeout(t);
  }, [q, open]);

  const items = useMemo<Item[]>(() => {
    const nav: Item[] = [
      { id: "files", group: "跳转", label: "全部文件", kw: "files qbwj", icon: <FolderOpen />, run: () => go("#/files") },
      ...mounts.map((m) => ({ id: `m:${m.path}`, group: "跳转", label: m.name, hint: m.mount_kind ?? "", icon: <HardDrive />, run: () => go(filesHref(m.path)) })),
      { id: "search", group: "跳转", label: "高级搜索", kw: "search gjss", icon: <Search />, run: () => go(`#/search?q=${encodeURIComponent(q)}`) },
      { id: "tasks", group: "跳转", label: "任务中心", kw: "tasks rwzx", icon: <ListChecks />, run: () => go("#/tasks") },
      ...(me
        ? [
            { id: "shares", group: "跳转", label: "我的分享", kw: "shares wdfx", icon: <Share2 />, run: () => go("#/shares") },
            { id: "stats", group: "跳转", label: "访问统计", kw: "stats fwtj", icon: <BarChart3 />, run: () => go("#/stats") },
            { id: "account", group: "跳转", label: "账户与安全", kw: "account security zhyaq", icon: <User />, run: () => go("#/account") },
            { id: "prefs", group: "跳转", label: "界面偏好（原地打开文件等）", kw: "prefs settings jmph", icon: <SlidersHorizontal />, run: () => go("#/account/prefs") },
          ]
        : []),
      ...(isAdmin ? [{ id: "dash", group: "管理", label: "仪表盘", kw: "dashboard ybp", icon: <LayoutDashboard />, run: () => go("#/admin/dashboard") }] : []),
      ...(can("admin_mounts") ? [{ id: "mounts", group: "管理", label: "挂载点", kw: "mounts gzd", icon: <HardDrive />, run: () => go("#/admin/mounts") }] : []),
      ...(can("admin_users") ? [{ id: "users", group: "管理", label: "用户", kw: "users yh", icon: <User />, run: () => go("#/admin/users") }] : []),
      ...(can("admin_groups") ? [{ id: "groups", group: "管理", label: "用户组", kw: "groups yhz", icon: <Users />, run: () => go("#/admin/groups") }] : []),
      ...(can("admin_roles") ? [{ id: "roles", group: "管理", label: "角色与权限", kw: "roles permissions jsyqx", icon: <BadgeCheck />, run: () => go("#/admin/roles") }] : []),
      ...(can("admin_acl") ? [{ id: "acl", group: "管理", label: "目录权限 (ACL)", kw: "acl mlqx", icon: <Shield />, run: () => go("#/admin/acl") }] : []),
      ...(can("admin_audit") ? [{ id: "audit", group: "管理", label: "审计日志", kw: "audit sjrz", icon: <ScrollText />, run: () => go("#/admin/audit") }] : []),
      ...(can("admin_settings") ? [{ id: "settings", group: "管理", label: "全局设置", kw: "settings qjsz", icon: <Settings />, run: () => go("#/admin/settings") }] : []),
      { id: "t-light", group: "外观", label: "浅色模式", kw: "light theme qsms", icon: <Sun />, run: () => setTheme("light") },
      { id: "t-dark", group: "外观", label: "深色模式", kw: "dark theme ssms", icon: <Moon />, run: () => setTheme("dark") },
      { id: "t-sys", group: "外观", label: "跟随系统", kw: "system theme gsxt", icon: <Monitor />, run: () => setTheme("system") },
    ];
    const s = q.trim();
    // empty query → original order; otherwise rank by fuzzy score (label, then hint)
    const filtered = s
      ? nav
          .map((i) => ({ i, sc: Math.max(fuzzyScore(i.label, s), fuzzyScore(i.hint ?? "", s) - 3, ...(i.kw ?? "").split(" ").map((w) => fuzzyScore(w, s) - 1)) }))
          .filter((x) => x.sc >= 0)
          .sort((a, b) => b.sc - a.sc)
          .map((x) => ({ ...x.i, group: "命令" }))
      : nav;
    const files: Item[] = hits.map((h) => ({
      id: `f:${h.path}`,
      group: "文件",
      label: h.name,
      hint: `${h.path}${h.is_dir ? "" : ` · ${fmtSize(h.size)}`}`,
      icon: <FileIcon name={h.name} isDir={h.is_dir} className="size-4" />,
      run: () => (h.is_dir ? go(filesHref(h.path)) : (tabs.open({ path: h.path, name: h.name, size: h.size, modified_unix: h.modified_unix, is_dir: false }), go(filesHref(h.path.slice(0, h.path.lastIndexOf("/")) || "/")))),
    }));
    return [...files, ...filtered];
  }, [q, hits, mounts, isAdmin, me, setTheme]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [q, hits.length]);
  // spring highlight (stiffness 520 / damping 34 / mass 0.45) slides to the active row
  const listRef = useRef<HTMLUListElement>(null);
  const hl = useRef<HTMLDivElement>(null);
  const [hy, setHy] = useState(0);
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    if (!row) return;
    setHy(row.offsetTop);
    row.scrollIntoView({ block: "nearest" });
  }, [active, items, open]);
  useSpring(hy, { k: 520, d: 34, m: 0.45 }, (v) => hl.current && (hl.current.style.transform = `translate3d(0,${v}px,0)`));
  // panel in: spring 420 / 36 / 0.9 on scale + opacity
  const panel = useRef<HTMLDivElement>(null);
  useSpring(open ? 1 : 0, { k: 420, d: 36, m: 0.9 }, (v) => panel.current && ((panel.current.style.opacity = String(Math.min(1, Math.max(0, v)))), (panel.current.style.transform = `translateY(${(1 - v) * -8}px) scale(${0.96 + 0.04 * v})`)));
  if (!open) return null;
  const run = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };
  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-3 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label="命令面板" data-palette className="cp-panel w-full max-w-xl overflow-hidden border border-line bg-panel shadow-pop" style={{ opacity: 0 }}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const n = items.length;
              if (e.key === "ArrowDown") (e.preventDefault(), n && setActive((a) => (a + 1) % n));
              else if (e.key === "ArrowUp") (e.preventDefault(), n && setActive((a) => (a - 1 + n) % n));
              else if (e.key === "Home" && !q) (e.preventDefault(), setActive(0));
              else if (e.key === "End" && !q) (e.preventDefault(), setActive(Math.max(0, n - 1)));
              else if (e.key === "Enter") (e.preventDefault(), q.trim() && !items.length ? (onClose(), go(`#/search?q=${encodeURIComponent(q)}`)) : run(items[active]));
              else if (e.key === "Escape") onClose();
            }}
            placeholder="搜索文件、跳转页面、执行命令…  支持 ext:pdf size:>10m mount:名称"
            aria-label="命令或搜索"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-faint">Esc</kbd>
        </div>
        <ul ref={listRef} role="listbox" className="cp-list scroll-thin relative max-h-[calc(6*38px+40px)] overflow-auto sm:max-h-[55vh]">
          {items.length > 0 && <div ref={hl} className="cp-hl" aria-hidden data-cp-hl />}
          {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">回车进行高级搜索「{q}」</li>}
          {items.map((i, idx) => {
            const head = i.group !== lastGroup ? ((lastGroup = i.group), <li key={`g-${i.group}`} className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint">{i.group}</li>) : null;
            return [
              head,
              <li key={i.id} role="option" aria-selected={idx === active} data-idx={idx} className="relative">
                <button onMouseMove={() => idx !== active && setActive(idx)} onClick={() => run(i)} className={cx("cp-row", idx === active ? "text-fg" : "text-muted")}>
                  <span className="text-muted [&>svg]:size-4">{i.icon}</span>
                  <span className="truncate">{i.label}</span>
                  {i.hint && <span className="ml-auto truncate pl-3 text-[11px] text-faint">{i.hint}</span>}
                </button>
              </li>,
            ];
          })}
        </ul>
        <footer className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
          <Command className="size-3" /> K 打开 · ↑↓ 循环选择 · Home/End 首尾 · ↵ 执行 · Esc 关闭
        </footer>
      </div>
    </div>
  );
}
