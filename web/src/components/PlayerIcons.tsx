// Stylised app badges for external players (not the official logos; recognisable colour + glyph).
import type { ReactNode } from "react";

const Box = ({ bg, children, size = 28 }: { bg: string; children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
    <rect width="32" height="32" rx="8" fill={bg} />
    {children}
  </svg>
);

export const PLAYER_ICONS: Record<string, (p: { size?: number }) => ReactNode> = {
  VLC: ({ size }) => (
    <Box bg="#ff8800" size={size}>
      <path d="M16 6l7 17H9z" fill="#fff" />
      <path d="M13.2 13h5.6M11.6 18h8.8" stroke="#ff8800" strokeWidth="2" />
      <path d="M7 24h18l-1.6 3H8.6z" fill="#fff" opacity=".9" />
    </Box>
  ),
  PotPlayer: ({ size }) => (
    <Box bg="#25272e" size={size}>
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="#ffd23f" strokeWidth="2" />
      <path d="M13.5 11.5v9l8-4.5z" fill="#ffd23f" />
    </Box>
  ),
  IINA: ({ size }) => (
    <Box bg="#7b3fe4" size={size}>
      <circle cx="16" cy="16" r="9" fill="#fff" opacity=".18" />
      <path d="M13 10.5v11l9-5.5z" fill="#fff" />
      <circle cx="9" cy="23" r="1.6" fill="#ff7bd0" />
    </Box>
  ),
  "MX Player": ({ size }) => (
    <Box bg="#1b6dff" size={size}>
      <path d="M10 11.5l6 4.5-6 4.5z" fill="#fff" />
      <path d="M17 11.5h5m-5 9h5M17 11.5l5 9m0-9l-5 9" stroke="#fff" strokeWidth="1.6" fill="none" opacity=".0" />
      <text x="17" y="21" fontSize="9" fontWeight="800" fill="#fff" fontFamily="sans-serif">MX</text>
    </Box>
  ),
  nPlayer: ({ size }) => (
    <Box bg="#111" size={size}>
      <text x="8.5" y="22.5" fontSize="17" fontWeight="800" fill="#fff" fontFamily="sans-serif">n</text>
      <path d="M21 11v10l6-5z" fill="#33d17a" />
    </Box>
  ),
  Infuse: ({ size }) => (
    <Box bg="#ff5a1f" size={size}>
      <path d="M16 6c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-4 3-6 1 1 1.5 2 2 2 1-2 1-5 1-8z" fill="#fff" />
      <path d="M16 15c.6 2 3 3 3 5.4a3 3 0 0 1-6 0c0-1.6 1.6-2.6 3-5.4z" fill="#ff5a1f" opacity=".85" />
    </Box>
  ),
};

export function externalPlayers(absUrl: string) {
  const u = absUrl;
  const noProto = u.replace(/^https?:\/\//, "");
  return [
    { name: "VLC", href: `vlc://${u}`, tip: "用 VLC 打开（Windows/macOS/Linux/iOS）" },
    { name: "PotPlayer", href: `potplayer://${u}`, tip: "用 PotPlayer 打开（Windows）" },
    { name: "IINA", href: `iina://weblink?url=${encodeURIComponent(u)}`, tip: "用 IINA 打开（macOS）" },
    { name: "MX Player", href: `intent:${u}#Intent;package=com.mxtech.videoplayer.ad;type=video/*;end`, tip: "用 MX Player 打开（Android）" },
    { name: "nPlayer", href: `${u.startsWith("https") ? "nplayer-https" : "nplayer-http"}://${noProto}`, tip: "用 nPlayer 打开（iOS/Android）" },
    { name: "Infuse", href: `infuse://x-callback-url/play?url=${encodeURIComponent(u)}`, tip: "用 Infuse 打开（iOS/macOS/tvOS）" },
  ];
}

export function ExternalPlayers({ url, className }: { url: string; className?: string }) {
  const abs = new URL(url, location.href).toString();
  return (
    <div className={className ?? "flex flex-wrap items-center gap-2 text-[13px] text-muted"} data-testid="external-players">
      <span>外部播放器</span>
      {externalPlayers(abs).map((p) => {
        const Icon = PLAYER_ICONS[p.name];
        return (
          <a key={p.name} href={p.href} title={p.tip} aria-label={p.name} className="group relative grid size-9 place-items-center rounded-xl border border-line bg-panel transition hover:-translate-y-0.5 hover:shadow-card active:scale-95">
            <Icon size={26} />
            <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded-md bg-fg px-1.5 py-0.5 text-[11px] whitespace-nowrap text-bg group-hover:block">{p.name}</span>
          </a>
        );
      })}
    </div>
  );
}
