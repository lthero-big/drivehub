// DEPTAI-485 round 6 components.
//   TagRow    — tags on one line, overflow collapses into a "+N" chip with a hover / click popover (#9)
//   Skeleton* — shape-matched loading placeholders replacing spinners (#6)
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/util";
import { usePopoverPos } from "./ui";

export type TagLike = { id: number; name: string; color: string };

const chip = (t: TagLike) => <span key={t.id} className="ftag" data-tag-chip><i className={`tc-${t.color}`} />{t.name}</span>;

/** Single-line tag list. Measures the chips and shows as many as fit the available width; the rest
 *  collapse into "+N" (hover or click shows all). The row height never changes, whatever the tag count. */
export function TagRow({ tags, className }: { tags: TagLike[]; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const meas = useRef<HTMLSpanElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(tags.length);
  const [open, setOpen] = useState(false);
  const hover = useRef<number | undefined>(undefined);
  const key = tags.map((t) => t.id + t.name).join("|");
  useLayoutEffect(() => {
    const el = box.current, m = meas.current;
    if (!el || !m) return;
    const calc = () => {
      const W = el.clientWidth;
      const ws = [...m.children].map((c) => (c as HTMLElement).offsetWidth);
      const plusW = 30, gap = 4;
      let used = 0, k = 0;
      for (; k < ws.length; k++) {
        const need = used + (k ? gap : 0) + ws[k] + (k < ws.length - 1 ? gap + plusW : 0);
        if (need > W) break;
        used += (k ? gap : 0) + ws[k];
      }
      setFit(k);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [key]);
  // stable anchor object — a fresh one each render would re-run the positioning effect forever
  const anchor = useMemo(() => (open && plusRef.current ? { el: plusRef.current } : null), [open]);
  const pos = usePopoverPos(open, anchor, pop, { align: "right" });
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => !plusRef.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", f);
    return () => document.removeEventListener("mousedown", f);
  }, [open]);
  if (!tags.length) return null;
  const rest = tags.length - fit;
  const enter = () => (clearTimeout(hover.current), (hover.current = window.setTimeout(() => setOpen(true), 250)));
  const leave = () => (clearTimeout(hover.current), (hover.current = window.setTimeout(() => setOpen(false), 200)));
  return (
    <span ref={box} className={cx("relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden whitespace-nowrap", className)} data-file-tags data-tags-total={tags.length} data-tags-shown={fit}>
      <span ref={meas} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex gap-1">{tags.map(chip)}</span>
      {tags.slice(0, fit).map(chip)}
      {rest > 0 && (
        <button ref={plusRef} type="button" className="ftag ftag-more shrink-0" data-tags-more={rest} aria-label={`还有 ${rest} 个标签`} aria-expanded={open}
          onClick={(e) => (e.stopPropagation(), setOpen((o) => !o))} onDoubleClick={(e) => e.stopPropagation()} onMouseEnter={enter} onMouseLeave={leave}>
          +{rest}
        </button>
      )}
      {open && createPortal(
        <div ref={pop} role="tooltip" style={pos} onMouseEnter={() => clearTimeout(hover.current)} onMouseLeave={leave} className="pop-in pop-surface z-[80] flex max-w-72 flex-wrap gap-1 rounded-xl p-2" data-tags-popover>
          <p className="mb-0.5 w-full text-[11px] text-faint">全部 {tags.length} 个标签</p>
          {tags.map(chip)}
        </div>,
        document.body,
      )}
    </span>
  );
}

/* ───────────────────────────── skeletons (#6) ───────────────────────────── */

/** Base block: shimmering rounded rectangle. */
export function Sk({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <span aria-hidden className={cx("sk block", className)} style={style} />;
}

/** Wrapper with aria-busy + label so screen readers announce loading. */
export function SkWrap({ label = "加载中", children, className }: { label?: string; children: ReactNode; className?: string }) {
  return <div role="status" aria-busy="true" aria-label={label} data-skeleton className={cx("sk-wrap", className)}>{children}</div>;
}

/** File list rows: checkbox · icon · name (+meta) · size · time. */
export function SkFileRows({ rows = 8 }: { rows?: number }) {
  return (
    <SkWrap label="正在加载文件" className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid grid-cols-[2.5rem_1fr] items-center gap-2 px-2 py-2.5 sm:grid-cols-[2.5rem_1fr_6rem_9rem_2.5rem]">
          <Sk className="mx-auto size-4 rounded" />
          <span className="flex items-center gap-2.5"><Sk className="size-6 rounded-md" /><Sk className="h-3.5 rounded" style={{ width: `${30 + ((i * 37) % 45)}%` }} /></span>
          <Sk className="ml-auto hidden h-3 w-12 rounded sm:block" />
          <Sk className="hidden h-3 w-24 rounded sm:block" />
          <span />
        </div>
      ))}
    </SkWrap>
  );
}

/** File grid cards: thumbnail + two text lines. */
export function SkFileGrid({ n = 12 }: { n?: number }) {
  return (
    <SkWrap label="正在加载文件" className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-line bg-panel">
          <Sk className="aspect-[4/3] w-full rounded-none" />
          <div className="space-y-1.5 px-2 py-2"><Sk className="h-3 w-4/5 rounded" /><Sk className="h-2.5 w-1/3 rounded" /></div>
        </div>
      ))}
    </SkWrap>
  );
}

/** Generic data table: header + rows of cells with given relative widths. */
export function SkTable({ cols = [3, 2, 2, 2, 1], rows = 6, label }: { cols?: number[]; rows?: number; label?: string }) {
  const tpl = cols.map((c) => `${c}fr`).join(" ");
  return (
    <SkWrap label={label} className="overflow-hidden rounded-xl border border-line bg-panel">
      <div className="grid gap-3 border-b border-line bg-panel-2 px-3 py-2.5" style={{ gridTemplateColumns: tpl }}>{cols.map((_, i) => <Sk key={i} className="h-2.5 w-1/2 rounded" />)}</div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="grid gap-3 border-b border-line px-3 py-3 last:border-0" style={{ gridTemplateColumns: tpl }}>
          {cols.map((_, i) => <Sk key={i} className="h-3 rounded" style={{ width: `${45 + ((r * 13 + i * 29) % 50)}%` }} />)}
        </div>
      ))}
    </SkWrap>
  );
}

/** Row of stat cards. */
export function SkStats({ n = 4 }: { n?: number }) {
  return (
    <SkWrap className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" label="正在加载统计">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="rounded-2xl border border-line bg-panel p-4"><span className="flex items-center gap-2"><Sk className="size-8 rounded-xl" /><Sk className="h-3 w-12 rounded" /></span><Sk className="mt-3 h-7 w-16 rounded-lg" /></div>
      ))}
    </SkWrap>
  );
}

/** Card grid (roles, mounts, groups…). */
export function SkCards({ n = 6, className }: { n?: number; className?: string }) {
  return (
    <SkWrap className={cx("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", className)}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="space-y-3 rounded-2xl border border-line bg-panel p-4">
          <span className="flex items-center gap-2"><Sk className="size-9 rounded-xl" /><span className="flex-1 space-y-1.5"><Sk className="h-3.5 w-1/3 rounded" /><Sk className="h-2.5 w-2/3 rounded" /></span></span>
          <Sk className="h-2.5 w-full rounded" /><Sk className="h-2.5 w-4/5 rounded" />
        </div>
      ))}
    </SkWrap>
  );
}

/** Text lines (previews / readme / code). */
export function SkLines({ n = 8, className }: { n?: number; className?: string }) {
  return <SkWrap className={cx("space-y-2.5 p-4", className)}>{Array.from({ length: n }, (_, i) => <Sk key={i} className="h-3 rounded" style={{ width: `${55 + ((i * 41) % 45)}%` }} />)}</SkWrap>;
}

/** Chart area with bars. */
export function SkChart({ h = 112 }: { h?: number }) {
  return <SkWrap label="正在加载图表" className="flex items-end gap-1" >{Array.from({ length: 24 }, (_, i) => <Sk key={i} className="flex-1 rounded-t" style={{ height: h * (0.25 + ((i * 47) % 70) / 100) }} />)}</SkWrap>;
}

/** Media viewer placeholder (image / video / pdf). */
export function SkMedia({ className }: { className?: string }) {
  return <SkWrap label="正在加载预览" className={cx("grid h-full min-h-48 place-items-center", className)}><Sk className="aspect-video w-[min(90%,48rem)] rounded-xl" /></SkWrap>;
}

/** Page header placeholder (title + desc + actions), same rhythm as PageHeader. */
export function SkHeader({ actions = 2 }: { actions?: number }) {
  return (
    <div className="flex items-end gap-3 pb-2">
      <div className="flex-1 space-y-2"><Sk className="h-6 w-40 rounded-lg" /><Sk className="h-3 w-64 max-w-full rounded" /></div>
      {Array.from({ length: actions }, (_, i) => <Sk key={i} className="hidden h-8 w-20 rounded-lg sm:block" />)}
    </div>
  );
}

export type SkKind = "files" | "table" | "stats" | "cards" | "form" | "dashboard" | "acl" | "account";

/** Whole-page skeleton whose shape follows the page's real components. */
export function PageSkeleton({ kind }: { kind: SkKind }) {
  const body = {
    files: <><div className="flex gap-2 py-3"><Sk className="h-8 w-64 rounded-lg" /><span className="flex-1" /><Sk className="h-8 w-24 rounded-lg" /><Sk className="h-8 w-8 rounded-lg" /></div><SkFileRows rows={10} /></>,
    table: <><SkHeader /><SkTable rows={8} /></>,
    stats: <><SkHeader /><Sk className="h-28 w-full rounded-2xl" /><SkStats n={6} /><div className="rounded-2xl border border-line bg-panel p-5"><SkChart /></div><SkTable cols={[2, 2, 3, 4, 2, 2]} rows={6} /></>,
    cards: <><SkHeader /><SkCards /></>,
    form: <><SkHeader actions={0} /><div className="space-y-4 rounded-2xl border border-line bg-panel p-5">{Array.from({ length: 4 }, (_, i) => <div key={i} className="space-y-1.5"><Sk className="h-3 w-24 rounded" /><Sk className="h-10 w-full rounded-xl" /></div>)}</div></>,
    dashboard: <><SkHeader actions={0} /><SkStats n={4} /><div className="grid gap-4 lg:grid-cols-2"><div className="rounded-2xl border border-line bg-panel p-5"><SkChart /></div><SkTable cols={[3, 2, 2]} rows={5} /></div></>,
    acl: <><SkHeader /><div className="flex gap-2"><Sk className="h-9 w-24 rounded-xl" /><Sk className="h-9 w-24 rounded-xl" /><Sk className="h-9 w-24 rounded-xl" /></div><div className="grid gap-4 lg:grid-cols-[18rem_1fr]"><div className="space-y-2 rounded-2xl border border-line bg-panel p-3">{Array.from({ length: 8 }, (_, i) => <Sk key={i} className="h-7 rounded-lg" style={{ marginLeft: (i % 3) * 14 }} />)}</div><SkTable cols={[3, 4, 2]} rows={5} /></div></>,
    account: <><SkHeader actions={0} /><div className="flex gap-2">{Array.from({ length: 4 }, (_, i) => <Sk key={i} className="h-9 w-20 rounded-xl" />)}</div><SkCards n={2} className="xl:grid-cols-2" /></>,
  }[kind];
  return <div className="mx-auto max-w-6xl space-y-4 py-4" data-page-skeleton={kind}>{body}</div>;
}

/** Skeleton for a hash route (lazy page chunks / first data load). */
export function routeSkeleton(name: string, rest = ""): SkKind {
  if (name === "files") return "files";
  if (name === "stats") return "stats";
  if (name === "account") return "account";
  if (name === "admin") {
    const sub = rest.split("/")[0];
    if (sub === "dashboard" || sub === "") return "dashboard";
    if (sub === "roles" || sub === "mounts" || sub === "groups") return "cards";
    if (sub === "settings") return "form";
    if (sub === "acl") return "acl";
  }
  return "table";
}

/** Boot skeleton: sidebar + top bar + file list, shown before the session is known. */
export function AppSkeleton() {
  return (
    <div className="flex h-full bg-panel" data-app-skeleton>
      <SkWrap label="正在加载 DriveHub" className="hidden w-64 shrink-0 space-y-2 border-r border-line p-3 lg:block">
        <span className="flex items-center gap-2 pb-3"><Sk className="size-9 rounded-xl" /><Sk className="h-4 w-24 rounded" /></span>
        {Array.from({ length: 7 }, (_, i) => <Sk key={i} className="h-8 rounded-xl" style={{ width: `${70 + ((i * 17) % 25)}%` }} />)}
      </SkWrap>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-14 items-center gap-2 border-b border-line px-4"><Sk className="h-4 w-32 rounded" /><span className="flex-1" /><Sk className="size-9 rounded-xl" /><Sk className="h-9 w-24 rounded-xl" /></div>
        <div className="px-4 sm:px-8"><PageSkeleton kind="files" /></div>
      </div>
    </div>
  );
}

/** Preview placeholders per viewer: code (gutter + lines), doc (heading + paragraphs), page (A4 sheet), list (archive rows). */
export function SkPreview({ kind }: { kind: "code" | "doc" | "page" | "list" }) {
  if (kind === "list") return <SkTable cols={[5, 1, 2]} rows={8} label="正在读取压缩包" />;
  if (kind === "page")
    return (
      <SkWrap label="正在渲染文档" className="flex justify-center bg-panel-2 p-6">
        <div className="w-full max-w-2xl space-y-3 rounded-lg bg-panel p-10 shadow-card"><Sk className="h-5 w-1/2 rounded" />{Array.from({ length: 10 }, (_, i) => <Sk key={i} className="h-3 rounded" style={{ width: `${60 + ((i * 31) % 40)}%` }} />)}</div>
      </SkWrap>
    );
  if (kind === "code")
    return (
      <SkWrap label="正在加载代码" className="grid grid-cols-[2.5rem_1fr] gap-x-3 gap-y-2 p-4 font-mono">
        {Array.from({ length: 14 }, (_, i) => [<Sk key={`n${i}`} className="h-3 w-5 justify-self-end rounded opacity-60" />, <Sk key={`l${i}`} className="h-3 rounded" style={{ width: `${15 + ((i * 53) % 70)}%`, marginLeft: (i % 4) * 16 }} />])}
      </SkWrap>
    );
  return (
    <SkWrap label="正在加载文档" className="space-y-3 p-6">
      <Sk className="h-6 w-1/3 rounded-lg" />
      {Array.from({ length: 3 }, (_, p) => <div key={p} className="space-y-2 pt-2">{Array.from({ length: 3 }, (_, i) => <Sk key={i} className="h-3 rounded" style={{ width: `${70 + ((p * 7 + i * 13) % 30)}%` }} />)}</div>)}
    </SkWrap>
  );
}
