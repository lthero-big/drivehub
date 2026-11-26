#!/usr/bin/env node
/**
 * RHEA-278 smoke & visual verification for refactored Mounts, Roles, ACL & Sidebar
 * across Paper / Bento / Swiss skins and Light / Dark modes.
 *
 * Usage:
 *   node scripts/smoke_admin_redesign.mjs
 *   SHOTS=/path/to/shots node scripts/smoke_admin_redesign.mjs
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

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-drivehub-server-version": "0.1.1",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const state = {
  mounts: [
    { name: "本地归档", kind: "fs", options: { root: "/srv/files/archive" }, read_only: false, hidden: false, enabled: true, sort_order: 1, transfer_mode: "auto" },
    { name: "PikPak 影音", kind: "pikpak", options: { username: "lthero@example.com", password: "***", refresh_token: "***", device_id: "9a3f8c21d0e4b172" }, read_only: false, hidden: false, enabled: true, sort_order: 2, transfer_mode: "proxy" },
    { name: "115 云盘", kind: "p115", options: { cookie: "***", root_id: "281947102", page_size: "1000" }, read_only: true, hidden: false, enabled: true, sort_order: 3, transfer_mode: "direct" },
    { name: "对象存储 R2", kind: "s3", options: { bucket: "drivehub-media", endpoint: "https://r2.cloudflarestorage.com", region: "auto", access_key_id: "AKIA***", secret_access_key: "***" }, read_only: false, hidden: false, enabled: true, sort_order: 4, transfer_mode: "direct" },
    { name: "OpenList 桥接", kind: "webdav", options: { endpoint: "http://127.0.0.1:8471/dav/media", username: "admin", password: "***" }, read_only: false, hidden: true, enabled: false, sort_order: 5, transfer_mode: "proxy" },
  ],
  roles: [
    { id: 1, name: "admin", description: "系统内置管理员，拥有全部文件与管理后台权限", builtin: true, level: "admin", permissions: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "delete", "share", "share_upload", "share_manage", "tag", "admin_users", "admin_groups", "admin_roles", "admin_acl", "admin_mounts", "admin_audit", "admin_settings"], users: 2, groups: 1 },
    { id: 2, name: "user", description: "默认普通成员角色，可读写文件、打标签与创建分享", builtin: true, level: "user", permissions: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "delete", "share", "share_upload", "tag"], users: 8, groups: 2 },
    { id: 3, name: "guest", description: "只读访客，仅可浏览和下载公开目录", builtin: true, level: "guest", permissions: ["read", "download"], users: 3, groups: 1 },
    { id: 4, name: "媒体协作者", description: "影音与设计素材上传、整理和外链分享", builtin: false, level: "user", permissions: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "share", "tag"], users: 4, groups: 1 },
    { id: 5, name: "存储运维", description: "管理存储挂载点与查看审计日志", builtin: false, level: "user", permissions: ["read", "download", "admin_mounts", "admin_audit"], users: 1, groups: 0 },
  ],
  rules: [
    { id: 10, path: "/", subject: "logged_in", subject_id: null, allow: ["read", "download"], deny: [] },
    { id: 11, path: "/本地归档", subject: "group", subject_id: 1, allow: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "tag"], deny: [] },
    { id: 12, path: "/本地归档", subject: "user", subject_id: 2, allow: ["read", "download"], deny: ["delete"] },
  ],
  gates: [{ path: "/本地归档", modes: ["logged_in"], has_password: false }],
  lastMountPost: null,
  reindexCalls: 0,
  deletedMounts: [],
  nextRoleId: 6,
  nextRuleId: 20,
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  if (p.startsWith("/api/")) {
    if (p === "/api/v1/health") return json(res, 200, { status: "ok", db: true });
    if (p === "/api/version") return json(res, 200, { server_version: "0.1.1", api_version: 1, min_client_version: "0.1.0", latest: "0.1.1", update_available: false, web_build: null });
    if (p === "/api/auth/status") {
      return json(res, 200, {
        initialized: true,
        open_registration: false,
        require_email_verification: false,
        mail_transport: "smtp",
        oauth_providers: [],
        me: { id: 1, username: "admin", email: "admin@example.com", role: "admin", disabled: false, email_verified: true, totp_enabled: true, root_path: "/", visible_mounts: null, quota_bytes: null, used_bytes: 0, created_at: 1700000000, has_password: true, groups: [{ id: 1, name: "核心团队" }], roles: [], caps: [], identities: [] },
      });
    }
    if (p === "/api/fs/list") {
      return json(res, 200, {
        path: "/",
        total: 4,
        items: state.mounts
          .filter((m) => m.enabled !== false && !m.hidden)
          .map((m) => ({ name: m.name, path: `/${m.name}`, is_dir: true, size: 0, modified_unix: 1763900000, mount_kind: m.kind })),
        permissions: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "delete", "share", "tag"],
      });
    }
    if (p === "/api/mounts" && req.method === "GET") return json(res, 200, state.mounts);
    if (p === "/api/mounts" && req.method === "POST") {
      const body = await readBody(req);
      state.lastMountPost = body;
      const idx = state.mounts.findIndex((m) => m.name === body.name);
      if (idx >= 0) state.mounts[idx] = { ...state.mounts[idx], ...body };
      else state.mounts.push(body);
      return json(res, 200, body);
    }
    if (p.startsWith("/api/mounts/") && req.method === "DELETE") {
      const name = decodeURIComponent(p.slice("/api/mounts/".length));
      state.deletedMounts.push(name);
      state.mounts = state.mounts.filter((m) => m.name !== name);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/search/reindex" && req.method === "POST") {
      state.reindexCalls++;
      return json(res, 200, { files: 128 });
    }
    if (p === "/api/admin/roles" && req.method === "GET") return json(res, 200, state.roles);
    if (p === "/api/admin/roles" && req.method === "POST") {
      const body = await readBody(req);
      const role = { id: state.nextRoleId++, name: body.name, description: body.description || "", permissions: body.permissions || [], builtin: false, level: "user", users: 0, groups: 0, created_at: 1763900000 };
      state.roles.push(role);
      return json(res, 200, role);
    }
    if (p.startsWith("/api/admin/roles/") && req.method === "PATCH") {
      const id = Number(p.split("/").pop());
      const body = await readBody(req);
      const r = state.roles.find((x) => x.id === id);
      if (r) Object.assign(r, body);
      return json(res, 200, r || {});
    }
    if (p === "/api/acl/rules" && req.method === "GET") return json(res, 200, state.rules);
    if (p === "/api/acl/rules" && req.method === "POST") {
      const body = await readBody(req);
      const rule = { id: state.nextRuleId++, ...body };
      state.rules.push(rule);
      return json(res, 200, rule);
    }
    if (p.startsWith("/api/acl/rules/") && req.method === "DELETE") {
      const id = Number(p.split("/").pop());
      state.rules = state.rules.filter((x) => x.id !== id);
      return json(res, 200, { ok: true });
    }
    if (p === "/api/acl/gates") return json(res, 200, state.gates);
    if (p === "/api/admin/users") {
      return json(res, 200, [
        { id: 1, username: "admin", role: "admin", groups: [{ id: 1, name: "核心团队" }] },
        { id: 2, username: "alice", role: "user", groups: [{ id: 1, name: "核心团队" }] },
      ]);
    }
    if (p === "/api/admin/groups") return json(res, 200, [{ id: 1, name: "核心团队", members: 2 }]);
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
function assert(cond, label, detail = "") {
  if (!cond) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    throw new Error(`Assertion failed: ${label}`);
  }
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
}

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
        this.errors.push(`console: ${msg.params.entry.text || ""}`);
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
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval error");
    return r.result.value;
  }
  async waitFor(fnExpr, timeout = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(`Boolean(${fnExpr})`)) return;
      await sleep(50);
    }
    throw new Error(`Timeout waiting for: ${fnExpr}`);
  }
  async click(selector) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`Element not found: ${selector}`);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  }
  async setInput(selector, value) {
    await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Input not found: ' + ${JSON.stringify(selector)});
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      desc.set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  }
  async shot(name) {
    if (!SHOTS) return;
    await sleep(180);
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  }
}

const chromePath = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error("No Chrome/Chromium binary found.");
  process.exit(1);
}

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const userDataDir = fs.mkdtempSync("/tmp/dh-rhea278-chrome-");
const chrome = spawn(
  chromePath,
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "--window-size=1360,860", "about:blank"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let cdp;
try {
  const wsBase = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout:\n${stderr}`)), 15000);
    chrome.stderr.on("data", (d) => {
      stderr += d.toString();
      const m = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const targets = await (await fetch(`http://127.0.0.1:${new URL(wsBase).port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 860, deviceScaleFactor: 2, mobile: false });

  async function openView(hash, skin = "paper", theme = "light") {
    await cdp.send("Page.navigate", { url: `${baseUrl}/${hash}` });
    await sleep(300);
    await cdp.eval(`localStorage.setItem('dh_skin', ${JSON.stringify(skin)}); localStorage.setItem('dh_theme', ${JSON.stringify(theme)});`);
    await cdp.send("Page.reload");
    await sleep(450);
  }

  // 1. Mounts Page — Paper Light & visual/credential checks
  await openView("#/admin/mounts", "paper", "light");
  await cdp.waitFor(`document.querySelector('[data-testid="mount-list"] [data-mount-card]')`);
  const mountCheck = await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-mount-card]'));
    const txt = cards.map(c => c.textContent).join('\\n');
    const icons = cards.map(c => {
      const ic = c.querySelector('[data-provider-icon]');
      return { kind: ic?.dataset.providerIcon, w: ic ? Math.round(ic.getBoundingClientRect().width) : 0 };
    });
    const navMounts = Array.from(document.querySelectorAll('[data-nav-mount-icon]')).map(e => e.dataset.navMountIcon);
    return {
      count: cards.length,
      hasRawStars: txt.includes('***'),
      hasRawSecretKeys: /\\b(password|refresh_token|device_id|secret_access_key|cookie)\\b/i.test(txt),
      icons,
      navMounts,
    };
  })()`);
  assert(mountCheck.count === 5, "1a 5 mount cards rendered", JSON.stringify(mountCheck.icons));
  assert(!mountCheck.hasRawStars && !mountCheck.hasRawSecretKeys, "1b zero raw credentials or *** exposed on mount cards");
  assert(mountCheck.icons.every((i) => i.w === 44), "1c every mount card has 44px branded ProviderIcon", JSON.stringify(mountCheck.icons));
  assert(mountCheck.navMounts.length >= 4, "1d sidebar renders branded mount badges", JSON.stringify(mountCheck.navMounts));
  await cdp.shot("after-mounts-paper-light");

  // Capture Paper Dark, Bento Light, Swiss Dark for Mounts
  await openView("#/admin/mounts", "paper", "dark");
  await cdp.waitFor(`document.querySelector('[data-mount-card]')`);
  await cdp.shot("after-mounts-paper-dark");

  await openView("#/admin/mounts", "bento", "light");
  await cdp.waitFor(`document.querySelector('[data-mount-card]')`);
  await cdp.shot("after-mounts-bento-light");

  await openView("#/admin/mounts", "swiss", "dark");
  await cdp.waitFor(`document.querySelector('[data-mount-card]')`);
  await cdp.shot("after-mounts-swiss-dark");

  // Return to Paper Light for interactive modal & CRUD checks
  await openView("#/admin/mounts", "paper", "light");
  await cdp.waitFor(`document.querySelector('[data-mount-card]')`);

  // Open Create Mount modal -> select PikPak -> verify Basic vs collapsed Advanced
  await cdp.eval(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('添加存储')).click()`);
  await cdp.waitFor(`document.querySelector('[data-mount-kind-opt="pikpak"]')`);
  await cdp.click('[data-mount-kind-opt="pikpak"]');
  await sleep(180);
  const pikpakState = await cdp.eval(`(() => {
    const disc = document.querySelector('[role="dialog"] [data-disclosure]');
    return {
      hasUser: Boolean(document.querySelector('input[name="mount-opt-username"]')),
      hasPass: Boolean(document.querySelector('input[name="mount-opt-password"]')),
      advCollapsed: disc?.dataset.open === 'false',
    };
  })()`);
  assert(pikpakState.hasUser && pikpakState.hasPass && pikpakState.advCollapsed, "1f PikPak form separates Basic fields and collapses Advanced options", JSON.stringify(pikpakState));
  await cdp.click('[role="dialog"] [data-disclosure-trigger]');
  await sleep(260);
  const advOpen = await cdp.eval(`document.querySelector('[role="dialog"] [data-disclosure]')?.dataset.open === 'true' && Boolean(document.querySelector('input[name="mount-opt-device_id"]'))`);
  assert(advOpen, "1g PikPak Advanced options expand cleanly (device_id / root_id / tokens)");
  await cdp.eval(`document.querySelector('[role="dialog"] .scroll-thin')?.scrollTo(0, 0)`);
  await sleep(120);
  await cdp.shot("after-mounts-modal-pikpak-paper-light");

  // Switch to 115 -> verify 4-field assembly into cookie
  await cdp.click('[data-mount-kind-opt="p115"]');
  await sleep(150);
  await cdp.setInput('input[name="mount-display-name"]', "115测试");
  await cdp.setInput('input[name="mount-opt-uid"]', "u1");
  await cdp.setInput('input[name="mount-opt-cid"]', "c2");
  await cdp.setInput('input[name="mount-opt-seid"]', "s3");
  await cdp.setInput('input[name="mount-opt-kid"]', "k4");
  await cdp.eval(`document.querySelector('[role="dialog"] footer button.btn-primary').click()`);
  await sleep(300);
  assert(
    state.lastMountPost?.name === "115测试" && state.lastMountPost?.options?.cookie === "UID=u1; CID=c2; SEID=s3; KID=k4",
    "1h 115 4-field split/assemble saves exact cookie contract",
    JSON.stringify(state.lastMountPost?.options),
  );

  // Reindex button
  await cdp.eval(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('重建索引')).click()`);
  await sleep(250);
  assert(state.reindexCalls === 1, "1e reindex action triggers POST /api/search/reindex");

  // Edit existing 115 mount leaving 4 fields blank -> keeps cookie "***"
  await cdp.eval(`document.querySelector('[data-mount-card="115 云盘"] button[aria-label^="编辑"]').click()`);
  await cdp.waitFor(`document.querySelector('input[name="mount-opt-uid"]')`);
  await cdp.eval(`document.querySelector('[role="dialog"] footer button.btn-primary').click()`);
  await sleep(300);
  assert(
    state.lastMountPost?.name === "115 云盘" && state.lastMountPost?.options?.cookie === "***",
    "1i editing 115 mount with blank credential fields preserves cookie='***'",
    JSON.stringify(state.lastMountPost?.options),
  );

  // Toggle switch on existing mount
  await cdp.click('[data-mount-card="OpenList 桥接"] input[role="switch"]');
  await sleep(300);
  assert(state.mounts.find((m) => m.name === "OpenList 桥接")?.enabled === true, "1j quick enable switch toggles mount state");

  // Delete created mount via ConfirmButton
  await cdp.click('[data-mount-card="115测试"] button[aria-label^="删除挂载点"]');
  await sleep(150);
  await cdp.click('[data-mount-card="115测试"] button[data-confirm]');
  await sleep(300);
  assert(state.deletedMounts.includes("115测试"), "1k delete mount confirm flow works");

  // 2. Roles Page — Paper Light & Dark + upgraded PermMatrix modal
  await openView("#/admin/roles", "paper", "light");
  await cdp.waitFor(`document.querySelector('[data-testid="role-list"] li[data-role="admin"]')`);
  const rolesCheck = await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="role-list"] li[data-role]'));
    const builtin = cards.filter(c => c.dataset.roleBuiltin === 'true').length;
    const custom = cards.filter(c => c.dataset.roleBuiltin === 'false').length;
    const catsPerCard = cards.map(c => c.querySelectorAll('[data-role-cat]').length);
    const icons = cards.map(c => c.querySelector('[data-provider-icon]')?.dataset.providerIcon);
    const okBadges = document.querySelectorAll('[data-testid="role-list"] [class*="bg-ok/"]').length;
    return { total: cards.length, builtin, custom, catsPerCard, icons, okBadges };
  })()`);
  assert(rolesCheck.builtin === 3 && rolesCheck.custom === 2, "2a builtin and custom roles clearly sectioned", JSON.stringify(rolesCheck));
  assert(rolesCheck.catsPerCard.every((n) => n === 4) && rolesCheck.okBadges === 0, "2b green badge waterfall replaced by 4 capability bars per card");
  assert(new Set(rolesCheck.icons).size >= 4, "2c distinct visual icons across role types", JSON.stringify(rolesCheck.icons));
  await cdp.shot("after-roles-paper-light");

  // Open Role Editor Modal -> test search, collapse, presets & save
  await cdp.eval(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('新建角色')).click()`);
  await cdp.waitFor(`document.querySelector('[data-testid="perm-matrix"]')`);
  await cdp.shot("after-roles-modal-paper-light");

  // Collapse admin group
  await cdp.click('[data-perm-cat-toggle="admin"]');
  await sleep(220);
  const adminCollapsed = await cdp.eval(`document.querySelector('[data-perm-cat="admin"]')?.dataset.open === 'false'`);
  assert(adminCollapsed, "2d PermMatrix category collapses cleanly");

  // Search filter
  await cdp.setInput('[data-perm-search]', "审计");
  await sleep(150);
  const searchVisible = await cdp.eval(`document.querySelectorAll('[data-testid="perm-matrix"] [data-perm]').length`);
  assert(searchVisible === 1, "2e PermMatrix search narrows to matching permission", `visible=${searchVisible}`);
  await cdp.setInput('[data-perm-search]', "");
  await sleep(120);

  // Preset + Save new role
  await cdp.click('[data-perm-preset="rw"]');
  await cdp.setInput('[role="dialog"] input[placeholder*="媒体协作者"]', "测试新角色");
  await cdp.eval(`document.querySelector('[role="dialog"] footer button.btn-primary').click()`);
  await sleep(300);
  assert(state.roles.some((r) => r.name === "测试新角色"), "2f creating a role via upgraded PermMatrix works");

  await openView("#/admin/roles", "paper", "dark");
  await cdp.waitFor(`document.querySelector('[data-testid="role-list"] li')`);
  await cdp.shot("after-roles-paper-dark");

  // 3. ACL Page — Paper Light & Bento Dark + Custom PermMatrix disclosure
  await openView("#/admin/acl?path=%2F%E6%9C%AC%E5%9C%B0%E5%BD%92%E6%A1%A3", "paper", "light");
  await cdp.waitFor(`document.querySelector('[data-testid="acl-matrix"] [data-rule]')`);
  const aclCheck = await cdp.eval(`(() => {
    const pills = document.querySelectorAll('[data-acl-page] [data-status-pill]').length;
    const rules = document.querySelectorAll('[data-testid="acl-matrix"] [data-rule]').length;
    return { pills, rules };
  })()`);
  assert(aclCheck.rules === 2 && aclCheck.pills >= 2, "3a ACL page renders StatusPill and rules", JSON.stringify(aclCheck));
  await cdp.shot("after-acl-paper-light");

  // Expand fine-tune panel
  await cdp.click('[data-testid="acl-matrix"] [data-acl-tune]');
  await sleep(200);
  const hasFine = await cdp.eval(`Boolean(document.querySelector('[data-acl-fine]'))`);
  assert(hasFine, "3b ACL fine-tune panel expands with semantic permission rows");

  await openView("#/admin/acl?path=%2F%E6%9C%AC%E5%9C%B0%E5%BD%92%E6%A1%A3", "bento", "dark");
  await cdp.waitFor(`document.querySelector('[data-testid="acl-matrix"] [data-rule]')`);
  await cdp.shot("after-acl-bento-dark");

  assert(cdp.errors.length === 0, "4 zero console/page errors", cdp.errors.join("; "));
  console.log("\nALL RHEA-278 ADMIN REDESIGN CHECKS PASSED!");
} finally {
  try {
    cdp?.ws.close();
  } catch {}
  chrome.kill("SIGKILL");
  server.close();
  await sleep(150);
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
}
