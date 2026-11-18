import { lazy, Suspense, useEffect, useState } from "react";
import { FolderOpen, Search as SearchIcon, Sparkles } from "lucide-react";
import { client, ok, type FsItem, type SearchHit } from "../lib/api";
import { filesHref, go } from "../lib/router";
import { cx, errMsg, extsOf, fmtSize, fmtTime, KIND_LABEL, parentOf, type Kind } from "../lib/util";
import { Badge, Empty, IconButton, Input, Select, Spinner, PageHeader, Pager, usePaged } from "../ui/ui";
import { FileIcon } from "../components/FileIcon";

const Preview = lazy(() => import("../components/Preview"));
const KINDS: Kind[] = ["image", "video", "audio", "pdf", "office", "markdown", "code", "archive"];
const SIZES = [
  ["", "不限大小"],
  ["size:<1m", "< 1 MB"],
  ["size:>10m", "> 10 MB"],
  ["size:>100m", "> 100 MB"],
  ["size:>1g", "> 1 GB"],
] as const;

export function SearchPage({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [mount, setMount] = useState("");
  const [size, setSize] = useState("");
  const [mode, setMode] = useState<"keyword" | "semantic">("keyword");
  const [mounts, setMounts] = useState<string[]>([]);
  const [res, setRes] = useState<{ hits: SearchHit[]; total: number; took: number; msg?: string | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState<FsItem | null>(null);

  useEffect(() => {
    ok(client.GET("/api/fs/list", { params: { query: { path: "/" } } })).then((r) => setMounts(r.items.map((i) => i.name))).catch(() => {});
  }, []);
  useEffect(() => setText(initial), [initial]);

  const query = [text.trim(), kinds.length ? `ext:${kinds.flatMap(extsOf).join(",")}` : "", mount ? `mount:${mount}` : "", size].filter(Boolean).join(" ");
  useEffect(() => {
    if (!query) return setRes(null);
    setLoading(true);
    setErr("");
    const t = setTimeout(() => {
      ok(client.GET("/api/search", { params: { query: { q: query, mode, limit: 200 } } }))
        .then((r) => setRes({ hits: r.hits, total: r.total, took: r.took_ms, msg: r.enabled ? null : r.message }))
        .catch((e) => setErr(errMsg(e)))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [query, mode]);

  const toggleKind = (k: Kind) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  const asItem = (h: SearchHit): FsItem => ({ name: h.name, path: h.path, is_dir: h.is_dir, size: h.size, modified_unix: h.modified_unix });
  const pg = usePaged(res?.hits ?? [], 15, query);
  const files = res?.hits.filter((h) => !h.is_dir).map(asItem) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 py-4">
      <PageHeader title="搜索" desc="按文件名、类型、存储与大小查找" />
      <form onSubmit={(e) => e.preventDefault()} className="space-y-3 rounded-2xl border border-line bg-panel p-4 shadow-card">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <SearchIcon className="pointer-events-none absolute top-3 left-3 size-4 text-faint" />
            <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="文件名关键词（中文分词）…" className="pl-9" aria-label="搜索关键词" />
          </div>
          <Select value={mode} onChange={(e) => setMode(e.target.value as "keyword" | "semantic")} aria-label="搜索模式">
            <option value="keyword">关键词</option>
            <option value="semantic">语义（二期）</option>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {KINDS.map((k) => (
            <button type="button" key={k} onClick={() => toggleKind(k)} aria-pressed={kinds.includes(k)} className={cx("btn-key min-h-8 rounded-full border px-3 py-1 text-xs", kinds.includes(k) ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:bg-hover")}>
              {KIND_LABEL[k]}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          <Select value={mount} onChange={(e) => setMount(e.target.value)} aria-label="存储">
            <option value="">全部存储</option>
            {mounts.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
          <Select value={size} onChange={(e) => setSize(e.target.value)} aria-label="大小">
            {SIZES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-[11px] text-faint">
          实际查询：<code className="rounded bg-hover px-1">{query || "（空）"}</code> · 语法：<code>ext:pdf,docx</code> <code>size:&gt;10m</code> <code>mount:名称</code>
        </p>
      </form>

      {loading && <Spinner />}
      {err && <p className="text-sm text-danger">{err}</p>}
      {res?.msg && (
        <p className="flex items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-[13px] text-accent">
          <Sparkles className="size-4" /> {res.msg}
        </p>
      )}
      {res && !res.msg && (
        <>
          <p className="text-xs text-muted">
            共 {res.total} 条 · {res.took.toFixed(1)} ms
          </p>
          {res.hits.length === 0 ? (
            <Empty icon={<SearchIcon className="size-10" />} title="没有找到匹配的文件" />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel shadow-card">
              {pg.slice.map((h) => (
                <li key={h.path} className="flex items-center gap-3 px-3 py-2 hover:bg-hover">
                  <FileIcon name={h.name} isDir={h.is_dir} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => (h.is_dir ? go(filesHref(h.path)) : setPreview(asItem(h)))}>
                    <p className="truncate text-[13.5px]">{h.name}</p>
                    <p className="truncate text-[11px] text-faint">{parentOf(h.path)}</p>
                  </button>
                  <Badge>{h.mount}</Badge>
                  <span className="hidden w-20 text-right text-xs text-muted sm:block">{h.is_dir ? "" : fmtSize(h.size)}</span>
                  <span className="hidden w-32 text-xs text-muted md:block">{fmtTime(h.modified_unix)}</span>
                  <IconButton label="打开所在文件夹" onClick={() => go(filesHref(h.is_dir ? h.path : parentOf(h.path)))}>
                    <FolderOpen className="size-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <Pager {...pg} />
        </>
      )}
      {!query && <Empty icon={<SearchIcon className="size-10" />} title="输入关键词或选择筛选条件">也可以随时按 Ctrl/⌘ + K 快速搜索</Empty>}
      {preview && (
        <Suspense fallback={null}>
          <Preview item={preview} siblings={files} onClose={() => setPreview(null)} onChange={setPreview} />
        </Suspense>
      )}
    </div>
  );
}
