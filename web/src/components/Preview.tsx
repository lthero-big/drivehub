// File preview (lazy chunk): image gallery, video/audio (+ external players), PDF, Markdown,
// code/text, zip listing via Range reads, DOCX, and a download fallback.
import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Music } from "lucide-react";
import { fileUrl, rawFetch, type FsItem } from "../lib/api";
import { cx, ext, fmtSize, kindOf } from "../lib/util";
import { Button, Spinner } from "../ui/ui";
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

/**
 * Image viewer as a card stack (after 21st "triage card stack"): drag the top card sideways — it tilts
 * 0.065°/px (opposite when grabbed on the lower half), cards behind rise as you drag; past min(35% width, 140px)
 * or a 500px/s flick it flies off and the next image comes up. Drag right / ← goes back. Reduced motion: fades.
 */
function ImageStack({ item, siblings, onPick }: { item: FsItem; siblings: FsItem[]; onPick: (i: FsItem) => void }) {
  const imgs = useMemo(() => {
    const l = siblings.filter((s) => !s.is_dir && kindOf(s.name) === "image");
    return l.some((s) => s.path === item.path) ? l : [item];
  }, [siblings, item]);
  const idx = Math.max(0, imgs.findIndex((s) => s.path === item.path));
  const box = useRef<HTMLDivElement>(null);
  const d = useRef<{ x0: number; y0: number; top: boolean; hist: { x: number; t: number }[] } | null>(null);
  const [off, setOff] = useState({ x: 0, y: 0, dragging: false });
  const [fly, setFly] = useState<0 | 1 | -1>(0);
  const [enter, setEnter] = useState<0 | 1 | -1>(0);
  const rm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const prev = idx > 0 ? imgs[idx - 1] : null;
  const next = idx < imgs.length - 1 ? imgs[idx + 1] : null;
  const goto = (dir: 1 | -1) => {
    const target = dir === 1 ? next : prev;
    if (!target) return setOff({ x: 0, y: 0, dragging: false });
    if (rm) return onPick(target);
    if (dir === 1) {
      setFly(-1);
      setTimeout(() => (setFly(0), setOff({ x: 0, y: 0, dragging: false }), onPick(target)), 220);
    } else {
      setOff({ x: 0, y: 0, dragging: false });
      setEnter(1);
      onPick(target);
      requestAnimationFrame(() => requestAnimationFrame(() => setEnter(0)));
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,[role=dialog]")) return;
      if (e.key === "ArrowRight") goto(1);
      else if (e.key === "ArrowLeft") goto(-1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  const down = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    d.current = { x0: e.clientX, y0: e.clientY, top: e.clientY < r.top + r.height / 2, hist: [{ x: e.clientX, t: performance.now() }] };
    setOff({ x: 0, y: 0, dragging: true });
  };
  const move = (e: RPointerEvent) => {
    const s = d.current;
    if (!s) return;
    let y = e.clientY - s.y0;
    if (Math.abs(y) > 48) y = Math.sign(y) * (48 + (Math.abs(y) - 48) * 0.25); // vertical rubber band
    s.hist = [...s.hist.slice(-4), { x: e.clientX, t: performance.now() }];
    setOff({ x: e.clientX - s.x0, y, dragging: true });
  };
  const up = () => {
    const s = d.current;
    d.current = null;
    if (!s) return;
    const w = box.current?.clientWidth ?? 600;
    const h0 = s.hist[0], h1 = s.hist[s.hist.length - 1];
    const v = ((h1.x - h0.x) / Math.max(1, h1.t - h0.t)) * 1000;
    const dir = off.x < 0 ? 1 : -1; // drag left → next
    const far = Math.abs(off.x) > Math.min(w * 0.35, 140);
    const flick = Math.abs(v) > 500 && Math.sign(v) === Math.sign(off.x) && Math.abs(off.x) > 12;
    if (far || flick) goto(dir);
    else setOff({ x: 0, y: 0, dragging: false });
  };
  const lift = Math.min(1, Math.abs(off.x) / 160) * 0.4;
  const cards = imgs.slice(idx, idx + 4);
  return (
    <div ref={box} className="relative flex h-full min-h-72 flex-col select-none">
      <div className="relative min-h-0 flex-1">
        {cards
          .map((c, k) => {
            const top = k === 0;
            const depth = top ? 0 : Math.max(0, k - lift);
            const rot = top ? off.x * 0.065 * (d.current?.top === false ? -1 : 1) : 0;
            const tx = top ? (fly ? fly * (w0() + 200) : enter ? (box.current?.clientWidth ?? 800) : off.x) : 0;
            const style = {
              transform: `translate3d(${tx}px, ${top ? off.y : depth * 14}px, 0) rotate(${fly ? fly * 18 : enter ? 12 : rot}deg) scale(${1 - depth * 0.05})`,
              opacity: top ? (fly ? 0 : 1) : k > 2 ? 0 : 1 - depth * 0.18,
              zIndex: 10 - k,
            };
            return (
              <div
                key={c.path}
                className={cx("stack-card absolute inset-x-[4%] top-2 bottom-10 overflow-hidden rounded-2xl border border-line bg-panel-2 shadow-pop sm:inset-x-[8%]", top && off.dragging && "dragging", top ? "cursor-grab active:cursor-grabbing" : "pointer-events-none")}
                style={style}
                onPointerDown={top ? down : undefined}
                onPointerMove={top ? move : undefined}
                onPointerUp={top ? up : undefined}
                onPointerCancel={top ? up : undefined}
              >
                <img src={fileUrl(c.path)} alt={c.name} draggable={false} className="size-full object-contain" />
              </div>
            );
          })
          .reverse()}
        {prev && (
          <button aria-label="上一张" onClick={() => goto(-1)} className="absolute top-1/2 left-1 z-20 -translate-y-1/2 rounded-full border border-line bg-panel p-2 shadow-pop hover:bg-hover">
            <ChevronLeft className="size-5" />
          </button>
        )}
        {next && (
          <button aria-label="下一张" onClick={() => goto(1)} className="absolute top-1/2 right-1 z-20 -translate-y-1/2 rounded-full border border-line bg-panel p-2 shadow-pop hover:bg-hover">
            <ChevronRight className="size-5" />
          </button>
        )}
      </div>
      <p className="absolute inset-x-0 bottom-1 truncate text-center text-xs text-muted">
        {item.name} · {idx + 1} / {imgs.length} · 左右拖动或 ← → 切换
      </p>
    </div>
  );
  function w0() {
    return box.current?.clientWidth ?? 800;
  }
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
      return <ImageStack item={item} siblings={siblings} onPick={onPick} />;
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

/** Embedded file body for an editor tab (no chrome; the tab strip + breadcrumb live in Editor). */
export default function FileBody({ item, siblings, onPick }: { item: FsItem; siblings: FsItem[]; onPick: (i: FsItem) => void }) {
  return <Body item={item} siblings={siblings} onPick={onPick} />;
}
