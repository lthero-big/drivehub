import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, RotateCw, X, XCircle } from "lucide-react";
import { uploads, useUploads } from "../lib/uploads";
import { baseName, cx, fmtSize } from "../lib/util";
import { IconButton, Progress } from "../ui/ui";
import { FileIcon } from "./FileIcon";

/** Floating upload queue (bottom-right): progress, cancel, retry, resume badge. */
export function UploadQueue() {
  const jobs = useUploads();
  const [min, setMin] = useState(false);
  if (!jobs.length) return null;
  const active = jobs.filter((j) => j.status === "uploading" || j.status === "queued");
  const failed = jobs.filter((j) => j.status === "error").length;
  const total = jobs.reduce((a, j) => a + (j.status === "canceled" ? 0 : j.size), 0);
  const loaded = jobs.reduce((a, j) => a + (j.status === "canceled" ? 0 : j.loaded), 0);
  return (
    <section aria-label="上传队列" className="anim-in fixed right-3 bottom-3 z-40 w-[calc(100vw-1.5rem)] max-w-sm overflow-hidden rounded-xl border border-line bg-panel shadow-pop">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">{active.length ? `正在上传 ${active.length} 项` : failed ? `${failed} 项失败` : "上传完成"}</p>
          <p className="text-[11px] text-muted">
            {fmtSize(loaded)} / {fmtSize(total)}
          </p>
        </div>
        <IconButton label={min ? "展开" : "收起"} onClick={() => setMin(!min)}>
          {min ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </IconButton>
        <IconButton label={active.length ? "全部取消" : "清空"} onClick={() => (active.length ? uploads.cancelAll() : uploads.clearFinished())}>
          <X className="size-4" />
        </IconButton>
      </header>
      {!min && (
        <ul className="scroll-thin max-h-72 overflow-auto">
          {jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-2 px-3 py-2">
              <FileIcon name={j.file.name} isDir={false} className="size-4" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px]" title={j.path}>
                  {baseName(j.path)}
                </p>
                {j.status === "uploading" || j.status === "queued" ? (
                  <div className="mt-1 flex items-center gap-2">
                    <Progress value={j.size ? j.loaded / j.size : 0} />
                    <span className="w-10 text-right text-[11px] text-muted tabular-nums">{j.status === "queued" ? "等待" : `${Math.floor((j.loaded / (j.size || 1)) * 100)}%`}</span>
                  </div>
                ) : (
                  <p className={cx("text-[11px]", j.status === "error" ? "text-danger" : "text-muted")}>
                    {j.status === "done" ? `${fmtSize(j.size)}${j.resumed ? " · 断点续传" : ""}` : j.status === "canceled" ? "已取消" : j.error}
                  </p>
                )}
              </div>
              {j.status === "done" && <CheckCircle2 className="size-4 text-ok" aria-label="完成" />}
              {(j.status === "error" || j.status === "canceled") && (
                <IconButton label="重试" onClick={() => uploads.retry(j.id)}>
                  <RotateCw className="size-4" />
                </IconButton>
              )}
              {(j.status === "uploading" || j.status === "queued") && (
                <IconButton label="取消" onClick={() => uploads.cancel(j.id)}>
                  <XCircle className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
