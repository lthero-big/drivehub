// Personal file / folder tags (DEPTAI-485 r5): tiny store over /api/tags*.
import { useSyncExternalStore } from "react";
import { call } from "./api";

export type Tag = { id: number; name: string; color: string; count?: number };
export const TAG_COLORS = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple", "pink"] as const;
let list: Tag[] = [];
let loaded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const tagStore = {
  get: () => list,
  subscribe(f: () => void) {
    subs.add(f);
    if (!loaded) void tagStore.reload();
    return () => void subs.delete(f);
  },
  async reload() {
    loaded = true;
    try {
      list = await call<Tag[]>("GET", "/api/tags");
    } catch {
      list = [];
    }
    emit();
  },
  create: (name: string, color: string) => call<Tag>("POST", "/api/tags", { name, color }).then((t) => (tagStore.reload(), t)),
  remove: (id: number) => call("DELETE", `/api/tags/${id}`).then(() => tagStore.reload()),
  /** Adds / removes tags on paths; returns path → tags. */
  assign: (paths: string[], b: { add?: number[]; remove?: number[]; add_names?: string[] }) =>
    call<Record<string, Tag[]>>("POST", "/api/tags/assign", { paths, ...b }).then((r) => (tagStore.reload(), r)),
  ofDir: (dir: string) => call<Record<string, Tag[]>>("GET", `/api/tags/of?dir=${encodeURIComponent(dir)}`),
  files: (ids: number[], mode: "any" | "all", under?: string) =>
    call<{ path: string; name: string; tags: Tag[] }[]>("GET", `/api/tags/files?tags=${ids.join(",")}&mode=${mode}${under ? `&under=${encodeURIComponent(under)}` : ""}`),
};
export const useTags = () => useSyncExternalStore(tagStore.subscribe, tagStore.get);
