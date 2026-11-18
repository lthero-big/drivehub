// DEPTAI-485 r3 motion kit (B). References: design.lthero.com/prompt/<slug> — see motion.css.
import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Link2, Send, Share2 } from "lucide-react";
import { cx } from "../lib/util";
import { Button } from "./ui";
import { reducedMotion, type Phase } from "./morph";
export { reducedMotion, useReducedMotion } from "./morph";

/* ───────── 1. LoadingButton / multistate (mp-loading-button + 21st-multistate-button) ───────── */
type LBProps = Omit<React.ComponentProps<typeof Button>, "onClick" | "loading" | "phase"> & { onClick?: (e: React.MouseEvent<HTMLButtonElement>) => unknown | Promise<unknown> };
/** idle → (pill shrinks to circle + arc) → green ✓ 完成 → idle. Failure → red ✕ + shake. */
export function LoadingButton({ onClick, ...rest }: LBProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const click = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (phase !== "idle") return;
    setPhase("run");
    const t0 = Date.now();
    let ok = true;
    try {
      await onClick?.(e);
    } catch {
      ok = false;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 450 - (Date.now() - t0))));
    setPhase(ok ? "done" : "error");
    timer.current = setTimeout(() => setPhase("idle"), ok ? 1100 : 1400);
  };
  return <Button {...rest} phase={phase} onClick={click} />;
}

/* ───────── 2. SegmentedDrag (affectui-segmented-drag) ───────── */
export type SegOption<T extends string> = { value: T; label?: ReactNode; icon?: ReactNode; title?: string };
export function SegmentedDrag<T extends string>({ options, value, onChange, label, size = "md", iconOnly, className, role = "radiogroup" }: { options: SegOption<T>[]; value: T; onChange: (v: T) => void; label: string; size?: "sm" | "md"; iconOnly?: boolean; className?: string; role?: "radiogroup" | "tablist" }) {
  const root = useRef<HTMLDivElement>(null);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const [box, setBox] = useState<{ l: number; r: number } | null>(null);
  const prev = useRef(-1);
  const [dur, setDur] = useState({ l: 0.4, r: 0.27 });
  const [press, setPress] = useState(false);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const measure = useCallback(() => {
    const b = btns.current[idx], r = root.current;
    if (!b || !r) return;
    setBox({ l: b.offsetLeft, r: r.clientWidth - b.offsetLeft - b.offsetWidth });
  }, [idx]);
  useLayoutEffect(() => {
    if (prev.current >= 0 && prev.current !== idx) {
      const right = idx > prev.current; // leading edge fast (270ms), trailing slow (400ms)
      setDur(right ? { l: 0.4, r: 0.27 } : { l: 0.27, r: 0.4 });
    }
    prev.current = idx;
    measure();
  }, [idx, measure, options.length]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    return () => ro.disconnect();
  }, [measure]);
  const drag = useRef<{ x: number; touch: boolean; on: boolean; moved: boolean; start: number } | null>(null);
  const hit = (x: number) => btns.current.findIndex((b) => b && x >= b.getBoundingClientRect().left && x <= b.getBoundingClientRect().right);
  const choose = (i: number) => i >= 0 && options[i].value !== value && onChange(options[i].value);
  const down = (e: React.PointerEvent) => {
    const touch = e.pointerType !== "mouse";
    const i = hit(e.clientX);
    drag.current = { x: e.clientX, touch, on: !touch || i === idx, moved: false, start: i };
    setPress(true);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x) >= (d.touch ? 8 : 3)) d.moved = true;
    if (d.moved && d.on) choose(hit(e.clientX));
  };
  const up = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setPress(false);
    if (d && !d.moved) choose(hit(e.clientX));
  };
  const key = (e: React.KeyboardEvent) => {
    const n = options.length;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (idx + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (idx + n - 1) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    choose(to);
    btns.current[to]?.focus();
  };
  const tab = role === "tablist";
  return (
    <div ref={root} role={role} aria-label={label} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => (drag.current = null, setPress(false))} onKeyDown={key}
      className={cx("seg", size === "sm" && "seg-sm", iconOnly && "seg-icon", className)} data-press={press ? 1 : 0}>
      {box && <span aria-hidden className="seg-pill" style={{ left: box.l, right: box.r, ["--seg-l" as string]: reducedMotion() ? "0s" : `${dur.l}s`, ["--seg-r" as string]: reducedMotion() ? "0s" : `${dur.r}s` }} />}
      {options.map((o, i) => (
        <button key={o.value} ref={(el) => void (btns.current[i] = el)} type="button" role={tab ? "tab" : "radio"} aria-checked={tab ? undefined : o.value === value} aria-selected={tab ? o.value === value : undefined} aria-label={o.title ?? (typeof o.label === "string" ? o.label : o.value)} title={o.title} tabIndex={o.value === value ? 0 : -1} className="seg-opt">
          {o.icon}
          {o.label != null && (
            <span className="relative inline-grid place-items-center">
              <span className="w5 [grid-area:1/1]">{o.label}</span>
              <span className="w6 [grid-area:1/1]" aria-hidden>{o.label}</span>
              <span className="invisible font-semibold [grid-area:1/1]" aria-hidden>{o.label}</span>
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ───────── 3. SendButton (ig-send-button) ───────── */
const PCOL = ["#ff5a2c", "#3b82f6", "#f5b700", "#a855f7"];
export function SendButton({ onSend, label = "发送", sentLabel = "已发送", className, disabled, icon }: { onSend: () => unknown | Promise<unknown>; label?: string; sentLabel?: string; className?: string; disabled?: boolean; icon?: ReactNode }) {
  const [st, setSt] = useState<"idle" | "sending" | "sent">("idle");
  const click = async () => {
    if (st !== "idle") return;
    setSt("sending");
    const t0 = Date.now();
    try {
      await onSend();
    } catch {
      setSt("idle");
      return;
    }
    await new Promise((r) => setTimeout(r, Math.max(0, 700 - (Date.now() - t0))));
    setSt("sent");
    setTimeout(() => setSt("idle"), 1600);
  };
  const parts = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2, r = 52 + (i % 3) * 15;
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, c: PCOL[i % 4] };
  });
  return (
    <button type="button" disabled={disabled} onClick={click} data-state={st} aria-live="polite" aria-label={st === "sent" ? sentLabel : label} className={cx("sb btn-key", className)}>
      <span className="sb-in"><span className="sb-plane">{icon ?? <Send className="size-4" />}</span>{label}</span>
      <svg className="sb-ring" viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="9" fill="none" stroke="rgba(255,255,255,.3)" strokeWidth="3" /><circle cx="12" cy="12" r="9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeDasharray="26 60" /></svg>
      <svg className="sb-ok" viewBox="0 0 24 24" aria-hidden><path d="M6 12.5 L10.5 17 L18 8" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
      {st === "sent" && !reducedMotion() && parts.map((p, i) => <i key={i} className="sb-p" style={{ background: p.c, ["--dx" as string]: `${p.dx}px`, ["--dy" as string]: `${p.dy}px` }} />)}
    </button>
  );
}

/* ───────── 4. ShareButton (social-share-button): capsule springs open into an icon row ───────── */
export function ShareButton({ url, label = "分享", actions }: { url: string; label?: string; actions?: { icon: ReactNode; label: string; onClick: () => void }[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(260);
  useLayoutEffect(() => void (row.current && setW(row.current.scrollWidth + 14)), [actions?.length]);
  useEffect(() => {
    if (!open) return;
    const f = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", f);
    document.addEventListener("keydown", k);
    return () => (document.removeEventListener("pointerdown", f), document.removeEventListener("keydown", k));
  }, [open]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* clipboard may be blocked on http */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div ref={root} className="shr" data-open={open ? 1 : 0} style={{ ["--shr-w" as string]: `${w}px` }}>
      <button type="button" className="shr-label" aria-expanded={open} onClick={() => setOpen(true)} tabIndex={open ? -1 : 0}><Share2 className="size-4" />{label}</button>
      <div ref={row} className="shr-row">
        {actions?.map((a) => <button key={a.label} type="button" title={a.label} aria-label={a.label} onClick={a.onClick} tabIndex={open ? 0 : -1}>{a.icon}</button>)}
        {actions?.length ? <i /> : null}
        <button type="button" onClick={copy} aria-label="复制链接" tabIndex={open ? 0 : -1} className={copied ? "!text-ok" : ""}>
          {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}<span>{copied ? "已复制" : "复制链接"}</span>
        </button>
      </div>
    </div>
  );
}
export { Copy };

/* ───────── 5. FoldToolbar (ui-recent-fold-toolbar): a parent tool unfolds its sub-tools in place ───────── */
export type FoldTool = { id: string; label: string; icon: ReactNode; children?: FoldTool[]; onSelect?: () => void };
export function FoldToolbar({ tools, label = "工具栏", activeId }: { tools: FoldTool[]; label?: string; activeId?: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [swap, setSwap] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openId) return;
    const f = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpenId(null);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpenId(null);
    document.addEventListener("pointerdown", f);
    document.addEventListener("keydown", k);
    return () => (document.removeEventListener("pointerdown", f), document.removeEventListener("keydown", k));
  }, [openId]);
  const pick = (parent: FoldTool, child: FoldTool) => {
    setSwap(parent.id);
    setOpenId(null);
    setTimeout(() => (setChosen((c) => ({ ...c, [parent.id]: child.id })), setSwap(null)), reducedMotion() ? 0 : 140);
    child.onSelect?.();
  };
  return (
    <div ref={root} className="ft" role="toolbar" aria-label={label}>
      {tools.map((t) => {
        const cur = t.children?.find((c) => c.id === chosen[t.id]) ?? t.children?.[0];
        const shown = cur ?? t;
        const act = activeId === t.id || (!!chosen[t.id] && activeId === chosen[t.id]);
        return (
          <div key={t.id} className="inline-flex items-center gap-0.5">
            <button type="button" className="ft-btn ft-par" data-parent={t.children ? 1 : 0} data-active={act ? 1 : 0} data-hide={openId === t.id ? 1 : 0} aria-label={t.label} title={t.label} aria-expanded={t.children ? openId === t.id : undefined}
              onClick={() => (t.children ? setOpenId(t.id) : t.onSelect?.())}>
              <span className="ft-ic" data-swap={swap === t.id ? 1 : 0}>{shown.icon}</span>
            </button>
            {t.children && (
              <div className="ft-sub" data-open={openId === t.id ? 1 : 0} role="group" aria-label={`${t.label}子工具`}>
                <button type="button" className="ft-btn" style={{ ["--i" as string]: 0 }} aria-label="收起" tabIndex={openId === t.id ? 0 : -1} onClick={() => setOpenId(null)}>×</button>
                {t.children.map((c, i) => (
                  <button key={c.id} type="button" className="ft-btn" style={{ ["--i" as string]: i + 1 }} aria-label={c.label} title={c.label} tabIndex={openId === t.id ? 0 : -1} onClick={() => pick(t, c)}>{c.icon}</button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ───────── 6. Genie minimize into a dock (motion-recent-genie-minimize) ───────── */
/** Warps `el` toward `to` as a funnel: bottom rows leave first, the window pinches to the dock icon.
 *  Implemented with a clip-path trapezoid + transform (no strip raster), 640ms / 720ms reverse. */
export function genie(el: HTMLElement, to: DOMRect, dir: "min" | "max"): Promise<void> {
  if (reducedMotion()) return Promise.resolve();
  const r = el.getBoundingClientRect();
  const dx = to.left + to.width / 2 - (r.left + r.width / 2);
  const dy = to.top + to.height / 2 - (r.top + r.height / 2);
  const sx = Math.max(0.04, to.width / r.width);
  const funnel = (t: number) => {
    // t: 0 = full window, 1 = pinched cup. Top edge narrows first-late, bottom edge leads.
    const inset = 50 * t;
    const bottomInset = 50 * Math.min(1, t * 1.25);
    return `polygon(${inset * 0.3}% 0%, ${100 - inset * 0.3}% 0%, ${100 - bottomInset}% 100%, ${bottomInset}% 100%)`;
  };
  const tf = (t: number) => `translate(${dx * t}px, ${dy * t}px) scale(${1 - (1 - sx) * t}, ${1 - 0.9 * t})`;
  const steps = [0, 0.25, 0.5, 0.75, 1];
  const frames = steps.map((t) => ({ clipPath: funnel(t ** 1.4), transform: tf(t ** 1.8), opacity: t > 0.9 ? 1 - (t - 0.9) * 6 : 1, offset: t }));
  const a = el.animate(dir === "min" ? frames : [...frames].reverse().map((f, i) => ({ ...f, offset: steps[i] })), { duration: dir === "min" ? 640 : 720, easing: "cubic-bezier(.5,0,.75,.4)", fill: "both" });
  if (dir === "max") a.effect?.updateTiming({ easing: "cubic-bezier(.25,.6,.5,1)" });
  return a.finished.then(() => (dir === "max" ? a.cancel() : undefined)).catch(() => undefined);
}

export type DockEntry = { id: string; name: string; icon?: ReactNode };
export function GenieDock({ items, onRestore, popId }: { items: DockEntry[]; onRestore: (id: string, rect: DOMRect) => void; popId?: string | null }) {
  if (!items.length) return null;
  return (
    <div className="gdock" role="toolbar" aria-label="已最小化的窗口">
      {items.map((it) => (
        <button key={it.id} type="button" data-dock-id={it.id} data-name={it.name} data-pop={popId === it.id ? 1 : 0} aria-label={`恢复 ${it.name}`} className="gdock-i" onClick={(e) => onRestore(it.id, e.currentTarget.getBoundingClientRect())}>
          {it.icon}
        </button>
      ))}
    </div>
  );
}
export const dockRect = (id: string) => document.querySelector<HTMLElement>(`[data-dock-id="${CSS.escape(id)}"]`)?.getBoundingClientRect() ?? new DOMRect(window.innerWidth / 2 - 26, window.innerHeight - 66, 52, 52);
void Children; void isValidElement;
