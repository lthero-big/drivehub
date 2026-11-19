// Delayed delete with undo: items disappear immediately, the real DELETE runs when the undo window ends.
// There is no server-side trash yet, so pending deletes are flushed (keepalive) if the page is closed.
// The same machinery backs file deletes (paths) and share deletes (ids): `deferred` is generic,
// `undoableDelete` adds the shared confirm → undo-toast flow used everywhere (DEPTAI-485 r6 #1).
import { authHeaders, call } from "./api";
import { errMsg } from "./util";
import { toast } from "../ui/ui";

type Failed = { key: string; err: string };
type Job = { id: number; keys: string[]; exec: (k: string) => Promise<unknown>; beacon: (k: string) => void; done: (failed: Failed[]) => void };
const pending = new Map<number, Job>();
let seq = 0;

async function run(p: Job) {
  pending.delete(p.id);
  const failed: Failed[] = [];
  for (const k of p.keys) {
    try {
      await p.exec(k);
    } catch (e) {
      failed.push({ key: k, err: errMsg(e) });
    }
  }
  p.done(failed);
}

/** Schedules `exec(key)` for every key; returns commit / undo handles. */
export function deferred(keys: string[], exec: Job["exec"], beacon: Job["beacon"], done: Job["done"]) {
  const p: Job = { id: ++seq, keys, exec, beacon, done };
  pending.set(p.id, p);
  return {
    commit: () => pending.has(p.id) && run(p),
    undo: () => void pending.delete(p.id),
  };
}

const beaconReq = (method: string, url: string, body?: unknown) =>
  fetch(url, { method, keepalive: true, headers: { ...authHeaders(), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });


/** Shared "delete with undo" flow: hide now → undo toast (undo = unhide) (morphs out of the confirm dialog) →
 *  commit when the toast's undo window ends. Used by files and by "我的分享". */
export function undoableDelete<T>(o: {
  items: T[];
  key: (t: T) => string;
  name: (t: T) => string;
  noun?: string;
  hide: (keys: string[]) => void;
  unhide: (keys: string[]) => void;
  exec: (key: string) => Promise<unknown>;
  beacon: (key: string) => void;
  after?: (ok: string[], failed: Failed[]) => unknown;
}) {
  const keys = o.items.map(o.key);
  o.hide(keys);
  const job = deferred(keys, o.exec, o.beacon, (failed) => {
    failed.forEach((f) => toast.err(`${o.name(o.items[keys.indexOf(f.key)])}：${f.err}`));
    const ok = keys.filter((k) => !failed.some((f) => f.key === k));
    // caller reloads, then un-hides (avoids a flash of the deleted rows); default: un-hide now
    if (o.after) Promise.resolve(o.after(ok, failed)).finally(() => o.unhide(keys));
    else o.unhide(keys);
  });
  const text = o.items.length === 1 ? `已删除${o.noun ?? ""}「${o.name(o.items[0])}」` : `已删除 ${o.items.length} ${o.noun ? `个${o.noun}` : "项"}`;
  toast.undo(text, { onUndo: () => (job.undo(), o.unhide(keys)), onCommit: () => job.commit() });
}

export const fsTrash = {
  exec: (path: string) => call("POST", "/api/fs/delete", { path }),
  beacon: (path: string) => void beaconReq("POST", "/api/fs/delete", { path }),
};

export const shareTrash = {
  exec: (id: string) => call("DELETE", `/api/shares/${id}`),
  beacon: (id: string) => void beaconReq("DELETE", `/api/shares/${id}`),
};

window.addEventListener("pagehide", () => {
  for (const p of pending.values()) for (const k of p.keys) p.beacon(k);
  pending.clear();
});
