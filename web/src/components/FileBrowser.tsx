import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as RMouseEvent } from "react";
import {
  ArrowDownAZ, Check, ChevronRight, Copy, Download, Eye, FileArchive, FolderInput, FolderPlus, FolderUp, Grid2x2, Images, KeyRound, List,
  MoreHorizontal, Pencil, RefreshCw, Shield, Trash2, Upload, X, Lock,
} from "lucide-react";
import { ApiError, client, fileUrl, ok, pathPassword, rawFetch, zipUrl, type FsItem } from "../lib/api";
import { useApp } from "../lib/app";
import { filesHref, go } from "../lib/router";
import { fromDataTransfer, fromFileList, uploads } from "../lib/uploads";
import { baseName, cx, errMsg, fmtSize, fmtTime, joinPath, kindOf } from "../lib/util";
import { ask, Button, Checkbox, confirmDlg, Empty, IconButton, Input, Menu, MenuItem, Pager, Spinner, toast } from "../ui/ui";
import { DirPicker } from "./DirPicker";
import { FileIcon } from "./FileIcon";

const Preview = lazy(() => import("./Preview"));

type View = "list" | "grid" | "gallery";
type Sort = { by: "name" | "size" | "modified"; desc: boolean };
const PAGE = 60;

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

export function FileBrowser({ path }: { path: string }) {
  const { fsVersion, bumpFs, isAdmin } = useApp();
  const [items, setItems] = useState<FsItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState<{ msg: string; status: number } | null>(null);
  const [view, setView] = useStored<View>("dh_view", "list");
  const [sort, setSort] = useStored<Sort>("dh_sort", { by: "name", desc: false });
  const [cols, setCols] = useStored<number>("dh_gallery_cols", 4);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<number>(-1);
  const [preview, setPreview] = useState<FsItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const [picker, setPicker] = useState<null | "move" | "copy">(null);
  const [pw, setPw] = useState("");
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
      } catch (e) {
        setErr({ msg: errMsg(e), status: e instanceof ApiError ? e.status : 0 });
        setItems([]);
      }
    },
    [path, sort.by, sort.desc],
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
  const all = items ?? [];
  const list = useMemo(() => (q.trim() ? all.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())) : all), [all, q]);
  const selected = useMemo(() => list.filter((i) => sel.has(i.path)), [list, sel]);
  const images = useMemo(() => list.filter((i) => !i.is_dir && kindOf(i.name) === "image"), [list]);
  const readme = useMemo(() => list.find((i) => !i.is_dir && /^readme\.(md|markdown)$/i.test(i.name)), [list]);

  const open = (i: FsItem) => (i.is_dir ? go(filesHref(i.path)) : setPreview(i));

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
      load(true);
    } catch (e) {
      toast.err(errMsg(e));
    }
  };
  const remove = async (its: FsItem[]) => {
    if (!its.length) return;
    const yes = await confirmDlg(its.length === 1 ? `删除「${its[0].name}」？` : `删除 ${its.length} 项？`, { label: "删除后无法恢复（文件夹会连同内容一起删除）。", confirm: "删除", danger: true });
    if (!yes) return;
    let n = 0;
    for (const i of its) {
      try {
        await ok(client.POST("/api/fs/delete", { body: { path: i.path } }));
        n++;
      } catch (e) {
        toast.err(`${i.name}：${errMsg(e)}`);
      }
    }
    if (n) toast.ok(`已删除 ${n} 项`);
    setSel(new Set());
    load(true);
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
  const addFiles = (files: { file: File; path: string }[]) => {
    if (isRoot) return toast.err("请先进入一个存储再上传");
    if (files.length) uploads.add(files);
  };

  // ---- keyboard / paste / drop ----------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (preview || t.closest("input,textarea,select,[role=dialog]")) return;
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
      if (t.closest("input,textarea")) return;
      const fs = e.clipboardData?.files;
      if (fs?.length) {
        e.preventDefault();
        addFiles(fromFileList(fs, path));
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
    e.preventDefault();
    setDragging(false);
    addFiles(await fromDataTransfer(e.dataTransfer, path));
  };

  // ---- render ---------------------------------------------------------------
  const sortLabel = { name: "名称", size: "大小", modified: "修改时间" }[sort.by];
  const ItemMenu = ({ i }: { i: FsItem }) => (
    <Menu
      trigger={(t) => (
        <IconButton label="更多操作" onClick={(e) => (e.stopPropagation(), t())}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      )}
    >
      {(close) => (
        <div onClick={(e) => e.stopPropagation()}>
          <MenuItem icon={<Eye />} onClick={() => (close(), open(i))}>打开</MenuItem>
          <MenuItem icon={i.is_dir ? <FileArchive /> : <Download />} onClick={() => (close(), download([i]))}>{i.is_dir ? "打包下载" : "下载"}</MenuItem>
          {!isRoot && <MenuItem icon={<Pencil />} kbd="F2" onClick={() => (close(), rename(i))}>重命名</MenuItem>}
          {!isRoot && <MenuItem icon={<FolderInput />} onClick={() => (close(), setSel(new Set([i.path])), setPicker("move"))}>移动到…</MenuItem>}
          {!isRoot && <MenuItem icon={<Copy />} onClick={() => (close(), setSel(new Set([i.path])), setPicker("copy"))}>复制到…</MenuItem>}
          {isAdmin && <MenuItem icon={<Shield />} onClick={() => (close(), go(`#/admin/acl?path=${encodeURIComponent(i.path)}`))}>权限设置</MenuItem>}
          {!isRoot && <MenuItem icon={<Trash2 />} danger kbd="Del" onClick={() => (close(), remove([i]))}>删除</MenuItem>}
        </div>
      )}
    </Menu>
  );

  return (
    <div className="relative flex min-h-full flex-col" onDragOver={(e) => (e.preventDefault(), !isRoot && setDragging(true))} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={onDrop}>
      <div className="sticky top-0 z-10 -mx-3 flex flex-wrap items-center gap-2 border-b border-line bg-panel/95 px-3 py-2 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <Crumbs path={path} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Input className="hidden !h-9 w-40 sm:block" placeholder="筛选本页…" aria-label="筛选文件" value={q} onChange={(e) => setQ(e.target.value)} />
          {!isRoot && (
            <>
              <Button size="sm" variant="primary" onClick={() => fileInput.current?.click()}>
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
          <div className="flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label="视图">
            {([["list", List, "列表"], ["grid", Grid2x2, "网格"], ["gallery", Images, "相册"]] as const).map(([v, I, l]) => (
              <button key={v} role="radio" aria-checked={view === v} aria-label={l} title={l} onClick={() => setView(v)} className={cx("rounded-md p-1.5", view === v ? "bg-active text-fg" : "text-muted hover:text-fg")}>
                <I className="size-4" />
              </button>
            ))}
          </div>
          <IconButton label="刷新" onClick={() => load(true)}>
            <RefreshCw className="size-4" />
          </IconButton>
        </div>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(fromFileList(e.target.files, path)), (e.target.value = ""))} />
        <input ref={dirInput} type="file" hidden {...({ webkitdirectory: "" } as object)} onChange={(e) => (e.target.files && addFiles(fromFileList(e.target.files, path)), (e.target.value = ""))} />
        {selected.length > 0 && (
          <div role="toolbar" aria-label="批量操作" className="anim-in scroll-thin absolute inset-0 z-10 flex items-center gap-1 overflow-x-auto border-b border-line bg-accent-soft px-3 text-[13px] whitespace-nowrap sm:px-6">
            <IconButton label="取消选择" onClick={() => setSel(new Set())}>
              <X className="size-4" />
            </IconButton>
            <span className="mr-2 shrink-0 font-medium">已选 {selected.length} 项 · {fmtSize(selected.reduce((a, b) => a + b.size, 0))}</span>
            <Button size="sm" variant="ghost" onClick={() => download(selected)}>
              <Download className="size-4" /> {selected.length === 1 && !selected[0].is_dir ? "下载" : "打包下载"}
            </Button>
            {!isRoot && (
              <>
                {selected.length === 1 && (
                  <Button size="sm" variant="ghost" onClick={() => rename(selected[0])}>
                    <Pencil className="size-4" /> 重命名
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setPicker("move")}>
                  <FolderInput className="size-4" /> 移动
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPicker("copy")}>
                  <Copy className="size-4" /> 复制
                </Button>
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => remove(selected)}>
                  <Trash2 className="size-4" /> 删除
                </Button>
              </>
            )}
          </div>
        )}

      </div>

      <div className="flex-1 py-3">
        {items === null && (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        )}
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
        {items && !err && list.length === 0 && (
          <Empty icon={<Upload className="size-10" />} title={isRoot ? "还没有存储" : "这个文件夹是空的"}>
            {isRoot ? (isAdmin ? <a className="text-accent underline" href="#/admin/mounts">去添加挂载点</a> : "请联系管理员添加存储") : "拖拽文件或文件夹到这里，或按 Ctrl+V 粘贴上传"}
          </Empty>
        )}

        {list.length > 0 && view === "list" && (
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
            {list.map((i, idx) => (
              <div
                role="row"
                aria-selected={sel.has(i.path)}
                key={i.path}
                data-path={i.path}
                onClick={(e) => click(e, i, idx)}
                onDoubleClick={() => open(i)}
                className={cx("group grid cursor-default grid-cols-[2.75rem_1fr_2.5rem] items-center gap-2 border-b border-line px-3 py-1.5 last:border-b-0 sm:grid-cols-[2.75rem_1fr_7rem_10rem_2.5rem]", sel.has(i.path) ? "bg-accent-soft" : "hover:bg-hover")}
              >
                <span role="gridcell" onClick={(e) => e.stopPropagation()}>
                  <Checkbox label={`选择 ${i.name}`} checked={sel.has(i.path)} onChange={() => toggle(i)} stopClick className={cx(!sel.has(i.path) && "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100")} />
                </span>
                <span role="gridcell" className="flex min-w-0 items-center gap-2.5">
                  <FileIcon name={i.name} isDir={i.is_dir} mountKind={i.mount_kind} />
                  <span className="min-w-0">
                    <a href={i.is_dir ? filesHref(i.path) : undefined} onClick={(e) => { if (!i.is_dir) return; if (e.metaKey || e.ctrlKey || e.shiftKey) e.preventDefault(); }} className="block truncate text-[13.5px]">
                      {i.name}
                    </a>
                    <span className="block text-[11px] text-faint sm:hidden">{i.is_dir ? (i.mount_kind ? i.mount_kind.toUpperCase() : "文件夹") : `${fmtSize(i.size)} · ${fmtTime(i.modified_unix)}`}</span>
                  </span>
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

        {list.length > 0 && view === "grid" && (
          <ul aria-label="文件网格" className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
            {list.map((i, idx) => {
              const img = !i.is_dir && kindOf(i.name) === "image";
              return (
                <li key={i.path} aria-selected={sel.has(i.path)} onClick={(e) => click(e, i, idx)} onDoubleClick={() => open(i)} className={cx("group relative flex cursor-default flex-col overflow-hidden rounded-xl border bg-panel", sel.has(i.path) ? "border-accent ring-2 ring-accent/30" : "border-line hover:bg-hover")}>
                  <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-panel-2">
                    {img ? <img src={fileUrl(i.path)} alt="" loading="lazy" decoding="async" className="size-full object-cover" /> : <FileIcon name={i.name} isDir={i.is_dir} mountKind={i.mount_kind} className="size-10" />}
                  </div>
                  <div className="flex items-center gap-1 px-2 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{i.name}</span>
                      <span className="block text-[11px] text-faint">{i.is_dir ? "文件夹" : fmtSize(i.size)}</span>
                    </span>
                    <ItemMenu i={i} />
                  </div>
                  <Checkbox label={`选择 ${i.name}`} checked={sel.has(i.path)} onChange={() => toggle(i)} stopClick className={cx("glass absolute top-1 left-1 !min-h-10 !min-w-10 shadow-card", !sel.has(i.path) && "opacity-0 group-hover:opacity-100")} />
                </li>
              );
            })}
          </ul>
        )}

        {list.length > 0 && view === "gallery" && (
          <>
            <div className="mb-2 flex items-center gap-3 text-xs text-muted">
              <span>{images.length} 张图片</span>
              <label className="flex items-center gap-2">
                列数
                <input type="range" min={2} max={8} value={cols} onChange={(e) => setCols(Number(e.target.value))} aria-label="相册列数" className="accent-[var(--accent)]" />
              </label>
              {list.length - images.length > 0 && <span>（另有 {list.length - images.length} 个非图片项，切换到列表查看）</span>}
            </div>
            {images.length === 0 ? (
              <Empty icon={<Images className="size-10" />} title="此文件夹没有图片" />
            ) : (
              <div style={{ columnCount: cols }} className="gap-2 [column-gap:0.5rem] max-sm:![column-count:2]">
                {images.map((i) => (
                  <button key={i.path} onClick={() => setPreview(i)} className="mb-2 block w-full break-inside-avoid overflow-hidden rounded-lg border border-line bg-panel-2" aria-label={`查看 ${i.name}`}>
                    <img src={fileUrl(i.path)} alt={i.name} loading="lazy" decoding="async" className="w-full" />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {items && !err && <Pager page={page} pages={Math.max(1, Math.ceil(total / PAGE))} total={total} size={PAGE} setPage={(n) => (setSel(new Set()), load(false, n))} />}
        {readme && <Readme item={readme} />}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/70">
          <p className="text-sm font-medium text-accent">松开即可上传到 {path}</p>
        </div>
      )}
      <DirPicker open={!!picker} title={picker === "move" ? `移动 ${selected.length} 项到…` : `复制 ${selected.length} 项到…`} start={path} onClose={() => setPicker(null)} onPick={(d) => transfer(picker!, d)} />
      {preview && (
        <Suspense fallback={null}>
          <Preview item={preview} siblings={list} onClose={() => setPreview(null)} onChange={setPreview} />
        </Suspense>
      )}
    </div>
  );
}

