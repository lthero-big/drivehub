// Upload queue: concurrency-limited, per-file progress, cancel/retry, and resumable chunked
// sessions for large files (resume survives reloads via localStorage + server offset).
import { useSyncExternalStore } from "react";
import { ApiError, authHeaders, call, refreshTokens, tokens, type UploadSession } from "./api";

export type UpStatus = "queued" | "uploading" | "done" | "error" | "canceled";
export type UpJob = {
  id: number;
  file: File;
  path: string;
  size: number;
  loaded: number;
  status: UpStatus;
  error?: string;
  resumed?: boolean;
  xhr?: XMLHttpRequest;
  session?: string;
};

const SINGLE_MAX = 8 << 20;
let concurrency = 3;
let jobs: UpJob[] = [];
let seq = 0;
const subs = new Set<() => void>();
const doneSubs = new Set<(path: string) => void>();
let snapshot: UpJob[] = [];

function emit() {
  snapshot = jobs.map((j) => ({ ...j }));
  subs.forEach((s) => s());
}
const patch = (j: UpJob, p: Partial<UpJob>) => {
  Object.assign(j, p);
  emit();
};

export const uploads = {
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
  get: () => snapshot,
  onDone(f: (path: string) => void) {
    doneSubs.add(f);
    return () => void doneSubs.delete(f);
  },
  setConcurrency(n: number) {
    concurrency = Math.max(1, Math.min(8, n));
    pump();
  },
  add(items: { file: File; path: string }[]) {
    for (const it of items) jobs.push({ id: ++seq, file: it.file, path: it.path, size: it.file.size, loaded: 0, status: "queued" });
    emit();
    pump();
  },
  cancel(id: number) {
    const j = jobs.find((x) => x.id === id);
    if (!j || j.status === "done") return;
    j.xhr?.abort();
    if (j.session) {
      call("DELETE", `/api/fs/uploads/${j.session}`).catch(() => {});
      localStorage.removeItem(resumeKey(j));
    }
    patch(j, { status: "canceled", xhr: undefined });
    pump();
  },
  retry(id: number) {
    const j = jobs.find((x) => x.id === id);
    if (!j || (j.status !== "error" && j.status !== "canceled")) return;
    patch(j, { status: "queued", error: undefined });
    pump();
  },
  clearFinished() {
    jobs = jobs.filter((j) => j.status === "queued" || j.status === "uploading" || j.status === "error");
    emit();
  },
  cancelAll() {
    jobs.filter((j) => j.status === "queued" || j.status === "uploading").forEach((j) => uploads.cancel(j.id));
  },
};

export function useUploads() {
  return useSyncExternalStore(uploads.subscribe, uploads.get);
}

const resumeKey = (j: UpJob) => `dh_up:${j.path}|${j.size}|${j.file.lastModified}`;

function pump() {
  const running = jobs.filter((j) => j.status === "uploading").length;
  const next = jobs.filter((j) => j.status === "queued").slice(0, Math.max(0, concurrency - running));
  for (const j of next) {
    patch(j, { status: "uploading", loaded: 0 });
    run(j)
      .then(() => {
        patch(j, { status: "done", loaded: j.size, xhr: undefined });
        doneSubs.forEach((f) => f(j.path));
      })
      .catch((e: unknown) => {
        if (j.status === "canceled") return;
        patch(j, { status: "error", error: e instanceof Error ? e.message : String(e), xhr: undefined });
      })
      .finally(pump);
  }
}

/** PUT a body with upload progress; refreshes the token once on 401. */
function xhrPut(j: UpJob, url: string, body: Blob, base: number): Promise<any> {
  const once = () =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const x = new XMLHttpRequest();
      j.xhr = x;
      x.open("PUT", url);
      for (const [k, v] of Object.entries(authHeaders())) x.setRequestHeader(k, v);
      x.setRequestHeader("content-type", "application/octet-stream");
      x.upload.onprogress = (e) => patch(j, { loaded: base + e.loaded });
      x.onload = () => {
        let b: any = {};
        try {
          b = JSON.parse(x.responseText);
        } catch {
          /* empty */
        }
        resolve({ status: x.status, body: b });
      };
      x.onerror = () => reject(new Error("网络错误"));
      x.onabort = () => reject(new Error("已取消"));
      x.send(body);
    });
  return once().then(async (r) => {
    if (r.status === 401 && tokens.get() && (await refreshTokens())) r = await once();
    if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, r.body);
    return r.body;
  });
}

async function run(j: UpJob) {
  const enc = encodeURIComponent;
  if (j.size <= SINGLE_MAX) {
    await xhrPut(j, `/api/fs/upload?path=${enc(j.path)}&overwrite=true`, j.file, 0);
    return;
  }
  const key = resumeKey(j);
  let s: UploadSession | null = null;
  const saved = localStorage.getItem(key);
  if (saved) {
    s = await call<UploadSession>("GET", `/api/fs/uploads/${saved}`).catch(() => null);
    if (s) patch(j, { resumed: s.offset > 0 });
  }
  if (!s) {
    s = await call<UploadSession>("POST", "/api/fs/uploads", { path: j.path, size: j.size, overwrite: true });
    localStorage.setItem(key, s.id);
  }
  j.session = s.id;
  let off = s.offset;
  const chunk = s.chunk_size || 8 << 20;
  while (off < j.size) {
    if (j.status === "canceled") throw new Error("已取消");
    const end = Math.min(j.size, off + chunk);
    try {
      const r: UploadSession = await xhrPut(j, `/api/fs/uploads/${s.id}?offset=${off}`, j.file.slice(off, end), off);
      off = r.offset;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        off = (await call<UploadSession>("GET", `/api/fs/uploads/${s.id}`)).offset;
        continue;
      }
      throw e;
    }
    patch(j, { loaded: off });
  }
  await call("POST", `/api/fs/uploads/${s.id}/complete`);
  localStorage.removeItem(key);
}

/** Expands a drop (files and folders) into upload items under `dir`. */
export async function fromDataTransfer(dt: DataTransfer, dir: string): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];
  const base = dir.replace(/\/+$/, "");
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[];
  if (!entries.length) {
    for (const f of Array.from(dt.files)) out.push({ file: f, path: `${base}/${f.name}` });
    return out;
  }
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push({ file: f, path: `${base}/${prefix}${f.name}` });
    } else if (e.isDirectory) {
      const r = (e as FileSystemDirectoryEntry).createReader();
      let batch: FileSystemEntry[];
      do {
        batch = await new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej));
        for (const c of batch) await walk(c, `${prefix}${e.name}/`);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

export function fromFileList(list: FileList, dir: string) {
  const base = dir.replace(/\/+$/, "");
  return Array.from(list).map((f) => ({ file: f, path: `${base}/${(f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name}` }));
}
