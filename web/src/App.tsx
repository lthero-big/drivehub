import { useEffect, useState } from "react";
import { api, WEB_VERSION, type Compat, type VersionInfo } from "./api";

type Health = { status: string; db: boolean };

export default function App() {
  const [ver, setVer] = useState<VersionInfo | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [compat, setCompat] = useState<Compat | null>(null);

  useEffect(() => {
    fetch("/api/version").then((r) => r.json()).then(setVer).catch(() => setVer(null));
    api<Health>("/api/v1/health").then(setHealth).catch((e) => setCompat(e as Compat));
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-8">
      <div className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        <h1 className="text-2xl font-semibold">DriveHub</h1>
        <p className="mt-1 text-sm text-neutral-400">多网盘管理 · M0 脚手架</p>
        {compat && compat.status !== "ok" && (
          <div className="mt-4 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-300">
            {compat.status === "client_too_old" && `Web 版本过旧，请升级到 ${compat.min_version} 以上`}
            {compat.status === "server_too_old" && "服务端版本过旧，请升级服务端"}
            {compat.status === "invalid" && `版本号无效：${compat.reason}`}
          </div>
        )}
        <dl className="mt-6 grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-neutral-400">Web</dt><dd>{WEB_VERSION}</dd>
          <dt className="text-neutral-400">Server</dt><dd>{ver?.server_version ?? "…"}</dd>
          <dt className="text-neutral-400">API</dt><dd>{ver ? `v${ver.api_version}` : "…"}</dd>
          <dt className="text-neutral-400">健康</dt>
          <dd>{health ? `${health.status} / db ${health.db ? "ok" : "down"}` : "…"}</dd>
        </dl>
      </div>
    </main>
  );
}
