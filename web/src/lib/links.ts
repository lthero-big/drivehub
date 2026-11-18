import { filesHref } from "./router";

const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
/** In-app deep link (needs the viewer to have access); files open as an editor tab via ?open=. */
export function appLink(i: { path: string; is_dir: boolean }): string {
  const base = location.origin + location.pathname;
  return i.is_dir ? base + filesHref(i.path) : `${base}${filesHref(parentOf(i.path))}?open=${encodeURIComponent(i.path)}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
