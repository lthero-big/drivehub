// Video + audio players (DEPTAI-485 r3 #2 #3): custom controls, speed, PiP, fullscreen, volume,
// keyboard shortcuts, seek preview (hover thumbnail), subtitles (sibling .srt/.vtt or local file),
// remembered position; audio: cover from ID3, waveform, playlist, loop/shuffle modes.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Captions, Maximize, Minimize, Music, Pause, PictureInPicture2, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX, Gauge, ListOrdered } from "lucide-react";
import { MorphPlay, reducedMotion } from "../ui/motion";
import { fileUrl, rawFetch, type FsItem } from "../lib/api";
import { cx, ext, fmtSize, kindOf } from "../lib/util";
import { ExternalPlayers } from "./PlayerIcons";

export const clock = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : String(m)) + `:${String(x).padStart(2, "0")}`;
};
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const posKey = (p: string) => `dh_pos:${p}`;

function usePos(path: string, el: React.RefObject<HTMLMediaElement | null>) {
  const [resumed, setResumed] = useState<number | null>(null);
  useEffect(() => {
    const m = el.current;
    if (!m) return;
    const save = () => {
      if (m.duration > 20 && m.currentTime > 5 && m.currentTime < m.duration - 5) localStorage.setItem(posKey(path), String(Math.floor(m.currentTime)));
      else if (m.duration && m.currentTime >= m.duration - 5) localStorage.removeItem(posKey(path));
    };
    const meta = () => {
      const v = Number(localStorage.getItem(posKey(path)));
      if (v > 5 && m.duration > v + 5) {
        m.currentTime = v;
        setResumed(v);
        setTimeout(() => setResumed(null), 4000);
      }
    };
    m.addEventListener("loadedmetadata", meta);
    m.addEventListener("pause", save);
    const t = setInterval(save, 3000);
    if (m.readyState >= 1) meta();
    return () => {
      save();
      clearInterval(t);
      m.removeEventListener("loadedmetadata", meta);
      m.removeEventListener("pause", save);
    };
  }, [path, el]);
  return resumed;
}

function srtToVtt(s: string) {
  return "WEBVTT\n\n" + s.replace(/\r/g, "").replace(/^\uFEFF/, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
}
async function loadSub(path: string): Promise<string> {
  const r = await rawFetch(fileUrl(path));
  const buf = new Uint8Array(await r.arrayBuffer());
  let t: string;
  try {
    t = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    t = new TextDecoder("gbk").decode(buf);
  }
  const vtt = ext(path) === "vtt" ? t : srtToVtt(t);
  return URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
}

type Sub = { label: string; url: string };

function Pop({ children, right }: { children: ReactNode; right?: number }) {
  return <div role="menu" className="mp-pop anim-in" style={{ right: right ?? 0 }} onClick={(e) => e.stopPropagation()}>{children}</div>;
}

export function VideoPlayer({ item, siblings }: { item: FsItem; siblings: FsItem[] }) {
  const url = fileUrl(item.path);
  const wrap = useRef<HTMLDivElement>(null);
  const v = useRef<HTMLVideoElement>(null);
  const pv = useRef<HTMLVideoElement | null>(null);
  const pc = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [buf, setBuf] = useState(0);
  const [vol, setVol] = useState(() => Number(localStorage.getItem("dh_vol") ?? 1));
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fs, setFs] = useState(false);
  const [idle, setIdle] = useState(false);
  const [menu, setMenu] = useState<null | "rate" | "sub">(null);
  const [subs, setSubs] = useState<Sub[]>([]);
  const [subSel, setSubSel] = useState(-1);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [flash, setFlash] = useState<{ k: number; icon: ReactNode } | null>(null);
  const [err, setErr] = useState(false);
  const [drag, setDrag] = useState(false);
  const idleT = useRef<number>(0);
  const hls = ext(item.name) === "m3u8";
  const resumed = usePos(item.path, v);

  // sibling subtitles with same stem
  useEffect(() => {
    let live = true;
    const stem = item.name.replace(/\.[^.]+$/, "").toLowerCase();
    const cands = siblings.filter((s) => !s.is_dir && ["srt", "vtt"].includes(ext(s.name)) && s.name.toLowerCase().startsWith(stem));
    setSubs([]);
    setSubSel(-1);
    Promise.all(cands.map(async (c) => ({ label: c.name.slice(stem.length).replace(/^[._-]/, "").replace(/\.(srt|vtt)$/i, "") || c.name, url: await loadSub(c.path) }))).then((l) => {
      if (!live) return;
      setSubs(l);
      if (l.length) setSubSel(0);
    }, () => {});
    return () => {
      live = false;
    };
  }, [item.path, siblings]);
  useEffect(() => {
    const tt = v.current?.textTracks;
    if (!tt) return;
    for (let i = 0; i < tt.length; i++) tt[i].mode = i === subSel ? "showing" : "disabled";
  }, [subSel, subs]);

  useEffect(() => {
    const m = v.current;
    if (!m) return;
    m.volume = vol;
    m.muted = muted;
    localStorage.setItem("dh_vol", String(vol));
  }, [vol, muted]);
  useEffect(() => {
    if (v.current) v.current.playbackRate = rate;
  }, [rate, item.path]);
  useEffect(() => {
    const f = () => setFs(document.fullscreenElement === wrap.current);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(idleT.current);
    idleT.current = window.setTimeout(() => !v.current?.paused && setIdle(true), 2600);
  }, []);
  const doFlash = (icon: ReactNode) => setFlash({ k: Date.now(), icon });
  const toggle = useCallback(() => {
    const m = v.current;
    if (!m) return;
    if (m.paused) m.play().catch(() => {});
    else m.pause();
    doFlash(m.paused ? <Play className="size-8" /> : <Pause className="size-8" />);
  }, []);
  const seek = useCallback((t: number) => {
    const m = v.current;
    if (m && isFinite(m.duration)) m.currentTime = Math.max(0, Math.min(m.duration, t));
  }, []);
  const toggleFs = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.current?.requestFullscreen?.();
  }, []);
  const pip = useCallback(async () => {
    const m = v.current as (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }) | null;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await m?.requestPictureInPicture?.();
    } catch {
      /* unsupported */
    }
  }, []);
  const setRateTo = (r: number) => {
    setRate(r);
    doFlash(<span className="text-lg font-semibold">{r}×</span>);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!wrap.current || wrap.current.offsetParent === null) return;
      if ((e.target as HTMLElement)?.closest("input,textarea,select,[role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const m = v.current;
      if (!m) return;
      const k = e.key;
      let used = true;
      if (k === " " || k === "k") toggle();
      else if (k === "ArrowRight") (seek(m.currentTime + 5), doFlash(<span className="text-base font-semibold">+5s</span>));
      else if (k === "ArrowLeft") (seek(m.currentTime - 5), doFlash(<span className="text-base font-semibold">−5s</span>));
      else if (k === "l") (seek(m.currentTime + 10), doFlash(<span className="text-base font-semibold">+10s</span>));
      else if (k === "j") (seek(m.currentTime - 10), doFlash(<span className="text-base font-semibold">−10s</span>));
      else if (k === "ArrowUp") setVol((x) => Math.min(1, +(x + 0.05).toFixed(2)));
      else if (k === "ArrowDown") setVol((x) => Math.max(0, +(x - 0.05).toFixed(2)));
      else if (k === "m") setMuted((x) => !x);
      else if (k === "f") toggleFs();
      else if (k === "p") pip();
      else if (k === "c") setSubSel((s) => (subs.length ? (s + 2 > subs.length ? -1 : s + 1) : -1));
      else if (k === ">" || k === ".") setRateTo(RATES[Math.min(RATES.length - 1, RATES.indexOf(rate) + 1)] ?? 1);
      else if (k === "<" || k === ",") setRateTo(RATES[Math.max(0, RATES.indexOf(rate) - 1)] ?? 1);
      else if (/^[0-9]$/.test(k)) seek((m.duration * Number(k)) / 10);
      else if (k === "Home") seek(0);
      else used = false;
      if (used) (e.preventDefault(), wake());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, seek, toggleFs, pip, wake, rate, subs.length]);

  // seek bar
  const pctOf = (e: { clientX: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  const onSeekDown = (e: RPointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(true);
    seek(pctOf(e, e.currentTarget) * dur);
  };
  const onSeekMove = (e: RPointerEvent<HTMLDivElement>) => {
    const p = pctOf(e, e.currentTarget);
    setHover({ x: p, t: p * dur });
    if (drag) seek(p * dur);
    if (hls || !dur) return;
    if (!pv.current) {
      const pvv = document.createElement("video");
      pvv.muted = true;
      pvv.preload = "auto";
      pvv.src = url;
      pvv.addEventListener("seeked", () => {
        const c = pc.current;
        if (c && pvv.videoWidth) c.getContext("2d")?.drawImage(pvv, 0, 0, c.width, c.height);
      });
      pv.current = pvv;
    }
    if (pv.current.readyState >= 1) pv.current.currentTime = p * dur;
  };
  useEffect(
    () => () => {
      pv.current?.removeAttribute("src");
      pv.current = null;
    },
    [item.path],
  );

  const onTime = () => {
    const m = v.current!;
    setCur(m.currentTime);
    if (m.buffered.length) setBuf(m.buffered.end(m.buffered.length - 1));
  };
  const clickT = useRef<number>(0);
  const onSurface = () => {
    if (menu) return setMenu(null);
    clearTimeout(clickT.current);
    clickT.current = window.setTimeout(toggle, 220);
  };
  const VolIcon = muted || vol === 0 ? VolumeX : vol < 0.5 ? Volume1 : Volume2;
  const pct = dur ? (cur / dur) * 100 : 0;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="video-player">
      <div ref={wrap} tabIndex={0} onMouseMove={wake} onMouseLeave={() => playing && setIdle(true)} className={cx("mp min-h-0 flex-1 outline-none", idle && playing && "idle", fs && "!rounded-none")}>
        <video
          key={item.path}
          ref={v}
          src={url}
          autoPlay
          playsInline
          crossOrigin="anonymous"
          onClick={onSurface}
          onDoubleClick={() => (clearTimeout(clickT.current), toggleFs())}
          onPlay={() => (setPlaying(true), wake())}
          onPause={() => (setPlaying(false), setIdle(false))}
          onTimeUpdate={onTime}
          onDurationChange={(e) => setDur(e.currentTarget.duration)}
          onProgress={onTime}
          onError={() => setErr(true)}
          onLoadedMetadata={() => setErr(false)}
        >
          {subs.map((s) => <track key={s.url} kind="subtitles" label={s.label} src={s.url} />)}
        </video>
        {err && (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center text-sm">
            <p>浏览器无法播放此视频（编码不受支持或网络错误）。<br />请使用下方的外部播放器，或下载后观看。</p>
          </div>
        )}
        {flash && <div className="mp-big" key={flash.k}><div className="mp-flash">{flash.icon}</div></div>}
        {resumed != null && <div className="absolute left-4 bottom-20 rounded-lg bg-black/70 px-3 py-1.5 text-xs anim-in">已从 {clock(resumed)} 继续播放 · <button className="underline" onClick={() => seek(0)}>从头开始</button></div>}
        <div className="mp-top"><p className="truncate font-medium">{item.name}</p></div>
        <div className="mp-bar" onClick={(e) => e.stopPropagation()}>
          <div
            className={cx("mp-seek", drag && "drag")}
            data-testid="seekbar"
            role="slider"
            aria-label="播放进度"
            aria-valuemin={0}
            aria-valuemax={Math.floor(dur)}
            aria-valuenow={Math.floor(cur)}
            onPointerDown={onSeekDown}
            onPointerMove={onSeekMove}
            onPointerUp={() => setDrag(false)}
            onPointerLeave={() => !drag && setHover(null)}
          >
            <div className="track">
              <div className="buf" style={{ width: `${dur ? (buf / dur) * 100 : 0}%` }} />
              <div className="played" style={{ width: `${pct}%` }} />
            </div>
            <div className="knob" style={{ left: `${pct}%` }} />
            {hover && (
              <div className="pointer-events-none absolute bottom-5 flex -translate-x-1/2 flex-col items-center gap-1" style={{ left: `${hover.x * 100}%` }}>
                {!hls && <canvas ref={pc} width={160} height={90} className="rounded-md border border-white/20 bg-black" />}
                <span className="rounded bg-black/80 px-1.5 py-0.5 text-[11px] tabular-nums">{clock(hover.t)}</span>
              </div>
            )}
          </div>
          <div className="mt-1 flex items-center gap-0.5">
            <button className="mp-btn" aria-label={playing ? "暂停" : "播放"} onClick={toggle}><MorphPlay playing={playing} className="size-5" /></button>
            <button className="mp-btn" aria-label="后退 10 秒" onClick={() => seek(cur - 10)}><SkipBack className="size-[18px]" /></button>
            <button className="mp-btn" aria-label="前进 10 秒" onClick={() => seek(cur + 10)}><SkipForward className="size-[18px]" /></button>
            <div className="group/vol flex items-center">
              <button className="mp-btn" aria-label={muted ? "取消静音" : "静音"} onClick={() => setMuted(!muted)}><VolIcon className="size-5" /></button>
              <input type="range" className="mp-vol" min={0} max={1} step={0.01} value={muted ? 0 : vol} aria-label="音量" onChange={(e) => (setMuted(false), setVol(Number(e.target.value)))} />
            </div>
            <span className="ml-2 text-xs tabular-nums text-white/85">{clock(cur)} / {clock(dur)}</span>
            <span className="flex-1" />
            <div className="relative">
              <button className="mp-btn !w-auto gap-1 px-2 text-[13px] font-medium" aria-label="倍速" aria-pressed={menu === "rate"} onClick={() => setMenu(menu === "rate" ? null : "rate")}>
                <Gauge className="size-[18px]" /> {rate}×
              </button>
              {menu === "rate" && (
                <Pop>
                  {RATES.map((r) => <button key={r} role="menuitemradio" aria-checked={r === rate} onClick={() => (setRateTo(r), setMenu(null))}>{r === 1 ? "正常" : `${r}×`}{r === rate && "✓"}</button>)}
                </Pop>
              )}
            </div>
            <div className="relative">
              <button className="mp-btn" aria-label="字幕" aria-pressed={subSel >= 0} onClick={() => setMenu(menu === "sub" ? null : "sub")}><Captions className="size-5" /></button>
              {menu === "sub" && (
                <Pop>
                  <button role="menuitemradio" aria-checked={subSel < 0} onClick={() => (setSubSel(-1), setMenu(null))}>关闭字幕{subSel < 0 && "✓"}</button>
                  {subs.map((s, i) => <button key={s.url} role="menuitemradio" aria-checked={subSel === i} onClick={() => (setSubSel(i), setMenu(null))}>{s.label}{subSel === i && "✓"}</button>)}
                  <label className="flex w-full cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-white/80 hover:bg-white/10">
                    加载本地字幕…
                    <input type="file" accept=".srt,.vtt" hidden onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const t = await f.text();
                      const u = URL.createObjectURL(new Blob([f.name.endsWith(".vtt") ? t : srtToVtt(t)], { type: "text/vtt" }));
                      setSubs((l) => [...l, { label: f.name, url: u }]);
                      setSubSel(subs.length);
                      setMenu(null);
                    }} />
                  </label>
                </Pop>
              )}
            </div>
            {"pictureInPictureEnabled" in document && <button className="mp-btn" aria-label="画中画" onClick={pip}><PictureInPicture2 className="size-5" /></button>}
            <button className="mp-btn" aria-label={fs ? "退出全屏" : "全屏"} onClick={toggleFs}>{fs ? <Minimize className="size-5" /> : <Maximize className="size-5" />}</button>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ExternalPlayers url={url} />
        <p className="hidden text-xs text-faint lg:block">空格 播放 · ←/→ 5s · J/L 10s · ↑/↓ 音量 · F 全屏 · P 画中画 · C 字幕 · &lt;/&gt; 倍速 · 0-9 跳转</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- audio

type Meta = { title?: string; artist?: string; album?: string; cover?: string };
function syncsafe(b: Uint8Array, o: number) {
  return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
}
function decodeText(b: Uint8Array, enc: number) {
  const dec = enc === 0 ? "latin1" : enc === 1 ? "utf-16" : enc === 2 ? "utf-16be" : "utf-8";
  return new TextDecoder(dec).decode(b).replace(/\0+$/, "");
}
async function readId3(path: string): Promise<Meta> {
  const r = await rawFetch(fileUrl(path), { headers: { range: "bytes=0-1048575" } });
  const b = new Uint8Array(await r.arrayBuffer());
  const out: Meta = {};
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return out;
  const ver = b[3];
  const end = Math.min(b.length, 10 + syncsafe(b, 6));
  let p = 10;
  while (p + 10 < end) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    const size = ver === 4 ? syncsafe(b, p + 4) : (b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7];
    if (!size || size < 0 || !/^[A-Z0-9]{4}$/.test(id)) break;
    const d = b.subarray(p + 10, Math.min(end, p + 10 + size));
    if (id === "TIT2") out.title = decodeText(d.subarray(1), d[0]);
    else if (id === "TPE1") out.artist = decodeText(d.subarray(1), d[0]);
    else if (id === "TALB") out.album = decodeText(d.subarray(1), d[0]);
    else if (id === "APIC" && !out.cover) {
      const enc = d[0];
      let q = 1;
      while (q < d.length && d[q] !== 0) q++;
      const mime = new TextDecoder("latin1").decode(d.subarray(1, q)) || "image/jpeg";
      q += 2; // NUL + picture type
      if (enc === 1 || enc === 2) {
        while (q + 1 < d.length && !(d[q] === 0 && d[q + 1] === 0)) q += 2;
        q += 2;
      } else {
        while (q < d.length && d[q] !== 0) q++;
        q += 1;
      }
      if (q < d.length) out.cover = URL.createObjectURL(new Blob([d.slice(q)], { type: mime.includes("/") ? mime : "image/jpeg" }));
    }
    p += 10 + size;
  }
  return out;
}

const hueOf = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

async function peaksOf(path: string, size: number, n: number): Promise<number[] | null> {
  if (size > 40 << 20) return null;
  const r = await rawFetch(fileUrl(path));
  const ab = await r.arrayBuffer();
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ac = new Ctx();
  try {
    const buf = await ac.decodeAudioData(ab);
    const ch = buf.getChannelData(0);
    const step = Math.floor(ch.length / n) || 1;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (let j = i * step; j < Math.min(ch.length, (i + 1) * step); j += Math.ceil(step / 200)) m = Math.max(m, Math.abs(ch[j]));
      out.push(m);
    }
    const mx = Math.max(...out) || 1;
    return out.map((x) => x / mx);
  } finally {
    ac.close();
  }
}

function Wave({ peaks, seed, progress, onSeek }: { peaks: number[] | null; seed: string; progress: number; onSeek: (p: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bars = useMemo(() => peaks ?? Array.from({ length: 120 }, (_, i) => 0.25 + 0.55 * Math.abs(Math.sin(i * 0.37 + hueOf(seed)) * Math.cos(i * 0.11))), [peaks, seed]);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const cs = getComputedStyle(c);
    const on = cs.getPropertyValue("--brand").trim() || "#d0021b";
    const off = cs.getPropertyValue("--line").trim() || "#ccc";
    const bw = w / bars.length;
    bars.forEach((p, i) => {
      const bh = Math.max(3, p * h * 0.92);
      g.fillStyle = i / bars.length < progress ? on : off;
      g.beginPath();
      g.roundRect(i * bw + 1, (h - bh) / 2, Math.max(1.5, bw - 2), bh, 2);
      g.fill();
    });
  }, [bars, progress]);
  return (
    <canvas
      ref={ref}
      data-testid="waveform"
      role="slider"
      aria-label="播放进度"
      className="h-16 w-full cursor-pointer"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - r.left) / r.width);
      }}
    />
  );
}

type Mode = "list" | "one" | "shuffle" | "order";
const MODES: { id: Mode; label: string; icon: ReactNode }[] = [
  { id: "list", label: "列表循环", icon: <Repeat className="size-[18px]" /> },
  { id: "one", label: "单曲循环", icon: <Repeat1 className="size-[18px]" /> },
  { id: "shuffle", label: "随机播放", icon: <Shuffle className="size-[18px]" /> },
  { id: "order", label: "顺序播放", icon: <ListOrdered className="size-[18px]" /> },
];

export function AudioPlayer({ item, siblings, onPick }: { item: FsItem; siblings: FsItem[]; onPick: (i: FsItem) => void }) {
  const url = fileUrl(item.path);
  const a = useRef<HTMLAudioElement>(null);
  const list = useMemo(() => siblings.filter((s) => !s.is_dir && kindOf(s.name) === "audio"), [siblings]);
  const idx = Math.max(0, list.findIndex((s) => s.path === item.path));
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [vol, setVol] = useState(() => Number(localStorage.getItem("dh_vol") ?? 1));
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [rateMenu, setRateMenu] = useState(false);
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem("dh_amode") as Mode) || "list");
  const [meta, setMeta] = useState<Meta>({});
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const resumed = usePos(item.path, a);
  // track change: keep showing the previous track's cover / title / waveform / colour until the new ones
  // are decoded, then swap once (no blank frame in between — r6 #2 "切歌闪一下")
  const [metaFor, setMetaFor] = useState(item.path);
  const hue = hueOf(metaFor.slice(metaFor.lastIndexOf("/") + 1));
  useEffect(() => {
    let live = true;
    const done = (m: Meta) => live && ((live = false), setMeta(m), setMetaFor(item.path));
    let peaksLive = true;
    readId3(item.path).then(done, () => done({}));
    const t = setTimeout(() => done({}), 1500); // slow / huge file: fall back to the file name
    peaksOf(item.path, item.size, 140).then((p) => peaksLive && setPeaks(p), () => peaksLive && setPeaks(null));
    return () => {
      live = false;
      peaksLive = false;
      clearTimeout(t);
    };
  }, [item.path, item.size]);
  useEffect(() => {
    if (a.current) (a.current.volume = vol, (a.current.muted = muted), localStorage.setItem("dh_vol", String(vol)));
  }, [vol, muted]);
  useEffect(() => {
    if (a.current) a.current.playbackRate = rate;
  }, [rate, item.path]);
  useEffect(() => localStorage.setItem("dh_amode", mode), [mode]);

  const step = useCallback(
    (d: 1 | -1, auto = false) => {
      if (!list.length) return;
      if (auto && mode === "one") {
        if (a.current) (a.current.currentTime = 0, a.current.play());
        return;
      }
      if (mode === "shuffle" && list.length > 1) {
        let n = idx;
        while (n === idx) n = Math.floor(Math.random() * list.length);
        return onPick(list[n]);
      }
      const n = idx + d;
      if (n >= list.length) return mode === "order" && auto ? undefined : onPick(list[0]);
      if (n < 0) return onPick(list[list.length - 1]);
      onPick(list[n]);
    },
    [list, idx, mode, onPick],
  );
  const toggle = useCallback(() => {
    const m = a.current;
    if (m) m.paused ? m.play().catch(() => {}) : m.pause();
  }, []);
  const seek = (t: number) => {
    if (a.current && isFinite(a.current.duration)) a.current.currentTime = Math.max(0, Math.min(a.current.duration, t));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = a.current;
      if (!el || !el.isConnected || el.closest("[hidden],.hidden") || (e.target as HTMLElement)?.closest("input,textarea,select,[role=dialog]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === " ") toggle();
      else if (k === "ArrowRight") seek(el.currentTime + 5);
      else if (k === "ArrowLeft") seek(el.currentTime - 5);
      else if (k === "ArrowUp") setVol((x) => Math.min(1, +(x + 0.05).toFixed(2)));
      else if (k === "ArrowDown") setVol((x) => Math.max(0, +(x - 0.05).toFixed(2)));
      else if (k === "n") step(1);
      else if (k === "p") step(-1);
      else if (k === "m") setMuted((x) => !x);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, step]);
  const VolIcon = muted || vol === 0 ? VolumeX : vol < 0.5 ? Volume1 : Volume2;
  const ready = metaFor === item.path;
  const title = meta.title || (ready ? item.name : list.find((x) => x.path === metaFor)?.name ?? item.name).replace(/\.[^.]+$/, "");
  const modeInfo = MODES.find((m) => m.id === mode)!;
  // track change: title / artist cross-fade 450 ms, content swaps at the midpoint
  const sub = [meta.artist, meta.album].filter(Boolean).join(" · ") || fmtSize((ready ? item : list.find((x) => x.path === metaFor) ?? item).size);
  const [shown, setShown] = useState({ title, sub });
  const [fade, setFade] = useState(false);
  useEffect(() => {
    if (shown.title === title && shown.sub === sub) return;
    if (reducedMotion()) return setShown({ title, sub });
    setFade(true);
    const t = setTimeout(() => (setShown({ title, sub }), setFade(false)), 225);
    return () => clearTimeout(t);
  }, [title, sub]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ap-root mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col gap-4 lg:flex-row" data-testid="audio-player" data-track={metaFor} style={{ ["--ap-h" as string]: `hsl(${hue} 70% 55%)` }}>
      <section className="ap relative mt-[98px] flex shrink-0 flex-col gap-4 rounded-[28px] border border-line p-5 pt-[14px] shadow-card lg:w-[22rem]" data-testid="music-player">
        {/* music-player widget (21st smammar): half vinyl peeks out of the card, 7s/turn while playing */}
        <div className="mp-disc-wrap" style={{ top: -98, height: 98, overflow: "hidden" }} aria-hidden>
          <div data-testid="vinyl" data-playing={playing ? "" : undefined} className={cx("mp-disc spin", !playing && "paused")} style={{ ["--mp-a" as string]: `hsl(${hue} 70% 58%)`, ["--mp-b" as string]: `hsl(${(hue + 60) % 360} 70% 40%)` }}>
            {meta.cover && <img key={meta.cover} src={meta.cover} alt="" data-testid="audio-cover" className="mp-cover absolute inset-0 size-full rounded-full object-cover opacity-90" />}
            <span className="absolute inset-0 rounded-full" style={{ background: "repeating-radial-gradient(circle, rgb(255 255 255 / .06) 0 2px, rgb(0 0 0 / .08) 2px 4px)" }} />
          </div>
        </div>
        <div className={cx("mp-meta min-w-0", fade && "x")}>
          <p className="truncate text-base font-semibold" data-testid="audio-title">{shown.title}</p>
          <p className="truncate text-xs text-muted">{shown.sub}</p>
        </div>
        <DotViz playing={playing} />
        <Wave peaks={peaks} seed={item.name} progress={dur ? cur / dur : 0} onSeek={(p) => seek(p * dur)} />
        <div className="-mt-3 flex justify-between text-xs tabular-nums text-muted"><span>{clock(cur)}</span><span>{clock(dur)}</span></div>
        <div className="flex items-center justify-center gap-2">
          <button aria-label={modeInfo.label} title={modeInfo.label} onClick={() => setMode(MODES[(MODES.findIndex((m) => m.id === mode) + 1) % MODES.length].id)} className="grid size-10 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg">{modeInfo.icon}</button>
          <button aria-label="上一首" onClick={() => step(-1)} className="grid size-10 place-items-center rounded-full hover:bg-hover"><SkipBack className="size-5" /></button>
          <button aria-label={playing ? "暂停" : "播放"} onClick={toggle} className="grid size-14 place-items-center rounded-full bg-brand text-white shadow-pop transition active:scale-95 hover:brightness-110"><MorphPlay playing={playing} className="size-6" /></button>
          <button aria-label="下一首" onClick={() => step(1)} className="grid size-10 place-items-center rounded-full hover:bg-hover"><SkipForward className="size-5" /></button>
          <div className="relative">
            <button aria-label="倍速" onClick={() => setRateMenu(!rateMenu)} className="grid h-10 min-w-10 place-items-center rounded-full px-2 text-xs font-semibold text-muted hover:bg-hover hover:text-fg">{rate}×</button>
            {rateMenu && (
              <div className="pop-surface absolute bottom-12 left-1/2 z-10 -translate-x-1/2 rounded-xl p-1 text-[13px]">
                {RATES.map((r) => <button key={r} onClick={() => (setRate(r), setRateMenu(false))} className={cx("block w-full rounded-lg px-4 py-1.5 text-left hover:bg-hover", r === rate && "text-brand")}>{r}×</button>)}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button aria-label={muted ? "取消静音" : "静音"} onClick={() => setMuted(!muted)} className="grid size-8 place-items-center rounded-full text-muted hover:bg-hover"><VolIcon className="size-[18px]" /></button>
          <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : vol} aria-label="音量" onChange={(e) => (setMuted(false), setVol(Number(e.target.value)))} className="h-1 flex-1 accent-[var(--brand)]" />
        </div>
        {resumed != null && <p className="text-center text-xs text-muted">已从 {clock(resumed)} 继续</p>}
        <audio key={item.path} ref={a} src={url} autoPlay crossOrigin="anonymous" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)} onDurationChange={(e) => setDur(e.currentTarget.duration)} onEnded={() => step(1, true)} />
      </section>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-panel">
        <header className="flex items-center justify-between border-b border-line px-4 py-2 text-xs text-muted"><span>播放列表 · {list.length} 首</span><span>N 下一首 · P 上一首 · 空格 播放</span></header>
        <ol className="min-h-0 flex-1 overflow-auto scroll-thin text-[13px]" data-testid="playlist">
          {list.map((s, i) => {
            const on = s.path === item.path;
            return (
              <li key={s.path}>
                <button onClick={() => onPick(s)} aria-current={on} className={cx("flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-hover", on && "bg-brand-soft text-brand")}>
                  <span className="grid w-6 place-items-center text-right text-xs text-faint">{on ? <span className={cx("eq text-brand", !playing && "paused")}><i /><i /><i /></span> : i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{s.name.replace(/\.[^.]+$/, "")}</span>
                  <span className="text-xs text-faint">{fmtSize(s.size)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

/** 21-column dot visualizer (three mixed sines, 60 ms tick, 6–30 px); static when paused / reduced motion. */
function DotViz({ playing }: { playing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dots = [...(ref.current?.children ?? [])] as HTMLElement[];
    if (!playing || reducedMotion()) return void dots.forEach((d) => (d.style.height = "6px"));
    let t = 0;
    const id = setInterval(() => {
      t += 0.06;
      dots.forEach((d, i) => {
        const v = Math.sin(t * 5 + i * 0.7) * 0.5 + Math.sin(t * 8.3 + i * 1.9) * 0.3 + Math.sin(t * 2.1 + i * 0.35) * 0.4;
        d.style.height = `${6 + Math.max(0, v) * 24}px`;
      });
    }, 60);
    return () => clearInterval(id);
  }, [playing]);
  return <div ref={ref} className="mp-viz" data-testid="dot-viz" aria-hidden>{Array.from({ length: 21 }, (_, i) => <span key={i} />)}</div>;
}
