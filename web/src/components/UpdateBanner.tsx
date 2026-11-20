import { RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { useVersion } from "../lib/version";

/** Reload prompt shown when the server or web bundle changed under this open page. */
export function UpdateBanner() {
  const v = useVersion();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = v.current ?? "stale";
  if (!v.stale || dismissed === key) return null;
  const upgraded = v.initial && v.current && v.initial !== v.current;
  const msg = upgraded
    ? "DriveHub 服务端已更新到 " + v.current + "（页面加载时为 " + v.initial + "），刷新以加载新版本。"
    : "Web 端有新版本，刷新以加载新版本。";
  return (
    <div role="status" className="flex items-center justify-center gap-3 bg-accent-soft px-4 py-2 text-[13px] text-accent">
      <span>{msg}</span>
      <button onClick={() => location.reload()} className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[12.5px] font-medium text-accent-fg hover:opacity-90">
        <RotateCcw className="size-3.5" />刷新页面
      </button>
      <button onClick={() => setDismissed(key)} aria-label="稍后" className="rounded-md p-1 hover:bg-hover"><X className="size-3.5" /></button>
    </div>
  );
}
