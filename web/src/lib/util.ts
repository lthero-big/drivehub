export function fmtSize(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function fmtTime(unix: number | null | undefined): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff >= 0 && diff < 60) return "刚刚";
  if (diff >= 0 && diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff >= 0 && diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
};

export type Kind = "folder" | "image" | "video" | "audio" | "pdf" | "markdown" | "code" | "text" | "archive" | "office" | "other";

const KINDS: [Kind, string[]][] = [
  ["image", ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "ico", "svg"]],
  ["video", ["mp4", "m4v", "webm", "mov", "mkv", "m3u8"]],
  ["audio", ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"]],
  ["pdf", ["pdf"]],
  ["markdown", ["md", "markdown"]],
  ["code", ["rs", "go", "py", "js", "ts", "tsx", "jsx", "java", "kt", "c", "h", "cpp", "hpp", "cs", "sh", "sql", "css", "vue", "rb", "php", "swift", "lua", "json", "toml", "yaml", "yml", "xml", "html", "htm", "ini", "conf"]],
  ["text", ["txt", "log", "csv", "tsv", "srt", "vtt"]],
  ["archive", ["zip", "rar", "7z", "tar", "gz", "tgz", "xz", "bz2"]],
  ["office", ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"]],
];
const BY_EXT = new Map<string, Kind>();
for (const [k, list] of KINDS) for (const e of list) BY_EXT.set(e, k);

export function kindOf(name: string, isDir = false): Kind {
  if (isDir) return "folder";
  return BY_EXT.get(ext(name)) ?? "other";
}

export const KIND_LABEL: Record<Kind, string> = {
  folder: "文件夹",
  image: "图片",
  video: "视频",
  audio: "音频",
  pdf: "PDF",
  markdown: "Markdown",
  code: "代码",
  text: "文本",
  archive: "压缩包",
  office: "Office",
  other: "文件",
};

export const extsOf = (k: Kind) => KINDS.find(([x]) => x === k)?.[1] ?? [];

export function joinPath(dir: string, name: string) {
  return `${dir.replace(/\/+$/, "")}/${name}`.replace(/^\/+/, "/");
}

export function parentOf(path: string) {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function baseName(path: string) {
  const p = path.replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1) || "/";
}

export function cx(...a: (string | false | null | undefined)[]) {
  return a.filter(Boolean).join(" ");
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    "login required": "需要登录",
    "admin only": "仅管理员可用",
    "file exists": "文件已存在",
    "is a directory": "这是一个文件夹",
    "bad credentials": "用户名或密码错误",
    "bad totp": "两步验证码不正确",
  };
  for (const [k, v] of Object.entries(map)) if (m.startsWith(k)) return v;
  if (m.startsWith("permission denied")) return `没有权限（${m.replace("permission denied: ", "")}）`;
  return m;
}
