// DEPTAI-485 round 5 motion components. References (design.lthero.com/prompt/<slug>):
//   ChipGroup      ← ui-21st-kuratlielia-chip-group
//   AnimatedTags   ← motion-21st-educalvolpz-animated-tags
//   OtpField       ← motion-eased-otp-field
//   useScrollTimeline ← motion-timeline-scroll
//   HoverReveal    ← motion-mp-hover-reveal
//   useSpring      ← motion-interior-command-palette (semi-implicit Euler, 1/240 s)
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cx } from "../lib/util";

export const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const eOut = (t: number) => 1 - Math.pow(1 - t, 3);

/* ───────── FLIP helper: remember rects, then animate children from old → new ───────── */
function useFlip(root: RefObject<HTMLElement | null>, sel: string, ms: number, ease: string) {
  const first = useRef<Map<string, DOMRect> | null>(null);
  const snap = useCallback(() => {
    const m = new Map<string, DOMRect>();
    root.current?.querySelectorAll<HTMLElement>(sel).forEach((el) => el.dataset.k && m.set(el.dataset.k, el.getBoundingClientRect()));
    first.current = m;
  }, [root, sel]);
  useLayoutEffect(() => {
    const m = first.current;
    first.current = null;
    if (!m || reduced()) return;
    root.current?.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      const a = el.dataset.k ? m.get(el.dataset.k) : undefined;
      if (!a) return;
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (dx || dy) el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "none" }], { duration: ms, easing: ease });
    });
  });
  return snap;
}

/* ───────── ChipGroup: multi-select filter pills, check grows in, extra fold into “+N” ───────── */
export type ChipOpt = { value: string; label: ReactNode; color?: string };
export function ChipGroup({ options, value, onChange, maxVisible = 4, label, clearLabel = "清除" }: { options: ChipOpt[]; value: string[]; onChange: (v: string[]) => void; maxVisible?: number; label: string; clearLabel?: string }) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const prev = useRef<Set<string>>(new Set());
  const snap = useFlip(root, ".chip", 420, "cubic-bezier(.2,.9,.25,1)");
  const sel = new Set(value);
  const vis = expanded || options.length <= maxVisible ? options : [...options.slice(0, maxVisible), ...options.slice(maxVisible).filter((o) => sel.has(o.value))];
  const hidden = options.length - vis.length;
  const shownNow = new Set(vis.map((o) => o.value));
  const fresh = [...shownNow].filter((v) => !prev.current.has(v));
  useEffect(() => void (prev.current = shownNow));
  const toggle = (v: string) => (snap(), onChange(sel.has(v) ? value.filter((x) => x !== v) : [...value, v]));
  const onKey = (e: React.KeyboardEvent) => {
    const list = [...(root.current?.querySelectorAll<HTMLElement>(".chip") ?? [])];
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const j = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % list.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + list.length) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : -1;
    if (j >= 0) (e.preventDefault(), list[j].focus());
  };
  return (
    <div>
      <div ref={root} className="chips" role="group" aria-label={label} onKeyDown={onKey}>
        {vis.map((o, i) => (
          <button key={o.value} type="button" data-k={o.value} aria-pressed={sel.has(o.value)} onClick={() => toggle(o.value)} className={cx("chip", fresh.includes(o.value) && prev.current.size > 0 && "grow")} style={fresh.includes(o.value) ? { animationDelay: `${Math.min(Math.max(0, i - maxVisible) * 45, 300)}ms` } : undefined}>
            <svg className="chk" viewBox="0 0 14 14" aria-hidden><path d="M2.5 7.4l3 3 6-6.6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
            {o.color && <span className={cx("dot", `tc-${o.color}`)} />}
            <span>{o.label}</span>
          </button>
        ))}
        {options.length > maxVisible && (expanded || hidden > 0) && (
          <button type="button" data-k="__more" className="chip more" aria-expanded={expanded} onClick={() => (snap(), setExpanded(!expanded))}>
            <span key={expanded ? "l" : "m"} className="mt in">{expanded ? "收起" : `+${hidden} 更多`}</span>
          </button>
        )}
      </div>
      {value.length > 0 && (
        <p className="mt-2 text-[12px] text-faint">已选 <b className="font-medium text-muted">{value.length}</b> 项 <button type="button" className="ml-1 underline underline-offset-2 hover:text-fg" onClick={() => (snap(), onChange([]))}>{clearLabel}</button></p>
      )}
    </div>
  );
}

/* ───────── AnimatedTags: chips jump between “selected” and “available” with ±20px + 4px blur ───────── */
export type TagOpt = { id: string; label: string; color?: string };
const AT = { dy: 20, blur: 4, dur: 250, ease: "cubic-bezier(.22,1,.36,1)" };
export function AnimatedTags({ options, selected, onChange, emptyText = "点下面的标签加进来", extra }: { options: TagOpt[]; selected: string[]; onChange: (ids: string[], changed: { id: string; on: boolean }) => void; emptyText?: string; extra?: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const snap = useFlip(root, ".atag:not(.gone)", AT.dur, AT.ease);
  const entering = useRef<{ id: string; toSel: boolean } | null>(null);
  const move = (id: string, toSel: boolean) => {
    const old = root.current?.querySelector<HTMLElement>(`.atag[data-k="${CSS.escape(id)}"]`);
    if (old && !reduced()) {
      // exit: detach a ghost from the flow and fade it out in the travel direction
      const g = old.cloneNode(true) as HTMLElement;
      const r = old.getBoundingClientRect(), pr = old.parentElement!.getBoundingClientRect();
      g.classList.add("gone");
      g.removeAttribute("data-k");
      g.style.left = `${r.left - pr.left}px`;
      g.style.top = `${r.top - pr.top}px`;
      old.parentElement!.appendChild(g);
      g.animate([{ transform: "none", opacity: 1, filter: "blur(0)" }, { transform: `translateY(${toSel ? -AT.dy : AT.dy}px)`, opacity: 0, filter: `blur(${AT.blur}px)` }], { duration: AT.dur, easing: AT.ease, fill: "forwards" }).onfinish = () => g.remove();
    }
    snap();
    entering.current = { id, toSel };
    onChange(toSel ? [...selected, id] : selected.filter((x) => x !== id), { id, on: toSel });
  };
  useLayoutEffect(() => {
    const e = entering.current;
    entering.current = null;
    if (!e || reduced()) return;
    const el = root.current?.querySelector<HTMLElement>(`.atag[data-k="${CSS.escape(e.id)}"]`);
    el?.animate([{ transform: `translateY(${e.toSel ? AT.dy : -AT.dy}px)`, opacity: 0, filter: `blur(${AT.blur}px)` }, { transform: "none", opacity: 1, filter: "blur(0)" }], { duration: AT.dur, easing: AT.ease });
  });
  const byId = new Map(options.map((o) => [o.id, o]));
  const chip = (o: TagOpt, on: boolean) => (
    <button key={o.id} type="button" data-k={o.id} className="atag" aria-label={(on ? "移除 " : "添加 ") + o.label} onClick={() => move(o.id, !on)}>
      {o.color && <i className={`tc-${o.color}`} />}{o.label}
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>{on ? <><circle cx="12" cy="12" r="10" /><path d="m15 9-6 6M9 9l6 6" /></> : <path d="M5 12h14M12 5v14" />}</svg>
    </button>
  );
  return (
    <div ref={root} className="space-y-3">
      <div className="atags-sel" data-empty={emptyText} data-tags-selected>{selected.map((id) => byId.get(id)).filter(Boolean).map((o) => chip(o!, true))}</div>
      <div className="atags-av" data-tags-available>{options.filter((o) => !selected.includes(o.id)).map((o) => chip(o, false))}{extra}</div>
    </div>
  );
}

/* ───────── OtpField: 6 cells (3+3), chars pop in, wrong → shake, right → ripple ───────── */
export type OtpStatus = "idle" | "checking" | "wrong" | "ok";
export function OtpField({ value, onChange, onComplete, status = "idle", length = 6, groups = [3, 3], label = "验证码", autoFocus }: { value: string; onChange: (v: string) => void; onComplete?: (v: string) => void; status?: OtpStatus; length?: number; groups?: number[]; label?: string; autoFocus?: boolean }) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const row = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [pops, setPops] = useState<number[]>([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? "");
  const locked = status === "checking" || status === "ok";
  useEffect(() => {
    if (autoFocus) inputs.current[0]?.focus();
  }, [autoFocus]);
  useEffect(() => {
    const r = row.current;
    if (!r || reduced()) return;
    if (status === "wrong") (r.classList.remove("shake"), void r.offsetWidth, r.classList.add("shake"));
    if (status === "ok") r.querySelectorAll(".otp-cell").forEach((c, i) => c.animate([{ transform: "none" }, { transform: "translateY(-3px) scale(1.04)" }, { transform: "none" }], { duration: 320, delay: i * 35, easing: "cubic-bezier(.2,0,0,1)" }));
  }, [status]);
  const fill = (at: number, d: string) => {
    if (locked) return;
    const start = d.length > 1 ? 0 : at;
    const next = chars.slice();
    const p: number[] = [];
    for (let k = 0; k < d.length && start + k < length; k++) (next[start + k] = d[k], p.push(start + k));
    const v = next.join("");
    setPops(p);
    onChange(v);
    inputs.current[Math.min(start + d.length, length - 1)]?.focus();
    if (next.every(Boolean)) onComplete?.(v);
  };
  let n = 0;
  return (
    <div ref={row} role="group" aria-label={label} data-otp className={cx("otp-row", status === "wrong" && "bad", status === "ok" && "ok")} onAnimationEnd={(e) => e.target === row.current && row.current?.classList.remove("shake")}>
      {groups.map((c, g) => (
        <div key={g} className="contents">
          {g > 0 && <span className="otp-sep" aria-hidden />}
          <div className="otp-grp">
            {Array.from({ length: c }, () => {
              const i = n++;
              return (
                <div key={i} className={cx("otp-cell", focus === i && "f")}>
                  <input
                    ref={(el) => void (inputs.current[i] = el)}
                    inputMode="numeric"
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    aria-label={`${label} 第 ${i + 1} 位，共 ${length} 位`}
                    maxLength={length}
                    readOnly={locked}
                    value=""
                    onFocus={() => setFocus(i)}
                    onBlur={() => setTimeout(() => !row.current?.contains(document.activeElement) && setFocus(null))}
                    onChange={(e) => {
                      const d = e.target.value.replace(/\D/g, "");
                      if (d) fill(i, d);
                    }}
                    onPaste={(e) => (e.preventDefault(), fill(0, (e.clipboardData.getData("text") || "").replace(/\D/g, "")))}
                    onKeyDown={(e) => {
                      if (locked) return;
                      if (e.key === "Backspace") {
                        e.preventDefault();
                        const j = chars[i] ? i : Math.max(0, i - 1);
                        const next = chars.slice();
                        next[j] = "";
                        onChange(next.join("").padEnd(0));
                        inputs.current[j]?.focus();
                      } else if (e.key === "ArrowLeft" && i > 0) inputs.current[i - 1]?.focus();
                      else if (e.key === "ArrowRight" && i < length - 1) inputs.current[i + 1]?.focus();
                      else if (e.key === "Enter" && chars.every(Boolean)) onComplete?.(chars.join(""));
                    }}
                  />
                  <span className="pointer-events-none flex items-center justify-center">
                    {chars[i] ? <span key={pops.includes(i) ? `p${chars[i]}${i}` : `s${i}`} className={cx("otp-ch", pops.includes(i) && "in")}>{chars[i]}</span> : focus === i && !locked ? <span className="otp-caret" /> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────── Scroll timeline: line tip pinned max(126px, 50% viewport) below the scroller top; q = eOut((L − dotY)/22) ───────── */
export function useScrollTimeline(root: RefObject<HTMLElement | null>, deps: unknown[], tip = 126, ramp = 22) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const scroller = (el.closest("main") as HTMLElement | null) ?? document.documentElement;
    let raf = 0;
    const paint = () => {
      raf = 0;
      const top = el.getBoundingClientRect().top;
      const vt = scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top;
      const all = reduced();
      // tip sits 126px below the scroller top, but never above the middle of the visible area,
      // so the first screen of events is already lit when the page opens
      const tipY = Math.max(tip, (scroller === document.documentElement ? innerHeight : scroller.clientHeight) * 0.5);
      const L = vt + tipY - top; // line length in timeline coordinates
      const len = clamp(L, 0, el.scrollHeight);
      // if the timeline ends above the tip, light everything
      const bottomGap = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      const fullyScrolled = bottomGap < 2;
      el.style.setProperty("--tl-len", `${all || fullyScrolled ? el.scrollHeight : len}px`);
      el.querySelectorAll<HTMLElement>(".tl-item").forEach((it) => {
        const y = it.offsetTop + 21;
        const q = all || fullyScrolled ? 1 : eOut(clamp((L - y) / ramp));
        it.style.setProperty("--q", q.toFixed(3));
      });
    };
    const on = () => void (raf ||= requestAnimationFrame(paint));
    paint();
    scroller.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => (scroller.removeEventListener("scroll", on), window.removeEventListener("resize", on), cancelAnimationFrame(raf));
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/* ───────── HoverReveal: preview follows the pointer at +26px, q tween 0.25 s easeOutCubic ───────── */
export function useHoverReveal() {
  const [src, setSrc] = useState<string | null>(null);
  const [blur, setBlur] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const st = useRef({ q: 0, from: 0, to: 0, t0: 0, x: 0, y: 0, raf: 0 });
  const frame = useCallback(() => {
    const s = st.current;
    const p = clamp((performance.now() - s.t0) / (reduced() ? 1 : 250));
    s.q = p >= 1 ? s.to : s.from + (s.to - s.from) * eOut(p);
    const el = box.current;
    if (el) {
      const w = 264, h = 168;
      let x = s.x + 26;
      if (x + w > innerWidth - 8) x = s.x - 26 - w;
      const y = clamp(s.y - 46, 8, innerHeight - h - 8);
      el.style.opacity = String(s.q);
      el.style.transform = `translate(${x}px,${y}px) scale(${reduced() ? 1 : 0.85 + 0.15 * s.q})`;
    }
    if (p < 1 || s.to > 0) s.raf = requestAnimationFrame(frame);
    else (s.raf = 0, setSrc(null));
  }, []);
  const go = (to: number) => {
    const s = st.current;
    s.from = s.q;
    s.to = to;
    s.t0 = performance.now();
    if (!s.raf) s.raf = requestAnimationFrame(frame);
  };
  useEffect(() => () => cancelAnimationFrame(st.current.raf), []);
  const bind = (url: string | null, opts?: { blur?: boolean }) =>
    url
      ? {
          onPointerEnter: (e: React.PointerEvent) => {
            if (e.pointerType === "touch") return;
            st.current.x = e.clientX;
            st.current.y = e.clientY;
            setBlur(!!opts?.blur);
            setSrc(url);
            go(1);
          },
          onPointerMove: (e: React.PointerEvent) => void ((st.current.x = e.clientX), (st.current.y = e.clientY)),
          onPointerLeave: () => go(0),
        }
      : {};
  const node = src ? (
    <div ref={box} className={cx("hrv", blur && "dh-cover-blur")} data-hover-reveal data-blur={blur ? "" : undefined} style={{ opacity: 0 }} aria-hidden>
      <img src={src} alt="" />
      {blur && <span className="dh-cover-hint">已模糊</span>}
    </div>
  ) : null;
  return { bind, node };
}

/* ───────── useSpring: semi-implicit Euler (1/240 s), stiffness / damping / mass ───────── */
export function useSpring(target: number, cfg = { k: 520, d: 34, m: 0.45 }, apply: (v: number) => void) {
  const s = useRef({ x: target, v: 0, raf: 0, last: 0 });
  useEffect(() => {
    const st = s.current;
    if (reduced()) return void ((st.x = target), apply(target));
    const tick = (t: number) => {
      let dt = Math.min(0.064, (t - (st.last || t)) / 1000);
      st.last = t;
      const h = 1 / 240;
      while (dt > 0) {
        const a = (-cfg.k * (st.x - target) - cfg.d * st.v) / cfg.m;
        st.v += a * h;
        st.x += st.v * h;
        dt -= h;
      }
      apply(st.x);
      if (Math.abs(st.x - target) > 0.05 || Math.abs(st.v) > 0.05) st.raf = requestAnimationFrame(tick);
      else (st.x = target, st.v = 0, apply(target), (st.raf = 0), (st.last = 0));
    };
    cancelAnimationFrame(st.raf);
    st.last = 0;
    st.raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(st.raf);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps
}
