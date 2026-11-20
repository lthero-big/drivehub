// Image / video cover with optional tag-driven blur (peek on hover).
import { useEffect, useState, type ReactNode } from "react";
import { fileUrl } from "../lib/api";
import { isBlurred, type Tag } from "../lib/tags";
import { cx, kindOf } from "../lib/util";
import { FileIcon } from "./FileIcon";

const posters = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

export function posterOf(path: string): Promise<string | null> {
  const hit = posters.get(path);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(path);
  if (pending) return pending;
  const p = new Promise<string | null>((resolve) => {
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.src = fileUrl(path);
    const done = (url: string | null) => {
      v.removeAttribute("src");
      v.load();
      resolve(url);
    };
    const snap = () => {
      if (!v.videoWidth) return done(null);
      const max = 480;
      const scale = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(v.videoWidth * scale));
      c.height = Math.max(1, Math.round(v.videoHeight * scale));
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      try {
        const url = c.toDataURL("image/jpeg", 0.72);
        posters.set(path, url);
        done(url);
      } catch {
        done(null);
      }
    };
    const onReady = () => {
      const t = Math.min(0.25, (Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1) * 0.05);
      const onSeeked = () => {
        v.removeEventListener("seeked", onSeeked);
        snap();
      };
      v.addEventListener("seeked", onSeeked);
      try {
        v.currentTime = t;
      } catch {
        snap();
      }
    };
    v.addEventListener("loadeddata", onReady, { once: true });
    v.addEventListener("error", () => done(null), { once: true });
  });
  inflight.set(path, p);
  p.finally(() => inflight.delete(path));
  return p;
}

export function MediaCover({
  path, name, tags, alt, className, imgClass,
}: {
  path: string; name: string; tags?: Tag[]; alt?: string; className?: string; imgClass?: string;
}) {
  const kind = kindOf(name);
  const blur = isBlurred(tags);
  const [poster, setPoster] = useState<string | null>(() => posters.get(path) ?? null);
  useEffect(() => {
    if (kind !== "video") return;
    let live = true;
    if (!poster) posterOf(path).then((u) => { if (live) setPoster(u); });
    return () => { live = false; };
  }, [kind, path, poster]);
  const img = (src: string) => (
    <img src={src} alt={alt ?? ""} loading="lazy" decoding="async" draggable={false} className={cx("size-full object-cover", imgClass)} />
  );
  const frame = (child: ReactNode) => (
    <div className={cx("dh-cover", blur && "dh-cover-blur", className)} data-cover={kind} data-blur={blur ? "" : undefined}>
      {child}
      {blur && <span className="dh-cover-hint">已模糊</span>}
    </div>
  );
  if (kind === "image") return frame(img(fileUrl(path)));
  if (kind === "video") {
    return frame(poster ? img(poster) : <FileIcon name={name} isDir={false} className="size-10" />);
  }
  return <FileIcon name={name} isDir={false} className="size-10" />;
}
