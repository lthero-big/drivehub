import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, RotateCw, X, XCircle } from "lucide-react";
import { uploads, useUploads, type UpJob } from "../lib/uploads";
import { baseName, cx, fmtSize } from "../lib/util";
import { IconButton, Progress } from "../ui/ui";
import { FileIcon } from "./FileIcon";

const TTL_MS = 5000;
const LEAVE_MS = 320;
const autoDismiss = (j: UpJob) => j.status === "done" || j.status === "canceled";

/** Floating upload queue (bottom-right): progress, cancel, retry, auto-dismiss completed items. */
export function UploadQueue() {
  const jobs = useUploads();
  const [min, setMin] = useState(false);
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const [panelOut, setPanelOut] = useState(false);
  const [held, setHeld] = useState<UpJob[]>([]);
  const scheduled = useRef(new Set<number>());

  useEffect(() => {
    const now = Date.now();
    for (const j of jobs) {
      if (!autoDismiss(j) || scheduled.current.has(j.id)) continue;
      scheduled.current.add(j.id);
      const id = j.id;
      const wait = Math.max(0, TTL_MS - (now - (j.doneAt ?? now)));
      window.setTimeout(() => {
        setLeaving((s) => new Set(s).add(id));
        window.setTimeout(() => uploads.dismiss(id), LEAVE_MS);
      }, wait);
    }
    const live = new Set(jobs.map((j) => j.id));
    for (const id of [...scheduled.current]) if (!live.has(id)) scheduled.current.delete(id);
  }, [jobs]);

  useEffect(() => {
    if (jobs.length) {
      setHeld(jobs);
      setPanelOut(false);
      return;
    }
    if (!held.length) return;
    setPanelOut(true);
    const t = window.setTimeout(() => {
      setHeld([]);
      setLeaving(new Set());
      setPanelOut(false);
    }, LEAVE_MS);
    return () => clearTimeout(t);
  }, [jobs, held.length]);

  const view = jobs.length ? jobs : held;
  if (!view.length) return null;

  const active = view.filter((j) => j.status === "uploading" || j.status === "queued");
  const failed = view.filter((j) => j.status === "error").length;
  const total = view.reduce((a, j) => a + (j.status === "canceled" ? 0 : j.size), 0);
  const loaded = view.reduce((a, j) => a + (j.status === "canceled" ? 0 : j.loaded), 0);

  return (
    <section aria-label="上传队列" data-leaving={panelOut ? "" : undefined} className="up-panel anim-in fixed right-3 bottom-3 z-40 w-[calc(100vw-1.5rem)] max-w-sm overflow-hidden rounded-xl border border-line bg-panel shadow-pop">
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
          {view.map((j) => {
            const ttlLeft = autoDismiss(j) ? Math.max(0, TTL_MS - (Date.now() - (j.doneAt ?? Date.now()))) : 0;
            return (
              <li key={j.id} data-leaving={leaving.has(j.id) ? "" : undefined} className="up-item flex items-center gap-2 px-3 py-2">
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
                    <>
                      <p className={cx("text-[11px]", j.status === "error" ? "text-danger" : "text-muted")}>
                        {j.status === "done" ? `${fmtSize(j.size)}${j.resumed ? " · 断点续传" : ""}` : j.status === "canceled" ? "已取消" : j.error}
                      </p>
                      {autoDismiss(j) && !leaving.has(j.id) && !panelOut && (
                        <span className="up-ttl" style={{ animationDelay: `-${TTL_MS - ttlLeft}ms` }} />
                      )}
                    </>
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
            );
          })}
        </ul>
      )}
    </section>
  );
}
