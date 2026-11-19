import { Children, forwardRef, isValidElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { cx } from "../lib/util";
import { SegmentedDrag } from "./motion";
import { LbDone, LbSpin, useMorph, type Phase } from "./morph";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "outline" | "danger";
  size?: "sm" | "md";
  /** async state: pill shrinks to a circle with an arc (unified loading button) */
  loading?: boolean;
  /** driven phase (LoadingButton): idle | run | done | error */
  phase?: Phase;
  doneLabel?: string;
  errorLabel?: string;
  /** hover floods the button with a dot + inverted label (multistate button) */
  hoverFill?: boolean;
};
/** Key-like button: raised surface, lift on hover, press-down on :active, ring on focus.
 *  Buttons that pass `loading` / `phase` use the shared morph: shrink → arc → ✓ (motion-mp-loading-button). */
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "outline", size = "md", loading, phase, doneLabel = "完成", errorLabel = "失败", hoverFill, className, children, disabled, ...rest }, ref) {
  const inner = useRef<HTMLButtonElement | null>(null);
  const ph: Phase = phase ?? (loading ? "run" : "idle");
  useMorph(inner, ph);
  const morph = loading !== undefined || phase !== undefined || hoverFill;
  return (
    <button
      ref={(el) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      disabled={disabled || loading || (phase !== undefined && phase !== "idle")}
      data-state={morph ? ph : undefined}
      aria-busy={ph === "run" || undefined}
      className={cx(
        "btn-key inline-flex items-center justify-center gap-1.5 rounded-xl font-medium whitespace-nowrap select-none disabled:opacity-50 disabled:pointer-events-none",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        variant === "primary" && "btn-primary bg-accent text-accent-fg",
        variant === "outline" && "btn-outline border border-line bg-panel hover:bg-panel-2",
        variant === "ghost" && "btn-ghost hover:bg-hover",
        variant === "danger" && "btn-danger bg-danger text-white",
        morph && "lb",
        hoverFill && "ms",
        className,
      )}
      {...rest}
    >
      {morph ? (
        <>
          <span className={cx("lb-label", hoverFill && "ms-a")}>{children}</span>
          {hoverFill && <span className="ms-b" aria-hidden>{children}</span>}
          <LbSpin />
          <LbDone label={ph === "error" ? errorLabel : doneLabel} error={ph === "error"} />
        </>
      ) : (
        children
      )}
    </button>
  );
});

/** Control sizes (DEPTAI-485 r6 #2) — one scale for every input-like control:
 *  - "md" (h-10, 14px): form fields stacked under a <Field> label (dialogs, settings forms)
 *  - "sm" (h-8, 13px): controls placed *beside* text — page-header actions, filter bars, card headers, toolbars
 *  - "xs" (h-7, 12px): dense chrome such as the code-viewer header
 *  Labels next to an sm control use 13px text so label and control share one baseline. */
export type CtlSize = "xs" | "sm" | "md";
export const CTL_H: Record<CtlSize, string> = { xs: "h-7 rounded-lg px-2 text-xs", sm: "h-8 rounded-lg px-2.5 text-[13px]", md: "h-10 rounded-xl px-3 text-sm" };

export function IconButton({ label, className, children, size = "md", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: CtlSize }) {
  return (
    <button aria-label={label} title={label} className={cx("btn-key btn-icon inline-flex shrink-0", size === "md" ? "size-9" : size === "sm" ? "size-8 [&>svg]:size-4" : "size-7 [&>svg]:size-3.5", "items-center justify-center rounded-xl text-muted hover:bg-hover hover:text-fg disabled:opacity-40", className)} {...rest}>
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { ctl?: CtlSize }>(function Input({ className, ctl = "md", ...rest }, ref) {
  return <input ref={ref} className={cx("field-input w-full border border-line bg-panel outline-none", CTL_H[ctl], " placeholder:text-faint hover:border-faint/60 focus:border-accent", className)} {...rest} />;
});

type SelectProps = { value: string | undefined; required?: boolean; onChange: (e: { target: { value: string } }) => void; children: ReactNode; className?: string; "aria-label"?: string; disabled?: boolean; size?: CtlSize };
/** Custom listbox. Keeps the native-select call shape: <Select value onChange={(e)=>e.target.value}><option value>…</option></Select>. */
export function Select({ value, onChange, children, className, disabled, size = "md", ...rest }: SelectProps) {
  const opts = useMemo(() => {
    const out: { value: string; label: ReactNode }[] = [];
    Children.forEach(children, (c) => {
      if (isValidElement(c) && c.type === "option") {
        const p = (c as ReactElement<{ value?: string; children?: ReactNode }>).props;
        out.push({ value: p.value ?? String(p.children), label: p.children });
      }
    });
    return out;
  }, [children]);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const cur = opts.find((o) => o.value === (value ?? ""));
  const anchor = useMemo(() => (open && box.current ? { el: box.current } : null), [open]);
  const pos = usePopoverPos(open, anchor, list, { matchWidth: true });
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", f);
    return () => document.removeEventListener("mousedown", f);
  }, [open]);
  const pick = (v: string) => {
    onChange({ target: { value: v } });
    setOpen(false);
    box.current?.querySelector("button")?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") return setOpen(false);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setHi(Math.max(0, opts.findIndex((o) => o.value === value)));
        return setOpen(true);
      }
      setHi((h) => (h + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length);
    } else if ((e.key === "Enter" || e.key === " ") && open) {
      e.preventDefault();
      pick(opts[hi].value);
    }
  };
  return (
    <div ref={box} className={cx("relative inline-block", className)} onKeyDown={onKey}>
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        aria-label={rest["aria-label"]}
        disabled={disabled}
        onClick={() => (setHi(Math.max(0, opts.findIndex((o) => o.value === value))), setOpen((o) => !o))}
        data-size={size}
        className={cx("btn-key field-input flex w-full items-center justify-between gap-2 border border-line bg-panel text-left hover:border-faint/60 disabled:opacity-50", CTL_H[size], size === "md" ? "min-w-28" : "min-w-20")}
      >
        <span className="truncate">{cur?.label ?? "请选择"}</span>
        <ChevronDown className={cx(size === "md" ? "size-4" : "size-3.5", "shrink-0 text-faint transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open &&
        createPortal(
          <ul ref={list} id={id} role="listbox" style={pos} className="pop-in pop-surface scroll-thin relative z-[75] max-h-64 overflow-auto rounded-xl p-1">
            <span aria-hidden className="pop-hi" style={{ transform: `translateY(${hi * 40}px)` }} />
            {opts.map((o, i) => (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => (e.preventDefault(), pick(o.value))}
                className={cx("flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap", "relative", o.value === value && "font-medium text-accent")}
              >
                <span className="flex-1">{o.label}</span>
                {o.value === value && <Check className="size-4" />}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}

/** Custom checkbox: hidden native input for a11y, big (>=40px) hit area, animated tick. */
export function Checkbox({ checked, onChange, children, label, className, indeterminate, stopClick }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; label?: string; className?: string; indeterminate?: boolean; stopClick?: boolean }) {
  return (
    <label className={cx("check group inline-flex min-h-10 min-w-10 cursor-pointer items-center justify-center gap-2 rounded-xl select-none", children ? "px-2" : "", className)} onClick={stopClick ? (e) => e.stopPropagation() : undefined}>
      <input type="checkbox" className="peer sr-only" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-box flex size-5 shrink-0 items-center justify-center rounded-md border border-faint/70 bg-panel text-accent-fg transition-all duration-200 group-hover:border-accent group-active:scale-90 peer-checked:border-accent peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-panel">
        {checked ? <Check className="size-3.5 stroke-[3]" /> : indeterminate ? <span className="h-0.5 w-2.5 rounded bg-faint" /> : null}
      </span>
      {children && <span className="text-[13.5px]">{children}</span>}
    </label>
  );
}

/** Custom radio group. */
export function RadioGroup<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <label key={o.value} className="group inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-xl px-2 select-none">
          <input type="radio" name={name} className="peer sr-only" checked={o.value === value} onChange={() => onChange(o.value)} />
          <span className="flex size-5 items-center justify-center rounded-full border border-faint/70 bg-panel transition-all duration-200 group-hover:border-accent group-active:scale-90 peer-checked:border-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/50 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-panel [&>i]:scale-0 peer-checked:[&>i]:scale-100">
            <i className="size-2.5 rounded-full bg-accent transition-transform duration-200" />
          </span>
          <span className="text-[13.5px]">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** Tabs: draggable segmented control (affectUI) — the pill stretches toward the target, drag across to switch. */
export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; icon?: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={cx("scroll-thin -mx-1 overflow-x-auto px-1 py-1", className)}>
      <SegmentedDrag<T> role="tablist" label="标签页" value={value} onChange={onChange} options={tabs.map((t) => ({ value: t.id, label: t.label, icon: t.icon }))} />
    </div>
  );
}

export function usePaged<T>(items: T[], size = 20, resetKey: unknown = "") {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / size));
  useEffect(() => setPage(1), [resetKey, size]);
  const p = Math.min(page, pages);
  return { page: p, pages, setPage, total: items.length, slice: items.slice((p - 1) * size, p * size), size };
}

export function Pager({ page, pages, setPage, total, size }: { page: number; pages: number; setPage: (n: number) => void; total: number; size: number }) {
  if (total <= size) return total > 0 ? <p className="px-1 pt-3 text-xs text-faint">共 {total} 条</p> : null;
  const from = (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  return (
    <nav aria-label="分页" className="flex flex-wrap items-center justify-between gap-2 pt-3 text-[13px] text-muted">
      <span>{from}–{to} / 共 {total} 条</span>
      <span className="flex items-center gap-1">
        <IconButton label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="size-4" /></IconButton>
        <span className="min-w-16 text-center tabular-nums">{page} / {pages}</span>
        <IconButton label="下一页" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight className="size-4" /></IconButton>
      </span>
    </nav>
  );
}

export function PageHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 pb-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{title}</h1>
        {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
      </div>
      {actions && <div className="ctl-sm flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({ icon, label, value, hint, tone = "accent" }: { icon?: ReactNode; label: string; value: ReactNode; hint?: ReactNode; tone?: "accent" | "ok" | "warn" | "danger" }) {
  return (
    <div className="card-lift rounded-2xl border border-line bg-panel p-4 shadow-card">
      <div className="flex items-center gap-2 text-[13px] text-muted">
        {icon && <span className={cx("flex size-8 items-center justify-center rounded-xl [&>svg]:size-4", tone === "accent" && "bg-accent-soft text-accent", tone === "ok" && "bg-ok/12 text-ok", tone === "warn" && "bg-warn/15 text-warn", tone === "danger" && "bg-danger/12 text-danger")}>{icon}</span>}
        {label}
      </div>
      <p className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[13px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className="group inline-flex h-10 min-w-12 shrink-0 items-center justify-center rounded-xl">
      <span className={cx("relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-300 group-focus-visible:ring-2 group-focus-visible:ring-accent/50 group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-panel", checked ? "bg-ok" : "bg-active")}>
        <span className={cx("inline-block size-6 rounded-full bg-white shadow-md transition-all duration-300 ease-[cubic-bezier(.34,1.56,.64,1)] group-active:w-7", checked ? "translate-x-[22px] group-active:translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </button>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "ok" | "danger" | "warn"; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "bg-hover text-muted",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "ok" && "bg-ok/12 text-ok",
        tone === "danger" && "bg-danger/12 text-danger",
        tone === "warn" && "bg-warn/15 text-warn",
      )}
    >
      {children}
    </span>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-2xl border border-line bg-panel shadow-card", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <div className="ctl-sm flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("size-5 animate-spin text-faint", className)} aria-label="加载中" />;
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide, dataAttr }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; dataAttr?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input:not([type=checkbox]),textarea,button[data-autofocus]")?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", f);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 p-0 backdrop-blur-sm backdrop-in sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" data-ask-dialog={dataAttr ? "" : undefined} className={cx("pop-in flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-line bg-panel shadow-pop sm:rounded-3xl", wide ? "sm:max-w-3xl" : "sm:max-w-md")}>
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="truncate text-sm font-semibold">{title}</h2>
          <IconButton label="关闭" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

// ---- toasts + prompt/confirm ----------------------------------------------

type Toast = { id: number; text: string; tone: "ok" | "danger" | "neutral" };
type UndoToast = { id: number; text: string; ms: number; onUndo: () => void; onCommit: () => void; from: DOMRect | null };
let pushToast: (t: Omit<Toast, "id">) => void = () => {};
let pushUndo: (t: Omit<UndoToast, "id" | "from">) => void = () => {};
const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Rect of the confirm dialog that was just closed — the undo toast morphs out of it (dialog → toast). */
let lastDialog: { rect: DOMRect; t: number } | null = null;
export const toast = {
  ok: (text: string) => pushToast({ text, tone: "ok" }),
  err: (text: string) => pushToast({ text, tone: "danger" }),
  info: (text: string) => pushToast({ text, tone: "neutral" }),
  /** Toast with an 「撤销」 button and a draining progress bar; onCommit runs when the window elapses (hover pauses). */
  undo: (text: string, o: { onUndo: () => void; onCommit: () => void; ms?: number }) => pushUndo({ text, ms: o.ms ?? 5000, onUndo: o.onUndo, onCommit: o.onCommit }),
};

type Ask = { title: string; label?: string; value?: string; confirm?: string; danger?: boolean; input: boolean; resolve: (v: string | null) => void };
let pushAsk: (a: Ask) => void = () => {};
export const ask = (title: string, opts: { label?: string; value?: string; confirm?: string } = {}) =>
  new Promise<string | null>((resolve) => pushAsk({ title, ...opts, input: true, resolve }));
export const confirmDlg = (title: string, opts: { label?: string; confirm?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((resolve) => pushAsk({ title, ...opts, input: false, resolve: (v) => resolve(v !== null) }));

function UndoToastView({ t, done }: { t: UndoToast; done: (undo: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const settled = useRef(false);
  const finish = (undo: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (undo) t.onUndo();
    else t.onCommit();
    const el = ref.current;
    if (el && !reduceMotion()) el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(12px) scale(.96)" }], { duration: 180, easing: "ease-in", fill: "forwards" }).onfinish = () => done(undo);
    else done(undo);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduceMotion()) return;
    const to = el.getBoundingClientRect();
    const from = t.from ?? new DOMRect(to.left, to.top + 24, to.width, to.height);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    // FLIP: start at the dialog's box, glide + shrink into the toast slot (520ms, ease-out-expo like the reference)
    el.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`, borderRadius: "24px", opacity: t.from ? 1 : 0 },
        { transform: "none", borderRadius: "16px", opacity: 1 },
      ],
      { duration: t.from ? 520 : 260, easing: "cubic-bezier(0.22,1,0.36,1)" },
    );
    el.querySelector(".toast-body")?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: t.from ? 520 : 200 });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} role="status" className="toast-undo pop-surface pointer-events-auto relative w-[340px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl">
      <div className="toast-body flex min-h-16 items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ok/12 text-ok"><Check className="size-4 stroke-[2.5]" /></span>
        <span className="min-w-0 flex-1 truncate text-sm">{t.text}</span>
        <button onClick={() => finish(true)} className="btn-key h-8 shrink-0 rounded-lg px-3 text-[13px] font-semibold text-accent hover:bg-accent-soft">撤销</button>
        <button aria-label="立即提交" onClick={() => finish(false)} className="shrink-0 rounded-md p-1 text-faint hover:bg-hover hover:text-fg"><X className="size-3.5" /></button>
      </div>
      <i className="toast-bar absolute inset-x-0 bottom-0 h-[3px] origin-left bg-accent" style={{ animationDuration: `${t.ms}ms` }} onAnimationEnd={() => finish(false)} />
    </div>
  );
}

export function Overlays() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [undos, setUndos] = useState<UndoToast[]>([]);
  const [a, setA] = useState<Ask | null>(null);
  const [v, setV] = useState("");
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setToasts((x) => [...x.slice(-3), { ...t, id }]);
      setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 3500);
    };
    pushUndo = (t) => {
      const id = ++n;
      const from = lastDialog && performance.now() - lastDialog.t < 800 ? lastDialog.rect : null;
      lastDialog = null;
      setUndos((x) => [...x, { ...t, id, from }]);
    };
    pushAsk = (x) => {
      setV(x.value ?? "");
      setA(x);
    };
  }, []);
  const close = (val: string | null) => {
    const d = document.querySelector<HTMLElement>("[data-ask-dialog]");
    if (d && val !== null) lastDialog = { rect: d.getBoundingClientRect(), t: performance.now() };
    a?.resolve(val);
    setA(null);
  };
  return (
    <>
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-3">
        {toasts.map((t) => (
          <div key={t.id} className={cx("anim-in pop-surface pointer-events-auto max-w-md rounded-xl px-3 py-2 text-sm", t.tone === "danger" ? "text-danger" : t.tone === "ok" ? "text-ok" : "")}>
            {t.text}
          </div>
        ))}
      </div>
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-3 sm:right-5 sm:left-auto sm:items-end">
        {undos.map((t) => (
          <UndoToastView key={t.id} t={t} done={() => setUndos((x) => x.filter((y) => y.id !== t.id))} />
        ))}
      </div>
      <Modal
        open={!!a}
        onClose={() => close(null)}
        title={a?.title ?? ""}
        dataAttr
        footer={
          <>
            <Button onClick={() => close(null)}>取消</Button>
            <Button data-autofocus variant={a?.danger ? "danger" : "primary"} onClick={() => close(a?.input ? v : "")}>
              {a?.confirm ?? "确定"}
            </Button>
          </>
        }
      >
        {a?.input ? (
          <form onSubmit={(e) => (e.preventDefault(), close(v))}>
            <Field label={a.label ?? ""}>
              <Input value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
            </Field>
          </form>
        ) : (
          <p className="text-sm text-muted">{a?.label}</p>
        )}
      </Modal>
    </>
  );
}

/**
 * Two-step destructive button (Arc UI confirm-morph): the pill widens in place into 「取消 / 确认」,
 * faces cross-fade (old out 80ms, new in 240ms), Esc cancels, auto-disarms after 6s,
 * then shows a spinner while onConfirm runs and a tick when it resolves.
 */
export function ConfirmButton({ icon, label, confirmLabel = "确认删除", onConfirm, iconOnly, size = "md", className }: { icon: ReactNode; label: string; confirmLabel?: string; onConfirm: () => unknown | Promise<unknown>; iconOnly?: boolean; size?: "sm" | "md"; className?: string }) {
  const [st, setSt] = useState<"idle" | "armed" | "busy" | "done">("idle");
  const inner = useRef<HTMLSpanElement>(null);
  const [w, setW] = useState<number | undefined>(undefined);
  const box = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const m = () => setW(el.scrollWidth);
    m();
    const ro = new ResizeObserver(m);
    ro.observe(el);
    return () => ro.disconnect();
  }, [st]);
  useEffect(() => {
    if (st !== "armed") return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setSt("idle");
    const f = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setSt("idle");
    const t = setTimeout(() => setSt("idle"), 6000);
    window.addEventListener("keydown", k);
    document.addEventListener("mousedown", f);
    setTimeout(() => box.current?.querySelector<HTMLElement>("[data-confirm]")?.focus(), 0);
    return () => (clearTimeout(t), window.removeEventListener("keydown", k), document.removeEventListener("mousedown", f));
  }, [st]);
  useEffect(() => {
    const el = inner.current;
    if (!el || reduceMotion()) return;
    Array.from(el.children).forEach((c, i) => (c as HTMLElement).animate([{ opacity: 0, filter: "blur(3px)", transform: "scale(.92)" }, { opacity: 1, filter: "blur(0)", transform: "none" }], { duration: 240, delay: 80 + i * 40, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "backwards" }));
  }, [st]);
  const go = async () => {
    setSt("busy");
    try {
      await onConfirm();
      setSt("done");
      setTimeout(() => setSt("idle"), 1100);
    } catch {
      setSt("idle");
    }
  };
  const h = size === "sm" ? "h-8 text-[13px]" : "h-10 text-sm";
  return (
    <span ref={box} data-state={st} className={cx("confirm-morph inline-flex shrink-0 overflow-hidden rounded-full align-middle", st === "armed" ? "bg-danger/10 ring-1 ring-danger/30" : st === "idle" ? "" : "bg-hover", className)} style={{ width: w }} onClick={(e) => e.stopPropagation()}>
      <span ref={inner} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
        {st === "idle" && (
          <button type="button" aria-label={label} title={label} onClick={() => setSt("armed")} className={cx("btn-key inline-flex items-center justify-center gap-1.5 rounded-full font-medium text-danger hover:bg-danger/10 [&>svg]:size-4", h, iconOnly ? (size === "sm" ? "w-8" : "w-9") : "px-3.5")}>
            {icon}
            {!iconOnly && <span>{label}</span>}
          </button>
        )}
        {st === "armed" && (
          <>
            <button type="button" onClick={() => setSt("idle")} className={cx("rounded-full px-3 font-medium text-muted hover:bg-hover hover:text-fg", h)}>取消</button>
            <button type="button" data-confirm onClick={go} className={cx("btn-key inline-flex items-center gap-1.5 rounded-full bg-danger px-3.5 font-semibold text-white [&>svg]:size-4", h)}>
              {icon}
              {confirmLabel}
            </button>
          </>
        )}
        {st === "busy" && (
          <span className={cx("inline-flex items-center gap-1.5 px-3.5 text-muted", h)}>
            <Loader2 className="size-4 animate-spin" /> 处理中
          </span>
        )}
        {st === "done" && (
          <span className={cx("inline-flex items-center gap-1.5 px-3.5 font-medium text-ok", h)}>
            <span className="tick-pop flex size-5 items-center justify-center rounded-full bg-ok text-white"><Check className="size-3 stroke-[3]" /></span> 完成
          </span>
        )}
      </span>
    </span>
  );
}

type Anchor = { el: HTMLElement } | { x: number; y: number };
/**
 * Position a portaled popover next to an anchor element (or a point) and keep it inside the viewport:
 * flips to the other side when there is not enough room, shifts horizontally, and caps the height.
 */
export function usePopoverPos(open: boolean, anchor: Anchor | null, pop: React.RefObject<HTMLElement | null>, opts: { side?: "top" | "bottom"; align?: "left" | "right"; gap?: number; matchWidth?: boolean } = {}) {
  const [st, setSt] = useState<React.CSSProperties>({ position: "fixed", top: -9999, left: -9999, visibility: "hidden" });
  const { side = "bottom", align = "left", gap = 6, matchWidth } = opts;
  useLayoutEffect(() => {
    if (!open || !anchor) return;
    const place = () => {
      const el = pop.current;
      if (!el) return;
      const M = 8;
      const vw = window.innerWidth, vh = window.innerHeight;
      const r = "el" in anchor ? anchor.el.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
      el.style.maxHeight = "";
      const w = Math.max(el.offsetWidth, matchWidth ? r.width : 0);
      const h = el.scrollHeight;
      const below = vh - r.bottom - gap - M, above = r.top - gap - M;
      let s = side;
      if (s === "bottom" && h > below && above > below) s = "top";
      else if (s === "top" && h > above && below > above) s = "bottom";
      let room = s === "bottom" ? below : above;
      let height = Math.min(h, room);
      let top = s === "bottom" ? r.bottom + gap : r.top - gap - height;
      if (h > room && h <= vh - 2 * M) {
        // fits on neither side: keep the whole menu visible and let it overlap the anchor
        room = vh - 2 * M;
        height = h;
        top = s === "bottom" ? vh - M - h : M;
      }
      top = Math.max(M, Math.min(top, vh - M - height));
      let left = "el" in anchor ? (align === "right" ? r.right - w : r.left) : r.left;
      if (!("el" in anchor) && left + w > vw - M) left = r.left - w; // context menu: open to the left of the pointer
      left = Math.max(M, Math.min(left, vw - M - w));
      setSt({ position: "fixed", top, left, minWidth: matchWidth ? r.width : undefined, maxHeight: room < h ? room : undefined, transformOrigin: `${align === "right" ? "right" : "left"} ${s === "bottom" ? "top" : "bottom"}` });
    };
    place();
    const ro = new ResizeObserver(place);
    if (pop.current) ro.observe(pop.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, side, align, gap, matchWidth, pop]);
  return st;
}

/** Arrow-key navigation between menuitems inside a menu element. */
function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])"));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
  items[n]?.focus();
}

/** Anchored dropdown menu, portaled to <body> so it is never clipped by scroll containers; opaque surface. */
export function Menu({ trigger, children, align = "right", side = "bottom", matchWidth, className }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; side?: "top" | "bottom"; matchWidth?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const anchor = useMemo(() => (open && ref.current ? { el: (ref.current.firstElementChild as HTMLElement) ?? ref.current } : null), [open]);
  const style = usePopoverPos(open, anchor, pop, { side, align, matchWidth });
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && (setOpen(false), (ref.current?.querySelector("button") as HTMLElement | null)?.focus());
    document.addEventListener("mousedown", f);
    window.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", f);
      window.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <div ref={ref} className={className ?? "relative"}>
      {trigger(() => setOpen((o) => !o))}
      {open &&
        createPortal(
          <div ref={pop} role="menu" style={style} onKeyDown={menuKeys} onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()} className="pop-in pop-surface scroll-thin z-[75] min-w-48 overflow-auto rounded-2xl p-1.5">
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Context menu at a pointer position (right click / long press). Same opaque surface + viewport collision. */
export function ContextMenu({ at, onClose, children, label }: { at: { x: number; y: number } | null; onClose: () => void; children: (close: () => void) => ReactNode; label?: string }) {
  const pop = useRef<HTMLDivElement>(null);
  const style = usePopoverPos(!!at, at, pop, { gap: 2 });
  useEffect(() => {
    if (!at) return;
    const f = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", f);
    window.addEventListener("keydown", k);
    window.addEventListener("blur", onClose);
    setTimeout(() => pop.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true }), 0);
    return () => {
      document.removeEventListener("mousedown", f);
      window.removeEventListener("keydown", k);
      window.removeEventListener("blur", onClose);
    };
  }, [at, onClose]);
  if (!at) return null;
  return createPortal(
    <div ref={pop} role="menu" aria-label={label} style={style} onKeyDown={menuKeys} onContextMenu={(e) => e.preventDefault()} className="pop-in pop-surface scroll-thin z-[75] min-w-56 overflow-auto rounded-2xl p-1.5">
      {children(onClose)}
    </div>,
    document.body,
  );
}

export function MenuSep() {
  return <div role="separator" className="mx-2 my-1 h-px bg-line" />;
}

export function MenuItem({ icon, children, onClick, danger, kbd, disabled }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; kbd?: string; disabled?: boolean }) {
  return (
    <button role="menuitem" disabled={disabled} onClick={onClick} className={cx("flex min-h-9 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap outline-none transition-colors duration-150 hover:bg-hover focus-visible:bg-hover active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40", danger && "text-danger hover:bg-danger/10 focus-visible:bg-danger/10")}>
      <span className={cx("[&>svg]:size-4", danger ? "text-danger" : "text-muted")}>{icon}</span>
      <span className="flex-1">{children}</span>
      {kbd && <kbd className="pl-4 font-sans text-[11px] text-faint">{kbd}</kbd>}
    </button>
  );
}

export function Progress({ value, tone = "accent" }: { value: number; tone?: "accent" | "ok" | "danger" }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
      <div className={cx("h-full rounded-full transition-[width] duration-500", tone === "accent" ? "bg-accent" : tone === "ok" ? "bg-ok" : "bg-danger")} style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}
