// Local favourites (收藏) — kept per browser until a server-side API exists.
import { useSyncExternalStore } from "react";
import type { FsItem } from "./api";

export type Fav = { path: string; name: string; is_dir: boolean };
const KEY = "dh_favs";
let favs: Fav[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
})();
const subs = new Set<() => void>();
const save = (n: Fav[]) => {
  favs = n;
  localStorage.setItem(KEY, JSON.stringify(n));
  subs.forEach((f) => f());
};
export const favorites = {
  get: () => favs,
  subscribe(f: () => void) {
    subs.add(f);
    return () => void subs.delete(f);
  },
  has: (p: string) => favs.some((f) => f.path === p),
  toggle(i: Pick<FsItem, "path" | "name" | "is_dir">) {
    save(favorites.has(i.path) ? favs.filter((f) => f.path !== i.path) : [...favs, { path: i.path, name: i.name, is_dir: i.is_dir }]);
  },
  forget(paths: string[]) {
    const n = favs.filter((f) => !paths.some((x) => f.path === x || f.path.startsWith(x + "/")));
    if (n.length !== favs.length) save(n);
  },
};
export const useFavorites = () => useSyncExternalStore(favorites.subscribe, favorites.get);
