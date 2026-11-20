// Focus-expanding bento gallery. Tracks reflow in place (no modal),
// matching https://design.lthero.com/prompt/motion-bento-focus-grid .
import { useEffect, useMemo, useState, type MouseEvent as RMouseEvent } from "react";
import { fileUrl, type FsItem } from "../lib/api";
import { isBlurred, type Tag } from "../lib/tags";
import { cx, fmtSize, fmtTime, kindOf } from "../lib/util";
import { Button } from "../ui/ui";
import { MediaCover } from "./MediaCover";

function useNarrow(): boolean {
  const [n, setN] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => setN(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return n;
}

export function BentoGallery({
  items,
  tagMap,
  cols,
  onOpen,
  onContext,
  itemProps,
}: {
  items: FsItem[];
  tagMap: Record<string, Tag[]>;
  cols: number;
  onOpen: (item: FsItem) => void;
  onContext: (e: RMouseEvent, item: FsItem) => void;
  itemProps?: (item: FsItem) => object;
}) {
  const narrow = useNarrow();
  const C = narrow ? 2 : Math.max(3, Math.min(5, cols));
  const [focus, setFocus] = useState<string | null>(null);
  const sig = items.map((i) => i.path).join("\n");
  useEffect(() => { setFocus(null); }, [sig]);

  const n = items.length;
  const rows = Math.max(1, Math.ceil(n / C));
  const focusIdx = focus ? items.findIndex((i) => i.path === focus) : -1;
  const fRow = focusIdx >= 0 ? Math.floor(focusIdx / C) : -1;
  const fCol = focusIdx >= 0 ? focusIdx % C : -1;

  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setFocus(null);
        return;
      }
      if (focusIdx < 0) return;
      let next = -1;
      if (e.key === "ArrowRight") next = Math.min(n - 1, focusIdx + 1);
      else if (e.key === "ArrowLeft") next = Math.max(0, focusIdx - 1);
      else if (e.key === "ArrowDown") next = Math.min(n - 1, focusIdx + C);
      else if (e.key === "ArrowUp") next = Math.max(0, focusIdx - C);
      else if (e.key === "Enter") {
        e.preventDefault();
        onOpen(items[focusIdx]);
        return;
      }
      if (next >= 0 && next !== focusIdx) {
        e.preventDefault();
        setFocus(items[next].path);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focus, focusIdx, n, C, items, onOpen]);

  useEffect(() => {
    if (!focus) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.querySelector<HTMLElement>(".dh-bento")?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [focus]);

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

  const height = fRow < 0 ? "calc(" + rows + " * var(--bento-row))" : "min(68vh, 720px)";

  return (
    <div
      className="dh-bento"
      data-gallery
      data-state={focus ? "focus" : "home"}
      data-focus-col={fCol >= 0 ? String(fCol) : undefined}
      style={{ gridTemplateColumns: colTemplate, gridTemplateRows: rowTemplate, height }}
    >
      {items.map((i) => {
        const layer = focus === null ? "home" : i.path === focus ? "full" : "mini";
        const kind = kindOf(i.name);
        const tags = tagMap[i.path];
        return (
          <section
            key={i.path}
            {...(itemProps?.(i) ?? {})}
            role="button"
            tabIndex={0}
            data-tile
            data-path={i.path}
            data-layer={layer}
            aria-label={layer === "full" ? i.name + "（已展开）" : "展开 " + i.name}
            aria-expanded={layer === "full"}
            className={cx("dh-bento-tile", layer === "full" && "focused")}
            onClick={() => { if (i.path !== focus) setFocus(i.path); }}
            onDoubleClick={(e) => { e.preventDefault(); onOpen(i); }}
            onContextMenu={(e) => onContext(e, i)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && i.path === focus) {
                e.preventDefault();
                e.stopPropagation();
                setFocus(null);
                return;
              }
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (i.path === focus) onOpen(i);
                else setFocus(i.path);
              }
            }}
          >
            <div className={cx("dh-bento-layer", "home", layer !== "full" && "on")}>
              <MediaCover path={i.path} name={i.name} tags={tags} alt={i.name} className="size-full" />
              {layer === "home" && <span className="dh-bento-name">{i.name}</span>}
            </div>
            {layer === "full" && (
              <div className={cx("dh-bento-layer", "full", "on")}>
                <button type="button" className="dh-bento-x" aria-label="收起" data-bento-close onClick={(e) => { e.stopPropagation(); setFocus(null); }}>×</button>
                <div className="dh-bento-full-media">
                  {kind === "video" && !isBlurred(tags) ? (
                    <video src={fileUrl(i.path)} controls playsInline autoPlay className="size-full object-contain" />
                  ) : (
                    <MediaCover path={i.path} name={i.name} tags={tags} alt={i.name} className="size-full" imgClass="object-contain" />
                  )}
                </div>
                <div className="dh-bento-meta">
                  <div className="min-w-0">
                    <div className="ttl">{i.name}</div>
                    <div className="sub">{i.size ? fmtSize(i.size) : ""}{i.modified_unix ? " · " + fmtTime(i.modified_unix) : ""}{kind === "video" ? " · 视频" : ""}</div>
                  </div>
                  <Button size="sm" variant="primary" onClick={(e) => { e.stopPropagation(); onOpen(i); }}>打开</Button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
