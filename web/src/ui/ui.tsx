import { Children, forwardRef, isValidElement, useEffect, useId, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, X } from "lucide-react";
import { cx } from "../lib/util";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" | "danger"; size?: "sm" | "md"; loading?: boolean };
/** Key-like button: raised surface, lift on hover, press-down on :active, ring on focus. */
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "outline", size = "md", loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "btn-key inline-flex items-center justify-center gap-1.5 rounded-xl font-medium whitespace-nowrap select-none disabled:opacity-50 disabled:pointer-events-none",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-10 px-4 text-sm",
        variant === "primary" && "btn-primary bg-accent text-accent-fg",
        variant === "outline" && "btn-outline border border-line bg-panel hover:bg-panel-2",
        variant === "ghost" && "btn-ghost hover:bg-hover",
        variant === "danger" && "btn-danger bg-danger text-white",
        className,
      )}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button aria-label={label} title={label} className={cx("btn-key btn-icon inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-hover hover:text-fg disabled:opacity-40", className)} {...rest}>
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx("field-input h-10 w-full rounded-xl border border-line bg-panel px-3 text-sm outline-none placeholder:text-faint hover:border-faint/60 focus:border-accent", className)} {...rest} />;
});

type SelectProps = { value: string | undefined; required?: boolean; onChange: (e: { target: { value: string } }) => void; children: ReactNode; className?: string; "aria-label"?: string; disabled?: boolean };
/** Custom listbox. Keeps the native-select call shape: <Select value onChange={(e)=>e.target.value}><option value>…</option></Select>. */
export function Select({ value, onChange, children, className, disabled, ...rest }: SelectProps) {
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
  const id = useId();
  const cur = opts.find((o) => o.value === (value ?? ""));
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
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
        className="btn-key field-input flex h-10 w-full min-w-28 items-center justify-between gap-2 rounded-xl border border-line bg-panel px-3 text-left text-sm hover:border-faint/60 disabled:opacity-50"
      >
        <span className="truncate">{cur?.label ?? "请选择"}</span>
        <ChevronDown className={cx("size-4 shrink-0 text-faint transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <ul id={id} role="listbox" className="pop-in glass scroll-thin absolute top-full left-0 z-50 mt-1.5 max-h-64 min-w-full overflow-auto rounded-xl border border-line p-1 shadow-pop">
          {opts.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => (e.preventDefault(), pick(o.value))}
              className={cx("flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm whitespace-nowrap", i === hi && "bg-hover", o.value === value && "font-medium text-accent")}
            >
              <span className="flex-1">{o.label}</span>
              {o.value === value && <Check className="size-4" />}
            </li>
          ))}
        </ul>
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

/** Tabs (segmented underline). Controlled; renders role=tablist. */
export function Tabs<T extends string>({ tabs, value, onChange, className }: { tabs: { id: T; label: ReactNode; icon?: ReactNode }[]; value: T; onChange: (v: T) => void; className?: string }) {
  return (
    <div role="tablist" className={cx("scroll-thin -mx-1 flex gap-1 overflow-x-auto border-b border-line px-1", className)}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={cx("tab-btn relative flex h-11 shrink-0 items-center gap-2 rounded-t-xl px-3.5 text-sm font-medium [&>svg]:size-4", t.id === value ? "text-fg" : "text-muted hover:text-fg")}
        >
          {t.icon}
          {t.label}
          <span className={cx("absolute inset-x-2 bottom-0 h-0.5 origin-center rounded-full bg-accent transition-transform duration-300", t.id === value ? "scale-x-100" : "scale-x-0")} />
        </button>
      ))}
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
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
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
          <div className="flex items-center gap-2">{actions}</div>
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

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
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
      <div ref={ref} role="dialog" aria-modal="true" className={cx("pop-in flex max-h-[92dvh] w-full flex-col rounded-t-3xl border border-line bg-panel shadow-pop sm:rounded-3xl", wide ? "sm:max-w-3xl" : "sm:max-w-md")}>
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
let pushToast: (t: Omit<Toast, "id">) => void = () => {};
export const toast = {
  ok: (text: string) => pushToast({ text, tone: "ok" }),
  err: (text: string) => pushToast({ text, tone: "danger" }),
  info: (text: string) => pushToast({ text, tone: "neutral" }),
};

type Ask = { title: string; label?: string; value?: string; confirm?: string; danger?: boolean; input: boolean; resolve: (v: string | null) => void };
let pushAsk: (a: Ask) => void = () => {};
export const ask = (title: string, opts: { label?: string; value?: string; confirm?: string } = {}) =>
  new Promise<string | null>((resolve) => pushAsk({ title, ...opts, input: true, resolve }));
export const confirmDlg = (title: string, opts: { label?: string; confirm?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((resolve) => pushAsk({ title, ...opts, input: false, resolve: (v) => resolve(v !== null) }));

export function Overlays() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [a, setA] = useState<Ask | null>(null);
  const [v, setV] = useState("");
  useEffect(() => {
    let n = 0;
    pushToast = (t) => {
      const id = ++n;
      setToasts((x) => [...x.slice(-3), { ...t, id }]);
      setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 3500);
    };
    pushAsk = (x) => {
      setV(x.value ?? "");
      setA(x);
    };
  }, []);
  const close = (val: string | null) => {
    a?.resolve(val);
    setA(null);
  };
  return (
    <>
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2 px-3">
        {toasts.map((t) => (
          <div key={t.id} className={cx("anim-in pointer-events-auto max-w-md rounded-lg border px-3 py-2 text-sm shadow-pop", t.tone === "danger" ? "border-danger/30 bg-panel text-danger" : t.tone === "ok" ? "border-ok/30 bg-panel text-ok" : "border-line bg-panel")}>
            {t.text}
          </div>
        ))}
      </div>
      <Modal
        open={!!a}
        onClose={() => close(null)}
        title={a?.title ?? ""}
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

/** Small anchored menu (click outside / Esc closes). */
export function Menu({ trigger, children, align = "right" }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", f);
    window.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", f);
      window.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div role="menu" className={cx("pop-in glass absolute z-40 mt-1 min-w-48 rounded-2xl border border-line p-1.5 shadow-pop", align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, kbd }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; kbd?: string }) {
  return (
    <button role="menuitem" onClick={onClick} className={cx("flex min-h-10 w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-hover active:scale-[0.98]", danger && "text-danger")}>
      <span className="text-muted [&>svg]:size-4">{icon}</span>
      <span className="flex-1">{children}</span>
      {kbd && <kbd className="text-[11px] text-faint">{kbd}</kbd>}
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
