// Delayed delete with undo: items disappear immediately, the real DELETE runs when the undo window ends.
// There is no server-side trash yet, so pending deletes are flushed (keepalive) if the page is closed.
import { authHeaders, call } from "./api";
import { errMsg } from "./util";

type Pending = { id: number; paths: string[]; done: (failed: { path: string; err: string }[]) => void };
const pending = new Map<number, Pending>();
let seq = 0;

async function run(p: Pending) {
  pending.delete(p.id);
  const failed: { path: string; err: string }[] = [];
  for (const path of p.paths) {
    try {
      await call("POST", "/api/fs/delete", { path });
    } catch (e) {
      failed.push({ path, err: errMsg(e) });
    }
  }
  p.done(failed);
}

export const trash = {
  schedule(paths: string[], done: Pending["done"]) {
    const p = { id: ++seq, paths, done };
    pending.set(p.id, p);
    return {
      commit: () => pending.has(p.id) && run(p),
      undo: () => void pending.delete(p.id),
    };
  },
  isPending: (path: string) => [...pending.values()].some((p) => p.paths.includes(path)),
};

window.addEventListener("pagehide", () => {
  for (const p of pending.values())
    for (const path of p.paths)
      fetch("/api/fs/delete", { method: "POST", keepalive: true, headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ path }) });
  pending.clear();
});
