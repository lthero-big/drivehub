// Shared focus-expanding bento grid for settings dashboards.
// Same reflow as BentoGallery / motion-bento-focus-grid:
// animate grid-template tracks in place (480ms, no modal).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { cx } from "../lib/util";

export type BentoFocusTile = {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  home?: ReactNode;
  mini?: ReactNode;
  full: ReactNode;
};

function useNarrow(bp = 700): boolean {
  const [n, setN] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp}px)`);
    const sync = () => setN(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, [bp]);
  return n;
}

export function BentoFocusGrid({
  tiles,
  focus,
  onFocus,
  cols = 3,
  className,
  label = "设置",
}: {
  tiles: BentoFocusTile[];
  focus: string | null;
  onFocus: (id: string | null) => void;
  cols?: number;
  className?: string;
  label?: string;
}) {
  const narrow = useNarrow();
  const C = narrow ? 1 : Math.max(2, Math.min(3, cols));
  const n = tiles.length;
  const rows = Math.max(1, Math.ceil(n / C));
  const focusIdx = focus ? tiles.findIndex((t) => t.id === focus) : -1;
  const fRow = focusIdx >= 0 ? Math.floor(focusIdx / C) : -1;
  const fCol = focusIdx >= 0 ? focusIdx % C : -1;

  useEffect(() => {
    if (focus && focusIdx < 0) onFocus(null);
  }, [focus, focusIdx, onFocus]);

  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (document.querySelector('[role="tooltip"], [role="menu"], [role="dialog"], [role="listbox"]')) return;
        e.preventDefault();
        onFocus(null);
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (focusIdx < 0) return;
      let next = -1;
      if (e.key === "ArrowRight") next = Math.min(n - 1, focusIdx + 1);
      else if (e.key === "ArrowLeft") next = Math.max(0, focusIdx - 1);
      else if (e.key === "ArrowDown") next = Math.min(n - 1, focusIdx + C);
      else if (e.key === "ArrowUp") next = Math.max(0, focusIdx - C);
      if (next >= 0 && next !== focusIdx) {
        e.preventDefault();
        onFocus(tiles[next].id);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focus, focusIdx, n, C, tiles, onFocus]);

  const colTemplate = useMemo(() => {
    if (fCol < 0) return "repeat(" + C + ", minmax(0, 1fr))";
    return Array.from({ length: C }, (_, c) => (c === fCol ? "670fr" : "185fr")).join(" ");
  }, [C, fCol]);

  const rowTemplate = useMemo(() => {
    if (fRow < 0) return "repeat(" + rows + ", minmax(var(--bento-row), 1fr))";
    return Array.from({ length: rows }, (_, r) => {
      if (r === fRow) return "minmax(0, 520fr)";
      if (Math.abs(r - fRow) === 1) return "minmax(0, 88fr)";
      return "minmax(0, 0fr)";
    }).join(" ");
  }, [rows, fRow]);

  const height = fRow < 0 ? "calc(" + rows + " * var(--bento-row))" : "min(72vh, 760px)";

  return (
    <div
      className={cx("dh-bento", "dh-bento-settings", className)}
      data-settings-bento
      data-state={focus ? "focus" : "home"}
      role="list"
      aria-label={label}
      style={{ gridTemplateColumns: colTemplate, gridTemplateRows: rowTemplate, height }}
    >
      {tiles.map((t) => {
        const layer = focus === null ? "home" : t.id === focus ? "full" : "mini";
        return (
          <section
            key={t.id}
            role="listitem"
            tabIndex={0}
            data-tile
            data-id={t.id}
            data-layer={layer}
            aria-label={layer === "full" ? t.label + "（已展开）" : "展开 " + t.label}
            aria-expanded={layer === "full"}
            className={cx("dh-bento-tile", layer === "full" && "focused")}
            onClick={() => { if (t.id !== focus) onFocus(t.id); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                if (e.target !== e.currentTarget) return;
                e.preventDefault();
                if (t.id !== focus) onFocus(t.id);
              }
            }}
          >
            <div className={cx("dh-bento-layer", "home", layer === "home" && "on")}>
              <div className="dh-set-home">
                <div className="dh-set-kicker">
                  {t.icon ? <span className="dh-set-ico" aria-hidden>{t.icon}</span> : null}
                  <span className="dh-set-label">{t.label}</span>
                </div>
                {t.home ?? (t.hint ? <p className="dh-set-hint">{t.hint}</p> : null)}
              </div>
            </div>
            <div className={cx("dh-bento-layer", "mini", layer === "mini" && "on")}>
              {t.mini ?? (
                <div className="dh-set-mini">
                  {t.icon ? <span className="dh-set-ico" aria-hidden>{t.icon}</span> : null}
                  <span className="dh-set-mini-label">{t.label}</span>
                  {t.hint ? <span className="dh-set-mini-hint">{t.hint}</span> : null}
                </div>
              )}
            </div>
            <div className={cx("dh-bento-layer", "full", layer === "full" && "on")}>
              <div className="dh-set-full">
                <header className="dh-set-full-head">
                  <div className="dh-set-full-ttl">
                    {t.icon ? <span className="dh-set-ico" aria-hidden>{t.icon}</span> : null}
                    <h2>{t.label}</h2>
                  </div>
                  <button
                    type="button"
                    className="dh-bento-x dh-set-x"
                    aria-label="收起"
                    data-bento-close
                    onClick={(e) => { e.stopPropagation(); onFocus(null); }}
                  >
                    ×
                  </button>
                </header>
                <div className="dh-set-full-body">{t.full}</div>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
