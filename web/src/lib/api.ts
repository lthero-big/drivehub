// Typed API client generated from api/openapi.json (`npm run gen:api`) + auth plumbing.
import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "../gen/openapi";

export type Schemas = components["schemas"];
export type FsItem = Schemas["FsItem"];
export type ListResp = Schemas["ListResp"];
export type SearchHit = Schemas["SearchHitDto"];
export type TaskInfo = Schemas["TaskInfo"];
export type MountConfig = Schemas["MountConfig"];
export type VersionInfo = Schemas["VersionInfo"];
export type UploadSession = Schemas["UploadSession"];

export const WEB_VERSION = __WEB_VERSION__;
export const API_MAJOR = 1;
export const CLIENT_HEADERS: Record<string, string> = {
  "x-drivehub-client": `web/${WEB_VERSION}`,
  "x-drivehub-api": String(API_MAJOR),
};

export type Tokens = { access_token: string; refresh_token: string };
type Listener = () => void;
const listeners = new Set<Listener>();

export const tokens = {
  get(): Tokens | null {
    try {
      const s = localStorage.getItem("dh_tokens");
      return s ? (JSON.parse(s) as Tokens) : null;
    } catch {
      return null;
    }
  },
  set(t: Tokens | null) {
    if (t) localStorage.setItem("dh_tokens", JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token }));
    else localStorage.removeItem("dh_tokens");
    listeners.forEach((l) => l());
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
};

/** Password for password-gated directories, remembered per session. */
export const pathPassword = {
  get: () => sessionStorage.getItem("dh_path_pw") ?? "",
  set: (v: string) => (v ? sessionStorage.setItem("dh_path_pw", v) : sessionStorage.removeItem("dh_path_pw")),
};

export class ApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body?.error ?? `HTTP ${status}`));
  }
}

let refreshing: Promise<boolean> | null = null;
/** Single-flight refresh of the access token. */
export function refreshTokens(): Promise<boolean> {
  const t = tokens.get();
  if (!t) return Promise.resolve(false);
  refreshing ??= fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", ...CLIENT_HEADERS },
    body: JSON.stringify({ refresh_token: t.refresh_token }),
  })
    .then(async (r) => {
      if (r.ok) {
        tokens.set(await r.json());
        return true;
      }
      if (r.status === 401) tokens.set(null);
      return false;
    })
    .catch(() => false)
    .finally(() => (refreshing = null));
  return refreshing;
}

function authHeaders(): Record<string, string> {
  const t = tokens.get();
  const pw = pathPassword.get();
  return {
    ...CLIENT_HEADERS,
    ...(t ? { authorization: `Bearer ${t.access_token}` } : {}),
    ...(pw && /^[\x20-\x7e]+$/.test(pw) ? { "x-drivehub-path-password": pw } : {}),
  };
}

const retries = new WeakMap<Request, Request>();
const auth: Middleware = {
  onRequest({ request }) {
    for (const [k, v] of Object.entries(authHeaders())) request.headers.set(k, v);
    if (!request.url.includes("/api/auth/refresh")) retries.set(request, request.clone());
    return request;
  },
  async onResponse({ request, response }) {
    const again = retries.get(request);
    if (response.status === 401 && again && tokens.get() && (await refreshTokens())) {
      for (const [k, v] of Object.entries(authHeaders())) again.headers.set(k, v);
      return fetch(again);
    }
    return response;
  },
};

export const client = createClient<paths>({ baseUrl: "" });
client.use(auth);

/** Unwraps an openapi-fetch result, throwing ApiError on non-2xx. */
export async function ok<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (!response.ok) throw new ApiError(response.status, (error as Record<string, unknown>) ?? {});
  return data as T;
}

/** Untyped JSON call for endpoints whose responses are not described in the contract. */
export async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const go = () =>
    fetch(path, {
      method,
      headers: { ...authHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  let res = await go();
  if (res.status === 401 && tokens.get() && !path.startsWith("/api/auth/refresh") && (await refreshTokens())) res = await go();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** URL usable in <img>/<video>/<a> (token in query, since tags cannot send headers). */
export function fileUrl(path: string, opts: { download?: boolean } = {}): string {
  const q = new URLSearchParams({ path });
  const t = tokens.get();
  if (t) q.set("access_token", t.access_token);
  const pw = pathPassword.get();
  if (pw) q.set("path_password", pw);
  if (opts.download) q.set("dl", "1");
  else q.set("preview", "true");
  return `/api/fs/download?${q}`;
}

export function zipUrl(paths: string[], name: string): string {
  const q = new URLSearchParams({ paths: paths.join("\n"), name });
  const t = tokens.get();
  if (t) q.set("access_token", t.access_token);
  const pw = pathPassword.get();
  if (pw) q.set("path_password", pw);
  return `/api/fs/zip?${q}`;
}

/** Raw authed fetch (Range reads for archive preview, text preview). */
export async function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const go = () => fetch(url, { ...init, headers: { ...authHeaders(), ...(init.headers as Record<string, string>) } });
  let r = await go();
  if (r.status === 401 && tokens.get() && (await refreshTokens())) r = await go();
  return r;
}

export { authHeaders };

// ---- domain types for endpoints without response schemas ------------------

export type Me = {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user" | "guest";
  disabled: boolean;
  email_verified: boolean;
  totp_enabled: boolean;
  root_path: string;
  visible_mounts: string[] | null;
  quota_bytes: number | null;
  used_bytes: number;
  created_at: number;
  has_password: boolean;
  groups: { id: number; name: string }[];
  roles?: { id: number; name: string }[];
  caps?: string[];
  identities: string[];
};
export type AuthStatus = Omit<Schemas["AuthStatus"], "me"> & { me: Me | null };
export type Role = { id: number; name: string; description: string; permissions: string[]; builtin: boolean; created_at: number; users: number; groups: number };
export type Group = { id: number; name: string; members: number; member_list?: { id: number; username: string }[]; roles?: { id: number; name: string }[] };
export type RoleBody = Schemas["RoleBody"];
export type PatchGroupBody = Schemas["PatchGroupBody"];
/** RBAC (roles / groups) — typed against api/openapi.json request bodies. */
export const rbac = {
  roles: () => call<Role[]>("GET", "/api/admin/roles"),
  createRole: (b: RoleBody) => call<Role>("POST", "/api/admin/roles", b),
  updateRole: (id: number, b: RoleBody) => call<Role>("PATCH", `/api/admin/roles/${id}`, b),
  deleteRole: (id: number) => call("DELETE", `/api/admin/roles/${id}`),
  groups: () => call<Group[]>("GET", "/api/admin/groups"),
  createGroup: (name: string) => call<Group>("POST", "/api/admin/groups", { name }),
  updateGroup: (id: number, b: PatchGroupBody) => call<Group>("PATCH", `/api/admin/groups/${id}`, b),
  deleteGroup: (id: number) => call("DELETE", `/api/admin/groups/${id}`),
};
export type Rule = { id: number; path: string; subject: string; subject_id: number | null; allow: string[]; deny: string[] };
export type Gate = { path: string; modes: string[]; has_password: boolean };
export type AuditRow = { id: number; ts: number; user_id: number | null; username: string; channel: string; action: string; path: string; allowed: boolean; detail: string };
export type Effective = {
  path: string;
  real_path: string;
  user_id: number | null;
  username: string;
  permissions: string[];
  bits: number;
  reason: string;
  gate: { path: string; modes: string[]; passed: boolean } | null;
  trace: { path: string; subject: string; subject_id: number | null; allow: string[]; deny: string[]; after: string[] }[];
};
// Categorized permission catalog (DEPTAI-485 r5) — mirrors drivehub_core::acl::PERM_CATALOG
// (also served by GET /api/acl/catalog). `global` ones only take effect at the root / via roles.
export type PermDef = { name: string; category: "file" | "share" | "tag" | "admin"; label: string; hint: string; global?: boolean };
export const PERM_CATEGORIES: { id: PermDef["category"]; label: string }[] = [
  { id: "file", label: "文件" },
  { id: "share", label: "分享" },
  { id: "tag", label: "标签" },
  { id: "admin", label: "管理后台" },
];
export const PERM_CATALOG: PermDef[] = [
  { name: "read", category: "file", label: "浏览", hint: "列目录、预览、查看属性" },
  { name: "download", category: "file", label: "下载", hint: "下载文件与打包下载" },
  { name: "upload", category: "file", label: "上传", hint: "上传新文件到目录" },
  { name: "create", category: "file", label: "新建", hint: "新建文件夹" },
  { name: "edit", category: "file", label: "编辑", hint: "在线编辑、覆盖保存" },
  { name: "rename", category: "file", label: "重命名", hint: "重命名文件与文件夹" },
  { name: "move", category: "file", label: "移动", hint: "移动到其他目录（含拖拽）" },
  { name: "copy", category: "file", label: "复制", hint: "复制到其他目录" },
  { name: "delete", category: "file", label: "删除", hint: "删除文件与文件夹" },
  { name: "share", category: "share", label: "创建分享", hint: "创建预览 / 下载分享链接" },
  { name: "share_upload", category: "share", label: "收集分享", hint: "创建可上传的文件夹分享" },
  { name: "share_manage", category: "share", label: "管理全部分享", hint: "查看 / 停用所有人的分享", global: true },
  { name: "tag", category: "tag", label: "打标签", hint: "给文件与文件夹添加标签" },
  { name: "admin_users", category: "admin", label: "用户", hint: "创建、编辑、禁用普通用户", global: true },
  { name: "admin_groups", category: "admin", label: "用户组", hint: "管理用户组与成员", global: true },
  { name: "admin_roles", category: "admin", label: "角色", hint: "管理角色（不能授予自己没有的管理权限）", global: true },
  { name: "admin_acl", category: "admin", label: "目录权限", hint: "管理目录规则与访问门槛", global: true },
  { name: "admin_mounts", category: "admin", label: "挂载点", hint: "管理存储挂载与重建索引", global: true },
  { name: "admin_audit", category: "admin", label: "审计", hint: "查看审计日志与全部访问统计", global: true },
  { name: "admin_settings", category: "admin", label: "系统设置", hint: "修改后台设置", global: true },
];
export const PERMS = PERM_CATALOG.map((p) => p.name);
/** Per-path permissions (meaningful on any directory). */
export const PATH_PERMS = PERM_CATALOG.filter((p) => !p.global).map((p) => p.name);
export const PERM_LABEL: Record<string, string> = Object.fromEntries(PERM_CATALOG.map((p) => [p.name, p.label]));
export const PERM_HINT: Record<string, string> = Object.fromEntries(PERM_CATALOG.map((p) => [p.name, p.hint]));
export const permsOf = (cat: string, names = PERMS) => PERM_CATALOG.filter((p) => p.category === cat && names.includes(p.name)).map((p) => p.name);
