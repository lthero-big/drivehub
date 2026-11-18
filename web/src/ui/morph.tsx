// Shared bits of the unified loading button (DEPTAI-485 r3, motion-mp-loading-button).
import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from "react";
import "./motion.css";

const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const reducedMotion = () => !!mq?.matches;
export function useReducedMotion() {
  return useSyncExternalStore(
    (f) => (mq?.addEventListener("change", f), () => mq?.removeEventListener("change", f)),
    reducedMotion,
  );
}

export type Phase = "idle" | "run" | "done" | "error";

/** Animates the button width: natural → circle (run) → wider pill with check (done/error) → natural. */
export function useMorph(ref: RefObject<HTMLElement | null>, phase: Phase) {
  const idleBox = useRef({ v: 0 });
  const idleW = idleBox.current;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (phase === "idle") {
      if (el.style.width) {
        if (reducedMotion()) { el.style.width = ""; return; }
        el.style.width = `${idleW.v}px`;
        const t = setTimeout(() => (el.style.width = ""), 340);
        return () => clearTimeout(t);
      }
      return;
    }
    if (reducedMotion()) return;
    const h = el.getBoundingClientRect().height;
    if (!el.style.width) {
      idleW.v = el.getBoundingClientRect().width;
      el.style.width = `${idleW.v}px`;
      void el.offsetWidth;
    }
    el.style.width = `${phase === "run" ? h : Math.max(h + 76, 112)}px`;
  }, [phase, ref]);
}
export function LbSpin() {
  return (
    <span className="lb-spin" aria-hidden>
      <svg viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="3" />
        <circle cx="10" cy="10" r="8.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeDasharray="18.85 37.7" transform="rotate(-90 10 10)" />
      </svg>
    </span>
  );
}

export function LbDone({ label, error }: { label: string; error?: boolean }) {
  return (
    <span className="lb-done" aria-hidden>
      <svg width="16" height="16" viewBox="0 0 16 16" style={{ marginLeft: "-.1rem" }}>
        {error ? <path d="M4 4 L12 12 M12 4 L4 12" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" /> : <path d="M2.5 8.2 L6.2 12 L13.5 4" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />}
      </svg>
      <span>{label}</span>
    </span>
  );
}
