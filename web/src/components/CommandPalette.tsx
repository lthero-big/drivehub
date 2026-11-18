import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command, FolderOpen, Moon, Search, Settings, Sun, Users, HardDrive, ListChecks, Shield, ScrollText, User, LayoutDashboard, Monitor } from "lucide-react";
import { client, ok, type FsItem, type SearchHit } from "../lib/api";
import { useApp } from "../lib/app";
import { filesHref, go } from "../lib/router";
import { tabs } from "../lib/tabs";
import type { ThemePref } from "../lib/theme";
import { cx, fmtSize } from "../lib/util";
import { FileIcon } from "./FileIcon";

type Item = { id: string; label: string; hint?: string; icon: ReactNode; run: () => void; group: string };

/** ⌘K / Ctrl+K command palette: navigation, actions, and live file search. */
export function CommandPalette({ open, onClose, setTheme }: { open: boolean; onClose: () => void; setTheme: (t: ThemePref) => void }) {
  const { isAdmin, me } = useApp();
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
      { id: "files", group: "跳转", label: "全部文件", icon: <FolderOpen />, run: () => go("#/files") },
      ...mounts.map((m) => ({ id: `m:${m.path}`, group: "跳转", label: m.name, hint: m.mount_kind ?? "", icon: <HardDrive />, run: () => go(filesHref(m.path)) })),
      { id: "search", group: "跳转", label: "高级搜索", icon: <Search />, run: () => go(`#/search?q=${encodeURIComponent(q)}`) },
      { id: "tasks", group: "跳转", label: "任务中心", icon: <ListChecks />, run: () => go("#/tasks") },
      ...(me ? [{ id: "account", group: "跳转", label: "账户与安全", icon: <User />, run: () => go("#/account") }] : []),
      ...(isAdmin
        ? [
            { id: "dash", group: "管理", label: "仪表盘", icon: <LayoutDashboard />, run: () => go("#/admin/dashboard") },
            { id: "mounts", group: "管理", label: "挂载点", icon: <HardDrive />, run: () => go("#/admin/mounts") },
            { id: "users", group: "管理", label: "用户与用户组", icon: <Users />, run: () => go("#/admin/users") },
            { id: "acl", group: "管理", label: "目录权限 (ACL)", icon: <Shield />, run: () => go("#/admin/acl") },
            { id: "audit", group: "管理", label: "审计日志", icon: <ScrollText />, run: () => go("#/admin/audit") },
            { id: "settings", group: "管理", label: "全局设置", icon: <Settings />, run: () => go("#/admin/settings") },
          ]
        : []),
      { id: "t-light", group: "外观", label: "浅色模式", icon: <Sun />, run: () => setTheme("light") },
      { id: "t-dark", group: "外观", label: "深色模式", icon: <Moon />, run: () => setTheme("dark") },
      { id: "t-sys", group: "外观", label: "跟随系统", icon: <Monitor />, run: () => setTheme("system") },
    ];
    const s = q.trim().toLowerCase();
    const filtered = s ? nav.filter((i) => i.label.toLowerCase().includes(s) || i.hint?.toLowerCase().includes(s)) : nav;
    const files: Item[] = hits.map((h) => ({
      id: `f:${h.path}`,
      group: "文件",
      label: h.name,
      hint: `${h.path}${h.is_dir ? "" : ` · ${fmtSize(h.size)}`}`,
      icon: <FileIcon name={h.name} isDir={h.is_dir} className="size-4" />,
      run: () => (h.is_dir ? go(filesHref(h.path)) : (tabs.open({ path: h.path, name: h.name, size: h.size, modified_unix: h.modified_unix, is_dir: false }), go(filesHref(h.path.slice(0, h.path.lastIndexOf("/")) || "/")))),
    }));
    return [...files, ...filtered];
  }, [q, hits, mounts, isAdmin, me, setTheme]);

  useEffect(() => setActive(0), [q, hits.length]);
  if (!open) return null;
  const run = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };
  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/40 p-3 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="命令面板" className="anim-in w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-panel shadow-pop">
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 text-faint" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(items.length - 1, a + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
              else if (e.key === "Enter") (e.preventDefault(), q.trim() && !items.length ? (onClose(), go(`#/search?q=${encodeURIComponent(q)}`)) : run(items[active]));
              else if (e.key === "Escape") onClose();
            }}
            placeholder="搜索文件、跳转页面、执行命令…  支持 ext:pdf size:>10m mount:名称"
            aria-label="命令或搜索"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-faint">Esc</kbd>
        </div>
        <ul role="listbox" className="scroll-thin max-h-[55vh] overflow-auto p-1.5">
          {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">回车进行高级搜索「{q}」</li>}
          {items.map((i, idx) => {
            const head = i.group !== lastGroup ? ((lastGroup = i.group), <li key={`g-${i.group}`} className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-faint">{i.group}</li>) : null;
            return [
              head,
              <li key={i.id} role="option" aria-selected={idx === active}>
                <button onMouseMove={() => setActive(idx)} onClick={() => run(i)} className={cx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px]", idx === active && "bg-hover")}>
                  <span className="text-muted [&>svg]:size-4">{i.icon}</span>
                  <span className="truncate">{i.label}</span>
                  {i.hint && <span className="ml-auto truncate pl-3 text-[11px] text-faint">{i.hint}</span>}
                </button>
              </li>,
            ];
          })}
        </ul>
        <footer className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-faint">
          <Command className="size-3" /> K 打开 · ↑↓ 选择 · ↵ 执行
        </footer>
      </div>
    </div>
  );
}
