#!/usr/bin/env node
/**
 * RHEA-277 smoke & visual verification for DriveHub Web design system,
 * multi-skin framework (Paper / Bento / Swiss × Light / Dark), and settings-ui primitives.
 *
 * Zero external dependencies: uses Node 22 built-in http/WebSocket + headless Google Chrome CDP.
 *
 * Usage:
 *   node scripts/smoke_design_system.mjs
 *   SHOTS=/path/to/shots node scripts/smoke_design_system.mjs
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

const mock = {
  loggedIn: true,
};

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-drivehub-server-version": "0.1.1",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const p = u.pathname;
  if (p.startsWith("/api/")) {
    if (p === "/api/v1/health") return json(res, 200, { status: "ok", db: true });
    if (p === "/api/version") {
      return json(res, 200, {
        server_version: "0.1.1",
        api_version: 1,
        min_client_version: "0.1.0",
        latest: "0.1.2",
        update_available: true,
        web_build: null,
      });
    }
    if (p === "/api/auth/status") {
      return json(res, 200, {
        initialized: true,
        open_registration: true,
        require_email_verification: false,
        mail_transport: "smtp",
        oauth_providers: ["github", "google"],
        me: mock.loggedIn
          ? {
              id: 1,
              username: "admin",
              email: "admin@example.com",
              role: "admin",
              disabled: false,
              email_verified: true,
              totp_enabled: true,
              root_path: "/",
              visible_mounts: null,
              quota_bytes: 100 * 1024 * 1024 * 1024,
              used_bytes: 28 * 1024 * 1024 * 1024,
              created_at: 1700000000,
              has_password: true,
              groups: [{ id: 1, name: "核心团队" }],
              roles: [],
              caps: [],
              identities: [],
            }
          : null,
      });
    }
    if (p === "/api/auth/tokens") return json(res, 200, []);
    if (p === "/api/auth/app-passwords") return json(res, 200, []);
    if (p === "/api/auth/sessions") {
      return json(res, 200, [
        { id: "s1", user_agent: "Chrome 135 / Linux", ip: "127.0.0.1", method: "password", created_at: 1763900000, last_used: 1763903600, current: true },
      ]);
    }
    if (p === "/api/auth/identities") return json(res, 200, []);
    if (p === "/api/fs/list") {
      const dir = u.searchParams.get("path") || "/";
      if (dir === "/") {
        return json(res, 200, {
          path: "/",
          total: 3,
          items: [
            { name: "本地归档", path: "/local", is_dir: true, size: 0, modified_unix: 1763900000, mount_kind: "fs" },
            { name: "PikPak 影音", path: "/pikpak", is_dir: true, size: 0, modified_unix: 1763900000, mount_kind: "pikpak" },
            { name: "115 云盘", path: "/p115", is_dir: true, size: 0, modified_unix: 1763900000, mount_kind: "p115" },
          ],
          permissions: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "delete", "share", "tag"],
        });
      }
      return json(res, 200, {
        path: dir,
        total: 5,
        items: [
          { name: "设计稿", path: `${dir}/设计稿`, is_dir: true, size: 0, modified_unix: 1763900000 },
          { name: "项目文档", path: `${dir}/项目文档`, is_dir: true, size: 0, modified_unix: 1763890000 },
          { name: "DriveHub-架构说明.md", path: `${dir}/DriveHub-架构说明.md`, is_dir: false, size: 18432, modified_unix: 1763901200 },
          { name: "release-manifest.json", path: `${dir}/release-manifest.json`, is_dir: false, size: 4280, modified_unix: 1763902400 },
          { name: "季度汇总-2026Q4.pdf", path: `${dir}/季度汇总-2026Q4.pdf`, is_dir: false, size: 3421900, modified_unix: 1763880000 },
        ],
        permissions: ["read", "download", "upload", "create", "edit", "rename", "move", "copy", "delete", "share", "tag"],
      });
    }
    if (p === "/api/tags") return json(res, 200, []);
    if (p === "/api/mounts") {
      return json(res, 200, [
        { name: "本地归档", kind: "fs", options: { root: "/srv/files" }, read_only: false, hidden: false, enabled: true, sort_order: 1, transfer_mode: "auto" },
        { name: "PikPak 影音", kind: "pikpak", options: { username: "user@example.com", password: "***" }, read_only: false, hidden: false, enabled: true, sort_order: 2, transfer_mode: "proxy" },
        { name: "115 云盘", kind: "p115", options: { cookie: "***", root_id: "0" }, read_only: true, hidden: false, enabled: false, sort_order: 3, transfer_mode: "direct" },
      ]);
    }
    if (p === "/api/admin/roles") {
      return json(res, 200, [
        { id: 1, name: "admin", description: "系统内置管理员", builtin: true, level: "admin", permissions: ["read", "download", "upload", "delete"], users: 2, groups: 1 },
        { id: 2, name: "editor", description: "团队日常读写协作", builtin: false, level: "user", permissions: ["read", "download", "upload", "create", "edit", "rename", "share", "tag"], users: 5, groups: 2 },
        { id: 3, name: "guest", description: "只读访客权限", builtin: true, level: "guest", permissions: ["read", "download"], users: 1, groups: 0 },
      ]);
    }
    if (p === "/api/admin/settings") {
      return json(res, 200, { open_registration: false, require_email_verification: true });
    }
    if (p === "/api/admin/update/status") {
      return json(res, 200, {
        current_version: "0.1.1",
        status: { state: "idle", from_version: null, target_version: null, progress_bytes: 0, total_bytes: 0, message: "", error: null, actor: "", started_at: 0, updated_at: 0, commands: [], log: [] },
        last_check: {
          checked_at: Math.floor(Date.now() / 1000) - 90,
          source_url: "https://github.com/lthero-big/drivehub/releases/latest/download/release-manifest.json",
          channel: "stable",
          latest: {
            version: "0.1.2",
            channel: "stable",
            api_version: 1,
            min_client_version: "0.1.0",
            released_at: "2026-11-26T04:00:00Z",
            notes: "- Web 端 Paper 四层设计系统与多皮肤框架上线\n- 新增 settings-ui 分层组件原语",
            artifacts: [{ kind: "server", platform: "linux-x86_64", url: "drivehub", sha256: "abc", size: 25165824 }],
          },
          update_available: true,
          key_id: "ed25519:prod",
          error: null,
        },
        settings: { auto_check: true, mode: "notify", source_url: "", channel: "", interval_secs: 21600, window_start: "", window_end: "", notify_webhook: "", notify_email: "" },
        effective: { check_enabled: true, source_url: "", channel: "stable", interval_secs: 21600, deployment: "binary", platform: "linux-x86_64", exe_path: "/srv/drivehub", restart: "exit", docker_socket: null, can_auto_install: true, trusted_key_ids: [], db_backups: [] },
      });
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
      const v = await this.eval(`Boolean(${fnExpr})`);
      if (v) return;
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
  async key(keyName, modifiers = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, modifiers });
  }
  async shot(name) {
    if (!SHOTS) return;
    await sleep(120);
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
  }
}

function assert(cond, label, detail = "") {
  if (!cond) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    throw new Error(`Assertion failed: ${label}`);
  }
  console.log(`PASS ${label}${detail ? ` — ${detail}` : ""}`);
}

const chromePath = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error("No Chrome/Chromium binary found.");
  process.exit(1);
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;
const userDataDir = fs.mkdtempSync("/tmp/dh-rhea277-chrome-");
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1360,860",
    "about:blank",
  ],
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
    chrome.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}):\n${stderr}`));
    });
  });

  const devPort = new URL(wsBase).port;
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const pageTarget = targets.find((t) => t.type === "page");
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1360, height: 860, deviceScaleFactor: 2, mobile: false });

  async function goto(hash, initScript = "") {
    await cdp.send("Page.navigate", { url: `${baseUrl}/${hash}` });
    await sleep(350);
    if (initScript) {
      await cdp.eval(initScript);
      await sleep(150);
    }
  }

  // Helper in browser to measure WCAG contrast between two CSS vars resolved on documentElement
  const measureTokensExpr = `(() => {
    const parseRgb = (cssColor) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillStyle = cssColor;
      const out = ctx.fillStyle;
      if (out.startsWith('#')) {
        const hex = out.slice(1);
        return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
      }
      const m = out.match(/\\d+/g);
      return m ? m.slice(0,3).map(Number) : [0,0,0];
    };
    const lum = ([r,g,b]) => {
      const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (c1, c2) => {
      const l1 = lum(parseRgb(c1)), l2 = lum(parseRgb(c2));
      return Number(((Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05)).toFixed(2));
    };
    const cs = getComputedStyle(document.documentElement);
    const get = (k) => cs.getPropertyValue(k).trim();
    const shell = document.querySelector('.dh-app-shell');
    const shellCs = shell ? getComputedStyle(shell) : null;
    return {
      skin: document.documentElement.dataset.skin,
      theme: document.documentElement.dataset.theme,
      surface0: get('--surface-0'),
      surface1: get('--surface-1'),
      surface2: get('--surface-2'),
      surfaceSunken: get('--surface-sunken'),
      line1: get('--line-1'),
      line2: get('--line-2'),
      line3: get('--line-3'),
      fg: get('--fg'),
      fg2: get('--fg-2'),
      fg3: get('--fg-3'),
      fg4: get('--fg-4'),
      accent: get('--accent'),
      accentFg: get('--accent-fg'),
      radius: get('--radius'),
      shellRadius: shellCs ? shellCs.borderTopLeftRadius : null,
      shellBorder: shellCs ? shellCs.borderTopColor : null,
      contrastFg: ratio(get('--fg'), get('--surface-1')),
      contrastFg2: ratio(get('--fg-2'), get('--surface-1')),
      contrastFg3: ratio(get('--fg-3'), get('--surface-1')),
      contrastAccent: ratio(get('--accent-fg'), get('--accent')),
    };
  })()`;

  // 1. Load file browser in default Paper + Light
  await goto("#/files/local");
  await cdp.eval(`localStorage.setItem('dh_theme', 'light'); localStorage.setItem('dh_skin', 'paper');`);
  await cdp.send("Page.reload");
  await cdp.waitFor(`document.querySelector('[data-skin-trigger]') && document.querySelector('.dh-app-shell')`);
  await sleep(300);

  // 2. Test all 6 combinations (Paper / Bento / Swiss × Light / Dark) on Files page
  const skins = ["paper", "bento", "swiss"];
  const modes = ["light", "dark"];
  const radiusExpected = { paper: "10px", bento: "14px", swiss: "0px" };
  let shotIdx = 1;

  for (const s of skins) {
    // Switch skin via topbar SkinMenu!
    await cdp.click('[data-skin-trigger]');
    await cdp.waitFor(`document.querySelector('[data-skin-menu]')`);
    await cdp.click(`[data-skin-option="${s}"]`);
    await sleep(160);

    for (const m of modes) {
      const modeLabel = m === "light" ? "浅色" : "深色";
      await cdp.click(`[role="radiogroup"][aria-label="主题"] [aria-label="${modeLabel}"]`);
      await sleep(220);

      const info = await cdp.eval(measureTokensExpr);
      assert(
        info.skin === s && info.theme === m,
        `1.${s}.${m} dataset matches (${s}/${m})`,
        `skin=${info.skin} theme=${info.theme}`,
      );
      assert(
        info.radius === radiusExpected[s],
        `1.${s}.${m} geometry radius=${radiusExpected[s]}`,
        `shellRadius=${info.shellRadius}`,
      );
      if (s === "swiss") {
        assert(info.shellRadius === "0px", `1.${s}.${m} Swiss shell has sharp 0px corners`, info.shellRadius);
      }
      assert(
        info.contrastFg >= 7 && info.contrastFg2 >= 4.5 && info.contrastFg3 >= 4.5 && info.contrastAccent >= 4.5,
        `1.${s}.${m} WCAG AA/AAA text & accent contrast`,
        `fg=${info.contrastFg}:1 fg2=${info.contrastFg2}:1 fg3=${info.contrastFg3}:1 accent=${info.contrastAccent}:1`,
      );
      assert(
        Boolean(info.surface0 && info.surface1 && info.surface2 && info.surfaceSunken && info.line1 && info.line2 && info.line3),
        `1.${s}.${m} all 4-tier tokens populated`,
      );
      await cdp.shot(`${String(shotIdx++).padStart(2, "0")}-files-${s}-${m}`);
    }
  }

  // 3. Persistence across reload (currently swiss + dark)
  const stored = await cdp.eval(`({ skin: localStorage.getItem('dh_skin'), theme: localStorage.getItem('dh_theme') })`);
  assert(stored.skin === "swiss" && stored.theme === "dark", "2a skin & theme persisted to localStorage", JSON.stringify(stored));
  await cdp.send("Page.reload");
  await cdp.waitFor(`document.querySelector('[data-skin-trigger]')`);
  const afterReload = await cdp.eval(`({ skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.theme })`);
  assert(afterReload.skin === "swiss" && afterReload.theme === "dark", "2b FOUC-free reload preserves swiss/dark", JSON.stringify(afterReload));

  // 4. Verify UpdatePopover still opens cleanly under Swiss Dark + Paper Light
  await cdp.click('[data-update-trigger]');
  await cdp.waitFor(`document.querySelector('[data-update-popover]')`);
  const popCheck = await cdp.eval(`(() => {
    const p = document.querySelector('[data-update-popover]');
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    return { w: Math.round(r.width), visible: r.width > 200 && r.height > 100, border: cs.borderTopColor, radius: cs.borderTopLeftRadius };
  })()`);
  assert(popCheck.visible && popCheck.radius === "0px", "3a UpdatePopover works & inherits Swiss geometry", JSON.stringify(popCheck));
  await cdp.key("Escape");
  await sleep(120);

  // 5. Account -> 外观与偏好 (#/account/prefs) — verify settings-ui primitives!
  await cdp.eval(`localStorage.setItem('dh_skin', 'paper'); localStorage.setItem('dh_theme', 'light'); location.hash = '#/account/prefs';`);
  await cdp.send("Page.reload");
  await cdp.waitFor(`document.querySelector('[data-appearance-skins]') && document.querySelector('[data-prefs]')`);
  await sleep(350);

  // Verify SectionPanel + StatusPill + SettingRow hairlines + InfoTip + DisclosureRow
  const stCheck = await cdp.eval(`(() => {
    const panel = document.querySelector('[data-prefs]');
    const rows = panel.querySelectorAll('.dh-st-rows > .dh-st-row');
    const firstBefore = rows[0] ? getComputedStyle(rows[0], '::before').display : null;
    const secondBefore = rows[1] ? getComputedStyle(rows[1], '::before') : null;
    const pill = document.querySelector('[data-status-pill]');
    const pillCs = pill ? getComputedStyle(pill) : null;
    const disc = panel.querySelector('[data-disclosure]');
    return {
      rowCount: rows.length,
      firstHairlineHidden: firstBefore === 'none',
      secondHairlineLeft: secondBefore ? secondBefore.left : null,
      pillBorderWidth: pillCs ? pillCs.borderTopWidth : null,
      disclosureClosed: disc ? disc.dataset.open === 'false' : null,
    };
  })()`);
  assert(
    stCheck.rowCount >= 3 && stCheck.firstHairlineHidden && stCheck.secondHairlineLeft === "16px" && stCheck.pillBorderWidth === "0px" && stCheck.disclosureClosed,
    "4a settings-ui SectionPanel, indented hairline, borderless StatusPill & collapsed DisclosureRow",
    JSON.stringify(stCheck),
  );

  // Expand DisclosureRow and verify grid-template-rows height transition!
  await cdp.click('[data-prefs] [data-disclosure-trigger]');
  await sleep(280);
  const discOpen = await cdp.eval(`(() => {
    const disc = document.querySelector('[data-prefs] [data-disclosure]');
    const r = disc.getBoundingClientRect();
    return { open: disc.dataset.open, h: Math.round(r.height) };
  })()`);
  assert(discOpen.open === "true" && discOpen.h > 60, "4b DisclosureRow expands smoothly", JSON.stringify(discOpen));

  // Click InfoTip and verify tooltip opens & Escape closes it
  await sleep(150);
  await cdp.eval(`document.querySelector('[data-prefs] [data-info-tip]').click()`);
  await cdp.waitFor(`document.querySelector('[role="tooltip"]')`);
  const tipText = await cdp.eval(`document.querySelector('[role="tooltip"]').textContent.trim()`);
  assert(tipText.length > 5, "4c InfoTip opens accessible tooltip", tipText);
  await cdp.key("Escape");
  await sleep(120);
  const tipGone = await cdp.eval(`!document.querySelector('[role="tooltip"]') && Boolean(document.querySelector('[data-prefs]'))`);
  assert(tipGone, "4d Escape closes InfoTip tooltip without collapsing Bento tile");

  await cdp.eval(`document.querySelector('.dh-set-full-body')?.scrollTo(0, 0)`);
  await sleep(100);
  await cdp.shot("07-prefs-paper-light");

  // Switch skin & mode via Account AppearancePanel and check topbar sync!
  await cdp.click('[data-appearance-skin="bento"]');
  await cdp.click('[data-appearance-mode="dark"]');
  await sleep(250);
  const synced = await cdp.eval(`({
    skin: document.documentElement.dataset.skin,
    theme: document.documentElement.dataset.theme,
    topbarActive: document.querySelector('[data-skin-trigger]').dataset.activeSkin
  })`);
  assert(synced.skin === "bento" && synced.theme === "dark" && synced.topbarActive === "bento", "4e AppearancePanel syncs bidirectionally with topbar", JSON.stringify(synced));
  await cdp.shot("08-prefs-bento-dark");

  await cdp.click('[data-appearance-skin="swiss"]');
  await cdp.click('[data-appearance-mode="light"]');
  await sleep(250);
  await cdp.shot("09-prefs-swiss-light");

  // 6. Command Palette skin switch check
  await cdp.key("k", 2); // Ctrl+K
  await cdp.waitFor(`document.querySelector('[data-palette]')`);
  const hasSkinCmds = await cdp.eval(`(() => {
    const txt = document.querySelector('[data-palette]').textContent;
    return txt.includes('皮肤：暖纸 Paper') && txt.includes('皮肤：Bento 瓷片') && txt.includes('皮肤：瑞士网格 Swiss');
  })()`);
  assert(hasSkinCmds, "5 CommandPalette exposes all 3 skins");
  await cdp.key("Escape");
  await sleep(120);

  // 7. Admin pages (Mounts, Roles, Settings) under Bento Light & Paper Dark
  await cdp.eval(`localStorage.setItem('dh_skin', 'bento'); localStorage.setItem('dh_theme', 'light'); location.hash = '#/admin/mounts';`);
  await cdp.send("Page.reload");
  await cdp.waitFor(`document.querySelector('h1')`);
  await sleep(300);
  await cdp.shot("10-admin-mounts-bento-light");

  await cdp.eval(`localStorage.setItem('dh_skin', 'paper'); localStorage.setItem('dh_theme', 'dark'); location.hash = '#/admin/roles';`);
  await cdp.send("Page.reload");
  await cdp.waitFor(`document.querySelector('[data-testid="role-list"]')`);
  await sleep(300);
  await cdp.shot("11-admin-roles-paper-dark");

  await goto("#/admin/settings");
  await cdp.waitFor(`document.querySelector('.dh-bento-settings')`);
  await sleep(300);

  // 8. Login (AuthPage) under Paper Light & Swiss Dark
  mock.loggedIn = false;
  await cdp.eval(`localStorage.setItem('dh_skin', 'paper'); localStorage.setItem('dh_theme', 'light'); sessionStorage.removeItem('dh_guest'); location.hash = '#/';`);
  await cdp.send("Page.reload");
  await cdp.waitFor(`document.querySelector('[data-auth-submit]')`);
  await sleep(300);
  await cdp.shot("12-auth-paper-light");

  await cdp.eval(`localStorage.setItem('dh_skin', 'swiss'); localStorage.setItem('dh_theme', 'dark');`);
  await cdp.send("Page.reload");
  await cdp.waitFor(`document.querySelector('[data-auth-submit]')`);
  await sleep(300);
  await cdp.shot("13-auth-swiss-dark");

  // 9. Zero console/page errors
  assert(cdp.errors.length === 0, "6 zero unexpected console/page errors", cdp.errors.join("; "));
  console.log("\nALL DESIGN SYSTEM & MULTI-SKIN CHECKS PASSED!");
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
