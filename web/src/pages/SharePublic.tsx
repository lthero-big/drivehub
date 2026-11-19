import { useEffect, useRef, useState } from "react";
import { Download, Eye, File, Folder, KeyRound, Link2, Upload } from "lucide-react";
import { CLIENT_HEADERS, tokens } from "../lib/api";
import { abs, copy, PERM_NAMES } from "../lib/shares";
import { errMsg, fmtSize, fmtTime } from "../lib/util";
import { Button, Card, Empty, Input, Spinner, toast } from "../ui/ui";

type Item = { name: string; path: string; is_dir: boolean; size: number; modified_unix: number | null };
type Opened = { id: number; name: string; owner: string; perm: string; expires_at: number | null; items: Item[]; token: string; visits_left: number | null; downloads_left: number | null; kind?: string; allow_download?: boolean; allow_upload?: boolean; uploads_left?: number | null; bytes_left?: number | null };

function headers(): Record<string, string> {
  const t = tokens.get();
  return { ...CLIENT_HEADERS, ...(t ? { authorization: `Bearer ${t.access_token}` } : {}) };
}

async function getJson(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { ...headers(), ...(init.headers as Record<string, string>) } });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, body };
}

/** Pickup-code box (home page / login page): `<code>` or `<code>-<pin>`. */
export function PickupBox({ compact }: { compact?: boolean }) {
  const [v, setV] = useState("");
  const go = () => {
    const raw = v.trim().replace(/^.*\/s\//, "").replace(/\s+/, "-");
    if (raw) location.href = `/s/${encodeURIComponent(raw).replace(/%2D/gi, "-")}`;
  };
  return (
    <form className={compact ? "flex gap-1.5" : "mx-auto flex max-w-sm gap-2 pb-8"} onSubmit={(e) => (e.preventDefault(), go())}>
      <Input ctl={compact ? "sm" : "md"} className={compact ? "w-44" : ""} placeholder="输入取件码领取分享" value={v} onChange={(e) => setV(e.target.value)} aria-label="取件码" />
      <Button type="submit" size={compact ? "sm" : "md"}><KeyRound className="size-4" /> 领取</Button>
    </form>
  );
}

/** Visitor page for `/s/<code>[-<pin>][?pin=]`. */
export function SharePublicPage() {
  const raw = decodeURIComponent(location.pathname.replace(/^\/s\//, "").replace(/\/$/, ""));
  const qpin = new URLSearchParams(location.search).get("pin") ?? "";
  const code = raw.split("-")[0];
  const [state, setState] = useState<"loading" | "pin" | "error" | "open">("loading");
  const [err, setErr] = useState("");
  const [needCaptcha, setNeedCaptcha] = useState(false);
  const [captcha, setCaptcha] = useState<{ id: string; svg: string } | null>(null);
  const [pin, setPin] = useState("");
  const [answer, setAnswer] = useState("");
  const [share, setShare] = useState<Opened | null>(null);
  const [dir, setDir] = useState("/");
  const [list, setList] = useState<Item[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const open = async (p?: string) => {
    const q = new URLSearchParams();
    if (p) q.set("pin", p);
    if (captcha) (q.set("captcha_id", captcha.id), q.set("captcha", answer));
    const r = await getJson(`/api/s/${encodeURIComponent(p ? code : raw)}?${q}`);
    if (r.ok) {
      setShare(r.body);
      setList(r.body.items);
      setState("open");
      // drop room: go straight into the room folder
      if (r.body.kind === "room" && r.body.items[0]?.is_dir) {
        const d = r.body.items[0].path;
        const l = await getJson(`/api/s/${code}/list?${new URLSearchParams({ path: d, t: r.body.token })}`);
        if (l.ok) (setDir(d), setList(l.body.items));
      }
      return;
    }
    if (r.body.need_pin) {
      setState("pin");
      if (r.body.error === "wrong pin") setErr("提取码错误");
      else if (r.body.error === "captcha required") setErr("请输入验证码");
      else setErr("");
      setNeedCaptcha(!!r.body.need_captcha);
      if (r.body.need_captcha) loadCaptcha();
      return;
    }
    setState("error");
    setErr(r.body.need_login ? "该分享需要登录后访问" : r.status === 410 ? "分享已过期或已失效" : r.status === 429 ? "尝试次数过多，请稍后再试" : r.body.error ?? `错误 ${r.status}`);
  };
  const loadCaptcha = async () => {
    const r = await getJson("/api/s/captcha");
    setCaptcha(r.body);
    setAnswer("");
  };
  useEffect(() => void open(qpin || undefined), []); // eslint-disable-line react-hooks/exhaustive-deps

  const browse = async (d: string) => {
    if (!share) return;
    setDir(d);
    if (d === "/") return setList(share.items);
    const r = await getJson(`/api/s/${code}/list?${new URLSearchParams({ path: d, t: share.token })}`);
    if (r.ok) setList(r.body.items);
    else toast.err(r.body.error ?? "加载失败");
  };
  const url = (i: Item, inline: boolean) =>
    `/api/s/${code}/download?${new URLSearchParams({ path: i.path, t: share!.token, ...(inline ? { inline: "true" } : {}) })}`;
  const direct = async (i: Item) => {
    const r = await getJson(`/api/s/${code}/direct?${new URLSearchParams({ path: i.path, t: share!.token })}`);
    if (r.ok) (copy(abs(r.body.url)), toast.ok("直链已复制"));
    else toast.err(r.body.error ?? "失败");
  };
  const upload = async (files: FileList) => {
    for (const f of Array.from(files)) {
      const target = dir === "/" ? f.name : `${dir}/${f.name}`;
      const r = await fetch(`/api/s/${code}/upload?${new URLSearchParams({ path: target, t: share!.token })}`, { method: "PUT", headers: headers(), body: f });
      if (r.ok) toast.ok(`已上传 ${f.name}`);
      else toast.err(`${f.name}: ${(await r.json().catch(() => ({}))).error ?? r.status}`);
    }
    browse(dir === "/" ? `/${share!.items[0]?.name}` : dir);
  };
  const room = share?.kind === "room";
  const canDl = share ? share.perm !== "preview" && share.allow_download !== false : false;
  const roomDir = room && share ? share.items[0]?.path : null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-8">
      <h1 className="text-lg font-semibold"><a href="/">DriveHub</a> · {room ? "快传房间" : "分享"}</h1>
      {state === "loading" && <div className="flex justify-center py-16"><Spinner /></div>}
      {state === "error" && <Empty title={err}><a className="text-accent underline" href="/">返回首页</a></Empty>}
      {state === "pin" && (
        <Card title="请输入提取码">
          <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), open(pin))}>
            <Input autoFocus placeholder="提取码" value={pin} onChange={(e) => setPin(e.target.value)} aria-label="提取码" />
            {needCaptcha && captcha && (
              <div className="flex items-center gap-2">
                <button type="button" title="换一张" onClick={loadCaptcha} dangerouslySetInnerHTML={{ __html: captcha.svg }} />
                <Input placeholder="验证码答案" value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label="验证码" />
              </div>
            )}
            {err && <p className="text-[13px] text-danger">{err}</p>}
            <Button variant="primary" type="submit">提取文件</Button>
          </form>
        </Card>
      )}
      {state === "open" && share && (
        <Card
          title={<span>{share.name} <span className="text-xs font-normal text-muted">来自 {share.owner} · {room ? [share.allow_upload ? "可上传" : null, share.allow_download !== false ? "可下载" : "不可下载", share.uploads_left != null ? `剩余 ${share.uploads_left} 个文件` : null, share.bytes_left != null ? `剩余 ${fmtSize(share.bytes_left)}` : null].filter(Boolean).join(" · ") : PERM_NAMES[share.perm]}{share.expires_at ? ` · ${fmtTime(share.expires_at)} 到期` : ""}</span></span>}
          actions={share.perm === "upload" && <><Button size="sm" onClick={() => fileInput.current?.click()}><Upload className="size-4" /> 上传文件</Button><input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files).catch((x) => toast.err(errMsg(x)))} /></>}
        >
          {dir !== "/" && dir !== roomDir && (
            <button className="mb-2 text-[13px] text-accent underline" onClick={() => browse(dir.split("/").slice(0, -1).join("/") || "/")}>← 返回上级 ({dir})</button>
          )}
          {!list ? <Spinner /> : list.length === 0 ? <Empty title="空文件夹" /> : (
            <ul className="divide-y divide-line text-[13px]">
              {list.map((i) => (
                <li key={i.path} className="flex items-center gap-2 py-1.5">
                  {i.is_dir ? <Folder className="size-4 text-accent" /> : <File className="size-4 text-muted" />}
                  {i.is_dir ? <button className="flex-1 truncate text-left hover:underline" onClick={() => browse(i.path)}>{i.name}</button> : <span className="flex-1 truncate">{i.name}</span>}
                  <span className="text-xs text-muted tabular-nums">{i.is_dir ? "" : fmtSize(i.size)}</span>
                  {!i.is_dir && (
                    <>
                      {share.allow_download !== false && <a className="p-1" title="预览" href={url(i, true)} target="_blank" rel="noreferrer"><Eye className="size-4" /></a>}
                      {canDl && <a className="p-1" title="下载" href={url(i, false)}><Download className="size-4" /></a>}
                      {canDl && <button className="p-1" title="复制直链" onClick={() => direct(i)}><Link2 className="size-4" /></button>}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(share.downloads_left !== null || share.visits_left !== null) && (
            <p className="mt-3 text-xs text-muted">{share.visits_left !== null && `剩余访问 ${share.visits_left} 次 `}{share.downloads_left !== null && `剩余下载 ${share.downloads_left} 次`}</p>
          )}
        </Card>
      )}
    </div>
  );
}
