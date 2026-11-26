import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import {
  BadgeCheck,
  ChevronDown,
  Cloud,
  Database,
  Eye,
  FolderCog,
  Globe,
  HardDrive,
  HelpCircle,
  Loader2,
  Lock,
  PenLine,
  Server,
  Shield,
  Terminal,
  User,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cx } from "../lib/util";
import { usePopoverPos } from "./ui";

/**
 * DriveHub Settings / Admin Layered UI Primitives (RHEA-277).
 *
 * Aligns with dropit's settings-ui separation + folia-major kit.css polish:
 * 1. Static information: SectionPanel headers, SettingRow labels, FactsGrid, StatusPill
 *    (borderless soft fill + colored dot — never looks clickable).
 * 2. Input controls: SettingInput / SettingSelect / SettingTextarea / SettingSwitch
 *    (sunken surface-0 fill, crisp line-2 border, hover line-3, focus ring).
 * 3. Action controls: raised Button / IconButton from ui.tsx.
 * 4. Visual anchors: ProviderIcon (standardized 32/40/44px colored brand icon slot).
 *
 * Every component resolves against the Paper 4-tier tokens so Paper / Bento / Swiss
 * skins and light / dark modes apply automatically.
 */

export const settingFieldClass =
  "block w-full min-h-10 rounded-lg border border-line-2 bg-surface-0 px-3 py-2 text-[13.5px] font-medium text-fg shadow-[inset_0_1px_1px_rgb(0_0_0/0.03)] transition-[border-color,box-shadow,background-color] duration-[var(--dur-fast)] placeholder:font-normal placeholder:text-fg-4 hover:border-line-3 focus-visible:border-accent focus-visible:bg-surface-1 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-fg-3 disabled:hover:border-line-2 aria-invalid:border-danger";

export const settingSelectClass = `${settingFieldClass} dh-select-native cursor-pointer`;

export const settingLabelClass = "inline-flex items-center gap-1.5 text-[12.5px] font-medium text-fg-2";

// ---------------------------------------------------------------------------
// InfoTip — keeps long explanations out of headings & setting rows
// ---------------------------------------------------------------------------

export interface InfoTipProps {
  content: ReactNode;
  label?: string;
  className?: string;
}

/** Compact help icon that reveals explanatory text on hover, keyboard focus, or click. */
export function InfoTip({ content, label = "查看说明", className }: InfoTipProps) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  const open = pinned || hover || focused;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const suppressFocusOpen = useRef(false);
  const tipId = useId();
  const anchor = useMemo(() => (open && btnRef.current ? { el: btnRef.current } : null), [open]);
  const pos = usePopoverPos(open, anchor, popRef, { side: "top", align: "left", gap: 6 });

  useEffect(() => {
    if (!open) return;
    const closeAll = () => {
      setPinned(false);
      setHover(false);
      setFocused(false);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target) && !popRef.current?.contains(target)) {
        closeAll();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeAll();
        suppressFocusOpen.current = true;
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        data-info-tip=""
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={(e) => {
          if (suppressFocusOpen.current) {
            suppressFocusOpen.current = false;
            return;
          }
          if (e.currentTarget.matches(":focus-visible")) setFocused(true);
        }}
        onBlur={(e) => {
          if (!popRef.current?.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
        onClick={(e) => {
          e.stopPropagation();
          setPinned((v) => {
            if (v) setHover(false);
            return !v;
          });
        }}
        className={cx(
          "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-fg-4 transition-colors hover:bg-surface-2 hover:text-fg-2 focus-visible:text-fg",
          className,
        )}
      >
        <HelpCircle className="size-3.5" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            id={tipId}
            role="tooltip"
            style={pos}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            className="anim-in pop-surface z-[80] max-w-xs rounded-xl px-3 py-2 text-[12px] leading-relaxed text-fg-2"
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// StatusPill — read-only status indicator (borderless soft fill + colored dot)
// ---------------------------------------------------------------------------

export type StatusTone = "ok" | "good" | "danger" | "bad" | "warn" | "neutral" | "accent" | "brand";

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  ok: "bg-ok-soft text-ok",
  good: "bg-ok-soft text-ok",
  danger: "bg-danger-soft text-danger",
  bad: "bg-danger-soft text-danger",
  warn: "bg-warn-soft text-warn",
  neutral: "bg-surface-2 text-fg-3",
  accent: "bg-accent-soft text-accent",
  brand: "bg-brand-soft text-brand",
};

export interface StatusPillProps extends ComponentProps<"span"> {
  tone?: StatusTone;
  /** Render the 6px status dot (default true). */
  dot?: boolean;
  /** Subtle pulse ring for live/active states. */
  pulse?: boolean;
  /** Spinning indicator for in-progress states. */
  spinning?: boolean;
  children: ReactNode;
}

/** Read-only status pill: borderless soft fill + status dot, never styled like a button. */
export function StatusPill({
  tone = "neutral",
  dot = true,
  pulse = false,
  spinning = false,
  children,
  className,
  ...rest
}: StatusPillProps) {
  return (
    <span
      data-status-pill=""
      data-tone={tone}
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium leading-5 whitespace-nowrap select-none",
        STATUS_TONE_CLASS[tone],
        className,
      )}
      {...rest}
    >
      {spinning ? (
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />
      ) : dot ? (
        <span aria-hidden="true" className="relative flex size-1.5 shrink-0">
          {pulse && <span className="upd-pulse-ring absolute inset-0 rounded-full bg-current opacity-65" />}
          <span className="relative inline-flex size-1.5 rounded-full bg-current opacity-85" />
        </span>
      ) : null}
      <span>{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// SectionPanel — card container grouping related rows or controls
// ---------------------------------------------------------------------------

export interface SectionPanelProps extends Omit<ComponentProps<"section">, "title"> {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  /** Optional concise tooltip explanation shown beside the title. */
  hint?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  /** When true, omits body padding and wraps children in `.dh-st-rows` for hairline-divided SettingRows. */
  flush?: boolean;
  children: ReactNode;
}

/** Settings/admin card separating header metadata from body rows/controls. */
export function SectionPanel({
  id,
  title,
  description,
  hint,
  icon,
  badge,
  actions,
  flush = false,
  children,
  className,
  ...rest
}: SectionPanelProps) {
  const autoId = useId();
  const titleId = title ? `${id ?? autoId}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-section-panel=""
      className={cx("dh-st-panel overflow-hidden", className)}
      {...rest}
    >
      {(title || actions) && (
        <header className="dh-st-panel-head flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-start gap-2.5">
            {icon && (
              <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-2 [&>svg]:size-4">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                {title && (
                  <h2 id={titleId} className="text-[14.5px] font-semibold tracking-tight text-fg">
                    {title}
                  </h2>
                )}
                {hint && <InfoTip content={hint} />}
                {badge}
              </div>
              {description && (
                <p className="mt-0.5 max-w-[66ch] text-[12.5px] leading-relaxed text-fg-3">{description}</p>
              )}
            </div>
          </div>
          {actions && <div className="ctl-sm flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "dh-st-rows" : "px-4 py-4 sm:px-5"}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// SettingRow — left-indented hairline row with icon slot + tooltip + right control
// ---------------------------------------------------------------------------

export interface SettingRowProps {
  title: ReactNode;
  description?: ReactNode;
  /** Optional tooltip shown beside title to keep rows compact. */
  hint?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Hairline indent: "default" (16px), "icon" (56px, auto-inferred when icon is set), or "sub" (40px). */
  indent?: "default" | "icon" | "sub";
  htmlFor?: string;
  align?: "center" | "start";
  children?: ReactNode;
  className?: string;
}

/** Single row inside a flush SectionPanel: label/icon on left, control or value on right. */
export function SettingRow({
  title,
  description,
  hint,
  icon,
  badge,
  indent,
  htmlFor,
  align = "center",
  children,
  className,
}: SettingRowProps) {
  const effectiveIndent = indent ?? (icon ? "icon" : "default");
  return (
    <div
      data-setting-row=""
      data-indent={effectiveIndent === "default" ? undefined : effectiveIndent}
      className={cx(
        "dh-st-row grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-5",
        align === "center" ? "sm:items-center" : "sm:items-start",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-2 [&>svg]:size-4">
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {htmlFor ? (
              <label htmlFor={htmlFor} className="cursor-pointer text-[13.5px] font-medium text-fg">
                {title}
              </label>
            ) : (
              <p className="text-[13.5px] font-medium text-fg">{title}</p>
            )}
            {hint && <InfoTip content={hint} />}
            {badge}
          </div>
          {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-fg-3">{description}</p>}
        </div>
      </div>
      {children != null && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">{children}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disclosure & DisclosureRow — smooth grid-template-rows: 0fr -> 1fr collapse
// ---------------------------------------------------------------------------

export interface DisclosureProps {
  open: boolean;
  instant?: boolean;
  children: ReactNode;
  className?: string;
}

/** Smooth height disclosure container using `grid-template-rows: 0fr -> 1fr`. */
export function Disclosure({ open, instant = false, children, className }: DisclosureProps) {
  return (
    <div
      data-disclosure=""
      data-open={open ? "true" : "false"}
      data-instant={instant ? "true" : undefined}
      aria-hidden={!open || undefined}
      className={cx("dh-unfold", className)}
    >
      <div inert={!open || undefined}>{children}</div>
    </div>
  );
}

export interface DisclosureRowProps {
  title: ReactNode;
  summary?: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional indent for the row hairline. */
  indent?: "default" | "icon" | "sub";
  /** Body padding override (default padded inside a quiet tinted surface). */
  flushBody?: boolean;
  children: ReactNode;
  className?: string;
}

/** Expandable row for advanced options or collapsible subsections inside SectionPanel or modals. */
export function DisclosureRow({
  title,
  summary,
  hint,
  icon,
  badge,
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  indent,
  flushBody = false,
  children,
  className,
}: DisclosureRowProps) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = controlledOpen ?? innerOpen;
  const bodyId = useId();
  const effectiveIndent = indent ?? (icon ? "icon" : "default");

  const toggle = () => {
    const next = !isOpen;
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div
      data-disclosure-row=""
      data-open={isOpen ? "true" : "false"}
      data-indent={effectiveIndent === "default" ? undefined : effectiveIndent}
      className={cx("dh-st-row", className)}
    >
      <div className="flex items-center gap-2 px-4 py-3 sm:px-5">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={bodyId}
          data-disclosure-trigger=""
          onClick={toggle}
          className="group flex min-w-0 flex-1 items-center gap-3 rounded-lg py-0.5 text-left transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {icon && (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-2 transition-colors group-hover:bg-surface-sunken [&>svg]:size-4">
              {icon}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13.5px] font-medium text-fg">{title}</span>
              {badge}
            </span>
            {summary && <span className="mt-0.5 block truncate text-[12.5px] text-fg-3">{summary}</span>}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cx(
              "size-4 shrink-0 text-fg-4 transition-transform duration-[var(--dur-base)] ease-[var(--ease-enter)] group-hover:text-fg-2",
              isOpen && "rotate-180 text-fg-2",
            )}
          />
        </button>
        {hint && <InfoTip content={hint} />}
      </div>
      <Disclosure open={isOpen}>
        <div
          id={bodyId}
          className={cx(
            flushBody ? "border-t border-line-1" : "border-t border-line-1 bg-surface-0/70 px-4 py-3.5 sm:px-5",
          )}
        >
          {children}
        </div>
      </Disclosure>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Input Controls — visually distinct from static info via sunken surface-0
// ---------------------------------------------------------------------------

export const SettingInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function SettingInput({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(settingFieldClass, className)} {...rest} />;
  },
);

export const SettingTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function SettingTextarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(settingFieldClass, "min-h-20 resize-y", className)} {...rest} />;
  },
);

export const SettingSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SettingSelect({ className, ...rest }, ref) {
    return <select ref={ref} className={cx(settingSelectClass, className)} {...rest} />;
  },
);

export interface SettingFieldProps {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  caption?: ReactNode;
  required?: boolean;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingField({
  label,
  htmlFor,
  hint,
  caption,
  required,
  error,
  children,
  className,
}: SettingFieldProps) {
  return (
    <div className={cx("space-y-1.5", className)}>
      <div className={settingLabelClass}>
        {htmlFor ? (
          <label htmlFor={htmlFor} className="cursor-pointer">
            {label}
          </label>
        ) : (
          <span>{label}</span>
        )}
        {required && <span className="text-danger" aria-hidden="true">*</span>}
        {hint && <InfoTip content={hint} />}
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      ) : caption ? (
        <p className="text-[12px] text-fg-4">{caption}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingSwitch — native checkbox role="switch" (inline or full-row card)
// ---------------------------------------------------------------------------

export interface SettingSwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role" | "onChange"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible label (rendered visibly when variant="card"). */
  label: string;
  description?: ReactNode;
  /** "inline" fits inside SettingRow; "card" renders a full clickable framed switch row. */
  variant?: "inline" | "card";
}

export function SettingSwitch({
  checked,
  onChange,
  label,
  description,
  variant = "inline",
  className,
  id,
  ...rest
}: SettingSwitchProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const descId = description ? `${inputId}-desc` : undefined;

  if (variant === "inline") {
    return (
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        aria-label={label}
        aria-describedby={descId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={cx("dh-switch-native", className)}
        {...rest}
      />
    );
  }

  return (
    <div
      data-switch-card=""
      className={cx(
        "relative flex items-center justify-between gap-4 rounded-lg border border-line-2 bg-surface-0 px-3.5 py-2.5 transition-colors hover:border-line-3 hover:bg-surface-2 has-[:disabled]:opacity-55 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/35",
        className,
      )}
    >
      <span className="min-w-0">
        <label
          htmlFor={inputId}
          className="block cursor-pointer text-[13.5px] font-medium text-fg after:absolute after:inset-0 after:content-['']"
        >
          {label}
        </label>
        {description && (
          <span id={descId} className="mt-0.5 block text-[12px] text-fg-3">
            {description}
          </span>
        )}
      </span>
      <input
        id={inputId}
        type="checkbox"
        role="switch"
        aria-describedby={descId}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="dh-switch-native relative z-10"
        {...rest}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderIcon — standardized brand icon slot for storage backends / roles / OAuth
// ---------------------------------------------------------------------------

export type ProviderKind =
  | "fs"
  | "s3"
  | "webdav"
  | "rclone"
  | "openlist"
  | "pikpak"
  | "p115"
  | "admin"
  | "editor"
  | "user"
  | "viewer"
  | "guest"
  | "custom"
  | "github"
  | "google";

export interface ProviderMeta {
  label: string;
  icon: LucideIcon;
  /** Light-safe & dark-safe brand foreground color */
  color: string;
  /** Optional short monogram for providers with iconic numeric/letter marks */
  monogram?: string;
}

export const PROVIDER_META: Record<ProviderKind, ProviderMeta> = {
  fs: { label: "本地磁盘", icon: HardDrive, color: "#5c6472" },
  s3: { label: "S3 兼容", icon: Database, color: "#d97706" },
  webdav: { label: "WebDAV", icon: Globe, color: "#0284c7" },
  rclone: { label: "rclone 桥接", icon: Terminal, color: "#0f766e" },
  openlist: { label: "OpenList 桥接", icon: Server, color: "#4f46e5" },
  pikpak: { label: "PikPak", icon: Zap, color: "#2563eb" },
  p115: { label: "115 网盘", icon: Cloud, color: "#059669", monogram: "115" },
  admin: { label: "管理员", icon: Shield, color: "#d0021b" },
  editor: { label: "编辑", icon: PenLine, color: "#2563eb" },
  user: { label: "成员", icon: User, color: "#0d9488" },
  viewer: { label: "只读", icon: Eye, color: "#64748b" },
  guest: { label: "访客", icon: Lock, color: "#b45309" },
  custom: { label: "自定义", icon: BadgeCheck, color: "#7c3aed" },
  github: { label: "GitHub", icon: FolderCog, color: "#334155" },
  google: { label: "Google", icon: Globe, color: "#ea4335" },
};

const PROVIDER_SIZE_CLASS = {
  sm: "size-8 rounded-lg [&>svg]:size-4 text-[11px]",
  md: "size-10 rounded-xl [&>svg]:size-[18px] text-[12px]",
  lg: "size-11 rounded-xl [&>svg]:size-5 text-[13px]",
} as const;

export interface ProviderIconProps {
  /** Built-in storage driver, role level, or provider identifier. */
  kind?: ProviderKind | string;
  /** Optional custom icon element overriding the preset icon. */
  icon?: ReactNode;
  /** Optional custom brand color overriding preset hue. */
  color?: string;
  /** Slot size: sm (32px), md (40px), lg (44px — recommended for mount cards). */
  size?: "sm" | "md" | "lg";
  className?: string;
  title?: string;
}

/**
 * Standardized colored rounded brand icon container.
 * Uses color-mix against surface-1 so tint stays refined and legible in both
 * light and dark themes across Paper / Bento / Swiss skins.
 */
export function ProviderIcon({ kind, icon, color, size = "lg", className, title }: ProviderIconProps) {
  const normalized = kind === "115" ? "p115" : kind;
  const meta = normalized && normalized in PROVIDER_META ? PROVIDER_META[normalized as ProviderKind] : undefined;
  const hue = color ?? meta?.color ?? "var(--accent)";
  const IconComp = meta?.icon ?? Cloud;

  return (
    <span
      data-provider-icon={normalized ?? "custom"}
      title={title ?? meta?.label}
      aria-hidden={title ? undefined : true}
      style={{
        color: hue,
        backgroundColor: `color-mix(in oklab, ${hue} 14%, var(--surface-1))`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${hue} 22%, transparent)`,
      }}
      className={cx(
        "inline-flex shrink-0 items-center justify-center font-bold tracking-tight select-none",
        PROVIDER_SIZE_CLASS[size],
        className,
      )}
    >
      {icon ? (
        icon
      ) : meta?.monogram ? (
        <span className="font-mono leading-none tabular-nums">{meta.monogram}</span>
      ) : (
        <IconComp aria-hidden="true" />
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// FactsGrid & InlineNote — read-only metadata strips
// ---------------------------------------------------------------------------

export interface FactItem {
  label: string;
  value: ReactNode;
}

/** Read-only key/value facts: muted labels, plain tabular values, visually distinct from controls. */
export function FactsGrid({ items, cols = 4, className }: { items: FactItem[]; cols?: 2 | 3 | 4; className?: string }) {
  const colCls =
    cols === 2 ? "sm:grid-cols-2" : cols === 3 ? "sm:grid-cols-3" : "grid-cols-2 md:grid-cols-4";
  return (
    <dl className={cx("grid gap-x-4 gap-y-3 text-[13.5px]", colCls, className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-[11.5px] font-medium text-fg-3">{item.label}</dt>
          <dd className="mt-0.5 truncate font-medium text-fg tabular-nums">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Quiet left-accented info/warn/danger callout strip (never styled like a button). */
export function InlineNote({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "warn" | "danger" | "ok";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "rounded-lg border-l-2 px-3 py-2 text-[12.5px] leading-relaxed text-fg-2",
        tone === "info" && "border-l-line-3 bg-surface-2/80",
        tone === "warn" && "border-l-warn bg-warn-soft",
        tone === "danger" && "border-l-danger bg-danger-soft",
        tone === "ok" && "border-l-ok bg-ok-soft",
        className,
      )}
    >
      {children}
    </div>
  );
}
