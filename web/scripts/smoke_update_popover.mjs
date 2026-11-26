#!/usr/bin/env node
/**
 * RHEA-276 smoke & visual verification for the top-left brand update trigger & UpdatePopover.
 * Zero external dependencies: uses Node 22 built-in http/WebSocket + headless Google Chrome CDP.
 *
 * Usage:
 *   node scripts/smoke_update_popover.mjs
 *   SHOTS=/path/to/shots node scripts/smoke_update_popover.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist");
const SHOTS = process.env.SHOTS ? path.resolve(process.env.SHOTS) : "";
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

if (!fs.existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/index.html not found. Run `npm run build` first.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Controllable mock backend state
const mock = {
  role: "admin",
  serverVersion: "0.1.0",
  latestVersion: "0.1.1",
  updateAvailable: true,
  deployment: "binary",
  canAutoInstall: true,
  checkEnabled: true,
  offline: false,
  status: {
    state: "idle",
    from_version: null,
    target_version: null,
    progress_bytes: 0,
    total_bytes: 0,
    message: "",
    error: null,
    actor: "",
    started_at: 0,
    updated_at: 0,
    commands: [],
    log: [],
  },
  requests: [],
};

function makeOverview() {
  return {
    current_version: mock.serverVersion,
    status: { ...mock.status },
    last_check: {
      checked_at: Math.floor(Date.now() / 1000) - 120,
      source_url: "https://github.com/lthero-big/drivehub/releases/latest/download/release-manifest.json",
      channel: "stable",
      latest: {
        version: mock.latestVersion,
        channel: "stable",
        api_version: 1,
        min_client_version: "0.1.0",
        released_at: "2026-11-23T08:30:00Z",
        notes: "## 0.1.1 Highlights\n- 左上角品牌图标更新角标与一键更新弹窗\n- Android 端 PikPak 风格深色 UI 升级\n- 修复若干同步与稳定性问题",
        artifacts: [
          {
            kind: "server",
            platform: "linux-x86_64",
            url: "drivehub-linux-x86_64",
            sha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            size: 26214400,
          },
          {
            kind: "docker",
            platform: "",
            url: "",
            sha256: "",
            size: 0,
            image: "ghcr.io/lthero-big/drivehub:0.1.1",
          },
        ],
      },
      update_available: mock.updateAvailable,
      key_id: "ed25519:prod-2026",
      error: null,
    },
    settings: {
      auto_check: true,
      mode: "notify",
      source_url: "",
      channel: "",
      interval_secs: 21600,
      window_start: "",
      window_end: "",
      notify_webhook: "",
      notify_email: "",
    },
    effective: {
      check_enabled: mock.checkEnabled,
      source_url: "https://github.com/lthero-big/drivehub/releases/latest/download/release-manifest.json",
      channel: "stable",
      interval_secs: 21600,
      deployment: mock.deployment,
      platform: "linux-x86_64",
      exe_path: mock.deployment === "binary" ? "/root/Project/drivehub/target/release/drivehub" : null,
      restart: "exit",
      docker_socket: null,
      can_auto_install: mock.canAutoInstall,
      trusted_key_ids: ["ed25519:prod-2026"],
      db_backups: [],
    },
  };
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-drivehub-server-version": mock.serverVersion,
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  if (p.startsWith("/api/")) {
    mock.requests.push(`${req.method} ${p}`);
    if (mock.offline && (p === "/api/version" || p.startsWith("/api/admin/update"))) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "restarting" }));
      return;
    }
    if (p === "/api/v1/health") return json(res, 200, { status: "ok", db: true });
    if (p === "/api/version") {
      return json(res, 200, {
        server_version: mock.serverVersion,
        api_version: 1,
        min_client_version: "0.1.0",
        latest: mock.latestVersion,
        update_available: mock.updateAvailable,
        web_build: null,
      });
    }
    if (p === "/api/auth/status") {
      return json(res, 200, {
        initialized: true,
        open_registration: false,
        require_email_verification: false,
        mail_transport: "log",
        oauth_providers: [],
        me: {
          id: mock.role === "admin" ? 1 : 2,
          username: mock.role === "admin" ? "admin" : "alice",
          email: mock.role === "admin" ? "admin@example.com" : "alice@example.com",
          role: mock.role,
          disabled: false,
          email_verified: true,
          totp_enabled: false,
          root_path: "/",
          visible_mounts: null,
          quota_bytes: null,
          used_bytes: 0,
          created_at: 1700000000,
          has_password: true,
          groups: [],
          roles: [],
          caps: [],
          identities: [],
        },
      });
    }
    if (p === "/api/fs/list") {
      return json(res, 200, {
        path: u.searchParams.get("path") || "/",
        total: 2,
        items: [
          { name: "local", path: "/local", is_dir: true, size: 0, modified: 1763900000, mount_kind: "fs" },
          { name: "pikpak", path: "/pikpak", is_dir: true, size: 0, modified: 1763900000, mount_kind: "pikpak" },
        ],
        permissions: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "delete"],
      });
    }
    if (p === "/api/tags") return json(res, 200, []);
    if (p === "/api/admin/settings") return json(res, 200, { open_registration: false, require_email_verification: false });
    if (p === "/api/admin/update/status") {
      if (mock.role !== "admin") return json(res, 403, { error: "admin only" });
      return json(res, 200, makeOverview());
    }
    if (p === "/api/admin/update/check" && req.method === "POST") {
      if (mock.role !== "admin") return json(res, 403, { error: "admin only" });
      return json(res, 200, makeOverview());
    }
    if (p === "/api/admin/update/apply" && req.method === "POST") {
      if (mock.role !== "admin") return json(res, 403, { error: "admin only" });
      mock.status = {
        ...mock.status,
        state: "downloading",
        from_version: mock.serverVersion,
        target_version: mock.latestVersion,
        progress_bytes: 13107200,
        total_bytes: 26214400,
        message: "正在下载 drivehub-linux-x86_64",
        error: null,
      };
      return json(res, 202, makeOverview());
    }
    return json(res, 200, {});
  }

  const filePath = path.join(DIST, p === "/" ? "index.html" : p);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    fs.createReadStream(path.join(DIST, "index.html")).pipe(res);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.errors.push(`pageerror: ${msg.params.exceptionDetails.text}`);
      } else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        const t = msg.params.entry.text || "";
        if (!t.includes("503")) this.errors.push(`console: ${t}`);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const res = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  }
  async waitFor(expr, timeout = 8000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = await this.eval(expr);
      if (v) return v;
      await sleep(120);
    }
    throw new Error(`Timeout waiting for: ${expr}`);
  }
  async screenshot(name) {
    if (!SHOTS) return;
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  }
}

const fails = [];
function check(name, cond, detail = "") {
  if (!cond) fails.push(`${name}${detail ? ` (${detail})` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

const chromeBin = process.env.CHROME_BIN || "google-chrome";
const cdpPort = 9222 + Math.floor(Math.random() * 400);
const userDataDir = fs.mkdtempSync("/tmp/dh-rhea276-chrome-");
const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  let target = null;
  for (let i = 0; i < 50; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === "page");
      if (target) break;
    } catch {}
    await sleep(150);
  }
  if (!target) throw new Error("Failed to connect to headless Chrome CDP");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });

  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1360,
    height: 860,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // --- Scenario 1: Admin + Update Available + Expanded Sidebar ---
  await cdp.send("Page.navigate", { url: `${baseUrl}/#/files` });
  await cdp.waitFor(`!!document.querySelector('[data-update-trigger]')`);
  await cdp.waitFor(`document.querySelector('[data-version-pill="available"]')?.textContent?.includes('v0.1.1')`);

  const triggerInfo = await cdp.eval(`(() => {
    const btn = document.querySelector('[data-update-trigger]');
    const dot = btn.querySelector('[data-update-indicator="available"]');
    const pill = btn.querySelector('[data-version-pill="available"]');
    return { dot: !!dot, pill: pill?.textContent?.trim() };
  })()`);
  check("1a expanded trigger shows breathing update dot & v0.1.1 ↑ pill", triggerInfo.dot && triggerInfo.pill === "v0.1.1 ↑", JSON.stringify(triggerInfo));

  await cdp.eval(`document.querySelector('[data-update-trigger]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-popover]')`);
  await sleep(260);

  const pop1 = await cdp.eval(`(() => {
    const pop = document.querySelector('[data-update-popover]');
    const r = pop.getBoundingClientRect();
    return {
      inBody: pop.parentElement === document.body,
      width: Math.round(r.width),
      left: Math.round(r.left),
      right: Math.round(r.right),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vw: window.innerWidth,
      vh: window.innerHeight,
      text: pop.textContent,
      hasCheck: !!pop.querySelector('[data-update-check]'),
      hasApply: !!pop.querySelector('[data-update-apply]'),
      hasLink: !!pop.querySelector('[data-update-settings-link]'),
    };
  })()`);
  check("1b popover portaled to body & unclipped in viewport", pop1.inBody && pop1.left >= 0 && pop1.right <= pop1.vw && pop1.width >= 300, `${pop1.width}px @ (${pop1.left},${pop1.top})`);
  check("1c popover shows version compare, notes, check, apply, and settings link", pop1.text.includes("v0.1.0") && pop1.text.includes("v0.1.1") && pop1.text.includes("2026-11-23") && pop1.hasCheck && pop1.hasApply && pop1.hasLink);
  await cdp.screenshot("01-expanded-update-available");

  // Escape closes popover and restores focus to trigger
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await cdp.waitFor(`!document.querySelector('[data-update-popover]')`);
  const focusRestored = await cdp.eval(`document.activeElement === document.querySelector('[data-update-trigger]')`);
  check("1d Escape closes popover & restores focus to trigger", focusRestored);

  // --- Scenario 2: Collapsed (mini) sidebar ---
  await cdp.eval(`document.querySelector('[data-sidebar-toggle]').click()`);
  await sleep(360);
  await cdp.eval(`document.querySelector('[data-update-trigger]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-popover]')`);
  await sleep(260);
  const popMini = await cdp.eval(`(() => {
    const trig = document.querySelector('[data-update-trigger]').getBoundingClientRect();
    const pop = document.querySelector('[data-update-popover]').getBoundingClientRect();
    const aside = document.querySelector('aside[aria-label="侧栏"]').getBoundingClientRect();
    return { asideW: Math.round(aside.width), trigR: Math.round(trig.right), popL: Math.round(pop.left), popW: Math.round(pop.width), popR: Math.round(pop.right), vw: window.innerWidth };
  })()`);
  check("2 collapsed mini sidebar opens popover cleanly to the right without clipping", popMini.asideW <= 72 && popMini.popL >= popMini.trigR && popMini.popR <= popMini.vw && popMini.popW >= 300, JSON.stringify(popMini));
  await cdp.screenshot("02-collapsed-mini-popover");

  // Expand sidebar again
  await cdp.eval(`document.querySelector('[data-update-trigger]').click()`);
  await cdp.eval(`document.querySelector('[data-sidebar-toggle]').click()`);
  await sleep(360);

  // --- Scenario 3: Check + Confirm + Downloading + Restart Poll + Upgraded ---
  await cdp.eval(`document.querySelector('[data-update-trigger]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-popover]')`);
  const checkBefore = mock.requests.filter((r) => r === "POST /api/admin/update/check").length;
  await cdp.eval(`document.querySelector('[data-update-check]').click()`);
  await sleep(250);
  const checkAfter = mock.requests.filter((r) => r === "POST /api/admin/update/check").length;
  check("3a check button calls POST /api/admin/update/check", checkAfter === checkBefore + 1);

  // Arm confirmation, press Escape to disarm without closing popover, then arm & confirm
  await cdp.eval(`document.querySelector('[data-update-apply]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-confirm]')`);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await sleep(120);
  const disarmedKeptOpen = await cdp.eval(`!!document.querySelector('[data-update-popover]') && !document.querySelector('[data-update-confirm]') && !!document.querySelector('[data-update-apply]')`);
  check("3b Escape disarms inline confirmation without closing popover", disarmedKeptOpen);

  await cdp.eval(`document.querySelector('[data-update-apply]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-confirm]')`);
  await cdp.eval(`document.querySelector('[data-update-confirm]').click()`);
  await cdp.waitFor(`document.querySelector('[data-update-popover]')?.textContent?.includes('50%')`);
  await sleep(200);
  const progInfo = await cdp.eval(`({
    runningIcon: !!document.querySelector('[data-update-indicator="running"]'),
    pill: document.querySelector('[data-version-pill="running"]')?.textContent?.trim(),
    popText: document.querySelector('[data-update-popover]')?.textContent
  })`);
  check("3c apply shows in-progress trigger indicator & 50% download progress", progInfo.runningIcon && progInfo.pill === "50%" && progInfo.popText.includes("50%"), JSON.stringify({ runningIcon: progInfo.runningIcon, pill: progInfo.pill }));
  await cdp.screenshot("03-updating-progress");

  // Simulate restarting & offline period, verifying /api/version is polled
  mock.status.state = "restarting";
  mock.status.message = "restarting into 0.1.1";
  mock.offline = true;
  const verCountBeforeRestart = mock.requests.filter((r) => r === "GET /api/version").length;
  await cdp.waitFor(`document.querySelector('[data-update-popover]')?.textContent?.includes('重启重连中')`, 4000);
  await sleep(1250);
  const verCountDuringRestart = mock.requests.filter((r) => r === "GET /api/version").length;
  const offlineText = await cdp.eval(`document.querySelector('[data-update-popover]')?.textContent || ''`);
  check("3d during restart/offline polls /api/version & shows reconnecting state", verCountDuringRestart > verCountBeforeRestart && offlineText.includes("重启重连中"), `verPolls=${verCountDuringRestart - verCountBeforeRestart}`);

  // Server comes back on 0.1.1
  mock.offline = false;
  mock.serverVersion = "0.1.1";
  mock.updateAvailable = false;
  mock.status = { ...mock.status, state: "succeeded", message: "updated to 0.1.1" };
  await cdp.waitFor(`!!document.querySelector('[data-update-reload]')`, 6000);
  await sleep(250);
  const reloadText = await cdp.eval(`document.querySelector('[data-update-reload]')?.textContent?.trim()`);
  check("3e transitions to '已更新，点击刷新' button after server recovers on new version", reloadText?.includes("v0.1.1") && reloadText?.includes("刷新"), reloadText);
  await cdp.screenshot("04-upgraded-ready-refresh");

  // --- Scenario 3f: Navigate to #/admin/update and verify shared store deduplication ---
  const statusReqsBeforeNav = mock.requests.filter((r) => r === "GET /api/admin/update/status").length;
  await cdp.eval(`document.querySelector('[data-update-settings-link]').click()`);
  await cdp.waitFor(`location.hash === '#/admin/update' && document.body.textContent.includes('更新设置')`, 5000);
  await sleep(400);
  const statusReqsAfterNav = mock.requests.filter((r) => r === "GET /api/admin/update/status").length;
  const updatePageShowsUpgraded = await cdp.eval(`document.body.textContent.includes('服务端已更新到 0.1.1')`);
  check("3f navigating to #/admin/update reuses cached store without redundant status fetch", statusReqsAfterNav === statusReqsBeforeNav && updatePageShowsUpgraded, `extraFetches=${statusReqsAfterNav - statusReqsBeforeNav}`);

  // --- Scenario 4: Dark mode expanded popover (with update available) ---
  mock.serverVersion = "0.1.0";
  mock.updateAvailable = true;
  mock.status = { state: "idle", from_version: null, target_version: null, progress_bytes: 0, total_bytes: 0, message: "", error: null, actor: "", started_at: 0, updated_at: 0, commands: [], log: [] };
  await cdp.eval(`localStorage.setItem('dh_theme', 'dark')`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor(`!!document.querySelector('[data-update-trigger]')`);
  await cdp.waitFor(`document.querySelector('[data-version-pill="available"]')?.textContent?.includes('v0.1.1')`);
  await cdp.eval(`document.querySelector('[data-update-trigger]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-popover]')`);
  await sleep(260);
  await cdp.screenshot("05-dark-mode-popover");

  // --- Scenario 5: Docker without socket fallback ---
  mock.deployment = "docker";
  mock.canAutoInstall = false;
  await cdp.eval(`localStorage.setItem('dh_theme', 'light')`);
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor(`!!document.querySelector('[data-update-trigger]')`);
  await cdp.eval(`document.querySelector('[data-update-trigger]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-copy-docker]')`);
  await sleep(260);
  const dockerInfo = await cdp.eval(`(() => {
    const pop = document.querySelector('[data-update-popover]');
    return {
      hasCopy: !!pop.querySelector('[data-update-copy-docker]'),
      hasApply: !!pop.querySelector('[data-update-apply]'),
      hasCmd: pop.textContent.includes('docker compose pull && docker compose up -d'),
      hasLink: !!pop.querySelector('[data-update-settings-link]'),
    };
  })()`);
  check("5 docker (no socket) shows host copyable command & no auto-install button", dockerInfo.hasCopy && !dockerInfo.hasApply && dockerInfo.hasCmd && dockerInfo.hasLink, JSON.stringify(dockerInfo));
  await cdp.screenshot("06-docker-manual-popover");

  // --- Scenario 6: Non-admin user (0 admin API calls + stale refresh button) ---
  mock.role = "user";
  mock.deployment = "binary";
  mock.canAutoInstall = true;
  mock.serverVersion = "0.1.0";
  mock.updateAvailable = true;
  mock.requests.length = 0;
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor(`!!document.querySelector('[data-update-trigger]')`);
  await sleep(400);
  await cdp.eval(`document.querySelector('[data-update-trigger]').click()`);
  await cdp.waitFor(`!!document.querySelector('[data-update-popover]')`);
  await sleep(250);
  const nonAdminIdle = await cdp.eval(`(() => {
    const trig = document.querySelector('[data-update-trigger]');
    const pop = document.querySelector('[data-update-popover]');
    return {
      redDot: !!trig.querySelector('[data-update-indicator="available"]'),
      pill: trig.querySelector('[data-version-pill]')?.textContent?.trim(),
      hasCheck: !!pop.querySelector('[data-update-check]'),
      hasApply: !!pop.querySelector('[data-update-apply]'),
      hasLink: !!pop.querySelector('[data-update-settings-link]'),
      hasReload: !!pop.querySelector('[data-update-reload]'),
      text: pop.textContent,
    };
  })()`);
  const adminReqs = mock.requests.filter((r) => r.includes("/api/admin/update"));
  check("6a non-admin makes ZERO /api/admin/update/* requests", adminReqs.length === 0, `adminReqs=${adminReqs.length}`);
  check("6b non-admin hides red dot, check/apply buttons & admin link", !nonAdminIdle.redDot && nonAdminIdle.pill === "v0.1.0" && !nonAdminIdle.hasCheck && !nonAdminIdle.hasApply && !nonAdminIdle.hasLink && !nonAdminIdle.hasReload);

  // Now simulate server upgrade behind the non-admin user's open tab
  mock.serverVersion = "0.1.1";
  mock.updateAvailable = false;
  await cdp.eval(`window.dispatchEvent(new Event('focus'))`);
  await cdp.waitFor(`!!document.querySelector('[data-update-reload]')`, 5000);
  await sleep(200);
  const nonAdminStaleText = await cdp.eval(`document.querySelector('[data-update-reload]')?.textContent?.trim()`);
  check("6c non-admin sees '刷新加载新版本' when server upgrades (v.stale === true)", nonAdminStaleText === "刷新加载新版本", nonAdminStaleText);
  await cdp.screenshot("07-non-admin-stale");

  check("7 zero unexpected console/page errors", cdp.errors.length === 0, cdp.errors.join("; "));
  ws.close();
} finally {
  chrome.kill("SIGKILL");
  await new Promise((r) => chrome.once("exit", r)).catch(() => {});
  server.close();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

if (fails.length) {
  console.error("\nFAILED CHECKS:\n" + fails.map((f) => " - " + f).join("\n"));
  process.exit(1);
}
console.log("\nALL SMOKE CHECKS PASSED!");
