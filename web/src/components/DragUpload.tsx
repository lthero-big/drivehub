// Upload placeholders, "absorb" animation, internal-drag helpers and the drag-to-delete bin
// (DEPTAI-485 r3 #8, palette/interaction after lthero-big/dropit).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, RotateCw, Trash2, X } from "lucide-react";
import { uploads, type UpJob } from "../lib/uploads";
import { cx, fmtSize, kindOf } from "../lib/util";
import { FileIcon, FolderIcon } from "./FileIcon";

/** Custom MIME marking a drag that started on one of our own file rows/cards. */
export const INTERNAL_MIME = "application/x-drivehub-items";
export const isInternalDrag = (dt: DataTransfer | null) => !!dt && Array.from(dt.types).includes(INTERNAL_MIME);
export const hasExternalFiles = (dt: DataTransfer | null) => !!dt && !isInternalDrag(dt) && Array.from(dt.types).includes("Files");

let origin: { x: number; y: number } | null = null;
/** Where the next batch of uploads "flies in" from (drop point / upload button). */
export const setUploadOrigin = (x: number, y: number) => void (origin = { x, y });

export type Ph = { key: string; name: string; isDir: boolean; loaded: number; size: number; status: "queued" | "uploading" | "done" | "error"; error?: string; ids: number[]; file?: File };

export function placeholdersFor(jobs: UpJob[], dir: string, existing: Set<string>, now: number): Ph[] {
  const prefix = dir === "/" ? "/" : dir + "/";
  const g = new Map<string, Ph>();
  for (const j of jobs) {
    if (j.status === "canceled" || !j.path.startsWith(prefix)) continue;
    const rest = j.path.slice(prefix.length);
    const name = rest.split("/")[0];
    if (!name) continue;
    if (j.status === "done" && (existing.has(name) || now - (j.doneAt ?? 0) > 6000)) continue;
    const isDir = rest.includes("/");
    const o = g.get(name) ?? { key: name, name, isDir, loaded: 0, size: 0, status: "done" as Ph["status"], ids: [], file: isDir ? undefined : j.file };
    o.loaded += j.status === "done" ? j.size : j.loaded;
    o.size += j.size;
    o.ids.push(j.id);
    if (j.status === "error") (o.status = "error", (o.error = j.error));
    else if (o.status !== "error" && (j.status === "uploading" || (j.status === "queued" && o.status === "done"))) o.status = j.status === "uploading" ? "uploading" : "queued";
    g.set(name, o);
  }
  return [...g.values()];
}

/** Flies a freshly mounted placeholder in from the drop point and "sucks" it into its slot. */
function useAbsorb(ref: React.RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    const o = origin ?? { x: r.left + r.width / 2, y: r.top - 80 };
    const dx = o.x - (r.left + r.width / 2), dy = o.y - (r.top + r.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(1.9) rotate(-4deg)`, opacity: 0, filter: "blur(4px)" },
        { transform: `translate(${dx * 0.25}px, ${dy * 0.25}px) scale(1.15) rotate(1deg)`, opacity: 1, filter: "blur(0)", offset: 0.62 },
        { transform: "translate(0,0) scale(1)", opacity: 1, filter: "blur(0)" },
      ],
      { duration: 620, easing: "cubic-bezier(0.2, 0.85, 0.25, 1.05)" },
    );
    el.dataset.absorbed = "1";
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

function Progress({ p }: { p: Ph }) {
  const pct = p.size ? Math.min(100, Math.round((p.loaded / p.size) * 100)) : p.status === "done" ? 100 : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-hover" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx("h-full rounded-full transition-[width] duration-200", p.status === "error" ? "bg-danger" : p.status === "done" ? "bg-ok" : "up-bar")} style={{ width: `${p.status === "queued" ? 3 : pct}%` }} />
    </div>
  );
}
const pctOf = (p: Ph) => (p.size ? Math.min(100, Math.round((p.loaded / p.size) * 100)) : 0);
const stateText = (p: Ph) => (p.status === "done" ? "完成" : p.status === "error" ? p.error || "失败" : p.status === "queued" ? "排队中" : `${pctOf(p)}% · ${fmtSize(p.loaded)} / ${fmtSize(p.size)}`);

function Actions({ p }: { p: Ph }) {
  return (
    <span className="flex items-center gap-0.5">
      {p.status === "error" && <button aria-label="重试" onClick={() => p.ids.forEach((i) => uploads.retry(i))} className="grid size-7 place-items-center rounded-md hover:bg-hover"><RotateCw className="size-3.5" /></button>}
      {(p.status === "uploading" || p.status === "queued" || p.status === "error") && <button aria-label="取消上传" onClick={() => p.ids.forEach((i) => uploads.cancel(i))} className="grid size-7 place-items-center rounded-md hover:bg-hover"><X className="size-3.5" /></button>}
    </span>
  );
}

export function PhRow({ p }: { p: Ph }) {
  const ref = useRef<HTMLDivElement>(null);
  useAbsorb(ref);
  return (
    <div ref={ref} role="row" data-up-placeholder={p.name} data-status={p.status} className={cx("grid grid-cols-[2.75rem_1fr_auto] items-center gap-2 border-b border-line bg-brand-soft/60 px-3 py-2 sm:grid-cols-[2.75rem_1fr_17rem_2.5rem]", p.status === "done" && "up-done")}>
      <span className="grid place-items-center">{p.status === "done" ? <Check className="size-5 text-ok tick-pop" /> : p.status === "error" ? <AlertCircle className="size-5 text-danger" /> : p.isDir ? <FolderIcon size={22} /> : <FileIcon name={p.name} isDir={false} />}</span>
      <span className="min-w-0"><span className="block truncate text-[13.5px]">{p.name}</span></span>
      <span className="hidden min-w-0 flex-col gap-1 sm:flex"><Progress p={p} /><span className={cx("truncate text-[11px] tabular-nums", p.status === "error" ? "text-danger" : "text-muted")}>{stateText(p)}</span></span>
      <span className="flex justify-end"><Actions p={p} /></span>
    </div>
  );
}

export function PhCard({ p }: { p: Ph }) {
  const ref = useRef<HTMLLIElement>(null);
  useAbsorb(ref);
  const preview = useMemo(() => (p.file && kindOf(p.name) === "image" ? URL.createObjectURL(p.file) : null), [p.file, p.name]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  return (
    <li ref={ref} data-up-placeholder={p.name} data-status={p.status} className={cx("relative flex flex-col overflow-hidden rounded-xl border border-brand/40 bg-panel", p.status === "done" && "up-done")}>
      <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-panel-2">
        {preview ? <img src={preview} alt="" draggable={false} className={cx("size-full object-cover transition", p.status !== "done" && "opacity-50 blur-[1px]")} /> : p.isDir ? <FolderIcon size={60} /> : <FileIcon name={p.name} isDir={false} className="size-10" />}
        <span className="absolute top-1.5 right-1.5 rounded-full bg-panel px-1.5 py-0.5 text-[10px] font-semibold tabular-nums shadow-card">{p.status === "done" ? "✓" : p.status === "error" ? "!" : `${pctOf(p)}%`}</span>
      </div>
      <div className="space-y-1 px-2 py-1.5">
        <div className="flex items-center gap-1"><span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span><Actions p={p} /></div>
        <Progress p={p} />
        <span className={cx("block truncate text-[11px]", p.status === "error" ? "text-danger" : "text-faint")}>{stateText(p)}</span>
      </div>
    </li>
  );
}

// Dropit drag-to-trash (design.lthero.com motion-dropit-drag-trash): the bin spawns ONCE at drag start,
// next to the dragged card (home centre + 230px east for a card, i.e. ~56px past its right edge;
// vertically aligned with it) and stays frozen there for the whole drag. Hit test is the cursor
// vs the bin centre (radius 30 × 1.15), not card overlap. Hot: disc 1.42× red #dc2626, lid −24°.
// After a delete the red bin lingers ~0.8s in place.
const BIN_R = 30, BIN_PAD = 46, BIN_GAP = 56;
export const binSpot = (home: DOMRect) => ({
  x: Math.min(Math.max(home.right + BIN_GAP, BIN_PAD), window.innerWidth - BIN_PAD),
  y: Math.min(Math.max(home.top + home.height / 2, BIN_PAD), window.innerHeight - BIN_PAD),
});
/** Bin that appears while one of our own items is dragged; dropping on it deletes. */
export function TrashZone({ active, home, count, onDelete }: { active: boolean; home: DOMRect | null; count: number; onDelete: () => void }) {
  const [hot, setHot] = useState(false);
  const [gulp, setGulp] = useState<{ x: number; y: number; n: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [shown, setShown] = useState(false);
  const hotRef = useRef(false);
  const posRef = useRef<{ x: number; y: number } | null>(null);
  const cb = useRef(onDelete);
  cb.current = onDelete;
  const nRef = useRef(count);
  nRef.current = count;
  // freeze the spot when the drag starts; never follow the pointer
  useLayoutEffect(() => {
    if (!active || !home) return void ((posRef.current = null), setPos(null), setShown(false));
    const p = binSpot(home);
    posRef.current = p;
    setPos(p);
    setShown(false);
    const r = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(r);
  }, [active, home]);
  useEffect(() => {
    if (!active) return void ((hotRef.current = false), setHot(false));
    const near = (x: number, y: number) => {
      const p = posRef.current;
      return !!p && Math.hypot(x - p.x, y - p.y) <= BIN_R * 1.15;
    };
    const over = (e: DragEvent) => {
      if (e.clientX === 0 && e.clientY === 0) return; // Firefox "drag" events carry no coordinates
      const h = near(e.clientX, e.clientY);
      if (h !== hotRef.current) ((hotRef.current = h), setHot(h));
      if (h && e.type === "dragover") (e.preventDefault(), e.dataTransfer && (e.dataTransfer.dropEffect = "move"));
    };
    const drop = (e: DragEvent) => {
      if (!near(e.clientX, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      hotRef.current = false;
      setHot(false);
      const p = posRef.current!;
      setGulp({ ...p, n: nRef.current });
      setTimeout(() => setGulp(null), 800);
      cb.current();
    };
    window.addEventListener("dragover", over, true);
    window.addEventListener("drag", over, true); // source-side events keep the hot state live between dragovers
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drag", over, true);
      window.removeEventListener("drop", drop, true);
    };
  }, [active]);
  const at = gulp ?? (active ? pos : null);
  if (!at) return null;
  const isHot = hot || !!gulp;
  return createPortal(
    <div data-testid="trash-zone" data-hot={isHot || undefined} data-x={Math.round(at.x)} data-y={Math.round(at.y)} className={cx("dbin", (shown || gulp) && "show", isHot && "hot")} style={{ transform: `translate(${at.x}px, ${at.y}px)` }} aria-hidden>
      <div className="disc">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <g className="lid"><path d="M4 7h16" /><path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" /><path d="M12 4.6v-.4" /></g>
          <path d="M6 7l.8 12.2A1.8 1.8 0 0 0 8.6 21h6.8a1.8 1.8 0 0 0 1.8-1.8L18 7" /><path d="M10 11v6M14 11v6" />
        </svg>
      </div>
      <div className="blabel">{gulp ? `已删除 ${gulp.n} 项` : hot ? (count > 1 ? `松手删除 ${count} 项` : "松手删除") : "拖到这里删除"}</div>
    </div>,
    document.body,
  );
}

export { Trash2 };
