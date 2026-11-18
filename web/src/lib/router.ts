import { useEffect, useState } from "react";

/** Hash routes: #/files/<path>, #/search?q=, #/admin/<tab>, #/account, #/tasks … */
export type Route = { name: string; rest: string; q: URLSearchParams };

export function parse(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const qi = h.indexOf("?");
  const pathPart = qi >= 0 ? h.slice(0, qi) : h;
  const q = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : "");
  const [name, ...rest] = pathPart.split("/");
  return { name: name || "files", rest: decodeURIComponent(rest.join("/")), q };
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const f = () => setR(parse());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return r;
}

export const go = (h: string) => {
  location.hash = h;
};

export const filesHref = (path: string) =>
  "#/files" + (path === "/" ? "" : path.split("/").map(encodeURIComponent).join("/"));
