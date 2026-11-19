// Share (DEPTAI-474) + audit (DEPTAI-475) types and helpers.
export type Share = {
  id: number;
  code: string;
  name: string;
  owner: string;
  owner_id: number | null;
  items: string[];
  perm: "preview" | "download" | "upload";
  pin: string | null;
  has_pin: boolean;
  require_login: boolean;
  expires_at: number | null;
  max_visits: number | null;
  max_downloads: number | null;
  visits: number;
  downloads: number;
  uploads: number;
  bytes: number;
  revoked: boolean;
  status: "active" | "expired" | "exhausted" | "revoked";
  created_at: number;
  last_access: number | null;
  url: string;
  url_with_pin: string | null;
  pickup_code: string;
  direct_url: string | null;
  kind?: "share" | "room";
  allow_upload?: boolean;
  allow_download?: boolean;
  max_uploads?: number | null;
  max_bytes?: number | null;
  up_bytes?: number;
  room_url?: string | null;
  stats?: { by_action: { action: string; count: number }[]; unique_ips: number; recent: AuditEvent[] };
};

export type AuditEvent = {
  id: number;
  ts: number;
  time: string;
  user_id: number | null;
  username: string;
  ip: string;
  ua: string;
  client: string;
  channel: string;
  action: string;
  path: string;
  storage: string;
  allowed: boolean;
  bytes: number;
  share_id: number | null;
  detail: string;
  hash: string;
};

export const PERM_NAMES: Record<string, string> = { preview: "仅预览", download: "可下载", upload: "可上传（收集文件）" };
export const STATUS_NAMES: Record<string, string> = { active: "有效", expired: "已过期", exhausted: "次数用尽", revoked: "已失效" };

/** Absolute URL for a share-relative link returned by the server. */
export const abs = (u: string) => (u.startsWith("http") ? u : location.origin + u);

export async function qrDataUrl(text: string): Promise<string> {
  const QR = await import("qrcode");
  return QR.toDataURL(text, { margin: 1, width: 200 });
}

export function copy(text: string) {
  return navigator.clipboard?.writeText(text);
}
