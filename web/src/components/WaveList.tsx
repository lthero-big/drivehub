// Waveform list playback (DEPTAI-485 r5 C8, ref ui-mobbin-epidemic-sound-waveform-list): audio rows
// in the file list carry their own waveform (2px bars, 3px pitch, 36px high); clicking plays the
// track inline and lights the row's waveform; a sticky player bar reuses the waveform as a
// scrubbable progress bar. One shared <audio> element for the whole app.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Pause, Play, X } from "lucide-react";
import { fileUrl, rawFetch, type FsItem } from "../lib/api";
import { cx, fmtSize } from "../lib/util";

type S = { item: FsItem | null; playing: boolean; cur: number; dur: number; queue: FsItem[] };
let st: S = { item: null, playing: false, cur: 0, dur: 0, queue: [] };
const subs = new Set<() => void>();
const set = (p: Partial<S>) => ((st = { ...st, ...p }), subs.forEach((f) => f()));
let el: HTMLAudioElement | null = null;
const audio = () => {
  if (el) return el;
  el = new Audio();
  el.preload = "metadata";
  el.addEventListener("play", () => set({ playing: true }));
  el.addEventListener("pause", () => set({ playing: false }));
  el.addEventListener("timeupdate", () => set({ cur: el!.currentTime }));
  el.addEventListener("durationchange", () => set({ dur: isFinite(el!.duration) ? el!.duration : 0 }));
  el.addEventListener("ended", () => {
    const q = st.queue, i = q.findIndex((x) => x.path === st.item?.path);
    if (i >= 0 && i + 1 < q.length) inlineAudio.play(q[i + 1], q);
    else set({ playing: false });
  });
  return el;
};
export const inlineAudio = {
  get: () => st,
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  play(item: FsItem, queue: FsItem[] = st.queue) {
    const a = audio();
    if (st.item?.path === item.path) return void (a.paused ? a.play().catch(() => {}) : a.pause());
    a.src = fileUrl(item.path);
    set({ item, queue, cur: 0, dur: 0 });
    a.play().catch(() => set({ playing: false }));
    void loadPeaks(item);
  },
  seek(frac: number) {
    const a = audio();
    if (isFinite(a.duration)) a.currentTime = Math.max(0, Math.min(a.duration, frac * a.duration));
  },
  stop() {
    el?.pause();
    set({ item: null, playing: false, cur: 0, dur: 0 });
  },
};
export const useInlineAudio = () => useSyncExternalStore(inlineAudio.subscribe, inlineAudio.get);

// ---- peaks: deterministic placeholder per name, replaced by decoded peaks once played (< 25 MB)
const peakCache = new Map<string, number[]>();
const peakSubs = new Set<() => void>();
async function loadPeaks(i: FsItem) {
  if (peakCache.has(i.path) || i.size > 25 << 20) return;
  try {
    const ab = await (await rawFetch(fileUrl(i.path))).arrayBuffer();
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new Ctx();
    const buf = await ac.decodeAudioData(ab);
    void ac.close();
    const ch = buf.getChannelData(0), n = 160, step = Math.floor(ch.length / n) || 1;
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      let m = 0;
      for (let j = k * step; j < Math.min(ch.length, (k + 1) * step); j += Math.ceil(step / 160)) m = Math.max(m, Math.abs(ch[j]));
      out.push(m);
    }
    const mx = Math.max(...out) || 1;
    peakCache.set(i.path, out.map((x) => x / mx));
    peakSubs.forEach((f) => f());
  } catch {
    /* keep placeholder */
  }
}
const seedPeaks = (s: string) => {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return Array.from({ length: 160 }, (_, i) => 0.18 + 0.72 * Math.abs(Math.sin(i * 0.29 + h) * Math.cos(i * 0.07 + h / 7)) * (0.6 + 0.4 * Math.sin(i * 0.9 + h)));
};
const usePeaks = (i: FsItem) => {
  useSyncExternalStore((f) => (peakSubs.add(f), () => void peakSubs.delete(f)), () => peakCache.get(i.path));
  return peakCache.get(i.path) ?? null;
};

/** Canvas waveform: 2px bars on a 3px pitch; played part in the accent, rest muted (.38 alpha when idle). */
export function WaveCanvas({ item, progress, on, onSeek, className, label }: { item: FsItem; progress: number; on: boolean; onSeek?: (f: number) => void; className?: string; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const real = usePeaks(item);
  const peaks = useMemo(() => real ?? seedPeaks(item.name), [real, item.name]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (!w) return;
      c.width = w * dpr;
      c.height = h * dpr;
      const g = c.getContext("2d")!;
      g.scale(dpr, dpr);
      const cs = getComputedStyle(c);
      const acc = cs.getPropertyValue("--accent").trim() || "#0066cc", fg = cs.getPropertyValue("--fg").trim() || "#111", mu = cs.getPropertyValue("--faint").trim() || "#888";
      const bars = Math.floor(w / 3);
      g.globalAlpha = on ? 1 : 0.38;
      for (let b = 0; b < bars; b++) {
        const p = peaks[Math.floor((b / bars) * peaks.length)] ?? 0.2;
        const bh = Math.max(2, p * h);
        g.fillStyle = on && b / bars <= progress ? acc : on ? fg : mu;
        g.fillRect(b * 3, (h - bh) / 2, 2, bh);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, [peaks, progress, on]);
  const seekAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onSeek?.((e.clientX - r.left) / r.width);
  };
  return (
    <canvas
      ref={ref}
      role={onSeek ? "slider" : undefined}
      aria-label={label ?? "波形"}
      aria-valuenow={onSeek ? Math.round(progress * 100) : undefined}
      data-wave={item.path}
      data-on={on ? "" : undefined}
      className={cx("h-9 w-full", onSeek && "cursor-pointer", className)}
      onPointerDown={onSeek ? (e) => (e.stopPropagation(), e.currentTarget.setPointerCapture(e.pointerId), seekAt(e)) : undefined}
      onPointerMove={onSeek ? (e) => e.buttons && seekAt(e) : undefined}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Inline play button + waveform for one audio row. */
export function WaveRowExtra({ item, queue }: { item: FsItem; queue: FsItem[] }) {
  const a = useInlineAudio();
  const on = a.item?.path === item.path;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" data-wave-row>
      <button type="button" aria-label={on && a.playing ? `暂停 ${item.name}` : `播放 ${item.name}`} onClick={(e) => (e.stopPropagation(), inlineAudio.play(item, queue))} onDoubleClick={(e) => e.stopPropagation()} className={cx("grid size-8 shrink-0 place-items-center rounded-full border transition active:scale-90", on ? "border-accent bg-accent text-accent-fg" : "border-line hover:bg-hover")}>
        {on && a.playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-px" />}
      </button>
      <WaveCanvas item={item} on={on} progress={on && a.dur ? a.cur / a.dur : 0} onSeek={on ? inlineAudio.seek : (f) => (inlineAudio.play(item, queue), setTimeout(() => inlineAudio.seek(f), 300))} className="hidden max-w-[22rem] md:block" />
    </span>
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Sticky player bar (56px) — waveform doubles as the progress bar. */
export function WavePlayerBar() {
  const a = useInlineAudio();
  if (!a.item) return null;
  return (
    <div className="wvl-bar -mx-4 sm:-mx-8" data-wave-bar role="region" aria-label="正在播放">
      <button type="button" aria-label={a.playing ? "暂停" : "播放"} onClick={() => inlineAudio.play(a.item!)} className="grid size-10 place-items-center rounded-full bg-fg text-panel transition active:scale-95">
        {a.playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>
      <span className="min-w-0"><span className="block truncate text-[13px] font-medium" data-wave-title>{a.item.name.replace(/\.[^.]+$/, "")}</span><span className="block text-[11px] text-faint tabular-nums">{clock(a.cur)} / {clock(a.dur)} · {fmtSize(a.item.size)}</span></span>
      <WaveCanvas item={a.item} on progress={a.dur ? a.cur / a.dur : 0} onSeek={inlineAudio.seek} label="播放进度" />
      <button type="button" aria-label="关闭播放" onClick={inlineAudio.stop} className="ml-auto grid size-8 place-items-center rounded-full text-muted hover:bg-hover"><X className="size-4" /></button>
    </div>
  );
}
