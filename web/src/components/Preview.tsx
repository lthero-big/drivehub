// File preview (lazy chunk): image gallery, video/audio (+ external players), PDF, Markdown,
// code/text, zip listing via Range reads, DOCX, and a download fallback.
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X, Music } from "lucide-react";
import { fileUrl, rawFetch, type FsItem } from "../lib/api";
import { cx, ext, fmtSize, fmtTime, kindOf } from "../lib/util";
import { Button, IconButton, Spinner } from "../ui/ui";
import { FileIcon } from "./FileIcon";

const TEXT_MAX = 1 << 20;

async function readText(path: string, max = TEXT_MAX): Promise<{ text: string; truncated: boolean }> {
  const r = await rawFetch(fileUrl(path), { headers: { range: `bytes=0-${max - 1}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const total = Number(r.headers.get("content-range")?.split("/")[1] ?? buf.length);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("gbk").decode(buf);
  }
  return { text, truncated: total > buf.length };
}

function useAsync<T>(f: () => Promise<T>, deps: unknown[]) {
  const [s, set] = useState<{ v?: T; e?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    set({ loading: true });
    f().then(
      (v) => live && set({ v, loading: false }),
      (e) => live && set({ e: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => {
      live = false;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return s;
}

function Loading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <Spinner />
    </div>
  );
}

function Fallback({ item, why }: { item: FsItem; why: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <FileIcon name={item.name} isDir={false} className="size-14" />
      <p className="text-sm font-medium">{item.name}</p>
      <p className="text-[13px] text-muted">{why}</p>
      <a href={fileUrl(item.path, { download: true })} download={item.name}>
        <Button variant="primary">
          <Download className="size-4" /> 下载（{fmtSize(item.size)}）
        </Button>
      </a>
    </div>
  );
}

function CodeView({ item }: { item: FsItem }) {
  const s = useAsync(() => readText(item.path), [item.path]);
  if (s.loading) return <Loading />;
  if (s.e) return <Fallback item={item} why={`读取失败：${s.e}`} />;
  const lines = s.v!.text.split("\n");
  return (
    <div className="h-full overflow-auto scroll-thin rounded-lg border border-line bg-panel-2 font-mono text-[12.5px] leading-5">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className="w-12 select-none border-r border-line pr-2 text-right align-top text-faint">{i + 1}</td>
              <td className="whitespace-pre-wrap break-all pl-3 pr-4">{l || " "}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.v!.truncated && <p className="p-3 text-xs text-warn">文件较大，只显示前 1 MB。</p>}
    </div>
  );
}

function MarkdownView({ item }: { item: FsItem }) {
  const s = useAsync(async () => {
    const [{ text }, { marked }, purify] = await Promise.all([readText(item.path), import("marked"), import("dompurify")]);
    return purify.default.sanitize(await marked.parse(text, { gfm: true }));
  }, [item.path]);
  if (s.loading) return <Loading />;
  if (s.e) return <Fallback item={item} why={`读取失败：${s.e}`} />;
  return <article className="prose-dh mx-auto max-w-3xl" dangerouslySetInnerHTML={{ __html: s.v! }} />;
}

type ZipEntry = { name: string; size: number; csize: number; dir: boolean };
async function listZip(item: FsItem): Promise<ZipEntry[]> {
  const size = item.size;
  const tailLen = Math.min(size, 65557 + 22);
  const r = await rawFetch(fileUrl(item.path), { headers: { range: `bytes=${size - tailLen}-${size - 1}` } });
  const tail = new DataView(await r.arrayBuffer());
  let e = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("不是有效的 zip 文件");
  const cdSize = tail.getUint32(e + 12, true);
  const cdOff = tail.getUint32(e + 16, true);
  if (cdOff === 0xffffffff) throw new Error("ZIP64 归档暂不支持在线查看");
  const cr = await rawFetch(fileUrl(item.path), { headers: { range: `bytes=${cdOff}-${cdOff + cdSize - 1}` } });
  const cd = new DataView(await cr.arrayBuffer());
  const out: ZipEntry[] = [];
  const utf8 = new TextDecoder("utf-8");
  const gbk = new TextDecoder("gbk");
  for (let p = 0; p + 46 <= cd.byteLength && cd.getUint32(p, true) === 0x02014b50; ) {
    const flags = cd.getUint16(p + 8, true);
    const csize = cd.getUint32(p + 20, true);
    const usize = cd.getUint32(p + 24, true);
    const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
    const raw = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl);
    const name = flags & 0x800 ? utf8.decode(raw) : gbk.decode(raw);
    out.push({ name, size: usize, csize, dir: name.endsWith("/") });
    p += 46 + nl + xl + cl;
  }
  return out;
}

function ZipView({ item }: { item: FsItem }) {
  const s = useAsync(() => listZip(item), [item.path]);
  if (s.loading) return <Loading />;
  if (s.e) return <Fallback item={item} why={s.e} />;
  const files = s.v!.filter((x) => !x.dir);
  return (
    <div className="h-full overflow-auto scroll-thin rounded-lg border border-line">
      <p className="sticky top-0 border-b border-line bg-panel-2 px-3 py-2 text-xs text-muted">
        {files.length} 个文件 · 解压后 {fmtSize(files.reduce((a, b) => a + b.size, 0))}
      </p>
      <ul className="divide-y divide-line text-[13px]">
        {s.v!.map((x) => (
          <li key={x.name} className="flex items-center gap-2 px-3 py-1.5">
            <FileIcon name={x.name.replace(/\/$/, "")} isDir={x.dir} className="size-4" />
            <span className="min-w-0 flex-1 truncate">{x.name}</span>
            {!x.dir && <span className="text-xs text-faint">{fmtSize(x.size)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DocxView({ item }: { item: FsItem }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const s = useAsync(async () => {
    if (!el) return false;
    const [{ renderAsync }, r] = await Promise.all([import("docx-preview"), rawFetch(fileUrl(item.path))]);
    await renderAsync(await r.blob(), el, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true });
    return true;
  }, [item.path, el]);
  return (
    <div className="h-full overflow-auto scroll-thin rounded-lg bg-white text-black">
      {s.loading && <Loading />}
      {s.e && <Fallback item={item} why={`无法渲染：${s.e}`} />}
      <div ref={setEl} />
    </div>
  );
}

function externalPlayers(item: FsItem) {
  const abs = new URL(fileUrl(item.path), location.href).toString();
  return [
    { name: "PotPlayer", href: `potplayer://${abs}` },
    { name: "IINA", href: `iina://weblink?url=${encodeURIComponent(abs)}` },
    { name: "VLC", href: `vlc://${abs}` },
  ];
}

function Body({ item, siblings, onPick }: { item: FsItem; siblings: FsItem[]; onPick: (i: FsItem) => void }) {
  const k = kindOf(item.name);
  const url = fileUrl(item.path);
  switch (k) {
    case "image":
      return <img src={url} alt={item.name} className="mx-auto max-h-full max-w-full object-contain" />;
    case "video": {
      const hls = ext(item.name) === "m3u8";
      const playable = !hls || document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
      return (
        <div className="flex h-full flex-col gap-3">
          {playable ? (
            <video key={item.path} src={url} controls autoPlay className="min-h-0 w-full flex-1 rounded-lg bg-black" />
          ) : (
            <Fallback item={item} why="此浏览器不能直接播放 HLS，可用下面的外部播放器打开" />
          )}
          <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
            外部播放器：
            {externalPlayers(item).map((p) => (
              <a key={p.name} href={p.href} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-hover">
                <ExternalLink className="size-3.5" /> {p.name}
              </a>
            ))}
          </div>
        </div>
      );
    }
    case "audio": {
      const list = siblings.filter((s) => kindOf(s.name) === "audio");
      const idx = list.findIndex((s) => s.path === item.path);
      return (
        <div className="mx-auto flex h-full max-w-xl flex-col gap-4">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-line bg-panel-2 p-6">
            <Music className="size-10 text-accent" />
            <p className="text-center text-sm font-medium">{item.name}</p>
            <audio key={item.path} src={url} controls autoPlay className="w-full" onEnded={() => idx >= 0 && idx < list.length - 1 && onPick(list[idx + 1])} />
          </div>
          {list.length > 1 && (
            <ol className="min-h-0 flex-1 overflow-auto scroll-thin rounded-xl border border-line text-[13px]">
              {list.map((a, i) => (
                <li key={a.path}>
                  <button onClick={() => onPick(a)} className={cx("flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-hover", a.path === item.path && "bg-accent-soft text-accent")}>
                    <span className="w-6 text-right text-faint">{i + 1}</span>
                    <span className="truncate">{a.name}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      );
    }
    case "pdf":
      return <iframe title={item.name} src={url} className="h-full w-full rounded-lg border border-line bg-white" />;
    case "markdown":
      return <MarkdownView item={item} />;
    case "code":
    case "text":
      return <CodeView item={item} />;
    case "archive":
      return ext(item.name) === "zip" ? <ZipView item={item} /> : <Fallback item={item} why="此类压缩包暂不支持在线查看（支持 zip）" />;
    case "office":
      return ext(item.name) === "docx" ? <DocxView item={item} /> : <Fallback item={item} why="此 Office 格式暂不支持在线预览（支持 docx）" />;
    default:
      return item.size <= 256 * 1024 ? <CodeView item={item} /> : <Fallback item={item} why="暂不支持预览此类型" />;
  }
}

export default function Preview({ item, siblings, onClose, onChange }: { item: FsItem; siblings: FsItem[]; onClose: () => void; onChange: (i: FsItem) => void }) {
  const files = useMemo(() => siblings.filter((s) => !s.is_dir), [siblings]);
  const i = files.findIndex((f) => f.path === item.path);
  const prev = i > 0 ? files[i - 1] : null;
  const next = i >= 0 && i < files.length - 1 ? files[i + 1] : null;
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && prev) onChange(prev);
      else if (e.key === "ArrowRight" && next) onChange(next);
    };
    window.addEventListener("keydown", f);
    const o = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", f);
      document.body.style.overflow = o;
    };
  }, [prev, next, onClose, onChange]);
  return (
    <div role="dialog" aria-modal="true" aria-label={`预览 ${item.name}`} className="fixed inset-0 z-50 flex flex-col bg-bg/95 backdrop-blur-sm">
      <header className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <FileIcon name={item.name} isDir={false} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{item.name}</p>
          <p className="truncate text-xs text-muted">
            {fmtSize(item.size)} · {fmtTime(item.modified_unix)} {files.length > 1 && i >= 0 && `· ${i + 1}/${files.length}`}
          </p>
        </div>
        <a href={fileUrl(item.path, { download: true })} download={item.name} aria-label="下载" title="下载" className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg">
          <Download className="size-4" />
        </a>
        <IconButton label="关闭预览" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="relative min-h-0 flex-1 p-3 sm:p-6">
        <Body item={item} siblings={siblings} onPick={onChange} />
        {prev && (
          <button aria-label="上一个" onClick={() => onChange(prev)} className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full border border-line bg-panel/90 p-2 shadow-pop hover:bg-hover">
            <ChevronLeft className="size-5" />
          </button>
        )}
        {next && (
          <button aria-label="下一个" onClick={() => onChange(next)} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full border border-line bg-panel/90 p-2 shadow-pop hover:bg-hover">
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
}
