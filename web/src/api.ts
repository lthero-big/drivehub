export const WEB_VERSION = __WEB_VERSION__;
export const API_MAJOR = 1;

export type VersionInfo = {
  server_version: string;
  api_version: number;
  min_app_version: string;
  min_web_version: string;
};

export type Compat =
  | { status: "ok" }
  | { status: "client_too_old"; min_version: string }
  | { status: "server_too_old"; server_api_version: number }
  | { status: "invalid"; reason: string };

const CLIENT_HEADERS = { "x-drivehub-client": `web/${WEB_VERSION}`, "x-drivehub-api": String(API_MAJOR) };

/** Every API call carries the client identity so the server can answer 426 on mismatch. */
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: CLIENT_HEADERS });
  if (res.status === 426 || res.status === 400) throw (await res.json()) as Compat;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ---- M2 auth -------------------------------------------------------------

export type Tokens = { access_token: string; refresh_token: string };

export const tokens = {
  get(): Tokens | null {
    const s = localStorage.getItem("dh_tokens");
    return s ? (JSON.parse(s) as Tokens) : null;
  },
  set(t: Tokens | null) {
    if (t) localStorage.setItem("dh_tokens", JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token }));
    else localStorage.removeItem("dh_tokens");
  },
};

export class ApiError extends Error {
  constructor(public status: number, public body: Record<string, unknown>) {
    super(String(body.error ?? status));
  }
}

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  const t = tokens.get();
  return fetch(path, {
    method,
    headers: {
      ...CLIENT_HEADERS,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(t ? { authorization: `Bearer ${t.access_token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** JSON call with bearer token; transparently refreshes once on 401. */
export async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await raw(method, path, body);
  const t = tokens.get();
  if (res.status === 401 && t && !path.startsWith("/api/auth/refresh")) {
    const r = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: t.refresh_token }),
    });
    if (r.ok) {
      tokens.set(await r.json());
      res = await raw(method, path, body);
    } else tokens.set(null);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}
