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

/** Every API call carries the client identity so the server can answer 426 on mismatch. */
export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { "x-drivehub-client": `web/${WEB_VERSION}`, "x-drivehub-api": String(API_MAJOR) },
  });
  if (res.status === 426 || res.status === 400) throw (await res.json()) as Compat;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}
