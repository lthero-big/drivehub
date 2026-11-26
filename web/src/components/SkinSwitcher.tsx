import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import {
  SKINS,
  useResolvedDark,
  useSkin,
  useTheme,
  type SkinId,
  type SkinMeta,
  type ThemePref,
} from "../lib/theme";
import { cx } from "../lib/util";
import { usePopoverPos } from "../ui/ui";
import { SectionPanel, SettingRow, StatusPill } from "../ui/settings-ui";

function SkinSwatches({ skin, dark }: { skin: SkinMeta; dark: boolean }) {
  const [canvas, card, accent] = dark ? skin.darkSwatches : skin.swatches;
  const r = skin.radiusHint === "sharp" ? "rounded-none" : "rounded-full";
  return (
    <span className="inline-flex shrink-0 items-center -space-x-1" aria-hidden="true">
      <span className={cx("size-3 border border-line-2", r)} style={{ backgroundColor: canvas }} />
      <span className={cx("size-3 border border-line-2", r)} style={{ backgroundColor: card }} />
      <span className={cx("size-3 border border-black/10", r)} style={{ backgroundColor: accent }} />
    </span>
  );
}

/**
 * Compact top-bar skin picker popover (Paper / Bento / Swiss).
 * Portaled to body so it is never clipped; instant switch + localStorage persistence.
 */
export function SkinMenu() {
  const [skin, setSkin] = useSkin();
  const dark = useResolvedDark();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  const current = SKINS.find((s) => s.id === skin) ?? SKINS[0];
  const anchor = useMemo(() => (open && triggerRef.current ? { el: triggerRef.current } : null), [open]);
  const style = usePopoverPos(open, anchor, popRef, { side: "bottom", align: "right", gap: 6 });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const pick = (id: SkinId) => {
    setSkin(id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-skin-trigger=""
        data-active-skin={skin}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`界面皮肤：${current.label}`}
        title={`界面皮肤：${current.label}`}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "btn-key inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-line-2 bg-surface-0 px-2.5 text-[12.5px] font-medium text-fg-2 hover:border-line-3 hover:bg-surface-2 hover:text-fg",
          open && "border-line-3 bg-surface-2 text-fg",
        )}
      >
        <SkinSwatches skin={current} dark={dark} />
        <span className="hidden sm:inline">{current.shortLabel}</span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popRef}
            id={popId}
            role="menu"
            aria-label="选择界面皮肤"
            data-skin-menu=""
            style={style}
            className="pop-in pop-surface z-[75] w-64 overflow-hidden rounded-2xl p-1.5"
          >
            <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-fg-3">
                <Palette className="size-3.5" aria-hidden="true" />
                界面皮肤
              </span>
              <span className="text-[10.5px] text-fg-4">{dark ? "深色" : "浅色"}</span>
            </div>
            <div className="space-y-0.5 pt-0.5">
              {SKINS.map((item) => {
                const selected = item.id === skin;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    data-skin-option={item.id}
                    onClick={() => pick(item.id)}
                    className={cx(
                      "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                      selected ? "bg-accent-soft text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    <span className="mt-1">
                      <SkinSwatches skin={item} dark={dark} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-[13px] font-medium leading-tight text-fg">
                        {item.label}
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-fg-3">
                        {item.description}
                      </span>
                    </span>
                    <Check
                      className={cx(
                        "mt-0.5 size-4 shrink-0 text-accent transition-opacity",
                        selected ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Visual skin & color-mode picker panel for Account → 偏好. */
export function AppearancePanel() {
  const [skin, setSkin] = useSkin();
  const [theme, setTheme] = useTheme();
  const dark = useResolvedDark();
  const current = SKINS.find((s) => s.id === skin) ?? SKINS[0];

  const modes: { value: ThemePref; label: string; icon: typeof Sun }[] = [
    { value: "light", label: "浅色", icon: Sun },
    { value: "dark", label: "深色", icon: Moon },
    { value: "system", label: "跟随系统", icon: Monitor },
  ];

  return (
    <SectionPanel
      title="外观与皮肤"
      icon={<Palette />}
      hint="皮肤与深浅色模式均保存在当前浏览器 localStorage，切换即时生效且不影响他人。"
      badge={<StatusPill tone="accent">{current.label}</StatusPill>}
      flush
    >
      <SettingRow
        title="色彩模式"
        description="选择浅色、深色或自动跟随操作系统外观"
      >
        <div
          role="radiogroup"
          aria-label="色彩模式"
          className="inline-flex rounded-xl border border-line-2 bg-surface-2 p-0.5"
        >
          {modes.map(({ value, label, icon: Icon }) => {
            const active = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                data-appearance-mode={value}
                onClick={() => setTheme(value)}
                className={cx(
                  "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors",
                  active
                    ? "bg-surface-1 text-fg shadow-elev-1"
                    : "text-fg-3 hover:text-fg",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </SettingRow>

      <div className="dh-st-row px-4 py-4 sm:px-5" data-appearance-skins="">
        <p className="mb-3 text-[13.5px] font-medium text-fg">界面皮肤</p>
        <div role="radiogroup" aria-label="界面皮肤" className="grid gap-3 sm:grid-cols-3">
          {SKINS.map((item) => {
            const selected = item.id === skin;
            const [canvas, card, accent] = dark ? item.darkSwatches : item.swatches;
            const frameRadius =
              item.radiusHint === "sharp" ? "0px" : item.radiusHint === "round" ? "14px" : "8px";
            const borderCol =
              item.id === "swiss"
                ? dark
                  ? "#e5e5e5"
                  : "#111111"
                : dark
                  ? "rgba(255,255,255,0.12)"
                  : "rgba(0,0,0,0.08)";

            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-appearance-skin={item.id}
                onClick={() => setSkin(item.id)}
                className={cx(
                  "group flex flex-col gap-2.5 rounded-xl border p-3 text-left transition-all",
                  selected
                    ? "border-accent bg-accent-soft/50 shadow-elev-1 ring-1 ring-accent/35"
                    : "border-line-2 bg-surface-0 hover:border-line-3 hover:bg-surface-2/60",
                )}
              >
                {/* Mini wireframe preview */}
                <div
                  aria-hidden="true"
                  className="flex h-16 w-full gap-1.5 overflow-hidden p-2"
                  style={{
                    backgroundColor: canvas,
                    borderRadius: frameRadius,
                    border: `1px solid ${borderCol}`,
                  }}
                >
                  <div className="flex w-7 flex-col gap-1">
                    <span
                      className="h-2.5 w-2.5"
                      style={{
                        backgroundColor: accent,
                        borderRadius: item.radiusHint === "sharp" ? "0px" : "4px",
                      }}
                    />
                    <span
                      className="h-1.5 w-full opacity-35"
                      style={{ backgroundColor: accent, borderRadius: frameRadius }}
                    />
                    <span
                      className="h-1.5 w-4/5 opacity-20"
                      style={{ backgroundColor: borderCol, borderRadius: frameRadius }}
                    />
                  </div>
                  <div
                    className="flex flex-1 flex-col justify-between p-1.5"
                    style={{
                      backgroundColor: card,
                      borderRadius: item.radiusHint === "sharp" ? "0px" : "6px",
                      border: `1px solid ${borderCol}`,
                    }}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span
                        className="h-1.5 w-10 opacity-45"
                        style={{ backgroundColor: dark ? "#e5e5e5" : "#222", borderRadius: frameRadius }}
                      />
                      <span
                        className="h-2 w-4"
                        style={{ backgroundColor: accent, borderRadius: frameRadius }}
                      />
                    </div>
                    <div className="space-y-1">
                      <span
                        className="block h-1 w-full opacity-20"
                        style={{ backgroundColor: dark ? "#e5e5e5" : "#222" }}
                      />
                      <span
                        className="block h-1 w-2/3 opacity-15"
                        style={{ backgroundColor: dark ? "#e5e5e5" : "#222" }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-fg">{item.label}</p>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{item.description}</p>
                  </div>
                  {selected && (
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg">
                      <Check className="size-3 stroke-[3]" aria-hidden="true" />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </SectionPanel>
  );
}
