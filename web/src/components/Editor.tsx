// VS Code–style file area: the folder view plus closable/switchable tabs for open files,
// each with a path breadcrumb. The sidebar stays visible; tabs persist across reloads.
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Download, ExternalLink, Info, Minus, Share2, X } from "lucide-react";
import { client, fileUrl, ok, type FsItem } from "../lib/api";
import { appLink, copyText } from "../lib/links";
import { filesHref, go } from "../lib/router";
import { parentOf, tabs, useTabs, type Tab } from "../lib/tabs";
import { dock, useDock } from "../lib/dock";
import { dockRect, genie, GenieDock } from "../ui/motion";
import { cx, fmtSize, fmtTime } from "../lib/util";
import { ContextMenu, IconButton, Menu, MenuItem, MenuSep, Spinner, toast } from "../ui/ui";
import { FileBrowser } from "./FileBrowser";
import { DetailsDialog, ShareDialog } from "./FileDialogs";
import { FileIcon, FolderIcon } from "./FileIcon";

const FileBody = lazy(() => import("./Preview"));

function TabStrip({ path, list, active }: { path: string; list: Tab[]; active: string | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const folderName = path === "/" ? "全部文件" : path.split("/").filter(Boolean).slice(-1)[0];
  const activate = (t: Tab) => {
    tabs.activate(t.path);
    if (parentOf(t.path) !== path) go(filesHref(parentOf(t.path)));
  };
  useEffect(() => {
    document.querySelector<HTMLElement>(`[data-tab-active]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div role="tablist" aria-label="已打开的文件" className="scroll-thin sticky top-0 z-20 -mx-4 flex h-10 shrink-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden border-b border-line bg-panel px-2 sm:-mx-8 sm:px-4">
      <button role="tab" aria-selected={!active} data-tab-active={!active ? "" : undefined} onClick={() => tabs.activate(null)} className={cx("editor-tab group relative -mb-px flex h-9 max-w-52 shrink-0 items-center gap-1.5 rounded-t-xl border px-3 text-[13px]", !active ? "border-line border-b-panel bg-panel font-medium text-fg" : "border-transparent text-muted hover:bg-hover hover:text-fg")}>
        <FolderIcon size={16} />
        <span className="truncate">{folderName}</span>
        {!active && <i className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-accent" />}
      </button>
      {list.map((t) => {
        const on = t.path === active;
        return (
          <div
            key={t.path}
            role="tab"
            tabIndex={0}
            aria-selected={on}
            title={t.path}
            data-tab-active={on ? "" : undefined}
            onClick={() => activate(t)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), activate(t))}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && (e.preventDefault(), tabs.close(t.path))}
            onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, tab: t }))}
            className={cx("editor-tab tab-in group relative -mb-px flex h-9 max-w-60 shrink-0 cursor-default items-center gap-1.5 rounded-t-xl border pr-1.5 pl-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/50", on ? "border-line border-b-panel bg-panel font-medium text-fg" : "border-transparent text-muted hover:bg-hover hover:text-fg")}
          >
            <FileIcon name={t.name} isDir={false} className="size-4" />
            <span className="truncate">{t.name}</span>
            <button aria-label={`关闭 ${t.name}`} onClick={(e) => (e.stopPropagation(), tabs.close(t.path))} className={cx("ml-0.5 rounded-md p-0.5 text-faint hover:bg-active hover:text-fg", on ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}>
              <X className="size-3.5" />
            </button>
            {on && <i className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-accent" />}
          </div>
        );
      })}
      <ContextMenu at={menu} onClose={() => setMenu(null)} label="标签操作">
        {(close) =>
          menu && (
            <div>
              <MenuItem icon={<X />} onClick={() => (close(), tabs.close(menu.tab.path))}>关闭</MenuItem>
              <MenuItem icon={<span />} onClick={() => (close(), tabs.closeOthers(menu.tab.path), go(filesHref(parentOf(menu.tab.path))))}>关闭其他</MenuItem>
              <MenuItem icon={<span />} onClick={() => (close(), tabs.closeAll())}>全部关闭</MenuItem>
              <MenuSep />
              <MenuItem icon={<span />} onClick={() => (close(), copyText(menu.tab.path).then(() => toast.ok("路径已复制")))}>复制路径</MenuItem>
            </div>
          )
        }
      </ContextMenu>
    </div>
  );
}

function useSiblings(dir: string) {
  const [s, set] = useState<FsItem[]>([]);
  useEffect(() => {
    let live = true;
    ok(client.GET("/api/fs/list", { params: { query: { path: dir, page: 1, per_page: 500, sort: "name", order: "asc" } } }))
      .then((r) => live && set(r.items))
      .catch(() => live && set([]));
    return () => {
      live = false;
    };
  }, [dir]);
  return s;
}

function FileView({ tab }: { tab: Tab }) {
  const dir = parentOf(tab.path);
  const siblings = useSiblings(dir);
  const files = useMemo(() => siblings.filter((s) => !s.is_dir), [siblings]);
  const item: FsItem = useMemo(() => siblings.find((s) => s.path === tab.path) ?? { ...tab }, [siblings, tab]);
  const [share, setShare] = useState<FsItem | null>(null);
  const [details, setDetails] = useState<FsItem | null>(null);
  const parts = tab.path.split("/").filter(Boolean);
  const panel = useRef<HTMLDivElement>(null);
  const minimize = async () => {
    if (panel.current) await genie(panel.current, dockRect(tab.path), "min");
    dock.minimize(tab.path);
    tabs.activate(null);
  };
  // restored from the dock: genie back out of the icon
  useLayoutEffect(() => {
    const r = dock.consumeRestore(tab.path);
    if (r && panel.current) void genie(panel.current, r, "max");
  }, [tab.path]);
  return (
    <section aria-label={`文件 ${tab.name}`} className="flex min-h-0 flex-1 flex-col pt-2 pb-3">
      <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1">
        <nav aria-label="文件路径" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[13px]">
          <a href="#/files" onClick={() => tabs.activate(null)} className="shrink-0 rounded-md max-sm:hidden px-1.5 py-1 text-muted hover:bg-hover hover:text-fg">全部</a>
          {parts.slice(0, -1).map((p, i) => {
            const href = filesHref("/" + parts.slice(0, i + 1).join("/"));
            return (
              <span key={href} className="flex min-w-0 items-center gap-0.5 max-sm:hidden">
                <ChevronRight className="size-3.5 shrink-0 text-faint" />
                <a href={href} onClick={() => tabs.activate(null)} className="truncate rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-fg">{p}</a>
              </span>
            );
          })}
          <ChevronRight className="size-3.5 shrink-0 text-faint max-sm:hidden" />
          <Menu
            align="left"
            className="min-w-0"
            trigger={(t) => (
              <button onClick={t} aria-label="切换同目录文件" className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-semibold hover:bg-hover">
                <FileIcon name={tab.name} isDir={false} className="size-4" />
                <span className="truncate">{tab.name}</span>
                <ChevronDown className="size-3.5 shrink-0 text-faint" />
              </button>
            )}
          >
            {(close) => (
              <div className="max-h-80">
                {files.length === 0 && <p className="px-3 py-2 text-xs text-faint">加载中…</p>}
                {files.map((f) => (
                  <MenuItem key={f.path} icon={<FileIcon name={f.name} isDir={false} className="size-4" />} onClick={() => (close(), tabs.open(f))}>
                    <span className={cx(f.path === tab.path && "font-semibold text-accent")}>{f.name}</span>
                  </MenuItem>
                ))}
              </div>
            )}
          </Menu>
        </nav>
        <span className="hidden text-xs text-faint tabular-nums md:inline">{fmtSize(item.size)} · {fmtTime(item.modified_unix)}</span>
        <span className="flex items-center">
          <a href={fileUrl(tab.path, { download: true })} download={tab.name} aria-label="下载" title="下载" className="btn-key btn-icon inline-flex size-9 items-center justify-center rounded-xl text-muted hover:bg-hover hover:text-fg">
            <Download className="size-[18px]" />
          </a>
          <IconButton className="max-sm:hidden" label="在新标签页打开" onClick={() => window.open(appLink(item), "_blank", "noopener")}><ExternalLink className="size-[18px]" /></IconButton>
          <IconButton className="max-sm:hidden" label="分享" onClick={() => setShare(item)}><Share2 className="size-[18px]" /></IconButton>
          <IconButton label="属性" onClick={() => setDetails(item)}><Info className="size-[18px]" /></IconButton>
          <IconButton label="最小化到 Dock" onClick={minimize}><Minus className="size-[18px]" /></IconButton>
          <IconButton label="关闭标签" onClick={() => tabs.close(tab.path)}><X className="size-[18px]" /></IconButton>
        </span>
      </div>
      <div key={tab.path} ref={panel} className="anim-in relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-panel-2/60 p-2 sm:p-4">
        <Suspense fallback={<div className="flex h-64 items-center justify-center"><Spinner /></div>}>
          <FileBody item={item} siblings={siblings} onPick={(i) => tabs.open(i)} />
        </Suspense>
      </div>
      <ShareDialog item={share} onClose={() => setShare(null)} />
      <DetailsDialog item={details} onClose={() => setDetails(null)} />
    </section>
  );
}

export function FilesArea({ path, openParam }: { path: string; openParam: string | null }) {
  const { tabs: list, active } = useTabs();
  // deep link: #/files/<dir>?open=<file>
  useEffect(() => {
    if (!openParam) return;
    ok(client.GET("/api/fs/stat", { params: { query: { path: openParam } } }))
      .then((i) => (i.is_dir ? go(filesHref(i.path)) : tabs.open(i)))
      .catch(() => toast.err("无法打开链接里的文件"))
      .finally(() => history.replaceState(null, "", filesHref(parentOf(openParam))));
  }, [openParam]);
  // navigating to another folder shows the folder view (tabs stay open)
  useEffect(() => {
    const a = tabs.get().active;
    if (a && parentOf(a) !== path && !openParam) tabs.activate(null);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const tab = list.find((t) => t.path === active) ?? null;
  const { min } = useDock();
  useEffect(() => dock.prune(list.map((t) => t.path)), [list]);
  useEffect(() => void (active && dock.forget(active)), [active]);
  const entries = list.filter((t) => min.includes(t.path)).map((t) => ({ id: t.path, name: t.name, icon: <FileIcon name={t.name} isDir={false} className="size-7" /> }));
  return (
    <div className={cx("flex flex-col", tab ? "h-full" : "min-h-full")} style={{ "--tabs-h": list.length ? "40px" : "0px" } as CSSProperties}>
      {list.length > 0 && <TabStrip path={path} list={list} active={tab?.path ?? null} />}
      <FileBrowser path={path} hidden={!!tab} />
      {tab && <FileView tab={tab} />}
      <GenieDock items={entries} onRestore={(id, rect) => (dock.restore(id, rect), tabs.activate(id), parentOf(id) !== path && go(filesHref(parentOf(id))))} />
    </div>
  );
}
