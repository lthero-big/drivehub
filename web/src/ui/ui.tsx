import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { X, Loader2 } from "lucide-react";
import { cx } from "../lib/util";

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "outline" | "danger"; size?: "sm" | "md"; loading?: boolean };
export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "outline", size = "md", loading, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:pointer-events-none select-none",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-accent text-accent-fg hover:opacity-90",
        variant === "outline" && "border border-line bg-panel hover:bg-hover",
        variant === "ghost" && "hover:bg-hover",
        variant === "danger" && "bg-danger text-white hover:opacity-90",
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
    <button aria-label={label} title={label} className={cx("inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg disabled:opacity-40", className)} {...rest}>
      {children}
    </button>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx("h-9 w-full rounded-lg border border-line bg-panel px-3 text-sm outline-none placeholder:text-faint focus:border-accent", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx("h-9 rounded-lg border border-line bg-panel px-2 text-sm outline-none focus:border-accent", className)} {...rest}>
      {children}
    </select>
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
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", checked ? "bg-accent" : "bg-active")}>
      <span className={cx("inline-block size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
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
    <section className={cx("rounded-xl border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
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
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input,select,textarea,button[data-autofocus]")?.focus(), 0);
    return () => {
      window.removeEventListener("keydown", f);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" className={cx("anim-in flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-panel shadow-pop sm:rounded-2xl", wide ? "sm:max-w-3xl" : "sm:max-w-md")}>
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
        <div role="menu" className={cx("anim-in absolute z-40 mt-1 min-w-44 rounded-xl border border-line bg-panel p-1 shadow-pop", align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, danger, kbd }: { icon?: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean; kbd?: string }) {
  return (
    <button role="menuitem" onClick={onClick} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-hover", danger && "text-danger")}>
      <span className="text-muted [&>svg]:size-4">{icon}</span>
      <span className="flex-1">{children}</span>
      {kbd && <kbd className="text-[11px] text-faint">{kbd}</kbd>}
    </button>
  );
}

export function Progress({ value, tone = "accent" }: { value: number; tone?: "accent" | "ok" | "danger" }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
      <div className={cx("h-full rounded-full transition-[width]", tone === "accent" ? "bg-accent" : tone === "ok" ? "bg-ok" : "bg-danger")} style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}
