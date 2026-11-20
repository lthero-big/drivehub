import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as RMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownAZ, Check, CheckSquare, ChevronRight, ClipboardCopy, Copy, Download, ExternalLink, Eye, FileArchive, FolderInput, FolderPlus, FolderUp, Grid2x2, Images, Info, KeyRound, Link2, List,
  MoreHorizontal, Pencil, RefreshCw, Share2, Shield, Star, StarOff, Trash2, Upload, X, Lock, Tag as TagIcon,
} from "lucide-react";
import { ApiError, client, fileUrl, ok, pathPassword, rawFetch, zipUrl, type FsItem } from "../lib/api";
import { favorites, useFavorites } from "../lib/favs";
import { appLink, copyText } from "../lib/links";
import { tabs } from "../lib/tabs";
import { fsTrash as trash, undoableDelete } from "../lib/trash";
import { SkFileGrid, SkFileRows, TagRow } from "../ui/r6";
import { liftEnd, liftOutcome, liftStart } from "../lib/dragGhost";
import { useApp } from "../lib/app";
import { filesHref, go } from "../lib/router";
import { fromDataTransfer, fromFileList, uploads, useUploads } from "../lib/uploads";
import { hasExternalFiles, INTERNAL_MIME, isInternalDrag, PhCard, PhRow, placeholdersFor, setUploadOrigin, TrashZone } from "./DragUpload";
import { baseName, cx, errMsg, fmtSize, fmtTime, joinPath, kindOf } from "../lib/util";
import { ask, Button, Checkbox, ConfirmButton, confirmDlg, ContextMenu, Empty, IconButton, Input, Menu, MenuItem, MenuSep, Pager, toast } from "../ui/ui";
import { SegmentedDrag } from "../ui/motion";
import { DirPicker } from "./DirPicker";
import { DetailsDialog } from "./FileDialogs";
import { ShareDialog } from "./ShareDialog";
import { TagDialog } from "./TagDialog";
import { WavePlayerBar, WaveRowExtra } from "./WaveList";
import { tagStore, useTags, type Tag } from "../lib/tags";
import { usePrefs } from "../lib/prefs";
import { ChipGroup, useHoverReveal } from "../ui/r5";
import { FileIcon, FolderIcon } from "./FileIcon";
import { MediaCover } from "./MediaCover";
import { isBlurred } from "../lib/tags";

/** nearest vertically scrollable ancestor (rubber-band auto-scroll). */
function scroller(el: HTMLElement | null): HTMLElement {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
}

type View = "list" | "grid" | "gallery";
type Sort = { by: "name" | "size" | "modified"; desc: boolean };
const PAGE_SIZES = [30, 60, 100, 200];
const pageSize0 = () => Number(localStorage.getItem("dh_pagesize_files")) || 60;

function useStored<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, set] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? (JSON.parse(s) as T) : init;
    } catch {
      return init;
    }
  });
  return [v, (x: T) => (set(x), localStorage.setItem(key, JSON.stringify(x)))];
}

function Crumbs({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <nav aria-label="路径" className="flex min-w-0 items-center gap-0.5 text-sm">
      <a href="#/files" className="rounded-md px-1.5 py-1 text-muted hover:bg-hover hover:text-fg">全部</a>
      {parts.map((p, i) => {
        const href = filesHref("/" + parts.slice(0, i + 1).join("/"));
        const last = i === parts.length - 1;
        return (
          <span key={href} className={cx("flex min-w-0 items-center gap-0.5", !last && "hidden sm:flex")}>
            <ChevronRight className="size-3.5 shrink-0 text-faint" />
            <a href={href} aria-current={last ? "page" : undefined} className={cx("truncate rounded-md px-1.5 py-1 hover:bg-hover", last ? "font-semibold" : "text-muted")}>
              {p}
            </a>
          </span>
        );
      })}
    </nav>
  );
}

function Readme({ item }: { item: FsItem }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const r = await rawFetch(fileUrl(item.path), { headers: { range: "bytes=0-262143" } });
      if (!r.ok) return;
      const [{ marked }, purify] = await Promise.all([import("marked"), import("dompurify")]);
      const out = purify.default.sanitize(await marked.parse(await r.text(), { gfm: true }));
      if (live) setHtml(out);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [item.path]);
  if (!html) return null;
  return (
    <section className="mt-4 rounded-xl border border-line bg-panel">
      <header className="border-b border-line px-4 py-2 text-xs font-medium text-muted">{item.name}</header>
      <article className="prose-dh px-5 py-3" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

/** Floating action dock for the current selection: bottom-centre, genie rise, magnifying buttons. */
function Dock({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const magnify = (x: number | null) => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce), (pointer: coarse)").matches) return;
    el.querySelectorAll<HTMLElement>(".dock-btn").forEach((b) => {
      if (x == null) return void (b.style.transform = "");
      const r = b.getBoundingClientRect();
      const d = Math.abs(x - (r.left + r.width / 2));
      const s = 1 + 0.32 * Math.max(0, 1 - d / 96);
      b.style.transform = `translateY(${-(s - 1) * 14}px) scale(${s})`;
    });
  };
  return createPortal(
    <div ref={ref} role="toolbar" aria-label={label} onMouseMove={(e) => magnify(e.clientX)} onMouseLeave={() => magnify(null)} className="dock pop-surface fixed bottom-4 z-40 flex max-w-[calc(100vw-1rem)] items-end gap-0.5 overflow-x-auto rounded-[22px] p-1.5 sm:overflow-visible">
      {children}
    </div>,
    document.body,
  );
}

function DockBtn({ icon, label, onClick, danger, className }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label} className={cx(className, "dock-btn relative flex size-11 shrink-0 flex-col items-center justify-center rounded-2xl [&>svg]:size-[19px]", danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-hover")}>
      {icon}
      <span className="dock-tip pointer-events-none absolute -top-8 left-1/2 hidden rounded-lg bg-fg px-2 py-1 text-[11px] whitespace-nowrap text-bg shadow-pop sm:block">{label}</span>
    </button>
  );
}

export function FileBrowser({ path, hidden }: { path: string; hidden?: boolean }) {
  const { fsVersion, bumpFs, isAdmin, me } = useApp();
  const pf = usePrefs();
  const myTags = useTags();
  const [tagMap, setTagMap] = useState<Record<string, Tag[]>>({});
  const [tagBar, setTagBar] = useState(false);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<"any" | "all">("any");
  const [tagging, setTagging] = useState<FsItem[] | null>(null);
  const [tagElsewhere, setTagElsewhere] = useState<{ path: string; name: string; tags: Tag[] }[]>([]);
  const hover = useHoverReveal();
  useFavorites();
  const [items, setItems] = useState<FsItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [PAGE, setPAGE] = useState(pageSize0);
  const [err, setErr] = useState<{ msg: string; status: number } | null>(null);
  const [view, setView] = useStored<View>("dh_view", "list");
  const [sort, setSort] = useStored<Sort>("dh_sort", { by: "name", desc: false });
  const [cols, setCols] = useStored<number>("dh_gallery_cols", 4);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<number>(-1);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; item: FsItem | null } | null>(null);
  const closeCtx = useCallback(() => setCtxMenu(null), []);
  const [sharing, setSharing] = useState<FsItem[]>([]);
  const [details, setDetails] = useState<FsItem | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picker, setPicker] = useState<null | "move" | "copy">(null);
  const [pw, setPw] = useState("");
  const [dragPaths, setDragPaths] = useState<string[] | null>(null);
  const [dragSrc, setDragSrc] = useState<string | null>(null);
  const [dragHome, setDragHome] = useState<DOMRect | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [band, setBand] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const bandRef = useRef<{ x0: number; y0: number; lx: number; ly: number; base: Set<string>; mode: "new" | "add" | "toggle"; moved: boolean; sc: HTMLElement } | null>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const ups = useUploads();
  const [tick, setTick] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const isRoot = path === "/";

  const load = useCallback(
    async (refresh = false, pg = 1) => {
      setErr(null);
      try {
        const r = await ok(client.GET("/api/fs/list", { params: { query: { path, page: pg, per_page: PAGE, sort: sort.by, order: sort.desc ? "desc" : "asc", refresh } } }));
        setTotal(r.total);
        setPage(pg);
        setItems(r.items);
        if (me) tagStore.ofDir(path).then(setTagMap, () => setTagMap({}));
      } catch (e) {
        setErr({ msg: errMsg(e), status: e instanceof ApiError ? e.status : 0 });
        setItems([]);
      }
    },
    [path, sort.by, sort.desc, me, PAGE],
  );

  useEffect(() => {
    setItems(null);
    setSel(new Set());
    anchor.current = -1;
    load();
  }, [load]);
  useEffect(() => {
    if (fsVersion) load(true);
  }, [fsVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () =>
      uploads.onDone((p) => {
        if (p.startsWith(path === "/" ? "/" : path + "/")) debounceReload();
      }),
    [path], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const reloadTimer = useRef<number>(0);
  const debounceReload = () => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => load(true), 400);
  };

  const [q, setQ] = useState("");
  useEffect(() => setQ(""), [path]);
  const all = useMemo(() => (items ?? []).filter((i) => !gone.has(i.path)), [items, gone]);
  const list = useMemo(() => {
    let l = q.trim() ? all.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())) : all;
    if (tagFilter.length) {
      const want = tagFilter.map(Number);
      l = l.filter((i) => {
        const has = (tagMap[i.path] ?? []).map((t) => t.id);
        return tagMode === "all" ? want.every((w) => has.includes(w)) : want.some((w) => has.includes(w));
      });
    }
    return l;
  }, [all, q, tagFilter, tagMode, tagMap]);
  useEffect(() => setTagFilter([]), [path]);
  useEffect(() => {
    if (!tagFilter.length) return setTagElsewhere([]);
    tagStore.files(tagFilter.map(Number), tagMode).then((r) => setTagElsewhere(r.filter((x) => (x.path.slice(0, x.path.lastIndexOf("/")) || "/") !== path)), () => setTagElsewhere([]));
  }, [tagFilter, tagMode, path, tagMap]);
  /** Tags stay on one line (+N overflow chip), so a heavily tagged file never makes its row taller. */
  const tagPills = (i: FsItem, grid = false) => {
    const ts = tagMap[i.path];
    return ts?.length ? <TagRow tags={ts} className={grid ? "mt-1 w-full" : "max-w-[45%] min-w-12"} /> : null;
  };
  const selected = useMemo(() => list.filter((i) => sel.has(i.path)), [list, sel]);
  const audios = useMemo(() => list.filter((i) => !i.is_dir && kindOf(i.name) === "audio"), [list]);
  const isMedia = (i: FsItem) => !i.is_dir && (kindOf(i.name) === "image" || kindOf(i.name) === "video");
  const [galleryAll, setGalleryAll] = useState<FsItem[] | null>(null);
  useEffect(() => {
    if (view !== "gallery") return;
    let live = true;
    (async () => {
      const acc: FsItem[] = [];
      let pg = 1, total = Infinity;
      while (live && acc.length < total) {
        const r = await ok(client.GET("/api/fs/list", { params: { query: { path, page: pg, per_page: 1000, sort: sort.by, order: sort.desc ? "desc" : "asc" } } }));
        total = r.total;
        acc.push(...r.items);
        if (!r.items.length || acc.length >= total) break;
        pg += 1;
      }
      if (live) setGalleryAll(acc);
    })().catch(() => { if (live) setGalleryAll([]); });
    return () => { live = false; };
  }, [view, path, sort.by, sort.desc, fsVersion]);
  const galleryItems = useMemo(() => {
    const src = (galleryAll ?? all).filter((i) => !gone.has(i.path) && isMedia(i));
    let l = q.trim() ? src.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())) : src;
    if (tagFilter.length) {
      const want = tagFilter.map(Number);
      l = l.filter((i) => {
        const has = (tagMap[i.path] ?? []).map((t) => t.id);
        return tagMode === "all" ? want.every((w) => has.includes(w)) : want.some((w) => has.includes(w));
      });
    }
    return l;
  }, [galleryAll, all, gone, q, tagFilter, tagMode, tagMap]);
  const galleryImages = galleryItems.filter((i) => kindOf(i.name) === "image");
  const galleryVideos = galleryItems.filter((i) => kindOf(i.name) === "video");
  const phs = useMemo(() => placeholdersFor(ups, path, new Set((items ?? []).map((i) => i.name)), Date.now()), [ups, path, items, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const last = Math.max(0, ...ups.filter((u) => u.status === "done").map((u) => u.doneAt ?? 0));
    if (!last || Date.now() - last > 6000) return;
    const t = setTimeout(() => setTick((x) => x + 1), 6100 - (Date.now() - last));
    return () => clearTimeout(t);
  }, [ups]);
  const readme = useMemo(() => list.find((i) => !i.is_dir && /^readme\.(md|markdown)$/i.test(i.name)), [list]);

  const open = (i: FsItem) => {
    if (!i.is_dir) return tabs.open(i);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return go(filesHref(i.path));
    setOpening(i.path); // let the folder icon "open" before navigating
    setTimeout(() => (setOpening(null), go(filesHref(i.path))), 170);
  };
  const openInNewTab = (i: FsItem) => window.open(appLink(i), "_blank", "noopener");
  const copy = async (text: string, what: string) => ((await copyText(text)) ? toast.ok(`${what}已复制`) : toast.err("复制失败"));

  const click = (e: RMouseEvent, i: FsItem, idx: number) => {
    if (e.shiftKey && anchor.current >= 0) {
      const [a, b] = [Math.min(anchor.current, idx), Math.max(anchor.current, idx)];
      setSel(new Set(list.slice(a, b + 1).map((x) => x.path)));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const n = new Set(sel);
      if (n.has(i.path)) n.delete(i.path);
      else n.add(i.path);
      setSel(n);
      anchor.current = idx;
      return;
    }
    // touch / narrow screens: a tap opens; desktop: click selects, double-click opens
    if (window.matchMedia("(pointer: coarse)").matches && sel.size === 0) return open(i);
    if (sel.size > 0 && window.matchMedia("(pointer: coarse)").matches) return toggle(i);
    setSel(new Set([i.path]));
    anchor.current = idx;
  };
  const toggle = (i: FsItem) => {
    const n = new Set(sel);
    if (n.has(i.path)) n.delete(i.path);
    else n.add(i.path);
    setSel(n);
  };

  // ---- actions --------------------------------------------------------------
  const mkdir = async () => {
    const name = await ask("新建文件夹", { label: "名称", value: "新建文件夹", confirm: "创建" });
    if (!name?.trim()) return;
    try {
      await ok(client.POST("/api/fs/mkdir", { body: { path: joinPath(path, name.trim()) } }));
      toast.ok("已创建");
      load(true);
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const rename = async (i: FsItem) => {
    const name = await ask("重命名", { label: "新名称", value: i.name, confirm: "重命名" });
    if (!name?.trim() || name === i.name) return;
    try {
      await ok(client.POST("/api/fs/rename", { body: { path: i.path, new_name: name.trim() } }));
      tabs.forget([i.path]);
      favorites.forget([i.path]);
      load(true);
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  /** Delete with undo: hide now, commit after the toast's undo window (dialog → toast morph). */
  const scheduleDelete = (its: FsItem[]) => {
    setSel(new Set());
    undoableDelete({
      items: its,
      key: (i) => i.path,
      name: (i) => i.name,
      hide: (ps) => setGone((g) => new Set([...g, ...ps])),
      unhide: (ps) => setGone((g) => new Set([...g].filter((p) => !ps.includes(p)))),
      exec: trash.exec,
      beacon: trash.beacon,
      after: (ok) => {
        tabs.forget(ok);
        favorites.forget(ok);
        bumpFs();
        return load(true);
      },
    });
  };
  const remove = async (its: FsItem[]) => {
    if (!its.length) return;
    const yes = await confirmDlg(its.length === 1 ? `删除「${its[0].name}」？` : `删除 ${its.length} 项？`, { label: "文件夹会连同内容一起删除。5 秒内可以撤销。", confirm: "删除", danger: true });
    if (yes) scheduleDelete(its);
  };
  const transfer = async (kind: "move" | "copy", dst: string) => {
    setPicker(null);
    let tasks = 0;
    for (const i of selected) {
      try {
        const r = await ok(client.POST(kind === "move" ? "/api/fs/move" : "/api/fs/copy", { body: { src: i.path, dst: joinPath(dst, i.name) } }));
        if (r.task_id) tasks++;
      } catch (e) {
        toast.err(`${i.name}：${errMsg(e)}`);
      }
    }
    if (kind === "move") (tabs.forget(selected.map((i) => i.path)), favorites.forget(selected.map((i) => i.path)));
    toast.ok(tasks ? `已创建 ${tasks} 个后台任务（任务中心可看进度）` : kind === "move" ? "已移动" : "已复制");
    setSel(new Set());
    load(true);
    bumpFs();
  };
  const download = (its: FsItem[]) => {
    if (its.length === 1 && !its[0].is_dir) {
      const a = document.createElement("a");
      a.href = fileUrl(its[0].path, { download: true });
      a.download = its[0].name;
      a.click();
      return;
    }
    const name = its.length === 1 ? its[0].name : `${baseName(path) || "drivehub"}-${its.length}项`;
    location.href = zipUrl(its.map((i) => i.path), name);
  };
  const addFiles = (files: { file: File; path: string }[], from?: { x: number; y: number }) => {
    if (from) setUploadOrigin(from.x, from.y);
    if (isRoot) return toast.err("请先进入一个存储再上传");
    if (files.length) uploads.add(files);
  };

  // ---- keyboard / paste / drop ----------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (hidden || t.closest("input,textarea,select,[role=dialog],[role=menu]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSel(new Set(list.map((i) => i.path)));
      } else if (e.key === "Escape") setSel(new Set());
      else if ((e.key === "Delete" || (e.key === "Backspace" && e.metaKey)) && selected.length) remove(selected);
      else if (e.key === "F2" && selected.length === 1) rename(selected[0]);
      else if (e.key === "Enter" && selected.length === 1) open(selected[0]);
      else if (e.key === "Backspace" && !isRoot && !selected.length) go(filesHref(path.slice(0, path.lastIndexOf("/")) || "/"));
    };
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (hidden || t.closest("input,textarea")) return;
      const fs = e.clipboardData?.files;
      if (fs?.length) {
        e.preventDefault();
        addFiles(fromFileList(fs, path), { x: window.innerWidth / 2, y: 120 });
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  });
  const onDrop = async (e: DragEvent) => {
    setDragging(false);
    // dragging one of our own rows/cards (even an image) must never be treated as an upload
    if (isInternalDrag(e.dataTransfer)) return;
    if (!hasExternalFiles(e.dataTransfer)) return;
    e.preventDefault();
    const from = { x: e.clientX, y: e.clientY };
    addFiles(await fromDataTransfer(e.dataTransfer, path), from);
  };

  // ---- internal drag (move into folder / drag to bin) ---------------------------
  const onItemDragStart = (e: DragEvent, i: FsItem) => {
    const paths = sel.has(i.path) ? selected.map((x) => x.path) : [i.path];
    if (!sel.has(i.path)) setSel(new Set([i.path]));
    e.dataTransfer.setData(INTERNAL_MIME, JSON.stringify(paths));
    e.dataTransfer.setData("text/plain", paths.map(baseName).join("\n"));
    e.dataTransfer.effectAllowed = "copyMove";
    // the whole card / row lifts and follows the pointer (not just a name chip)
    const home = liftStart(e, paths.length);
    setTimeout(() => (setDragHome(home), setDragPaths(paths), setDragSrc(i.path)), 0); // changing the DOM inside dragstart can cancel the drag
  };
  const onItemDragEnd = (e: DragEvent) => (liftEnd(e.dataTransfer?.dropEffect ?? "none"), setDragPaths(null), setDragSrc(null), setDragHome(null), setDropTarget(null));
  const moveInto = async (paths: string[], dst: string) => {
    const todo = paths.filter((p) => p !== dst && p.slice(0, p.lastIndexOf("/")) !== dst && !dst.startsWith(p + "/"));
    if (!todo.length) return;
    let tasks = 0;
    for (const p of todo) {
      try {
        const r = await ok(client.POST("/api/fs/move", { body: { src: p, dst: joinPath(dst, baseName(p)) } }));
        if (r.task_id) tasks++;
      } catch (e) {
        toast.err(`${baseName(p)}：${errMsg(e)}`);
      }
    }
    tabs.forget(todo);
    favorites.forget(todo);
    toast.ok(tasks ? `已创建 ${tasks} 个后台任务` : `已移动 ${todo.length} 项到 ${baseName(dst)}`);
    setSel(new Set());
    load(true);
    bumpFs();
  };
  const dragProps = (i: FsItem) => ({
    "data-sel-path": i.path,
    draggable: !isRoot,
    onDragStart: (e: DragEvent) => onItemDragStart(e, i),
    onDragEnd: onItemDragEnd,
    ...(i.is_dir && !isRoot
      ? {
          onDragOver: (e: DragEvent) => {
            if (!isInternalDrag(e.dataTransfer) || dragPaths?.includes(i.path)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            if (dropTarget !== i.path) setDropTarget(i.path);
          },
          onDragLeave: () => setDropTarget((t) => (t === i.path ? null : t)),
          onDrop: (e: DragEvent) => {
            if (!isInternalDrag(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropTarget(null);
            liftOutcome("drop");
            setDragPaths(null);
            setDragSrc(null);
            setDragHome(null);
            try {
              moveInto(JSON.parse(e.dataTransfer.getData(INTERNAL_MIME)), i.path);
            } catch {
              /* ignore */
            }
          },
        }
      : {}),
  });
  const dragCls = (i: FsItem) => cx(dragSrc === i.path ? "drag-slot" : dragPaths?.includes(i.path) && "drag-ghost-src", dropTarget === i.path && "drop-folder");

  // ---- rubber-band selection (desktop-style marquee) ------------------------------
  const updateBand = () => {
    const b = bandRef.current;
    if (!b) return;
    const sy = b.sc.scrollTop;
    const y0 = b.y0 - sy;
    const l = Math.min(b.x0, b.lx), r = Math.max(b.x0, b.lx), t = Math.min(y0, b.ly), bt = Math.max(y0, b.ly);
    setBand({ l, t, w: r - l, h: bt - t });
    const hit = new Set<string>();
    areaRef.current?.querySelectorAll<HTMLElement>("[data-sel-path]").forEach((el) => {
      const rc = el.getBoundingClientRect();
      if (rc.right >= l && rc.left <= r && rc.bottom >= t && rc.top <= bt) hit.add(el.dataset.selPath!);
    });
    let out: Set<string>;
    if (b.mode === "new") out = hit;
    else if (b.mode === "add") out = new Set([...b.base, ...hit]);
    else {
      out = new Set(b.base);
      hit.forEach((p) => (out.has(p) ? out.delete(p) : out.add(p)));
    }
    setSel(out);
  };
  const onAreaDown = (e: RMouseEvent) => {
    if (e.button !== 0 || window.matchMedia("(pointer: coarse)").matches) return;
    if ((e.target as HTMLElement).closest("[data-sel-path],[data-up-placeholder],button,a,input,label,[role=toolbar],[role=columnheader],[role=dialog]")) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    const sc = scroller(areaRef.current);
    const mode = e.shiftKey ? "add" : e.metaKey || e.ctrlKey ? "toggle" : "new";
    bandRef.current = { x0: e.clientX, y0: e.clientY + sc.scrollTop, lx: e.clientX, ly: e.clientY, base: new Set(sel), mode, moved: false, sc };
    let raf = 0;
    const loop = () => {
      const b = bandRef.current;
      if (!b) return;
      if (b.moved) {
        const rc = b.sc === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : b.sc.getBoundingClientRect();
        const dy = b.ly < rc.top + 36 ? -14 : b.ly > rc.bottom - 36 ? 14 : 0;
        if (dy) (b.sc.scrollTop += dy, updateBand());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const move = (ev: MouseEvent) => {
      const b = bandRef.current;
      if (!b) return;
      b.lx = ev.clientX;
      b.ly = ev.clientY;
      if (!b.moved && Math.hypot(ev.clientX - b.x0, ev.clientY - (b.y0 - b.sc.scrollTop)) < 4) return;
      b.moved = true;
      updateBand();
    };
    const up = () => {
      const b = bandRef.current;
      bandRef.current = null;
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setBand(null);
      if (b && !b.moved && b.mode === "new") setSel(new Set());
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // ---- render ---------------------------------------------------------------
  const sortLabel = { name: "名称", size: "大小", modified: "修改时间" }[sort.by];
  /** Shared action list for the ⋯ menu and the right-click menu. */
  const itemActions = (i: FsItem, close: () => void) => {
    const many = selected.length > 1 && sel.has(i.path) ? selected : [i];
    const fav = favorites.has(i.path);
    const run = (f: () => void) => () => (close(), f());
    return (
      <div>
        {many.length > 1 && <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-medium text-faint">已选 {many.length} 项</p>}
        {many.length === 1 && <MenuItem icon={<Eye />} kbd="↵" onClick={run(() => open(i))}>打开</MenuItem>}
        {many.length === 1 && !i.mount_kind && <MenuItem icon={<ExternalLink />} onClick={run(() => openInNewTab(i))}>在新标签页打开</MenuItem>}
        <MenuItem icon={many.length > 1 || i.is_dir ? <FileArchive /> : <Download />} onClick={run(() => download(many))}>{many.length > 1 || i.is_dir ? "打包下载" : "下载"}</MenuItem>
        {many.length === 1 && <MenuItem icon={<Share2 />} onClick={run(() => setSharing([i]))}>分享…</MenuItem>}
        <MenuSep />
        {!isRoot && many.length === 1 && <MenuItem icon={<Pencil />} kbd="F2" onClick={run(() => rename(i))}>重命名</MenuItem>}
        {!isRoot && <MenuItem icon={<FolderInput />} onClick={run(() => (setSel(new Set(many.map((x) => x.path))), setPicker("move")))}>移动到…</MenuItem>}
        {!isRoot && <MenuItem icon={<Copy />} onClick={run(() => (setSel(new Set(many.map((x) => x.path))), setPicker("copy")))}>复制到…</MenuItem>}
        {many.length === 1 && <MenuItem icon={<Link2 />} onClick={run(() => copy(appLink(i), "链接"))}>复制链接</MenuItem>}
        {many.length === 1 && <MenuItem icon={<ClipboardCopy />} onClick={run(() => copy(i.path, "路径"))}>复制路径</MenuItem>}
        <MenuSep />
        {many.length === 1 && <MenuItem icon={fav ? <StarOff /> : <Star />} onClick={run(() => (favorites.toggle(i), toast.ok(fav ? "已取消收藏" : "已收藏，可在侧栏找到")))}>{fav ? "取消收藏" : "收藏"}</MenuItem>}
        {me && !isRoot && <MenuItem icon={<TagIcon />} onClick={run(() => setTagging(many))}>标签…</MenuItem>}
        {many.length === 1 && <MenuItem icon={<Info />} onClick={run(() => setDetails(i))}>属性</MenuItem>}
        {isAdmin && many.length === 1 && <MenuItem icon={<Shield />} onClick={run(() => go(`#/admin/acl?path=${encodeURIComponent(i.path)}`))}>权限设置</MenuItem>}
        {!isRoot && (
          <>
            <MenuSep />
            <MenuItem icon={<Trash2 />} danger kbd="Del" onClick={run(() => remove(many))}>删除{many.length > 1 ? ` ${many.length} 项` : ""}</MenuItem>
          </>
        )}
      </div>
    );
  };
  const ItemMenu = ({ i }: { i: FsItem }) => (
    <Menu
      trigger={(t) => (
        <IconButton label="更多操作" onClick={(e) => (e.stopPropagation(), t())}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      )}
    >
      {(close) => itemActions(i, close)}
    </Menu>
  );
  const onItemContext = (e: RMouseEvent, i: FsItem) => {
    e.preventDefault();
    e.stopPropagation();
    if (!sel.has(i.path)) setSel(new Set([i.path]));
    setCtxMenu({ x: e.clientX, y: e.clientY, item: i });
  };
  const onBlankContext = (e: RMouseEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea,a[href]:not([data-row-link])")) return;
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, item: null });
  };

  return (
    <div className={cx("relative flex flex-1 flex-col", hidden && "hidden", selected.length > 0 && "pb-20")} onContextMenu={onBlankContext} onDragOver={(e) => hasExternalFiles(e.dataTransfer) && (e.preventDefault(), !isRoot && setDragging(true))} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={onDrop}>
      <div className="sticky top-[var(--tabs-h,0px)] z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2 sm:-mx-8 sm:px-8">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <Crumbs path={path} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Input className="hidden !h-9 w-40 sm:block" placeholder="筛选本页…" aria-label="筛选文件" value={q} onChange={(e) => setQ(e.target.value)} />
          {!isRoot && (
            <>
              <Button size="sm" variant="primary" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setUploadOrigin(r.left + r.width / 2, r.top + r.height / 2); fileInput.current?.click(); }}>
                <Upload className="size-4" /> <span className="hidden sm:inline">上传</span>
              </Button>
              <IconButton label="上传文件夹" onClick={() => dirInput.current?.click()}>
                <FolderUp className="size-4" />
              </IconButton>
              <IconButton label="新建文件夹" onClick={mkdir}>
                <FolderPlus className="size-4" />
              </IconButton>
            </>
          )}
          <Menu
            trigger={(t) => (
              <IconButton label={`排序：${sortLabel}`} onClick={t}>
                <ArrowDownAZ className="size-4" />
              </IconButton>
            )}
          >
            {(close) =>
              (["name", "size", "modified"] as const).map((b) => (
                <MenuItem key={b} icon={sort.by === b ? <Check /> : <span className="inline-block size-4" />} onClick={() => (close(), setSort({ by: b, desc: sort.by === b ? !sort.desc : b !== "name" }))}>
                  {{ name: "名称", size: "大小", modified: "修改时间" }[b]} {sort.by === b && (sort.desc ? "↓" : "↑")}
                </MenuItem>
              ))
            }
          </Menu>
          {me && (
            <IconButton label={tagFilter.length ? `按标签筛选（已选 ${tagFilter.length}）` : "按标签筛选"} aria-pressed={tagBar} onClick={() => setTagBar(!tagBar)} className={cx(tagFilter.length > 0 && "text-accent")}>
              <TagIcon className="size-4" />
            </IconButton>
          )}
          <SegmentedDrag<View> label="视图" size="sm" iconOnly value={view} onChange={setView} options={[{ value: "list", icon: <List className="size-4" />, title: "列表" }, { value: "grid", icon: <Grid2x2 className="size-4" />, title: "网格" }, { value: "gallery", icon: <Images className="size-4" />, title: "相册" }]} />
          <IconButton label="刷新" onClick={() => load(true)}>
            <RefreshCw className="size-4" />
          </IconButton>
        </div>
        {tagBar && me && (
          <div className="anim-in basis-full space-y-2 pt-1" data-tag-filter>
            {myTags.length === 0 ? <p className="text-[12.5px] text-faint">还没有标签：右键文件 →「标签…」创建第一个标签</p> : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-medium text-muted">按标签筛选</span>
                  <span className="ml-auto inline-flex rounded-lg border border-line p-0.5 text-[12px]" role="radiogroup" aria-label="匹配方式">
                    {(["any", "all"] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={tagMode === m} onClick={() => setTagMode(m)} className={cx("rounded-md px-2 py-0.5", tagMode === m ? "bg-hover text-fg" : "text-muted")}>{m === "any" ? "任一" : "全部"}</button>)}
                  </span>
                </div>
                <ChipGroup label="标签" options={myTags.map((t) => ({ value: String(t.id), label: `${t.name}${t.count ? ` ${t.count}` : ""}`, color: t.color }))} value={tagFilter} onChange={setTagFilter} maxVisible={6} />
                {tagElsewhere.length > 0 && (
                  <p className="text-[12px] text-muted" data-tag-elsewhere>其他目录还有 {tagElsewhere.length} 项：{tagElsewhere.slice(0, 6).map((x) => <a key={x.path} className="mr-2 text-accent hover:underline" href={filesHref(x.path.slice(0, x.path.lastIndexOf("/")) || "/")} title={x.path}>{x.name}</a>)}{tagElsewhere.length > 6 && "…"}</p>
                )}
              </>
            )}
          </div>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(fromFileList(e.target.files, path)), (e.target.value = ""))} />
        <input ref={dirInput} type="file" hidden {...({ webkitdirectory: "" } as object)} onChange={(e) => (e.target.files && addFiles(fromFileList(e.target.files, path)), (e.target.value = ""))} />
      </div>

      <div ref={areaRef} onMouseDown={onAreaDown} data-testid="file-area" className={cx("min-h-[55vh] flex-1 py-3", band && "sel-none")}>
        {items === null && (view === "grid" ? <SkFileGrid /> : <SkFileRows />)}
        {err && (
          <Empty icon={err.status === 401 || err.status === 403 ? <Lock className="size-10" /> : undefined} title={err.status === 401 ? "需要登录或目录密码" : err.status === 403 ? "没有访问权限" : "加载失败"}>
            <p>{err.msg}</p>
            {(err.status === 401 || err.status === 403) && (
              <form className="mx-auto mt-3 flex max-w-xs gap-2" onSubmit={(e) => (e.preventDefault(), pathPassword.set(pw), load(true))}>
                <Input type="password" placeholder="目录密码" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="目录密码" />
                <Button type="submit" variant="primary">
                  <KeyRound className="size-4" />
                </Button>
              </form>
            )}
          </Empty>
        )}
        {items && !err && list.length === 0 && phs.length === 0 && (
          <Empty icon={<Upload className="size-10" />} title={isRoot ? "还没有存储" : "这个文件夹是空的"}>
            {isRoot ? (isAdmin ? <a className="text-accent underline" href="#/admin/mounts">去添加挂载点</a> : "请联系管理员添加存储") : "拖拽文件或文件夹到这里，或按 Ctrl+V 粘贴上传"}
          </Empty>
        )}

        {(list.length > 0 || phs.length > 0) && view === "list" && (
          <div role="grid" aria-label="文件列表" aria-multiselectable className="overflow-hidden rounded-xl border border-line bg-panel">
            <div role="row" className="hidden grid-cols-[2.75rem_1fr_7rem_10rem_2.5rem] items-center gap-2 border-b border-line bg-panel-2 px-3 py-2 text-xs font-medium text-muted sm:grid">
              <span role="columnheader">
                <Checkbox label="全选" checked={sel.size > 0 && sel.size === list.length} indeterminate={sel.size > 0 && sel.size < list.length} onChange={(v) => setSel(v ? new Set(list.map((i) => i.path)) : new Set())} />
              </span>
              <span role="columnheader"><button className="text-left hover:text-fg" onClick={() => setSort({ by: "name", desc: sort.by === "name" && !sort.desc })}>名称</button></span>
              <span role="columnheader" className="text-right"><button className="hover:text-fg" onClick={() => setSort({ by: "size", desc: !(sort.by === "size" && sort.desc) })}>大小</button></span>
              <span role="columnheader"><button className="text-left hover:text-fg" onClick={() => setSort({ by: "modified", desc: !(sort.by === "modified" && sort.desc) })}>修改时间</button></span>
              <span />
            </div>
            {phs.map((p) => <PhRow key={"ph:" + p.key} p={p} />)}
            {list.map((i, idx) => (
              <div
                role="row"
                {...dragProps(i)}
                aria-selected={sel.has(i.path)}
                key={i.path}
                data-path={i.path}
                onClick={(e) => click(e, i, idx)}
                onDoubleClick={() => open(i)}
                onContextMenu={(e) => onItemContext(e, i)}
                {...hover.bind(pf.hoverPreview && !i.is_dir && (kindOf(i.name) === "image" || kindOf(i.name) === "video") ? fileUrl(i.path) : null, { blur: isBlurred(tagMap[i.path]) })}
                className={cx("group grid cursor-default grid-cols-[2.75rem_1fr_2.5rem] items-center gap-2 border-b border-line px-3 py-1.5 last:border-b-0 sm:grid-cols-[2.75rem_1fr_7rem_10rem_2.5rem]", sel.has(i.path) ? "bg-accent-soft" : "hover:bg-hover", dragCls(i))}
              >
                <span role="gridcell" onClick={(e) => e.stopPropagation()}>
                  <Checkbox label={`选择 ${i.name}`} checked={sel.has(i.path)} onChange={() => toggle(i)} stopClick className={cx(!sel.has(i.path) && "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100")} />
                </span>
                <span role="gridcell" className="flex min-w-0 items-center gap-2.5">
                  {i.is_dir && !i.mount_kind ? <FolderIcon size={22} open={opening === i.path} /> : isMedia(i) ? <MediaCover path={i.path} name={i.name} tags={tagMap[i.path]} className="size-8 shrink-0 rounded-md" /> : <FileIcon name={i.name} isDir={i.is_dir} mountKind={i.mount_kind} />}
                  <span className="min-w-0">
                    <a data-row-link href={i.is_dir ? filesHref(i.path) : undefined} onClick={(e) => { if (!i.is_dir) return; if (e.metaKey || e.ctrlKey || e.shiftKey) e.preventDefault(); }} className="block truncate text-[13.5px]">
                      {i.name}
                    </a>
                    <span className="block text-[11px] text-faint sm:hidden">{i.is_dir ? (i.mount_kind ? i.mount_kind.toUpperCase() : "文件夹") : `${fmtSize(i.size)} · ${fmtTime(i.modified_unix)}`}</span>
                  </span>
                  {tagPills(i)}
                  {!i.is_dir && kindOf(i.name) === "audio" && <WaveRowExtra item={i} queue={audios} />}
                  {i.read_only && <span className="rounded bg-hover px-1 text-[10px] text-muted">只读</span>}
                </span>
                <span role="gridcell" className="hidden text-right text-xs text-muted tabular-nums sm:block">{i.is_dir ? "—" : fmtSize(i.size)}</span>
                <span role="gridcell" className="hidden text-xs text-muted tabular-nums sm:block">{fmtTime(i.modified_unix)}</span>
                <span role="gridcell" className="flex justify-end opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-aria-selected:opacity-100">
                  <ItemMenu i={i} />
                </span>
              </div>
            ))}
          </div>
        )}

        {(list.length > 0 || phs.length > 0) && view === "grid" && (
          <ul aria-label="文件网格" className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
            {phs.map((p) => <PhCard key={"ph:" + p.key} p={p} />)}
            {list.map((i, idx) => {
              const cover = isMedia(i);
              return (
                <li key={i.path} {...dragProps(i)} aria-selected={sel.has(i.path)} onClick={(e) => click(e, i, idx)} onDoubleClick={() => open(i)} onContextMenu={(e) => onItemContext(e, i)} className={cx("group relative flex cursor-default flex-col overflow-hidden rounded-xl border bg-panel", sel.has(i.path) ? "border-accent ring-2 ring-accent/30" : "border-line hover:bg-hover", dragCls(i))}>
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-panel-2">
                    {cover ? <MediaCover path={i.path} name={i.name} tags={tagMap[i.path]} alt={i.name} className="size-full" /> : i.is_dir && !i.mount_kind ? <FolderIcon size={60} open={opening === i.path} className="mt-3" /> : <FileIcon name={i.name} isDir={i.is_dir} mountKind={i.mount_kind} className="size-10" />}
                  </div>
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{i.name}</span>
                      <span className="block text-[11px] text-faint">{i.is_dir ? "文件夹" : fmtSize(i.size)}</span>
                      {tagPills(i, true)}
                    </span>
                    <ItemMenu i={i} />
                  </div>
                  <Checkbox label={`选择 ${i.name}`} checked={sel.has(i.path)} onChange={() => toggle(i)} stopClick className={cx("absolute top-1 left-1 bg-panel !min-h-10 !min-w-10 shadow-card", !sel.has(i.path) && "opacity-0 group-hover:opacity-100")} />
                </li>
              );
            })}
          </ul>
        )}

        {view === "gallery" && (galleryAll !== null || list.length > 0) && (
          <>
            <div className="mb-2 flex items-center gap-3 text-xs text-muted">
              <span data-gallery-count>{galleryImages.length} 张图片{galleryVideos.length ? ` · ${galleryVideos.length} 个视频` : ""}（整个文件夹）</span>
              <label className="flex items-center gap-2">
                列数
                <input type="range" min={2} max={8} value={cols} onChange={(e) => setCols(Number(e.target.value))} aria-label="相册列数" className="accent-[var(--accent)]" />
              </label>
            </div>
            {galleryItems.length === 0 ? (
              <Empty icon={<Images className="size-10" />} title={galleryAll === null ? "正在加载相册…" : "此文件夹没有图片或视频"} />
            ) : (
              <div style={{ columnCount: cols }} className="gap-2 [column-gap:0.5rem] max-sm:![column-count:2]" data-gallery>
                {galleryItems.map((i) => (
                  <button key={i.path} {...dragProps(i)} onClick={() => tabs.open(i)} onContextMenu={(e) => onItemContext(e, i)} className="mb-2 block w-full break-inside-avoid overflow-hidden rounded-lg border border-line bg-panel-2" aria-label={`查看 ${i.name}`}>
                    <MediaCover path={i.path} name={i.name} tags={tagMap[i.path]} alt={i.name} className="w-full" imgClass="w-full h-auto object-cover" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {items && !err && view !== "gallery" && <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE))} total={total - (items ? items.length - all.length : 0)} size={PAGE} sizes={PAGE_SIZES} unit="项" setSize={(n) => (localStorage.setItem("dh_pagesize_files", String(n)), setPAGE(n))} setPage={(n) => (setSel(new Set()), load(false, n))} />}
        {readme && <Readme item={readme} />}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/70">
          <p className="text-sm font-medium text-accent">松开即可上传到 {path}</p>
        </div>
      )}
      {band && band.w + band.h > 0 && <div className="band" data-testid="band" style={{ left: band.l, top: band.t, width: band.w, height: band.h }} />}
      <TrashZone active={!!dragPaths && !isRoot} home={dragHome} count={dragPaths?.length ?? 0} onDelete={() => { liftOutcome("delete"); const ps = dragPaths ?? []; setDragPaths(null); setDragSrc(null); setDragHome(null); const its = all.filter((i) => ps.includes(i.path)); if (its.length) scheduleDelete(its); }} />
      <DirPicker open={!!picker} title={picker === "move" ? `移动 ${selected.length} 项到…` : `复制 ${selected.length} 项到…`} start={path} onClose={() => setPicker(null)} onPick={(d) => transfer(picker!, d)} />
      {!hidden && selected.length > 0 && (
        <Dock label="批量操作">
          <span className="mr-1 flex h-11 shrink-0 items-center gap-1 rounded-2xl bg-accent-soft pr-1 pl-3 text-[13px] font-medium text-accent">
            <span className="max-sm:hidden">已选&nbsp;</span>{selected.length} 项{selected.some((x) => !x.is_dir) && <span className="hidden font-normal sm:inline"> · {fmtSize(selected.reduce((a, b) => a + (b.is_dir ? 0 : b.size), 0))}</span>}
            <button aria-label="取消选择" onClick={() => setSel(new Set())} className="ml-1 rounded-full p-1.5 hover:bg-accent/15"><X className="size-3.5" /></button>
          </span>
          {selected.length === 1 && <DockBtn icon={<Eye />} label="打开" onClick={() => open(selected[0])} />}
          <DockBtn icon={selected.length === 1 && !selected[0].is_dir ? <Download /> : <FileArchive />} label={selected.length === 1 && !selected[0].is_dir ? "下载" : "打包下载"} onClick={() => download(selected)} />
          {selected.length === 1 && <DockBtn className="max-sm:hidden" icon={<Share2 />} label="分享" onClick={() => setSharing(selected)} />}
          {!isRoot && selected.length === 1 && <DockBtn icon={<Pencil />} label="重命名" onClick={() => rename(selected[0])} />}
          {!isRoot && <DockBtn icon={<FolderInput />} label="移动到…" onClick={() => setPicker("move")} />}
          {!isRoot && <DockBtn className="max-sm:hidden" icon={<Copy />} label="复制到…" onClick={() => setPicker("copy")} />}
          {selected.length === 1 && <DockBtn className="max-sm:hidden" icon={<Info />} label="属性" onClick={() => setDetails(selected[0])} />}
          <DockBtn className="max-sm:hidden" icon={<CheckSquare />} label="全选" onClick={() => setSel(new Set(list.map((i) => i.path)))} />
          {!isRoot && (
            <span className="ml-1 flex h-11 items-center border-l border-line pl-1.5">
              <ConfirmButton icon={<Trash2 />} label="删除" confirmLabel={`删除 ${selected.length} 项`} onConfirm={() => scheduleDelete(selected)} />
            </span>
          )}
        </Dock>
      )}
      <ContextMenu at={ctxMenu} onClose={closeCtx} label="文件操作">
        {(close) =>
          ctxMenu?.item ? (
            itemActions(ctxMenu.item, close)
          ) : (
            <div>
              {!isRoot && <MenuItem icon={<FolderPlus />} onClick={() => (close(), mkdir())}>新建文件夹</MenuItem>}
              {!isRoot && <MenuItem icon={<Upload />} onClick={() => (close(), fileInput.current?.click())}>上传文件</MenuItem>}
              {!isRoot && <MenuItem icon={<FolderUp />} onClick={() => (close(), dirInput.current?.click())}>上传文件夹</MenuItem>}
              {!isRoot && <MenuSep />}
              <MenuItem icon={<CheckSquare />} kbd="Ctrl A" onClick={() => (close(), setSel(new Set(list.map((i) => i.path))))}>全选</MenuItem>
              <MenuItem icon={<RefreshCw />} onClick={() => (close(), load(true))}>刷新</MenuItem>
              <MenuItem icon={<Link2 />} onClick={() => (close(), copy(appLink({ path, is_dir: true }), "链接"))}>复制此文件夹链接</MenuItem>
            </div>
          )
        }
      </ContextMenu>
      <ShareDialog items={sharing} onClose={() => setSharing([])} />
      <WavePlayerBar />
      <DetailsDialog item={details} onClose={() => setDetails(null)} />
      {tagging && <TagDialog items={tagging} current={tagMap} onClose={() => setTagging(null)} onChanged={(m) => setTagMap((t) => ({ ...t, ...m }))} />}
      {hover.node && createPortal(hover.node, document.body)}
    </div>
  );
}

